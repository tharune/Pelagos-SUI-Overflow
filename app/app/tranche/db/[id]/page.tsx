"use client";

// ---------------------------------------------------------------------------
// DeepBook tranche detail — one screen per BTC Risk Slice (and the cross-venue
// Hybrid). The whole oracle is one range strip; senior / mezz / junior are
// conviction-width slices of it. The page shows:
//   • the live SVI-implied distribution, with the selected slice's coverage shaded
//   • a Buy / Sell order panel (mint vs redeem) per tranche, priced live on-chain
//   • the underlying band positions that make up the selected slice
// Everything is wired to the real DeepBook Predict backend (devInspect pricing +
// non-custodial mint/redeem PTBs the wallet signs).
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Header, PageFrame } from "../../../_components/Header";
import { C, FD, FM, FS, EASE, trancheColor } from "../../../_lib/tokens";
import { friendlyWalletError } from "../../../_lib/chain";
import { useWalletSigner } from "../../../_lib/wallet-bridge";
import { ConnectModal } from "@mysten/dapp-kit";
import {
  BucketLadder,
  ResultLine,
  Cap,
  dollars,
  openableBuckets,
  StripStyles,
} from "../../../_components/strip-products";
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

export default function DeepBookTrancheDetail() {
  const params = useParams();
  const idRaw = (Array.isArray(params?.id) ? params?.id[0] : params?.id) ?? "";
  const isHybrid = idRaw.startsWith("hybrid");
  const bucket = isHybrid ? (idRaw.split("-")[1] ?? "short") : null;
  const wallet = useWalletSigner();

  // A real oracle id is "0x…". Hybrid vaults resolve their tenor's oracle from
  // the live BTC vol surface (short = soonest buffered, long = furthest).
  const [oracleId, setOracleId] = useState<string | undefined>(!isHybrid && idRaw.startsWith("0x") ? idRaw : undefined);
  const [resolved, setResolved] = useState<boolean>(!isHybrid);
  const [tranches, setTranches] = useState<TrancheProfile[] | null>(null);
  const [forward, setForward] = useState<number | null>(null);
  const [density, setDensity] = useState<ImpliedDensity | null>(null);
  const [selected, setSelected] = useState<Kind>("senior");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isHybrid) return;
    let alive = true;
    fetchVolSurface("BTC")
      .then((s) => {
        const Y = 31_557_600;
        const live = s.slices.filter((sl) => sl.t_years > 360 / Y).sort((a, b) => a.expiry - b.expiry);
        const pick = bucket === "long" ? live[live.length - 1] : bucket === "med" ? live[Math.floor(live.length / 2)] : live[0];
        if (alive) { setOracleId(pick?.oracle_id); setResolved(true); }
      })
      .catch(() => { if (alive) setResolved(true); });
    return () => { alive = false; };
  }, [isHybrid, bucket]);

  // Load the slice quote (all three tranches) at a $100 reference, then the
  // implied density for the SAME oracle so the chart + slices line up.
  useEffect(() => {
    if (!resolved) return;
    let alive = true;
    setErr(null);
    trancheQuote({ asset: "BTC", oracle_id: oracleId, budget_usd: 100 })
      .then(async (q) => {
        if (!alive) return;
        setTranches(q.tranches);
        setForward(q.forward_usd);
        const d = await fetchDensity(q.oracle_id).catch(() => null);
        if (alive) setDensity(d);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [resolved, oracleId]);

  const sorted = useMemo(
    () => (tranches ? ORDER.map((k) => tranches.find((t) => t.tranche === k)).filter((t): t is TrancheProfile => Boolean(t)) : []),
    [tranches],
  );
  const sel = sorted.find((t) => t.tranche === selected) ?? sorted[0] ?? null;

  return (
    <>
      <Header />
      <PageFrame wide>
        <Link href="/app/tranche" className="dbt-back">← Back to Risk Slices</Link>

        {/* Hero */}
        <div className="dbt-hero">
          <div style={{ minWidth: 0 }}>
            <div className="dbt-eyebrow" style={{ color: isHybrid ? C.violet : C.teal }}>
              {isHybrid ? `DeepBook × Polymarket · Hybrid${bucket ? ` · ${HY_LABEL[bucket] ?? ""}` : ""}` : "DeepBook Predict · Risk Slice"}
            </div>
            <h1>{isHybrid ? `Hybrid Vault${bucket ? ` · ${HY_LABEL[bucket] ?? ""}` : ""}` : "BTC Risk Slice"}</h1>
            <p>
              {isHybrid
                ? "One waterfall over two venues. The senior core leans on a live BTC range strip; the junior tail reaches into a Polymarket event basket. Trade the BTC core below, then add the event tail."
                : "One live BTC range strip, sliced by conviction width. Buy a slice to mint it, sell to redeem — priced live on-chain, settled on Sui."}
            </p>
          </div>
          {sel && forward != null && (
            <div className="dbt-hero-right">
              <span className="dbt-eyebrow" style={{ color: C.textMuted }}>{kindLabel(sel.tranche)} slice</span>
              <strong style={{ color: colorFor(sel.tranche) }}>{multipleOf(sel)}×</strong>
              <em>best case {usd(sel.strip.realized_max_payout_raw)} · forward {dollars(forward)}</em>
            </div>
          )}
        </div>

        {err && <div className="dbt-error">{err}</div>}

        {/* Main grid */}
        <div className="dbt-grid">
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

            {/* Tranche selector */}
            <div className="dbt-tranche-row">
              {sorted.map((t) => {
                const active = t.tranche === selected;
                const col = colorFor(t.tranche);
                return (
                  <button
                    key={t.tranche}
                    type="button"
                    className={`dbt-tranche${active ? " is-active" : ""}`}
                    style={active ? { borderColor: `${col}88`, background: `${col}12` } : undefined}
                    onClick={() => setSelected(t.tranche)}
                  >
                    <span style={{ color: col }}>{kindLabel(t.tranche)}</span>
                    <strong>{multipleOf(t)}×</strong>
                    <em>{tradeableOf(t)} bands live</em>
                  </button>
                );
              })}
              {sorted.length === 0 && <CardSkeleton />}
            </div>

            {/* Underlying positions */}
            <div className="dbt-card">
              <div className="dbt-card-head">
                <Cap>Underlying band positions · {kindLabel(sel?.tranche ?? "senior")}</Cap>
                <span className="dbt-mono-dim">{sel ? `${sel.strip.buckets.length} bands` : "—"}</span>
              </div>
              {sel ? <BucketLadder quote={sel.strip} /> : <div className="dbt-ladder-empty">Loading the live book…</div>}
            </div>

            {isHybrid && (
              <Link href="/app/basket" className="dbt-hyb-leg">
                <div className="dbt-eyebrow" style={{ color: C.violet }}>Leg 2 · Polymarket event tail</div>
                <div className="dbt-hyb-title">Add an uncorrelated event basket →</div>
                <p>The junior tail is funded from Polymarket&apos;s CLOB-priced event baskets, settled on Pelagos&apos;s own vault.</p>
              </Link>
            )}
          </div>

          {/* Trade panel */}
          <TradePanel wallet={wallet} oracleId={oracleId} selected={selected} onSelect={setSelected} tranches={sorted} />
        </div>
      </PageFrame>
      <StripStyles />
      <style jsx global>{DBT_CSS}</style>
    </>
  );
}

function multipleOf(t: TrancheProfile): string {
  const cost = Number(t.strip.total_cost_raw) / 1e6;
  const best = Number(t.strip.realized_max_payout_raw) / 1e6;
  return cost > 0 ? (best / cost).toFixed(2) : "—";
}
function tradeableOf(t: TrancheProfile): string {
  const live = t.strip.buckets.filter((b) => b.tradeable).length;
  return `${live}/${t.strip.buckets.length}`;
}

// ---------------------------------------------------------------------------
// Outcome-distribution chart — same look as the High/Mid event-tranche detail:
// a moment-matched Normal over μ±3σ (fills the frame), the selected slice's
// coverage shaded full-height with a vertical gradient, the forward marked, and
// the slice boundaries called out on the axis.
// ---------------------------------------------------------------------------
function DensityChart({
  density,
  tranches,
  selected,
  forward,
}: {
  density: ImpliedDensity | null;
  tranches: TrancheProfile[];
  selected: Kind;
  forward: number | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(680);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(280, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // μ = forward; σ = ATM implied move ($). Fall back to the selected slice's
  // own band half-width when the density feed is missing.
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

  const H = 260, PT = 22, PB = 26, PL = 10, PR = 10;
  const frame = useMemo(() => {
    if (mu == null || !(sigma > 0)) return null;
    const lo = mu - 3 * sigma, hi = mu + 3 * sigma, span = hi - lo || 1;
    const N = 240;
    const norm = (x: number) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    const sx = (v: number) => PL + ((Math.max(lo, Math.min(hi, v)) - lo) / span) * (w - PL - PR);
    const sy = (d: number) => PT + (1 - d) * (H - PT - PB);
    const pts: Array<{ x: number; y: number; v: number }> = [];
    for (let i = 0; i <= N; i++) {
      const v = lo + (span * i) / N;
      pts.push({ x: sx(v), y: sy(norm(v)), v });
    }
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

          {/* full distribution wash + the selected slice's coverage highlighted */}
          <path d={frame.sliceArea(frame.lo, frame.hi)} fill="url(#dbt-grad-all)" />
          {selBand && <path d={frame.sliceArea(Math.max(frame.lo, selBand[0]), Math.min(frame.hi, selBand[1]))} fill="url(#dbt-grad-sel)" />}

          {/* density line */}
          <path d={frame.line} fill="none" stroke={C.textPrimary} strokeWidth="1.5" strokeOpacity="0.82" strokeLinejoin="round" strokeLinecap="round" />

          {/* slice boundary guides */}
          {selBand && [selBand[0], selBand[1]].map((b, i) => (
            b >= frame.lo && b <= frame.hi ? (
              <line key={i} x1={frame.sx(b)} x2={frame.sx(b)} y1={PT} y2={frame.base} stroke={selColor} strokeWidth="1" strokeDasharray="3 3" opacity={0.55} />
            ) : null
          ))}

          {/* forward marker */}
          {mu >= frame.lo && mu <= frame.hi && (
            <g>
              <line x1={frame.sx(mu)} x2={frame.sx(mu)} y1={PT - 8} y2={frame.base} stroke={C.tealLight} strokeWidth="1.4" opacity={0.9} />
              <text x={frame.sx(mu)} y={PT - 11} textAnchor="middle" fontFamily={FM} fontSize="10" fill={C.tealLight} fontWeight={500}>
                Forward {dollars(mu)}
              </text>
            </g>
          )}

          {/* x ticks: lo / slice edges / hi */}
          {(() => {
            const raw: Array<{ v: number; sel?: boolean }> = [{ v: frame.lo }, { v: frame.hi }];
            if (selBand) { raw.push({ v: selBand[0], sel: true }, { v: selBand[1], sel: true }); }
            const eps = frame.span * 0.02;
            const ticks: typeof raw = [];
            for (const t of raw.sort((a, b) => a.v - b.v)) if (!ticks.some((x) => Math.abs(x.v - t.v) < eps)) ticks.push(t);
            return ticks.map((t, i) => (
              <text key={i} x={frame.sx(t.v)} y={H - 8} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"} fontFamily={FM} fontSize="9.5" fill={t.sel ? selColor : C.textMuted} opacity={t.sel ? 0.95 : 0.8}>
                {dollars(t.v)}
              </text>
            ));
          })()}
        </svg>
      ) : (
        <div style={{ height: H, display: "grid", placeItems: "center", fontFamily: FM, fontSize: 12, color: C.textMuted }}>
          Loading the implied distribution…
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buy / Sell order panel — mint (buy) or redeem (sell) the selected tranche,
// priced live on-chain at the entered size.
// ---------------------------------------------------------------------------
function TradePanel({
  wallet,
  oracleId,
  selected,
  onSelect,
  tranches,
}: {
  wallet: ReturnType<typeof useWalletSigner>;
  oracleId?: string;
  selected: Kind;
  onSelect: (k: Kind) => void;
  tranches: TrancheProfile[];
}) {
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

  // Re-price the slice at the entered size (debounced).
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!valid) return;
    if (timer.current) window.clearTimeout(timer.current);
    setLoading(true);
    timer.current = window.setTimeout(() => {
      trancheQuote({ asset: "BTC", oracle_id: oracleId, budget_usd: budgetNum, sender: wallet.address ?? undefined })
        .then((r) => setQuote(r.tranches))
        .catch(() => setQuote(null))
        .finally(() => setLoading(false));
    }, 250);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [budgetNum, valid, oracleId, wallet.address]);

  const live = (quote ?? tranches).find((t) => t.tranche === selected) ?? null;
  const cost = live ? Number(live.strip.total_cost_raw) / 1e6 : 0;
  const bid = live ? Number(live.strip.total_redeem_value_raw) / 1e6 : 0;
  const best = live ? Number(live.strip.realized_max_payout_raw) / 1e6 : 0;
  const spread = live ? Number(live.strip.round_trip_spread_raw) / 1e6 : 0;
  const tradeable = live ? live.strip.buckets.filter((b) => b.tradeable).length : 0;

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
        prep = await prepareOpenStrip({
          owner: wallet.address as string, manager_id: mgr,
          oracle_id: live.strip.oracle_id, expiry: live.strip.expiry, buckets, deposit_amount_raw: deposit,
        });
      } else {
        setStage("Building redeem…");
        prep = await prepareRedeemStrip({
          owner: wallet.address as string, manager_id: mgr,
          oracle_id: live.strip.oracle_id, expiry: live.strip.expiry, buckets,
        });
      }
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult(c.digest);
    } catch (e) {
      setOpErr(friendlyWalletError(e));
    } finally {
      setBusy(false); setStage(null);
    }
  }

  return (
    <div className="dbt-card dbt-trade">
      {/* Buy / Sell side toggle */}
      <div className="dbt-side">
        {(["buy", "sell"] as Side[]).map((s) => (
          <button key={s} type="button" className={`dbt-side-btn${side === s ? " is-active" : ""}`} data-side={s} onClick={() => setSide(s)}>
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      {/* Tranche tabs */}
      <div className="dbt-tabs">
        {ORDER.map((k) => {
          const active = k === selected;
          const col = colorFor(k);
          return (
            <button key={k} type="button" className="dbt-tab" aria-selected={active}
              style={{ color: active ? col : C.textSecondary, background: active ? `${col}18` : "transparent", fontWeight: active ? 600 : 500 }}
              onClick={() => onSelect(k)}>
              {kindLabel(k)}
            </button>
          );
        })}
      </div>

      {/* Amount */}
      <div className="dbt-amount">
        <div className="dbt-amount-head">
          <span>{side === "buy" ? "Budget" : "Position size"}</span>
          <span className="dbt-mono-dim">dUSDC</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <input className="dbt-amount-input" inputMode="decimal" value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
          <span style={{ fontFamily: FM, fontSize: 11, color: C.textSecondary }}>dUSDC</span>
        </div>
      </div>

      {/* Quote breakdown */}
      <div className="dbt-quote">
        {side === "buy" ? (
          <>
            <QRow k="Ask (mint)" v={live ? usd(live.strip.total_cost_raw) : loading ? "…" : "—"} />
            <QRow k="Best-case payout" v={best > 0 ? `$${best.toFixed(2)}` : "—"} color={accent} />
            <QRow k="Max multiple" v={cost > 0 ? `${(best / cost).toFixed(2)}×` : "—"} />
            <QRow k="Round-trip spread" v={spread > 0 ? `$${spread.toFixed(2)}` : "—"} color={C.amber} />
          </>
        ) : (
          <>
            <QRow k="Bid (redeem now)" v={live ? usd(live.strip.total_redeem_value_raw) : loading ? "…" : "—"} color={C.green} />
            <QRow k="vs ask" v={cost > 0 ? `${(((bid - cost) / cost) * 100).toFixed(1)}%` : "—"} />
            <QRow k="Round-trip spread" v={spread > 0 ? `$${spread.toFixed(2)}` : "—"} color={C.amber} />
          </>
        )}
        <QRow k="Bands" v={live ? `${tradeable} / ${live.strip.buckets.length} tradeable` : "—"} />
      </div>

      {/* Action */}
      <div style={{ marginTop: "auto" }}>
        {!wallet.connected ? (
          <ConnectModal trigger={<button className={`dbt-action ${side}`} style={{ cursor: "pointer" }}>Connect a wallet to {side}</button>} />
        ) : (
          <button className={`dbt-action ${side}`} disabled={busy || !live || tradeable === 0} onClick={submit}>
            {busy ? (stage ?? "Submitting…") : side === "buy"
              ? `Buy ${kindLabel(selected)} · ${live ? usd(live.strip.total_cost_raw) : ""}`
              : `Sell ${kindLabel(selected)} · ${live ? usd(live.strip.total_redeem_value_raw) : ""}`}
          </button>
        )}
        {side === "sell" && (
          <p className="dbt-sell-note">Selling redeems the slice&apos;s bands back to dUSDC. You can only sell a slice you hold.</p>
        )}
        {result && <ResultLine digest={result} label={`${side === "buy" ? "Opened" : "Redeemed"} ${kindLabel(selected)}`} />}
        {opErr && <div className="dbt-error" style={{ marginTop: 12 }}>{opErr}</div>}
      </div>
    </div>
  );
}

function QRow({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="dbt-qrow">
      <span>{k}</span>
      <strong style={color ? { color } : undefined}>{v}</strong>
    </div>
  );
}

function CardSkeleton() {
  return <div className="dbt-tranche" style={{ opacity: 0.4, pointerEvents: "none" }}><span>—</span><strong>—</strong><em>pricing…</em></div>;
}

const DBT_CSS = `
  .dbt-back { display: inline-flex; gap: 8px; margin-bottom: 18px; color: ${C.textSecondary}; font-family: ${FS}; font-size: 13px; text-decoration: none; }
  .dbt-back:hover { color: ${C.textPrimary}; }
  .dbt-eyebrow { font-family: ${FM}; font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 10px; }
  .dbt-hero { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; margin-bottom: 22px; }
  .dbt-hero h1 { margin: 0; font-family: ${FD}; font-size: 32px; font-weight: 600; letter-spacing: -0.03em; color: ${C.textPrimary}; }
  .dbt-hero p { margin: 10px 0 0; max-width: 620px; font-family: ${FS}; font-size: 13.5px; line-height: 1.6; color: ${C.textSecondary}; }
  .dbt-hero-right { text-align: right; display: grid; gap: 2px; }
  .dbt-hero-right strong { font-family: ${FD}; font-size: 40px; font-weight: 600; line-height: 1; letter-spacing: -0.02em; }
  .dbt-hero-right em { font-family: ${FM}; font-size: 11px; font-style: normal; color: ${C.textMuted}; margin-top: 6px; }
  .dbt-error { border: 0.5px solid ${C.red}55; background: ${C.redBg}; border-radius: 10px; padding: 12px 14px; font-family: ${FM}; font-size: 12px; color: ${C.red}; line-height: 1.5; }
  .dbt-grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
  @media (max-width: 920px) { .dbt-grid { grid-template-columns: 1fr; } }
  .dbt-left { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .dbt-card { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 16px 18px; min-width: 0; }
  .dbt-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .dbt-mono-dim { font-family: ${FM}; font-size: 10.5px; color: ${C.textMuted}; }
  .dbt-tranche-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .dbt-tranche { display: grid; gap: 3px; text-align: left; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 10px; padding: 12px 13px; cursor: pointer; transition: border-color 0.14s ${EASE}, background 0.14s ${EASE}, transform 0.14s ${EASE}; }
  .dbt-tranche:hover { transform: translateY(-1px); border-color: ${C.borderHover}; }
  .dbt-tranche span { font-family: ${FM}; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 560; }
  .dbt-tranche strong { font-family: ${FD}; font-size: 19px; font-weight: 600; color: ${C.textPrimary}; letter-spacing: -0.01em; }
  .dbt-tranche em { font-family: ${FM}; font-size: 10px; font-style: normal; color: ${C.textMuted}; }
  .dbt-ladder-empty { height: 160px; display: grid; place-items: center; font-family: ${FM}; font-size: 12px; color: ${C.textMuted}; }
  .dbt-hyb-leg { display: block; border: 0.5px solid ${C.violet}55; background: ${C.panelGradient}; border-radius: 14px; padding: 16px 18px; text-decoration: none; transition: border-color 0.15s ${EASE}; }
  .dbt-hyb-leg:hover { border-color: ${C.violet}; }
  .dbt-hyb-title { font-family: ${FD}; font-size: 16px; font-weight: 600; color: ${C.textPrimary}; margin-top: 4px; }
  .dbt-hyb-leg p { margin: 6px 0 0; font-family: ${FS}; font-size: 12.5px; color: ${C.textSecondary}; line-height: 1.55; max-width: 620px; }

  .dbt-trade { display: flex; flex-direction: column; gap: 14px; position: sticky; top: 88px; }
  .dbt-side { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 4px; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 11px; }
  .dbt-side-btn { height: 38px; border: none; border-radius: 8px; background: transparent; color: ${C.textSecondary}; font-family: ${FD}; font-size: 13.5px; font-weight: 600; cursor: pointer; transition: all 0.14s ${EASE}; }
  .dbt-side-btn[data-side="buy"].is-active { background: ${C.green}1f; color: ${C.green}; }
  .dbt-side-btn[data-side="sell"].is-active { background: ${C.red}1f; color: ${C.red}; }
  .dbt-tabs { display: flex; padding: 3px; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 10px; }
  .dbt-tab { flex: 1; padding: 8px 0; border: none; border-radius: 8px; background: transparent; font-family: ${FD}; font-size: 11.5px; letter-spacing: 0.03em; text-transform: capitalize; cursor: pointer; transition: all 0.14s ${EASE}; }
  .dbt-amount { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 12px; padding: 12px 14px; display: grid; gap: 9px; }
  .dbt-amount-head { display: flex; justify-content: space-between; font-family: ${FM}; font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: ${C.textMuted}; }
  .dbt-amount-input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: ${C.textPrimary}; font-family: ${FD}; font-size: 22px; font-weight: 400; letter-spacing: -0.01em; padding: 0; }
  .dbt-quote { display: grid; gap: 10px; padding: 14px; border: 0.5px solid ${C.border}; border-radius: 12px; }
  .dbt-qrow { display: flex; justify-content: space-between; align-items: baseline; }
  .dbt-qrow span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }
  .dbt-qrow strong { font-family: ${FD}; font-size: 13px; font-weight: 560; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .dbt-action { width: 100%; border: none; border-radius: 11px; padding: 14px; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.14s ${EASE}; color: #04121d; }
  .dbt-action.buy { background: ${C.green}; }
  .dbt-action.sell { background: ${C.red}; color: #1a0606; }
  .dbt-action:disabled { opacity: 0.5; cursor: not-allowed; }
  .dbt-sell-note { margin: 10px 0 0; font-family: ${FS}; font-size: 11px; color: ${C.textMuted}; line-height: 1.5; }
`;
