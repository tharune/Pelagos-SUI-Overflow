"use client";

// ---------------------------------------------------------------------------
// BTC Volatility desk — an equity-derivatives-style vol trading surface.
//
//   • BASIC   — the guided 4-strategy desk (straddle / strangle / butterfly /
//               iron condor): a tenor selector, payoff diagram, live Greeks and
//               a real-time delta-hedge, with an on-chain Open flow.
//   • ADVANCED — a tradfi / Bloomberg VOL DESK: an interactive three.js 3D
//               implied-vol surface, a 2D smile slice, the ATM term-structure
//               curve, a strikes/greeks readout and a trade-builder ticket.
//
// All numbers are live: the BTC mark from a Sui venue, the SVI surface from the
// backend vol engine. The structure mints on-chain on Sui; perp hedge routing
// is simulated on testnet.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { friendlyWalletError } from "../_lib/chain";
import { useWalletSigner } from "../_lib/wallet-bridge";
import { useMode, BetaTag } from "../_lib/mode";
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

// The 3D surface is WebGL — client-only, never SSR'd.
const VolSurface3D = dynamic(() => import("./_components/VolSurface3D"), {
  ssr: false,
  loading: () => <div className="vd-3d-load">initialising surface…</div>,
});

type StratMeta = { id: VolStrategy; label: string; side: "long" | "short"; blurb: string };
const STRATS: StratMeta[] = [
  { id: "straddle", label: "Straddle", side: "long", blurb: "Long gamma · ATM" },
  { id: "strangle", label: "Strangle", side: "long", blurb: "Long gamma · wide" },
  { id: "butterfly", label: "Butterfly", side: "short", blurb: "Short gamma · pinned" },
  { id: "condor", label: "Iron Condor", side: "short", blurb: "Short gamma · ranged" },
];

// Plain-English "what does this win on" for Basic users — no gamma / ATM jargon.
const PLAIN_THESIS: Record<VolStrategy, string> = {
  straddle: "Wins if BTC makes a big move — up or down — before expiry.",
  strangle: "A cheaper bet on a big move; BTC needs a wider swing to pay off.",
  butterfly: "Wins if BTC settles near today's price at expiry.",
  condor: "Wins if BTC stays inside a price range through expiry.",
};
const sideColor = (s: "long" | "short") => (s === "long" ? C.green : C.violet);

const money = (v: number, d = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;

// Signed percent that never renders a negative-zero ("-0.00%"). Values that
// round to 0 read as a clean "0.00"; positives carry an explicit "+".
const pct2 = (v: number): string => {
  const r = Number(v.toFixed(2));
  return r > 0 ? `+${r.toFixed(2)}` : r.toFixed(2);
};

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

// ---- horizon / tenor model -------------------------------------------------
// The surface ships ~12 tenor slices. We bucket them into three desk horizons
// so the Basic view stays a clean pill row; each horizon resolves to a concrete
// live oracle_id that gets passed into the quote so the structure re-prices on
// the chosen expiry.
type Horizon = "short" | "mid" | "far";
const HORIZONS: Array<{ id: Horizon; label: string; sub: string }> = [
  { id: "short", label: "Short", sub: "front" },
  { id: "mid", label: "Mid", sub: "belly" },
  { id: "far", label: "Far", sub: "back" },
];
function sliceForHorizon(surface: VolDeskSurface | null, h: Horizon): VolDeskSurface["slices"][number] | null {
  if (!surface || surface.slices.length === 0) return null;
  const s = surface.slices;
  if (h === "short") return s[0];
  if (h === "far") return s[s.length - 1];
  return s[Math.floor((s.length - 1) / 2)];
}

export default function VolatilityPage() {
  const { mode } = useMode();
  const wallet = useWalletSigner();
  const [strategy, setStrategy] = useState<VolStrategy>("straddle");
  // Institutional default: at $100 the gamma/delta-hedge numbers round to
  // 0.0000 and the desk reads as dead. A $25k ticket makes the Greeks, the
  // payoff P&L axis, and the live delta-hedge all read meaningfully.
  const [notional, setNotional] = useState("25000");
  const [horizon, setHorizon] = useState<Horizon>("short");
  const [surface, setSurface] = useState<VolDeskSurface | null>(null);
  const [surfErr, setSurfErr] = useState<string | null>(null);
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

  const horizonOracle = useMemo(
    () => sliceForHorizon(surface, horizon)?.oracle_id,
    [surface, horizon],
  );

  useEffect(() => {
    let alive = true;
    fetchVolDeskSurface()
      .then((s) => { if (alive) { setSurface(s); setSurfErr(null); } })
      .catch((e) => { if (alive) setSurfErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  // Re-price the structure (debounced) + poll every 8s so Greeks stay live.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    const run = () =>
      volQuote({ strategy, notional_usd: notionalNum, oracle_id: horizonOracle, sender: wallet.address ?? undefined })
        .then((r) => { if (alive) { setQ(r); setErr(null); } })
        .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, 200);
    const poll = window.setInterval(run, 8000);
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); window.clearInterval(poll); };
  }, [strategy, notionalNum, valid, horizonOracle, wallet.address]);

  // Fast live BTC mark — ticks the desk in real time (2s).
  useEffect(() => {
    let alive = true;
    const tick = () => fetchVolMark().then((r) => { if (alive) setLiveMark(r.mark); }).catch(() => {});
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  useEffect(() => { setHedged(null); }, [strategy, notionalNum, horizon]);

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
  const hedgeSide: "short" | "long" | "flat" = runDelta > 1e-6 ? "short" : runDelta < -1e-6 ? "long" : "flat";
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

  // Shared bits passed down to both views.
  const deskState = {
    strategy, setStrategy, notional, setNotional, horizon, setHorizon,
    surface, surfErr, q, err, accent, meta, tradeable, g,
    markPrice, movePct, runDelta, gammaPnl, hedgeSide, hedgeBtc, venue, onSui, fwd,
    liveMark, hedged, routeHedge, busy, stage, result, openErr, openPosition, wallet,
    ivPct, rvPct, vrp,
  };

  return (
    <>
      <Header />
      <PageFrame wide>
        <div className="vd">
          {/* top: title + live BTC ticker */}
          <div className="vd-top">
            <div>
              <div className="vd-eyebrow">BTC volatility</div>
              <h1>Volatility <BetaTag style={{ marginLeft: 4, transform: "translateY(-4px)" }} /></h1>
              <p>
                {mode === "advanced"
                  ? "Institutional vol desk: a live SVI implied-vol surface, smile and term-structure analytics, and a multi-leg trade builder minted on Sui."
                  : "Bet on how much BTC will move — not which way. Pick a strategy, set your size, and see the payoff before you open it on Sui."}
              </p>
            </div>
            <div className="vd-ticker">
              <span className="vd-ticker-k">BTC mark</span>
              <strong key={Math.round(markPrice)}>{dollars(markPrice)}</strong>
              <span className="vd-ticker-v">
                <i className={`vd-dot${onSui ? " on" : ""}`} />{venue} · live
              </span>
            </div>
          </div>

          {/* market stat strip — Advanced shows it standalone; Basic folds these
              into one combined "market + position" metrics block (see BasicDesk). */}
          {mode === "advanced" && (
            <div className="vd-stats">
              <Stat label="Implied vol" value={`${ivPct}%`} hint={q ? `${q.tenor_label} tenor` : "front"} color={C.tealLight} />
              <Stat label="Realized vol" value={`${rvPct}%`} hint={surface ? `${surface.rv_window_hours}h` : "trailing"} />
              <Stat label="Vol premium" value={`${pct2(vrp)}%`} hint="implied − realized" color={Math.abs(vrp) < 0.05 ? undefined : vrp > 0 ? C.green : C.red} />
              <Stat label="Forward" value={fwd ? dollars(fwd) : "—"} hint="at quote" />
              <Stat label="Spot vs fwd" value={`${pct2(movePct)}%`} hint="live drift" color={Math.abs(movePct) < 0.005 ? undefined : movePct > 0 ? C.green : C.red} />
            </div>
          )}

          {/* Only surface a quote error when we have NOTHING to show. */}
          {err && !q && <div className="vd-err">{err}</div>}

          {mode === "advanced" ? <AdvancedDesk {...deskState} /> : <BasicDesk {...deskState} />}
        </div>
      </PageFrame>
      <StripStyles />
      <style jsx global>{VD_CSS}</style>
    </>
  );
}

// Shared prop bag type for the two desk views.
type DeskProps = {
  strategy: VolStrategy; setStrategy: (s: VolStrategy) => void;
  notional: string; setNotional: (s: string) => void;
  horizon: Horizon; setHorizon: (h: Horizon) => void;
  surface: VolDeskSurface | null; surfErr: string | null;
  q: VolQuote | null; err: string | null; accent: string; meta: StratMeta;
  tradeable: number; g: VolQuote["greeks"] | null;
  markPrice: number; movePct: number; runDelta: number; gammaPnl: number;
  hedgeSide: "short" | "long" | "flat"; hedgeBtc: number; venue: string; onSui: boolean; fwd: number;
  liveMark: BtcMark | null; hedged: string | null; routeHedge: () => void;
  busy: boolean; stage: string | null; result: string | null; openErr: string | null;
  openPosition: () => void; wallet: ReturnType<typeof useWalletSigner>;
  ivPct: string; rvPct: string; vrp: number;
};

// ===========================================================================
// BASIC — the guided 4-strategy desk + horizon selector.
// ===========================================================================
function BasicDesk(p: DeskProps) {
  const { strategy, setStrategy, notional, setNotional, horizon, setHorizon, surface, q, accent, meta, tradeable, g, ivPct, rvPct, vrp, fwd } = p;
  const horizonSlice = sliceForHorizon(surface, horizon);

  return (
    <>
    {/* combined metrics — market context (top) + your position (bottom) in one block */}
    <div className="vd-metrics">
      <div className="vd-metrics-row">
        <Stat label="Implied vol" value={`${ivPct}%`} hint={q ? `${q.tenor_label} tenor` : "front month"} color={C.tealLight} />
        <Stat label="Realized vol" value={`${rvPct}%`} hint={surface ? `${surface.rv_window_hours}h trailing` : "trailing"} />
        <Stat label="Vol premium" value={`${pct2(vrp)}%`} hint={Math.abs(vrp) < 0.05 ? "fairly priced" : vrp > 0 ? "vol looks rich" : "vol looks cheap"} color={Math.abs(vrp) < 0.05 ? undefined : vrp > 0 ? C.green : C.red} />
        <Stat label="Forward" value={fwd ? dollars(fwd) : "—"} hint="BTC at quote" />
      </div>
      <div className="vd-metrics-row vd-metrics-pos">
        <Stat label="Delta" value={g ? `${g.delta_btc >= 0 ? "+" : ""}${g.delta_btc.toFixed(3)} BTC` : "—"} hint="net direction" />
        <Stat label="Gamma" value={g ? g.gamma.toFixed(4) : "—"} hint="convexity" color={g ? (g.gamma >= 0 ? C.green : C.red) : undefined} />
        <Stat label="Vega" value={g ? `${g.vega_usd >= 0 ? "+" : ""}${money(g.vega_usd)}` : "—"} hint="per vol point" color={g ? (g.vega_usd >= 0 ? C.green : C.red) : undefined} />
        <Stat label="Theta" value={g ? `${g.theta_usd_day >= 0 ? "+" : ""}${money(g.theta_usd_day)}` : "—"} hint="daily time decay" color={g ? (g.theta_usd_day >= 0 ? C.green : C.red) : undefined} />
      </div>
    </div>

    <div className="vd-grid">
      {/* LEFT — strategy, controls, payoff */}
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

        {/* controls: amount + horizon + plain-English description */}
        <div className="vd-card vd-ctrls">
          <div className="vd-amount">
            <Cap>Amount · dUSDC</Cap>
            <div className="vd-amount-in">
              <input className="vd-num" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
            </div>
          </div>
          <div className="vd-horizon">
            <Cap>Time horizon</Cap>
            <div className="vd-pills">
              {HORIZONS.map((h) => {
                const on = h.id === horizon;
                const sl = sliceForHorizon(surface, h.id);
                return (
                  <button key={h.id} className={`vd-pill${on ? " on" : ""}`} onClick={() => setHorizon(h.id)} disabled={!surface}>
                    <b>{h.label}</b>
                    <em>{sl ? sl.tenor_label : h.sub}</em>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="vd-ctrl-meta">
            <p>{PLAIN_THESIS[strategy]}</p>
            <div><Cap>Expires in</Cap><strong>{q ? q.tenor_label : horizonSlice?.tenor_label ?? "—"}</strong></div>
          </div>
        </div>

        {/* payoff diagram */}
        <div className="vd-card vd-payoff">
          <div className="vd-card-head"><Cap>Payoff at expiry · {q?.strategy_label ?? meta.label}</Cap><span className="vd-dim">P&L vs BTC settlement</span></div>
          <PayoffDiagram quote={q} markPrice={p.markPrice} accent={accent} />
        </div>

      </div>

      {/* RIGHT — hedge + ticket */}
      <div className="vd-side">
        <HedgePanel {...p} />
        <TicketPanel {...p} />
      </div>
    </div>

    {/* structure legs — full-width */}
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
    </>
  );
}

// ===========================================================================
// ADVANCED — Bloomberg-style multi-panel vol desk with the 3D surface centre.
// ===========================================================================
function AdvancedDesk(p: DeskProps) {
  const { surface, surfErr, q } = p;
  // Tenor index selected in the smile panel (drives the 3D ribbon + smile).
  const [sliceIdx, setSliceIdx] = useState(0);
  const slices = surface?.slices ?? [];
  const sel = slices[Math.min(sliceIdx, Math.max(0, slices.length - 1))] ?? null;

  // Keep slice index in range as the surface (re)loads.
  useEffect(() => {
    if (surface && sliceIdx > surface.slices.length - 1) setSliceIdx(0);
  }, [surface, sliceIdx]);

  return (
    <div className="vd-adv">
      {/* ROW 1: 3D surface (wide) + smile slice */}
      <div className="vd-adv-r1">
        <div className="vd-card vd-3d">
          <div className="vd-card-head">
            <Cap>Implied-vol surface · SVI</Cap>
            <span className="vd-dim">drag to rotate · {slices.length} tenors × {sel?.points.length ?? 0} strikes · live</span>
          </div>
          {surface ? (
            <VolSurface3D surface={surface} selectedSlice={sliceIdx} height={356} />
          ) : surfErr ? (
            <div className="vd-3d-load">surface unavailable — {surfErr}</div>
          ) : (
            <div className="vd-3d-load">loading SVI surface…</div>
          )}
          <div className="vd-3d-legend">
            <span className="vd-leg-grad" />
            <span className="vd-leg-lo">low IV</span>
            <span className="vd-leg-hi">high IV</span>
          </div>
        </div>

        <div className="vd-card vd-smile">
          <div className="vd-card-head"><Cap>Smile · {sel?.tenor_label ?? "—"}</Cap><span className="vd-dim">IV vs strike</span></div>
          <SmileChart slice={sel} />
          <div className="vd-smile-stat">
            <div><span>ATM IV</span><strong style={{ color: C.tealLight }}>{sel ? `${(sel.atm_iv * 100).toFixed(1)}%` : "—"}</strong></div>
            <div><span>Forward</span><strong>{sel ? dollars(sel.forward_usd) : "—"}</strong></div>
            <div><span>Skew</span><strong>{sel ? skewOf(sel) : "—"}</strong></div>
          </div>
        </div>
      </div>

      {/* ROW 2: term structure (also the tenor selector) + greeks */}
      <div className="vd-adv-r2">
        <div className="vd-card vd-term">
          <div className="vd-card-head">
            <Cap>ATM term structure</Cap>
            <span className="vd-dim">{slices.length} expiries · click to select tenor{sel ? ` · ${sel.tenor_label} ${(sel.atm_iv * 100).toFixed(1)}%` : ""}</span>
          </div>
          <TermChart surface={surface} selectedIdx={sliceIdx} onPick={setSliceIdx} />
        </div>

        <div className="vd-card vd-adv-greeks">
          <div className="vd-card-head"><Cap>Greeks · {p.meta.label}</Cap><span className="vd-dim">{p.q ? p.q.tenor_label : "—"}</span></div>
          <div className="vd-greeks vd-greeks-tall">
            <Greek sym="Δ" name="Delta" val={p.g ? `${p.g.delta_btc >= 0 ? "+" : ""}${p.g.delta_btc.toFixed(4)}` : "—"} unit="BTC" />
            <Greek sym="Γ" name="Gamma" val={p.g ? p.g.gamma.toFixed(5) : "—"} color={p.g ? (p.g.gamma >= 0 ? C.green : C.red) : undefined} />
            <Greek sym="ν" name="Vega" val={p.g ? `${p.g.vega_usd >= 0 ? "+" : ""}${money(p.g.vega_usd)}` : "—"} unit="/pt" color={p.g ? (p.g.vega_usd >= 0 ? C.green : C.red) : undefined} />
            <Greek sym="Θ" name="Theta" val={p.g ? `${p.g.theta_usd_day >= 0 ? "+" : ""}${money(p.g.theta_usd_day)}` : "—"} unit="/day" color={p.g ? (p.g.theta_usd_day >= 0 ? C.green : C.red) : undefined} />
          </div>
        </div>
      </div>

      {/* ROW 3: strategy + trade builder (with payoff) + ticket + hedge */}
      <div className="vd-adv-r3">
        <div className="vd-card vd-builder">
          <div className="vd-card-head"><Cap>Trade builder</Cap><span className="vd-dim">compose a vol structure</span></div>
          <div className="vd-build-strats">
            {STRATS.map((s) => {
              const on = s.id === p.strategy;
              const c = sideColor(s.side);
              return (
                <button key={s.id} className={`vd-bstrat${on ? " on" : ""}`} style={on ? { borderColor: c, background: `${c}14` } : undefined} onClick={() => p.setStrategy(s.id)}>
                  <ShapeIcon strategy={s.id} color={on ? c : C.textMuted} />
                  <b style={on ? { color: c } : undefined}>{s.label}</b>
                  <em>{s.side}</em>
                </button>
              );
            })}
          </div>
          <div className="vd-build-amt">
            <span className="vd-build-lbl">Notional</span>
            <div className="vd-amount-in">
              <input className="vd-num vd-num-sm" inputMode="decimal" value={p.notional} onChange={(e) => p.setNotional(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
              <span>dUSDC</span>
            </div>
            <div className="vd-pills vd-pills-sm">
              {HORIZONS.map((h) => (
                <button key={h.id} className={`vd-pill${h.id === p.horizon ? " on" : ""}`} onClick={() => p.setHorizon(h.id)} disabled={!surface}>
                  <b>{h.label}</b>
                </button>
              ))}
            </div>
          </div>
          <PayoffDiagram quote={q} markPrice={p.markPrice} accent={p.accent} compact />
          <div className="vd-build-legs">
            {q ? q.strip.buckets.filter((b) => b.tradeable).slice(0, 6).map((b, i) => (
              <div className="vd-bleg" key={i}>
                <span>{dollars(b.lower_usd)}–{dollars(b.higher_usd)}</span>
                <span>{usd(b.mint_cost_raw)}</span>
                <span style={{ color: p.accent }}>{usd(b.max_payout_raw)}</span>
              </div>
            )) : <div className="vd-leg-empty">pricing…</div>}
          </div>
        </div>

        <div className="vd-card vd-ticket">
          <div className="vd-card-head"><Cap>{p.meta.label} · {p.meta.side} vol</Cap><span className="vd-dim">{p.tradeable}/{q?.strip.buckets.length ?? 0}</span></div>
          <div className="vd-hedge-rows">
            <Row k="Entry cost" v={q ? usd(q.strip.total_cost_raw) : "—"} />
            <Row k="Max payout" v={q ? usd(q.strip.realized_max_payout_raw) : "—"} color={C.tealLight} />
            <Row k="Max loss" v={q ? money(q.max_loss_usd) : "—"} hint="premium" />
          </div>
          <OpenControls {...p} />
        </div>

        <HedgePanel {...p} />
      </div>
    </div>
  );
}

// ---- shared right-rail panels ---------------------------------------------
function HedgePanel(p: DeskProps) {
  const { q, accent, hedgeSide, hedgeBtc, runDelta, gammaPnl, markPrice, movePct, venue, hedged, routeHedge, liveMark } = p;
  return (
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
        <Row k="Spot drift" v={`${pct2(movePct)}%`} color={Math.abs(movePct) < 0.005 ? undefined : movePct > 0 ? C.green : C.red} />
        <Row k="Funding (8h)" v={q ? `${(q.hedge.funding_rate * 100).toFixed(3)}%` : "—"} hint={(liveMark ?? q?.mark)?.funding_source === "bluefin" ? "Bluefin" : "est."} />
      </div>
      <button className="vd-hedge-btn" disabled={!q || hedgeSide === "flat" || Boolean(hedged)} onClick={routeHedge}>
        {hedged ? "✓ Hedge routed" : hedgeSide === "flat" ? "Delta-neutral" : `Route ${hedgeSide} ${hedgeBtc.toFixed(4)} BTC`}
      </button>
      {hedged && <div className="vd-sim">✓ {hedged}</div>}
      <p className="vd-note">Structure minted on‑chain on Sui. BTC mark live from {venue}; perp routing simulated on testnet.</p>
    </div>
  );
}

function TicketPanel(p: DeskProps) {
  const { q, meta, tradeable } = p;
  return (
    <div className="vd-card vd-ticket">
      <div className="vd-card-head"><Cap>{meta.label} · {meta.side} vol</Cap><span className="vd-dim">{tradeable}/{q?.strip.buckets.length ?? 0}</span></div>
      <div className="vd-hedge-rows">
        <Row k="Entry cost" v={q ? usd(q.strip.total_cost_raw) : "—"} />
        <Row k="Max payout" v={q ? usd(q.strip.realized_max_payout_raw) : "—"} color={C.tealLight} />
        <Row k="Max loss" v={q ? money(q.max_loss_usd) : "—"} hint="premium" />
      </div>
      <OpenControls {...p} />
    </div>
  );
}

function OpenControls(p: DeskProps) {
  const { wallet, accent, busy, q, tradeable, meta, stage, result, openErr, openPosition } = p;
  return (
    <>
      {!wallet.connected ? (
        <ConnectModal trigger={<button className="vd-open-btn" style={{ background: accent }}>Connect a wallet</button>} />
      ) : (
        <button className="vd-open-btn" style={{ background: accent }} disabled={busy || !q || tradeable === 0} onClick={openPosition}>
          {busy ? (stage ?? "Submitting…") : `Open ${meta.label} · ${q ? usd(q.strip.total_cost_raw) : ""}`}
        </button>
      )}
      {result && <ResultLine digest={result} label={`${meta.label} opened`} />}
      {openErr && <div className="vd-err" style={{ marginTop: 10 }}>{openErr}</div>}
    </>
  );
}

// ---- small presentational helpers -----------------------------------------
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

/** iv@-strike − iv@+strike off the smile, in vol points (negative => put skew). */
function skewOf(slice: VolDeskSurface["slices"][number]): string {
  const pts = slice.points;
  if (pts.length < 2) return "—";
  const lo = pts[0].iv, hi = pts[pts.length - 1].iv;
  const sk = (lo - hi) * 100;
  return `${sk >= 0 ? "+" : ""}${sk.toFixed(1)}`;
}

// ---- 2D smile chart (IV vs strike for one tenor) --------------------------
function SmileChart({ slice }: { slice: VolDeskSurface["slices"][number] | null }) {
  const W = 360, H = 184, PL = 38, PR = 14, PT = 12, PB = 26;
  if (!slice || slice.points.length < 2) return <div className="vd-chart-empty">no slice</div>;
  const pts = slice.points;
  const xs = pts.map((p) => p.log_moneyness);
  const ys = pts.map((p) => p.iv);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yPad = (yMax - yMin) * 0.12 || 0.02;
  const lo = yMin - yPad, hi = yMax + yPad;
  const sx = (x: number) => PL + ((x - xMin) / (xMax - xMin || 1)) * (W - PL - PR);
  const sy = (y: number) => PT + (1 - (y - lo) / (hi - lo || 1)) * (H - PT - PB);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.log_moneyness).toFixed(1)} ${sy(p.iv).toFixed(1)}`).join(" ");
  const area = `${line} L ${sx(xMax).toFixed(1)} ${H - PB} L ${sx(xMin).toFixed(1)} ${H - PB} Z`;
  const atmX = sx(0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
      {[hi, (hi + lo) / 2, lo].map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke={C.border} strokeWidth="1" opacity={0.5} vectorEffect="non-scaling-stroke" />
          <text x={PL - 6} y={sy(v) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9">{(v * 100).toFixed(0)}%</text>
        </g>
      ))}
      <line x1={atmX} x2={atmX} y1={PT} y2={H - PB} stroke={C.textMuted} strokeDasharray="3 3" strokeWidth="1" opacity={0.55} />
      <text x={atmX} y={H - 8} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="8.5">ATM</text>
      <path d={area} fill={C.tealLight} opacity={0.1} />
      <path d={line} fill="none" stroke={C.tealLight} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {pts.map((p, i) => (
        <circle key={i} cx={sx(p.log_moneyness)} cy={sy(p.iv)} r={Math.abs(p.log_moneyness) < 1e-9 ? 3 : 1.8} fill={Math.abs(p.log_moneyness) < 1e-9 ? C.tealLight : C.teal} />
      ))}
    </svg>
  );
}

// ---- ATM term-structure curve (IV vs expiry) ------------------------------
function TermChart({ surface, selectedIdx, onPick }: { surface: VolDeskSurface | null; selectedIdx: number; onPick: (i: number) => void }) {
  const W = 360, H = 150, PL = 38, PR = 14, PT = 12, PB = 24;
  const ts = surface?.term_structure ?? [];
  if (ts.length < 2) return <div className="vd-chart-empty">{surface ? "single tenor" : "loading…"}</div>;
  const ys = ts.map((t) => t.atm_iv);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yPad = (yMax - yMin) * 0.18 || 0.02;
  const lo = yMin - yPad, hi = yMax + yPad;
  const sx = (i: number) => PL + (i / (ts.length - 1)) * (W - PL - PR);
  const sy = (y: number) => PT + (1 - (y - lo) / (hi - lo || 1)) * (H - PT - PB);
  const line = ts.map((t, i) => `${i === 0 ? "M" : "L"} ${sx(i).toFixed(1)} ${sy(t.atm_iv).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
      {[hi, lo].map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke={C.border} strokeWidth="1" opacity={0.5} vectorEffect="non-scaling-stroke" />
          <text x={PL - 6} y={sy(v) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9">{(v * 100).toFixed(0)}%</text>
        </g>
      ))}
      <path d={line} fill="none" stroke={C.violet} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {ts.map((t, i) => {
        const on = i === selectedIdx;
        return (
          <g key={i} style={{ cursor: "pointer" }} onClick={() => onPick(i)}>
            <circle cx={sx(i)} cy={sy(t.atm_iv)} r={on ? 4 : 2.4} fill={on ? C.tealLight : C.violet} stroke={on ? C.tealLight : "none"} />
            {(i === 0 || i === ts.length - 1 || on) && (
              <text x={sx(i)} y={H - 8} textAnchor="middle" fill={on ? C.tealLight : C.textMuted} fontFamily={FM} fontSize="8.5">{t.tenor_label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Classic options payoff diagram: net P&L vs BTC settlement price, with the
 *  forward and the live mark marked. Profit shaded accent, loss shaded red. */
function PayoffDiagram({ quote, markPrice, accent, compact }: { quote: VolQuote | null; markPrice: number; accent: string; compact?: boolean }) {
  const W = 760, H = compact ? 168 : 230, PL = 52, PR = 16, PT = 14, PB = 26;
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

  if (!model) return <div className="vd-payoff-empty" style={{ height: H }}>pricing…</div>;
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
        <clipPath id="vd-pos"><rect x={PL} y={PT} width={W - PL - PR} height={Math.max(0, zeroY - PT)} /></clipPath>
        <clipPath id="vd-neg"><rect x={PL} y={zeroY} width={W - PL - PR} height={Math.max(0, H - PB - zeroY)} /></clipPath>
      </defs>
      {[yMax, 0, yMin].map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke={C.border} strokeWidth="1" opacity={v === 0 ? 0.9 : 0.4} vectorEffect="non-scaling-stroke" />
          <text x={PL - 8} y={sy(v) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9.5">{v >= 0 ? "+$" : "-$"}{Math.abs(Math.round(v)).toLocaleString()}</text>
        </g>
      ))}
      <g clipPath="url(#vd-pos)"><path d={areaPos} fill={accent} opacity={0.16} /></g>
      <g clipPath="url(#vd-neg)"><path d={areaPos} fill={C.red} opacity={0.12} /></g>
      <line x1={sx(fwd)} x2={sx(fwd)} y1={PT} y2={H - PB} stroke={C.textMuted} strokeWidth="1" strokeDasharray="3 3" opacity={0.6} />
      <text x={sx(fwd)} y={H - 8} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9">fwd {dollars(fwd)}</text>
      <line x1={sx(markX)} x2={sx(markX)} y1={PT} y2={H - PB} stroke={C.tealLight} strokeWidth="1.2" opacity={0.85} />
      <circle cx={sx(markX)} cy={PT + 4} r={3} fill={C.tealLight} />
      <path d={line} fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const VD_CSS = `
  .vd { max-width: 1720px; margin: 0 auto; display: grid; gap: 14px; min-width: 0; }
  .vd-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .vd-eyebrow { font-family: ${FM}; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: ${C.teal}; }
  .vd-top h1 { margin: 6px 0 0; font-family: ${FD}; font-size: 30px; font-weight: 600; letter-spacing: -0.03em; color: ${C.textPrimary}; display: flex; align-items: baseline; }
  .vd-top p { margin: 8px 0 0; max-width: 620px; font-family: ${FS}; font-size: 13px; line-height: 1.55; color: ${C.textSecondary}; }
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

  /* Combined metrics — market context (top row) + your position (bottom row). */
  .vd-metrics { display: grid; gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 12px; overflow: hidden; }
  .vd-metrics-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: ${C.border}; }
  .vd-metrics-row .vd-stat { background: ${C.card}; }
  .vd-metrics-pos .vd-stat { background: ${C.surface}; }
  @media (max-width: 1080px) { .vd-metrics-row { grid-template-columns: repeat(2, 1fr); } }

  .vd-err { border: 0.5px solid ${C.red}55; background: ${C.redBg}; border-radius: 10px; padding: 11px 14px; font-family: ${FM}; font-size: 12px; color: ${C.red}; }

  .vd-grid { display: grid; grid-template-columns: minmax(0, 1.62fr) minmax(330px, 0.92fr); gap: 14px; align-items: start; }
  @media (max-width: 1080px) { .vd-grid { grid-template-columns: 1fr; } .vd-stats { grid-template-columns: repeat(2, 1fr); } .vd-top { flex-direction: column; } .vd-ticker { text-align: left; } }
  .vd-main, .vd-side { display: grid; gap: 14px; min-width: 0; align-content: start; }
  .vd-card { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 15px 16px; min-width: 0; }
  .vd-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .vd-dim, .vd-live { font-family: ${FM}; font-size: 10px; color: ${C.textMuted}; }
  .vd-live { display: inline-flex; align-items: center; gap: 5px; color: ${C.green}; white-space: nowrap; }

  .vd-strats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; padding: 12px; }
  .vd-strat { display: grid; gap: 5px; justify-items: start; padding: 12px; border-radius: 11px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: pointer; transition: all 0.15s ${EASE}; }
  .vd-strat:hover { border-color: ${C.borderHover}; transform: translateY(-1px); }
  .vd-strat b { font-family: ${FD}; font-size: 13.5px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-strat em { font-family: ${FM}; font-size: 9.5px; font-style: normal; color: ${C.textMuted}; }

  .vd-ctrls { display: grid; grid-template-columns: 200px 290px 1fr; gap: 16px; align-items: center; }
  @media (max-width: 1280px) { .vd-ctrls { grid-template-columns: 1fr 1fr; } .vd-ctrls .vd-ctrl-meta { grid-column: 1 / -1; } }
  .vd-amount { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 11px; padding: 10px 13px; display: grid; gap: 6px; }
  .vd-amount-in { display: flex; align-items: baseline; gap: 8px; }
  .vd-num { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: ${C.textPrimary}; font-family: ${FD}; font-size: 22px; font-weight: 600; padding: 0; }
  .vd-num-sm { font-size: 18px; }
  .vd-amount-in span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }
  .vd-horizon { display: grid; gap: 6px; }
  .vd-pills { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .vd-pills-sm { grid-template-columns: repeat(3, 1fr); }
  .vd-pill { display: grid; gap: 2px; justify-items: center; padding: 8px 6px; border-radius: 9px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: pointer; transition: all 0.15s ${EASE}; }
  .vd-pill:hover:not(:disabled) { border-color: ${C.borderHover}; }
  .vd-pill:disabled { opacity: 0.5; cursor: default; }
  .vd-pill.on { border-color: ${C.tealLight}; background: ${C.tealLight}14; }
  .vd-pill b { font-family: ${FD}; font-size: 12px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-pill.on b { color: ${C.tealLight}; }
  .vd-pill em { font-family: ${FM}; font-size: 9px; font-style: normal; color: ${C.textMuted}; }
  .vd-ctrl-meta { display: grid; gap: 9px; align-content: center; }
  .vd-ctrl-meta div { display: flex; align-items: baseline; gap: 8px; }
  .vd-ctrl-meta strong { font-family: ${FD}; font-size: 14px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-ctrl-meta p { margin: 0; font-family: ${FS}; font-size: 13px; line-height: 1.5; color: ${C.textPrimary}; }

  .vd-payoff-empty { display: grid; place-items: center; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }

  .vd-greeks { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .vd-greeks-tall { grid-template-columns: 1fr 1fr; }
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

  /* ---- ADVANCED desk ---- */
  .vd-adv { display: grid; gap: 14px; min-width: 0; }
  .vd-adv-r1 { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(320px, 1fr); gap: 14px; align-items: stretch; }
  .vd-adv-r2 { display: grid; grid-template-columns: minmax(0, 1.62fr) minmax(280px, 1fr); gap: 14px; align-items: stretch; }
  .vd-adv-r3 { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(280px, 0.85fr) minmax(300px, 0.85fr); gap: 14px; align-items: start; }
  @media (max-width: 1280px) {
    .vd-adv-r1, .vd-adv-r2, .vd-adv-r3 { grid-template-columns: 1fr; }
  }
  .vd-3d { display: flex; flex-direction: column; }
  .vd-3d-load { height: 356px; display: grid; place-items: center; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; background: ${C.bg}; border-radius: 12px; }
  .vd-3d-legend { display: flex; align-items: center; gap: 10px; margin-top: 11px; }
  .vd-leg-grad { flex: 1; height: 7px; border-radius: 4px; background: linear-gradient(90deg, ${C.tealBg}, ${C.teal}, ${C.tealLight}, ${C.amber}, ${C.coral}); }
  .vd-leg-lo, .vd-leg-hi { font-family: ${FM}; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; white-space: nowrap; }
  .vd-smile { display: flex; flex-direction: column; }
  .vd-chart-empty { height: 150px; display: grid; place-items: center; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }
  .vd-smile-stat { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-top: 12px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; }
  .vd-smile-stat > div { background: ${C.card}; padding: 9px 11px; display: grid; gap: 3px; }
  .vd-smile-stat span { font-family: ${FM}; font-size: 9px; letter-spacing: 0.07em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-smile-stat strong { font-family: ${FD}; font-size: 15px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }

  .vd-tenor-list { display: grid; gap: 6px; max-height: 168px; overflow-y: auto; padding-right: 2px; }
  .vd-tenor { display: flex; justify-content: space-between; align-items: center; padding: 8px 11px; border-radius: 9px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: pointer; transition: all 0.12s ${EASE}; }
  .vd-tenor:hover { border-color: ${C.borderHover}; }
  .vd-tenor.on { border-color: ${C.tealLight}; background: ${C.tealLight}14; }
  .vd-tenor b { font-family: ${FM}; font-size: 11.5px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-tenor span { font-family: ${FM}; font-size: 11.5px; color: ${C.textSecondary}; font-variant-numeric: tabular-nums; }
  .vd-tenor.on b, .vd-tenor.on span { color: ${C.tealLight}; }

  .vd-builder { display: grid; gap: 12px; align-content: start; }
  .vd-build-strats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .vd-bstrat { display: grid; gap: 4px; justify-items: start; padding: 9px 10px; border-radius: 9px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: pointer; transition: all 0.15s ${EASE}; }
  .vd-bstrat:hover { border-color: ${C.borderHover}; }
  .vd-bstrat b { font-family: ${FD}; font-size: 12px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-bstrat em { font-family: ${FM}; font-size: 8.5px; font-style: normal; text-transform: uppercase; letter-spacing: 0.05em; color: ${C.textMuted}; }
  .vd-build-amt { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 9px 13px; border-radius: 10px; border: 0.5px solid ${C.border}; background: ${C.surface}; }
  .vd-build-lbl { font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.07em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-build-amt .vd-pills-sm { width: 180px; }
  .vd-build-amt .vd-pill { padding: 6px 4px; }
  .vd-build-legs { display: grid; gap: 5px; }
  .vd-bleg { display: grid; grid-template-columns: minmax(0, 1.6fr) 1fr 1fr; gap: 10px; padding: 7px 11px; border-radius: 8px; background: ${C.surface}; border: 0.5px solid ${C.border}; font-family: ${FM}; font-size: 10.5px; color: ${C.textSecondary}; font-variant-numeric: tabular-nums; }
  .vd-bleg span:not(:first-child) { text-align: right; }
`;
