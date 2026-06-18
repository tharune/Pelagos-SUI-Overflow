"use client";

// ---------------------------------------------------------------------------
// BTC Volatility desk — an equity-derivatives-style vol trading surface. Pick a
// structured strategy (straddle / strangle / butterfly / iron condor), see its
// payoff diagram, live Greeks, and a delta-hedge that ticks in real time off the
// live BTC mark. The structure is minted on-chain on Sui; the BTC mark is live
// from a Sui venue; the perp hedge routing is simulated on testnet.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { friendlyWalletError } from "../_lib/chain";
import { useWalletSigner } from "../_lib/wallet-bridge";
import { ConnectModal } from "@mysten/dapp-kit";
import { ResultLine, Cap, StripStyles, openableBuckets, dollars } from "../_components/strip-products";
import {
  fetchVolDeskSurface,
  volQuote,
  fetchVolMark,
  ensureManager,
  prepareVolOpen,
  confirmPredict,
  usd,
  type VolQuote,
  type VolDeskSurface,
  type VolStrategy,
  type BtcMark,
} from "../_lib/predict-strip-client";

type StratMeta = { id: VolStrategy; label: string; side: "long" | "short"; blurb: string };
const STRATS: StratMeta[] = [
  { id: "straddle", label: "Straddle", side: "long", blurb: "Long gamma · ATM" },
  { id: "strangle", label: "Strangle", side: "long", blurb: "Long gamma · wide" },
  { id: "butterfly", label: "Butterfly", side: "short", blurb: "Short gamma · pinned" },
  { id: "condor", label: "Iron Condor", side: "short", blurb: "Short gamma · ranged" },
];
const sideColor = (s: "long" | "short") => (s === "long" ? C.green : C.violet);

const money = (v: number, d = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;

/** Short, de-branded venue label for the live mark. */
function shortVenue(m?: BtcMark | null): string {
  if (!m) return "—";
  switch (m.source) {
    case "deepbook": return "Sui CLOB";
    case "bluefin": return "Bluefin perp";
    case "pyth": return "Pyth oracle";
    case "coinbase": return "Coinbase";
    default: return "Sui forward";
  }
}

export default function VolatilityPage() {
  const wallet = useWalletSigner();
  const [strategy, setStrategy] = useState<VolStrategy>("straddle");
  // Institutional default: at $100 the gamma/delta-hedge numbers round to
  // 0.0000 and the desk reads as dead. A $25k ticket makes the Greeks, the
  // payoff P&L axis, and the live delta-hedge all read meaningfully.
  const [notional, setNotional] = useState("25000");
  const [surface, setSurface] = useState<VolDeskSurface | null>(null);
  const [q, setQ] = useState<VolQuote | null>(null);
  const [liveMark, setLiveMark] = useState<BtcMark | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hedged, setHedged] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const notionalNum = Number(notional);
  const valid = Number.isFinite(notionalNum) && notionalNum > 0;
  const meta = STRATS.find((s) => s.id === strategy)!;
  const accent = sideColor(meta.side);

  useEffect(() => {
    let alive = true;
    fetchVolDeskSurface().then((s) => { if (alive) setSurface(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Re-price the structure (debounced) + poll every 8s so Greeks stay live.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    const run = () =>
      volQuote({ strategy, notional_usd: notionalNum, sender: wallet.address ?? undefined })
        .then((r) => { if (alive) { setQ(r); setErr(null); } })
        .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, 200);
    const poll = window.setInterval(run, 8000);
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); window.clearInterval(poll); };
  }, [strategy, notionalNum, valid, wallet.address]);

  // Fast live BTC mark — ticks the desk in real time (2s).
  useEffect(() => {
    let alive = true;
    const tick = () => fetchVolMark().then((r) => { if (alive) setLiveMark(r.mark); }).catch(() => {});
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  useEffect(() => { setHedged(null); }, [strategy, notionalNum]);

  const g = q?.greeks ?? null;
  const tradeable = q ? q.strip.buckets.filter((b) => b.tradeable).length : 0;

  // Live mark drives the real-time hedge: the position is delta-neutral at the
  // quote forward; as BTC ticks away from it, gamma generates delta to re-hedge,
  // and (for long gamma) a convexity P&L accrues.
  const fwd = q?.forward_usd ?? 0;
  const markPrice = liveMark?.mark ?? q?.mark.mark ?? fwd;
  const moveUsd = fwd ? markPrice - fwd : 0;
  const movePct = fwd ? (moveUsd / fwd) * 100 : 0;
  const runDelta = g ? g.delta_btc + g.gamma * moveUsd : 0;
  const gammaPnl = g ? 0.5 * g.gamma * moveUsd * moveUsd : 0;
  const hedgeSide = runDelta > 1e-6 ? "short" : runDelta < -1e-6 ? "long" : "flat";
  const hedgeBtc = Math.abs(runDelta);
  const venue = shortVenue(liveMark ?? q?.mark);
  const onSui = (liveMark ?? q?.mark)?.chain === "sui";

  async function openPosition() {
    if (!q || busy) return;
    setBusy(true); setOpenErr(null); setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const buckets = openableBuckets(q.strip.buckets);
      if (buckets.length === 0) throw new Error("No tradeable legs in this structure right now.");
      setStage("Building structure…");
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
    if (!q || hedgeSide === "flat") return;
    setHedged(`${hedgeSide.toUpperCase()} ${hedgeBtc.toFixed(4)} BTC-PERP @ ${dollars(markPrice)} · simulated fill`);
  }

  const ivPct = q ? (q.atm_iv * 100).toFixed(1) : surface ? ((surface.term_structure[0]?.atm_iv ?? 0) * 100).toFixed(1) : "—";
  const rvPct = surface ? (surface.realized_vol * 100).toFixed(1) : "—";
  const vrp = surface ? surface.vol_risk_premium * 100 : 0;

  return (
    <>
      <Header />
      <PageFrame wide>
        <div className="vd">
          {/* top: title + live BTC ticker */}
          <div className="vd-top">
            <div>
              <div className="vd-eyebrow">BTC volatility</div>
              <h1>Volatility</h1>
              <p>Trade BTC implied‑vs‑realized vol with structured option strategies, then delta‑hedge the gamma on a BTC perp.</p>
            </div>
            <div className="vd-ticker">
              <span className="vd-ticker-k">BTC mark</span>
              <strong key={Math.round(markPrice)}>{dollars(markPrice)}</strong>
              <span className="vd-ticker-v">
                <i className={`vd-dot${onSui ? " on" : ""}`} />{venue} · live
              </span>
            </div>
          </div>

          {/* market stat strip */}
          <div className="vd-stats">
            <Stat label="Implied vol" value={`${ivPct}%`} hint={q ? `${q.tenor_label} tenor` : "front"} color={C.tealLight} />
            <Stat label="Realized vol" value={`${rvPct}%`} hint={surface ? `${surface.rv_window_hours}h` : "trailing"} />
            <Stat label="Vol premium" value={`${vrp >= 0 ? "+" : ""}${vrp.toFixed(1)}%`} hint="implied − realized" color={vrp >= 0 ? C.green : C.red} />
            <Stat label="Forward" value={fwd ? dollars(fwd) : "—"} hint="at quote" />
            <Stat label="Spot vs fwd" value={`${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%`} hint="live drift" color={movePct >= 0 ? C.green : C.red} />
          </div>

          {err && <div className="vd-err">{err}</div>}

          {/* main desk: structure (left, wide) + hedge/ticket (right) */}
          <div className="vd-grid">
            {/* LEFT */}
            <div className="vd-main">
              {/* strategy selector */}
              <div className="vd-card vd-strats">
                {STRATS.map((s) => {
                  const on = s.id === strategy;
                  const c = sideColor(s.side);
                  return (
                    <button key={s.id} className={`vd-strat${on ? " is-active" : ""}`} style={on ? { borderColor: c, background: `${c}14` } : undefined} onClick={() => setStrategy(s.id)}>
                      <ShapeIcon strategy={s.id} color={on ? c : C.textMuted} />
                      <b style={on ? { color: c } : undefined}>{s.label}</b>
                      <em>{s.blurb}</em>
                    </button>
                  );
                })}
              </div>

              {/* controls + thesis */}
              <div className="vd-card vd-ctrls">
                <div className="vd-amount">
                  <Cap>Notional</Cap>
                  <div className="vd-amount-in">
                    <input className="vd-num" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
                    <span>dUSDC</span>
                  </div>
                </div>
                <div className="vd-ctrl-meta">
                  <div><Cap>Horizon</Cap><strong>{q ? q.tenor_label : "—"} · {tradeable} strikes</strong></div>
                  <p>{q?.thesis ?? meta.blurb}</p>
                </div>
              </div>

              {/* payoff diagram */}
              <div className="vd-card vd-payoff">
                <div className="vd-card-head"><Cap>Payoff at expiry · {q?.strategy_label ?? meta.label}</Cap><span className="vd-dim">P&L vs BTC settlement</span></div>
                <PayoffDiagram quote={q} markPrice={markPrice} accent={accent} />
              </div>

              {/* greeks */}
              <div className="vd-card vd-greeks">
                <Greek sym="Δ" name="Delta" val={g ? `${g.delta_btc >= 0 ? "+" : ""}${g.delta_btc.toFixed(4)}` : "—"} unit="BTC" />
                <Greek sym="Γ" name="Gamma" val={g ? g.gamma.toFixed(5) : "—"} color={g ? (g.gamma >= 0 ? C.green : C.red) : undefined} />
                <Greek sym="ν" name="Vega" val={g ? `${g.vega_usd >= 0 ? "+" : ""}${money(g.vega_usd)}` : "—"} unit="/pt" color={g ? (g.vega_usd >= 0 ? C.green : C.red) : undefined} />
                <Greek sym="Θ" name="Theta" val={g ? `${g.theta_usd_day >= 0 ? "+" : ""}${money(g.theta_usd_day)}` : "—"} unit="/day" color={g ? (g.theta_usd_day >= 0 ? C.green : C.red) : undefined} />
              </div>

              {/* structure legs */}
              <div className="vd-card vd-legs">
                <div className="vd-card-head"><Cap>Structure · {tradeable} legs</Cap><span className="vd-dim">range strikes on Sui</span></div>
                <div className="vd-legs-table">
                  <div className="vd-leg vd-leg-h"><span>Strike band</span><span>Contracts</span><span>Cost</span><span>Pays</span></div>
                  {q ? q.strip.buckets.filter((b) => b.tradeable).map((b, i) => (
                    <div className="vd-leg" key={i}>
                      <span className="vd-leg-band">{dollars(b.lower_usd)}–{dollars(b.higher_usd)}</span>
                      <span>{(Number(b.quantity) / 1e6).toFixed(0)}</span>
                      <span>{usd(b.mint_cost_raw)}</span>
                      <span style={{ color: accent }}>{usd(b.max_payout_raw)}</span>
                    </div>
                  )) : <div className="vd-leg-empty">pricing…</div>}
                </div>
              </div>
            </div>

            {/* RIGHT */}
            <div className="vd-side">
              {/* live delta hedge */}
              <div className="vd-card vd-hedge">
                <div className="vd-card-head">
                  <Cap>Delta hedge · BTC perp</Cap>
                  <span className="vd-live"><i className="vd-dot on" />live</span>
                </div>
                <div className="vd-hedge-delta">
                  <div>
                    <span>Net delta now</span>
                    <strong key={runDelta.toFixed(4)} style={{ color: Math.abs(runDelta) < 1e-4 ? C.textPrimary : accent }}>
                      {runDelta >= 0 ? "+" : ""}{runDelta.toFixed(4)} <em>BTC</em>
                    </strong>
                  </div>
                  <div className="vd-hedge-pnl">
                    <span>Gamma P&L</span>
                    <strong style={{ color: gammaPnl >= 0 ? C.green : C.red }}>{gammaPnl >= 0 ? "+" : ""}{money(gammaPnl)}</strong>
                  </div>
                </div>
                <div className="vd-hedge-rows">
                  <Row k="Hedge order" v={hedgeSide === "flat" ? "delta-neutral" : `${hedgeSide === "short" ? "Short" : "Long"} ${hedgeBtc.toFixed(4)} BTC`} color={hedgeSide === "flat" ? undefined : accent} />
                  <Row k="BTC-PERP mark" v={dollars(markPrice)} live />
                  <Row k="Spot drift" v={`${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%`} color={movePct >= 0 ? C.green : C.red} />
                  <Row k="Funding (8h)" v={q ? `${(q.hedge.funding_rate * 100).toFixed(3)}%` : "—"} hint={(liveMark ?? q?.mark)?.funding_source === "bluefin" ? "Bluefin" : "est."} />
                </div>
                <button className="vd-hedge-btn" disabled={!q || hedgeSide === "flat" || Boolean(hedged)} onClick={routeHedge}>
                  {hedged ? "✓ Hedge routed" : hedgeSide === "flat" ? "Delta-neutral" : `Route ${hedgeSide} ${hedgeBtc.toFixed(4)} BTC`}
                </button>
                {hedged && <div className="vd-sim">✓ {hedged}</div>}
                <p className="vd-note">Structure minted on‑chain on Sui. BTC mark live from {venue}; perp routing simulated on testnet.</p>
              </div>

              {/* ticket */}
              <div className="vd-card vd-ticket">
                <div className="vd-card-head"><Cap>{meta.label} · {meta.side} vol</Cap><span className="vd-dim">{tradeable}/{q?.strip.buckets.length ?? 0}</span></div>
                <div className="vd-hedge-rows">
                  <Row k="Entry cost" v={q ? usd(q.strip.total_cost_raw) : "—"} />
                  <Row k="Max payout" v={q ? usd(q.strip.realized_max_payout_raw) : "—"} color={C.tealLight} />
                  <Row k="Max loss" v={q ? money(q.max_loss_usd) : "—"} hint="premium" />
                </div>
                {!wallet.connected ? (
                  <ConnectModal trigger={<button className="vd-open-btn" style={{ background: accent }}>Connect a wallet</button>} />
                ) : (
                  <button className="vd-open-btn" style={{ background: accent }} disabled={busy || !q || tradeable === 0} onClick={openPosition}>
                    {busy ? (stage ?? "Submitting…") : `Open ${meta.label} · ${q ? usd(q.strip.total_cost_raw) : ""}`}
                  </button>
                )}
                {result && <ResultLine digest={result} label={`${meta.label} opened`} />}
                {openErr && <div className="vd-err" style={{ marginTop: 10 }}>{openErr}</div>}
              </div>
            </div>
          </div>
        </div>
      </PageFrame>
      <StripStyles />
      <style jsx global>{VD_CSS}</style>
    </>
  );
}

function Stat({ label, value, hint, color }: { label: string; value: string; hint: string; color?: string }) {
  return (
    <div className="vd-stat">
      <span className="vd-stat-k">{label}</span>
      <strong style={color ? { color } : undefined}>{value}</strong>
      <span className="vd-stat-h">{hint}</span>
    </div>
  );
}

function Greek({ sym, name, val, unit, color }: { sym: string; name: string; val: string; unit?: string; color?: string }) {
  return (
    <div className="vd-greek">
      <span className="vd-greek-k">{sym}<i>{name}</i></span>
      <strong style={color ? { color } : undefined}>{val}{unit && <em>{unit}</em>}</strong>
    </div>
  );
}

function Row({ k, v, color, hint, live }: { k: string; v: string; color?: string; hint?: string; live?: boolean }) {
  return (
    <div className="vd-row">
      <span>{k}{hint && <i>{hint}</i>}</span>
      <strong style={color ? { color } : undefined} className={live ? "vd-row-live" : undefined}>{v}</strong>
    </div>
  );
}

/** Tiny inline glyph hinting each structure's payoff shape. */
function ShapeIcon({ strategy, color }: { strategy: VolStrategy; color: string }) {
  const d =
    strategy === "straddle" ? "M2 4 L9 11 L16 4"
      : strategy === "strangle" ? "M2 4 L6 11 L12 11 L16 4"
        : strategy === "butterfly" ? "M2 11 L9 4 L16 11"
          : "M2 11 L6 4 L12 4 L16 11"; // condor
  return (
    <svg width="20" height="14" viewBox="0 0 18 14" fill="none" style={{ flexShrink: 0 }}>
      <path d={d} stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Classic options payoff diagram: net P&L vs BTC settlement price, with the
 *  forward and the live mark marked. Profit shaded accent, loss shaded red. */
function PayoffDiagram({ quote, markPrice, accent }: { quote: VolQuote | null; markPrice: number; accent: string }) {
  const W = 760, H = 230, PL = 52, PR = 16, PT = 14, PB = 26;
  const model = useMemo(() => {
    if (!quote) return null;
    const bands = quote.strip.buckets;
    const cost = Number(quote.strip.total_cost_raw) / 1e6;
    const fwd = quote.forward_usd;
    const sig = quote.sigma_usd || fwd * 0.04;
    const lo = Math.max(0, fwd - 3.4 * sig), hi = fwd + 3.4 * sig;
    const payoff = (x: number) => {
      for (const b of bands) if (b.tradeable && x > b.lower_usd && x <= b.higher_usd) return Number(b.quantity) / 1e6;
      return 0;
    };
    const N = 160;
    const pts = Array.from({ length: N }, (_, i) => {
      const x = lo + (i / (N - 1)) * (hi - lo);
      return { x, pnl: payoff(x) - cost };
    });
    const ys = pts.map((p) => p.pnl);
    return { pts, lo, hi, fwd, cost, yMin: Math.min(...ys, 0), yMax: Math.max(...ys, 0) };
  }, [quote]);

  if (!model) return <div className="vd-payoff-empty">pricing…</div>;
  const { pts, lo, hi, fwd, yMin, yMax } = model;
  const sx = (x: number) => PL + ((x - lo) / (hi - lo || 1)) * (W - PL - PR);
  const yPad = (yMax - yMin) * 0.12 || 1;
  const lo2 = yMin - yPad, hi2 = yMax + yPad;
  const sy = (v: number) => PT + (1 - (v - lo2) / (hi2 - lo2 || 1)) * (H - PT - PB);
  const zeroY = sy(0);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.pnl).toFixed(1)}`).join(" ");
  const areaPos = `${line} L ${sx(hi).toFixed(1)} ${zeroY} L ${sx(lo).toFixed(1)} ${zeroY} Z`;
  const markX = Math.max(lo, Math.min(hi, markPrice));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
      <defs>
        <clipPath id="vd-pos"><rect x={PL} y={PT} width={W - PL - PR} height={zeroY - PT} /></clipPath>
        <clipPath id="vd-neg"><rect x={PL} y={zeroY} width={W - PL - PR} height={H - PB - zeroY} /></clipPath>
      </defs>
      {/* y gridlines */}
      {[yMax, 0, yMin].map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke={C.border} strokeWidth="1" opacity={v === 0 ? 0.9 : 0.4} vectorEffect="non-scaling-stroke" />
          <text x={PL - 8} y={sy(v) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9.5">{v >= 0 ? "+$" : "-$"}{Math.abs(Math.round(v)).toLocaleString()}</text>
        </g>
      ))}
      {/* profit / loss shading */}
      <g clipPath="url(#vd-pos)"><path d={areaPos} fill={accent} opacity={0.16} /></g>
      <g clipPath="url(#vd-neg)"><path d={areaPos} fill={C.red} opacity={0.12} /></g>
      {/* forward marker */}
      <line x1={sx(fwd)} x2={sx(fwd)} y1={PT} y2={H - PB} stroke={C.textMuted} strokeWidth="1" strokeDasharray="3 3" opacity={0.6} />
      <text x={sx(fwd)} y={H - 8} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9">fwd {dollars(fwd)}</text>
      {/* live mark marker */}
      <line x1={sx(markX)} x2={sx(markX)} y1={PT} y2={H - PB} stroke={C.tealLight} strokeWidth="1.2" opacity={0.85} />
      <circle cx={sx(markX)} cy={PT + 4} r={3} fill={C.tealLight} />
      {/* payoff curve */}
      <path d={line} fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const VD_CSS = `
  .vd { max-width: 1480px; margin: 0 auto; display: grid; gap: 14px; min-width: 0; }
  .vd-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .vd-eyebrow { font-family: ${FM}; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: ${C.teal}; }
  .vd-top h1 { margin: 6px 0 0; font-family: ${FD}; font-size: 30px; font-weight: 600; letter-spacing: -0.03em; color: ${C.textPrimary}; }
  .vd-top p { margin: 8px 0 0; max-width: 560px; font-family: ${FS}; font-size: 13px; line-height: 1.55; color: ${C.textSecondary}; }
  .vd-ticker { text-align: right; border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 12px; padding: 12px 18px; min-width: 200px; }
  .vd-ticker-k { font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-ticker strong { display: block; margin: 3px 0; font-family: ${FD}; font-size: 28px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; animation: vd-flash 0.5s ${EASE}; }
  .vd-ticker-v { font-family: ${FM}; font-size: 10px; color: ${C.textMuted}; display: inline-flex; align-items: center; gap: 5px; }
  .vd-dot { width: 6px; height: 6px; border-radius: 50%; background: ${C.textMuted}; display: inline-block; }
  .vd-dot.on { background: ${C.green}; box-shadow: 0 0 7px ${C.green}; animation: vd-pulse 2s ${EASE} infinite; }
  @keyframes vd-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
  @keyframes vd-flash { 0% { color: ${C.tealLight}; } 100% { color: ${C.textPrimary}; } }

  .vd-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 12px; overflow: hidden; }
  .vd-stat { background: ${C.card}; padding: 11px 14px; display: grid; gap: 3px; }
  .vd-stat-k { font-family: ${FM}; font-size: 9px; letter-spacing: 0.09em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-stat strong { font-family: ${FD}; font-size: 17px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vd-stat-h { font-family: ${FM}; font-size: 9.5px; color: ${C.textMuted}; }

  .vd-err { border: 0.5px solid ${C.red}55; background: ${C.redBg}; border-radius: 10px; padding: 11px 14px; font-family: ${FM}; font-size: 12px; color: ${C.red}; }

  .vd-grid { display: grid; grid-template-columns: minmax(0, 1.62fr) minmax(330px, 0.92fr); gap: 14px; align-items: start; }
  @media (max-width: 1080px) { .vd-grid { grid-template-columns: 1fr; } .vd-stats { grid-template-columns: repeat(2, 1fr); } .vd-top { flex-direction: column; } .vd-ticker { text-align: left; } }
  .vd-main, .vd-side { display: grid; gap: 14px; min-width: 0; align-content: start; }
  .vd-card { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 15px 16px; min-width: 0; }
  .vd-card-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
  .vd-dim, .vd-live { font-family: ${FM}; font-size: 10px; color: ${C.textMuted}; }
  .vd-live { display: inline-flex; align-items: center; gap: 5px; color: ${C.green}; }

  .vd-strats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; padding: 12px; }
  .vd-strat { display: grid; gap: 5px; justify-items: start; padding: 12px; border-radius: 11px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: pointer; transition: all 0.15s ${EASE}; }
  .vd-strat:hover { border-color: ${C.borderHover}; transform: translateY(-1px); }
  .vd-strat b { font-family: ${FD}; font-size: 13.5px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-strat em { font-family: ${FM}; font-size: 9.5px; font-style: normal; color: ${C.textMuted}; }

  .vd-ctrls { display: grid; grid-template-columns: 220px 1fr; gap: 16px; align-items: center; }
  .vd-amount { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 11px; padding: 10px 13px; display: grid; gap: 6px; }
  .vd-amount-in { display: flex; align-items: baseline; gap: 8px; }
  .vd-num { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: ${C.textPrimary}; font-family: ${FD}; font-size: 22px; font-weight: 600; padding: 0; }
  .vd-amount-in span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }
  .vd-ctrl-meta div { display: flex; align-items: baseline; gap: 10px; }
  .vd-ctrl-meta strong { font-family: ${FD}; font-size: 14px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-ctrl-meta p { margin: 7px 0 0; font-family: ${FS}; font-size: 12px; line-height: 1.5; color: ${C.textSecondary}; }

  .vd-payoff-empty { height: 230px; display: grid; place-items: center; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }

  .vd-greeks { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .vd-greek { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 10px; padding: 11px 13px; display: grid; gap: 5px; }
  .vd-greek-k { font-family: ${FM}; font-size: 11px; color: ${C.textSecondary}; display: flex; align-items: baseline; gap: 5px; }
  .vd-greek-k i { font-style: normal; font-size: 8.5px; letter-spacing: 0.05em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-greek strong { font-family: ${FD}; font-size: 17px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vd-greek strong em { font-family: ${FM}; font-size: 9.5px; font-style: normal; color: ${C.textMuted}; margin-left: 3px; }

  .vd-legs-table { border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; }
  .vd-leg { display: grid; grid-template-columns: minmax(0, 1.7fr) 1fr 1fr 1fr; gap: 10px; align-items: center; padding: 9px 13px; border-bottom: 0.5px solid ${C.border}; font-family: ${FM}; font-size: 11.5px; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vd-leg:last-child { border-bottom: 0; }
  .vd-leg span:not(.vd-leg-band) { text-align: right; }
  .vd-leg-band { color: ${C.textSecondary}; }
  .vd-leg-h { background: ${C.surface}; font-size: 9px; letter-spacing: 0.09em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-leg-empty { padding: 22px; text-align: center; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }

  .vd-hedge-delta { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 12px 14px; border-radius: 11px; background: ${C.surface}; border: 0.5px solid ${C.border}; margin-bottom: 12px; }
  .vd-hedge-delta > div > span, .vd-hedge-pnl span { display: block; font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.05em; text-transform: uppercase; color: ${C.textMuted}; margin-bottom: 4px; }
  .vd-hedge-delta strong { font-family: ${FD}; font-size: 20px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vd-hedge-delta strong em { font-family: ${FM}; font-size: 10px; font-style: normal; color: ${C.textMuted}; }
  .vd-hedge-pnl { text-align: right; }
  .vd-hedge-pnl strong { font-size: 16px; }
  .vd-hedge-rows { display: grid; gap: 9px; }
  .vd-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .vd-row span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; display: flex; align-items: baseline; gap: 6px; }
  .vd-row span i { font-style: normal; font-size: 9px; color: ${C.textMuted}; opacity: 0.7; }
  .vd-row strong { font-family: ${FD}; font-size: 13px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vd-row-live { animation: vd-flash 0.5s ${EASE}; }
  .vd-hedge-btn { width: 100%; height: 42px; margin-top: 13px; border: 0.5px solid ${C.tealLight}55; border-radius: 11px; background: ${C.tealBg}; color: ${C.tealLight}; font-family: ${FD}; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s ${EASE}; }
  .vd-hedge-btn:hover:not(:disabled) { border-color: ${C.tealLight}; }
  .vd-hedge-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .vd-sim { margin-top: 9px; font-family: ${FM}; font-size: 11px; color: ${C.green}; }
  .vd-note { margin: 11px 0 0; font-family: ${FS}; font-size: 10.5px; line-height: 1.5; color: ${C.textMuted}; }

  .vd-ticket .vd-hedge-rows { margin-bottom: 14px; }
  .vd-open-btn { width: 100%; height: 46px; border: none; border-radius: 12px; color: #04121d; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.15s ${EASE}, transform 0.15s ${EASE}; }
  .vd-open-btn:hover:not(:disabled) { transform: translateY(-1px); }
  .vd-open-btn:disabled { opacity: 0.5; cursor: not-allowed; }
`;
