"use client";

// ---------------------------------------------------------------------------
// Shared strip-product UI.
//
// Every Pelagos DeepBook Predict product is the SAME range-strip engine with a
// different parameterization. This module holds the shared primitives (ladder,
// sliders, stats) + the four product panels (Distribution / Tranches / PPN /
// DeepBook Baskets) + the LP "be the house" widget, so each product gets its
// own page that is a thin shell around one panel. Pricing — both the ask (mint)
// and bid (redeem) of every bucket — comes live from the DeepBook order book
// via `previewStrip` (devInspect of get_range_trade_amounts), never a model.
//
// Pages wire the wallet/usdc hooks once and pass them in; render <StripStyles/>
// once for the shared class names.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { C, FD, FM, FS, EASE, trancheColor } from "../_lib/tokens";
import { suiExplorerTxUrl, friendlyWalletError } from "../_lib/chain";
import { ConnectModal } from "@mysten/dapp-kit";
import { useWalletSigner, useUsdcBalance } from "../_lib/wallet-bridge";
import {
  ppnQuote,
  trancheQuote,
  stripPreview,
  ensureManager,
  prepareOpenStrip,
  preparePpnOpen,
  prepareLpSupply,
  confirmPredict,
  usd,
  fmt,
  type StripQuote,
  type StripBucket,
  type PpnQuote,
  type TrancheProfile,
} from "../_lib/predict-strip-client";

export type Wallet = ReturnType<typeof useWalletSigner>;
export type Usdc = ReturnType<typeof useUsdcBalance>;

// ---------------------------------------------------------------------------
// Shared styles + small primitives.
// ---------------------------------------------------------------------------

export const PANEL: React.CSSProperties = {
  background: C.card,
  border: `0.5px solid ${C.border}`,
  borderRadius: 14,
  padding: 20,
};

export const pct = (p: number) => `${(p * 100).toFixed(1)}%`;
export const dollars = (v: number) =>
  `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** Consistent product-page header: eyebrow · title · one-line subtitle. */
export function PageHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24, maxWidth: 760 }}>
      <div style={{ fontFamily: FM, fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase", color: C.teal, marginBottom: 10 }}>
        {eyebrow}
      </div>
      <h1 style={{ fontFamily: FD, fontSize: 34, fontWeight: 600, letterSpacing: "-0.03em", color: C.textPrimary, margin: 0 }}>
        {title}
      </h1>
      <p style={{ fontFamily: FS, fontSize: 14.5, color: C.textSecondary, margin: "10px 0 0", lineHeight: 1.6 }}>{sub}</p>
    </div>
  );
}

export function Cap({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: FM,
        fontSize: 10.5,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: C.textMuted,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: C.textMuted }}>
        {label}
      </div>
      <div style={{ fontFamily: FD, fontSize: 19, fontWeight: 600, color: color ?? C.textPrimary, marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

export function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>{k}</span>
      <span style={{ fontFamily: FD, fontSize: 13, color: color ?? C.textPrimary }}>{v}</span>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  fmt: fmtFn,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontFamily: FM, fontSize: 10.5, letterSpacing: "0.1em", color: C.textMuted, textTransform: "uppercase" }}>
          {label}
        </span>
        <span style={{ fontFamily: FD, fontSize: 14, color: C.textPrimary }}>{fmtFn(value)}</span>
      </div>
      <input
        type="range"
        className="mk-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** A result line shared by all the open flows. */
export function ResultLine({ digest, label }: { digest: string; label: string }) {
  return (
    <div style={{ marginTop: 12, fontFamily: FM, fontSize: 12, color: C.green }}>
      ✓ {label} ·{" "}
      <a href={suiExplorerTxUrl(digest)} target="_blank" rel="noreferrer" style={{ color: C.tealLight }}>
        {digest.slice(0, 10)}… ↗
      </a>
    </div>
  );
}

// Filter a strip's buckets into the {lower,higher,quantity} form the open route
// wants — only tradeable buckets with a non-zero contract count are openable.
export function openableBuckets(buckets: StripBucket[]) {
  return buckets
    .filter((b) => b.tradeable && Number(b.quantity) > 0)
    .map((b) => ({ lower: b.lower, higher: b.higher, quantity: b.quantity }));
}

// ---------------------------------------------------------------------------
// The bucket ladder — the live MM order book for a distribution strip.
// ---------------------------------------------------------------------------

// CEX / Wall-Street order book — asks stacked above the forward mid, bids below,
// with cumulative depth bars, a live spread row, and timeframe toggles. It is
// self-contained: it polls a fresh on-chain strip (real get_range_trade_amounts
// pricing) every few seconds and on timeframe change, so the book is live. The
// timeframe widens/tightens the depth window shown (1m = tight near-mid book,
// 1D = the full deep book).
const OB_TFS: Array<{ k: string; span: number }> = [
  { k: "1m", span: 1.4 },
  { k: "5m", span: 2.0 },
  { k: "15m", span: 2.6 },
  { k: "1h", span: 3.2 },
  { k: "1D", span: 4.2 },
];

export function OrderBook({ oracleId, levels = 16 }: { oracleId?: string; levels?: number }) {
  const [tf, setTf] = useState("15m");
  const [quote, setQuote] = useState<StripQuote | null>(null);
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    let alive = true;
    const span = OB_TFS.find((t) => t.k === tf)?.span ?? 2.6;
    const load = () =>
      stripPreview({ oracle_id: oracleId, n: levels, span_sigma: span, budget_usd: 2000 })
        .then((q) => { if (alive) { setQuote(q); setPulse((p) => p + 1); } })
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 4500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [oracleId, tf, levels]);

  const view = useMemo(() => {
    if (!quote) return null;
    const fwd = quote.forward_usd;
    const rows = quote.buckets
      .map((b) => ({
        mid: (b.lower_usd + b.higher_usd) / 2,
        lo: b.lower_usd,
        hi: b.higher_usd,
        live: b.tradeable && Number(b.quantity) > 0,
        size: Number(b.quantity) / 1e6,
        ask: Number(b.mint_cost_raw) / 1e6,
        bid: Number(b.redeem_value_raw) / 1e6,
        imp: b.unit_price,
      }))
      .filter((r) => r.live);
    const asks = rows.filter((r) => r.mid > fwd).sort((a, b) => b.mid - a.mid); // far → near
    const bids = rows.filter((r) => r.mid <= fwd).sort((a, b) => b.mid - a.mid); // near → far
    // cumulative depth from the mid outward
    let c = 0; const askCum = new Map<number, number>();
    for (let i = asks.length - 1; i >= 0; i--) { c += asks[i].size; askCum.set(i, c); }
    c = 0; const bidCum = new Map<number, number>();
    for (let i = 0; i < bids.length; i++) { c += bids[i].size; bidCum.set(i, c); }
    const maxCum = Math.max(...Array.from(askCum.values()), ...Array.from(bidCum.values()), 1);
    const bestAsk = asks.length ? asks[asks.length - 1].ask : 0;
    const bestBid = bids.length ? bids[0].bid : 0;
    return { fwd, asks, bids, askCum, bidCum, maxCum, spread: Math.max(0, bestAsk - bestBid) };
  }, [quote]);

  return (
    <div className="cb">
      <div className="cb-head">
        <div className="cb-title">
          <span className="cb-live"><i style={{ animationDelay: `${pulse % 2}s` }} /> Live order book</span>
        </div>
        <div className="cb-tfs">
          {OB_TFS.map((t) => (
            <button key={t.k} type="button" className={t.k === tf ? "is-on" : ""} onClick={() => setTf(t.k)}>{t.k}</button>
          ))}
        </div>
      </div>
      <div className="cb-cols"><span>Price</span><span>Size</span><span>Total</span></div>
      {!view ? (
        <div className="cb-empty">loading the live book…</div>
      ) : (
        <>
          <div className="cb-side">
            {view.asks.map((r, i) => {
              const cum = view.askCum.get(i) ?? 0;
              return (
                <div className="cb-row cb-ask" key={`a${i}`}>
                  <div className="cb-depth cb-depth-ask" style={{ width: `${(cum / view.maxCum) * 100}%` }} />
                  <span className="cb-price">{dollars(r.mid)}</span>
                  <span className="cb-size">{r.size.toFixed(1)}</span>
                  <span className="cb-total">{cum.toFixed(0)}</span>
                </div>
              );
            })}
          </div>
          <div className="cb-spread">
            <span className="cb-mid">{dollars(view.fwd)}</span>
            <span className="cb-spread-v">spread {view.spread > 0 ? `$${view.spread.toFixed(2)}` : "—"}</span>
          </div>
          <div className="cb-side">
            {view.bids.map((r, i) => {
              const cum = view.bidCum.get(i) ?? 0;
              return (
                <div className="cb-row cb-bid" key={`b${i}`}>
                  <div className="cb-depth cb-depth-bid" style={{ width: `${(cum / view.maxCum) * 100}%` }} />
                  <span className="cb-price">{dollars(r.mid)}</span>
                  <span className="cb-size">{r.size.toFixed(1)}</span>
                  <span className="cb-total">{cum.toFixed(0)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Back-compat alias: older call sites pass a static {quote}; render the live book
// for that quote's oracle so every surface gets the same CEX order book.
export function BucketLadder({ quote }: { quote: StripQuote }) {
  return <OrderBook oracleId={quote.oracle_id} />;
}

// ---------------------------------------------------------------------------
// Connect-gated open button used across panels.
// ---------------------------------------------------------------------------

export function OpenButton({
  wallet,
  busy,
  disabled,
  label,
  busyLabel,
  onOpen,
}: {
  wallet: Wallet;
  busy: boolean;
  disabled?: boolean;
  label: string;
  busyLabel: string;
  onOpen: () => void;
}) {
  if (!wallet.connected) {
    return (
      <ConnectModal
        trigger={
          <button className="mk-open" style={{ cursor: "pointer" }}>
            Connect a wallet to open
          </button>
        }
      />
    );
  }
  return (
    <button className="mk-open" disabled={busy || disabled} onClick={onOpen}>
      {busy ? busyLabel : label}
    </button>
  );
}

// ===========================================================================
// TRANCHES — the same strip at 1.8σ / 1.0σ / 0.5σ: senior widest (defensive,
// steady multiple), junior tightest (lower hit-rate, biggest multiple).
// ===========================================================================

export function TranchesPanel({ wallet, oracleId, baseSigmaUsd }: { wallet: Wallet; oracleId?: string; baseSigmaUsd?: number }) {
  const [budget, setBudget] = useState("100");
  const [tranches, setTranches] = useState<TrancheProfile[]>([]);
  const [forward, setForward] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [openBusy, setOpenBusy] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [openErr, setOpenErr] = useState<string | null>(null);

  const budgetNum = Number(budget);

  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!Number.isFinite(budgetNum) || budgetNum <= 0) return;
    if (timer.current) window.clearTimeout(timer.current);
    setLoading(true);
    timer.current = window.setTimeout(() => {
      trancheQuote({ asset: "BTC", oracle_id: oracleId, budget_usd: budgetNum, sigma_usd: baseSigmaUsd, sender: wallet.address ?? undefined })
        .then((r) => {
          setTranches(r.tranches);
          setForward(r.forward_usd);
          setErr(null);
        })
        .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [budgetNum, oracleId, baseSigmaUsd, wallet.address]);

  async function openTranche(t: TrancheProfile) {
    setOpenBusy(t.tranche);
    setOpenErr(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const buckets = openableBuckets(t.strip.buckets);
      if (buckets.length === 0) throw new Error("No tradeable buckets in this tranche.");
      setStage("Building tranche…");
      const deposit = ((BigInt(t.strip.total_cost_raw) * 12n) / 10n).toString();
      const prep = await prepareOpenStrip({
        owner: wallet.address as string,
        manager_id: mgr,
        oracle_id: t.strip.oracle_id,
        expiry: t.strip.expiry,
        buckets,
        deposit_amount_raw: deposit,
      });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResults((p) => ({ ...p, [t.tranche]: c.digest }));
    } catch (e) {
      setOpenErr(friendlyWalletError(e));
    } finally {
      setOpenBusy(null);
      setStage(null);
    }
  }

  const order: TrancheProfile["tranche"][] = ["senior", "mezz", "junior"];
  const colorFor = (k: TrancheProfile["tranche"]) =>
    trancheColor(k === "mezz" ? "mezzanine" : k);
  const sorted = order
    .map((k) => tranches.find((t) => t.tranche === k))
    .filter((t): t is TrancheProfile => Boolean(t));

  return (
    <div>
      <div style={{ ...PANEL, marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 22, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <Cap style={{ marginBottom: 6 }}>Budget (dUSDC)</Cap>
          <input className="mk-num" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} style={{ maxWidth: 200 }} />
        </div>
        <div style={{ display: "grid", gap: 3 }}>
          <Cap>Forward</Cap>
          <span style={{ fontFamily: FD, fontSize: 18, fontWeight: 600, color: C.tealLight }}>
            {forward ? dollars(forward) : loading ? "…" : "—"}
          </span>
        </div>
        <div style={{ flexBasis: "100%", fontFamily: FS, fontSize: 13, color: C.textSecondary, lineHeight: 1.55, maxWidth: 760 }}>
          The same forward, sliced by conviction width. <strong style={{ color: C.textPrimary }}>Senior</strong> covers wide around
          the forward — a defensive slice with a high hit-rate and a steady multiple. <strong style={{ color: C.textPrimary }}>Junior</strong> pins
          the forward tight — a lower hit-rate, but the biggest multiple if it lands. Each card is a real strip you can open.
        </div>
      </div>

      {err && <div style={{ ...PANEL, marginBottom: 16, fontFamily: FM, fontSize: 12, color: C.red }}>{err}</div>}

      <div className="mk-cards">
        {sorted.map((t) => {
          const accent = colorFor(t.tranche);
          const tradeable = t.strip.buckets.filter((b) => b.tradeable).length;
          return (
            <div key={t.tranche} style={{ ...PANEL, borderColor: `${accent}55`, display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: FD, fontSize: 16, fontWeight: 600, color: accent, textTransform: "capitalize" }}>
                  {t.tranche}
                </span>
                <span style={{ fontFamily: FM, fontSize: 10, color: C.textMuted }}>σ × {t.sigma_mult.toFixed(2)}</span>
              </div>
              <span style={{ fontFamily: FS, fontSize: 12.5, color: C.textSecondary, lineHeight: 1.5, minHeight: 36 }}>
                {t.label}
              </span>
              <div style={{ display: "grid", gap: 9, paddingTop: 12, borderTop: `0.5px solid ${C.border}` }}>
                <Row k="Ask (mint)" v={usd(t.strip.total_cost_raw)} />
                <Row k="Best-case max payout" v={usd(t.strip.realized_max_payout_raw)} color={accent} />
                <Row k="Round-trip spread" v={usd(t.strip.round_trip_spread_raw)} color={C.amber} />
                <Row k="Buckets" v={`${tradeable} / ${t.strip.buckets.length} tradeable`} />
              </div>
              <div style={{ marginTop: "auto", paddingTop: 6 }}>
                <OpenButton
                  wallet={wallet}
                  busy={openBusy === t.tranche}
                  disabled={tradeable === 0}
                  label="Open this tranche"
                  busyLabel={stage ?? "Submitting…"}
                  onOpen={() => openTranche(t)}
                />
                {results[t.tranche] && <ResultLine digest={results[t.tranche]} label={`${t.tranche} opened`} />}
              </div>
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div style={{ ...PANEL, gridColumn: "1 / -1", fontFamily: FM, fontSize: 12.5, color: C.textMuted }}>
            {loading ? "Pricing senior / mezz / junior strips…" : "Set a budget to price tranches."}
          </div>
        )}
      </div>

      {openErr && <div style={{ ...PANEL, marginTop: 16, fontFamily: FM, fontSize: 12, color: C.red }}>{openErr}</div>}
    </div>
  );
}

// ===========================================================================
// PPN — floor → PLP supply + upside → range strip.
// ===========================================================================

export function PpnPanel({ wallet }: { wallet: Wallet }) {
  const [budget, setBudget] = useState("100");
  const [floorPct, setFloorPct] = useState(0.8);
  const [quote, setQuote] = useState<PpnQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const budgetNum = Number(budget);

  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!Number.isFinite(budgetNum) || budgetNum <= 0) return;
    if (timer.current) window.clearTimeout(timer.current);
    setLoading(true);
    timer.current = window.setTimeout(() => {
      ppnQuote({ asset: "BTC", budget_usd: budgetNum, floor_pct: floorPct, sender: wallet.address ?? undefined })
        .then((q) => {
          setQuote(q);
          setErr(null);
        })
        .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [budgetNum, floorPct, wallet.address]);

  async function open() {
    if (!quote) return;
    setBusy(true);
    setOpenErr(null);
    setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const buckets = openableBuckets(quote.strip.buckets);
      if (buckets.length === 0) throw new Error("No tradeable upside buckets in this note.");
      setStage("Building note…");
      const prep = await preparePpnOpen({
        owner: wallet.address as string,
        manager_id: mgr,
        oracle_id: quote.oracle_id,
        expiry: quote.expiry,
        buckets,
        floor_amount_raw: quote.floor_raw,
        upside_amount_raw: quote.upside_raw,
      });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult(c.digest);
    } catch (e) {
      setOpenErr(friendlyWalletError(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  const floorUi = quote ? Number(quote.floor_raw) / 1e6 : 0;
  const upsideUi = quote ? Number(quote.upside_raw) / 1e6 : 0;
  const floorW = floorUi + upsideUi > 0 ? (floorUi / (floorUi + upsideUi)) * 100 : Math.round(floorPct * 100);

  return (
    <div className="mk-grid">
      <aside style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <div style={PANEL}>
          <Cap>Structure · BTC</Cap>
          <div style={{ display: "grid", gap: 18, marginTop: 16 }}>
            <div>
              <Cap style={{ marginBottom: 6 }}>Budget (dUSDC)</Cap>
              <input className="mk-num" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
            <Slider label="Protection floor" value={floorPct} min={0.5} max={0.99} step={0.01} fmt={(v) => pct(v)} onChange={setFloorPct} />
          </div>

          {/* principal split — the note in one bar: floor kept safe + upside at risk */}
          <div style={{ marginTop: 18 }}>
            <div className="ppn-split">
              <span style={{ width: `${floorW}%`, background: C.green }} title="Floor → PLP" />
              <span style={{ width: `${100 - floorW}%`, background: C.tealLight }} title="Upside → strip" />
            </div>
            <div className="ppn-split-key">
              <span><i style={{ background: C.green }} />Floor → PLP&nbsp;<b>{quote ? usd(quote.floor_raw) : "—"}</b></span>
              <span><i style={{ background: C.tealLight }} />Upside → strip&nbsp;<b>{quote ? usd(quote.upside_raw) : "—"}</b></span>
            </div>
          </div>
        </div>

        <div style={PANEL}>
          <Cap>What you get</Cap>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 14, marginTop: 14 }}>
            <Stat label="Protected principal" value={quote ? usd(quote.protected_principal_raw) : "—"} color={C.green} />
            <Stat label="Best case" value={quote ? usd(quote.total_max_payout_raw) : "—"} color={C.tealLight} />
          </div>
          <div style={{ display: "grid", gap: 10, marginTop: 16, paddingTop: 14, borderTop: `0.5px solid ${C.border}` }}>
            <Row k="Protection" v={quote ? pct(quote.protection_pct) : "—"} />
            <Row k="Forward" v={quote ? dollars(quote.forward_usd) : loading ? "…" : "—"} />
            <Row k="Settles" v="Sui testnet" />
          </div>
          {err && <div style={{ marginTop: 12, fontFamily: FM, fontSize: 12, color: C.red }}>{err}</div>}
        </div>
      </aside>

      <main style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ ...PANEL, flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
            <Cap>Upside strip ladder · live on-chain MM</Cap>
            <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
              {loading ? "pricing…" : quote ? `${quote.strip.buckets.length} buckets` : "—"}
            </span>
          </div>
          {quote ? (
            <BucketLadder quote={quote.strip} />
          ) : (
            <div style={{ flex: 1, minHeight: 220, display: "grid", placeItems: "center", fontFamily: FM, fontSize: 12, color: C.textMuted }}>
              {loading ? "Pricing the upside strip…" : "Set a budget."}
            </div>
          )}
        </div>

        <div style={PANEL}>
          <OpenButton
            wallet={wallet}
            busy={busy}
            disabled={!quote}
            label={`Open protected note · ${quote ? usd(quote.budget_raw) : ""}`}
            busyLabel={stage ?? "Submitting…"}
            onOpen={open}
          />
          {result && <ResultLine digest={result} label="Protected note opened" />}
          {openErr && <div style={{ marginTop: 12, fontFamily: FM, fontSize: 12, color: C.red, lineHeight: 1.5 }}>{openErr}</div>}
        </div>
      </main>
    </div>
  );
}

// ===========================================================================
// LP WIDGET — "Be the house (PLP)".
// ===========================================================================

export function LpWidget({ wallet, usdc }: { wallet: Wallet; usdc: Usdc }) {
  const [amount, setAmount] = useState("250");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const amt = Number(amount);
  const valid = Number.isFinite(amt) && amt > 0;

  async function supply() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setStage("Building supply…");
      const prep = await prepareLpSupply({ owner: wallet.address as string, amount_ui: amt });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult(c.digest);
      usdc.refresh();
    } catch (e) {
      setError(friendlyWalletError(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <div style={{ ...PANEL, marginTop: 24, background: C.panelGradient }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ maxWidth: 460 }}>
          <Cap>Be the house · PLP</Cap>
          <div style={{ fontFamily: FD, fontSize: 18, fontWeight: 600, color: C.textPrimary, marginTop: 6 }}>
            Supply dUSDC to the Predict liquidity pool
          </div>
          <p style={{ fontFamily: FS, fontSize: 13, color: C.textSecondary, margin: "6px 0 0", lineHeight: 1.55 }}>
            The PLP pool backs every strip&apos;s payout and earns the spread the taker pays — the edge measured above.
            Supply dUSDC to take the other side of the book.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 240 }}>
          <div>
            <Cap style={{ marginBottom: 6 }}>Amount (dUSDC)</Cap>
            <input className="mk-num" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {!wallet.connected ? (
            <ConnectModal
              trigger={
                <button className="mk-open" style={{ cursor: "pointer" }}>
                  Connect a wallet
                </button>
              }
            />
          ) : (
            <button className="mk-open" disabled={busy || !valid} onClick={supply}>
              {busy ? stage ?? "Supplying…" : `Supply ${valid ? fmt(Math.round(amt * 1e6)).toLocaleString() : ""} dUSDC`}
            </button>
          )}
          {wallet.connected && (
            <span style={{ fontFamily: FM, fontSize: 10.5, color: C.textMuted }}>
              Balance {usdc.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} mUSDC · pool needs dUSDC
            </span>
          )}
        </div>
      </div>
      {result && <ResultLine digest={result} label="Supplied to PLP" />}
      {error && <div style={{ marginTop: 12, fontFamily: FM, fontSize: 12, color: C.red, lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}

// ===========================================================================
// Shared global styles — render once per page that uses the panels.
// ===========================================================================

export function StripStyles() {
  return (
    <style jsx global>{`
      .mk-grid { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 30px; align-items: start; }
      @media (max-width: 900px) { .mk-grid { grid-template-columns: 1fr; } }
      .mk-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
      @media (max-width: 900px) { .mk-cards { grid-template-columns: 1fr; } }
      .mk-num { width: 100%; box-sizing: border-box; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 8px; padding: 10px 12px; color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; outline: none; }
      .mk-num:focus { border-color: ${C.tealLight}; }
      .mk-open { width: 100%; background: ${C.tealLight}; border: none; border-radius: 10px; padding: 14px; color: #06121a; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.15s ${EASE}; }
      .mk-open:disabled { opacity: 0.5; cursor: not-allowed; }
      .mk-ghost { width: 100%; background: transparent; border: 0.5px solid ${C.border}; border-radius: 10px; padding: 12px; color: ${C.textSecondary}; font-family: ${FD}; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s ${EASE}; }
      .mk-ghost:hover:not(:disabled) { border-color: ${C.borderHover}; color: ${C.textPrimary}; }
      .mk-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
      /* ---- CEX / Wall-Street order book ---- */
      .cb { font-family: ${FM}; display: grid; gap: 0; }
      .cb-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .cb-live { display: inline-flex; align-items: center; gap: 7px; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: ${C.textMuted}; }
      .cb-live i { width: 6px; height: 6px; border-radius: 50%; background: ${C.green}; box-shadow: 0 0 0 0 ${C.green}66; animation: cbPing 2.4s ${EASE} infinite; }
      @keyframes cbPing { 0% { box-shadow: 0 0 0 0 ${C.green}55; } 70% { box-shadow: 0 0 0 5px ${C.green}00; } 100% { box-shadow: 0 0 0 0 ${C.green}00; } }
      .cb-tfs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 8px; border: 0.5px solid ${C.border}; background: ${C.surface}; }
      .cb-tfs button { appearance: none; border: 0; background: transparent; border-radius: 6px; padding: 3px 9px; color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; cursor: pointer; transition: all 0.14s ${EASE}; }
      .cb-tfs button:hover { color: ${C.textSecondary}; }
      .cb-tfs button.is-on { background: ${C.card}; color: ${C.textPrimary}; }
      .cb-cols { display: grid; grid-template-columns: 1fr 1fr 1fr; padding: 0 8px 6px; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.textMuted}; }
      .cb-cols span:nth-child(2), .cb-cols span:nth-child(3) { text-align: right; }
      .cb-side { display: grid; gap: 1px; }
      .cb-row { position: relative; display: grid; grid-template-columns: 1fr 1fr 1fr; align-items: center; height: 24px; padding: 0 8px; border-radius: 4px; overflow: hidden; }
      .cb-depth { position: absolute; top: 0; bottom: 0; right: 0; }
      .cb-depth-ask { background: ${C.red}16; }
      .cb-depth-bid { background: ${C.green}16; }
      .cb-price { position: relative; font-size: 11.5px; font-variant-numeric: tabular-nums; }
      .cb-ask .cb-price { color: ${C.red}; }
      .cb-bid .cb-price { color: ${C.green}; }
      .cb-size, .cb-total { position: relative; text-align: right; font-size: 11px; color: ${C.textSecondary}; font-variant-numeric: tabular-nums; }
      .cb-total { color: ${C.textMuted}; }
      .cb-spread { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; margin: 3px 0; border-top: 0.5px solid ${C.border}; border-bottom: 0.5px solid ${C.border}; }
      .cb-mid { font-family: ${FD}; font-size: 14px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
      .cb-spread-v { font-size: 10px; letter-spacing: 0.04em; color: ${C.textMuted}; }
      .cb-empty { height: 200px; display: grid; place-items: center; font-size: 11.5px; color: ${C.textMuted}; }
      .mk-range { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 4px; background: ${C.border}; outline: none; }
      .mk-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 50%; background: ${C.tealLight}; cursor: pointer; border: none; }
      .mk-range::-moz-range-thumb { width: 15px; height: 15px; border-radius: 50%; background: ${C.tealLight}; cursor: pointer; border: none; }
      .ppn-split { display: flex; gap: 2px; height: 10px; border-radius: 5px; overflow: hidden; }
      .ppn-split span { display: block; height: 100%; }
      .ppn-split-key { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; flex-wrap: wrap; }
      .ppn-split-key span { display: inline-flex; align-items: center; gap: 6px; font-family: ${FM}; font-size: 10.5px; color: ${C.textMuted}; }
      .ppn-split-key i { width: 7px; height: 7px; border-radius: 2px; flex: 0 0 auto; }
      .ppn-split-key b { color: ${C.textPrimary}; font-weight: 600; }
    `}</style>
  );
}
