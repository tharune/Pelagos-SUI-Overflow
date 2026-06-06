"use client";

/**
 * Transaction history — a chronological ledger of the connected wallet's
 * deposits, redemptions, and divestments. Fetches /api/deposit/transactions,
 * polls every 10s, and also refetches whenever the tab regains focus so a
 * freshly-confirmed buy from the Positions tab appears here without a manual
 * reload. Display-only — no writes.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { C, FS, FD, FM, EASE, BACKEND_URL, fmtUsd } from "../_lib/tokens";
import { explorerTxUrl } from "../_lib/wallet-bridge";
import {
  fetchContinuousPositions,
  type ContinuousPosition,
} from "../_lib/distribution-continuous-client";

type TxType = "deposit" | "redemption" | "divest" | string;

interface TxRow {
  id: string;
  bundle_id: string;
  bundle_name: string;
  type: TxType;
  amount_usdc: number;
  tokens: number | null;
  fee_usdc: number | null;
  tx_signature: string | null;
  created_at: string;
  // Enrichment from the backend for PPN / tranche rows. tokens stays 0
  // on those product rows, but tranche rows carry a face-value
  // notional derived from principal / price_per_token.
  tranche_kind?: "senior" | "mezzanine" | "junior" | null;
  price_per_token?: number | null;
  notional_tokens?: number | null;
  // Non-null when the tx matches a ppn_vaults row. Tells a vanilla PPN
  // buy apart from a basket buy when both have 0 PBU units.
  principal_usdc?: number | null;
  // Product type tagged by the backend ledger enrichment (tx digest matched
  // against the vault's deposit/redemption signature).
  product?: "basket" | "note" | "tranche" | string;
}

interface TxResponse {
  wallet_address: string;
  count: number;
  transactions: TxRow[];
}

interface HistoryProps {
  walletAddress: string | null;
  connected: boolean;
}

const POLL_MS = 10_000;

function labelForType(t: TxType): { text: string; color: string } {
  if (t === "deposit") return { text: "BUY", color: C.green };
  if (t === "redemption") return { text: "SELL", color: C.violet };
  if (t === "divest") return { text: "DIVEST", color: C.amber };
  if (t === "open") return { text: "OPEN", color: C.coral };
  if (t === "settle") return { text: "SETTLE", color: C.blue };
  return { text: String(t).toUpperCase(), color: C.textSecondary };
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }) + ", " + d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function shortSig(sig: string): string {
  if (sig.length <= 12) return sig;
  return `${sig.slice(0, 4)}…${sig.slice(-4)}`;
}

/**
 * Effective fee on a transaction, computed from the product type +
 * on-chain fee schedule. The backend's stored `fee_usdc` is either 0
 * (PPN/tranche close paths) or only covers the deposit side (basket
 * buys), so we reproduce the fee a caller can verify by inspecting
 * the tx in the chain explorer:
 *
 *   Basket deposit       — 50 bps of gross
 *   Basket redemption    — 30 bps, backed out from the net received
 *   PPN/tranche deposit  — 15 bps of gross (10 mgmt + 5 strategy)
 *   PPN/tranche close    — 5 bps, backed out from the net received
 *
 * `principal_usdc` is non-null only when the tx matches a ppn_vaults
 * row in the enrichment step, so we use it as the PPN-rail signal.
 * For sells the stored `amount_usdc` is the net the user actually
 * received; `net × bps / (10000 − bps)` recovers the fee on the
 * pre-fee gross.
 */
function feeForRow(row: TxRow): number {
  const amount = row.amount_usdc;
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const isDeposit = row.type === "deposit";
  const isSell = row.type === "redemption" || row.type === "divest";
  if (!isDeposit && !isSell) return 0;
  const isPpnRail = row.principal_usdc != null;
  const bps = isPpnRail
    ? isDeposit
      ? 15
      : 5
    : isDeposit
      ? 50
      : 30;
  if (isDeposit) {
    return (amount * bps) / 10_000;
  }
  return (amount * bps) / (10_000 - bps);
}

/** Invalid/missing ms timestamp → now, so toISOString() never throws. */
function isoFromMs(ms: number | undefined): string {
  const t = Number.isFinite(ms) ? (ms as number) : Date.now();
  return new Date(t).toISOString();
}

/**
 * Synthesize ledger rows from a continuous distribution position. Distribution
 * opens/settles live in the backend's file store (not the transactions table),
 * so we surface them here directly: an OPEN row at open time (collateral
 * escrowed) and, once settled, a SETTLE row at settle time (net paid out).
 * Both carry their real on-chain digest so the Tx link resolves.
 */
function distRowsForPosition(p: ContinuousPosition): TxRow[] {
  const collateral = Number.isFinite(p.collateral_usdc) ? p.collateral_usdc : 0;
  const out: TxRow[] = [
    {
      id: `dist-open-${p.id}`,
      bundle_id: p.market_id,
      bundle_name: p.question,
      type: "open",
      amount_usdc: collateral,
      tokens: null,
      fee_usdc: 0,
      tx_signature: p.open_digest ?? null,
      created_at: isoFromMs(p.opened_at),
    },
  ];
  if (p.settled) {
    const net = Number.isFinite(p.net_usdc) ? (p.net_usdc as number) : 0;
    out.push({
      id: `dist-settle-${p.id}`,
      bundle_id: p.market_id,
      bundle_name: p.question,
      type: "settle",
      amount_usdc: net,
      tokens: null,
      fee_usdc: 0,
      tx_signature: p.settle_digest ?? null,
      created_at: isoFromMs(p.settled_at ?? p.opened_at),
    });
  }
  return out;
}

export function History({ walletAddress, connected }: HistoryProps) {
  const [rows, setRows] = useState<TxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchRows = useCallback(
    async (opts: { background?: boolean } = {}): Promise<void> => {
      if (!walletAddress || !connected) {
        setRows(null);
        setError(null);
        setLoading(false);
        return;
      }
      if (!opts.background) setLoading(true);
      try {
        const res = await fetch(
          `${BACKEND_URL}/api/deposit/transactions/${encodeURIComponent(walletAddress)}`,
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as TxResponse;
        const txRows = Array.isArray(data.transactions) ? data.transactions : [];
        // Merge in distribution opens/settles (file-store sourced, with real
        // digests). Best-effort: a distribution fetch failure never blocks the
        // core ledger.
        let distRows: TxRow[] = [];
        try {
          const dist = await fetchContinuousPositions(walletAddress);
          distRows = (dist?.positions ?? []).flatMap(distRowsForPosition);
        } catch {
          /* distribution merge optional */
        }
        const merged = [...txRows, ...distRows].sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
        setRows(merged);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [walletAddress, connected],
  );

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    if (!walletAddress || !connected) return;
    const t = setInterval(() => void fetchRows({ background: true }), POLL_MS);
    return () => clearInterval(t);
  }, [fetchRows, walletAddress, connected]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void fetchRows({ background: true });
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [fetchRows]);

  const count = rows?.length ?? 0;

  const body = useMemo(() => {
    if (!connected) {
      return (
        <EmptyState
          title="Connect a wallet"
          subtitle="Your transaction history appears here once a wallet is connected."
        />
      );
    }
    if (loading && rows == null) {
      return <EmptyState title="Loading history…" subtitle="Fetching transactions from the ledger." />;
    }
    if (error) {
      return <EmptyState title="Couldn't load history" subtitle={error} />;
    }
    if (!rows || rows.length === 0) {
      return (
        <EmptyState
          title="No transactions yet"
          subtitle="Your buys, sells, and divestments will appear here automatically."
        />
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <HeaderRow />
        {rows.map((r) => (
          <TxRowView key={r.id} row={r} />
        ))}
      </div>
    );
  }, [connected, loading, rows, error]);

  return (
    <div
      style={{
        background: C.panelGradient,
        border: "0.5px solid rgba(45, 212, 191, 0.1)",
        borderRadius: 24,
        overflow: "hidden",
        position: "relative",
        boxShadow: "0 1px 0 rgba(255,255,255,0.03) inset, 0 20px 60px rgba(0,0,0,0.2)",
      }}
    >
      <div
        style={{
          padding: "18px 22px 14px 22px",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          borderBottom: "0.5px solid rgba(255,255,255,0.04)",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: FM,
              fontSize: 11,
              letterSpacing: "0.14em",
              color: C.teal,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            LEDGER
          </div>
          <div
            style={{
              fontSize: 20,
              fontFamily: FD,
              color: C.textPrimary,
              letterSpacing: "-0.02em",
            }}
          >
            Activity
          </div>
        </div>
        <div
          style={{
            fontFamily: FS,
            fontSize: 12,
            color: C.textSecondary,
          }}
        >
          {count} {count === 1 ? "entry" : "entries"}
        </div>
      </div>
      {body}
    </div>
  );
}

function HeaderRow() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "150px 70px 1fr 110px 110px 90px",
        gap: 12,
        padding: "10px 22px",
        borderBottom: "0.5px solid rgba(255,255,255,0.04)",
        fontFamily: FM,
        fontSize: 10,
        letterSpacing: "0.12em",
        color: C.textMuted,
        textTransform: "uppercase",
      }}
    >
      <span>Date</span>
      <span>Type</span>
      <span>Product</span>
      <span style={{ textAlign: "right" }}>USDC</span>
      <span style={{ textAlign: "right" }}>Tokens</span>
      <span style={{ textAlign: "right" }}>Tx</span>
    </div>
  );
}

function TxRowView({ row }: { row: TxRow }) {
  const label = labelForType(row.type);
  // Display precedence:
  //   1. `tokens` > 0         — real PBU units for basket deposits/redeems
  //   2. `notional_tokens` > 0 — synthetic face-value units for tranches
  //   3. "—"                   — vanilla PPN (principal-only, no unit)
  const displayTokens = (() => {
    if (typeof row.tokens === "number" && Number.isFinite(row.tokens) && row.tokens > 0) {
      return row.tokens.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }
    if (
      typeof row.notional_tokens === "number" &&
      Number.isFinite(row.notional_tokens) &&
      row.notional_tokens > 0
    ) {
      return row.notional_tokens.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return "—";
  })();
  // Product suffix: tranche kind for tranche rows, "PPN" for vanilla
  // PPN rows (a matched vault row with no tranche overlay), bare bundle
  // name for basket rows (no vault match).
  // Tag every row with its product so a note / tranche / basket / distribution
  // are distinguishable even when they share a bundle name.
  const productLabel = (() => {
    if (row.type === "open" || row.type === "settle") return `${row.bundle_name} · Distribution`;
    if (row.tranche_kind) {
      const kind = row.tranche_kind.charAt(0).toUpperCase() + row.tranche_kind.slice(1);
      return `${row.bundle_name} · ${kind} tranche`;
    }
    if (row.product === "tranche") return `${row.bundle_name} · Tranche`;
    if (row.product === "note" || (row.principal_usdc != null && row.tokens === 0)) {
      return `${row.bundle_name} · Protected Note`;
    }
    return `${row.bundle_name} · Basket`;
  })();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "150px 70px 1fr 110px 110px 90px",
        gap: 12,
        padding: "12px 22px",
        borderBottom: "0.5px solid rgba(255,255,255,0.03)",
        fontFamily: FS,
        fontSize: 12,
        color: C.textPrimary,
        alignItems: "center",
        transition: `background 0.15s ${EASE}`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      <span style={{ color: C.textSecondary }}>{formatDate(row.created_at)}</span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "3px 8px",
          borderRadius: 6,
          background: `${label.color}1a`,
          color: label.color,
          fontFamily: FM,
          fontSize: 10,
          letterSpacing: "0.08em",
          fontWeight: 600,
          width: "fit-content",
        }}
      >
        {label.text}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={productLabel}
      >
        {productLabel}
      </span>
      <span
        style={{
          textAlign: "right",
          fontFamily: FM,
          color: C.textPrimary,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 2,
        }}
      >
        {(() => {
          // Prefer the actual fee_usdc the confirm handler read off the
          // on-chain tx's pre/post balance deltas. Fall back to
          // feeForRow()'s theoretical schedule only when the row predates
          // the getUserUsdcDeltaFromTx logging fix (older deposits, old
          // sells that stored 0 as a placeholder). Once that backlog is
          // gone the fallback is dead code.
          const storedFee = Number(row.fee_usdc ?? 0);
          const fee = storedFee > 0 ? storedFee : feeForRow(row);
          const isDeposit = row.type === "deposit";
          // Main USDC line shows the *net* — what actually landed in the
          // user's position (deposit) or wallet (sell):
          //   deposit → amount − fee (fee comes off the gross)
          //   sell    → amount as-is (confirm endpoint already stores net)
          const displayAmount =
            isDeposit && fee > 0
              ? Math.max(0, row.amount_usdc - fee)
              : row.amount_usdc;
          return (
            <>
              <span>{fmtUsd(displayAmount, 4)}</span>
              {fee > 0 && (
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: FM,
                    color: C.textMuted,
                    letterSpacing: "0.01em",
                  }}
                >
                  {"−" + fmtUsd(fee, 4) + " fee"}
                </span>
              )}
            </>
          );
        })()}
      </span>
      <span style={{ textAlign: "right", fontFamily: FM, color: C.textSecondary }}>
        {displayTokens}
      </span>
      <span style={{ textAlign: "right" }}>
        {row.tx_signature ? (
          <a
            href={explorerTxUrl(row.tx_signature)}
            target="_blank"
            rel="noreferrer"
            style={{
              color: C.teal,
              textDecoration: "none",
              fontFamily: FM,
              fontSize: 11,
            }}
          >
            {shortSig(row.tx_signature)} ↗
          </a>
        ) : (
          <span style={{ color: C.textMuted }}>—</span>
        )}
      </span>
    </div>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div
      style={{
        padding: "60px 22px",
        textAlign: "center",
        fontFamily: FS,
      }}
    >
      <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 16, marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ color: C.textSecondary, fontSize: 13 }}>{subtitle}</div>
    </div>
  );
}
