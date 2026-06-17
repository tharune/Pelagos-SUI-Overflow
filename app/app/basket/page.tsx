"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Header, PageFrame } from "../_components/Header";
import { C, FS, FD, FM, EASE, tc, tl } from "../_lib/tokens";
import { monotonePath } from "../_lib/curve";
import { BUNDLES, type Bundle } from "../_lib/bundles";
import type { LiveBasket, LiveMarket, WindowKey } from "../_lib/live-baskets";
import { useLiveBaskets } from "../_lib/use-live-baskets";
import { fetchAllVaultPrices, type VaultPriceResponse } from "../../lib/api";
import { DeepBookBaskets } from "../_components/deepbook-baskets";

type AssetClass = "deepbook" | "event";
type TierFilter = "all" | 90 | 70 | 50;
type WindowFilter = "all" | WindowKey;
type FeedStatus = "loading" | "ready" | "seed";

type BasketView = Bundle & {
  live: boolean;
  markets: LiveMarket[];
  window: WindowKey;
};

// Mid (PBU-MID, tier 70) is intentionally dropped — event baskets are High + Low only.
const TIER_OPTIONS: Array<{ value: TierFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: 90, label: "High" },
  { value: 50, label: "Low" },
];

const WINDOW_OPTIONS: Array<{ value: WindowFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "week", label: "Short" },
  { value: "month", label: "Medium" },
  { value: "long", label: "Long" },
];

const TIER_LABEL: Record<90 | 70 | 50, string> = {
  90: "High probability",
  70: "Mid probability",
  50: "Low probability",
};

const WINDOW_LABEL: Record<WindowKey, string> = {
  week: "Short",
  month: "Medium",
  long: "Long",
};

const WINDOW_ORDER: Record<WindowKey, number> = {
  week: 0,
  month: 1,
  long: 2,
};

const TIER_ORDER: Record<90 | 70 | 50, number> = {
  90: 0,
  70: 1,
  50: 2,
};

function windowFromDays(daysLeft: number): WindowKey {
  const label = tl(daysLeft);
  if (label === "This week") return "week";
  if (label === "This month") return "month";
  return "long";
}

function seedBasket(bundle: Bundle): BasketView {
  return {
    ...bundle,
    live: false,
    markets: [],
    window: windowFromDays(bundle.daysLeft),
  };
}

function liveBasket(basket: LiveBasket): BasketView {
  return {
    ...basket,
    live: true,
    markets: basket.markets,
    window: basket.window,
  };
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
  const basketState = useLiveBaskets();
  const [assetClass, setAssetClass] = useState<AssetClass>("deepbook");
  const [tier, setTier] = useState<TierFilter>("all");
  const [windowFilter, setWindowFilter] = useState<WindowFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [vaultPrices, setVaultPrices] = useState<Record<string, VaultPriceResponse>>({});

  useEffect(() => {
    let alive = true;
    fetchAllVaultPrices().then((response) => {
      if (!alive || !response) return;
      const next: Record<string, VaultPriceResponse> = {};
      for (const price of response.prices) {
        if (price.bundle_name) next[price.bundle_name] = price;
      }
      setVaultPrices(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  const { baskets, feedStatus } = useMemo(() => {
    if (basketState.status === "ok" && basketState.baskets.length > 0) {
      return {
        baskets: basketState.baskets.map(liveBasket),
        feedStatus: "ready" as FeedStatus,
        feedError: null,
      };
    }
    if (basketState.status === "error") {
      return {
        baskets: BUNDLES.map(seedBasket),
        feedStatus: "seed" as FeedStatus,
        feedError: basketState.error,
      };
    }
    if (basketState.status === "ok") {
      return {
        baskets: BUNDLES.map(seedBasket),
        feedStatus: "seed" as FeedStatus,
        feedError: "Live basket feed returned no baskets.",
      };
    }
    return {
      baskets: [] as BasketView[],
      feedStatus: "loading" as FeedStatus,
      feedError: null,
    };
  }, [basketState]);

  const filtered = useMemo(() => {
    return baskets
      .filter((basket) => {
        if (basket.tier === 70) return false; // Mid tier removed from the suite
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

  const selected =
    filtered.find((basket) => basket.id === selectedId) ?? filtered[0] ?? null;

  return (
    <>
      <Header />
      <style>{BASKET_CSS}</style>
      <PageFrame wide>
        <div className="basket-shell">
          <section className="basket-hero">
            <div>
              <h1>Baskets</h1>
              <p>
                {assetClass === "deepbook"
                  ? "Calendar bundles spanning the BTC term structure — one ticket holds a strip on each of several live DeepBook expiries. Pick a shape, read its composition, open in one signature."
                  : "Curated baskets of uncorrelated event markets, settled on Pelagos's own vault. High-conviction and long-shot tiers."}
              </p>
            </div>
            <SegmentedControl
              value={assetClass}
              onChange={setAssetClass}
              options={[
                { value: "deepbook", label: "DeepBook · BTC" },
                { value: "event", label: "Event baskets" },
              ]}
            />
          </section>

          {assetClass === "deepbook" ? (
            <DeepBookBaskets />
          ) : (
            <>
              <section className="basket-controls" aria-label="Basket filters">
                <SegmentedControl value={tier} onChange={setTier} options={TIER_OPTIONS} />
                <SegmentedControl value={windowFilter} onChange={setWindowFilter} options={WINDOW_OPTIONS} />
              </section>

              {feedStatus === "loading" ? (
                <BasketLoading />
              ) : filtered.length === 0 ? (
                <BasketEmpty
                  onReset={() => {
                    setTier("all");
                    setWindowFilter("all");
                  }}
                />
              ) : (
                <section className="basket-workspace">
                  <BasketSelector
                    baskets={filtered}
                    selectedId={selected?.id ?? null}
                    vaultPrices={vaultPrices}
                    onSelect={setSelectedId}
                  />
                  {selected && (
                    <SelectedBasketPanel
                      basket={selected}
                      vaultPrice={vaultPrices[selected.id]?.issue_price ?? selected.issue}
                      onOpen={() => router.push(`/app/basket/${selected.id}`)}
                      onSlices={() => router.push(`/app/tranche/${selected.id}`)}
                    />
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </PageFrame>
    </>
  );
}

function SegmentedControl<V extends string | number>({
  value,
  onChange,
  options,
}: {
  value: V;
  onChange: (next: V) => void;
  options: Array<{ value: V; label: string }>;
}) {
  return (
    <div className="basket-segmented">
      {options.map((option) => (
        <button
          key={String(option.value)}
          className={option.value === value ? "is-active" : ""}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function BasketSelector({
  baskets,
  selectedId,
  vaultPrices,
  onSelect,
}: {
  baskets: BasketView[];
  selectedId: string | null;
  vaultPrices: Record<string, VaultPriceResponse>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="basket-selector">
      <div className="basket-selector-head">
        <div>
          <span>Selector</span>
          <strong>Available baskets</strong>
        </div>
        <em>{baskets.length} results</em>
      </div>
      <div className="basket-selector-table">
        <div className="basket-selector-row basket-selector-labels">
          <span>Basket</span>
          <span>NAV</span>
          <span>Issue</span>
          <span>Maturity</span>
          <span>Move</span>
        </div>
        {baskets.map((basket) => (
          <BasketSelectorRow
            key={basket.id}
            basket={basket}
            active={basket.id === selectedId}
            issuePrice={vaultPrices[basket.id]?.issue_price ?? basket.issue}
            onSelect={() => onSelect(basket.id)}
          />
        ))}
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
    <button
      type="button"
      className={`basket-selector-row ${active ? "is-active" : ""}`}
      onClick={onSelect}
    >
      <span className="basket-row-name">
        <i style={{ background: color }} />
        <span>
          <strong>{basket.id}</strong>
          <em>
            {TIER_LABEL[basket.tier]} / {WINDOW_LABEL[basket.window]}
          </em>
        </span>
      </span>
      <span>{(basket.nav * 100).toFixed(1)}%</span>
      <span>{formatPrice(issuePrice)}</span>
      <span>{formatDaysLeft(basket.daysLeft)}</span>
      <span style={{ color: positive ? C.green : C.red }}>
        {positive ? "+" : ""}
        {basket.change.toFixed(1)}%
      </span>
    </button>
  );
}

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

/**
 * Basket NAV trend — probability % on the Y-axis, time on the X-axis, with
 * timeframe tabs (1D pulls 5-min intraday history; 7D/30D/1Y slice the daily
 * series). NAV is a market probability in [0,1], rendered as a percentage.
 */
function BasketTrendChart({
  dayHistory,
  history,
  color,
}: {
  dayHistory?: number[];
  history: number[];
  color: string;
}) {
  const [range, setRange] = useState<TrendKey>("30D");
  // Measure the SVG wrapper so the chart fills its box EXACTLY. The previous
  // version set the SVG to width:100% with no height, so the browser sized it
  // from the viewBox aspect ratio — on a wide panel that made the SVG taller
  // than the fixed 204px card and it spilled over the metric cards below. By
  // driving the viewBox off the measured pixel width AND height, the SVG fills
  // the wrapper 1:1 (no overflow, no distortion) at any panel width.
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
    const raw =
      range === "1D"
        ? dayHistory && dayHistory.length > 2 ? dayHistory : history.slice(-2)
        : range === "7D"
          ? history.slice(-7)
          : range === "30D"
            ? history.slice(-30)
            : history;
    // Guard against malformed points: a non-finite or out-of-[0,1] value
    // (NAV is a probability) would scale off the plot box and bleed below
    // the card. Keep only valid probabilities; fall back to the raw slice
    // if sanitising leaves too little to draw.
    const clean = raw.filter((v) => Number.isFinite(v) && v > 0 && v <= 1);
    return clean.length >= 2 ? clean : raw.length >= 2 ? raw : [raw[0] ?? 0, raw[0] ?? 0];
  }, [range, dayHistory, history]);

  const W = dim.w, H = dim.h, PL = 44, PR = 10, PT = 10, PB = 22;
  const n = series.length;
  const lo = Math.min(...series), hi = Math.max(...series);
  const pad = (hi - lo) * 0.18 || 0.01;
  const yMin = Math.max(0, lo - pad), yMax = Math.min(1, hi + pad);
  const sx = (i: number) => PL + (i / Math.max(1, n - 1)) * (W - PL - PR);
  // Clamp every plotted y into the plot box so a stray point can never draw
  // outside it (defence-in-depth alongside the clipPath in the SVG).
  const sy = (v: number) => {
    const y = PT + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PT - PB);
    return Math.max(PT, Math.min(H - PB, y));
  };
  const pts = series.map((v, i) => [sx(i), sy(v)] as [number, number]);
  const line = monotonePath(pts);
  const area = `${line} L ${sx(n - 1)} ${H - PB} L ${sx(0)} ${H - PB} Z`;
  const yTicks = [yMax, (yMax + yMin) / 2, yMin];
  const xLabels = trendXLabels(range);
  const clipId = `bt-clip-${range}`;

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
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          style={{ display: "block", position: "absolute", inset: 0 }}
        >
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
            <text
              key={i}
              x={PL + f * (W - PL - PR)}
              y={H - 6}
              textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
              fill={C.textMuted}
              fontFamily={FM}
              fontSize="9.5"
            >
              {xLabels[i]}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

function SelectedBasketPanel({
  basket,
  vaultPrice,
  onOpen,
  onSlices,
}: {
  basket: BasketView;
  vaultPrice: number | null | undefined;
  onOpen: () => void;
  onSlices: () => void;
}) {
  const color = tc(basket.tier);
  const positive = basket.change >= 0;
  const marketVolume = basket.markets.reduce((sum, market) => sum + market.volumeUsd, 0);
  const topMarkets = basket.markets.slice(0, 6);

  return (
    <div className="basket-detail">
      <div className="basket-detail-head">
        <div>
          <span style={{ color }}>{TIER_LABEL[basket.tier]} / {WINDOW_LABEL[basket.window]}</span>
          <h2>{basket.id}</h2>
        </div>
        <div className="basket-nav">
          <strong style={{ color }}>{(basket.nav * 100).toFixed(1)}%</strong>
          <em>${basket.nav.toFixed(3)} NAV</em>
        </div>
      </div>

      <div className="basket-chart">
        <BasketTrendChart dayHistory={basket.dayHistory} history={basket.history} color={color} />
      </div>

      <div className="basket-metrics">
        <MetricCell label="Issue price" value={formatPrice(vaultPrice)} />
        <MetricCell label="24h move" value={`${positive ? "+" : ""}${basket.change.toFixed(1)}%`} tone={positive ? "positive" : "negative"} />
        <MetricCell label="Maturity" value={formatDaysLeft(basket.daysLeft)} />
        <MetricCell label="Legs" value={basket.totalLegs.toLocaleString("en-US")} />
        <MetricCell label="Market volume" value={basket.live ? formatCompactUsd(marketVolume) : "-"} />
        <MetricCell label="Route" value="Sui testnet" />
      </div>

      <div className="basket-detail-actions">
        <button type="button" className="basket-action-primary" onClick={onOpen}>
          Open basket
        </button>
        <button type="button" className="basket-action-secondary" onClick={onSlices}>
          View risk slices
        </button>
      </div>

      <div className="basket-constituents">
        <div className="basket-section-head">
          <span>Underlying markets</span>
          <strong>{basket.live ? `${basket.markets.length} legs` : "Seed data"}</strong>
        </div>
        {topMarkets.length > 0 ? (
          <div className="basket-market-list">
            {topMarkets.map((market) => (
              <div key={market.id} className="basket-market-row">
                <span>
                  <strong>{market.question}</strong>
                  <em>{market.side} / {(market.weight * 100).toFixed(1)}% weight</em>
                </span>
                <b>{(market.probability * 100).toFixed(1)}%</b>
                <i>{formatCompactUsd(market.volumeUsd)}</i>
              </div>
            ))}
          </div>
        ) : (
          <div className="basket-market-empty">
            Constituents will appear when market data is available.
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  const color = tone === "positive" ? C.green : tone === "negative" ? C.red : C.textPrimary;
  return (
    <div className="basket-metric-cell">
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  );
}

function BasketLoading() {
  return (
    <div className="basket-workspace">
      <div className="basket-selector basket-skeleton" />
      <div className="basket-detail basket-skeleton" />
    </div>
  );
}

function BasketEmpty({ onReset }: { onReset: () => void }) {
  return (
    <div className="basket-empty">
      <strong>No baskets match the current filters.</strong>
      <button type="button" onClick={onReset}>
        Reset filters
      </button>
    </div>
  );
}

const BASKET_CSS = `
  .basket-shell { max-width: 1320px; margin: 0 auto; display: grid; gap: 14px; min-width: 0; }
  .basket-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 16px; padding: 0 0 4px; }
  .basket-hero h1 { margin: 0; color: ${C.textPrimary}; font-family: ${FD}; font-size: 34px; line-height: 1.08; letter-spacing: -0.025em; font-weight: 600; }
  .basket-hero p { max-width: 620px; margin: 8px 0 0; color: ${C.textSecondary}; font-family: ${FS}; font-size: 13px; line-height: 1.55; }
  .basket-selector-head span, .basket-section-head span, .basket-metric-cell span { color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; }
  .basket-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .basket-segmented { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; border: 0.5px solid ${C.border}; background: ${C.surface}; }
  .basket-segmented button { appearance: none; border: 0; background: transparent; border-radius: 999px; min-width: 58px; height: 30px; padding: 0 13px; color: ${C.textSecondary}; font-family: ${FD}; font-size: 12px; font-weight: 520; cursor: pointer; transition: background 0.14s ${EASE}, color 0.14s ${EASE}; }
  .basket-segmented button:hover { color: ${C.textPrimary}; }
  .basket-segmented button.is-active { background: ${C.card}; color: ${C.textPrimary}; }
  .basket-warning { border: 0.5px solid rgba(217, 119, 6, 0.24); background: rgba(217, 119, 6, 0.06); color: #fbbf24; border-radius: 8px; padding: 10px 12px; font-family: ${FM}; font-size: 10.5px; letter-spacing: 0.03em; }
  .basket-workspace { display: grid; grid-template-columns: minmax(520px, 0.86fr) minmax(420px, 1.14fr); gap: 14px; align-items: stretch; min-width: 0; }
  .basket-selector, .basket-detail { min-width: 0; border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 8px; }
  .basket-selector { overflow: hidden; display: flex; flex-direction: column; }
  .basket-selector-head { display: flex; align-items: end; justify-content: space-between; gap: 14px; padding: 14px 14px 12px; border-bottom: 0.5px solid ${C.border}; }
  .basket-selector-head div { display: grid; gap: 5px; }
  .basket-selector-head strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; font-weight: 620; }
  .basket-selector-head em { color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; font-style: normal; white-space: nowrap; }
  .basket-selector-table { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
  .basket-selector-row { width: 100%; flex: 1 1 0; min-height: 64px; display: grid; grid-template-columns: minmax(190px, 1.55fr) 76px 86px 92px 74px; gap: 12px; align-items: center; border: 0; border-bottom: 0.5px solid ${C.border}; background: transparent; color: ${C.textSecondary}; padding: 12px 14px; text-align: left; font-family: ${FD}; cursor: pointer; transition: background 0.14s ${EASE}, color 0.14s ${EASE}; }
  .basket-selector-row:last-child { border-bottom: 0; }
  .basket-selector-row:hover, .basket-selector-row.is-active { background: ${C.surface}; color: ${C.textPrimary}; }
  .basket-selector-row.is-active { box-shadow: inset 2px 0 0 ${C.tealLight}; }
  .basket-selector-labels { flex: 0 0 auto; min-height: 0; cursor: default; background: ${C.surface}; color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; padding-top: 9px; padding-bottom: 9px; }
  .basket-selector-labels:hover { background: ${C.surface}; color: ${C.textMuted}; }
  .basket-selector-row > span:not(.basket-row-name) { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .basket-row-name { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
  .basket-row-name i { width: 6px; height: 6px; border-radius: 999px; flex: 0 0 auto; }
  .basket-row-name span { min-width: 0; display: grid; gap: 3px; }
  .basket-row-name strong { color: ${C.textPrimary}; font-size: 13px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .basket-row-name em { color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .basket-detail { padding: 16px; display: grid; gap: 14px; }
  .basket-detail-head { display: flex; justify-content: space-between; align-items: start; gap: 18px; }
  .basket-detail-head span { display: block; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; margin-bottom: 7px; }
  .basket-detail-head h2 { margin: 0; color: ${C.textPrimary}; font-family: ${FD}; font-size: 24px; line-height: 1.1; letter-spacing: -0.02em; font-weight: 620; }
  .basket-nav { text-align: right; display: grid; gap: 3px; }
  .basket-nav strong { font-family: ${FD}; font-size: 30px; line-height: 1; font-weight: 520; font-variant-numeric: tabular-nums; }
  .basket-nav em { color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; font-style: normal; }
  .basket-chart { height: 216px; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; padding: 10px 12px; overflow: hidden; }
  .basket-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .basket-metric-cell { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; padding: 12px; display: grid; gap: 7px; min-height: 72px; align-content: center; }
  .basket-metric-cell strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; font-weight: 620; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .basket-detail-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .basket-detail-actions button, .basket-empty button { height: 42px; border-radius: 8px; font-family: ${FD}; font-size: 13px; font-weight: 620; cursor: pointer; transition: background 0.14s ${EASE}, border-color 0.14s ${EASE}, color 0.14s ${EASE}; }
  .basket-action-primary { border: 0.5px solid ${C.tealLight}; background: ${C.tealLight}; color: #03111d; }
  .basket-action-primary:hover { background: ${C.teal}; border-color: ${C.teal}; }
  .basket-action-secondary, .basket-empty button { border: 0.5px solid ${C.border}; background: ${C.surface}; color: ${C.textPrimary}; }
  .basket-action-secondary:hover, .basket-empty button:hover { border-color: ${C.borderHover}; background: ${C.cardHover}; }
  .basket-constituents { display: grid; gap: 10px; }
  .basket-section-head { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
  .basket-section-head strong { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; font-weight: 520; white-space: nowrap; }
  .basket-market-list { border: 0.5px solid ${C.border}; border-radius: 8px; overflow: hidden; }
  .basket-market-row { display: grid; grid-template-columns: minmax(0, 1fr) 74px 76px; gap: 12px; align-items: center; padding: 10px 11px; border-bottom: 0.5px solid ${C.border}; background: ${C.surface}; }
  .basket-market-row:last-child { border-bottom: 0; }
  .basket-market-row span { min-width: 0; display: grid; gap: 3px; }
  .basket-market-row strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 12px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .basket-market-row em { color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .basket-market-row b, .basket-market-row i { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; font-style: normal; font-weight: 620; text-align: right; font-variant-numeric: tabular-nums; }
  .basket-market-empty, .basket-empty { border: 0.5px dashed ${C.border}; background: ${C.surface}; border-radius: 8px; color: ${C.textMuted}; font-family: ${FS}; font-size: 12px; line-height: 1.5; padding: 26px; text-align: center; }
  .basket-empty { display: grid; justify-items: center; gap: 14px; padding: 54px 24px; }
  .basket-empty strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 16px; font-weight: 620; }
  .basket-skeleton { min-height: 520px; opacity: 0.62; position: relative; overflow: hidden; }
  .basket-skeleton::after { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 35%, rgba(255,255,255,0.035) 50%, transparent 65%); animation: basket-loading 1.8s ease-in-out infinite; }
  @keyframes basket-loading { 0% { transform: translateX(-70%); } 100% { transform: translateX(70%); } }
  @media (max-width: 1180px) {
    .basket-hero, .basket-workspace { grid-template-columns: 1fr; }
  }
  @media (max-width: 760px) {
    .basket-controls, .basket-segmented { width: 100%; }
    .basket-segmented button { flex: 1; min-width: 0; }
    .basket-selector-row { grid-template-columns: minmax(0, 1fr) 64px; gap: 10px; }
    .basket-selector-row > span:nth-child(3), .basket-selector-row > span:nth-child(4), .basket-selector-row > span:nth-child(5) { display: none; }
    .basket-metrics, .basket-detail-actions { grid-template-columns: 1fr; }
    .basket-detail-head { flex-direction: column; }
    .basket-nav { text-align: left; }
    .basket-market-row { grid-template-columns: minmax(0, 1fr) 66px; }
    .basket-market-row i { display: none; }
  }
`;
