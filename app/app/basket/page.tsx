"use client";

// ---------------------------------------------------------------------------
// Market Baskets — curated baskets of uncorrelated event markets settled on the
// Pelagos vault. Basic mode is a two-pane selector + detail terminal; Advanced
// mode exposes each basket's senior / mezzanine / junior risk slices.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Header, PageFrame } from "../_components/Header";
import { C, FS, FD, FM, EASE, tc, tl, trancheColor } from "../_lib/tokens";
import { monotonePath } from "../_lib/curve";
import { BUNDLES, type Bundle } from "../_lib/bundles";
import type { LiveBasket, LiveMarket, WindowKey } from "../_lib/live-baskets";
import { useLiveBaskets, formatYieldPct } from "../_lib/use-live-baskets";
import { computeBasketStats, quoteTranchesFromStats, type TrancheQuote } from "../tranche/_quote";
import { useMode, BetaTag } from "../_lib/mode";

type TierFilter = "all" | 90 | 50;
type WindowFilter = "all" | WindowKey;
type FeedStatus = "loading" | "ready" | "seed";

type BasketView = Bundle & {
  live: boolean;
  markets: LiveMarket[];
  window: WindowKey;
};

const TIER_LABEL: Record<90 | 50, string> = {
  90: "High probability",
  50: "Low probability",
};

const WINDOW_LABEL: Record<WindowKey, string> = {
  week: "Short",
  month: "Medium",
  long: "Long",
};

const WINDOW_ORDER: Record<WindowKey, number> = { week: 0, month: 1, long: 2 };
const TIER_ORDER: Record<90 | 50, number> = { 90: 0, 50: 1 };

function windowFromDays(daysLeft: number): WindowKey {
  const label = tl(daysLeft);
  if (label === "This week") return "week";
  if (label === "This month") return "month";
  return "long";
}

function seedBasket(bundle: Bundle): BasketView {
  return { ...bundle, live: false, markets: [], window: windowFromDays(bundle.daysLeft) };
}
function liveBasket(basket: LiveBasket): BasketView {
  return { ...basket, live: true, markets: basket.markets, window: basket.window };
}

function formatDaysLeft(days: number): string {
  if (!Number.isFinite(days)) return "TBD";
  if (days <= 0) return "Resolving";
  if (days === 1) return "1 day";
  return `${days} days`;
}
function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}
function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(4)}`;
}

export default function BasketsPage() {
  const router = useRouter();
  const { mode, setMode } = useMode();
  const basketState = useLiveBaskets();
  const [tier, setTier] = useState<TierFilter>("all");
  const [windowFilter, setWindowFilter] = useState<WindowFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { baskets, feedStatus } = useMemo(() => {
    if (basketState.status !== "ok" && basketState.status !== "error") {
      return { baskets: [] as BasketView[], feedStatus: "loading" as FeedStatus };
    }
    const live = basketState.status === "ok" ? basketState.baskets : [];
    const liveById = new Map(live.map((b) => [b.id, b] as const));
    const merged: BasketView[] = BUNDLES.map((b) => {
      const lv = liveById.get(b.id);
      return lv ? liveBasket(lv) : seedBasket(b);
    });
    return { baskets: merged, feedStatus: (live.length > 0 ? "ready" : "seed") as FeedStatus };
  }, [basketState]);

  const filtered = useMemo(() => {
    return baskets
      .filter((basket) => {
        if (tier !== "all" && basket.tier !== tier) return false;
        if (windowFilter !== "all" && basket.window !== windowFilter) return false;
        return true;
      })
      .sort((a, b) => {
        const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
        if (tierDiff !== 0) return tierDiff;
        return WINDOW_ORDER[a.window] - WINDOW_ORDER[b.window];
      });
  }, [baskets, tier, windowFilter]);

  useEffect(() => {
    let nextSelectedId: string | null;
    if (filtered.length === 0) {
      nextSelectedId = null;
    } else if (!selectedId || !filtered.some((basket) => basket.id === selectedId)) {
      nextSelectedId = filtered[0].id;
    } else {
      return;
    }
    const id = window.setTimeout(() => setSelectedId(nextSelectedId), 0);
    return () => window.clearTimeout(id);
  }, [filtered, selectedId]);

  const selected = filtered.find((basket) => basket.id === selectedId) ?? filtered[0] ?? null;

  return (
    <>
      <Header />
      <style>{BASKET_CSS}</style>
      <PageFrame wide>
        <div className="bk-shell">
          <section className="bk-hero">
            <div>
              <span className="bk-eyebrow">Structured products</span>
              <h1>
                Baskets <BetaTag style={{ transform: "translateY(-4px)" }} />
              </h1>
              <p>
                {mode === "advanced"
                  ? "Every curated basket, pre-sliced by loss priority — senior is paid first, junior takes first loss. Pick a tranche to deploy on the Pelagos vault."
                  : "Curated baskets of uncorrelated event markets, settled on the Pelagos vault. Open one to trade it, or view its senior / mezzanine / junior risk slices."}
              </p>
            </div>
          </section>

          {mode === "advanced" ? (
            /* Advanced — the tranching engine, full width and nothing else. */
            <RiskSlicesPanel
              baskets={filtered}
              loading={feedStatus === "loading"}
              onOpen={(id) => router.push(`/app/tranche/${id}`)}
            />
          ) : feedStatus === "loading" ? (
            <BasketLoading />
          ) : filtered.length === 0 ? (
            <BasketEmpty
              onReset={() => {
                setTier("all");
                setWindowFilter("all");
              }}
            />
          ) : (
            /* Basic — a clean two-pane terminal: pick a basket, read its detail. */
            <div className="bk-split">
              <div className="bk-col-left">
                <BasketSelector
                  baskets={filtered}
                  selectedId={selected?.id ?? null}
                  feedStatus={feedStatus}
                  onSelect={setSelectedId}
                />
              </div>
              <div className="bk-col-right">
                {selected && (
                  <SelectedBasketPanel
                    basket={selected}
                    vaultPrice={selected.issue}
                    onOpen={() => router.push(`/app/basket/${selected.id}`)}
                    onViewSlices={() => setMode("advanced")}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </PageFrame>
    </>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <span className="bk-caption">{children}</span>;
}

/* ───────────────────────── BASIC · Event selector ───────────────────────── */

function BasketSelector({
  baskets,
  selectedId,
  feedStatus,
  onSelect,
}: {
  baskets: BasketView[];
  selectedId: string | null;
  feedStatus: FeedStatus;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="bk-card bk-selector">
      <div className="bk-selector-head">
        <div>
          <Caption>Selector</Caption>
          <strong>Event baskets</strong>
        </div>
        <em>{baskets.length} {feedStatus === "ready" ? "live" : "seed"}</em>
      </div>
      <div className="bk-selector-table">
        <div className="bk-selector-row bk-selector-labels">
          <span>Basket</span>
          <span>NAV</span>
          <span>Issue</span>
          <span>Move</span>
        </div>
        {baskets.map((basket) => (
          <BasketSelectorRow
            key={basket.id}
            basket={basket}
            active={basket.id === selectedId}
            issuePrice={basket.issue}
            onSelect={() => onSelect(basket.id)}
          />
        ))}
      </div>
      {/* Footer fills the column under the list so the two panes' bottoms line up. */}
      <div className="bk-selector-foot">
        <div className="bk-foot-legend">
          <Caption>Reading the table</Caption>
          <div className="bk-foot-rows">
            <div><span>NAV</span><em>Live mark, 0–100% of $1 face</em></div>
            <div><span>Issue</span><em>Vault entry price per unit</em></div>
            <div><span>Move</span><em>24-hour change in NAV</em></div>
          </div>
        </div>
        <p className="bk-foot-note">
          Open a basket to trade it on the Pelagos vault, or switch to <strong>Advanced</strong> for senior / mezzanine / junior risk slices.
        </p>
      </div>
    </div>
  );
}

function BasketSelectorRow({
  basket,
  active,
  issuePrice,
  onSelect,
}: {
  basket: BasketView;
  active: boolean;
  issuePrice: number | null | undefined;
  onSelect: () => void;
}) {
  const color = tc(basket.tier);
  const positive = basket.change >= 0;
  return (
    <button type="button" className={`bk-selector-row ${active ? "is-active" : ""}`} onClick={onSelect}>
      <span className="bk-row-name">
        <i style={{ background: color }} />
        <span>
          <strong>{basket.id}</strong>
          <em>{TIER_LABEL[basket.tier]} / {WINDOW_LABEL[basket.window]}</em>
        </span>
      </span>
      <span>{(basket.nav * 100).toFixed(1)}%</span>
      <span>{formatPrice(issuePrice)}</span>
      <span style={{ color: positive ? C.green : C.red }}>
        {positive ? "+" : ""}
        {basket.change.toFixed(1)}%
      </span>
    </button>
  );
}

/* ───────────────────────── BASIC · Trend chart ───────────────────────── */

const TREND_TABS = [
  { key: "1D", label: "1D" },
  { key: "7D", label: "7D" },
  { key: "30D", label: "30D" },
  { key: "1Y", label: "1Y" },
] as const;
type TrendKey = (typeof TREND_TABS)[number]["key"];

function trendXLabels(key: TrendKey): [string, string, string] {
  return key === "1D" ? ["24h ago", "12h", "now"]
    : key === "7D" ? ["7d ago", "3d", "now"]
    : key === "30D" ? ["30d ago", "15d", "now"]
    : ["1y ago", "6m", "now"];
}

function BasketTrendChart({ history, dayHistory, color }: { history: number[]; dayHistory: number[]; color: string }) {
  const [range, setRange] = useState<TrendKey>("1D");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [dim, setDim] = useState<{ w: number; h: number }>({ w: 600, h: 150 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.max(160, Math.floor(e.contentRect.width));
        const h = Math.max(90, Math.floor(e.contentRect.height));
        setDim((p) => (p.w === w && p.h === h ? p : { w, h }));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const series = useMemo(() => {
    // 1D = the 24h intraday series; the rest slice the daily history.
    const raw = range === "1D" ? (dayHistory && dayHistory.length > 1 ? dayHistory : history.slice(-2))
      : range === "7D" ? history.slice(-7)
      : range === "30D" ? history.slice(-30)
      : history;
    const clean = raw.filter((v) => Number.isFinite(v) && v > 0 && v <= 1);
    return clean.length >= 2 ? clean : raw.length >= 2 ? raw : [raw[0] ?? 0, raw[0] ?? 0];
  }, [range, history, dayHistory]);

  const W = dim.w, H = dim.h, PL = 44, PR = 10, PT = 10, PB = 22;
  const n = series.length;
  const lo = Math.min(...series), hi = Math.max(...series);
  const pad = (hi - lo) * 0.18 || 0.01;
  const yMin = Math.max(0, lo - pad), yMax = Math.min(1, hi + pad);
  const sx = (i: number) => PL + (i / Math.max(1, n - 1)) * (W - PL - PR);
  const sy = (v: number) => {
    const y = PT + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PT - PB);
    return Math.max(PT, Math.min(H - PB, y));
  };
  const pts = series.map((v, i) => [sx(i), sy(v)] as [number, number]);
  const line = monotonePath(pts);
  const area = `${line} L ${sx(n - 1)} ${H - PB} L ${sx(0)} ${H - PB} Z`;
  const yTicks = [yMax, (yMax + yMin) / 2, yMin];
  const xLabels = trendXLabels(range);
  const clipId = `bk-clip-${range}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexShrink: 0 }}>
        {TREND_TABS.map((t) => {
          const on = t.key === range;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setRange(t.key)}
              style={{
                padding: "4px 11px",
                borderRadius: 7,
                border: `0.5px solid ${on ? C.borderHover : C.border}`,
                background: on ? C.cardHover : "transparent",
                color: on ? C.textPrimary : C.textMuted,
                fontFamily: FM,
                fontSize: 11,
                cursor: "pointer",
                transition: `all 0.15s ${EASE}`,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none" style={{ display: "block", position: "absolute", inset: 0 }}>
          <defs>
            <clipPath id={clipId}>
              <rect x={PL} y={PT} width={W - PL - PR} height={H - PT - PB} />
            </clipPath>
          </defs>
          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke={C.border} strokeWidth="1" opacity={0.55} vectorEffect="non-scaling-stroke" />
              <text x={PL - 7} y={sy(v) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9.5">
                {(v * 100).toFixed(1)}%
              </text>
            </g>
          ))}
          <g clipPath={`url(#${clipId})`}>
            <path d={area} fill={color} opacity={0.12} />
            <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </g>
          {[0, 0.5, 1].map((f, i) => (
            <text key={i} x={PL + f * (W - PL - PR)} y={H - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fill={C.textMuted} fontFamily={FM} fontSize="9.5">
              {xLabels[i]}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

/* ───────────────────────── BASIC · Selected detail ───────────────────────── */

function SelectedBasketPanel({
  basket,
  vaultPrice,
  onOpen,
  onViewSlices,
}: {
  basket: BasketView;
  vaultPrice: number | null | undefined;
  onOpen: () => void;
  onViewSlices: () => void;
}) {
  const color = tc(basket.tier);
  const positive = basket.change >= 0;
  const marketVolume = basket.markets.reduce((sum, m) => sum + m.volumeUsd, 0);
  const topMarkets = basket.markets.slice(0, 5);

  return (
    <div className="bk-card bk-detail">
      <div className="bk-detail-head">
        <div>
          <span style={{ color }}>{TIER_LABEL[basket.tier]} / {WINDOW_LABEL[basket.window]}</span>
          <h2>{basket.id}</h2>
        </div>
        <div className="bk-nav">
          <strong style={{ color }}>{(basket.nav * 100).toFixed(1)}%</strong>
          <em>${basket.nav.toFixed(3)} NAV</em>
        </div>
      </div>

      <div className="bk-chart">
        <BasketTrendChart history={basket.history} dayHistory={basket.dayHistory} color={color} />
      </div>

      <div className="bk-metrics">
        <MetricCell label="Issue price" value={formatPrice(vaultPrice)} />
        <MetricCell label="24h move" value={`${positive ? "+" : ""}${basket.change.toFixed(1)}%`} tone={positive ? "positive" : "negative"} />
        <MetricCell label="Maturity" value={formatDaysLeft(basket.daysLeft)} />
        <MetricCell label="Legs" value={basket.live ? basket.totalLegs.toLocaleString("en-US") : "-"} />
        <MetricCell label="Volume" value={basket.live ? formatCompactUsd(marketVolume) : "-"} />
        <MetricCell label="Route" value="Sui testnet" />
      </div>

      <div className="bk-action-row">
        <button type="button" className="bk-action-primary" onClick={onOpen}>
          Open basket
        </button>
        <button type="button" className="bk-action-ghost" onClick={onViewSlices}>
          View risk slices
        </button>
      </div>

      <div className="bk-constituents">
        <div className="bk-section-head">
          <Caption>Top markets by weight</Caption>
          <strong>{basket.live ? `Top ${topMarkets.length} of ${basket.markets.length}` : "Seed data"}</strong>
        </div>
        {topMarkets.length > 0 ? (
          <div className="bk-market-list">
            {topMarkets.map((market) => (
              <div key={market.id} className="bk-market-row">
                <span>
                  <strong>{market.question}</strong>
                  <em>{market.side} / {(market.weight * 100).toFixed(1)}% weight</em>
                </span>
                <b>{(market.probability * 100).toFixed(1)}%</b>
              </div>
            ))}
          </div>
        ) : (
          <div className="bk-empty-inline">Constituents will appear when market data is available.</div>
        )}
      </div>
    </div>
  );
}

function MetricCell({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  const color = tone === "positive" ? C.green : tone === "negative" ? C.red : C.textPrimary;
  return (
    <div className="bk-metric-cell">
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  );
}

function BasketLoading() {
  return (
    <div className="bk-event-stack">
      <div className="bk-card bk-skeleton" style={{ minHeight: 300 }} />
      <div className="bk-card bk-skeleton" style={{ minHeight: 360 }} />
    </div>
  );
}

function BasketEmpty({ onReset }: { onReset: () => void }) {
  return (
    <div className="bk-card bk-empty">
      <strong>No baskets match the current filters.</strong>
      <button type="button" onClick={onReset}>Reset filters</button>
    </div>
  );
}

/* ───────────────────────── RIGHT · Risk Slices ───────────────────────── */

function RiskSlicesPanel({
  baskets,
  loading,
  onOpen,
}: {
  baskets: BasketView[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const sorted = useMemo(() => {
    return [...baskets].sort((a, b) => {
      const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
      if (t !== 0) return t;
      return WINDOW_ORDER[a.window] - WINDOW_ORDER[b.window];
    });
  }, [baskets]);

  return (
    <div className="bk-card bk-risk">
      <div className="bk-risk-head">
        <div>
          <Caption>Tranching engine</Caption>
          <strong>Risk slices</strong>
        </div>
        <em>Senior · Mezz · Junior</em>
      </div>
      <p className="bk-risk-sub">
        Every basket is sliced by loss priority — senior is paid first, junior eats first loss. Open a slice to deploy.
      </p>
      {loading ? (
        <div className="bk-risk-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bk-risk-card bk-skeleton" style={{ minHeight: 196 }} />
          ))}
        </div>
      ) : (
        <div className="bk-risk-grid">
          {sorted.map((b) => (
            <RiskSliceCard key={b.id} basket={b} onClick={() => onOpen(b.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function RiskSliceCard({ basket, onClick }: { basket: BasketView; onClick: () => void }) {
  const color = tc(basket.tier);
  const { stats, quotes } = useMemo(() => {
    const s = computeBasketStats(basket.nav, basket.markets, basket.totalLegs, basket.daysLeft, basket.tier);
    return { stats: s, quotes: quoteTranchesFromStats(s) };
  }, [basket.nav, basket.markets, basket.totalLegs, basket.daysLeft, basket.tier]);

  return (
    <button className="bk-risk-card" type="button" onClick={onClick}>
      <div className="bk-risk-card-head">
        <div className="bk-risk-card-title">
          <i style={{ background: color }} />
          <strong>{basket.id}</strong>
        </div>
        <span className="bk-day">{basket.daysLeft}d</span>
      </div>
      <div className="bk-risk-meta">
        <span>{basket.totalLegs} legs</span>
        <span>NAV {(basket.nav * 100).toFixed(1)}%</span>
        <span>σ {(stats.sigma * 100).toFixed(2)}%</span>
      </div>
      <DistributionBand quotes={quotes} nav={basket.nav} />
      <div className="bk-slice-list">
        {quotes.map((q) => <SliceRow key={q.kind} quote={q} />)}
      </div>
    </button>
  );
}

function DistributionBand({ quotes, nav }: { quotes: TrancheQuote[]; nav: number }) {
  const senior = quotes.find((q) => q.kind === "senior");
  const mezz = quotes.find((q) => q.kind === "mezzanine");
  const junior = quotes.find((q) => q.kind === "junior");
  if (!senior || !mezz || !junior) return null;
  const navPct = Math.max(0, Math.min(100, nav * 100));
  const segments = [senior, mezz, junior].map((q) => ({ pct: q.notionalShare * 100, color: trancheColor(q.kind), title: q.kind }));
  return (
    <div className="bk-band">
      <div className="bk-band-track">
        {segments.map((s) => <div key={s.title} title={s.title} style={{ width: `${s.pct}%`, background: s.color }} />)}
      </div>
      <i style={{ left: `${navPct}%` }} />
    </div>
  );
}

function SliceRow({ quote }: { quote: TrancheQuote }) {
  const color = trancheColor(quote.kind);
  const attach = Math.round(quote.attach * 100);
  const detach = Math.round(quote.detach * 100);
  const apyColor =
    quote.expectedApyPct >= 50 ? C.green : quote.expectedApyPct >= 10 ? C.tealLight : quote.expectedApyPct >= 0 ? C.textSecondary : C.red;
  return (
    <div className="bk-slice-row">
      <div>
        <span style={{ color }}>{quote.kind}</span>
        <em>{attach}-{detach}%</em>
      </div>
      <strong>${quote.marketPrice.toFixed(4)}</strong>
      <b style={{ color: apyColor }}>{formatYieldPct(quote.expectedApyPct)}<em> APY</em></b>
    </div>
  );
}


/* ───────────────────────── CSS ───────────────────────── */

const BASKET_CSS = `
  .bk-shell { max-width: 1380px; margin: 0 auto; display: grid; gap: 16px; min-width: 0; }
  .bk-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 16px; padding: 0 0 2px; }
  .bk-eyebrow { display: block; color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 9px; }
  .bk-hero h1 { margin: 0; color: ${C.textPrimary}; font-family: ${FD}; font-size: 30px; line-height: 1.05; letter-spacing: -0.02em; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .bk-hero p { max-width: 620px; margin: 9px 0 0; color: ${C.textSecondary}; font-family: ${FS}; font-size: 13px; line-height: 1.55; }
  .bk-caption { display: block; color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; }


  /* left selector fills the detail column's height so the two sections' bottoms line up */
  .bk-split { display: grid; grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr); gap: 16px; align-items: stretch; min-width: 0; }
  .bk-col-left, .bk-col-right { min-width: 0; display: flex; }
  .bk-col-left > .bk-card, .bk-col-right > .bk-card { width: 100%; }

  .bk-card { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 12px; min-width: 0; }

  .bk-event-stack { display: grid; gap: 14px; }
  .bk-selector { overflow: hidden; display: flex; flex-direction: column; }
  .bk-selector-head { display: flex; align-items: end; justify-content: space-between; gap: 14px; padding: 14px 16px 12px; border-bottom: 0.5px solid ${C.border}; }
  .bk-selector-head div { display: grid; gap: 6px; }
  .bk-selector-head strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; font-weight: 620; }
  .bk-selector-head em { color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; font-style: normal; white-space: nowrap; }
  .bk-selector-table { display: flex; flex-direction: column; }
  .bk-selector-row { width: 100%; display: grid; grid-template-columns: minmax(150px, 1.6fr) 64px 82px 64px; gap: 10px; align-items: center; border: 0; border-bottom: 0.5px solid ${C.border}; background: transparent; color: ${C.textSecondary}; padding: 11px 16px; text-align: left; font-family: ${FD}; cursor: pointer; transition: background 0.14s ${EASE}, color 0.14s ${EASE}; }
  .bk-selector-row:last-child { border-bottom: 0; }
  .bk-selector-row:hover, .bk-selector-row.is-active { background: ${C.surface}; color: ${C.textPrimary}; }
  .bk-selector-row.is-active { box-shadow: inset 2px 0 0 ${C.tealLight}; }
  .bk-selector-labels { cursor: default; background: ${C.surface}; color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; padding-top: 9px; padding-bottom: 9px; }
  .bk-selector-labels:hover { background: ${C.surface}; color: ${C.textMuted}; }
  .bk-selector-row > span:not(.bk-row-name) { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bk-row-name { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
  .bk-row-name i { width: 6px; height: 6px; border-radius: 999px; flex: 0 0 auto; }
  .bk-row-name span { min-width: 0; display: grid; gap: 3px; }
  .bk-row-name strong { color: ${C.textPrimary}; font-size: 13px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bk-row-name em { color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* selector footer — legend + how-to that fills the column under the basket list,
     so the left pane's bottom edge lines up with the right detail card. */
  .bk-selector-table { flex: 0 0 auto; }
  .bk-selector-foot { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: space-between; gap: 16px; padding: 15px 16px 16px; }
  .bk-foot-legend { display: grid; gap: 10px; }
  .bk-foot-rows { display: grid; gap: 8px; }
  .bk-foot-rows > div { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 12px; align-items: baseline; }
  .bk-foot-rows span { color: ${C.textSecondary}; font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 560; }
  .bk-foot-rows em { color: ${C.textMuted}; font-family: ${FS}; font-size: 11.5px; font-style: normal; line-height: 1.4; }
  .bk-foot-note { margin: 0; color: ${C.textMuted}; font-family: ${FS}; font-size: 11.5px; line-height: 1.55; }
  .bk-foot-note strong { color: ${C.textSecondary}; font-weight: 600; }

  .bk-detail { padding: 16px; display: grid; gap: 14px; }
  .bk-detail-head { display: flex; justify-content: space-between; align-items: start; gap: 18px; }
  .bk-detail-head span { display: block; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; margin-bottom: 7px; }
  .bk-detail-head h2 { margin: 0; color: ${C.textPrimary}; font-family: ${FD}; font-size: 22px; line-height: 1.1; letter-spacing: -0.02em; font-weight: 620; }
  .bk-nav { text-align: right; display: grid; gap: 3px; }
  .bk-nav strong { font-family: ${FD}; font-size: 28px; line-height: 1; font-weight: 520; font-variant-numeric: tabular-nums; }
  .bk-nav em { color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; font-style: normal; }
  .bk-chart { height: 196px; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 10px; padding: 10px 12px; overflow: hidden; }
  .bk-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .bk-metric-cell { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 9px; padding: 11px; display: grid; gap: 7px; min-height: 64px; align-content: center; }
  .bk-metric-cell span { color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; }
  .bk-metric-cell strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 14px; font-weight: 620; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .bk-action-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .bk-action-primary { height: 42px; border-radius: 9px; font-family: ${FD}; font-size: 13px; font-weight: 620; cursor: pointer; border: 0.5px solid ${C.tealLight}; background: ${C.tealLight}; color: #03111d; transition: background 0.14s ${EASE}, border-color 0.14s ${EASE}, opacity 0.14s ${EASE}; }
  .bk-action-primary:hover { background: ${C.teal}; border-color: ${C.teal}; }
  .bk-action-ghost { height: 42px; border-radius: 9px; font-family: ${FD}; font-size: 13px; font-weight: 600; cursor: pointer; border: 0.5px solid ${C.border}; background: ${C.surface}; color: ${C.textPrimary}; transition: background 0.14s ${EASE}, border-color 0.14s ${EASE}; }
  .bk-action-ghost:hover { border-color: ${C.tealLight}; color: ${C.tealLight}; }
  .bk-action-primary:disabled { opacity: 0.6; cursor: progress; }

  .bk-constituents { display: grid; gap: 10px; }
  .bk-section-head { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
  .bk-section-head strong { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; font-weight: 520; white-space: nowrap; }
  .bk-market-list { border: 0.5px solid ${C.border}; border-radius: 9px; overflow: hidden; }
  .bk-slice-list:empty { display: none; }
  .bk-market-row { display: grid; grid-template-columns: minmax(0, 1fr) 64px; gap: 12px; align-items: center; padding: 10px 12px; border-bottom: 0.5px solid ${C.border}; background: ${C.surface}; }
  .bk-market-row:last-child { border-bottom: 0; }
  .bk-market-row span { min-width: 0; display: grid; gap: 3px; }
  .bk-market-row strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 12px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bk-market-row em { color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bk-market-row b { color: ${C.textSecondary}; font-family: ${FM}; font-size: 11px; font-style: normal; font-weight: 620; text-align: right; font-variant-numeric: tabular-nums; }

  .bk-empty-inline { border: 0.5px dashed ${C.border}; background: ${C.surface}; border-radius: 9px; color: ${C.textMuted}; font-family: ${FS}; font-size: 12px; line-height: 1.5; padding: 18px; text-align: center; }
  .bk-empty { display: grid; justify-items: center; gap: 14px; padding: 48px 24px; text-align: center; }
  .bk-empty strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 16px; font-weight: 620; }
  .bk-empty button { height: 38px; padding: 0 18px; border-radius: 9px; font-family: ${FD}; font-size: 13px; font-weight: 600; cursor: pointer; border: 0.5px solid ${C.border}; background: ${C.surface}; color: ${C.textPrimary}; }
  .bk-empty button:hover { border-color: ${C.borderHover}; background: ${C.cardHover}; }

  .bk-skeleton { opacity: 0.6; position: relative; overflow: hidden; }
  .bk-skeleton::after { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 35%, rgba(255,255,255,0.04) 50%, transparent 65%); animation: bk-load 1.6s ease-in-out infinite; }
  @keyframes bk-load { 0% { transform: translateX(-70%); } 100% { transform: translateX(70%); } }

  /* Risk slices panel */
  .bk-risk { padding: 16px; display: grid; gap: 0; }
  .bk-risk-head { display: flex; align-items: end; justify-content: space-between; gap: 14px; }
  .bk-risk-head div { display: grid; gap: 6px; }
  .bk-risk-head strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; font-weight: 620; }
  .bk-risk-head em { color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; font-style: normal; letter-spacing: 0.06em; white-space: nowrap; }
  .bk-risk-sub { margin: 9px 0 14px; color: ${C.textMuted}; font-family: ${FS}; font-size: 12px; line-height: 1.5; }
  .bk-risk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
  .bk-risk-card { width: 100%; appearance: none; display: flex; flex-direction: column; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 10px; padding: 13px; text-align: left; cursor: pointer; transition: background 0.14s ${EASE}, border-color 0.14s ${EASE}, transform 0.14s ${EASE}; }
  .bk-risk-card:hover { background: ${C.cardHover}; border-color: ${C.borderHover}; transform: translateY(-1px); }
  .bk-risk-card-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .bk-risk-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .bk-risk-card-title i { width: 6px; height: 6px; border-radius: 999px; flex: 0 0 auto; }
  .bk-risk-card-title strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bk-day { height: 24px; min-width: 42px; padding: 0 9px; border-radius: 999px; border: 0.5px solid ${C.border}; color: ${C.textPrimary}; background: ${C.card}; display: inline-flex; align-items: center; justify-content: center; font-family: ${FD}; font-size: 11px; font-weight: 560; white-space: nowrap; flex: 0 0 auto; }
  .bk-risk-meta { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 7px; color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.02em; }
  .bk-band { position: relative; margin: 13px 0 11px; height: 7px; }
  .bk-band-track { height: 7px; display: flex; gap: 2px; overflow: hidden; border-radius: 999px; background: ${C.card}; }
  .bk-band-track div { opacity: 0.72; }
  .bk-band i { position: absolute; top: -2px; transform: translateX(-50%); width: 2px; height: 11px; border-radius: 999px; background: ${C.textPrimary}; opacity: 0.6; }
  .bk-slice-list { display: grid; margin-top: auto; border: 0.5px solid ${C.border}; border-radius: 9px; overflow: hidden; }
  .bk-slice-row { display: grid; grid-template-columns: minmax(0, 1fr) 66px 78px; gap: 8px; align-items: center; padding: 9px 11px; border-bottom: 0.5px solid ${C.border}; background: ${C.card}; }
  .bk-slice-row:last-child { border-bottom: 0; }
  .bk-slice-row div { min-width: 0; }
  .bk-slice-row span { display: block; font-family: ${FM}; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 560; }
  .bk-slice-row em { color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; font-style: normal; letter-spacing: 0.02em; }
  .bk-slice-row strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 12px; font-weight: 560; text-align: right; font-variant-numeric: tabular-nums; }
  .bk-slice-row b { font-family: ${FM}; font-size: 10px; font-weight: 580; text-align: right; font-variant-numeric: tabular-nums; }
  .bk-slice-row b em { margin-left: 3px; color: ${C.textMuted}; font-size: 9px; }

  @media (max-width: 1180px) {
    .bk-hero { grid-template-columns: 1fr; }
    .bk-split { grid-template-columns: 1fr; }
    .bk-risk-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 720px) {
    .bk-metrics, .bk-risk-grid { grid-template-columns: 1fr; }
    .bk-selector-row { grid-template-columns: minmax(0, 1fr) 60px; }
    .bk-selector-row > span:nth-child(3), .bk-selector-row > span:nth-child(4) { display: none; }
    .bk-detail-head { flex-direction: column; }
    .bk-nav { text-align: left; }
  }
`;
