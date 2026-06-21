"use client";

// ---------------------------------------------------------------------------
// Risk Slices — the tranching-engine landing page. Lists every basket sliced by
// loss priority (senior paid first, junior takes first loss) and links into the
// per-basket detail ticket where a slice is priced and deployed.
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Header, PageFrame } from "../_components/Header";
import { C, FS, FD, FM, EASE, trancheColor, tc } from "../_lib/tokens";
import { BUNDLES } from "../_lib/bundles";
import { useLiveBaskets, formatYieldPct } from "../_lib/use-live-baskets";
import { computeBasketStats, quoteTranchesFromStats, type TrancheQuote } from "./_quote";
import type { LiveBasket } from "../_lib/live-baskets";

const TIER_LABEL: Record<90 | 50, string> = {
  90: "High probability",
  50: "Low probability",
};

const TIER_BODY: Record<90 | 50, string> = {
  90: "High-probability baskets where the senior slice does most of the work.",
  50: "Long-shot baskets where the junior tail carries the upside.",
};

export default function TranchesPage() {
  const router = useRouter();
  const state = useLiveBaskets();

  const groups = useMemo(() => {
    const empty: Record<90 | 50, LiveBasket[]> = { 90: [], 50: [] };
    // Always render the full product suite (High / Low × windows). Overlay live
    // feed data where available; seed the rest only if the backend basket feed
    // is unreachable (it serves all six CLOB-priced baskets directly).
    const liveById = new Map(
      (state.status === "ok" ? state.baskets : []).map((b) => [b.id, b] as const),
    );
    const baskets: LiveBasket[] = BUNDLES.map(
      (b) =>
        liveById.get(b.id) ??
        ({
          ...b,
          live: false as const,
          window: (b.id.includes("-SHORT") ? "week" : b.id.includes("-MED") ? "month" : "long") as "week" | "month" | "long",
          markets: [],
        } as unknown as LiveBasket),
    );
    for (const b of baskets) empty[b.tier].push(b);
    const winOrder: Record<"week" | "month" | "long", number> = { week: 0, month: 1, long: 2 };
    for (const t of [90, 50] as const) empty[t].sort((a, b) => winOrder[a.window] - winOrder[b.window]);
    return empty;
  }, [state]);

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
                Senior, mezzanine, and junior tranches of Polymarket&apos;s event-CLOB baskets. Each basket is sliced by
                loss priority; pick a slice and open it. (BTC range strips live under Distribution &amp; Baskets.)
              </p>
            </div>
          </section>

          <div className="risk-stack">
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
  const apyColor = quote.expectedApyPct >= 50 ? C.green : quote.expectedApyPct >= 10 ? C.tealLight : quote.expectedApyPct > 0 ? C.teal : quote.expectedApyPct === 0 ? C.textSecondary : C.red;
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
  .risk-tier:first-child { border-top: 0; padding-top: 4px; }
  .risk-tier-head { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 14px; }
  .risk-tier-head p { margin: 5px 0 0; max-width: 640px; color: ${C.textMuted}; font-family: ${FS}; font-size: 12px; line-height: 1.45; }
  .risk-tier-head strong { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; font-weight: 520; white-space: nowrap; }
  .risk-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; grid-auto-rows: 1fr; }
  .risk-card { width: 100%; appearance: none; display: flex; flex-direction: column; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; padding: 13px; text-align: left; cursor: pointer; transition: background 0.14s ${EASE}, border-color 0.14s ${EASE}, transform 0.14s ${EASE}; }
  .risk-card:hover { background: ${C.card}; border-color: ${C.borderHover}; transform: translateY(-1px); }
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
