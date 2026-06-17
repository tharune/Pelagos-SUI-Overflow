"use client";

// ---------------------------------------------------------------------------
// Volatility desk — trade BTC implied-vs-realized vol like an equity-derivatives
// desk. Long vol = a barbell strip (long gamma, pays on big moves); short vol =
// a pin strip (short gamma, pays if BTC stays). The vol leg is a real DeepBook
// Predict strip (devInspect-priced, wallet-minted). Position Greeks (Δ/Γ/Vega/Θ)
// are computed live, and the net delta is delta-hedged with a BTC perp: real
// Bluefin BTC-PERP mark + funding, with simulated order routing.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { MetricTile } from "../_components/charts";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { friendlyWalletError } from "../_lib/chain";
import { useWalletSigner } from "../_lib/wallet-bridge";
import { ConnectModal } from "@mysten/dapp-kit";
import { OpenButton, ResultLine, Cap, StripStyles, openableBuckets, dollars } from "../_components/strip-products";
import {
  fetchVolDeskSurface,
  volQuote,
  ensureManager,
  prepareVolOpen,
  confirmPredict,
  usd,
  type VolQuote,
  type VolDeskSurface,
} from "../_lib/predict-strip-client";

type Side = "long" | "short";
const sideColor = (s: Side) => (s === "long" ? C.green : C.violet);

export default function VolatilityPage() {
  const wallet = useWalletSigner();
  const [side, setSide] = useState<Side>("long");
  const [notional, setNotional] = useState("100");
  const [surface, setSurface] = useState<VolDeskSurface | null>(null);
  const [q, setQ] = useState<VolQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hedged, setHedged] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const notionalNum = Number(notional);
  const valid = Number.isFinite(notionalNum) && notionalNum > 0;
  const accent = sideColor(side);

  useEffect(() => {
    let alive = true;
    fetchVolDeskSurface().then((s) => { if (alive) setSurface(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Price the vol position (debounced) + poll every 6s so the mark/Greeks stay live.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    setLoading(true);
    const run = () =>
      volQuote({ side, notional_usd: notionalNum, sender: wallet.address ?? undefined })
        .then((r) => { if (alive) { setQ(r); setErr(null); } })
        .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (alive) setLoading(false); });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, 250);
    const poll = window.setInterval(run, 6000);
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); window.clearInterval(poll); };
  }, [side, notionalNum, valid, wallet.address]);

  // reset the simulated hedge whenever the position changes
  useEffect(() => { setHedged(null); }, [side, notionalNum]);

  const g = q?.greeks ?? null;
  const tradeable = q ? q.strip.buckets.filter((b) => b.tradeable).length : 0;

  async function openPosition() {
    if (!q || busy) return;
    setBusy(true); setOpenErr(null); setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const buckets = openableBuckets(q.strip.buckets);
      if (buckets.length === 0) throw new Error("No tradeable bands in this vol leg right now.");
      setStage("Building position…");
      const deposit = ((BigInt(q.strip.total_cost_raw) * 12n) / 10n).toString();
      const prep = await prepareVolOpen({ owner: wallet.address as string, manager_id: mgr, oracle_id: q.oracle_id, expiry: q.expiry, buckets, deposit_amount_raw: deposit });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult(c.digest);
    } catch (e) { setOpenErr(friendlyWalletError(e)); }
    finally { setBusy(false); setStage(null); }
  }

  function routeHedge() {
    if (!q || q.hedge.side === "flat") return;
    setHedged(`${q.hedge.side.toUpperCase()} ${q.hedge.size_btc.toFixed(4)} BTC-PERP @ ${dollars(q.hedge.mark)} · simulated fill`);
  }

  const tenorMin = q ? Math.round(q.t_years * 365 * 24 * 60) : 0;
  const ivPct = q ? (q.atm_iv * 100).toFixed(1) : surface ? ((surface.term_structure[0]?.atm_iv ?? 0) * 100).toFixed(1) : "—";
  const rvPct = surface ? (surface.realized_vol * 100).toFixed(1) : "—";
  const vrp = surface ? surface.vol_risk_premium * 100 : 0;

  return (
    <>
      <Header />
      <PageFrame wide>
        <div className="vol-shell">
          <div className="vol-hero">
            <div>
              <div className="vol-eyebrow">DeepBook Predict × Bluefin · Volatility desk</div>
              <h1>Volatility</h1>
              <p>Trade BTC implied‑vs‑realized vol. Go long gamma (pays on big moves) or short gamma (pays if BTC stays), then delta‑hedge the position with a BTC perp — the equity‑derivatives‑desk workflow, on Sui.</p>
            </div>
          </div>

          {/* IV / RV / VRP strip + term structure */}
          <div className="vol-top">
            <div className="vol-tiles">
              <MetricTile label="ATM IMPLIED VOL" value={`${ivPct}%`} color={C.tealLight} sub={q ? `${tenorMin}m tenor` : "front tenor"} />
              <MetricTile label="REALIZED VOL" value={`${rvPct}%`} sub={surface ? `${surface.rv_window_hours}h · ${surface.rv_source}` : "trailing"} />
              <MetricTile label="VOL RISK PREMIUM" value={`${vrp >= 0 ? "+" : ""}${vrp.toFixed(1)}%`} color={vrp >= 0 ? C.green : C.red} sub="implied − realized" />
              <MetricTile label="BTC MARK" value={q ? dollars(q.mark.mark) : "—"} sub={q ? q.mark.venue : "perp/spot"} />
            </div>
            <div className="vol-term">
              <Cap>ATM IV term structure</Cap>
              <TermChart surface={surface} rv={surface?.realized_vol ?? 0} />
            </div>
          </div>

          {err && <div className="vol-err">{err}</div>}

          <div className="vol-grid">
            {/* LEFT — position + greeks */}
            <div className="vol-left">
              <div className="vol-card">
                <div className="vol-side">
                  {(["long", "short"] as Side[]).map((s) => (
                    <button key={s} type="button" className={`vol-side-btn${side === s ? " is-active" : ""}`} data-side={s} onClick={() => setSide(s)}>
                      {s === "long" ? "Long vol" : "Short vol"}
                      <em>{s === "long" ? "+gamma · pays on moves" : "−gamma · pays if calm"}</em>
                    </button>
                  ))}
                </div>
                <div className="vol-amount">
                  <Cap>Notional (dUSDC)</Cap>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <input className="vol-num" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
                    <span style={{ fontFamily: FM, fontSize: 11, color: C.textSecondary }}>dUSDC</span>
                  </div>
                </div>
                <PayoffShape quote={q} accent={accent} />
              </div>

              {/* Greeks */}
              <div className="vol-card">
                <Cap style={{ marginBottom: 12 }}>Position Greeks</Cap>
                <div className="vol-greeks">
                  <Greek label="Δ Delta" value={g ? `${g.delta_btc >= 0 ? "+" : ""}${g.delta_btc.toFixed(4)}` : "—"} unit="BTC" hint="directional exposure" />
                  <Greek label="Γ Gamma" value={g ? g.gamma.toFixed(5) : "—"} unit="" hint={side === "long" ? "long convexity" : "short convexity"} color={g ? (g.gamma >= 0 ? C.green : C.red) : undefined} />
                  <Greek label="ν Vega" value={g ? `${g.vega_usd >= 0 ? "+" : ""}$${g.vega_usd.toFixed(2)}` : "—"} unit="/ vol pt" hint="per +1% IV" color={g ? (g.vega_usd >= 0 ? C.green : C.red) : undefined} />
                  <Greek label="Θ Theta" value={g ? `${g.theta_usd_day / 24 >= 0 ? "+" : ""}$${(g.theta_usd_day / 24).toFixed(2)}` : "—"} unit="/ hr" hint="time decay" color={g ? (g.theta_usd_day >= 0 ? C.green : C.red) : undefined} />
                </div>
              </div>
            </div>

            {/* RIGHT — hedge + open */}
            <div className="vol-right">
              <div className="vol-card vol-hedge">
                <div className="vol-card-head"><Cap>Delta hedge · BTC perp</Cap><span className="vol-dim">{q ? q.mark.source : "—"}</span></div>
                <div className="vol-hedge-net">
                  <span>Net delta</span>
                  <strong>{g ? `${g.delta_btc >= 0 ? "+" : ""}${g.delta_btc.toFixed(4)} BTC` : "—"}</strong>
                </div>
                <div className="vol-hedge-rows">
                  <Row k="Hedge" v={q && q.hedge.side !== "flat" ? `${q.hedge.side === "short" ? "Short" : "Long"} ${q.hedge.size_btc.toFixed(4)} BTC` : "delta-neutral"} color={accent} />
                  <Row k="Notional" v={q ? usd((q.hedge.notional_usd * 1e6).toFixed(0)) : "—"} />
                  <Row k="BTC-PERP mark" v={q ? dollars(q.hedge.mark) : "—"} />
                  <Row k="Funding (8h)" v={q ? `${(q.hedge.funding_rate * 100).toFixed(3)}%` : "—"} />
                </div>
                <button className="vol-hedge-btn" disabled={!q || q.hedge.side === "flat" || Boolean(hedged)} onClick={routeHedge}>
                  {hedged ? "✓ Hedge routed" : q && q.hedge.side === "flat" ? "Already delta-neutral" : "Route hedge on Bluefin"}
                </button>
                {hedged && <div className="vol-sim">✓ {hedged}</div>}
                <p className="vol-note">The vol leg mints on DeepBook Predict (real, on‑chain). The hedge mark/funding are live from {q?.mark.venue ?? "Bluefin/Coinbase"}; order routing is simulated on testnet.</p>
              </div>

              <div className="vol-card">
                <div className="vol-card-head"><Cap>Open · {side === "long" ? "long" : "short"} vol</Cap><span className="vol-dim">{tradeable}/{q?.strip.buckets.length ?? 0} bands</span></div>
                <div className="vol-open-rows">
                  <Row k="Entry cost" v={q ? usd(q.strip.total_cost_raw) : "—"} />
                  <Row k="Best case" v={q ? usd(q.strip.realized_max_payout_raw) : "—"} color={C.tealLight} />
                  <Row k="Round-trip spread" v={q ? usd(q.strip.round_trip_spread_raw) : "—"} color={C.amber} />
                </div>
                {!wallet.connected ? (
                  <ConnectModal trigger={<button className="vol-open-btn">Connect a wallet to open</button>} />
                ) : (
                  <button className="vol-open-btn" disabled={busy || !q || tradeable === 0} onClick={openPosition}>
                    {busy ? (stage ?? "Submitting…") : `Open ${side} vol · ${q ? usd(q.strip.total_cost_raw) : ""}`}
                  </button>
                )}
                {result && <ResultLine digest={result} label={`${side} vol opened`} />}
                {openErr && <div className="vol-err" style={{ marginTop: 10 }}>{openErr}</div>}
              </div>
            </div>
          </div>
        </div>
      </PageFrame>
      <StripStyles />
      <style jsx global>{VOL_CSS}</style>
    </>
  );
}

function Greek({ label, value, unit, hint, color }: { label: string; value: string; unit: string; hint: string; color?: string }) {
  return (
    <div className="vol-greek">
      <span className="vol-greek-label">{label}</span>
      <strong style={color ? { color } : undefined}>{value}<em>{unit}</em></strong>
      <span className="vol-greek-hint">{hint}</span>
    </div>
  );
}

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="vol-row"><span>{k}</span><strong style={color ? { color } : undefined}>{v}</strong></div>
  );
}

/** Payoff-shape bars: one per tradeable band, height ∝ contracts. Barbell (long
 *  vol) is wings-heavy; pin (short vol) is center-heavy. */
function PayoffShape({ quote, accent }: { quote: VolQuote | null; accent: string }) {
  if (!quote) return <div className="vol-shape" style={{ display: "grid", placeItems: "center", color: C.textMuted, fontFamily: FM, fontSize: 11 }}>pricing…</div>;
  const bands = quote.strip.buckets;
  const maxQ = Math.max(...bands.map((b) => (b.tradeable ? Number(b.quantity) : 0)), 1);
  const fwd = quote.forward_usd;
  return (
    <div className="vol-shape">
      <div className="vol-shape-bars">
        {bands.map((b, i) => {
          const live = b.tradeable && Number(b.quantity) > 0;
          const h = live ? (Number(b.quantity) / maxQ) * 100 : 2;
          return <div key={i} className="vol-bar" style={{ height: `${Math.max(h, 3)}%`, background: live ? accent : `${C.textMuted}33`, opacity: live ? 0.85 : 0.4 }} title={`${dollars(b.lower_usd)}–${dollars(b.higher_usd)}`} />;
        })}
      </div>
      <div className="vol-shape-axis"><span>{dollars(bands[0]?.lower_usd ?? fwd)}</span><span style={{ color: C.tealLight }}>fwd {dollars(fwd)}</span><span>{dollars(bands[bands.length - 1]?.higher_usd ?? fwd)}</span></div>
    </div>
  );
}

/** ATM IV across tenors (solid) + realized vol (dashed) — the term structure. */
function TermChart({ surface, rv }: { surface: VolDeskSurface | null; rv: number }) {
  const W = 520, H = 96, P = 8;
  if (!surface || surface.term_structure.length < 2) return <div style={{ height: H, display: "grid", placeItems: "center", fontFamily: FM, fontSize: 11, color: C.textMuted }}>loading…</div>;
  const ts = surface.term_structure.filter((t) => t.atm_iv > 0 && t.atm_iv < 2).slice(0, 10);
  if (ts.length < 2) return <div style={{ height: H }} />;
  const ivs = ts.map((t) => t.atm_iv);
  const lo = Math.min(...ivs, rv) * 0.92, hi = Math.max(...ivs, rv) * 1.08;
  const sx = (i: number) => P + (i / (ts.length - 1)) * (W - 2 * P);
  const sy = (v: number) => P + (1 - (v - lo) / (hi - lo || 1)) * (H - 2 * P - 12);
  const line = ts.map((t, i) => `${i === 0 ? "M" : "L"} ${sx(i).toFixed(1)} ${sy(t.atm_iv).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      {rv > 0 && <line x1={P} x2={W - P} y1={sy(rv)} y2={sy(rv)} stroke={C.textMuted} strokeWidth="1" strokeDasharray="4 4" opacity={0.7} />}
      {rv > 0 && <text x={W - P} y={sy(rv) - 4} textAnchor="end" fontFamily={FM} fontSize="8.5" fill={C.textMuted}>RV {(rv * 100).toFixed(0)}%</text>}
      <path d={line} fill="none" stroke={C.tealLight} strokeWidth="1.6" strokeLinejoin="round" />
      {ts.map((t, i) => (
        <g key={i}>
          <circle cx={sx(i)} cy={sy(t.atm_iv)} r={2.2} fill={C.tealLight} />
          <text x={sx(i)} y={H - 2} textAnchor="middle" fontFamily={FM} fontSize="8" fill={C.textMuted}>{t.tenor_label}</text>
        </g>
      ))}
    </svg>
  );
}

const VOL_CSS = `
  .vol-shell { max-width: 1280px; margin: 0 auto; display: grid; gap: 16px; }
  .vol-hero h1 { margin: 8px 0 0; font-family: ${FD}; font-size: 34px; font-weight: 600; letter-spacing: -0.03em; color: ${C.textPrimary}; }
  .vol-hero p { margin: 10px 0 0; max-width: 720px; font-family: ${FS}; font-size: 14px; line-height: 1.6; color: ${C.textSecondary}; }
  .vol-eyebrow { font-family: ${FM}; font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: ${C.teal}; }
  .vol-top { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 14px; align-items: stretch; }
  @media (max-width: 980px) { .vol-top { grid-template-columns: 1fr; } }
  .vol-tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .vol-term { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
  .vol-err { border: 0.5px solid ${C.red}55; background: ${C.redBg}; border-radius: 10px; padding: 12px 14px; font-family: ${FM}; font-size: 12px; color: ${C.red}; }
  .vol-grid { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; align-items: start; }
  @media (max-width: 980px) { .vol-grid { grid-template-columns: 1fr; } }
  .vol-left, .vol-right { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .vol-card { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 16px 18px; }
  .vol-card-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
  .vol-dim { font-family: ${FM}; font-size: 10.5px; color: ${C.textMuted}; }
  .vol-side { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .vol-side-btn { display: grid; gap: 3px; padding: 12px; border-radius: 11px; border: 0.5px solid ${C.border}; background: ${C.surface}; color: ${C.textSecondary}; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.14s ${EASE}; }
  .vol-side-btn em { font-family: ${FM}; font-size: 9.5px; font-style: normal; font-weight: 400; color: ${C.textMuted}; letter-spacing: 0.02em; }
  .vol-side-btn[data-side="long"].is-active { border-color: ${C.green}; background: ${C.green}1a; color: ${C.green}; }
  .vol-side-btn[data-side="short"].is-active { border-color: ${C.violet}; background: ${C.violet}1f; color: ${C.violet}; }
  .vol-amount { margin-top: 14px; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 12px; padding: 12px 14px; display: grid; gap: 8px; }
  .vol-num { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: ${C.textPrimary}; font-family: ${FD}; font-size: 22px; padding: 0; }
  .vol-shape { margin-top: 16px; }
  .vol-shape-bars { display: flex; align-items: flex-end; gap: 3px; height: 120px; padding: 8px; border: 0.5px solid ${C.border}; border-radius: 10px; background: ${C.surface}; }
  .vol-bar { flex: 1; border-radius: 3px 3px 0 0; min-width: 0; }
  .vol-shape-axis { display: flex; justify-content: space-between; margin-top: 7px; font-family: ${FM}; font-size: 9.5px; color: ${C.textMuted}; }
  .vol-greeks { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .vol-greek { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 10px; padding: 12px 13px; display: grid; gap: 4px; }
  .vol-greek-label { font-family: ${FM}; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.textMuted}; }
  .vol-greek strong { font-family: ${FD}; font-size: 20px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vol-greek strong em { font-family: ${FM}; font-size: 10px; font-style: normal; color: ${C.textMuted}; margin-left: 4px; }
  .vol-greek-hint { font-family: ${FS}; font-size: 10.5px; color: ${C.textMuted}; }
  .vol-hedge-net { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 14px; border-radius: 10px; background: ${C.surface}; border: 0.5px solid ${C.border}; }
  .vol-hedge-net span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; letter-spacing: 0.06em; text-transform: uppercase; }
  .vol-hedge-net strong { font-family: ${FD}; font-size: 18px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vol-hedge-rows, .vol-open-rows { display: grid; gap: 9px; margin: 12px 0; }
  .vol-row { display: flex; justify-content: space-between; align-items: baseline; }
  .vol-row span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }
  .vol-row strong { font-family: ${FD}; font-size: 13px; font-weight: 560; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vol-hedge-btn { width: 100%; height: 42px; border: 0.5px solid ${C.tealLight}66; border-radius: 10px; background: ${C.tealBg}; color: ${C.tealLight}; font-family: ${FD}; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.14s ${EASE}; }
  .vol-hedge-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .vol-sim { margin-top: 10px; font-family: ${FM}; font-size: 11px; color: ${C.green}; }
  .vol-note { margin: 12px 0 0; font-family: ${FS}; font-size: 11px; color: ${C.textMuted}; line-height: 1.5; }
  .vol-open-btn { width: 100%; height: 46px; border: none; border-radius: 12px; background: ${C.tealLight}; color: #04121d; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.14s ${EASE}; }
  .vol-open-btn:disabled { opacity: 0.5; cursor: not-allowed; }
`;
