"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE, fmtUsd } from "../_lib/tokens";
import {
  DistributionBand,
  DistributionCandidate,
  DistributionLaunchPlan,
  DistributionQuote,
  buildLaunchPlan,
  fetchDistributionCandidates,
  quoteDistribution,
} from "../_lib/distribution-client";

const PANEL: React.CSSProperties = {
  background: C.card,
  border: `0.5px solid ${C.border}`,
  borderRadius: 8,
};

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function usd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return fmtUsd(value, 0);
}

function normalizeWeights(weights: number[]): number[] {
  const sum = weights.reduce((acc, n) => acc + Math.max(0, n), 0);
  if (sum <= 0) return weights.map(() => 100 / Math.max(1, weights.length));
  const normalized = weights.map((n) => Math.round((Math.max(0, n) / sum) * 10000) / 100);
  const roundedSum = normalized.reduce((acc, value) => acc + value, 0);
  const index = normalized.reduce((best, value, i) => value > normalized[best] ? i : best, 0);
  normalized[index] = Math.round((normalized[index] + 100 - roundedSum) * 100) / 100;
  return normalized;
}

function cleanWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

function weightsFromCurve(curve: number[]): number[] {
  if (curve.length === 0) return [];
  const weights = curve.map((value) => Math.round(value * 10000) / 100);
  const sum = weights.reduce((acc, value) => acc + value, 0);
  const index = weights.reduce((best, value, i) => value > weights[best] ? i : best, 0);
  weights[index] = Math.round((weights[index] + 100 - sum) * 100) / 100;
  return weights;
}

function scoreColor(score: number): string {
  if (score >= 78) return C.tealLight;
  if (score >= 62) return C.blue;
  return C.amber;
}

function outcomeLabel(value: DistributionCandidate["outcome_type"]): string {
  return value.replaceAll("_", " ");
}

function bandMagnitude(label: string): number | null {
  const lower = label.toLowerCase();
  if (lower.includes("not ipo") || lower.startsWith("no ")) return -1;
  const match = lower.match(/\$?\s*(\d+(?:\.\d+)?)\s*([tmbk])?/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2];
  if (unit === "t") return value * 1000;
  if (unit === "m") return value / 1000;
  if (unit === "k") return value / 1_000_000;
  return value;
}

function bandOrder(candidate: DistributionCandidate): number[] {
  const sortable = candidate.outcome_type === "price_level" || candidate.outcome_type === "numeric_range" || candidate.outcome_type === "count";
  const natural = candidate.bands.map((_, index) => index);
  if (!sortable) return natural;
  const scored = candidate.bands.map((band, index) => ({ index, value: bandMagnitude(band.label) }));
  if (scored.every((row) => row.value === null)) return natural;
  return scored
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return a.value - b.value || a.index - b.index;
    })
    .map((row) => row.index);
}

function signedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${pct(value)}`;
}

function signedUsd(value: number): string {
  if (Math.abs(value) < 0.005) return "+$0.00";
  return `${value > 0 ? "+" : "-"}${fmtUsd(Math.abs(value), 2)}`;
}

function firstBandIndex(candidate: DistributionCandidate): number {
  return bandOrder(candidate)[0] ?? 0;
}

function Metric({
  label,
  value,
  color,
  align = "left",
}: {
  label: string;
  value: string;
  color?: string;
  align?: "left" | "right";
}) {
  return (
    <div style={{ textAlign: align }}>
      <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ color: color ?? C.textPrimary, fontFamily: FD, fontSize: 14, fontWeight: 500, letterSpacing: "-0.005em", marginTop: 4, overflowWrap: "anywhere" }}>
        {value}
      </div>
    </div>
  );
}

function MiniCurve({ values }: { values: number[] }) {
  const width = 62;
  const height = 28;
  const max = Math.max(...values, 0.01);
  const x = (index: number) => (index / Math.max(1, values.length - 1)) * width;
  const y = (value: number) => height - (value / max) * height;
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      <polyline points={points} fill="none" stroke={C.tealLight} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
    </svg>
  );
}

function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function CurveSvg({
  candidate,
  target,
  quote,
  order,
  selectedBandIndex,
  onSelectBand,
}: {
  candidate: DistributionCandidate;
  target: number[];
  quote: DistributionQuote | null;
  order: number[];
  selectedBandIndex: number;
  onSelectBand: (index: number) => void;
}) {
  const width = 980;
  const height = 250;
  const padX = 46;
  const padY = 30;
  const displayOrder = order.length ? order : candidate.bands.map((_, index) => index);
  const referenceSeries = displayOrder.map((index) => candidate.reference_curve[index] ?? 0);
  const rawTargetSeries = quote?.target_curve ?? target;
  const targetSeries = displayOrder.map((index) => rawTargetSeries[index] ?? 0);
  const values = referenceSeries.map((value, index) => Math.max(value, targetSeries[index] ?? 0));
  const max = Math.max(...values, 0.02) * 1.2;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2 - 26;
  const baseline = padY + plotH;
  const x = (index: number) => padX + (index / Math.max(1, displayOrder.length - 1)) * plotW;
  const y = (value: number) => padY + plotH - (value / max) * plotH;
  const targetPoints = targetSeries.map((value, index) => ({ x: x(index), y: y(value) }));
  const referencePoints = referenceSeries.map((value, index) => ({ x: x(index), y: y(value) }));
  const targetLine = smoothPath(targetPoints);
  const referenceLine = smoothPath(referencePoints);
  const targetArea = `${targetLine} L ${x(targetSeries.length - 1)} ${baseline} L ${x(0)} ${baseline} Z`;
  const selectedDisplayIndex = Math.max(0, displayOrder.indexOf(selectedBandIndex));
  const selectedTarget = targetSeries[selectedDisplayIndex] ?? 0;
  const selectedMarket = referenceSeries[selectedDisplayIndex] ?? 0;
  const gridTicks = [0, 0.25, 0.5, 0.75, 1];
  const showAllPointLabels = displayOrder.length <= 8;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" className="dist-curve" role="img" aria-label="Reference and target distribution curves">
      <defs>
        <linearGradient id="distTargetFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={C.tealLight} stopOpacity="0.18" />
          <stop offset="100%" stopColor={C.tealLight} stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect x={padX} y={padY} width={plotW} height={plotH} rx="8" fill={C.surface} opacity="0.26" />
      {gridTicks.map((t) => {
        const yPos = padY + t * plotH;
        const labelValue = t === 1 ? 0 : max * (1 - t);
        return (
          <g key={t}>
            <line x1={padX} x2={padX + plotW} y1={yPos} y2={yPos} stroke={C.border} strokeWidth="1" opacity={t === 1 ? "0.72" : "0.44"} />
            <text x={padX - 10} y={yPos + 4} fill={C.textMuted} fontFamily={FM} fontSize="10" textAnchor="end">
              {pct(labelValue, 0)}
            </text>
          </g>
        );
      })}

      {referenceSeries.map((value, index) => {
        const originalIndex = displayOrder[index];
        const barW = Math.max(7, Math.min(16, plotW / Math.max(22, displayOrder.length * 2.7)));
        const barH = Math.max(2, baseline - y(value));
        return (
          <g key={candidate.bands[originalIndex]?.id ?? index}>
            <rect
              x={x(index) - barW / 2}
              y={baseline - barH}
              width={barW}
              height={barH}
              rx="2.5"
              fill={originalIndex === selectedBandIndex ? C.tealLight : C.textMuted}
              opacity={originalIndex === selectedBandIndex ? "0.34" : "0.18"}
            />
          </g>
        );
      })}

      <path d={targetArea} fill="url(#distTargetFill)" />
      <path d={referenceLine} fill="none" stroke={C.textMuted} strokeWidth="2" strokeDasharray="5 7" opacity="0.58" strokeLinecap="round" />
      <path d={targetLine} fill="none" stroke={C.tealLight} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {targetPoints.map((point, index) => {
        const originalIndex = displayOrder[index];
        const selected = originalIndex === selectedBandIndex;
        if (!showAllPointLabels && !selected) return null;
        return (
          <g key={`target-label-${candidate.bands[originalIndex]?.id ?? index}`}>
            <circle cx={point.x} cy={point.y} r={selected ? "4.5" : "3"} fill={C.tealLight} stroke={C.bg} strokeWidth="1.6" opacity={selected ? "1" : "0.78"} />
            <text
              x={point.x}
              y={Math.max(12, point.y - 9)}
              fill={selected ? C.textPrimary : C.textSecondary}
              fontFamily={FM}
              fontSize="9"
              textAnchor="middle"
            >
              {pct(targetSeries[index] ?? 0)}
            </text>
          </g>
        );
      })}

      {targetSeries.map((value, index) => {
        const originalIndex = displayOrder[index];
        const hitW = plotW / Math.max(1, displayOrder.length - 1);
        return (
          <rect
            key={candidate.bands[originalIndex]?.id ?? index}
            x={x(index) - hitW / 2}
            y={padY}
            width={hitW}
            height={plotH}
            fill="transparent"
            onClick={() => onSelectBand(originalIndex)}
            style={{ cursor: "pointer" }}
          />
        );
      })}
      <line x1={x(selectedDisplayIndex)} x2={x(selectedDisplayIndex)} y1={padY} y2={baseline} stroke={C.tealLight} strokeWidth="1" opacity="0.28" />
      <circle cx={x(selectedDisplayIndex)} cy={y(selectedMarket)} r="4" fill={C.textMuted} opacity="0.7" />
      <circle cx={x(selectedDisplayIndex)} cy={y(selectedTarget)} r="5.5" fill={C.tealLight} stroke={C.bg} strokeWidth="2" />
      <text x={padX} y={height - 8} fill={C.textMuted} fontFamily={FM} fontSize="10" letterSpacing="1.2">
        MARKET DEPTH
      </text>
      <text x={padX + plotW} y={height - 8} fill={C.tealLight} fontFamily={FM} fontSize="10" letterSpacing="1.2" textAnchor="end">
        TARGET CURVE
      </text>
    </svg>
  );
}

function CandidateRow({
  candidate,
  active,
  onClick,
}: {
  candidate: DistributionCandidate;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="dist-candidate"
      style={{
        border: `0.5px solid ${active ? C.tealLight : C.border}`,
        borderRadius: 8,
        background: active ? `${C.tealLight}0f` : C.card,
        padding: "12px 13px",
        width: "100%",
        cursor: "pointer",
        textAlign: "left",
        transition: `all 0.16s ${EASE}`,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "start" }}>
        <div>
          <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 13, fontWeight: 500, letterSpacing: "-0.005em", lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {candidate.title}
          </div>
          <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.04em", marginTop: 6 }}>
            {outcomeLabel(candidate.outcome_type)} · {candidate.band_count} ranges · {candidate.days_to_resolution ?? "-"}d
          </div>
        </div>
        <MiniCurve values={candidate.reference_curve} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "54px 1fr 1fr", gap: 8, marginTop: 11 }}>
        <Metric label="Score" value={candidate.launch_score.toFixed(1)} color={scoreColor(candidate.launch_score)} />
        <Metric label="Volume" value={usd(candidate.aggregate_volume_usd)} />
        <Metric label="Depth" value={usd(candidate.aggregate_depth_usd)} />
      </div>
    </button>
  );
}

function RangeTable({
  candidate,
  weights,
  quote,
  order,
  updateWeight,
  selectedBandIndex,
  onSelectBand,
  total,
  normalize,
}: {
  candidate: DistributionCandidate;
  weights: number[];
  quote: DistributionQuote | null;
  order: number[];
  updateWeight: (index: number, value: number) => void;
  selectedBandIndex: number;
  onSelectBand: (index: number) => void;
  total: number;
  normalize: () => void;
}) {
  const totalDelta = total - 100;
  return (
    <section style={{ ...PANEL, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div>
          <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}>
            Outcome ladder
          </div>
        </div>
        <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10 }}>
          {candidate.band_count} ranges
        </div>
      </div>

      <div className="dist-range-head">
        <span>Outcome</span>
        <span>Market vs yours</span>
        <span>Target %</span>
        <span>Payout</span>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {(order.length ? order : candidate.bands.map((_, index) => index)).map((index, rank) => {
          const band = candidate.bands[index];
          const target = quote?.target_curve[index] ?? weights[index] / 100;
          const reference = candidate.reference_curve[index] ?? band.normalized_probability;
          const position = quote?.pnl_curve[index]?.position_usdc ?? 0;
          const trade = target - reference;
          return (
            <div
              key={band.id}
              className="dist-range-row"
              onClick={() => onSelectBand(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onSelectBand(index);
              }}
              role="button"
              tabIndex={0}
              style={{ borderColor: index === selectedBandIndex ? C.tealLight : C.border, background: index === selectedBandIndex ? `${C.tealLight}10` : C.surface }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span className="dist-range-index">{rank + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 13, fontWeight: 500, letterSpacing: "-0.005em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {band.label}
                    </div>
                    <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, marginTop: 3 }}>
                      {pct(band.probability)} · depth {usd(band.depth_usd)}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div className="dist-bar-line">
                  <span>Market</span>
                  <div className="dist-meter">
                    <span style={{ width: `${Math.max(1, Math.min(100, reference * 100))}%`, background: C.textMuted, opacity: 0.42 }} />
                  </div>
                  <strong>{pct(reference)}</strong>
                </div>
                <div className="dist-bar-line">
                  <span>Yours</span>
                  <div className="dist-meter">
                    <span style={{ width: `${Math.max(1, Math.min(100, target * 100))}%`, background: C.tealLight }} />
                  </div>
                  <strong style={{ color: C.textPrimary }}>{pct(target)}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", color: C.textMuted, fontFamily: FM, fontSize: 10, marginTop: 5 }}>
                  <span>{trade >= 0 ? "overweight" : "underweight"}</span>
                  <span style={{ color: trade >= 0 ? C.green : C.coral }}>{signedPct(trade)}</span>
                </div>
              </div>

              <div className="dist-control" onClick={(event) => event.stopPropagation()}>
                <button className="dist-tap" onClick={() => updateWeight(index, Math.max(0, (weights[index] ?? 0) - 2.5))}>-</button>
                <input
                  className="dist-input"
                  aria-label={`${band.label} target weight`}
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={weights[index] ?? 0}
                  onChange={(event) => updateWeight(index, Number(event.target.value))}
                />
                <button className="dist-tap" onClick={() => updateWeight(index, (weights[index] ?? 0) + 2.5)}>+</button>
              </div>

              <div style={{ color: position >= 0 ? C.green : C.coral, fontFamily: FM, fontSize: 12, fontWeight: 800, textAlign: "right" }}>
                {signedUsd(position)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="dist-total-row">
        <span>Total probability</span>
        <strong style={{ color: Math.abs(totalDelta) < 0.05 ? C.green : C.amber }}>{total.toFixed(1)}%</strong>
        {Math.abs(totalDelta) >= 0.05 && (
          <button onClick={normalize}>
            {totalDelta > 0 ? `${totalDelta.toFixed(1)}% over` : `${Math.abs(totalDelta).toFixed(1)}% unassigned`} · auto-normalize
          </button>
        )}
      </div>
    </section>
  );
}

function DistributionLoadingState() {
  return (
    <div className="dist-loading-grid" aria-label="Loading distribution market candidates">
      <aside className="dist-loading-rail">
        <div className="dist-loading-card">
          <div className="dist-loading-label">Markets</div>
          <div className="dist-loading-pill">Loading markets</div>
        </div>
        <div className="dist-loading-label">Markets</div>
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="dist-loading-card">
            <div className="dist-shimmer" style={{ width: "78%" }} />
            <div className="dist-shimmer small" style={{ width: "54%" }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 14 }}>
              <div className="dist-shimmer tiny" />
              <div className="dist-shimmer tiny" />
              <div className="dist-shimmer tiny" />
            </div>
          </div>
        ))}
      </aside>
      <main className="dist-loading-main">
        <section style={{ ...PANEL, padding: "18px 20px" }}>
          <div className="dist-loading-label">Selected distribution surface</div>
          <div className="dist-shimmer title" />
          <div className="dist-shimmer small" style={{ width: "42%", marginTop: 14 }} />
        </section>
        <section style={{ ...PANEL, padding: "18px 20px" }}>
          <div className="dist-loading-label">Market distribution vs your proposed distribution</div>
          <div className="dist-loading-chart">
            <div className="dist-loading-wave" />
          </div>
        </section>
      </main>
    </div>
  );
}

export default function DistributionMarketsPage() {
  const [candidates, setCandidates] = useState<DistributionCandidate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedBandIndex, setSelectedBandIndex] = useState(0);
  const [showAllMarkets, setShowAllMarkets] = useState(false);
  const [weights, setWeights] = useState<number[]>([]);
  const [collateral, setCollateral] = useState("100");
  const [quote, setQuote] = useState<DistributionQuote | null>(null);
  const [launchPlan, setLaunchPlan] = useState<DistributionLaunchPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) ?? null,
    [candidates, selectedId],
  );
  const targetCurve = useMemo(() => normalizeWeights(weights).map((weight) => weight / 100), [weights]);
  const total = weights.reduce((acc, n) => acc + n, 0);
  const railCandidates = useMemo(() => {
    if (showAllMarkets) return candidates;
    const visible = candidates.slice(0, 7);
    if (!selected || visible.some((candidate) => candidate.id === selected.id)) return visible;
    return [...visible.slice(0, 6), selected];
  }, [candidates, selected, showAllMarkets]);
  const selectedBand = selected?.bands[selectedBandIndex] ?? selected?.bands[0] ?? null;
  const bandIndices = useMemo(
    () => selected ? bandOrder(selected) : [],
    [selected],
  );
  const selectedBandRank = bandIndices.indexOf(selectedBandIndex);
  const selectedRankLabel = selectedBandRank >= 0 ? selectedBandRank + 1 : selectedBandIndex + 1;
  async function load(refresh = false) {
    setError(null);
    try {
      const result = await fetchDistributionCandidates({ limit: 16, refresh });
      setCandidates(result.candidates);
      const currentStillExists = result.candidates.some((candidate) => candidate.id === selectedId);
      const next = currentStillExists
        ? result.candidates.find((candidate) => candidate.id === selectedId)
        : result.candidates[0];
      if (next && (!selectedId || !currentStillExists)) {
        setSelectedId(next.id);
        setSelectedBandIndex(firstBandIndex(next));
        setWeights(weightsFromCurve(next.reference_curve));
        setLaunchPlan(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load markets");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(true), 45_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selected || weights.length !== selected.bands.length) return;
    const collateralUsdc = Number(collateral);
    if (!Number.isFinite(collateralUsdc) || collateralUsdc <= 0) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const next = await quoteDistribution({
          candidateId: selected.id,
          weights,
          collateralUsdc,
        });
        if (!cancelled) {
          setQuote(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Quote failed");
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [collateral, selected, weights]);

  useEffect(() => {
    if (selected && selectedBandIndex >= selected.bands.length) setSelectedBandIndex(firstBandIndex(selected));
  }, [selected, selectedBandIndex]);

  function selectCandidate(candidate: DistributionCandidate) {
    setSelectedId(candidate.id);
    setSelectedBandIndex(firstBandIndex(candidate));
    setWeights(weightsFromCurve(candidate.reference_curve));
    setQuote(null);
    setLaunchPlan(null);
    setError(null);
  }

  function updateWeight(index: number, value: number) {
    setWeights((current) => current.map((weight, i) => i === index ? cleanWeight(value) : weight));
  }

  function normalizeCurrentWeights() {
    setWeights((current) => normalizeWeights(current));
  }

  async function stageLaunch() {
    if (!selected) return;
    try {
      setLaunchPlan(await buildLaunchPlan(selected.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build launch plan");
    }
  }

  return (
    <>
      <Header />
      <PageFrame wide>
        <style>{`
          .dist-shell { width: 100%; max-width: 1500px; margin: 0 auto; }
          .dist-workspace {
            display: grid; grid-template-columns: minmax(260px, 300px) minmax(0, 1fr); gap: 16px;
            align-items: start;
          }
          .dist-list {
            display: grid; gap: 7px; align-content: start;
          }
          .dist-main {
            display: grid; gap: 14px; min-width: 0; align-content: start;
          }
          .dist-candidate:hover { border-color: ${C.borderHover} !important; background: ${C.cardHover} !important; }
          .dist-rail-toggle {
            height: 36px; border: 0.5px solid ${C.border}; border-radius: 8px; background: ${C.surface};
            color: ${C.textSecondary}; cursor: pointer; font-family: ${FD}; font-size: 12px;
          }
          .dist-rail-toggle:hover { border-color: ${C.borderHover}; color: ${C.textPrimary}; }
          .dist-hero-grid { display: grid; grid-template-columns: 1fr; gap: 12px; align-items: stretch; }
          .dist-chart-head { display: grid; grid-template-columns: minmax(0, 1fr) repeat(4, max-content); gap: 18px; align-items: end; margin-bottom: 10px; }
          .dist-legend { display: flex; align-items: center; gap: 14px; color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; margin-bottom: 6px; }
          .dist-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
          .dist-legend i { width: 22px; height: 3px; border-radius: 99px; display: inline-block; }
          .dist-curve { min-height: 236px; max-height: 270px; display: block; }
          .dist-metric-panel {
            border-top: 0.5px solid ${C.border}; padding-top: 12px;
            display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
            align-items: end; gap: 12px;
          }
          .dist-money-field { grid-column: span 2; }
          .dist-button-pair { grid-column: span 2; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
          .dist-action { grid-column: span 2; }
          .dist-focus-strip {
            display: grid; grid-template-columns: 24px minmax(0, 1fr) repeat(4, max-content); gap: 10px; align-items: center;
            border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; padding: 8px 10px; margin-top: 8px;
          }
          .dist-focus-strip span {
            width: 22px; height: 22px; display: inline-grid; place-items: center; border-radius: 50%;
            border: 0.5px solid ${C.tealLight}; color: ${C.tealLight}; font-family: ${FM}; font-size: 10px;
          }
          .dist-focus-strip strong { color: ${C.textPrimary}; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .dist-focus-strip em { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; font-style: normal; white-space: nowrap; }
          .dist-input {
            width: 74px; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 7px;
            color: ${C.textPrimary}; font-family: ${FM}; font-size: 12px; padding: 7px 8px; text-align: center;
          }
          .dist-input:focus { outline: none; border-color: ${C.tealLight} !important; box-shadow: 0 0 0 3px ${C.tealLight}22; }
          .dist-money-field { display: grid; gap: 6px; color: ${C.textSecondary}; font-family: ${FS}; font-size: 12px; }
          .dist-money-input {
            display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center;
            width: 100%; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 7px;
            padding: 0 8px;
          }
          .dist-money-input span { color: ${C.textMuted}; font-family: ${FM}; font-size: 12px; }
          .dist-money-input .dist-input { width: 100%; border: 0; background: transparent; padding-left: 5px; box-shadow: none; }
          .dist-money-input .dist-input:focus { border-color: transparent !important; box-shadow: none; }
          .dist-money-input:focus-within { border-color: ${C.tealLight}; box-shadow: 0 0 0 3px ${C.tealLight}22; }
          .dist-tap {
            width: 28px; height: 28px; border-radius: 7px; border: 0.5px solid ${C.border};
            background: ${C.card}; color: ${C.textPrimary}; cursor: pointer; font-family: ${FD}; font-size: 14px; line-height: 1;
          }
          .dist-tap:hover { border-color: ${C.tealLight}; color: ${C.tealLight}; }
          .dist-action:hover { border-color: ${C.borderHover} !important; background: ${C.blue} !important; }
          .dist-range-head {
            display: grid; grid-template-columns: minmax(220px, 1.35fr) minmax(190px, 1fr) 126px 82px;
            gap: 12px; color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em;
            text-transform: uppercase; padding: 0 12px 10px;
          }
          .dist-range-row {
            display: grid; grid-template-columns: minmax(220px, 1.35fr) minmax(190px, 1fr) 126px 82px;
            gap: 12px; align-items: center; border: 0.5px solid ${C.border}; border-radius: 8px;
            background: ${C.surface}; padding: 9px 12px; text-align: left; cursor: pointer;
          }
          .dist-range-row:focus { outline: none; border-color: ${C.tealLight}; box-shadow: 0 0 0 3px ${C.tealLight}18; }
          .dist-range-index {
            width: 22px; height: 22px; border-radius: 50%; border: 0.5px solid ${C.border};
            display: inline-grid; place-items: center; color: ${C.tealLight}; font-family: ${FM}; font-size: 10px; flex: 0 0 auto;
          }
          .dist-bar-line { display: grid; grid-template-columns: 42px minmax(0, 1fr) 46px; gap: 7px; align-items: center; margin-bottom: 4px; }
          .dist-bar-line span { color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; }
          .dist-bar-line strong { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; text-align: right; }
          .dist-meter { height: 5px; border-radius: 999px; background: ${C.card}; overflow: hidden; border: 0.5px solid ${C.border}; }
          .dist-meter span { display: block; height: 100%; border-radius: 999px; }
          .dist-control { display: flex; align-items: center; justify-content: flex-end; gap: 7px; }
          .dist-total-row {
            margin-top: 12px; border: 0.5px solid ${C.border}; border-radius: 8px; background: ${C.surface};
            padding: 10px; display: flex; align-items: center; justify-content: flex-end; gap: 10px;
            color: ${C.textSecondary}; font-family: ${FS}; font-size: 12px;
          }
          .dist-total-row span { margin-right: auto; color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; }
          .dist-total-row button { border: 0.5px solid ${C.amber}; background: ${C.amber}12; color: ${C.amber}; border-radius: 6px; padding: 7px 9px; cursor: pointer; }
          .dist-loading-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 16px; align-items: start; }
          .dist-loading-rail, .dist-loading-main { display: grid; gap: 12px; }
          .dist-loading-card {
            border: 0.5px solid ${C.border}; border-radius: 8px; background: ${C.card}; padding: 14px;
            min-height: 88px; overflow: hidden;
          }
          .dist-loading-label {
            color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em;
            text-transform: uppercase; margin-bottom: 12px;
          }
          .dist-loading-pill {
            border: 0.5px solid ${C.border}; border-radius: 8px; color: ${C.textSecondary};
            background: ${C.surface}; font-family: ${FS}; font-size: 13px; padding: 10px 12px;
          }
          .dist-shimmer {
            height: 13px; border-radius: 6px;
            background: linear-gradient(90deg, ${C.surface} 0%, ${C.tealLight}24 42%, ${C.surface} 84%);
            background-size: 220% 100%; animation: distShimmer 1.35s ease-in-out infinite;
          }
          .dist-shimmer.small { height: 10px; margin-top: 10px; opacity: 0.8; }
          .dist-shimmer.tiny { height: 9px; opacity: 0.7; }
          .dist-shimmer.title { width: 48%; height: 24px; border-radius: 8px; }
          .dist-loading-chart {
            height: 360px; border-radius: 8px; border: 0.5px solid ${C.border};
            background: linear-gradient(180deg, ${C.surface}, ${C.card}); position: relative; overflow: hidden;
          }
          .dist-loading-wave {
            position: absolute; left: 7%; right: 7%; top: 42%; height: 90px;
            border-bottom: 3px solid ${C.tealLight}; border-radius: 50%; opacity: 0.42;
            filter: drop-shadow(0 0 18px ${C.tealLight}30);
          }
          @keyframes distShimmer {
            0% { background-position: 160% 0; }
            100% { background-position: -80% 0; }
          }
          @media (max-width: 1180px) {
            .dist-workspace { grid-template-columns: 1fr !important; }
            .dist-loading-grid { grid-template-columns: 1fr !important; }
            .dist-list { grid-template-columns: repeat(2, minmax(0, 1fr)); order: 2; }
            .dist-main { order: 1; }
          }
          @media (max-width: 860px) {
            .dist-hero-grid { grid-template-columns: 1fr !important; }
            .dist-chart-head { grid-template-columns: 1fr 1fr !important; }
            .dist-chart-head > div:first-child { grid-column: 1 / -1; }
            .dist-metric-panel { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .dist-range-head { display: none; }
            .dist-range-row { grid-template-columns: 1fr !important; }
            .dist-control { justify-content: flex-start; }
            .dist-list { grid-template-columns: 1fr !important; }
            .dist-focus-strip { grid-template-columns: 24px minmax(0, 1fr); }
            .dist-focus-strip em { display: none; }
            .dist-focus-strip em:last-child { display: block; justify-self: end; }
          }
        `}</style>

        <div className="dist-shell">
          <div style={{ marginBottom: 18 }}>
            <div>
              <h1 style={{ fontFamily: FD, fontSize: "clamp(28px, 3vw, 40px)", lineHeight: 1.05, margin: 0, color: C.textPrimary, letterSpacing: "-0.024em", fontWeight: 400 }}>
                Distribution Markets
              </h1>
            </div>
          </div>

          {error && (
            <div style={{ border: `0.5px solid ${C.red}`, background: `${C.red}10`, color: C.red, borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 12 }}>
              {error}
            </div>
          )}

          {loading && candidates.length === 0 ? (
            <DistributionLoadingState />
          ) : (
          <div className="dist-workspace">
            <aside className="dist-list">
              {railCandidates.map((candidate) => (
                <CandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  active={candidate.id === selectedId}
                  onClick={() => selectCandidate(candidate)}
                />
              ))}
              {candidates.length > 7 && (
                <button className="dist-rail-toggle" onClick={() => setShowAllMarkets((current) => !current)}>
                  {showAllMarkets ? "Show fewer" : "Show all markets"}
                </button>
              )}
            </aside>

            {selected && (
              <main className="dist-main">
                <section style={{ ...PANEL, padding: "18px 20px" }}>
                  <div className="dist-chart-head">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 7 }}>
                        Selected market
                      </div>
                      <h2 style={{ color: C.textPrimary, fontFamily: FD, fontSize: 23, fontWeight: 400, letterSpacing: "-0.024em", lineHeight: 1.1, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {selected.title}
                      </h2>
                    </div>
                    <Metric label="Score" value={selected.launch_score.toFixed(1)} color={scoreColor(selected.launch_score)} align="right" />
                    <Metric label="Volume" value={usd(selected.aggregate_volume_usd)} align="right" />
                    <Metric label="Depth" value={usd(selected.aggregate_depth_usd)} align="right" />
                    <Metric label="Spread" value={selected.avg_spread === null || selected.avg_spread > 0.25 ? "n/a" : pct(selected.avg_spread)} align="right" />
                  </div>
                  <div className="dist-hero-grid">
                    <div style={{ minWidth: 0 }}>
                      <div className="dist-legend">
                        <span><i style={{ background: C.textMuted, opacity: 0.55 }} /> Market</span>
                        <span><i style={{ background: C.tealLight }} /> Target</span>
                      </div>
                      <CurveSvg
                        candidate={selected}
                        target={targetCurve}
                        quote={quote}
                        order={bandIndices}
                        selectedBandIndex={selectedBandIndex}
                        onSelectBand={setSelectedBandIndex}
                      />
                      {selectedBand && (
                        <div className="dist-focus-strip">
                          <span>{selectedRankLabel}</span>
                          <strong>{selectedBand.label}</strong>
                          <em>Depth {usd(selectedBand.depth_usd)}</em>
                          <em>Market {pct(selected.reference_curve[selectedBandIndex] ?? 0)}</em>
                          <em>Your {pct(quote?.target_curve[selectedBandIndex] ?? targetCurve[selectedBandIndex] ?? 0)}</em>
                          <em style={{ color: (quote?.pnl_curve[selectedBandIndex]?.position_usdc ?? 0) >= 0 ? C.green : C.coral }}>
                            {signedUsd(quote?.pnl_curve[selectedBandIndex]?.position_usdc ?? 0)}
                          </em>
                        </div>
                      )}
                    </div>

                    <div className="dist-metric-panel">
                      <Metric label="Peak target" value={quote?.expected_band.label ?? "-"} />
                      <Metric label="Max gain" value={quote ? fmtUsd(quote.max_profit_usdc, 2) : "-"} color={C.green} />
                      <Metric label="Max loss" value={quote ? fmtUsd(quote.max_loss_usdc, 2) : "-"} color={C.coral} />
                      <Metric label="Fee" value={quote ? fmtUsd(quote.maker_fee_usdc, 2) : "-"} />
                      <Metric label="Net USDC" value={quote ? fmtUsd(quote.net_collateral_usdc, 2) : "-"} />
                      <Metric label="Total" value={`${total.toFixed(1)}%`} color={Math.abs(total - 100) < 0.05 ? C.green : C.amber} />
                      <label className="dist-money-field">
                        Collateral (USDC)
                        <span className="dist-money-input">
                          <span>$</span>
                          <input
                            className="dist-input"
                            type="number"
                            min={1}
                            value={collateral}
                            onChange={(event) => setCollateral(event.target.value)}
                          />
                        </span>
                      </label>
                      <div className="dist-button-pair">
                        <button className="dist-tap" style={{ width: "100%", fontSize: 12 }} onClick={normalizeCurrentWeights}>Normalize</button>
                        <button className="dist-tap" style={{ width: "100%", fontSize: 12 }} onClick={() => setWeights(weightsFromCurve(selected.reference_curve))}>Reset</button>
                      </div>
                      <button
                        className="dist-action"
                        onClick={stageLaunch}
                        style={{ height: 38, borderRadius: 8, border: `0.5px solid ${C.tealLight}`, background: C.tealLight, color: "#03111f", fontFamily: FD, fontSize: 12, fontWeight: 600, letterSpacing: "0.01em", cursor: "pointer", padding: "0 14px" }}
                      >
                        Submit distribution trade
                      </button>
                    </div>
                  </div>
                </section>

                <RangeTable
                  candidate={selected}
                  weights={weights}
                  quote={quote}
                  order={bandIndices}
                  updateWeight={updateWeight}
                  selectedBandIndex={selectedBandIndex}
                  onSelectBand={setSelectedBandIndex}
                  total={total}
                  normalize={normalizeCurrentWeights}
                />

                {launchPlan && (
                  <section style={{ ...PANEL, padding: 13, borderColor: launchPlan.status === "ready_to_launch" ? C.green : C.amber }}>
                    <span style={{ color: launchPlan.status === "ready_to_launch" ? C.green : C.amber, fontFamily: FM, textTransform: "uppercase", fontSize: 11 }}>
                      {launchPlan.status.replaceAll("_", " ")}
                    </span>
                    <span style={{ color: C.textSecondary, fontSize: 13 }}> · depth {usd(launchPlan.current_depth_usd)} / required {usd(launchPlan.required_depth_usd)} across {launchPlan.bands.length} ranges</span>
                  </section>
                )}
              </main>
            )}
          </div>
          )}
        </div>
      </PageFrame>
    </>
  );
}
