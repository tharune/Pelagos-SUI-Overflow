"use client";

/**
 * Market-maker desk bid (Pelagos / Sui) — SIMULATED secondary market.
 *
 * Self-contained, additive widget: given a held position size it fetches the
 * protocol market-maker's simulated bid (per-product spread below par) and
 * offers a "Sell to desk" that records the exit to History at that price. No
 * on-chain transaction — the fill is a simulated ledger event; the parent
 * reflects the closed position via `onSold` (e.g. clearing its virtual position
 * and refreshing), exactly as a redeem does.
 */

import { useEffect, useState } from "react";
import { C, FM, FD } from "../_lib/tokens";
import {
  fetchMmQuote,
  sellToMM,
  type MmProductType,
  type MmTrancheKind,
  type MmQuote,
} from "../_lib/mm-client";

export function MmDeskBid({
  productType,
  trancheKind,
  bundleId,
  walletAddress,
  sizeUsdc,
  disabled,
  onSold,
}: {
  productType: MmProductType;
  trancheKind?: MmTrancheKind;
  bundleId: string;
  walletAddress: string | null;
  /** Held position value to quote (display USDC). The widget hides itself at <= 0. */
  sizeUsdc: number;
  disabled?: boolean;
  onSold?: (payoutUsdc: number) => void;
}) {
  const [quote, setQuote] = useState<MmQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [soldMsg, setSoldMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!(sizeUsdc > 0)) {
      setQuote(null);
      return;
    }
    const ctrl = new AbortController();
    fetchMmQuote({ productType, trancheKind, sizeUsdc, signal: ctrl.signal })
      .then(setQuote)
      .catch(() => {
        /* the bid is best-effort; hide on failure */
      });
    return () => ctrl.abort();
  }, [productType, trancheKind, sizeUsdc]);

  if (!(sizeUsdc > 0) || !quote) return null;

  const blocked = busy || disabled || !walletAddress;

  async function sell() {
    if (!walletAddress) {
      setErr("Connect a wallet to sell.");
      return;
    }
    setBusy(true);
    setErr(null);
    setSoldMsg(null);
    try {
      const r = await sellToMM({ bundleId, walletAddress, productType, trancheKind, sizeUsdc, quote });
      setSoldMsg(`Sold to desk · +$${r.payoutUsdc.toFixed(2)} (simulated fill, recorded to History)`);
      onSold?.(r.payoutUsdc);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        border: `0.5px solid ${C.border}`,
        borderRadius: 10,
        background: C.surface,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: C.textMuted }}>
          Market-maker desk bid · simulated
        </span>
        <span style={{ fontFamily: FM, fontSize: 10.5, color: C.textMuted }}>
          {(quote.spread_bps / 100).toFixed(2)}% below par
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 6 }}>
        <span style={{ fontFamily: FD, fontSize: 18, fontWeight: 600, color: C.textPrimary }}>
          ${quote.payout_usdc.toFixed(2)}
        </span>
        <span style={{ fontFamily: FM, fontSize: 11, color: C.textSecondary }}>
          ${quote.bid_per_unit.toFixed(4)}/unit · ${quote.size_usdc.toFixed(2)} held
        </span>
      </div>
      <button
        type="button"
        onClick={sell}
        disabled={blocked}
        style={{
          marginTop: 10,
          width: "100%",
          padding: "8px 12px",
          borderRadius: 8,
          border: `0.5px solid ${C.border}`,
          background: "transparent",
          color: C.textSecondary,
          fontFamily: FD,
          fontSize: 12,
          fontWeight: 600,
          cursor: blocked ? "not-allowed" : "pointer",
          opacity: blocked ? 0.5 : 1,
        }}
      >
        {busy ? "Selling to desk…" : "Sell to desk"}
      </button>
      {soldMsg && <div style={{ marginTop: 8, fontFamily: FM, fontSize: 11, color: C.green }}>{soldMsg}</div>}
      {err && <div style={{ marginTop: 8, fontFamily: FM, fontSize: 11, color: C.red }}>{err}</div>}
    </div>
  );
}
