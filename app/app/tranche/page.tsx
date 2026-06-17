"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Header, PageFrame } from "../_components/Header";
import { C, FS, FD, FM, EASE, trancheColor, tc, tl } from "../_lib/tokens";
import { BUNDLES } from "../_lib/bundles";
import { useLiveBaskets, formatYieldPct } from "../_lib/use-live-baskets";
import { computeBasketStats, quoteTranchesFromStats, type TrancheQuote } from "./_quote";
import type { LiveBasket } from "../_lib/live-baskets";
import { trancheQuote, fetchVolSurface, type TrancheProfile } from "../_lib/predict-strip-client";

const TIER_LABEL: Record<90 | 70 | 50, string> = {
  90: "High probability",
  70: "Mid probability",
  50: "Low probability",
};
type HyBucket = "short" | "med" | "long";
const HY_BUCKETS: HyBucket[] = ["short", "med", "long"];
const HY_LABEL: Record<HyBucket, string> = { short: "Short", med: "Medium", long: "Long" };

const TIER_BODY: Record<90 | 70 | 50, string> = {
  90: "High-probability baskets where the senior slice does most of the work.",
  70: "Balanced baskets with visible mezzanine and junior pricing.",
  50: "Long-shot baskets where the junior tail carries the upside.",
};

export default function TranchesPage() {
  const router = useRouter();
  const state = useLiveBaskets();

  const groups = useMemo(() => {
    const empty: Record<90 | 70 | 50, LiveBasket[]> = { 90: [], 70: [], 50: [] };
    const baskets =
      state.status === "ok" && state.baskets.length > 0
        ? state.baskets
        : BUNDLES.map((b) => ({
            ...b,
            live: true as const,
            window: (tl(b.daysLeft) === "This week" ? "week" : tl(b.daysLeft) === "This month" ? "month" : "long") as "week" | "month" | "long",
            markets: [],
          }) as unknown as LiveBasket);
    for (const b of baskets) empty[b.tier].push(b);
    const winOrder: Record<"week" | "month" | "long", number> = { week: 0, month: 1, long: 2 };
    for (const t of [90, 70, 50] as const) empty[t].sort((a, b) => winOrder[a.window] - winOrder[b.window]);
    return empty;
  }, [state]);

  // Three cross-venue hybrid vaults — short / medium / long — each pairing a
  // DeepBook BTC tenor with an event-basket tail of matching horizon.
  const hybridBaskets = useMemo(() => {
    const list = (state.status === "ok" && state.baskets.length > 0 ? state.baskets : (BUNDLES as unknown as LiveBasket[]));
    const sorted = [...list].sort((a, b) => a.daysLeft - b.daysLeft);
    const at = (i: number) => sorted[Math.max(0, Math.min(sorted.length - 1, i))] ?? null;
    return { short: at(0), med: at(Math.floor(sorted.length / 2)), long: at(sorted.length - 1) };
  }, [state]);

  const [hyTenors, setHyTenors] = useState<Record<HyBucket, { oracleId: string; tenor: string } | null>>({ short: null, med: null, long: null });
  useEffect(() => {
    let alive = true;
    fetchVolSurface("BTC")
      .then((s) => {
        const Y = 31_557_600;
        const live = s.slices.filter((sl) => sl.t_years > 360 / Y).sort((a, b) => a.expiry - b.expiry);
        if (!alive || live.length === 0) return;
        const at = (i: number) => ({ oracleId: live[i].oracle_id, tenor: live[i].tenor_label });
        setHyTenors({ short: at(0), med: at(Math.floor(live.length / 2)), long: at(live.length - 1) });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <>
      <Header />
      <PageFrame wide>
        <style>{RISK_CSS}</style>
        <div className="risk-shell">
          <section className="risk-hero">
            <div>
              <h1>Risk Slices</h1>
              <p>
                Senior, mezzanine, and junior tranches across two venues: DeepBook&apos;s live BTC range strips and Polymarket&apos;s
                event-CLOB baskets. Pick a slice; set your size and open it inside each market.
              </p>
            </div>
          </section>

          <div className="risk-stack">
            {/* ── DeepBook · BTC ── */}
            <section className="risk-tier risk-tier--lead">
              <header className="risk-tier-head">
                <div>
                  <span style={{ color: C.tealLight }}>DeepBook · BTC</span>
                  <p>One live BTC range strip, sliced by conviction width. Senior covers wide for a high hit-rate and a steady multiple; junior pins the forward for the biggest payout. Sized off the oracle&apos;s own implied move.</p>
                </div>
                <strong>senior · mezz · junior</strong>
              </header>
              <DeepBookTranches onOpen={(oid) => router.push(`/app/tranche/db/${oid}`)} />
            </section>

            {/* ── Hybrid · cross-venue vaults ── */}
            <section className="risk-tier">
              <header className="risk-tier-head">
                <div>
                  <span style={{ color: C.violet }}>Hybrid · cross-venue vaults</span>
                  <p>One waterfall over two venues: a DeepBook BTC strip + a Polymarket event tail. Senior leans on the BTC core; junior takes the event tail. Pick a horizon.</p>
                </div>
                <strong>3 vaults</strong>
              </header>
              <div className="risk-grid">
                {HY_BUCKETS.map((bk) => {
                  const t = hyTenors[bk];
                  const basket = hybridBaskets[bk];
                  return t && basket ? (
                    <HybridTrancheCard key={bk} bucket={bk} oracleId={t.oracleId} tenor={t.tenor} basket={basket} onClick={() => router.push(`/app/tranche/db/hybrid-${bk}`)} />
                  ) : (
                    <CardSkeleton key={bk} count={1} />
                  );
                })}
              </div>
            </section>

            {/* ── Polymarket event tiers ── */}
            {state.status === "loading" && <CardSkeleton count={3} />}
            {state.status === "error" && <EmptyState title="Could not load event baskets" subtitle={state.error} />}
            {([90, 50] as const).map((tier) => {
              const baskets = groups[tier];
              if (baskets.length === 0) return null;
              return (
                <section className="risk-tier" key={tier}>
                  <header className="risk-tier-head">
                    <div>
                      <span style={{ color: tc(tier) }}>{TIER_LABEL[tier]}</span>
                      <p>{TIER_BODY[tier]}</p>
                    </div>
                    <strong>{baskets.length} baskets</strong>
                  </header>
                  <div className="risk-grid">
                    {baskets.map((basket) => (
                      <BasketTrancheCard key={basket.id} basket={basket} onClick={() => router.push(`/app/tranche/${basket.id}`)} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </PageFrame>
    </>
  );
}

// ── DeepBook tranches: one card per slice (senior / mezz / junior) ──
// Priced on the soonest active BTC oracle, whose bands reliably sit inside the
// protocol's mintable [2%,98%] band — so all three slices quote real fills.
const DB_ORDER: TrancheProfile["tranche"][] = ["senior", "mezz", "junior"];

function DeepBookTranches({ onOpen }: { onOpen: (oracleId: string) => void }) {
  const [data, setData] = useState<{ tranches: TrancheProfile[]; oracleId: string; forward: number; tenor: string } | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([trancheQuote({ asset: "BTC", budget_usd: 100 }), fetchVolSurface("BTC")])
      .then(([q, s]) => {
        if (!alive) return;
        const slice = s.slices.find((sl) => sl.oracle_id === q.oracle_id);
        setData({ tranches: q.tranches, oracleId: q.oracle_id, forward: q.forward_usd, tenor: slice?.tenor_label ?? "front" });
      })
      .catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, []);

  if (!data) return <div className="risk-grid"><CardSkeleton count={3} /></div>;

  const sorted = DB_ORDER.map((k) => data.tranches.find((t) => t.tranche === k)).filter((t): t is TrancheProfile => Boolean(t));

  return (
    <div className="risk-grid">
      {sorted.map((t) => (
        <TrancheStratCard key={t.tranche} t={t} forward={data.forward} tenor={data.tenor} onClick={() => onOpen(data.oracleId)} />
      ))}
    </div>
  );
}

function TrancheStratCard({ t, forward, tenor, onClick }: { t: TrancheProfile; forward: number; tenor: string; onClick: () => void }) {
  const kind = t.tranche === "mezz" ? "mezzanine" : t.tranche;
  const col = trancheColor(kind);
  const cost = Number(t.strip.total_cost_raw) / 1e6;
  // Honest best case = the largest single band settling (only one band can win).
  const maxPay = Number(t.strip.realized_max_payout_raw) / 1e6;
  const spread = Number(t.strip.round_trip_spread_raw) / 1e6;
  const mult = cost > 0 ? maxPay / cost : 0;
  const live = t.strip.buckets.filter((b) => b.tradeable).length;
  const total = t.strip.buckets.length;
  // Band coverage scales with σ-multiple — senior covers wide, junior pins ATM.
  const cover = Math.min(92, 18 + t.sigma_mult * 26);

  return (
    <button className="risk-card" type="button" onClick={onClick}>
      <div className="risk-card-head">
        <div>
          <div className="risk-card-title">
            <i style={{ background: col }} />
            <strong style={{ textTransform: "capitalize" }}>{kind}</strong>
          </div>
          <div className="risk-meta">
            <span>BTC · {tenor}</span>
            <span>σ × {t.sigma_mult.toFixed(2)}</span>
            <span style={{ color: `${C.green}cc` }}>live</span>
          </div>
        </div>
        <span className="risk-day">{live}/{total}</span>
      </div>

      <div className="risk-band">
        <div className="risk-band-track">
          <div style={{ width: `${(100 - cover) / 2}%`, background: "transparent" }} />
          <div title={kind} style={{ width: `${cover}%`, background: col }} />
        </div>
        <i style={{ left: "50%" }} />
      </div>

      <div className="risk-slice-list">
        <div className="risk-slice-row">
          <div><span style={{ color: C.textSecondary }}>Best-case payout</span><em>per $100 in</em></div>
          <strong>{maxPay > 0 ? `$${maxPay.toFixed(0)}` : "—"}</strong>
          <b style={{ color: mult >= 2 ? C.green : mult >= 1.25 ? C.tealLight : C.textSecondary }}>{mult > 0 ? `${mult.toFixed(2)}×` : "out of band"}</b>
        </div>
        <div className="risk-slice-row">
          <div><span style={{ color: C.textSecondary }}>Round-trip spread</span><em>open + close</em></div>
          <strong>{spread > 0 ? `$${spread.toFixed(2)}` : "—"}</strong>
          <b style={{ color: C.textMuted }}>cost</b>
        </div>
        <div className="risk-slice-row">
          <div><span style={{ color: C.textSecondary }}>Forward</span><em>oracle mark</em></div>
          <strong>${Math.round(forward).toLocaleString()}</strong>
          <b style={{ color: C.textMuted }}>BTC</b>
        </div>
      </div>
    </button>
  );
}

// ── Hybrid cross-venue vault card (DeepBook BTC tenor + Polymarket event tail) ──
function HybridTrancheCard({ bucket, oracleId, tenor, basket, onClick }: { bucket: HyBucket; oracleId: string; tenor: string; basket: LiveBasket; onClick: () => void }) {
  const [db, setDb] = useState<TrancheProfile[] | null>(null);
  useEffect(() => {
    let alive = true;
    trancheQuote({ asset: "BTC", oracle_id: oracleId, budget_usd: 100 })
      .then((q) => { if (alive) setDb(q.tranches); })
      .catch(() => { if (alive) setDb([]); });
    return () => { alive = false; };
  }, [oracleId]);

  const pm = useMemo(() => {
    try {
      const s = computeBasketStats(basket.nav, basket.markets, basket.totalLegs, basket.daysLeft, basket.tier);
      return quoteTranchesFromStats(s);
    } catch { return [] as TrancheQuote[]; }
  }, [basket]);

  // Blend: senior leans on the BTC core (low vol), junior reaches the event tail.
  // The figure is an indicative best-case return that combines the DeepBook
  // band's realized payoff with the Polymarket leg's expected yield.
  const rows = (["senior", "mezzanine", "junior"] as const).map((kind) => {
    const dbT = db?.find((t) => (t.tranche === "mezz" ? "mezzanine" : t.tranche) === kind);
    const pmT = pm.find((t) => t.kind === kind);
    const dbMult = dbT ? Number(dbT.strip.realized_max_payout_raw) / Math.max(1, Number(dbT.strip.total_cost_raw)) : 0;
    const pmApy = pmT ? pmT.expectedApyPct : 0;
    // weight: senior leans BTC (70/30), junior leans event (30/70)
    const wDb = kind === "senior" ? 0.7 : kind === "mezzanine" ? 0.5 : 0.3;
    const blended = Math.max(0, (dbMult - 1) * 100 * wDb + pmApy * (1 - wDb));
    return { kind, blended };
  });

  return (
    <button className="risk-card risk-card--hybrid" type="button" onClick={onClick}>
      <div className="risk-card-head">
        <div>
          <div className="risk-card-title">
            <i style={{ background: C.violet }} />
            <strong>HYBRID · {HY_LABEL[bucket]}</strong>
          </div>
          <div className="risk-meta">
            <span>DeepBook {tenor}</span>
            <span>+ Polymarket</span>
            <span style={{ color: `${C.green}cc` }}>live</span>
          </div>
        </div>
        <span className="risk-day">2-venue</span>
      </div>

      <div className="risk-band">
        <div className="risk-band-track">
          <div style={{ width: "55%", background: C.tealLight }} title="DeepBook BTC core" />
          <div style={{ width: "45%", background: C.violet }} title="Polymarket event tail" />
        </div>
      </div>

      <div className="risk-slice-list">
        {(db && pm.length) ? rows.map((r) => (
          <div className="risk-slice-row" key={r.kind}>
            <div>
              <span style={{ color: trancheColor(r.kind) }}>{r.kind}</span>
              <em>{r.kind === "senior" ? "BTC-weighted" : r.kind === "junior" ? "event-weighted" : "balanced"}</em>
            </div>
            <strong style={{ color: C.textMuted, fontWeight: 400 }}>·</strong>
            <b style={{ color: r.blended >= 50 ? C.green : r.blended >= 10 ? C.tealLight : C.textSecondary }}>{formatYieldPct(r.blended)}<em> blend</em></b>
          </div>
        )) : <RowSkeleton />}
      </div>
    </button>
  );
}

// ── Polymarket event basket card (CMLT design) ──
function BasketTrancheCard({ basket, onClick }: { basket: LiveBasket; onClick: () => void }) {
  const color = tc(basket.tier);
  const { stats, quotes } = useMemo(() => {
    const s = computeBasketStats(basket.nav, basket.markets, basket.totalLegs, basket.daysLeft, basket.tier);
    return { stats: s, quotes: quoteTranchesFromStats(s) };
  }, [basket.nav, basket.markets, basket.totalLegs, basket.daysLeft, basket.tier]);

  return (
    <button className="risk-card" type="button" onClick={onClick}>
      <div className="risk-card-head">
        <div>
          <div className="risk-card-title">
            <i style={{ background: color }} />
            <strong>{basket.id}</strong>
          </div>
          <div className="risk-meta">
            <span>{basket.totalLegs} legs</span>
            <span>NAV {(basket.nav * 100).toFixed(1)}%</span>
            <span>Vol {(stats.sigma * 100).toFixed(2)}%</span>
          </div>
        </div>
        <span className="risk-day">{basket.daysLeft}d</span>
      </div>
      <DistributionBand quotes={quotes} nav={basket.nav} />
      <div className="risk-slice-list">
        {quotes.map((quote) => <TrancheRow key={quote.kind} quote={quote} />)}
      </div>
    </button>
  );
}

function DistributionBand({ quotes, nav }: { quotes: TrancheQuote[]; nav: number }) {
  const senior = quotes.find((q) => q.kind === "senior");
  const mezzanine = quotes.find((q) => q.kind === "mezzanine");
  const junior = quotes.find((q) => q.kind === "junior");
  if (!senior || !mezzanine || !junior) return null;
  const navPct = Math.max(0, Math.min(100, nav * 100));
  const segments = [senior, mezzanine, junior].map((q) => ({ pct: q.notionalShare * 100, color: trancheColor(q.kind), title: q.kind }));
  return (
    <div className="risk-band">
      <div className="risk-band-track">
        {segments.map((s) => <div key={s.title} title={s.title} style={{ width: `${s.pct}%`, background: s.color }} />)}
      </div>
      <i style={{ left: `${navPct}%` }} />
    </div>
  );
}

function TrancheRow({ quote }: { quote: TrancheQuote }) {
  const color = trancheColor(quote.kind);
  const attach = Math.round(quote.attach * 100);
  const detach = Math.round(quote.detach * 100);
  const apyColor = quote.expectedApyPct >= 50 ? C.green : quote.expectedApyPct >= 10 ? C.tealLight : quote.expectedApyPct >= 0 ? C.textSecondary : C.red;
  return (
    <div className="risk-slice-row">
      <div>
        <span style={{ color }}>{quote.kind}</span>
        <em>{attach}-{detach}%</em>
      </div>
      <strong>${quote.marketPrice.toFixed(4)}</strong>
      <b style={{ color: apyColor }}>{formatYieldPct(quote.expectedApyPct)}<em> APY</em></b>
    </div>
  );
}

function RowSkeleton() {
  return <div style={{ height: 132, opacity: 0.4, display: "grid", placeItems: "center", fontFamily: FM, fontSize: 11, color: C.textMuted }}>pricing live…</div>;
}
function CardSkeleton({ count }: { count: number }) {
  return <>{Array.from({ length: count }).map((_, i) => <div key={i} className="risk-card" style={{ height: 230, opacity: 0.45 }} />)}</>;
}
function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="risk-empty">
      <strong>{title}</strong>
      <span>{subtitle}</span>
    </div>
  );
}

const RISK_CSS = `
  .risk-shell { max-width: 1280px; margin: 0 auto; display: grid; gap: 14px; }
  .risk-hero { display: grid; gap: 8px; padding: 6px 0 8px; }
  .risk-hero h1 { margin: 0; color: ${C.textPrimary}; font-family: ${FD}; font-size: 34px; line-height: 1.05; letter-spacing: -0.03em; font-weight: 600; }
  .risk-hero p { margin: 8px 0 0; max-width: 760px; color: ${C.textSecondary}; font-family: ${FS}; font-size: 13px; line-height: 1.55; }
  .risk-tier-head span { color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; }
  .risk-stack { display: grid; gap: 26px; }
  .risk-tier { border-top: 0.5px solid ${C.border}; padding-top: 22px; }
  .risk-tier--lead, .risk-tier:first-child { border-top: 0; padding-top: 4px; }
  .risk-tier-head { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 14px; }
  .risk-tier-head p { margin: 5px 0 0; max-width: 640px; color: ${C.textMuted}; font-family: ${FS}; font-size: 12px; line-height: 1.45; }
  .risk-tier-head strong { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; font-weight: 520; white-space: nowrap; }
  .risk-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; grid-auto-rows: 1fr; }
  .risk-card { width: 100%; appearance: none; display: flex; flex-direction: column; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; padding: 13px; text-align: left; cursor: pointer; transition: background 0.14s ${EASE}, border-color 0.14s ${EASE}, transform 0.14s ${EASE}; }
  .risk-card:hover { background: ${C.card}; border-color: ${C.borderHover}; transform: translateY(-1px); }
  .risk-card--hybrid { border-color: ${C.violet}55; background: ${C.panelGradient}; }
  .risk-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .risk-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .risk-card-title i { width: 6px; height: 6px; border-radius: 999px; flex: 0 0 auto; }
  .risk-card-title strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .risk-meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.02em; }
  .risk-day { height: 28px; min-width: 50px; padding: 0 10px; border-radius: 999px; border: 0.5px solid ${C.border}; color: ${C.textPrimary}; background: ${C.card}; display: inline-flex; align-items: center; justify-content: center; font-family: ${FD}; font-size: 12px; font-weight: 560; white-space: nowrap; }
  .risk-band { position: relative; margin: 15px 0 12px; height: 7px; }
  .risk-band-track { height: 7px; display: flex; gap: 2px; overflow: hidden; border-radius: 999px; background: ${C.card}; }
  .risk-band-track div { opacity: 0.7; }
  .risk-band i { position: absolute; top: -2px; transform: translateX(-50%); width: 2px; height: 11px; border-radius: 999px; background: ${C.textPrimary}; opacity: 0.62; }
  .risk-slice-list { display: grid; margin-top: auto; border: 0.5px solid ${C.border}; border-radius: 8px; overflow: hidden; }
  .risk-slice-row { display: grid; grid-template-columns: minmax(0, 1fr) 86px 96px; gap: 12px; align-items: center; padding: 10px 11px; border-bottom: 0.5px solid ${C.border}; background: transparent; }
  .risk-slice-row:last-child { border-bottom: 0; }
  .risk-slice-row div { min-width: 0; }
  .risk-slice-row span { display: block; font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.13em; text-transform: uppercase; font-weight: 560; }
  .risk-slice-row em { color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; font-style: normal; letter-spacing: 0.02em; }
  .risk-slice-row strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 13px; font-weight: 560; text-align: right; font-variant-numeric: tabular-nums; }
  .risk-slice-row b { font-family: ${FM}; font-size: 10.5px; font-weight: 580; text-align: right; font-variant-numeric: tabular-nums; }
  .risk-slice-row b em { margin-left: 3px; color: ${C.textMuted}; font-size: 9.5px; }
  .risk-empty { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 8px; padding: 42px 24px; display: grid; gap: 8px; justify-items: center; text-align: center; }
  .risk-empty strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 16px; font-weight: 620; }
  .risk-empty span { color: ${C.textSecondary}; font-family: ${FS}; font-size: 12px; line-height: 1.5; max-width: 460px; }
  @media (max-width: 1120px) { .risk-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 720px) { .risk-grid { grid-template-columns: 1fr; } .risk-tier-head { align-items: flex-start; flex-direction: column; gap: 8px; } .risk-slice-row { grid-template-columns: minmax(0, 1fr) 78px 84px; } }
`;
