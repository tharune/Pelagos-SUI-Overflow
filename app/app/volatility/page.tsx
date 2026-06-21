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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { friendlyWalletError } from "../_lib/chain";
import { useWalletSigner, useDusdcBalance, useUsdcBalance } from "../_lib/wallet-bridge";
import { CurrencySelect, type Currency } from "../_components/CurrencySelect";
import { simOpen, simConfirm } from "../_lib/sim-client";
import { useMode } from "../_lib/mode";
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

// ---- Advanced bespoke builder: templates ("tiers") + weight helpers --------
// Each template seeds the sculptor with a per-band weight profile + strip width;
// the user then drags the profile into any bespoke shape. The weights ARE the
// payout across strike bands, priced through the same on-chain MM path.
type BuilderTemplate = { id: string; label: string; blurb: string; span: number; side: "long" | "short" };
const TEMPLATES: BuilderTemplate[] = [
  { id: "straddle", label: "Straddle", blurb: "Long gamma · ATM", span: 2.2, side: "long" },
  { id: "strangle", label: "Strangle", blurb: "Long gamma · wide", span: 3.0, side: "long" },
  { id: "butterfly", label: "Butterfly", blurb: "Short gamma · pin", span: 1.7, side: "short" },
  { id: "condor", label: "Condor", blurb: "Short gamma · range", span: 2.6, side: "short" },
  { id: "putskew", label: "Put skew", blurb: "Long · downside-heavy", span: 2.6, side: "long" },
  { id: "flat", label: "Flat", blurb: "Uniform · sculpt from here", span: 2.4, side: "short" },
];

/** Per-band weight profile for a template, length n. */
function tplWeights(id: string, n: number): number[] {
  const c = (n - 1) / 2, maxd = Math.max(c, 1);
  const dist = (i: number) => Math.abs(i - c) / maxd;     // 0 center … 1 wings
  const sgn = (i: number) => (i - c) / maxd;               // −1 puts … +1 calls
  const fns: Record<string, (i: number) => number> = {
    straddle: (i) => 0.15 + dist(i) * 1.05,
    strangle: (i) => (dist(i) < 0.34 ? 0.05 : 0.12 + dist(i) * 1.25),
    butterfly: (i) => 0.12 + (1 - dist(i)) * 1.4,
    condor: (i) => (dist(i) < 0.55 ? 0.95 : 0.08),
    putskew: (i) => 0.22 + Math.max(0, -sgn(i)) * 0.7 + dist(i) * 0.12,
    flat: () => 0.6,
  };
  const f = fns[id] ?? fns.straddle;
  return Array.from({ length: n }, (_, i) => Math.max(0.04, Number(f(i).toFixed(3))));
}

/** Linearly resample a sculpted profile to a new bucket count (keeps the shape). */
function resampleWeights(w: number[], n: number): number[] {
  if (w.length === n || w.length < 2) return tplWeights("straddle", n);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / Math.max(1, n - 1)) * (w.length - 1);
    const a = Math.floor(t), b = Math.min(w.length - 1, a + 1), f = t - a;
    return Math.max(0.04, Number((w[a] + (w[b] - w[a]) * f).toFixed(3)));
  });
}

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
  const [currency, setCurrency] = useState<Currency>("mUSDC");
  const [horizon, setHorizon] = useState<Horizon>("short");
  // Advanced bespoke-builder state: a sculpted per-band weight profile + strip
  // width + bucket count. Drives the Advanced quote (custom path); Basic keeps
  // its named-strategy path untouched.
  const [bucketN, setBucketN] = useState(8);
  const [spanSigma, setSpanSigma] = useState(2.2);
  const [weights, setWeights] = useState<number[]>(() => tplWeights("straddle", 8));
  const [activeTemplate, setActiveTemplate] = useState<string>("straddle");
  // Advanced: the selected tenor index — drives BOTH the analytics charts and the
  // quote oracle, so picking a tenor re-prices the structure at that expiry.
  const [sliceIdx, setSliceIdx] = useState(0);
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
  // Advanced labels by the active template until the user actually sculpts (then
  // it's "Custom structure"); side is the template's, or the backend-inferred
  // side once custom. Basic colours by the chosen preset.
  const advTpl = TEMPLATES.find((t) => t.id === activeTemplate);
  const advStructLabel = advTpl ? advTpl.label : (q?.strategy_label ?? "Custom structure");
  const advStructSide: "long" | "short" = advTpl ? advTpl.side : (q?.side ?? "long");
  const accent = mode === "advanced" ? sideColor(advStructSide) : sideColor(meta.side);

  const horizonOracle = useMemo(
    () => sliceForHorizon(surface, horizon)?.oracle_id,
    [surface, horizon],
  );

  // Advanced tenor model. Drop seconds-to-expiry slices (as T→0 the SVI wings
  // blow up) and winsorize each slice's DISPLAY wing IV (cap at max(100%, 2×ATM))
  // so the smile / skew / 3D stay sane. The SELECTED slice drives the analytics
  // AND the quote oracle, so choosing a tenor re-prices the structure there.
  const advSlices = useMemo(
    () =>
      (surface?.slices ?? [])
        .filter((s) => s.points.length >= 3 && s.t_years > 300 / 31_557_600)
        .map((s) => {
          const ivCap = Math.max(1.0, s.atm_iv * 2);
          return { ...s, points: s.points.map((pt) => (pt.iv > ivCap ? { ...pt, iv: ivCap } : pt)) };
        }),
    [surface],
  );
  const advSel = advSlices[Math.min(sliceIdx, Math.max(0, advSlices.length - 1))] ?? null;
  const advFilteredSurface = useMemo(() => {
    if (!surface) return null;
    const keep = new Set(advSlices.map((s) => s.expiry));
    return { ...surface, slices: advSlices, term_structure: surface.term_structure.filter((t) => keep.has(t.expiry)) } as VolDeskSurface;
  }, [surface, advSlices]);
  // Advanced prices at the selected tenor's oracle; Basic at the horizon oracle.
  const quoteOracle = mode === "advanced" ? (advSel?.oracle_id ?? horizonOracle) : horizonOracle;

  useEffect(() => {
    let alive = true;
    fetchVolDeskSurface()
      .then((s) => { if (alive) { setSurface(s); setSurfErr(null); } })
      .catch((e) => { if (alive) setSurfErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  // Re-price the structure (throttled) + poll every 8s so Greeks stay live.
  const timer = useRef<number | null>(null);
  const lastQuoteAt = useRef(0);
  useEffect(() => {
    // In Advanced, wait for the selected tenor's oracle so the first quote prices
    // the SHOWN tenor (not the backend's default) — otherwise the ticket greeks
    // briefly disagree with every "tenor" label on first paint.
    if (!valid || (mode === "advanced" && !quoteOracle)) return;
    let alive = true;
    // Advanced prices the SCULPTED structure (custom weights); Basic prices the
    // named preset. Same endpoint, same on-chain MM path.
    const run = () => {
      lastQuoteAt.current = performance.now();
      volQuote(mode === "advanced"
        ? { notional_usd: notionalNum, oracle_id: quoteOracle, weights, span_sigma: spanSigma, sender: wallet.address ?? undefined }
        : { strategy, notional_usd: notionalNum, oracle_id: quoteOracle, sender: wallet.address ?? undefined })
        .then((r) => { if (alive) { setQ(r); setErr(null); } })
        .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    };
    // THROTTLE (not debounce): fire at most ~every 130ms so the ticket + Greeks
    // keep updating WHILE the user sculpts/drags, not only after they stop.
    const wait = Math.max(0, 130 - (performance.now() - lastQuoteAt.current));
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, wait);
    const poll = window.setInterval(run, 8000);
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); window.clearInterval(poll); };
  }, [strategy, notionalNum, valid, quoteOracle, wallet.address, mode, weights, spanSigma]);

  // Keep the selected tenor in range as the surface (re)loads / filters shift.
  useEffect(() => {
    if (sliceIdx > advSlices.length - 1) setSliceIdx(0);
  }, [advSlices.length, sliceIdx]);

  // Default the Advanced tenor to a MEANINGFUL vol horizon (~7 days) once the
  // surface loads. The front tenor makes the per-move greeks degenerate (delta
  // ∝ 1/√T blows up — a tiny structure "needs" a 100+ BTC hedge), so never open
  // there by default. The user can still pick any tenor from the dropdown.
  const didInitTenor = useRef(false);
  useEffect(() => {
    if (didInitTenor.current || advSlices.length === 0) return;
    didInitTenor.current = true;
    const targetYears = 7 / 365;
    let best = 0, bestD = Infinity;
    advSlices.forEach((s, i) => { const d = Math.abs(s.t_years - targetYears); if (d < bestD) { bestD = d; best = i; } });
    setSliceIdx(best);
  }, [advSlices]);

  // Fast live BTC mark — ticks the desk in real time (2s).
  useEffect(() => {
    let alive = true;
    const tick = () => fetchVolMark().then((r) => { if (alive) setLiveMark(r.mark); }).catch(() => {});
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // Reset the routed-hedge banner whenever the position the hedge was sized for
  // changes — Basic (strategy/horizon) AND Advanced (tenor/sculpt/width) drivers.
  useEffect(() => { setHedged(null); }, [strategy, notionalNum, horizon, sliceIdx, weights, spanSigma]);

  const g = q?.greeks ?? null;
  const tradeable = q ? q.strip.buckets.filter((b) => b.tradeable).length : 0;

  // Live mark drives the real-time hedge: the position is delta-neutral at the
  // quote forward; as BTC ticks away from it, gamma generates delta to re-hedge,
  // and (for long gamma) a convexity P&L accrues.
  const fwd = q?.forward_usd ?? 0;
  // Re-hedge drift is measured from the SPOT AT QUOTE TIME (the quote's BTC mark),
  // not the forward: the Greeks delta is struck at the quote, so baselining here
  // makes the hedge's net delta reconcile with the Greeks the instant you quote
  // (delta-neutral structure → ~0 hedge), and only a genuine post-quote tick of
  // the live mark generates gamma delta to re-hedge. The small forward−mark basis
  // (carry) is a pricing artifact and must not masquerade as a standing hedge.
  const quoteSpot = q?.mark.mark ?? fwd;
  const markPrice = liveMark?.mark ?? quoteSpot;
  const moveUsd = quoteSpot ? markPrice - quoteSpot : 0;
  const movePct = quoteSpot ? (moveUsd / quoteSpot) * 100 : 0;
  const runDelta = g ? g.delta_btc + g.gamma * moveUsd : 0;
  const gammaPnl = g ? 0.5 * g.gamma * moveUsd * moveUsd : 0;
  // Delta-neutral cutoff scales with position size: below max($25, 0.1% of
  // notional) the hedge is grid-discretisation dust — a symmetric strip never
  // lands perfectly on the discrete band grid, so it carries a few-dollar
  // residual delta that isn't a directional view worth routing a perp for.
  const hedgeUsd = Math.abs(runDelta) * markPrice;
  const hedgeFloorUsd = Math.max(25, 0.001 * (notionalNum || 0));
  const hedgeSide: "short" | "long" | "flat" =
    hedgeUsd < hedgeFloorUsd ? "flat" : runDelta > 0 ? "short" : "long";
  const hedgeBtc = Math.abs(runDelta);
  const venue = shortVenue(liveMark ?? q?.mark);
  const onSui = (liveMark ?? q?.mark)?.chain === "sui";

  async function openPosition() {
    if (!q || busy) return;
    setBusy(true); setOpenErr(null); setResult(null);
    try {
      // mUSDC = Pelagos USDC settlement (our Vault<MOCK_USDC>, same DeepBook pricing).
      if (currency === "mUSDC") {
        setStage("Opening position…");
        const r = (x: string) => Number(x) / 1e6;
        const bands = q.strip.buckets.filter((b) => b.tradeable).map((b) => ({ lower_usd: b.lower_usd, higher_usd: b.higher_usd, payout_usd: r(b.max_payout_raw) }));
        if (bands.length === 0) throw new Error("No tradeable legs in this structure right now.");
        const prep = await simOpen({
          owner: wallet.address as string, product: "vol", name: q.strategy_label,
          premium_usd: r(q.strip.total_cost_raw), max_payout_usd: r(q.strip.realized_max_payout_raw),
          oracle_id: q.oracle_id, forward_usd: q.forward_usd, expiry_ms: Number(q.expiry), bands,
        });
        setStage("Sign in wallet…");
        const digest = await wallet.signAndExecute(prep.tx_bytes);
        setStage("Confirming…");
        await simConfirm(prep.sim_id, digest);
        setResult(digest);
        return;
      }
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
    setHedged(`${hedgeSide.toUpperCase()} ${hedgeBtc.toFixed(4)} BTC-PERP @ ${dollars(markPrice)} · sized at live mark`);
  }

  const ivPct = q ? (q.atm_iv * 100).toFixed(1) : surface ? ((surface.term_structure[0]?.atm_iv ?? 0) * 100).toFixed(1) : "—";
  const rvPct = surface ? (surface.realized_vol * 100).toFixed(1) : "—";
  const vrp = surface ? surface.vol_risk_premium * 100 : 0;

  // Shared bits passed down to both views.
  const deskState = {
    strategy, setStrategy, notional, setNotional, currency, setCurrency, horizon, setHorizon,
    surface, surfErr, q, err, accent, meta, tradeable, g,
    markPrice, movePct, runDelta, gammaPnl, hedgeSide, hedgeBtc, venue, onSui, fwd,
    liveMark, hedged, routeHedge, busy, stage, result, openErr, openPosition, wallet,
    ivPct, rvPct, vrp,
    bucketN, setBucketN, spanSigma, setSpanSigma, weights, setWeights,
    activeTemplate, setActiveTemplate, advStructLabel, advStructSide,
    sliceIdx, setSliceIdx, advSlices, advSel, advFilteredSurface,
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
              <h1>Volatility</h1>
              <p>
                {mode === "advanced"
                  ? "Institutional vol desk: a live SVI implied-vol surface, smile and term-structure analytics, and a multi-leg trade builder minted on Sui."
                  : "Bet on how much BTC will move — not which way. Pick a strategy, set your size, and see the payoff before you open it on Sui."}
              </p>
            </div>
            {mode === "advanced" && (
              <div className="vd-ticker">
                <span className="vd-ticker-k">BTC mark</span>
                <strong key={Math.round(markPrice)}>{dollars(markPrice)}</strong>
                <span className="vd-ticker-v">
                  <i className={`vd-dot${onSui ? " on" : ""}`} />{venue} · live
                </span>
              </div>
            )}
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
  currency: Currency; setCurrency: (c: Currency) => void;
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
  // Advanced bespoke builder
  bucketN: number; setBucketN: (n: number) => void;
  spanSigma: number; setSpanSigma: (s: number) => void;
  weights: number[]; setWeights: React.Dispatch<React.SetStateAction<number[]>>;
  activeTemplate: string; setActiveTemplate: (s: string) => void;
  advStructLabel: string; advStructSide: "long" | "short";
  // Advanced tenor (lifted): selected index drives charts + quote oracle.
  sliceIdx: number; setSliceIdx: (i: number) => void;
  advSlices: VolDeskSurface["slices"]; advSel: VolDeskSurface["slices"][number] | null;
  advFilteredSurface: VolDeskSurface | null;
};

// ===========================================================================
// BASIC — the guided 4-strategy desk + horizon selector.
// ===========================================================================
function BasicDesk(p: DeskProps) {
  const { strategy, setStrategy, notional, setNotional, currency, setCurrency, horizon, setHorizon, surface, q, accent, meta, tradeable, ivPct, rvPct, vrp, fwd, wallet, busy, markPrice, venue, onSui } = p;
  const horizonSlice = sliceForHorizon(surface, horizon);
  // The delta-neutral hedge is now an OPTIONAL step inside the execute modal,
  // surfaced when you click Open — not a permanent panel cluttering the desk.
  const [showExecute, setShowExecute] = useState(false);
  const [hedgeOn, setHedgeOn] = useState(false);

  // Max return multiple — varies clearly by strategy AND tenor.
  const maxReturn = q && Number(q.strip.total_cost_raw) > 0
    ? Number(q.strip.realized_max_payout_raw) / Number(q.strip.total_cost_raw)
    : 0;
  // Breakeven "profit zone" — where the payoff crosses the premium paid. This is
  // the quantity that moves most across time horizons (it widens with √T), so it
  // makes the timeframe genuinely visible (cost is fixed = your amount).
  const profitZone = useMemo(() => {
    if (!q) return null;
    const bands = q.strip.buckets;
    const cost = Number(q.strip.total_cost_raw) / 1e6;
    if (!(cost > 0)) return null;
    const fwd = q.forward_usd;
    const sig = q.sigma_usd || fwd * 0.04;
    const lo = Math.max(0, fwd - 3.6 * sig), hi = fwd + 3.6 * sig;
    const payoff = (x: number) => { for (const b of bands) if (b.tradeable && x > b.lower_usd && x <= b.higher_usd) return Number(b.quantity) / 1e6; return 0; };
    const N = 280; const xs: number[] = [], vs: number[] = [];
    for (let i = 0; i < N; i++) { const x = lo + (i / (N - 1)) * (hi - lo); xs.push(x); vs.push(payoff(x) - cost); }
    const cross: number[] = [];
    for (let i = 1; i < N; i++) if ((vs[i - 1] < 0) !== (vs[i] < 0)) { const t = vs[i - 1] / (vs[i - 1] - vs[i]); cross.push(xs[i - 1] + t * (xs[i] - xs[i - 1])); }
    return cross.length >= 2 ? { lo: cross[0], hi: cross[cross.length - 1] } : null;
  }, [q]);

  return (
    <>
    {/* metrics — 4 market stats in one box + a separate live BTC price box */}
    <div className="vd-metrics2">
      <div className="vd-stat4">
        <Stat label="Implied vol" value={`${ivPct}%`} hint={q ? `${q.tenor_label} tenor` : "front month"} color={C.tealLight} />
        <Stat label="Realized vol" value={`${rvPct}%`} hint={surface ? `${surface.rv_window_hours}h trailing` : "trailing"} />
        <Stat label="Vol premium" value={`${pct2(vrp)}%`} hint={Math.abs(vrp) < 0.05 ? "fairly priced" : vrp > 0 ? "vol looks rich" : "vol looks cheap"} color={Math.abs(vrp) < 0.05 ? undefined : vrp > 0 ? C.green : C.red} />
        <Stat label="Forward" value={fwd ? dollars(fwd) : "—"} hint="BTC at quote" />
      </div>
      <div className="vd-pricebox">
        <span className="vd-mark-k">BTC mark</span>
        <strong key={Math.round(markPrice)}>{dollars(markPrice)}</strong>
        <span className="vd-mark-v"><i className={`vd-dot${onSui ? " on" : ""}`} />{venue} · live</span>
      </div>
    </div>

    {/* strategy selector — full width */}
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

    {/* payoff (left, the visual) + order entry (right: amount/horizon + ticket) */}
    <div className="vd-grid">
      <div className="vd-main">
        <div className="vd-card vd-payoff">
          <div className="vd-card-head"><Cap>Payoff at expiry · {q?.strategy_label ?? meta.label}</Cap><span className="vd-dim">P&L vs BTC settlement</span></div>
          <PayoffDiagram quote={q} markPrice={p.markPrice} accent={accent} h={404} />
        </div>
      </div>

      <div className="vd-side">
        {/* controls — amount + horizon + plain description (stacked) */}
        <div className="vd-card vd-ctrls vd-ctrls-v">
          <div className="vd-amount">
            <Cap>Amount</Cap>
            <div className="vd-amount-in">
              <span className="vd-amount-cur">$</span>
              <input className="vd-num" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
              <CurrencySelect value={currency} onChange={setCurrency} />
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
          <p className="vd-ctrls-desc">{PLAIN_THESIS[strategy]} <span>Expires in {q ? q.tenor_label : horizonSlice?.tenor_label ?? "—"}.</span></p>
        </div>

        {/* ticket — Open launches the review modal (optional delta hedge → sign) */}
        <div className="vd-card vd-ticket">
          <div className="vd-card-head"><Cap>{meta.label} · {meta.side} vol</Cap><span className="vd-dim">{tradeable}/{q?.strip.buckets.length ?? 0} legs · {q?.tenor_label ?? "—"}</span></div>
          <div className="vd-hedge-rows">
            <Row k="Entry cost" v={q ? usd(q.strip.total_cost_raw) : "—"} hint="your amount" />
            <Row k="Max payout" v={q ? usd(q.strip.realized_max_payout_raw) : "—"} color={C.tealLight} />
            <Row k="Max return" v={maxReturn > 0 ? `${maxReturn.toFixed(2)}×` : "—"} color={accent} />
            <Row k="Max loss" v={q ? money(q.max_loss_usd) : "—"} hint="premium" />
          </div>
          {profitZone && (
            <p className="vd-ticket-be">
              {meta.side === "long"
                ? <>Profits if BTC settles <b>below {dollars(profitZone.lo)}</b> or <b>above {dollars(profitZone.hi)}</b> by {q?.tenor_label}.</>
                : <>Profits if BTC settles <b>between {dollars(profitZone.lo)} and {dollars(profitZone.hi)}</b> by {q?.tenor_label}.</>}
            </p>
          )}
          {!wallet.connected ? (
            <ConnectModal trigger={<button className="vd-open-btn" style={{ background: accent }}>Connect a wallet</button>} />
          ) : (
            <button className="vd-open-btn" style={{ background: accent }} disabled={busy || !q || tradeable === 0} onClick={() => setShowExecute(true)}>
              {`Open ${meta.label} · ${q ? usd(q.strip.total_cost_raw) : ""}`}
            </button>
          )}
        </div>
      </div>
    </div>

    {/* structure legs — full-width; clearly labelled with the chosen strategy + the
        profit-zone bands highlighted (where a leg pays more than the premium). */}
    <div className="vd-card vd-legs">
      <div className="vd-card-head">
        <div className="vd-legs-title"><ShapeIcon strategy={strategy} color={accent} /><Cap>Structure · {meta.label}</Cap></div>
        <span className="vd-dim">{tradeable} range legs · {q?.tenor_label ?? "—"} · settled on Sui</span>
      </div>
      <p className="vd-legs-desc">{PLAIN_THESIS[strategy]} <span>Highlighted bands are where you net a profit.</span></p>
      <div className="vd-legs-table">
        <div className="vd-leg vd-leg-h"><span>Strike band</span><span>Contracts</span><span>Cost</span><span>Pays</span></div>
        {q ? q.strip.buckets.filter((b) => b.tradeable).map((b, i) => {
          const profit = Number(b.max_payout_raw) > Number(q.strip.total_cost_raw);
          return (
            <div className={`vd-leg${profit ? " profit" : ""}`} key={i}>
              <span className="vd-leg-band">{dollars(b.lower_usd)}–{dollars(b.higher_usd)}{profit && <i className="vd-leg-tag">in profit</i>}</span>
              <span>{(Number(b.quantity) / 1e6).toFixed(0)}</span>
              <span>{usd(b.mint_cost_raw)}</span>
              <span style={{ color: profit ? C.green : accent }}>{usd(b.max_payout_raw)}</span>
            </div>
          );
        }) : <div className="vd-leg-empty">pricing…</div>}
      </div>
    </div>

    {showExecute && (
      <ExecuteModal p={p} hedgeOn={hedgeOn} setHedgeOn={setHedgeOn} onClose={() => setShowExecute(false)} />
    )}
    </>
  );
}

// Review-and-sign modal for Basic. Surfaces the trade summary + an OPTIONAL
// delta-neutral perp hedge before the on-chain mint is signed.
function ExecuteModal({ p, hedgeOn, setHedgeOn, onClose }: { p: DeskProps; hedgeOn: boolean; setHedgeOn: (v: boolean) => void; onClose: () => void }) {
  const { q, meta, accent, busy, stage, result, openErr, openPosition, runDelta, hedgeSide, hedgeBtc, markPrice, gammaPnl, routeHedge, hedged, wallet } = p;
  const hasDelta = hedgeSide !== "flat" && Math.abs(runDelta) > 1e-3;
  // Both rails are first-class — read whichever the trade settles in.
  const dusdc = useDusdcBalance();
  const musdc = useUsdcBalance();
  const ccy = p.currency;
  const bal = ccy === "mUSDC" ? musdc : dusdc;
  const costUsd = q ? Number(q.strip.total_cost_raw) / 1e6 : 0;
  const shortBal = wallet.connected && !result && bal.uiAmount + 1e-9 < costUsd;
  const confirm = () => {
    if (hedgeOn && hasDelta && !hedged) routeHedge();
    openPosition();
  };
  return (
    <div className="vd-modal-bg" onClick={onClose}>
      <div className="vd-modal" onClick={(e) => e.stopPropagation()}>
        <div className="vd-modal-head">
          <Cap>Review order</Cap>
          <button className="vd-modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="vd-modal-title">
          <span className="vd-modal-badge" style={{ color: accent, background: `${accent}1c` }}>{meta.label}</span>
          {meta.side} vol · {q?.tenor_label ?? "—"}
        </div>
        <div className="vd-hedge-rows">
          <Row k="Entry cost" v={q ? usd(q.strip.total_cost_raw) : "—"} />
          <Row k="Max payout" v={q ? usd(q.strip.realized_max_payout_raw) : "—"} color={C.tealLight} />
          <Row k="Max loss" v={q ? money(q.max_loss_usd) : "—"} hint="premium" />
        </div>

        {hasDelta && (
          <div className={`vd-modal-hedge${hedgeOn ? " on" : ""}`}>
            <label className="vd-modal-toggle">
              <input type="checkbox" checked={hedgeOn} onChange={(e) => setHedgeOn(e.target.checked)} />
              <span>Add a delta-neutral hedge</span>
              <i>optional</i>
            </label>
            <p>
              This {meta.label.toLowerCase()} carries {runDelta >= 0 ? "+" : ""}{runDelta.toFixed(3)} BTC of delta.
              Hedging {hedgeBtc.toFixed(3)} BTC on a perp keeps you direction-neutral — pure volatility exposure.
              <i> Hedge is sized against live BTC‑PERP marks (analytics, not a live perp order).</i>
            </p>
            {hedgeOn && (
              <div className="vd-hedge-rows">
                <Row k="Hedge order" v={`${hedgeSide === "short" ? "Short" : "Long"} ${hedgeBtc.toFixed(4)} BTC`} color={accent} />
                <Row k="BTC-PERP mark" v={dollars(markPrice)} live />
                <Row k="Gamma P&L" v={`${gammaPnl >= 0 ? "+" : ""}${money(gammaPnl)}`} color={gammaPnl >= 0 ? C.green : C.red} />
              </div>
            )}
          </div>
        )}

        {wallet.connected && !result && (
          <div className="vd-hedge-rows" style={{ marginTop: 12 }}>
            <Row k={`Your ${ccy}`} v={`${bal.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${ccy}`} color={shortBal ? C.amber : undefined} />
          </div>
        )}
        {shortBal && (
          <p style={{ marginTop: 8, fontFamily: FM, fontSize: 11, color: C.textMuted, lineHeight: 1.5 }}>
            Not enough {ccy} — {ccy === "mUSDC" ? "mint more" : "switch to mUSDC, or top up"} from <strong style={{ color: C.textSecondary }}>Test funds</strong> in the header.
          </p>
        )}

        {result ? (
          <ResultLine digest={result} label={`${meta.label} opened${hedgeOn && hasDelta ? " + hedged" : ""}`} />
        ) : (
          <button className="vd-modal-confirm" style={{ background: accent }} disabled={busy || !q || shortBal} onClick={confirm}>
            {busy ? (stage ?? "Submitting…") : shortBal ? `Need more ${ccy} to open` : `Sign & open · ${q ? usd(q.strip.total_cost_raw) : ""}`}
          </button>
        )}
        {openErr && <div className="vd-err" style={{ marginTop: 10 }}>{openErr}</div>}
        <p className="vd-note">Structure minted on-chain on Sui (wallet-signed).{hedgeOn && hasDelta ? " Delta hedge sized against live BTC‑PERP marks." : ""}</p>
      </div>
    </div>
  );
}

// ===========================================================================
// ADVANCED — Bloomberg-style multi-panel vol desk with the 3D surface centre.
// ===========================================================================
function AdvancedDesk(p: DeskProps) {
  const { surfErr, q, advSlices, advSel, advFilteredSurface, sliceIdx, setSliceIdx } = p;
  const [tab, setTab] = useState<"payoff" | "surface" | "smile" | "term">("payoff");

  // ---- bespoke-builder actions (drive the parent's sculpted weights) -------
  const loadTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id);
    p.setActiveTemplate(id);
    if (t) p.setSpanSigma(t.span);
    p.setWeights(tplWeights(id, p.bucketN));
  };
  const changeBuckets = (n: number) => {
    p.setBucketN(n);
    p.setWeights((w) => (p.activeTemplate === "custom" ? resampleWeights(w, n) : tplWeights(p.activeTemplate, n)));
  };
  const sculpt = (idx: number, v: number) => {
    p.setActiveTemplate("custom");
    p.setWeights((w) => { const nw = [...w]; nw[idx] = v; return nw; });
  };

  // Instant client-side payoff preview — tracks the sculpted weights every frame
  // (forward + σ from the live quote, stable per tenor). The throttled server
  // quote refines the priced ticket numbers.
  const previewModel = useMemo(
    () => previewPayoffModel(p.weights, p.spanSigma, q?.forward_usd ?? 0, q?.sigma_usd ?? 0, Number(p.notional)),
    [p.weights, p.spanSigma, q?.forward_usd, q?.sigma_usd, p.notional],
  );

  const tenor = advSel?.tenor_label ?? "—";
  const nT = advSlices.length;

  return (
    <div className="vd-adv2">
      {/* ── LEFT: analyse + build ───────────────────────────────────────── */}
      <div className="vd-adv2-left">

        {/* tabbed analytics — surface / smile / term, one at a time, driven by
            the selected tenor + structure below */}
        <div className="vd-card vd-analytics">
          <div className="vd-card-head">
            <div className="vd-tabs" role="tablist" aria-label="Analytics view">
              {([["payoff", "Payoff"], ["surface", "Surface"], ["smile", "Smile"], ["term", "Term"]] as const).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={`vd-tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>{label}</button>
              ))}
            </div>
            <span className="vd-dim">
              {tab === "payoff" ? `P&L vs BTC settlement · ${tenor}`
                : tab === "surface" ? `${nT} tenors × ${advSel?.points.length ?? 0} strikes · drag to rotate`
                  : tab === "smile" ? `IV vs strike · ${tenor}`
                    : `${nT} expiries · click to select`}
            </span>
          </div>

          {tab === "payoff" && (
            <div className="vd-analytics-body">
              <PayoffDiagram quote={q} markPrice={p.markPrice} accent={p.accent} h={452} model={previewModel} />
            </div>
          )}

          {tab === "surface" && (
            <div className="vd-analytics-body">
              {advFilteredSurface && advFilteredSurface.slices.length > 0 ? (
                <VolSurface3D surface={advFilteredSurface} selectedSlice={sliceIdx} height={452} />
              ) : surfErr ? (
                <div className="vd-3d-load" style={{ height: 452 }}>surface unavailable — {surfErr}</div>
              ) : (
                <div className="vd-3d-load" style={{ height: 452 }}>loading SVI surface…</div>
              )}
              <div className="vd-3d-legend"><span className="vd-leg-grad" /><span className="vd-leg-lo">low IV</span><span className="vd-leg-hi">high IV</span></div>
            </div>
          )}

          {tab === "smile" && (
            <div className="vd-analytics-body">
              <SmileChart slice={advSel} h={372} />
              <div className="vd-smile-stat">
                <div><span>ATM IV</span><strong style={{ color: C.tealLight }}>{advSel ? `${(advSel.atm_iv * 100).toFixed(1)}%` : "—"}</strong></div>
                <div><span>Forward</span><strong>{advSel ? dollars(advSel.forward_usd) : "—"}</strong></div>
                <div><span>Skew</span><strong>{advSel ? skewOf(advSel) : "—"}</strong></div>
              </div>
            </div>
          )}

          {tab === "term" && (
            <div className="vd-analytics-body">
              <TermChart surface={advFilteredSurface} selectedIdx={sliceIdx} onPick={setSliceIdx} h={372} />
              <p className="vd-analytics-note">Selected tenor <b style={{ color: C.tealLight }}>{tenor}</b> prices the structure and Greeks on the right.</p>
            </div>
          )}
        </div>

        {/* structure builder */}
        <div className="vd-card vd-builder">
          <div className="vd-card-head">
            <Cap>Structure builder</Cap>
            <span className="vd-dim">drag the bars to sculpt · {p.advStructLabel.toLowerCase()}</span>
          </div>
          <div className="vd-tpl-row">
            {TEMPLATES.map((t) => {
              const on = p.activeTemplate === t.id;
              const c = sideColor(t.side);
              return (
                <button key={t.id} className={`vd-tpl${on ? " on" : ""}`} style={on ? { borderColor: c, background: `${c}14` } : undefined} onClick={() => loadTemplate(t.id)}>
                  <b style={on ? { color: c } : undefined}>{t.label}</b>
                  <em>{t.blurb}</em>
                </button>
              );
            })}
          </div>
          <BuilderSculptor weights={p.weights} onSculpt={sculpt} quote={q} side={p.advStructSide} />
          <div className="vd-build-ctl">
            <div className="vd-ctl-span">
              <span className="vd-build-lbl">Width <i>{p.spanSigma.toFixed(1)}σ</i></span>
              <input type="range" min={1} max={4} step={0.1} value={p.spanSigma} onChange={(e) => p.setSpanSigma(Number(e.target.value))} aria-label="Strip width in sigma" />
            </div>
            <div className="vd-ctl-buckets">
              <span className="vd-build-lbl">Bands</span>
              <div className="vd-seg">
                {[6, 8, 10, 12].map((n) => (
                  <button key={n} className={`vd-seg-b${p.bucketN === n ? " on" : ""}`} onClick={() => changeBuckets(n)}>{n}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* ── RIGHT: execute ──────────────────────────────────────────────── */}
      <div className="vd-adv2-right">

        {/* trade selection: tenor (dropdown of every expiry) + size */}
        <div className="vd-card vd-trade">
          <div className="vd-card-head"><Cap>{p.advStructLabel}</Cap><span className="vd-dim" style={{ color: sideColor(p.advStructSide) }}>{p.advStructSide} vol</span></div>
          <label className="vd-field">
            <span className="vd-build-lbl">Expiry</span>
            <div className="vd-select-wrap">
              <select className="vd-select" value={sliceIdx} onChange={(e) => setSliceIdx(Number(e.target.value))} disabled={nT === 0} aria-label="Expiry tenor">
                {nT === 0 ? <option>loading…</option> : advSlices.map((s, i) => (
                  <option key={i} value={i}>{s.tenor_label} · {(s.atm_iv * 100).toFixed(1)}% IV</option>
                ))}
              </select>
            </div>
          </label>
          <label className="vd-field">
            <span className="vd-build-lbl">Amount</span>
            <div className="vd-field-row">
              <span className="vd-amount-cur">$</span>
              <input className="vd-num vd-num-sm" inputMode="decimal" value={p.notional} onChange={(e) => p.setNotional(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
              <CurrencySelect value={p.currency} onChange={p.setCurrency} />
            </div>
          </label>
        </div>

        {/* order ticket */}
        <div className="vd-card vd-ticket">
          <div className="vd-card-head"><Cap>Order</Cap><span className="vd-dim">{p.tradeable}/{q?.strip.buckets.length ?? 0} legs · {tenor}</span></div>
          <div className="vd-hedge-rows">
            <Row k="Entry cost" v={q ? usd(q.strip.total_cost_raw) : "—"} />
            <Row k="Max payout" v={q ? usd(q.strip.realized_max_payout_raw) : "—"} color={C.tealLight} />
            <Row k="Max return" v={q && Number(q.strip.total_cost_raw) > 0 ? `${(Number(q.strip.realized_max_payout_raw) / Number(q.strip.total_cost_raw)).toFixed(2)}×` : "—"} color={p.accent} />
            <Row k="Max loss" v={q ? money(q.max_loss_usd) : "—"} hint="premium" />
          </div>
          <OpenControls {...p} />
        </div>

        {/* greeks */}
        <div className="vd-card vd-adv-greeks">
          <div className="vd-card-head"><Cap>Greeks</Cap><span className="vd-dim">{tenor}</span></div>
          <div className="vd-greeks vd-greeks-tall">
            <Greek sym="Δ" name="Delta" val={p.g ? `${p.g.delta_btc >= 0 ? "+" : ""}${p.g.delta_btc.toFixed(4)}` : "—"} unit="BTC" />
            <Greek sym="Γ" name="Gamma" val={p.g ? p.g.gamma.toFixed(5) : "—"} color={p.g ? (p.g.gamma >= 0 ? C.green : C.red) : undefined} />
            {(() => {
              // Per-pt vega (∝ √T) and per-day theta (∝ 1/T) are degenerate for
              // sub-day tenors — the RAW model values are economically meaningless
              // there. Suppress both rather than print an implausible number. The
              // default ~7d tenor shows real values; only ultra-short picks hit this.
              const degenerate = !!p.q && p.q.t_years < 1 / 365;
              return (
                <>
                  <Greek sym="ν" name="Vega" val={!p.g ? "—" : degenerate ? "—" : `${p.g.vega_usd >= 0 ? "+" : ""}${money(p.g.vega_usd)}`} unit={degenerate ? "short tenor" : "/pt"} color={p.g && !degenerate ? (p.g.vega_usd >= 0 ? C.green : C.red) : undefined} />
                  <Greek sym="Θ" name="Theta" val={!p.g ? "—" : degenerate ? "—" : `${p.g.theta_usd_day >= 0 ? "+" : ""}${money(p.g.theta_usd_day)}`} unit={degenerate ? "short tenor" : "/day"} color={p.g && !degenerate ? (p.g.theta_usd_day >= 0 ? C.green : C.red) : undefined} />
                </>
              );
            })()}
          </div>
        </div>

        {/* delta hedge */}
        <HedgePanel {...p} />
      </div>
    </div>
  );
}

// ---- the bespoke weight-profile sculptor -----------------------------------
// A row of per-band bars (one per strike band). Drag across the track to "paint"
// the payout profile; each bar's height is its weight. The band under the live
// quote's ATM is marked. Sculpting flips the active template to "custom".
function BuilderSculptor({ weights, onSculpt, quote, side }: {
  weights: number[]; onSculpt: (idx: number, v: number) => void; quote: VolQuote | null; side: "long" | "short";
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const n = weights.length;
  const maxW = Math.max(...weights, 0.001);
  const accent = sideColor(side);
  const buckets = quote?.strip.buckets ?? [];

  const setFrom = (e: React.PointerEvent) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const idx = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)));
    const v = Math.min(1, Math.max(0.04, 1 - (e.clientY - r.top) / r.height));
    onSculpt(idx, Number(v.toFixed(3)));
  };
  // The band index nearest the forward (ATM) — mark it so the sculptor reads
  // against the strike axis.
  let atmIdx = Math.floor((n - 1) / 2);
  if (buckets.length === n && quote) {
    let best = Infinity;
    buckets.forEach((b, i) => {
      const mid = (b.lower_usd + b.higher_usd) / 2;
      const d = Math.abs(mid - quote.forward_usd);
      if (d < best) { best = d; atmIdx = i; }
    });
  }

  return (
    <div className="vd-sculpt">
      <div
        ref={trackRef}
        className="vd-sculpt-track"
        onPointerDown={(e) => { dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setFrom(e); }}
        onPointerMove={(e) => { if (dragging.current) setFrom(e); }}
        onPointerUp={(e) => { dragging.current = false; try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ } }}
        onPointerLeave={() => { dragging.current = false; }}
      >
        {weights.map((w, i) => (
          <div key={i} className="vd-sculpt-col">
            <div className="vd-sculpt-bar" style={{ height: `${Math.max(4, (w / maxW) * 100)}%`, background: i === atmIdx ? C.tealLight : accent, opacity: i === atmIdx ? 1 : 0.85 }} />
          </div>
        ))}
      </div>
      <div className="vd-sculpt-axis">
        <span>← puts</span>
        <span style={{ color: C.tealLight }}>{buckets.length === n && quote ? dollars((buckets[atmIdx].lower_usd + buckets[atmIdx].higher_usd) / 2) : "ATM"}</span>
        <span>calls →</span>
      </div>
    </div>
  );
}

// ---- shared right-rail panels ---------------------------------------------
function HedgePanel(p: DeskProps) {
  const { q, accent, hedgeSide, hedgeBtc, runDelta, gammaPnl, markPrice, movePct, venue, hedged, routeHedge } = p;
  const fundingSrc = q?.hedge.funding_source;
  const fundingLabel = fundingSrc === "bluefin" ? "Bluefin" : fundingSrc === "hyperliquid" ? "Hyperliquid" : "est.";
  // Signed hourly carry on the LIVE hedge size: + = the hedge EARNS funding (a short
  // perp receives funding when funding>0), − = pays.
  const carry = q && hedgeSide !== "flat" ? (hedgeSide === "short" ? 1 : -1) * hedgeBtc * markPrice * q.hedge.funding_rate : 0;
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
        <Row k="Funding (1h)" v={q ? `${(q.hedge.funding_rate * 100).toFixed(4)}%` : "—"} hint={fundingLabel} />
        <Row k="Hedge carry (1h)" v={!q || hedgeSide === "flat" ? "—" : `${carry >= 0 ? "+" : ""}${money(carry)}`} color={hedgeSide === "flat" ? undefined : carry >= 0 ? C.green : C.red} hint={hedgeSide === "flat" ? undefined : carry >= 0 ? "earn" : "pay"} />
      </div>
      <button className="vd-hedge-btn" disabled={!q || hedgeSide === "flat" || Boolean(hedged)} onClick={routeHedge}>
        {hedged ? "✓ Hedge routed" : hedgeSide === "flat" ? "Delta-neutral" : `Route ${hedgeSide} ${hedgeBtc.toFixed(4)} BTC`}
      </button>
      {hedged && <div className="vd-sim">✓ {hedged}</div>}
      <p className="vd-note">Structure minted on‑chain on Sui. Delta hedge routed to Bluefin BTC‑PERP (the Sui perp) — live mark from {venue}, funding {fundingLabel === "est." ? "estimated" : `live · ${fundingLabel}`}; hedge sizing is analytics, not a live perp order.</p>
    </div>
  );
}

function OpenControls(p: DeskProps) {
  const { wallet, accent, busy, q, tradeable, advStructLabel, stage, result, openErr, openPosition } = p;
  return (
    <>
      {!wallet.connected ? (
        <ConnectModal trigger={<button className="vd-open-btn" style={{ background: accent }}>Connect a wallet</button>} />
      ) : (
        <button className="vd-open-btn" style={{ background: accent }} disabled={busy || !q || tradeable === 0} onClick={openPosition}>
          {busy ? (stage ?? "Submitting…") : `Open ${advStructLabel} · ${q ? usd(q.strip.total_cost_raw) : ""}`}
        </button>
      )}
      {result && <ResultLine digest={result} label={`${advStructLabel} opened`} />}
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

// Interpolate the smile IV at an arbitrary log-moneyness (clamped to the wings).
function ivAtLogm(pts: VolDeskSurface["slices"][number]["points"], k: number): number {
  if (pts.length === 0) return 0;
  if (k <= pts[0].log_moneyness) return pts[0].iv;
  if (k >= pts[pts.length - 1].log_moneyness) return pts[pts.length - 1].iv;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (k >= a.log_moneyness && k <= b.log_moneyness) {
      const f = (k - a.log_moneyness) / (b.log_moneyness - a.log_moneyness || 1);
      return a.iv + (b.iv - a.iv) * f;
    }
  }
  return pts[pts.length - 1].iv;
}

/** Risk-reversal skew: IV(put) − IV(call) at a MODERATE symmetric offset, in vol
 *  points (negative => put skew). Read off the smile body, not the blown-up
 *  extreme wings, so the number stays standard and sane. */
function skewOf(slice: VolDeskSurface["slices"][number]): string {
  const pts = slice.points;
  if (pts.length < 3) return "—";
  // ~25-delta proxy: 40% of the way out to the widest available strike, capped.
  const widest = Math.max(Math.abs(pts[0].log_moneyness), Math.abs(pts[pts.length - 1].log_moneyness));
  const k = Math.min(0.12, widest * 0.4);
  const sk = (ivAtLogm(pts, -k) - ivAtLogm(pts, k)) * 100;
  return `${sk >= 0 ? "+" : ""}${sk.toFixed(1)}`;
}

// These charts render at width:100% with preserveAspectRatio="none", so the
// viewBox x-axis stretches by ratio r = containerWidth / viewBoxWidth while y is
// fixed. That turns <text> labels into stretched glyphs and <circle> markers into
// ellipses (strokes are already protected via vectorEffect). We measure the live
// ratio and counter-scale each text/marker horizontally by 1/r about its own
// anchor x — positions/numbers stay identical, only the distortion is removed.
function useSvgXRatio(viewBoxW: number) {
  const [ratio, setRatio] = useState(1);
  const roRef = useRef<ResizeObserver | null>(null);
  // Callback ref: (re)measure whenever the SVG actually mounts — including after a
  // loading placeholder is swapped for the chart. The old mount-effect ran while
  // ref.current was still null (chart not yet rendered) and never re-ran, leaving
  // ratio=1 so the un-stretch correction was an identity matrix (stretched text).
  const ref = useCallback((el: SVGSVGElement | null) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width || el.clientWidth;
      if (w > 0) setRatio(w / viewBoxW);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
  }, [viewBoxW]);
  return { ref, ratio };
}
// Horizontal counter-scale about anchor x: matrix(1/r,0,0,1, x*(1-1/r), 0).
const noStretchX = (x: number, ratio: number): string =>
  `matrix(${(1 / ratio).toFixed(5)},0,0,1,${(x * (1 - 1 / ratio)).toFixed(3)},0)`;

// "Nice" axis: round [min,max] out to clean tick increments (1/2/5 × 10ⁿ) so the
// charts label 30%/40%/50% instead of data-derived 25%/66%/108%.
function niceTicks(min: number, max: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  const range = max - min || Math.abs(max) || 1;
  const raw = range / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 0.5; v += step) ticks.push(Number(v.toFixed(6)));
  return { lo, hi, ticks };
}

// ---- 2D smile chart (IV vs strike for one tenor) --------------------------
function SmileChart({ slice, h }: { slice: VolDeskSurface["slices"][number] | null; h?: number }) {
  const W = 360, H = h ?? 184, PL = 40, PR = 14, PT = 14, PB = 26;
  const { ref, ratio } = useSvgXRatio(W);
  if (!slice || slice.points.length < 2) return <div className="vd-chart-empty">no slice</div>;
  // The slice arrives already winsorized upstream (cap = max(100%, 2×ATM)). Drop
  // the points pinned AT that cap — the blown-up far wing — so the rendered smile
  // is the smooth, informative body, not a flat plateau.
  const cap = Math.max(1.0, slice.atm_iv * 2);
  const kept = slice.points.filter((p) => p.iv < cap - 1e-6);
  const pts = kept.length >= 3 ? kept : slice.points;
  const xs = pts.map((p) => p.log_moneyness);
  const ys = pts.map((p) => p.iv);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const { lo, hi, ticks } = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const sx = (x: number) => PL + ((x - xMin) / (xMax - xMin || 1)) * (W - PL - PR);
  const sy = (y: number) => PT + (1 - (y - lo) / (hi - lo || 1)) * (H - PT - PB);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.log_moneyness).toFixed(1)} ${sy(p.iv).toFixed(1)}`).join(" ");
  const area = `${line} L ${sx(xMax).toFixed(1)} ${H - PB} L ${sx(xMin).toFixed(1)} ${H - PB} Z`;
  const atmX = sx(0);
  const atmInRange = xMin <= 0 && xMax >= 0;
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke={C.border} strokeWidth="1" opacity={0.45} vectorEffect="non-scaling-stroke" />
          <text x={PL - 6} y={sy(v) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9" transform={noStretchX(PL - 6, ratio)}>{(v * 100).toFixed(0)}%</text>
        </g>
      ))}
      {atmInRange && (
        <>
          <line x1={atmX} x2={atmX} y1={PT} y2={H - PB} stroke={C.textMuted} strokeDasharray="3 3" strokeWidth="1" opacity={0.55} vectorEffect="non-scaling-stroke" />
          <text x={atmX} y={H - 8} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="8.5" transform={noStretchX(atmX, ratio)}>ATM</text>
        </>
      )}
      <path d={area} fill={C.tealLight} opacity={0.1} />
      <path d={line} fill="none" stroke={C.tealLight} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {pts.map((p, i) => {
        const cx = sx(p.log_moneyness);
        const isAtm = Math.abs(p.log_moneyness) < 1e-9;
        return <circle key={i} cx={cx} cy={sy(p.iv)} r={isAtm ? 3 : 1.8} fill={isAtm ? C.tealLight : C.teal} transform={noStretchX(cx, ratio)} />;
      })}
    </svg>
  );
}

// ---- ATM term-structure curve (IV vs expiry) ------------------------------
function TermChart({ surface, selectedIdx, onPick, h }: { surface: VolDeskSurface | null; selectedIdx: number; onPick: (i: number) => void; h?: number }) {
  const W = 360, H = h ?? 150, PL = 40, PR = 14, PT = 14, PB = 26;
  const { ref, ratio } = useSvgXRatio(W);
  const ts = surface?.term_structure ?? [];
  if (ts.length < 2) return <div className="vd-chart-empty">{surface ? "single tenor" : "loading…"}</div>;
  const ys = ts.map((t) => t.atm_iv);
  const { lo, hi, ticks } = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const sx = (i: number) => PL + (i / (ts.length - 1)) * (W - PL - PR);
  const sy = (y: number) => PT + (1 - (y - lo) / (hi - lo || 1)) * (H - PT - PB);
  const line = ts.map((t, i) => `${i === 0 ? "M" : "L"} ${sx(i).toFixed(1)} ${sy(t.atm_iv).toFixed(1)}`).join(" ");
  // Label ~5 evenly-spaced tenors (plus first/last/selected) so the x-axis reads.
  const labelEvery = Math.max(1, Math.ceil((ts.length - 1) / 4));
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke={C.border} strokeWidth="1" opacity={0.45} vectorEffect="non-scaling-stroke" />
          <text x={PL - 6} y={sy(v) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9" transform={noStretchX(PL - 6, ratio)}>{(v * 100).toFixed(0)}%</text>
        </g>
      ))}
      <path d={line} fill="none" stroke={C.violet} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {ts.map((t, i) => {
        const on = i === selectedIdx;
        const cx = sx(i);
        const showLabel = on || i === 0 || i === ts.length - 1 || i % labelEvery === 0;
        return (
          <g key={i} style={{ cursor: "pointer" }} onClick={() => onPick(i)}>
            {/* wide invisible hit target so the tenor is easy to click */}
            <circle cx={cx} cy={sy(t.atm_iv)} r={9} fill="transparent" transform={noStretchX(cx, ratio)} />
            <circle cx={cx} cy={sy(t.atm_iv)} r={on ? 4 : 2.4} fill={on ? C.tealLight : C.violet} stroke={on ? C.tealLight : "none"} vectorEffect="non-scaling-stroke" transform={noStretchX(cx, ratio)} />
            {showLabel && (
              <text x={cx} y={H - 8} textAnchor="middle" fill={on ? C.tealLight : C.textMuted} fontFamily={FM} fontSize="8.5" transform={noStretchX(cx, ratio)}>{t.tenor_label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Classic options payoff diagram: net P&L vs BTC settlement price, with the
 *  forward and the live mark marked. Profit shaded accent, loss shaded red. */
type PayoffModel = { pts: { x: number; pnl: number }[]; lo: number; hi: number; fwd: number; cost: number; yMin: number; yMax: number };

// Standard-normal CDF (Abramowitz–Stegun 26.2.17) for the client-side preview.
function ncdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

// Client-side payoff preview — mirrors the server strip allocation (qty ∝ weight,
// scaled so Σ price·weight = notional, bands tradeable only in [2%,98%]) so the
// payoff SHAPE updates instantly every frame while the user sculpts; the throttled
// server quote then refines the exact priced numbers in the ticket. Forward + σ
// come from the live quote (stable per tenor).
function previewPayoffModel(weights: number[], spanSigma: number, fwd: number, sig: number, notional: number): PayoffModel | null {
  if (!(fwd > 0) || !(sig > 0) || !(notional > 0) || weights.length < 2) return null;
  const n = weights.length;
  const lo = Math.max(0, fwd - spanSigma * sig), hi = fwd + spanSigma * sig;
  const bw = (hi - lo) / n;
  const edges: { a: number; b: number }[] = [];
  const ws: number[] = [];
  let denom = 0;
  for (let i = 0; i < n; i++) {
    const a = lo + i * bw, b = lo + (i + 1) * bw;
    const prob = ncdf((b - fwd) / sig) - ncdf((a - fwd) / sig);
    const w = prob >= 0.02 && prob <= 0.98 ? Math.max(0, weights[i]) : 0;
    edges.push({ a, b }); ws.push(w); denom += prob * w;
  }
  const K = denom > 0 ? notional / denom : 0;
  const qty = ws.map((w) => K * w);
  const plo = Math.max(0, fwd - 3.4 * sig), phi = fwd + 3.4 * sig;
  const payoffAt = (x: number) => { for (let i = 0; i < n; i++) if (x > edges[i].a && x <= edges[i].b) return qty[i]; return 0; };
  const N = 160;
  const pts = Array.from({ length: N }, (_, i) => { const x = plo + (i / (N - 1)) * (phi - plo); return { x, pnl: payoffAt(x) - notional }; });
  const ys = pts.map((p) => p.pnl);
  return { pts, lo: plo, hi: phi, fwd, cost: notional, yMin: Math.min(...ys, 0), yMax: Math.max(...ys, 0) };
}

function PayoffDiagram({ quote, markPrice, accent, compact, h, model: modelOverride }: { quote: VolQuote | null; markPrice: number; accent: string; compact?: boolean; h?: number; model?: PayoffModel | null }) {
  const W = 760, H = h ?? (compact ? 168 : 272), PL = 52, PR = 16, PT = 16, PB = 28;
  const { ref, ratio } = useSvgXRatio(W);
  const model = useMemo(() => {
    if (modelOverride) return modelOverride;
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
  }, [quote, modelOverride]);

  if (!model) return <div className="vd-payoff-empty" style={h ? { height: h } : compact ? { height: H } : { flex: 1, minHeight: 240 }}>pricing…</div>;
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
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={h ?? (compact ? H : "100%")} preserveAspectRatio="none" style={{ display: "block", ...(h || compact ? {} : { flex: 1, minHeight: 240 }) }}>
      <defs>
        <clipPath id="vd-pos"><rect x={PL} y={PT} width={W - PL - PR} height={Math.max(0, zeroY - PT)} /></clipPath>
        <clipPath id="vd-neg"><rect x={PL} y={zeroY} width={W - PL - PR} height={Math.max(0, H - PB - zeroY)} /></clipPath>
      </defs>
      {[yMax, 0, yMin].map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke={C.border} strokeWidth="1" opacity={v === 0 ? 0.9 : 0.4} vectorEffect="non-scaling-stroke" />
          <text x={PL - 8} y={sy(v) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9.5" transform={noStretchX(PL - 8, ratio)}>{v >= 0 ? "+$" : "-$"}{Math.abs(Math.round(v)).toLocaleString()}</text>
        </g>
      ))}
      <g clipPath="url(#vd-pos)"><path d={areaPos} fill={accent} opacity={0.16} /></g>
      <g clipPath="url(#vd-neg)"><path d={areaPos} fill={C.red} opacity={0.12} /></g>
      <line x1={sx(fwd)} x2={sx(fwd)} y1={PT} y2={H - PB} stroke={C.textMuted} strokeWidth="1" strokeDasharray="3 3" opacity={0.6} vectorEffect="non-scaling-stroke" />
      <text x={sx(fwd)} y={H - 8} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9" transform={noStretchX(sx(fwd), ratio)}>fwd {dollars(fwd)}</text>
      <line x1={sx(markX)} x2={sx(markX)} y1={PT} y2={H - PB} stroke={C.tealLight} strokeWidth="1.2" opacity={0.85} vectorEffect="non-scaling-stroke" />
      <circle cx={sx(markX)} cy={PT + 4} r={3} fill={C.tealLight} transform={noStretchX(sx(markX), ratio)} />
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

  /* Metrics: one box of 4 market stats + a separate live BTC price box. */
  .vd-metrics2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(210px, 0.32fr); gap: 14px; }
  .vd-stat4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 12px; overflow: hidden; }
  .vd-stat4 > .vd-stat { background: ${C.card}; }
  .vd-pricebox { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 12px; padding: 13px 18px; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; gap: 4px; text-align: right; }
  .vd-mark-k { font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-pricebox strong { font-family: ${FD}; font-size: 30px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; animation: vd-flash 0.5s ${EASE}; }
  .vd-mark-v { font-family: ${FM}; font-size: 10px; color: ${C.textMuted}; display: inline-flex; align-items: center; gap: 5px; }
  @media (max-width: 1080px) { .vd-metrics2 { grid-template-columns: 1fr; } .vd-stat4 { grid-template-columns: repeat(2, 1fr); } .vd-pricebox { align-items: flex-start; text-align: left; } }

  .vd-err { border: 0.5px solid ${C.red}55; background: ${C.redBg}; border-radius: 10px; padding: 11px 14px; font-family: ${FM}; font-size: 12px; color: ${C.red}; }

  .vd-grid { display: grid; grid-template-columns: minmax(0, 1.62fr) minmax(330px, 0.92fr); gap: 14px; align-items: stretch; }
  @media (max-width: 1080px) { .vd-grid { grid-template-columns: 1fr; } .vd-stats { grid-template-columns: repeat(2, 1fr); } .vd-top { flex-direction: column; } .vd-ticker { text-align: left; } }
  .vd-main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .vd-side { display: grid; gap: 14px; min-width: 0; align-content: start; }
  /* Basic payoff card fills the left column so the graph extends down (no dead space). */
  .vd-payoff { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .vd-card { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 15px 16px; min-width: 0; }
  .vd-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .vd-dim, .vd-live { font-family: ${FM}; font-size: 10px; color: ${C.textMuted}; }
  .vd-live { display: inline-flex; align-items: center; gap: 5px; color: ${C.green}; white-space: nowrap; }

  .vd-strats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; padding: 12px; }
  .vd-strat { display: grid; gap: 5px; justify-items: start; padding: 12px; border-radius: 11px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: pointer; transition: all 0.15s ${EASE}; }
  .vd-strat:hover { border-color: ${C.borderHover}; transform: translateY(-1px); }
  .vd-strat b { font-family: ${FD}; font-size: 13.5px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-strat em { font-family: ${FM}; font-size: 9.5px; font-style: normal; color: ${C.textMuted}; }

  .vd-amount { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 11px; padding: 10px 13px; display: grid; gap: 6px; }
  .vd-amount-in { display: flex; align-items: center; gap: 7px; }
  .vd-num { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: ${C.textPrimary}; font-family: ${FD}; font-size: 22px; font-weight: 600; padding: 0; }
  .vd-num-sm { font-size: 18px; }
  .vd-amount-in span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }
  .vd-amount-in .vd-amount-cur, .vd-field-row .vd-amount-cur { font-family: ${FD}; font-size: 18px; font-weight: 600; color: ${C.textMuted}; line-height: 1; }
  .vd-field-row { display: flex; align-items: center; gap: 7px; }
  .vd-field-row .vd-num-sm { width: auto; flex: 1; min-width: 0; }
  .vd-horizon { display: grid; gap: 6px; }
  .vd-pills { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .vd-pill { display: grid; gap: 2px; justify-items: center; padding: 8px 6px; border-radius: 9px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: pointer; transition: all 0.15s ${EASE}; }
  .vd-pill:hover:not(:disabled) { border-color: ${C.borderHover}; }
  .vd-pill:disabled { opacity: 0.5; cursor: default; }
  .vd-pill.on { border-color: ${C.tealLight}; background: ${C.tealLight}14; }
  .vd-pill b { font-family: ${FD}; font-size: 12px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-pill.on b { color: ${C.tealLight}; }
  .vd-pill em { font-family: ${FM}; font-size: 9px; font-style: normal; color: ${C.textMuted}; }
  /* Basic: controls stacked vertically in the right-rail order-entry column. */
  .vd-ctrls-v { display: grid; grid-template-columns: 1fr; align-items: stretch; gap: 12px; }
  .vd-ctrls-desc { margin: 0; font-family: ${FS}; font-size: 12.5px; line-height: 1.55; color: ${C.textSecondary}; }
  .vd-ctrls-desc span { color: ${C.textMuted}; }
  .vd-ticket-be { margin: 11px 0 0; font-family: ${FS}; font-size: 12px; line-height: 1.5; color: ${C.textSecondary}; }
  .vd-ticket-be b { color: ${C.textPrimary}; font-weight: 600; }

  /* Execute / review modal (optional delta-neutral hedge before signing). */
  .vd-modal-bg { position: fixed; inset: 0; z-index: 60; background: rgba(2, 10, 20, 0.62); backdrop-filter: blur(3px); display: grid; place-items: center; padding: 20px; animation: vd-fade 0.14s ${EASE}; }
  @keyframes vd-fade { from { opacity: 0; } to { opacity: 1; } }
  .vd-modal { width: min(440px, 100%); background: ${C.card}; border: 0.5px solid ${C.borderStrong}; border-radius: 16px; padding: 18px; display: grid; gap: 13px; box-shadow: 0 24px 60px rgba(0,0,0,0.45); }
  .vd-modal-head { display: flex; justify-content: space-between; align-items: center; }
  .vd-modal-x { appearance: none; border: none; background: transparent; color: ${C.textMuted}; font-size: 14px; cursor: pointer; padding: 2px 6px; border-radius: 6px; line-height: 1; }
  .vd-modal-x:hover { color: ${C.textPrimary}; background: ${C.cardHover}; }
  .vd-modal-title { font-family: ${FD}; font-size: 16px; font-weight: 600; color: ${C.textPrimary}; display: flex; align-items: center; gap: 8px; }
  .vd-modal-badge { font-family: ${FM}; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; padding: 3px 8px; border-radius: 6px; text-transform: capitalize; }
  .vd-modal-hedge { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 11px; padding: 12px; display: grid; gap: 9px; transition: border-color 0.15s ${EASE}; }
  .vd-modal-hedge.on { border-color: ${C.tealLight}66; }
  .vd-modal-toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; font-family: ${FD}; font-size: 13px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-modal-toggle input { width: 15px; height: 15px; accent-color: #4da2ff; cursor: pointer; flex-shrink: 0; }
  .vd-modal-toggle i { margin-left: auto; font-style: normal; font-family: ${FM}; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-modal-hedge p { margin: 0; font-family: ${FS}; font-size: 11.5px; line-height: 1.55; color: ${C.textSecondary}; }
  .vd-modal-hedge p i { font-style: normal; color: ${C.textMuted}; }
  .vd-modal-confirm { width: 100%; height: 46px; border: none; border-radius: 12px; color: #04121d; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: transform 0.15s ${EASE}, opacity 0.15s ${EASE}; }
  .vd-modal-confirm:hover:not(:disabled) { transform: translateY(-1px); }
  .vd-modal-confirm:disabled { opacity: 0.6; cursor: default; }

  .vd-payoff-empty { display: grid; place-items: center; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }

  .vd-greeks { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .vd-greeks-tall { grid-template-columns: 1fr 1fr; }
  .vd-greek { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 10px; padding: 11px 13px; display: grid; gap: 5px; }
  .vd-greek-k { font-family: ${FM}; font-size: 11px; color: ${C.textSecondary}; display: flex; align-items: baseline; gap: 5px; }
  .vd-greek-k i { font-style: normal; font-size: 8.5px; letter-spacing: 0.05em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-greek strong { font-family: ${FD}; font-size: 17px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vd-greek strong em { font-family: ${FM}; font-size: 9.5px; font-style: normal; color: ${C.textMuted}; margin-left: 3px; }

  .vd-legs-title { display: flex; align-items: center; gap: 8px; }
  .vd-legs-desc { margin: 0 0 13px; font-family: ${FS}; font-size: 12.5px; line-height: 1.5; color: ${C.textSecondary}; }
  .vd-legs-desc span { color: ${C.textMuted}; }
  .vd-leg.profit { background: ${C.green}0e; }
  .vd-leg.profit .vd-leg-band { color: ${C.textPrimary}; font-weight: 500; }
  .vd-leg-tag { margin-left: 9px; font-style: normal; font-family: ${FM}; font-size: 8.5px; letter-spacing: 0.06em; text-transform: uppercase; color: ${C.green}; background: ${C.green}1c; padding: 2px 6px; border-radius: 4px; }
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
  .vd-open-btn { width: 100%; height: 46px; margin-top: 15px; border: none; border-radius: 12px; color: #04121d; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.15s ${EASE}, transform 0.15s ${EASE}; }
  .vd-open-btn:hover:not(:disabled) { transform: translateY(-1px); }
  .vd-open-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ---- ADVANCED desk — 2-column trade terminal ---- */
  .vd-adv2 { display: grid; grid-template-columns: minmax(0, 1.58fr) minmax(330px, 0.9fr); gap: 14px; align-items: stretch; min-width: 0; }
  @media (max-width: 1180px) { .vd-adv2 { grid-template-columns: 1fr; } }
  /* flex columns so the LAST card in each (builder ⟷ hedge) grows to fill —
     their bottoms line up regardless of which column is naturally taller. */
  .vd-adv2-left, .vd-adv2-right { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

  /* tabbed analytics card (surface / smile / term) */
  .vd-analytics { display: flex; flex-direction: column; }
  .vd-analytics-body { display: flex; flex-direction: column; }
  .vd-analytics-note { margin: 12px 0 0; font-family: ${FS}; font-size: 12px; line-height: 1.5; color: ${C.textSecondary}; }
  .vd-analytics-note b { font-weight: 600; }
  .vd-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; border: 0.5px solid ${C.border}; background: ${C.bg}; }
  .vd-tab { appearance: none; border: none; background: transparent; color: ${C.textMuted}; font-family: ${FM}; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; padding: 5px 14px; border-radius: 6px; cursor: pointer; transition: background 0.14s ${EASE}, color 0.14s ${EASE}; }
  .vd-tab:hover:not(.on) { color: ${C.textPrimary}; }
  .vd-tab.on { background: ${C.tealLight}; color: #04121d; }
  .vd-tab:focus-visible { outline: 2px solid ${C.tealLight}; outline-offset: 2px; }

  .vd-3d-load { height: 356px; display: grid; place-items: center; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; background: ${C.bg}; border-radius: 12px; }
  .vd-3d-legend { display: flex; align-items: center; gap: 10px; margin-top: 11px; }
  .vd-leg-grad { flex: 1; height: 7px; border-radius: 4px; background: linear-gradient(90deg, ${C.tealBg}, ${C.teal}, ${C.tealLight}, ${C.amber}, ${C.coral}); }
  .vd-leg-lo, .vd-leg-hi { font-family: ${FM}; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; white-space: nowrap; }
  .vd-chart-empty { height: 200px; display: grid; place-items: center; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }
  .vd-smile-stat { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-top: 12px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; }
  .vd-smile-stat > div { background: ${C.card}; padding: 10px 13px; display: grid; gap: 3px; }
  .vd-smile-stat span { font-family: ${FM}; font-size: 9px; letter-spacing: 0.07em; text-transform: uppercase; color: ${C.textMuted}; }
  .vd-smile-stat strong { font-family: ${FD}; font-size: 16px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  /* right rail — trade selection (expiry dropdown + amount) */
  .vd-trade { display: grid; gap: 12px; }
  .vd-field { display: grid; gap: 6px; padding: 10px 13px; border-radius: 10px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: text; }
  .vd-field:focus-within { border-color: ${C.borderHover}; }
  .vd-field .vd-num-sm { font-size: 20px; width: 100%; }
  .vd-select-wrap { position: relative; }
  .vd-select-wrap::after { content: "▾"; position: absolute; right: 2px; top: 50%; transform: translateY(-50%); pointer-events: none; color: ${C.textMuted}; font-size: 11px; }
  .vd-select { appearance: none; width: 100%; padding: 2px 18px 2px 0; border: none; background: transparent; color: ${C.textPrimary}; font-family: ${FD}; font-size: 16px; font-weight: 600; cursor: pointer; outline: none; }
  .vd-select option { color: #04121d; }
  /* hedge is the right column's last card — fill so its bottom aligns with the
     builder; pin the disclaimer note to the bottom edge. */
  .vd-hedge { flex: 1 1 auto; display: flex; flex-direction: column; }
  .vd-hedge .vd-note { margin-top: auto; }

  .vd-builder { display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; }
  /* template "tiers" — load a starting profile into the sculptor */
  .vd-tpl-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
  .vd-tpl { display: grid; gap: 3px; justify-items: start; padding: 8px 10px; border-radius: 9px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: pointer; transition: all 0.15s ${EASE}; text-align: left; }
  .vd-tpl:hover { border-color: ${C.borderHover}; transform: translateY(-1px); }
  .vd-tpl b { font-family: ${FD}; font-size: 12px; font-weight: 600; color: ${C.textPrimary}; }
  .vd-tpl em { font-family: ${FM}; font-size: 8px; font-style: normal; text-transform: uppercase; letter-spacing: 0.04em; color: ${C.textMuted}; }

  /* the weight-profile sculptor (drag the bars to shape the payout) */
  .vd-sculpt { display: flex; flex-direction: column; gap: 7px; flex: 1 1 auto; min-height: 0; }
  .vd-sculpt-track { position: relative; display: flex; align-items: flex-end; gap: 3px; flex: 1 1 auto; min-height: 116px; padding: 10px 10px 0; border-radius: 10px; border: 0.5px solid ${C.border}; background: ${C.surface}; cursor: ns-resize; touch-action: none; }
  .vd-sculpt-col { flex: 1; height: 100%; display: flex; align-items: flex-end; }
  .vd-sculpt-bar { width: 100%; border-radius: 3px 3px 0 0; min-height: 4px; transition: height 0.05s linear; }
  .vd-sculpt-axis { display: flex; justify-content: space-between; font-family: ${FM}; font-size: 9px; letter-spacing: 0.04em; color: ${C.textMuted}; padding: 0 2px; font-variant-numeric: tabular-nums; }

  /* width (σ) + band-count controls */
  .vd-build-ctl { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; padding: 10px 13px; border-radius: 10px; border: 0.5px solid ${C.border}; background: ${C.surface}; }
  .vd-ctl-span { display: grid; gap: 7px; }
  .vd-ctl-span input[type="range"] { width: 100%; accent-color: #4da2ff; cursor: pointer; }
  .vd-ctl-buckets { display: grid; gap: 7px; justify-items: end; }
  .vd-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; border: 0.5px solid ${C.border}; background: ${C.bg}; }
  .vd-seg-b { appearance: none; border: none; background: transparent; color: ${C.textMuted}; font-family: ${FM}; font-size: 11px; font-weight: 600; padding: 4px 9px; border-radius: 6px; cursor: pointer; transition: background 0.12s ${EASE}, color 0.12s ${EASE}; }
  .vd-seg-b.on { background: ${C.tealLight}; color: #04121d; }

  .vd-build-lbl { font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.07em; text-transform: uppercase; color: ${C.textMuted}; white-space: nowrap; }
  .vd-build-lbl i { font-style: normal; color: ${C.tealLight}; margin-left: 4px; }
`;
