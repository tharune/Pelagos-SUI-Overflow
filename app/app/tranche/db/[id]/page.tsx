"use client";

// ---------------------------------------------------------------------------
// DeepBook tranche detail — same UI as the Polymarket (PBU) tranche detail, fed
// by the live DeepBook Predict engine. The whole oracle is one BTC range strip;
// senior / mezz / junior are conviction-width slices of it. Layout mirrors the
// event-tranche page: hero, outcome-distribution chart, metric tiles, a
// slice-width waterfall selector, a live CEX order book, and a Buy/Sell panel
// with the full fee breakdown + "how it works". Serves the BTC risk slice and
// the cross-venue hybrid vaults (hybrid-short / -med / -long), the latter with a
// Polymarket event basket preselected as the junior tail.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Header, PageFrame } from "../../../_components/Header";
import { MetricTile } from "../../../_components/charts";
import { C, FD, FM, FS, EASE, trancheColor, lightenColor } from "../../../_lib/tokens";
import { friendlyWalletError } from "../../../_lib/chain";
import { useWalletSigner } from "../../../_lib/wallet-bridge";
import { useLiveBaskets } from "../../../_lib/use-live-baskets";
import { BUNDLES } from "../../../_lib/bundles";
import type { LiveBasket } from "../../../_lib/live-baskets";
import { ConnectModal } from "@mysten/dapp-kit";
import { OrderBook, ResultLine, Cap, dollars, openableBuckets, StripStyles } from "../../../_components/strip-products";
import {
  trancheQuote,
  fetchDensity,
  fetchVolSurface,
  ensureManager,
  prepareOpenStrip,
  prepareRedeemStrip,
  confirmPredict,
  usd,
  type TrancheProfile,
  type ImpliedDensity,
} from "../../../_lib/predict-strip-client";

type Side = "buy" | "sell";
type Kind = TrancheProfile["tranche"];
const ORDER: Kind[] = ["senior", "mezz", "junior"];
const kindLabel = (k: Kind) => (k === "mezz" ? "mezzanine" : k);
const colorFor = (k: Kind) => trancheColor(k === "mezz" ? "mezzanine" : k);
const HY_LABEL: Record<string, string> = { short: "Short", med: "Medium", long: "Long" };

const num = (raw: string) => Number(raw) / 1e6;
function metrics(t: TrancheProfile) {
  const cost = num(t.strip.total_cost_raw);
  const best = num(t.strip.realized_max_payout_raw);
  const spread = num(t.strip.round_trip_spread_raw);
  const slippage = num(t.strip.total_slippage_raw);
  const units = t.strip.buckets.reduce((s, b) => s + (b.tradeable ? Number(b.quantity) : 0), 0) / 1e6;
  const live = t.strip.buckets.filter((b) => b.tradeable).length;
  return { cost, best, spread, slippage, units, live, total: t.strip.buckets.length, mult: cost > 0 ? best / cost : 0 };
}

export default function DeepBookTrancheDetail() {
  const params = useParams();
  const idRaw = (Array.isArray(params?.id) ? params?.id[0] : params?.id) ?? "";
  const isHybrid = idRaw.startsWith("hybrid");
  const bucket = isHybrid ? (idRaw.split("-")[1] ?? "short") : null;
  const wallet = useWalletSigner();
  const basketState = useLiveBaskets();

  const [oracleId, setOracleId] = useState<string | undefined>(!isHybrid && idRaw.startsWith("0x") ? idRaw : undefined);
  const [resolved, setResolved] = useState<boolean>(!isHybrid);
  const [tenor, setTenor] = useState<string>("");
  const [tranches, setTranches] = useState<TrancheProfile[] | null>(null);
  const [forward, setForward] = useState<number | null>(null);
  const [density, setDensity] = useState<ImpliedDensity | null>(null);
  const [selected, setSelected] = useState<Kind>("senior");
  const [err, setErr] = useState<string | null>(null);

  // Resolve the hybrid vault's tenor → oracle from the live vol surface.
  useEffect(() => {
    if (!isHybrid) return;
    let alive = true;
    fetchVolSurface("BTC")
      .then((s) => {
        const Y = 31_557_600;
        const live = s.slices.filter((sl) => sl.t_years > 360 / Y).sort((a, b) => a.expiry - b.expiry);
        const pick = bucket === "long" ? live[live.length - 1] : bucket === "med" ? live[Math.floor(live.length / 2)] : live[0];
        if (alive) { setOracleId(pick?.oracle_id); setTenor(pick?.tenor_label ?? ""); setResolved(true); }
      })
      .catch(() => { if (alive) setResolved(true); });
    return () => { alive = false; };
  }, [isHybrid, bucket]);

  useEffect(() => {
    if (!resolved) return;
    let alive = true;
    setErr(null);
    trancheQuote({ asset: "BTC", oracle_id: oracleId, budget_usd: 100 })
      .then(async (q) => {
        if (!alive) return;
        setTranches(q.tranches);
        setForward(q.forward_usd);
        if (!oracleId) setOracleId(q.oracle_id);
        const [d, vs] = await Promise.all([fetchDensity(q.oracle_id).catch(() => null), fetchVolSurface("BTC").catch(() => null)]);
        if (!alive) return;
        setDensity(d);
        if (!tenor && vs) setTenor(vs.slices.find((sl) => sl.oracle_id === q.oracle_id)?.tenor_label ?? "");
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [resolved, oracleId]);

  // Preselected Polymarket basket (the hybrid junior tail), by horizon.
  const eventBasket = useMemo(() => {
    if (!isHybrid) return null;
    const list = (basketState.status === "ok" && basketState.baskets.length > 0 ? basketState.baskets : (BUNDLES as unknown as LiveBasket[]));
    const sorted = [...list].sort((a, b) => a.daysLeft - b.daysLeft);
    const at = (i: number) => sorted[Math.max(0, Math.min(sorted.length - 1, i))] ?? null;
    return bucket === "long" ? at(sorted.length - 1) : bucket === "med" ? at(Math.floor(sorted.length / 2)) : at(0);
  }, [isHybrid, bucket, basketState]);

  const sorted = useMemo(
    () => (tranches ? ORDER.map((k) => tranches.find((t) => t.tranche === k)).filter((t): t is TrancheProfile => Boolean(t)) : []),
    [tranches],
  );
  const sel = sorted.find((t) => t.tranche === selected) ?? sorted[0] ?? null;
  const m = sel ? metrics(sel) : null;
  const accent = colorFor(selected);

  return (
    <>
      <Header />
      <PageFrame wide>
        <Link href="/app/tranche" className="dbt-back">← Back to Risk Slices</Link>

        {/* Hero */}
        <div className="dbt-hero">
          <div style={{ minWidth: 0 }}>
            <div className="dbt-tag" style={{ color: isHybrid ? C.violet : C.teal }}>
              <i style={{ background: isHybrid ? C.violet : C.teal }} />
              {isHybrid ? `HYBRID${bucket ? ` · ${HY_LABEL[bucket]?.toUpperCase()}` : ""}` : "DEEPBOOK · BTC"}
            </div>
            <h1>
              {isHybrid ? `Hybrid Vault${bucket ? ` · ${HY_LABEL[bucket]}` : ""}` : "BTC Risk Slice"}
              <span> · tranched</span>
            </h1>
            <div className="dbt-meta">
              {forward != null && <span>forward <b>{dollars(forward)}</b></span>}
              {tenor && <span>tenor <b>{tenor}</b></span>}
              {density && <span>σ <b>{dollars(density.forward_usd * density.atm_iv * Math.sqrt(Math.max(density.t_years, 1e-9)))}</b></span>}
              {sel && <span><b>{metrics(sel).live}/{metrics(sel).total}</b> bands live</span>}
            </div>
          </div>
          {m && (
            <div className="dbt-hero-right">
              <span>{kindLabel(selected)} slice</span>
              <strong style={{ color: accent }}>{m.mult.toFixed(2)}×</strong>
              <em style={{ color: C.green }}>best case ${m.best.toFixed(2)}</em>
              <em>cost ${m.cost.toFixed(2)} · spread ${m.spread.toFixed(2)}</em>
            </div>
          )}
        </div>

        {err && <div className="dbt-error">{err}</div>}

        <div className="dbt-grid">
          {/* LEFT */}
          <div className="dbt-left">
            <div className="dbt-card dbt-chart-card">
              <div className="dbt-card-head">
                <Cap>Outcome distribution · normal moment-matched</Cap>
                {density && (
                  <span className="dbt-mono-dim">
                    μ {dollars(density.forward_usd)} · σ {dollars(density.forward_usd * density.atm_iv * Math.sqrt(Math.max(density.t_years, 1e-9)))}
                  </span>
                )}
              </div>
              <DensityChart density={density} tranches={sorted} selected={selected} forward={forward} />
            </div>

            {/* metric tiles */}
            <div className="dbt-tiles">
              <MetricTile label="ASK" value={m ? `$${m.cost.toFixed(2)}` : "—"} color={accent} sub="to mint the slice" />
              <MetricTile label="BEST CASE" value={m ? `$${m.best.toFixed(2)}` : "—"} sub="largest band settles" />
              <MetricTile label="MULTIPLE" value={m ? `${m.mult.toFixed(2)}x` : "—"} color={m && m.mult >= 1.5 ? C.green : undefined} sub="best ÷ cost" />
              <MetricTile label="SPREAD" value={m ? `$${m.spread.toFixed(2)}` : "—"} color={C.amber} sub="round-trip" />
            </div>

            {/* slice-width waterfall selector */}
            <Waterfall tranches={sorted} selected={selected} onSelect={setSelected} />

            {/* live CEX order book */}
            <div className="dbt-card">
              <Cap style={{ marginBottom: 12 }}>Order book · live on-chain depth</Cap>
              <OrderBook oracleId={oracleId} />
            </div>

            {isHybrid && eventBasket && (
              <Link href={`/app/tranche/${eventBasket.id}`} className="dbt-hyb-leg">
                <div className="dbt-tag" style={{ color: C.violet, marginBottom: 8 }}><i style={{ background: C.violet }} />LEG 2 · POLYMARKET EVENT TAIL · PRESELECTED</div>
                <div className="dbt-hyb-title">{eventBasket.id} <span style={{ color: C.textMuted }}>· {eventBasket.totalLegs} legs · NAV {(eventBasket.nav * 100).toFixed(1)}%</span></div>
                <p>The junior tail is funded from this Polymarket event basket (CLOB-priced, settled on Pelagos&apos;s own vault). Open it to complete the cross-venue slice →</p>
              </Link>
            )}
          </div>

          {/* RIGHT — Buy / Sell panel */}
          <BuyPanel wallet={wallet} oracleId={oracleId} selected={selected} onSelect={setSelected} tranches={sorted} isHybrid={isHybrid} />
        </div>
      </PageFrame>
      <StripStyles />
      <style jsx global>{DBT_CSS}</style>
    </>
  );
}

// ---------------------------------------------------------------------------
// Outcome-distribution chart (matches the PBU event-tranche chart): a moment-
// matched Normal over μ±3σ, the selected slice's coverage shaded full-height,
// forward marked, slice boundaries called out.
// ---------------------------------------------------------------------------
function DensityChart({ density, tranches, selected, forward }: { density: ImpliedDensity | null; tranches: TrancheProfile[]; selected: Kind; forward: number | null }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(680);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setW(Math.max(280, Math.floor(e.contentRect.width))); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sel = tranches.find((t) => t.tranche === selected) ?? tranches[0] ?? null;
  const coverage = (t: TrancheProfile | null): [number, number] | null => {
    if (!t) return null;
    const live = t.strip.buckets.filter((b) => b.tradeable);
    if (live.length === 0) return null;
    return [Math.min(...live.map((b) => b.lower_usd)), Math.max(...live.map((b) => b.higher_usd))];
  };
  const mu = forward ?? density?.forward_usd ?? null;
  let sigma = density ? density.forward_usd * density.atm_iv * Math.sqrt(Math.max(density.t_years, 1e-9)) : 0;
  if (!(sigma > 0) && mu != null) {
    const c = coverage(tranches.find((t) => t.tranche === "senior") ?? sel);
    sigma = c ? (c[1] - c[0]) / 3.6 : mu * 0.005;
  }

  const H = 300, PT = 24, PB = 28, PL = 12, PR = 12;
  const frame = useMemo(() => {
    if (mu == null || !(sigma > 0)) return null;
    const lo = mu - 3 * sigma, hi = mu + 3 * sigma, span = hi - lo || 1;
    const N = 240;
    const norm = (x: number) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    const sx = (v: number) => PL + ((Math.max(lo, Math.min(hi, v)) - lo) / span) * (w - PL - PR);
    const sy = (d: number) => PT + (1 - d) * (H - PT - PB);
    const pts: Array<{ x: number; y: number; v: number }> = [];
    for (let i = 0; i <= N; i++) { const v = lo + (span * i) / N; pts.push({ x: sx(v), y: sy(norm(v)), v }); }
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const base = H - PB;
    const sliceArea = (a: number, d: number) => {
      const inside = pts.filter((p) => p.v >= a && p.v <= d);
      if (inside.length === 0) return "";
      return `M ${sx(a).toFixed(1)} ${base} ` + inside.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + ` L ${sx(d).toFixed(1)} ${base} Z`;
    };
    return { lo, hi, span, sx, sy, line, base, sliceArea };
  }, [mu, sigma, w]);

  const selBand = coverage(sel);
  const selColor = colorFor(selected);

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      {frame && mu != null ? (
        <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} style={{ display: "block" }}>
          <defs>
            <linearGradient id="dbt-grad-all" gradientUnits="userSpaceOnUse" x1="0" y1={PT} x2="0" y2={frame.base}>
              <stop offset="0%" stopColor={C.textSecondary} stopOpacity="0.16" />
              <stop offset="100%" stopColor={C.textSecondary} stopOpacity="0.01" />
            </linearGradient>
            <linearGradient id="dbt-grad-sel" gradientUnits="userSpaceOnUse" x1="0" y1={PT} x2="0" y2={frame.base}>
              <stop offset="0%" stopColor={selColor} stopOpacity="0.62" />
              <stop offset="55%" stopColor={selColor} stopOpacity="0.2" />
              <stop offset="100%" stopColor={selColor} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={frame.sliceArea(frame.lo, frame.hi)} fill="url(#dbt-grad-all)" />
          {selBand && <path d={frame.sliceArea(Math.max(frame.lo, selBand[0]), Math.min(frame.hi, selBand[1]))} fill="url(#dbt-grad-sel)" />}
          <path d={frame.line} fill="none" stroke={C.textPrimary} strokeWidth="1.5" strokeOpacity="0.82" strokeLinejoin="round" strokeLinecap="round" />
          {selBand && [selBand[0], selBand[1]].map((b, i) => (b >= frame.lo && b <= frame.hi ? <line key={i} x1={frame.sx(b)} x2={frame.sx(b)} y1={PT} y2={frame.base} stroke={selColor} strokeWidth="1" strokeDasharray="3 3" opacity={0.55} /> : null))}
          {mu >= frame.lo && mu <= frame.hi && (
            <g>
              <line x1={frame.sx(mu)} x2={frame.sx(mu)} y1={PT - 8} y2={frame.base} stroke={C.tealLight} strokeWidth="1.4" opacity={0.9} />
              <text x={frame.sx(mu)} y={PT - 11} textAnchor="middle" fontFamily={FM} fontSize="10" fill={C.tealLight} fontWeight={500}>Forward {dollars(mu)}</text>
            </g>
          )}
          {(() => {
            const raw: Array<{ v: number; sel?: boolean }> = [{ v: frame.lo }, { v: frame.hi }];
            if (selBand) raw.push({ v: selBand[0], sel: true }, { v: selBand[1], sel: true });
            const eps = frame.span * 0.02;
            const ticks: typeof raw = [];
            for (const t of raw.sort((a, b) => a.v - b.v)) if (!ticks.some((x) => Math.abs(x.v - t.v) < eps)) ticks.push(t);
            return ticks.map((t, i) => (
              <text key={i} x={frame.sx(t.v)} y={H - 9} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"} fontFamily={FM} fontSize="9.5" fill={t.sel ? selColor : C.textMuted} opacity={t.sel ? 0.95 : 0.8}>{dollars(t.v)}</text>
            ));
          })()}
        </svg>
      ) : (
        <div style={{ height: H, display: "grid", placeItems: "center", fontFamily: FM, fontSize: 12, color: C.textMuted }}>Loading the implied distribution…</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slice-width waterfall selector (matches the PBU PAYOUT ORDER card): a
// segmented bar scaled to each slice's coverage width + three clickable cards.
// ---------------------------------------------------------------------------
function Waterfall({ tranches, selected, onSelect }: { tranches: TrancheProfile[]; selected: Kind; onSelect: (k: Kind) => void }) {
  if (tranches.length === 0) return <div className="dbt-card" style={{ height: 150 }} />;
  const weights = tranches.map((t) => Math.max(0.18, t.sigma_mult));
  return (
    <div className="dbt-card">
      <Cap style={{ marginBottom: 14 }}>Slice width · senior widest</Cap>
      <div className="dbt-segbar" style={{ gridTemplateColumns: weights.map((w) => `${w}fr`).join(" ") }}>
        {tranches.map((t) => {
          const active = t.tranche === selected;
          const col = colorFor(t.tranche);
          return (
            <button key={t.tranche} type="button" aria-selected={active} onClick={() => onSelect(t.tranche)}
              style={{ background: active ? `linear-gradient(180deg, ${col}3d, ${col}14)` : `${col}12`, border: `0.5px solid ${active ? col : `${col}33`}`, color: active ? lightenColor(col, 0.4) : col, boxShadow: active ? `0 0 14px ${col}22` : "none" }}>
              {kindLabel(t.tranche)}
            </button>
          );
        })}
      </div>
      <div className="dbt-wf-cards">
        {tranches.map((t) => {
          const active = t.tranche === selected;
          const col = colorFor(t.tranche);
          const mt = metrics(t);
          return (
            <button key={t.tranche} type="button" onClick={() => onSelect(t.tranche)} className="dbt-wf-card" style={{ background: active ? `${col}10` : C.surface, borderColor: active ? `${col}60` : C.border }}>
              <span style={{ color: col }}>{kindLabel(t.tranche)}</span>
              <strong>{mt.mult.toFixed(2)}×</strong>
              <em>σ × {t.sigma_mult.toFixed(2)} width</em>
              <em style={{ color: mt.best >= mt.cost ? C.green : C.textMuted }}>${mt.best.toFixed(0)} best case</em>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buy / Sell panel (matches the PBU buy box): tranche tabs, amount + balance,
// fee breakdown (ask / MM spread / slippage / total → you receive), Buy + Sell
// buttons, "how it works". Buy mints the slice's strip; Sell redeems it.
// ---------------------------------------------------------------------------
function BuyPanel({ wallet, oracleId, selected, onSelect, tranches, isHybrid }: { wallet: ReturnType<typeof useWalletSigner>; oracleId?: string; selected: Kind; onSelect: (k: Kind) => void; tranches: TrancheProfile[]; isHybrid: boolean }) {
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState<TrancheProfile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [opErr, setOpErr] = useState<string | null>(null);

  const budgetNum = Number(amount);
  const valid = Number.isFinite(budgetNum) && budgetNum > 0;
  const accent = colorFor(selected);

  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!valid) return;
    if (timer.current) window.clearTimeout(timer.current);
    setLoading(true);
    timer.current = window.setTimeout(() => {
      trancheQuote({ asset: "BTC", oracle_id: oracleId, budget_usd: budgetNum, sender: wallet.address ?? undefined })
        .then((r) => setQuote(r.tranches)).catch(() => setQuote(null)).finally(() => setLoading(false));
    }, 250);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [budgetNum, valid, oracleId, wallet.address]);

  const live = (quote ?? tranches).find((t) => t.tranche === selected) ?? null;
  const m = live ? metrics(live) : null;
  const bid = live ? num(live.strip.total_redeem_value_raw) : 0;
  const tick = `PSL-${selected.slice(0, 3).toUpperCase()}`;

  async function submit() {
    if (!live || busy) return;
    setBusy(true); setOpErr(null); setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const buckets = openableBuckets(live.strip.buckets);
      if (buckets.length === 0) throw new Error("No tradeable bands in this slice right now.");
      let prep;
      if (side === "buy") {
        setStage("Building order…");
        const deposit = ((BigInt(live.strip.total_cost_raw) * 12n) / 10n).toString();
        prep = await prepareOpenStrip({ owner: wallet.address as string, manager_id: mgr, oracle_id: live.strip.oracle_id, expiry: live.strip.expiry, buckets, deposit_amount_raw: deposit });
      } else {
        setStage("Building redeem…");
        prep = await prepareRedeemStrip({ owner: wallet.address as string, manager_id: mgr, oracle_id: live.strip.oracle_id, expiry: live.strip.expiry, buckets });
      }
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult(c.digest);
    } catch (e) { setOpErr(friendlyWalletError(e)); }
    finally { setBusy(false); setStage(null); }
  }

  const tradeable = m?.live ?? 0;

  return (
    <div className="dbt-buy">
      <div>
        <div className="dbt-buy-eyebrow" style={{ color: accent }}>{side === "buy" ? "BUY" : "SELL"} {kindLabel(selected).toUpperCase()}</div>
        <div className="dbt-buy-title">{isHybrid ? "Hybrid · BTC core" : "BTC Risk Slice"}</div>
        <div className="dbt-buy-sub">
          <span>σ × {live?.sigma_mult.toFixed(2) ?? "—"} width</span>
          <span>Ask <b style={{ color: accent }}>{live ? usd(live.strip.total_cost_raw) : "—"}</b></span>
        </div>
      </div>

      {/* side toggle */}
      <div className="dbt-side">
        {(["buy", "sell"] as Side[]).map((s) => (
          <button key={s} type="button" className={side === s ? "is-active" : ""} data-side={s} onClick={() => setSide(s)}>{s === "buy" ? "Buy" : "Sell"}</button>
        ))}
      </div>

      {/* tranche tabs */}
      <div className="dbt-tabs">
        {ORDER.map((k) => {
          const active = k === selected; const col = colorFor(k);
          return <button key={k} type="button" aria-selected={active} className="dbt-tab" style={{ color: active ? col : C.textSecondary, background: active ? `${col}18` : "transparent", fontWeight: active ? 600 : 500 }} onClick={() => onSelect(k)}>{kindLabel(k)}</button>;
        })}
      </div>

      {/* amount */}
      <div className="dbt-amount">
        <div className="dbt-amount-head"><span>{side === "buy" ? "Amount" : "Position size"}</span><span>{wallet.connected ? "Balance — dUSDC" : "dUSDC"}</span></div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <input className="dbt-amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
          <span style={{ fontFamily: FM, fontSize: 11, color: C.textSecondary }}>dUSDC</span>
        </div>
      </div>

      {/* fee breakdown */}
      {valid && (
        <div className="dbt-fees">
          {side === "buy" ? (
            <>
              <FeeRow k="Ask (mint cost)" hint="live on-chain quote, incl. MM spread" v={live ? usd(live.strip.total_cost_raw) : "…"} />
              <FeeRow k="MM round-trip spread" hint="the maker's two-sided edge" v={m ? `$${m.spread.toFixed(2)}` : "…"} />
              <FeeRow k="Slippage" hint="size impact at this clip" v={m ? `$${m.slippage.toFixed(2)}` : "…"} />
              <div className="dbt-fee-total"><span>Best case</span><span>{m ? `$${m.best.toFixed(2)}` : "—"}</span></div>
              <div className="dbt-fee-recv"><span>You receive</span><span style={{ color: accent }}>{m ? `${m.units.toFixed(2)} ${tick}` : "—"}</span></div>
            </>
          ) : (
            <>
              <FeeRow k="Bid (redeem now)" hint="what the book pays to buy it back" v={live ? usd(live.strip.total_redeem_value_raw) : "…"} />
              <FeeRow k="vs ask" hint="round-trip cost of a flat exit" v={m && m.cost > 0 ? `${(((bid - m.cost) / m.cost) * 100).toFixed(1)}%` : "…"} />
              <div className="dbt-fee-recv"><span>You receive</span><span style={{ color: C.green }}>{live ? usd(live.strip.total_redeem_value_raw) : "—"} dUSDC</span></div>
            </>
          )}
        </div>
      )}

      {/* action */}
      {!wallet.connected ? (
        <ConnectModal trigger={<button className={`dbt-action ${side}`} style={{ cursor: "pointer" }}>Connect a wallet to {side}</button>} />
      ) : (
        <button className={`dbt-action ${side}`} disabled={busy || !live || tradeable === 0} onClick={submit}>
          {busy ? (stage ?? "Submitting…") : side === "buy" ? `Buy ${kindLabel(selected)}` : `Sell ${kindLabel(selected)}`}
        </button>
      )}
      {result && <ResultLine digest={result} label={`${side === "buy" ? "Opened" : "Redeemed"} ${kindLabel(selected)}`} />}
      {opErr && <div className="dbt-error" style={{ marginTop: 4 }}>{opErr}</div>}

      {/* how it works */}
      <div className="dbt-how">
        <Cap style={{ marginBottom: 12 }}>How it works</Cap>
        {[
          ["Buy in", "Pick a slice, enter dUSDC, and confirm. You mint the slice's range strip at the live on-chain price — MM spread and slippage already included."],
          ["Hold", "The strip tracks BTC against the forward over the tenor. You can redeem (sell) any time at the live bid, or hold to settlement."],
          ["Settle", isHybrid ? "At expiry the BTC core settles on Sui; the junior tail settles from the preselected Polymarket basket. Proceeds convert back to dUSDC." : "At settlement the winning band pays $1 per contract; your strip converts back to dUSDC for the bands that land in range."],
        ].map(([t, d], i) => (
          <div className="dbt-how-row" key={i}><span>{String(i + 1).padStart(2, "0")}</span><div><strong>{t}</strong><p>{d}</p></div></div>
        ))}
      </div>
    </div>
  );
}

function FeeRow({ k, hint, v }: { k: string; hint: string; v: string }) {
  return (
    <div className="dbt-fee-row">
      <div><span>{k}</span><em>{hint}</em></div>
      <strong>{v}</strong>
    </div>
  );
}

const DBT_CSS = `
  .dbt-back { display: inline-flex; gap: 8px; margin-bottom: 18px; color: ${C.textSecondary}; font-family: ${FS}; font-size: 13px; text-decoration: none; }
  .dbt-back:hover { color: ${C.textPrimary}; }
  .dbt-hero { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; margin-bottom: 22px; }
  .dbt-tag { display: inline-flex; align-items: center; gap: 8px; font-family: ${FM}; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; }
  .dbt-tag i { width: 7px; height: 7px; border-radius: 50%; }
  .dbt-hero h1 { margin: 10px 0 0; font-family: ${FD}; font-size: 30px; font-weight: 700; letter-spacing: -0.01em; color: ${C.textPrimary}; }
  .dbt-hero h1 span { color: ${C.textMuted}; font-weight: 300; }
  .dbt-meta { display: flex; flex-wrap: wrap; gap: 16px; row-gap: 4px; margin-top: 8px; font-family: ${FS}; font-size: 13px; color: ${C.textSecondary}; }
  .dbt-meta b { color: ${C.textPrimary}; font-weight: 500; }
  .dbt-hero-right { text-align: right; display: grid; gap: 2px; }
  .dbt-hero-right > span { font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.textMuted}; margin-bottom: 4px; }
  .dbt-hero-right strong { font-family: ${FD}; font-size: 44px; font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
  .dbt-hero-right em { font-family: ${FM}; font-size: 12px; font-style: normal; color: ${C.textMuted}; margin-top: 5px; }
  .dbt-error { border: 0.5px solid ${C.red}55; background: ${C.redBg}; border-radius: 10px; padding: 12px 14px; font-family: ${FM}; font-size: 12px; color: ${C.red}; line-height: 1.5; }
  .dbt-grid { display: grid; grid-template-columns: minmax(0, 1fr) 372px; gap: 18px; align-items: start; }
  @media (max-width: 940px) { .dbt-grid { grid-template-columns: 1fr; } }
  .dbt-left { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .dbt-card { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 16px 18px; min-width: 0; }
  .dbt-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  .dbt-mono-dim { font-family: ${FM}; font-size: 10.5px; color: ${C.textMuted}; }
  .dbt-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  @media (max-width: 620px) { .dbt-tiles { grid-template-columns: repeat(2, 1fr); } }
  .dbt-segbar { display: grid; gap: 4px; margin-bottom: 14px; }
  .dbt-segbar button { height: 44px; border-radius: 8px; font-family: ${FD}; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; transition: all 0.15s ${EASE}; min-width: 0; overflow: hidden; }
  .dbt-wf-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .dbt-wf-card { display: grid; gap: 4px; text-align: left; border: 0.5px solid ${C.border}; border-radius: 10px; padding: 11px 12px; cursor: pointer; transition: all 0.15s ${EASE}; }
  .dbt-wf-card span { font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; }
  .dbt-wf-card strong { font-family: ${FD}; font-size: 19px; font-weight: 600; color: ${C.textPrimary}; letter-spacing: -0.01em; }
  .dbt-wf-card em { font-family: ${FM}; font-size: 10px; font-style: normal; color: ${C.textMuted}; }
  .dbt-hyb-leg { display: block; border: 0.5px solid ${C.violet}55; background: ${C.panelGradient}; border-radius: 14px; padding: 16px 18px; text-decoration: none; transition: border-color 0.15s ${EASE}; }
  .dbt-hyb-leg:hover { border-color: ${C.violet}; }
  .dbt-hyb-title { font-family: ${FD}; font-size: 16px; font-weight: 600; color: ${C.textPrimary}; }
  .dbt-hyb-leg p { margin: 6px 0 0; font-family: ${FS}; font-size: 12.5px; color: ${C.textSecondary}; line-height: 1.55; max-width: 640px; }

  .dbt-buy { display: flex; flex-direction: column; gap: 14px; border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 18px; position: sticky; top: 88px; }
  .dbt-buy-eyebrow { font-family: ${FM}; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 500; margin-bottom: 6px; }
  .dbt-buy-title { font-family: ${FD}; font-size: 19px; font-weight: 600; color: ${C.textPrimary}; }
  .dbt-buy-sub { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; font-family: ${FS}; font-size: 12px; color: ${C.textSecondary}; }
  .dbt-buy-sub b { font-weight: 500; }
  .dbt-side { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 4px; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 11px; }
  .dbt-side button { height: 36px; border: none; border-radius: 8px; background: transparent; color: ${C.textSecondary}; font-family: ${FD}; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.14s ${EASE}; }
  .dbt-side button[data-side="buy"].is-active { background: ${C.green}1f; color: ${C.green}; }
  .dbt-side button[data-side="sell"].is-active { background: ${C.red}1f; color: ${C.red}; }
  .dbt-tabs { display: flex; padding: 3px; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 10px; }
  .dbt-tab { flex: 1; padding: 8px 0; border: none; border-radius: 8px; background: transparent; font-family: ${FD}; font-size: 11.5px; letter-spacing: 0.03em; text-transform: capitalize; cursor: pointer; transition: all 0.14s ${EASE}; }
  .dbt-amount { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 12px; padding: 12px 14px; display: grid; gap: 9px; }
  .dbt-amount-head { display: flex; justify-content: space-between; font-family: ${FM}; font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: ${C.textMuted}; }
  .dbt-amount-input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: ${C.textPrimary}; font-family: ${FD}; font-size: 22px; font-weight: 400; letter-spacing: -0.01em; padding: 0; }
  .dbt-fees { display: grid; gap: 7px; padding: 12px 14px; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 12px; }
  .dbt-fee-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .dbt-fee-row div { min-width: 0; }
  .dbt-fee-row span { font-family: ${FM}; font-size: 11px; color: ${C.textSecondary}; }
  .dbt-fee-row em { display: block; font-family: ${FS}; font-size: 10px; font-style: normal; color: ${C.textMuted}; margin-top: 1px; line-height: 1.35; }
  .dbt-fee-row strong { font-family: ${FM}; font-size: 11.5px; color: ${C.textPrimary}; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .dbt-fee-total { display: flex; justify-content: space-between; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; padding-top: 6px; border-top: 0.5px solid ${C.border}; }
  .dbt-fee-recv { display: flex; justify-content: space-between; font-family: ${FM}; font-size: 11.5px; color: ${C.textSecondary}; font-weight: 500; }
  .dbt-fee-recv span:last-child { font-weight: 600; }
  .dbt-action { width: 100%; height: 46px; border: none; border-radius: 12px; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.14s ${EASE}, transform 0.14s ${EASE}; color: #04121d; }
  .dbt-action.buy { background: ${C.green}; }
  .dbt-action.sell { background: ${C.red}; color: #1a0606; }
  .dbt-action:hover:not(:disabled) { transform: translateY(-1px); }
  .dbt-action:disabled { opacity: 0.5; cursor: not-allowed; }
  .dbt-how { padding-top: 14px; border-top: 0.5px solid ${C.border}; }
  .dbt-how-row { display: grid; grid-template-columns: 24px 1fr; gap: 10px; margin-bottom: 12px; }
  .dbt-how-row > span { font-family: ${FM}; font-size: 11px; color: ${C.tealLight}; opacity: 0.7; }
  .dbt-how-row strong { font-family: ${FD}; font-size: 13px; font-weight: 600; color: ${C.textPrimary}; }
  .dbt-how-row p { margin: 4px 0 0; font-family: ${FS}; font-size: 11.5px; color: ${C.textMuted}; line-height: 1.5; }
`;
