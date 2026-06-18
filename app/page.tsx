"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Header, PageFrame } from "./app/_components/Header";
import { C, FD, FM, FS, BACKEND_URL, EASE, fmtUsd } from "./app/_lib/tokens";
import { monotonePath } from "./app/_lib/curve";
import {
  DistributionCandidate,
  fetchDistributionCandidates,
} from "./app/_lib/distribution-client";

type VaultSource = { name: string; apy: number; live: boolean };

/* Representative figures for illustrative readouts (no live wallet yet). */
const NOTIONAL = 50_000;
const MATURITY_DAYS = 30;

/* ------------------------------------------------------------------ */
/* Inline icons — stroke inherits currentColor.                       */
/* ------------------------------------------------------------------ */

type IconProps = { size?: number };

function IconCurve({ size = 18 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <path d="M3 17.5c3 0 3.6-9 6.6-9s2.7 6 4.2 6 2.1-4.5 4.2-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 20.5h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}

function IconBasket({ size = 18 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <path d="M12 3.2l8 4-8 4-8-4 8-4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M4 11.4l8 4 8-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
      <path d="M4 15.6l8 4 8-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.32" />
    </svg>
  );
}

function IconSlices({ size = 18 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="3.4" rx="1.4" stroke="currentColor" strokeWidth="1.6" />
      <rect x="4" y="10.3" width="11.5" height="3.4" rx="1.4" stroke="currentColor" strokeWidth="1.6" opacity="0.62" />
      <rect x="4" y="15.6" width="7" height="3.4" rx="1.4" stroke="currentColor" strokeWidth="1.6" opacity="0.34" />
    </svg>
  );
}

function IconShield({ size = 18 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <path d="M12 3l7 2.8v5.2c0 4.2-3 7.3-7 8.9-4-1.6-7-4.7-7-8.9V5.8L12 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 12.2l2.1 2.1L15 10.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconArrow({ size = 14 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSignal({ size = 18 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <path d="M3 12.5h3.4l2.3-6.4 3.8 12 2.4-7.1 1.5 3.2H21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCoin({ size = 18 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.4v9.2M14.3 9.3c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 1.9 0 2.6 5.2 1.3 5.2 4 0 1.2-1.1 2-2.7 2-1.2 0-2.2-.5-2.7-1.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCube({ size = 18 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <path d="M12 3l8 4.4v9.2L12 21l-8-4.4V7.4L12 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M4 7.6l8 4.4 8-4.4M12 12v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
    </svg>
  );
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                   */
/* ------------------------------------------------------------------ */

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function shortUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return fmtUsd(value, 0);
}

/* Clean, non-overshooting curve shared with every chart in the app. */
function smoothPath(pts: Array<[number, number]>): string {
  return monotonePath(pts);
}

/* ------------------------------------------------------------------ */
/* Hero terminal — clean live-market panel with real axes.            */
/* ------------------------------------------------------------------ */

function CurveTerminal({ candidate, ready }: { candidate: DistributionCandidate | null; ready: boolean }) {
  const W = 680;
  const H = 348;
  const padL = 44;
  const padR = 20;
  const padT = 38;
  const padB = 40;
  const plotL = padL;
  const plotR = W - padR;
  const plotW = plotR - plotL;
  const plotT = padT;
  const plotB = H - padB;
  const plotH = plotB - plotT;

  const fallback = [0.05, 0.11, 0.2, 0.31, 0.19, 0.09, 0.05];
  const series = (candidate?.reference_curve.length ? candidate.reference_curve : fallback).slice(0, 8);
  const n = series.length;
  const max = Math.max(...series, 0.05) * 1.15;

  const x = (i: number) => plotL + (i / Math.max(1, n - 1)) * plotW;
  const y = (v: number) => plotT + (1 - v / max) * plotH;
  const bandW = plotW / Math.max(1, n - 1);

  const pts = series.map((v, i): [number, number] => [x(i), y(v)]);
  const linePath = smoothPath(pts);
  const areaPath = `${linePath} L ${x(n - 1).toFixed(1)} ${plotB} L ${x(0).toFixed(1)} ${plotB} Z`;
  const topIndex = series.reduce((best, v, i) => (v > series[best] ? i : best), 0);

  const yTicks = [0, 0.5, 1]; // fraction of max
  const isLive = Boolean(candidate);

  return (
    <div className="lp-term">
      <div className="lp-term-head">
        <div>
          <span className="lp-term-eyebrow">Distribution market</span>
          <strong className="lp-term-name">{candidate?.title ?? "Sample distribution"}</strong>
        </div>
        <span className="lp-live">
          <i className={isLive ? "is-live" : ""} />
          {isLive ? "Live" : "Sample"}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="lp-curve" role="img" aria-label="Probability distribution across CLOB-implied bands">
        <defs>
          <linearGradient id="lpFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={C.tealLight} stopOpacity="0.16" />
            <stop offset="100%" stopColor={C.tealLight} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y axis: gridlines + probability labels */}
        {yTicks.map((t) => {
          const gy = plotT + (1 - t) * plotH;
          return (
            <g key={t}>
              <line x1={plotL} x2={plotR} y1={gy} y2={gy} stroke={C.border} strokeWidth="1" opacity={t === 0 ? 1 : 0.5} />
              <text x={plotL - 10} y={gy + 3.5} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="10">{pct(t * max, 0)}</text>
            </g>
          );
        })}

        {/* X tick marks + band labels render immediately (no jerk) */}
        {series.map((_, i) => (
          <g key={`x${i}`}>
            <line x1={x(i)} x2={x(i)} y1={plotB} y2={plotB + 5} stroke={C.border} strokeWidth="1" />
            <text x={x(i)} y={plotB + 18} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9.5">B{i + 1}</text>
          </g>
        ))}

        {/* The curve mounts only once the data has settled, so it draws in
            exactly once on its final shape — no mid-animation shape swap. */}
        {ready && (
          <g key={isLive ? "live" : "sample"}>
            <path d={areaPath} fill="url(#lpFill)" className="lp-area" />
            <path d={linePath} fill="none" stroke={C.tealLight} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="lp-line" pathLength={1} />
            {series.map((v, i) => (
              <g key={i} className="lp-stage">
                <line className="lp-guide" x1={x(i)} x2={x(i)} y1={plotT} y2={plotB} stroke={C.tealLight} strokeWidth="1" strokeDasharray="3 4" />
                <circle className="lp-dot" cx={x(i)} cy={y(v)} r={i === topIndex ? 3.6 : 2.8} fill={i === topIndex ? C.tealLight : C.surface} stroke={C.tealLight} strokeWidth="1.6" />
                <text className={`lp-val${i === topIndex ? " is-peak" : ""}`} x={x(i)} y={Math.max(16, y(v) - 12)} textAnchor="middle" fill={i === topIndex ? C.textPrimary : C.textSecondary} fontFamily={FM} fontSize="11">
                  {pct(v)}
                </text>
                <rect x={x(i) - bandW / 2} y={plotT} width={bandW} height={plotH} fill="transparent" />
              </g>
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scroll-triggered big charts — one per structured product.          */
/* The parent row toggles `is-drawn` once it scrolls into view, which  */
/* fires the line draw-in (same feel as the hero terminal).            */
/* ------------------------------------------------------------------ */

/* One global rAF-throttled scroll handler scrubs `--reveal` (0..1) on every
   `.scroll-fade` element from its position in the viewport — smoothstepped so
   the fade is clean: solid while the block sits in the reading band, easing to
   transparent as it enters from the bottom or leaves out the top. It also flips
   `is-drawn` on feature rows so their charts draw in once. JS-driven, so it is
   immune to the overflow ancestors that break CSS view() timelines. */
function useGlobalScrollFade() {
  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const vh = window.innerHeight || 1;
      // Wide bands (≈45% of the viewport each) so the fade is gradual and clearly
      // visible while scrolling: a block eases in as its top rises through the
      // lower half, sits solid across the centre, then eases out as its bottom
      // climbs through the upper half — so the content leaving the top fades.
      const band = vh * 0.45;
      const els = document.querySelectorAll<HTMLElement>(".scroll-fade");
      els.forEach((el) => {
        const r = el.getBoundingClientRect();
        const enter = clamp((vh - r.top) / band, 0, 1);
        const exit = clamp(r.bottom / band, 0, 1);
        let o = Math.min(enter, exit);
        o = o * o * (3 - 2 * o); // smoothstep
        el.style.setProperty("--reveal", o.toFixed(3));
        if (o > 0.3) el.classList.add("is-drawn");
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    // Robustness net: guarantee the one-shot draw-in (`is-drawn`) fires the
    // moment a block is even slightly visible, independent of the scroll-scrub
    // opacity threshold above. Without this, a chart/waterfall that is on a
    // tall viewport (or never scrolled into the reveal band) could stay stuck
    // in its hidden base state (stroke-dashoffset / scaleY(0)).
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-drawn");
              io?.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.08 },
      );
      document.querySelectorAll<HTMLElement>(".scroll-fade").forEach((el) => io?.observe(el));
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, []);
}

type Series = {
  values: number[]; // in chart Y-domain units
  bold?: boolean;
  op?: number;
  area?: boolean;
  dashed?: boolean;
  name?: string;
  delay?: number;
  endLabel?: string;
  endMuted?: boolean; // small muted endpoint label, no marker dot
};

const CW = 600;
const CH = 312;
const CpL = 46;
const CpR = 50;
const CpT = 24;
const CpB = 46;
const cPlotL = CpL;
const cPlotR = CW - CpR;
const cPlotW = cPlotR - cPlotL;
const cPlotT = CpT;
const cPlotB = CH - CpB;
const cPlotH = cPlotB - cPlotT;
const cx = (i: number, n: number) => cPlotL + (i / Math.max(1, n - 1)) * cPlotW;

function seriesPaths(s: Series, cy: (v: number) => number, fillId: string, key: React.Key) {
  const n = s.values.length;
  const pts = s.values.map((v, i): [number, number] => [cx(i, n), cy(v)]);
  const d = smoothPath(pts);
  const delay = `${s.delay ?? 0}s`;
  const last = pts[n - 1];
  return (
    <g key={key}>
      {s.area && (
        <path d={`${d} L ${cx(n - 1, n).toFixed(1)} ${cPlotB} L ${cx(0, n).toFixed(1)} ${cPlotB} Z`} fill={`url(#${fillId})`} className="feat-area" style={{ animationDelay: delay }} />
      )}
      {s.dashed ? (
        <path d={d} fill="none" stroke={C.tealLight} strokeWidth="1.5" strokeOpacity={s.op ?? 0.6} strokeDasharray="6 6" className="feat-dash" style={{ animationDelay: delay }} />
      ) : (
        <path d={d} fill="none" stroke={C.tealLight} strokeWidth={s.bold ? 2.6 : 1.8} strokeOpacity={s.op ?? 1} strokeLinecap="round" strokeLinejoin="round" className="feat-line" style={{ animationDelay: delay }} pathLength={1} />
      )}
      {s.endLabel && (
        <g className="feat-end" style={{ animationDelay: delay }}>
          {!s.endMuted && <circle cx={last[0]} cy={last[1]} r={3.2} fill={C.tealLight} fillOpacity={s.op ?? 1} />}
          <text x={last[0] + 7} y={last[1] + 3.5} textAnchor="start" fill={s.endMuted ? C.textMuted : C.textPrimary} fontFamily={FM} fontSize={s.endMuted ? "9.5" : "11.5"} fontWeight={s.endMuted ? 400 : 600}>{s.endLabel}</text>
        </g>
      )}
    </g>
  );
}

function ChartFrame({
  id,
  caption,
  yMin,
  yMax,
  yTicks,
  xLabels,
  children,
}: {
  id: string;
  caption: string;
  yMin: number;
  yMax: number;
  yTicks: Array<{ v: number; label: string }>;
  xLabels: string[];
  children: (cy: (v: number) => number, fillId: string) => React.ReactNode;
}) {
  const fillId = `featFill-${id}`;
  const cy = (v: number) => cPlotT + (1 - (v - yMin) / (yMax - yMin)) * cPlotH;
  return (
    <svg viewBox={`0 0 ${CW} ${CH}`} className="feat-chart" role="img" aria-label={caption}>
      <defs>
        <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={C.tealLight} stopOpacity="0.16" />
          <stop offset="100%" stopColor={C.tealLight} stopOpacity="0" />
        </linearGradient>
      </defs>
      {yTicks.map((t) => {
        const gy = cy(t.v);
        return (
          <g key={t.v}>
            <line x1={cPlotL} x2={cPlotR} y1={gy} y2={gy} stroke={C.border} strokeWidth="1" opacity={0.5} />
            <text x={cPlotL - 9} y={gy + 3.5} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="10">{t.label}</text>
          </g>
        );
      })}
      <line x1={cPlotL} x2={cPlotL} y1={cPlotT} y2={cPlotB} stroke={C.border} strokeWidth="1" />
      {xLabels.map((lab, k) => {
        const xx = cPlotL + (k / Math.max(1, xLabels.length - 1)) * cPlotW;
        return (
          <g key={k}>
            <line x1={xx} x2={xx} y1={cPlotB} y2={cPlotB + 5} stroke={C.border} strokeWidth="1" />
            <text x={xx} y={cPlotB + 18} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9.5">{lab}</text>
          </g>
        );
      })}
      {children(cy, fillId)}
      <text x={(cPlotL + cPlotR) / 2} y={CH - 9} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9.5" letterSpacing="0.05em">{caption}</text>
    </svg>
  );
}

/* Baskets — uncorrelated component events scatter above and below the line;
   pooling them gives the smooth basket that resolves ~97% with far less
   variance than any single leg. The diversification edge, made visible. */
function BasketChart({ caption }: { caption: string }) {
  const comps = [
    { values: [95.6, 94.3, 96.9, 95.1, 97.7, 98.6], end: "98.6%" },
    { values: [92.3, 94.0, 92.5, 95.0, 93.6, 95.6], end: "95.6%" },
    { values: [91.1, 92.8, 94.4, 92.6, 95.1, 94.3], end: "94.3%" },
    { values: [93.8, 92.4, 94.7, 93.2, 91.9, 93.0], end: "93.0%" },
    { values: [94.6, 93.1, 91.6, 93.5, 92.2, 91.8], end: "91.8%" },
  ];
  const basket = [94.1, 94.7, 95.3, 95.9, 96.5, 97.0];
  return (
    <ChartFrame id="basket" caption={caption} yMin={90} yMax={100} yTicks={[{ v: 90, label: "90%" }, { v: 95, label: "95%" }, { v: 100, label: "100%" }]} xLabels={["Apr", "May", "Jun", "Jul", "Aug", "Now"]}>
      {(cy, fillId) => (
        <>
          {comps.map((c, i) => seriesPaths({ values: c.values, op: 0.28, delay: 0.06 * i, endLabel: c.end, endMuted: true }, cy, fillId, `c${i}`))}
          {seriesPaths({ values: basket, bold: true, area: true, endLabel: "97%", delay: 0.26 }, cy, fillId, "b")}
        </>
      )}
    </ChartFrame>
  );
}

/* Risk Slices — one contiguous capital column split into tranches, with the
   loss waterfall flowing down it from the first-loss slice to the protected one. */
function WaterfallViz({ caption }: { caption: string }) {
  const top = cPlotT;
  const bottom = cPlotB;
  const colH = bottom - top;
  const colX = 196;
  const colW = 104;
  // top → bottom: first loss sits on top, the protected senior slice at the base.
  const segs = [
    { name: "Junior", share: 0.15, op: 0.32, role: "first loss" },
    { name: "Mezzanine", share: 0.3, op: 0.58, role: "balanced" },
    { name: "Senior", share: 0.55, op: 0.92, role: "protected" },
  ];
  let y = top;
  const rows = segs.map((seg, i) => {
    const segH = seg.share * colH;
    const r = { ...seg, y, segH, idx: i };
    y += segH;
    return r;
  });
  const axisX = colX - 16;
  return (
    <svg viewBox={`0 0 ${CW} ${CH}`} className="feat-chart" role="img" aria-label={caption}>
      {/* y axis + 0/50/100 ticks pinned to the column */}
      <line x1={axisX} x2={axisX} y1={top} y2={bottom} stroke={C.border} strokeWidth="1" />
      {[{ v: 1, l: "100%" }, { v: 0.5, l: "50%" }, { v: 0, l: "0%" }].map((t) => {
        const gy = bottom - t.v * colH;
        return (
          <g key={t.v}>
            <line x1={axisX - 5} x2={axisX} y1={gy} y2={gy} stroke={C.border} strokeWidth="1" />
            <text x={axisX - 10} y={gy + 3.5} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="10">{t.l}</text>
          </g>
        );
      })}

      {/* loss waterfall — flows down the stack, first loss → protected */}
      <g opacity="0.9">
        <line x1={axisX - 54} x2={axisX - 54} y1={top + 18} y2={bottom - 18} stroke={C.tealLight} strokeWidth="1.5" strokeOpacity="0.7" />
        <path d={`M ${axisX - 58} ${bottom - 26} L ${axisX - 54} ${bottom - 16} L ${axisX - 50} ${bottom - 26}`} fill="none" stroke={C.tealLight} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <text x={axisX - 54} y={top + 10} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="8" letterSpacing="0.12em">LOSS</text>
      </g>

      {/* one contiguous column, scaled up from its base as it draws in */}
      <g className="wf-stack" style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}>
        {rows.map((r) => (
          <rect key={r.name} x={colX} y={r.y} width={colW} height={r.segH} fill={C.tealLight} fillOpacity={r.op} />
        ))}
        {/* hairline dividers between tranches */}
        {rows.slice(1).map((r) => (
          <line key={`d${r.name}`} x1={colX} x2={colX + colW} y1={r.y} y2={r.y} stroke={C.bg} strokeWidth="1.5" />
        ))}
      </g>

      {/* tranche labels */}
      {rows.map((r) => (
        <g key={`l${r.name}`} className="wf-lab" style={{ animationDelay: `${(segs.length - 1 - r.idx) * 0.1}s` }}>
          <text x={colX + colW + 22} y={r.y + r.segH / 2 - 3} fill={C.textPrimary} fontFamily={FD} fontSize="15" fontWeight={600}>{r.name}</text>
          <text x={colX + colW + 22} y={r.y + r.segH / 2 + 15} fill={C.textMuted} fontFamily={FM} fontSize="11">{Math.round(r.share * 100)}% · {r.role}</text>
        </g>
      ))}

      <text x={(cPlotL + cPlotR) / 2} y={CH - 9} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9.5" letterSpacing="0.05em">{caption}</text>
    </svg>
  );
}

/* Protected Notes — the TradFi principal-protected note, plainly: the underlying
   market can fall below the floor, but the note's downside is floored at 95% and
   it keeps the upside above it. Two lines + the floor — nothing more. */
function ProtectedViz({ caption }: { caption: string }) {
  const target = 95;
  const underlying = [96.4, 94.6, 92.0, 93.0, 95.2, 97.6, 99.6];
  const note = [95.6, 95.2, 95.1, 95.4, 96.3, 97.6, 98.6];
  return (
    <ChartFrame id="ppn" caption={caption} yMin={90} yMax={100} yTicks={[{ v: 90, label: "90%" }, { v: 95, label: "95%" }, { v: 100, label: "100%" }]} xLabels={["Open", "", "", "Mid", "", "", "Resolve"]}>
      {(cy, fillId) => (
        <>
          {/* the protected zone — the note never enters it; the market can */}
          <rect x={cPlotL} y={cy(target)} width={cPlotW} height={cPlotB - cy(target)} fill={C.tealLight} fillOpacity={0.05} />
          {/* underlying market — falls through the floor, then recovers above it */}
          {seriesPaths({ values: underlying, op: 0.42, delay: 0.1, endLabel: "99.6%", endMuted: true }, cy, fillId, "u")}
          {/* the note — held at the floor on the downside, captures the upside */}
          {seriesPaths({ values: note, bold: true, endLabel: "98.6%", delay: 0.22 }, cy, fillId, "n")}
          {/* 95% floor */}
          {seriesPaths({ values: Array(7).fill(target), dashed: true, op: 0.75 }, cy, fillId, "f")}
          <text className="feat-end" x={cPlotL + 8} y={cy(target) + 15} textAnchor="start" fill={C.textMuted} fontFamily={FM} fontSize="9.5" letterSpacing="0.06em">PRINCIPAL FLOOR</text>
        </>
      )}
    </ChartFrame>
  );
}

/* Distribution Markets — you don't bet a single yes/no point, you trade a whole
   continuous view of where a number lands. Two bell curves over the same outcome
   axis: the market's implied distribution (muted) and your sharper view (bold),
   with your μ marker and the ±σ band you're trading. */
function DistributionViz({ caption }: { caption: string }) {
  const baseY = cPlotB;
  const span = cPlotW;
  const N = 72;
  const gauss = (muFrac: number, sigFrac: number, peakY: number): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const z = (t - muFrac) / sigFrac;
      const dens = Math.exp(-0.5 * z * z);
      pts.push([cPlotL + t * span, baseY - dens * (baseY - peakY)]);
    }
    return pts;
  };
  const market = gauss(0.44, 0.22, cPlotT + 92);
  const view = gauss(0.58, 0.13, cPlotT + 12);
  const muX = cPlotL + 0.58 * span;
  const sigLo = cPlotL + (0.58 - 0.13) * span;
  const sigHi = cPlotL + (0.58 + 0.13) * span;
  const fillId = "dist-fill";
  const areaD = `${smoothPath(view)} L ${view[view.length - 1][0].toFixed(1)} ${baseY} L ${view[0][0].toFixed(1)} ${baseY} Z`;
  return (
    <svg viewBox={`0 0 ${CW} ${CH}`} className="feat-chart" role="img" aria-label={caption}>
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.tealLight} stopOpacity="0.2" />
          <stop offset="100%" stopColor={C.tealLight} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* outcome axis */}
      <line x1={cPlotL} x2={cPlotR} y1={baseY} y2={baseY} stroke={C.border} strokeWidth="1" />
      {/* the ±σ band you're trading */}
      <rect x={sigLo} y={cPlotT} width={sigHi - sigLo} height={baseY - cPlotT} fill={C.tealLight} fillOpacity="0.05" />
      {/* your μ */}
      <line x1={muX} x2={muX} y1={cPlotT} y2={baseY} stroke={C.tealLight} strokeWidth="1.5" strokeOpacity="0.5" strokeDasharray="5 5" className="feat-dash" />
      <text x={muX} y={cPlotT - 6} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9" letterSpacing="0.1em">YOUR μ</text>
      {/* market-implied distribution (muted) */}
      <path d={smoothPath(market)} fill="none" stroke={C.tealLight} strokeWidth="1.8" strokeOpacity="0.3" strokeLinecap="round" strokeLinejoin="round" className="feat-line" pathLength={1} />
      {/* your sharper view (bold + area) */}
      <path d={areaD} fill={`url(#${fillId})`} className="feat-area" />
      <path d={smoothPath(view)} fill="none" stroke={C.tealLight} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="feat-line" style={{ animationDelay: "0.18s" }} pathLength={1} />
      {/* σ ticks */}
      <text x={sigLo} y={baseY + 16} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9.5">μ−σ</text>
      <text x={sigHi} y={baseY + 16} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9.5">μ+σ</text>
      <text x={(cPlotL + cPlotR) / 2} y={CH - 9} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9.5" letterSpacing="0.05em">{caption}</text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */

type SurfaceId = "distribution" | "basket" | "risk" | "ppn";

const SURFACES: Array<{
  id: SurfaceId;
  eyebrow: string;
  title: string;
  body: string;
  href: string;
  Icon: (p: IconProps) => React.ReactElement;
}> = [
  { id: "distribution", eyebrow: "Range ladder", title: "Distribution", body: "Drag μ and σ and mint a strip of real DeepBook range options that mirrors your whole view of where BTC lands — in one signature.", href: "/app/distribution", Icon: IconCurve },
  { id: "risk", eyebrow: "Conviction slices", title: "Risk Slices", body: "One strip sliced into senior, mezzanine, and junior by width — senior covers wide and defensive, junior pins the forward for the biggest multiple. Plus a cross-venue hybrid.", href: "/app/tranche", Icon: IconSlices },
  { id: "ppn", eyebrow: "Principal protected", title: "Protected Notes", body: "The floor earns itself back in the PLP house pool, the remainder buys an upside range strip — both in one transaction.", href: "/app/ppn", Icon: IconShield },
  { id: "basket", eyebrow: "Strips + events", title: "Baskets", body: "Curated DeepBook BTC strips — Pin, Spread, Wide — across every live expiry, plus uncorrelated event baskets. One venue, one click.", href: "/app/basket", Icon: IconBasket },
];

type Showcase = {
  id: SurfaceId;
  eyebrow: string;
  title: string;
  href: string;
  Icon: (p: IconProps) => React.ReactElement;
  lead: string;
  specs: string[];
  caption: string;
  legend: Array<{ name: string; dashed?: boolean; op?: number }>;
};

const SHOWCASE: Showcase[] = [
  {
    id: "basket",
    eyebrow: "Strips + events",
    title: "Baskets",
    href: "/app/basket",
    Icon: IconBasket,
    lead: "Curated BTC strips — Pin, Spread, Wide — on every live DeepBook expiry, plus uncorrelated event baskets.",
    specs: ["Pin, Spread, Wide shapes", "Live on-chain book per expiry", "Plus uncorrelated event baskets"],
    caption: "Pooled basket resolves above its uncorrelated components",
    legend: [{ name: "Basket" }, { name: "Components", op: 0.3 }],
  },
  {
    id: "risk",
    eyebrow: "Waterfall",
    title: "Risk Slices",
    href: "/app/tranche",
    Icon: IconSlices,
    lead: "Slice one strip into senior, mezzanine, and junior by conviction width — each absorbs losses in order.",
    specs: ["Senior covers wide, defensive and steady", "Junior pins the forward for the biggest multiple", "Plus a cross-venue hybrid: BTC core + event tail"],
    caption: "Capital stack and loss waterfall",
    legend: [{ name: "Senior", op: 0.9 }, { name: "Mezzanine", op: 0.6 }, { name: "Junior", op: 0.36 }],
  },
  {
    id: "ppn",
    eyebrow: "Floor target",
    title: "Protected Notes",
    href: "/app/ppn",
    Icon: IconShield,
    lead: "Set your floor: it earns itself back in the PLP house pool while the rest buys upside — principal protected.",
    specs: ["USDC principal sleeve", "Downside floored at your chosen level", "Full upside above the floor"],
    caption: "Note held at its floor while the underlying keeps the upside",
    legend: [{ name: "Note value" }, { name: "Underlying", op: 0.42 }, { name: "Floor", dashed: true, op: 0.75 }],
  },
  {
    id: "distribution",
    eyebrow: "Curve trade",
    title: "Distribution Markets",
    href: "/app/distribution",
    Icon: IconCurve,
    lead: "Trade your whole view of where a number lands — a continuous curve, not a single yes/no.",
    specs: ["Set your own μ and σ", "Trade your curve against the market's", "Continuous payout, settles on Sui"],
    caption: "Your sharper view vs the market's implied distribution",
    legend: [{ name: "Your view" }, { name: "Market", op: 0.3 }, { name: "μ", dashed: true, op: 0.6 }],
  },
];

function FeatureRow({ item, index }: { item: Showcase; index: number }) {
  const reverse = index % 2 === 1;
  return (
    <div className={`feat-row scroll-fade${reverse ? " is-rev" : ""}`}>
      <div className="feat-panel">
        <div className="feat-panel-head">
          <span className="feat-eyebrow">{item.eyebrow}</span>
        </div>
        {item.id === "basket" && <BasketChart caption={item.caption} />}
        {item.id === "risk" && <WaterfallViz caption={item.caption} />}
        {item.id === "ppn" && <ProtectedViz caption={item.caption} />}
        {item.id === "distribution" && <DistributionViz caption={item.caption} />}
        <div className="feat-legend">
          {item.legend.map((l) => (
            <span key={l.name}>
              <i className={l.dashed ? "dash" : ""} style={{ opacity: l.op ?? 1 }} />
              {l.name}
            </span>
          ))}
        </div>
      </div>
      <div className="feat-text">
        <div className="feat-tag"><item.Icon size={16} />{item.eyebrow}</div>
        <h3>{item.title}</h3>
        <p>{item.lead}</p>
        <ul className="feat-specs">
          {item.specs.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <Link className="feat-link" href={item.href}>
          Open {item.title} <span className="lp-ar"><IconArrow /></span>
        </Link>
      </div>
    </div>
  );
}

const PIPE: Array<{ name: string; sub: string; Icon: (p: IconProps) => React.ReactElement }> = [
  { name: "Live pricing", sub: "DeepBook Predict order book", Icon: IconSignal },
  { name: "Quote engine", sub: "Depth-weighted bands", Icon: IconBasket },
  { name: "USDC collateral", sub: "Net of quote fees", Icon: IconCoin },
  { name: "Sui settlement", sub: "mock-USDC package", Icon: IconCube },
];

/* ------------------------------------------------------------------ */

/** A live continuous (Normal mu/sigma) forward, used to give the hero chart a
 *  real bell-shaped distribution when the discrete-market pool has none. */
type ContForward = { question?: string; underlying?: string; mu: number; sigma: number; volume_usd?: number; backing_usdc?: number; pool_liquidity_usdc?: number };

/** Synthesize a DistributionCandidate whose reference_curve is a Normal PDF
 *  sampled across 7 bands — a clean bell — from a continuous forward market. */
function bellFromForward(m: ContForward): DistributionCandidate {
  const BANDS = 7;
  const K = 2.2;
  const sigma = m.sigma || Math.max(1e-6, Math.abs(m.mu) * 0.1);
  const lo = m.mu - K * sigma;
  const hi = m.mu + K * sigma;
  const raw = Array.from({ length: BANDS }, (_, i) => {
    const x = lo + ((hi - lo) * i) / (BANDS - 1);
    const z = (x - m.mu) / sigma;
    return Math.exp(-0.5 * z * z);
  });
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const curve = raw.map((v) => v / sum);
  return {
    id: `cont-${m.question ?? m.underlying ?? "fwd"}`,
    title: m.question ?? m.underlying ?? "Price distribution",
    category: "crypto",
    category_confidence: 1,
    distribution_fit: "high",
    outcome_type: "price_level",
    event_slug: null,
    end_date_iso: null,
    days_to_resolution: 7,
    aggregate_volume_usd: m.volume_usd ?? 0,
    // Depth = the market's REAL pool backing (live CLOB depth / 24h volume),
    // distinct from quoting volume — never the same number as volume.
    aggregate_depth_usd:
      m.backing_usdc ?? m.pool_liquidity_usdc ?? (m.volume_usd && m.volume_usd > 0 ? Math.round(m.volume_usd * 0.01) : 250_000),
    avg_spread: null,
    band_count: BANDS,
    launch_score: 90,
    launch_quality: "strong",
    reasons: [],
    pricing_source: "polymarket_gamma_clob",
    clob_book_count: BANDS,
    gamma_liquidity_count: BANDS,
    bands: [],
    reference_curve: curve,
    liquidity_curve: curve,
    fetched_at: new Date().toISOString(),
  };
}

export default function HomePage() {
  const [candidates, setCandidates] = useState<DistributionCandidate[]>([]);
  const [forward, setForward] = useState<ContForward | null>(null);
  const [vaults, setVaults] = useState<VaultSource[]>([]);
  const [chartReady, setChartReady] = useState(false);

  useGlobalScrollFade();

  useEffect(() => {
    let cancelled = false;
    // Draw the hero curve only after the data settles (or a short fallback
    // timeout) so it animates once on its final shape and never jerks.
    const timer = setTimeout(() => {
      if (!cancelled) setChartReady(true);
    }, 2200);
    fetchDistributionCandidates({ limit: 4, refresh: false })
      .then((result) => {
        if (!cancelled) setCandidates(result.candidates);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChartReady(true);
      });
    fetch(`${BACKEND_URL}/api/distribution/continuous/markets`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const list = (body.markets ?? []) as ContForward[];
        const best = list.find((m) => Number.isFinite(m.mu) && Number.isFinite(m.sigma) && m.sigma > 0) ?? null;
        if (best) setForward(best);
      })
      .catch(() => {});
    fetch(`${BACKEND_URL}/api/vaults/yields`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setVaults(
          (body.sources ?? [])
            .filter((source: VaultSource) => typeof source?.apy === "number")
            .map((source: VaultSource) => ({ name: source.name, apy: source.apy, live: source.live }))
            .slice(0, 5),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Prefer a real bell-shaped distribution for the hero: a multi-band market
  // (price-level / continuous outcome) reads as a normal curve, whereas a
  // 2-outcome winner market is just two bars. Fall back to the top-ranked
  // candidate when no multi-band market is live.
  // Hero distribution: prefer a real multi-band (bell-shaped) discrete market;
  // otherwise synthesize a clean Normal bell from a live continuous forward
  // (BTC/ETH price) so the chart always shows a real distribution rather than
  // the flat two-outcome shape of a winner market.
  const candidate =
    candidates.find((c) => (c.band_count ?? 0) >= 5) ??
    (forward ? bellFromForward(forward) : null) ??
    candidates[0] ??
    null;
  const bestVault = vaults[0] ?? null;
  const net = NOTIONAL * (1 - 0.0042);
  const vaultApy = bestVault?.apy ?? 0.0716;
  const protectedVaultPct = 1 / Math.pow(1 + vaultApy / 365, MATURITY_DAYS);
  const basketPct = Math.max(0, 1 - protectedVaultPct);

  const depthUsd = candidate?.aggregate_depth_usd ?? 240_000;
  const volumeUsd = candidate?.aggregate_volume_usd ?? 4_200_000;
  const stats = useMemo(
    () => [
      { label: "Quoting volume", value: shortUsd(volumeUsd), note: "Across live markets" },
      { label: "Order-book depth", value: shortUsd(depthUsd), note: "CLOB-implied, all bands" },
      { label: "CLOB books live", value: candidate ? `${candidate.clob_book_count} / ${candidate.band_count}` : "7 / 7", note: "Order books quoting now" },
      { label: "USDC vault APY", value: pct(vaultApy, 2), note: bestVault?.name ?? "Best Sui yield source" },
    ],
    [bestVault, candidate, depthUsd, vaultApy, volumeUsd],
  );

  return (
    <>
      <Header />
      <PageFrame wide>
        <style>{`
          .lp-shell { max-width: 1200px; margin: 0 auto; }

          .lp-section { padding: 108px 0; border-top: 0.5px solid ${C.border}; }
          .lp-eyebrow { color: ${C.tealLight}; font-family: ${FM}; font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase; }
          .lp-head { max-width: 660px; }
          .lp-head h2 { margin: 14px 0 0; color: ${C.textPrimary}; font-family: ${FD}; font-size: 34px; line-height: 1.12; letter-spacing: -0.03em; font-weight: 600; text-wrap: balance; }
          .lp-head p { margin: 14px 0 0; color: ${C.textSubtle}; font-family: ${FS}; font-size: 15px; line-height: 1.6; max-width: 560px; text-wrap: pretty; }

          /* ---- hero ---- */
          .lp-hero { display: grid; grid-template-columns: minmax(0, 0.92fr) minmax(500px, 1fr); gap: 60px; align-items: center; padding: 76px 0 84px; }
          .lp-hero-title { color: ${C.textPrimary}; font-family: ${FD}; font-size: clamp(44px, 4.8vw, 64px); line-height: 1.06; letter-spacing: -0.035em; font-weight: 600; margin: 16px 0 0; text-wrap: balance; }
          .lp-hero-title em { font-style: normal; color: ${C.tealLight}; }
          .lp-hero-sub { color: ${C.textSubtle}; font-family: ${FS}; font-size: 16px; line-height: 1.65; max-width: 520px; margin: 20px 0 0; text-wrap: pretty; }
          .lp-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 32px; }
          .lp-btn { height: 44px; display: inline-flex; align-items: center; gap: 8px; justify-content: center; border-radius: 9px; padding: 0 20px; font-family: ${FD}; font-size: 14px; font-weight: 600; text-decoration: none; transition: transform 0.18s ${EASE}, background 0.18s ${EASE}, border-color 0.18s ${EASE}, box-shadow 0.18s ${EASE}; }
          .lp-btn-primary { background: ${C.tealLight}; color: #06131f; border: 0.5px solid ${C.tealLight}; box-shadow: 0 8px 28px ${C.tealLight}26; }
          .lp-btn-primary:hover { transform: translateY(-2px); background: ${C.teal}; box-shadow: 0 14px 34px ${C.tealLight}3a; }
          .lp-btn-primary .lp-ar { transition: transform 0.18s ${EASE}; }
          .lp-btn-primary:hover .lp-ar { transform: translateX(3px); }
          .lp-btn-ghost { background: ${C.card}; color: ${C.textPrimary}; border: 0.5px solid ${C.border}; }
          .lp-btn-ghost:hover { border-color: ${C.borderHover}; background: ${C.cardHover}; transform: translateY(-2px); }
          .lp-trust { display: inline-flex; align-items: center; margin-top: 32px; color: ${C.textDim}; font-family: ${FM}; font-size: 11px; letter-spacing: 0.05em; }
          .lp-trust span { padding: 0 16px; border-left: 0.5px solid ${C.border}; }
          .lp-trust span:first-child { padding-left: 0; border-left: 0; }

          /* ---- hero terminal ---- */
          .lp-term { border: 0.5px solid ${C.border}; background: ${C.panelGradient}; border-radius: 16px; padding: 24px 24px 20px; box-shadow: 0 30px 80px rgba(0,0,0,0.34); }
          .lp-term-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
          .lp-term-eyebrow { display: block; color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 7px; }
          .lp-term-name { color: ${C.textPrimary}; font-family: ${FD}; font-size: 16px; font-weight: 600; letter-spacing: -0.015em; display: block; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .lp-live { display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0; color: ${C.textMuted}; font-family: ${FM}; font-size: 10.5px; letter-spacing: 0.08em; }
          .lp-live i { width: 6px; height: 6px; border-radius: 50%; background: ${C.textMuted}; }
          .lp-live i.is-live { background: ${C.tealLight}; animation: lpPing 2.6s ${EASE} infinite; }
          @keyframes lpPing { 0% { box-shadow: 0 0 0 0 ${C.tealLight}55; } 70% { box-shadow: 0 0 0 6px ${C.tealLight}00; } 100% { box-shadow: 0 0 0 0 ${C.tealLight}00; } }

          .lp-curve { width: 100%; display: block; margin: 14px 0 6px; }
          .lp-line { filter: drop-shadow(0 1px 7px ${C.tealLight}3a); stroke-dasharray: 1; stroke-dashoffset: 0; animation: lpDraw 1.7s ${EASE} forwards; }
          @keyframes lpDraw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
          .lp-area { opacity: 0; animation: lpFade 1.1s ${EASE} 0.5s forwards; }
          @keyframes lpFade { to { opacity: 1; } }
          .lp-stage .lp-guide { opacity: 0; transition: opacity 0.16s ${EASE}; }
          .lp-stage .lp-val { opacity: 0; transition: opacity 0.16s ${EASE}; }
          .lp-stage .lp-val.is-peak { opacity: 1; }
          .lp-stage .lp-dot { transform-box: fill-box; transform-origin: center; transition: transform 0.16s ${EASE}; }
          .lp-stage:hover .lp-guide { opacity: 0.36; }
          .lp-stage:hover .lp-val { opacity: 1; }
          .lp-stage:hover .lp-dot { transform: scale(1.45); }

          .lp-readout { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 0.5px solid ${C.border}; margin-top: 14px; padding-top: 16px; }
          .lp-readout > div { padding-left: 18px; border-left: 0.5px solid ${C.border}; display: flex; flex-direction: column; gap: 6px; }
          .lp-readout > div:first-child { padding-left: 0; border-left: 0; }
          .lp-readout .k { color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; }
          .lp-readout .v { color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }

          /* ---- live stat strip (single contained panel) ---- */
          .lp-stats { display: grid; grid-template-columns: repeat(4, 1fr); border: 0.5px solid ${C.border}; border-radius: 16px; background: ${C.cardGradient}; overflow: hidden; }
          .lp-stat { padding: 28px 28px; border-left: 0.5px solid ${C.border}; }
          .lp-stat:first-child { border-left: 0; }
          .lp-stat .k { display: block; color: ${C.textDim}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
          .lp-stat .v { display: block; color: ${C.textPrimary}; font-family: ${FD}; font-size: 30px; font-weight: 600; letter-spacing: -0.035em; margin: 16px 0 0; font-variant-numeric: tabular-nums; }
          .lp-stat .n { display: block; color: ${C.textMuted}; font-family: ${FS}; font-size: 12.5px; margin-top: 9px; }

          /* ---- product showcase (scroll-driven feature rows) ---- */
          .lp-showcase { display: grid; gap: 56px; margin-top: 64px; }
          /* clean scroll fade — pure opacity, scrubbed by JS via --reveal */
          .scroll-fade { opacity: var(--reveal, 1); will-change: opacity; }
          .feat-row { display: grid; grid-template-columns: 1.06fr 0.94fr; gap: 60px; align-items: center; }
          .feat-row.is-rev .feat-panel { order: 2; }
          .feat-row.is-rev .feat-text { order: 1; }
          .wf-stack { transform: scaleY(0); }
          .is-drawn .wf-stack { animation: wfGrow 0.8s ${EASE} forwards; }
          @keyframes wfGrow { to { transform: scaleY(1); } }
          .wf-lab { opacity: 0; }
          .is-drawn .wf-lab { animation: lpFade 0.6s ${EASE} forwards; }

          .feat-panel { border: 0.5px solid ${C.border}; background: ${C.panelGradient}; border-radius: 16px; padding: 22px 22px 18px; box-shadow: 0 28px 70px rgba(0,0,0,0.32); }
          .feat-panel-head { display: flex; align-items: center; justify-content: space-between; }
          .feat-eyebrow { color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; }
          .feat-chart { width: 100%; display: block; margin: 8px 0 0; }
          .feat-line { stroke-dasharray: 1; stroke-dashoffset: 1; filter: drop-shadow(0 1px 6px ${C.tealLight}26); }
          .is-drawn .feat-line { animation: lpDraw 1.7s ${EASE} forwards; }
          .feat-area { opacity: 0; }
          .is-drawn .feat-area { animation: lpFade 1.1s ${EASE} forwards; }
          .feat-dash { opacity: 0; }
          .is-drawn .feat-dash { animation: lpFade 0.9s ${EASE} forwards; }
          .feat-end { opacity: 0; }
          .is-drawn .feat-end { animation: lpFade 0.6s ${EASE} forwards; }
          .feat-legend { display: flex; gap: 20px; margin-top: 12px; padding-top: 14px; border-top: 0.5px solid ${C.border}; }
          .feat-legend span { display: inline-flex; align-items: center; gap: 8px; color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.04em; }
          .feat-legend i { width: 16px; height: 2px; border-radius: 2px; background: ${C.tealLight}; flex: none; }
          .feat-legend i.dash { background: linear-gradient(90deg, ${C.tealLight} 55%, transparent 0); background-size: 6px 100%; }

          .feat-tag { display: inline-flex; align-items: center; gap: 9px; color: ${C.tealLight}; font-family: ${FM}; font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; }
          .feat-text h3 { color: ${C.textPrimary}; font-family: ${FD}; font-size: 32px; line-height: 1.05; letter-spacing: -0.03em; font-weight: 600; margin: 16px 0 0; }
          .feat-text p { color: ${C.textSubtle}; font-family: ${FS}; font-size: 15px; line-height: 1.62; margin: 16px 0 0; max-width: 440px; }
          .feat-specs { list-style: none; margin: 24px 0 0; display: grid; gap: 11px; }
          .feat-specs li { display: flex; align-items: center; gap: 13px; color: ${C.textSubtle}; font-family: ${FS}; font-size: 14px; }
          .feat-specs li::before { content: ""; width: 14px; height: 1.5px; background: ${C.tealLight}; flex: none; border-radius: 2px; }
          .feat-link { display: inline-flex; align-items: center; gap: 8px; margin-top: 28px; color: ${C.tealLight}; font-family: ${FD}; font-size: 13.5px; font-weight: 600; text-decoration: none; }
          .feat-link .lp-ar { transition: transform 0.18s ${EASE}; }
          .feat-link:hover .lp-ar { transform: translateX(4px); }

          /* ---- flow pipeline (connected schematic) ---- */
          .lp-pipe { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 28px; margin-top: 56px; position: relative; }
          /* connector runs through the node-row centre (node sits below the index eyebrow). */
          .lp-pipe::before { content: ""; position: absolute; top: 55px; left: 12%; right: 12%; height: 1px; background: linear-gradient(90deg, ${C.tealLight}00, ${C.tealLight}5a 12%, ${C.tealLight}28 88%, ${C.tealLight}00); }
          .pipe-stage { position: relative; display: flex; flex-direction: column; align-items: flex-start; }
          /* step index — left-aligned eyebrow above the node, so number / node / name / sub all share one left edge. */
          .pipe-idx { display: block; height: 14px; line-height: 14px; margin-bottom: 16px; color: ${C.tealLight}; opacity: 0.8; font-family: ${FM}; font-size: 12px; letter-spacing: 0.24em; }
          .pipe-node { position: relative; z-index: 1; width: 50px; height: 50px; border-radius: 14px; display: grid; place-items: center; border: 0.5px solid ${C.tealLight}40; background: ${C.surface}; color: ${C.tealLight}; box-shadow: 0 0 0 6px ${C.bg}, 0 8px 22px ${C.tealLight}14; }
          .pipe-name { color: ${C.textPrimary}; font-family: ${FD}; font-size: 16px; font-weight: 600; letter-spacing: -0.015em; margin-top: 20px; }
          .pipe-sub { color: ${C.textMuted}; font-family: ${FM}; font-size: 11px; letter-spacing: 0.04em; margin-top: 7px; }

          /* ---- closing (single spec-sheet panel) ---- */
          .lp-close { display: grid; grid-template-columns: 0.86fr 1.14fr; border: 0.5px solid ${C.border}; border-radius: 16px; background: ${C.cardGradient}; overflow: hidden; }
          .lp-close-left { padding: 36px; display: flex; flex-direction: column; border-right: 0.5px solid ${C.border}; }
          .lp-close-left h3 { color: ${C.textPrimary}; font-family: ${FD}; font-size: 26px; line-height: 1.14; letter-spacing: -0.03em; font-weight: 600; margin: 16px 0 0; max-width: 320px; text-wrap: balance; }
          .lp-close-left p { color: ${C.textSubtle}; font-family: ${FS}; font-size: 14px; line-height: 1.6; margin: 14px 0 0; max-width: 340px; text-wrap: pretty; }
          .lp-close-cta { display: inline-flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 28px; color: ${C.tealLight}; font-family: ${FD}; font-size: 13px; font-weight: 600; text-decoration: none; width: fit-content; }
          .lp-close-cta .lp-ar { transition: transform 0.2s ${EASE}; }
          .lp-close-cta:hover .lp-ar { transform: translateX(4px); }
          .lp-spec { display: flex; flex-direction: column; }
          .lp-spec-row { display: grid; grid-template-columns: 132px minmax(0, 1fr) auto; gap: 18px; align-items: center; padding: 22px 28px; border-top: 0.5px solid ${C.border}; transition: background 0.18s ${EASE}; }
          .lp-spec-row:first-child { border-top: 0; }
          .lp-spec-row:hover { background: ${C.cardHover}; }
          .lp-spec-row .sk { color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
          .lp-spec-row .st { color: ${C.textPrimary}; font-family: ${FD}; font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .lp-spec-row .sv { color: ${C.textSecondary}; font-family: ${FM}; font-size: 12px; text-align: right; white-space: nowrap; }

          /* ---- footer ---- */
          .lp-footer { border-top: 0.5px solid ${C.border}; padding: 64px 0 0; }
          .lp-foot-main { display: grid; grid-template-columns: 1.5fr auto; gap: 40px; align-items: start; }
          .lp-footer-brand strong { display: flex; align-items: center; gap: 10px; color: ${C.textPrimary}; font-family: ${FD}; font-size: 14px; font-weight: 600; letter-spacing: 0.16em; }
          .lp-footer-brand p { color: ${C.textMuted}; font-family: ${FS}; font-size: 13.5px; line-height: 1.6; margin: 16px 0 0; max-width: 320px; }
          .lp-fmark { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; border: 0.5px solid ${C.tealLight}55; background: linear-gradient(145deg, ${C.tealLight}22, ${C.blue}10); }
          .lp-foot-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 64px; }
          .lp-fcol h5 { color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; margin: 0 0 18px; }
          .lp-fcol a { display: block; color: ${C.textSubtle}; font-family: ${FS}; font-size: 13.5px; text-decoration: none; padding: 7px 0; transition: color 0.16s ${EASE}; }
          .lp-fcol a:hover { color: ${C.tealLight}; }
          .lp-footer-base { margin-top: 56px; padding: 22px 0 8px; border-top: 0.5px solid ${C.border}; display: flex; align-items: center; justify-content: space-between; gap: 16px; color: ${C.textMuted}; font-family: ${FM}; font-size: 11px; letter-spacing: 0.04em; flex-wrap: wrap; }

          .lp-btn:focus-visible, .feat-link:focus-visible, .lp-spec-row:focus-visible, .lp-fcol a:focus-visible, .lp-close-cta:focus-visible {
            outline: 2px solid ${C.tealLight}; outline-offset: 3px; border-radius: 9px;
          }

          @media (prefers-reduced-motion: reduce) {
            .lp-line { animation: none; stroke-dashoffset: 0; }
            .lp-area { animation: none; opacity: 1; }
            .lp-live i.is-live { animation: none; }
            .scroll-fade { opacity: 1; }
            .feat-line { animation: none; stroke-dashoffset: 0; }
            .feat-area, .feat-dash, .feat-end { animation: none; opacity: 1; }
            .wf-stack { animation: none; transform: none; }
            .wf-lab { animation: none; opacity: 1; }
          }

          @media (max-width: 1080px) {
            .lp-hero { grid-template-columns: 1fr; gap: 40px; padding-top: 40px; }
            .lp-stats, .lp-pipe { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .lp-pipe { gap: 36px 28px; }
            .lp-pipe::before { display: none; }
            .lp-stat:nth-child(3) { border-left: 0; }
            .feat-row { grid-template-columns: 1fr; gap: 28px; }
            .feat-row.is-rev .feat-panel { order: 1; }
            .feat-row.is-rev .feat-text { order: 2; }
            .lp-close { grid-template-columns: 1fr; }
            .lp-close-left { border-right: 0; border-bottom: 0.5px solid ${C.border}; }
            .lp-foot-main { grid-template-columns: 1fr; gap: 32px; }
          }
          @media (max-width: 620px) {
            .lp-stats, .lp-pipe { grid-template-columns: 1fr; }
            .lp-stat { border-left: 0; }
            .lp-readout { grid-template-columns: repeat(2, 1fr); gap: 16px 0; }
            .lp-readout > div:nth-child(3) { border-left: 0; padding-left: 0; }
            .lp-spec-row { grid-template-columns: 1fr; gap: 6px; }
            .lp-spec-row .sv { text-align: left; }
            .lp-trust { flex-wrap: wrap; gap: 8px 0; }
          }
        `}</style>

        <div className="lp-shell">
          {/* ---------------- HERO ---------------- */}
          <section className="lp-hero">
            <div>
              <div className="lp-eyebrow">Sui testnet · structured markets</div>
              <h1 className="lp-hero-title">
                Structured products on <em>live market probability</em>
              </h1>
              <p className="lp-hero-sub">
                Pelagos turns prediction-market pricing into four composable products: distribution
                curves, baskets, risk slices, and protected notes. Each is collateralized in USDC and
                settled on Sui.
              </p>
              <div className="lp-actions">
                <Link className="lp-btn lp-btn-primary" href="/app/portfolio">
                  Launch app <span className="lp-ar"><IconArrow /></span>
                </Link>
                <a className="lp-btn lp-btn-ghost" href="#products">
                  Explore the products
                </a>
              </div>
              <div className="lp-trust">
                <span>Live DeepBook pricing</span>
                <span>USDC collateral</span>
                <span>Settled on Sui</span>
              </div>
            </div>

            <CurveTerminal candidate={candidate} ready={chartReady} />
          </section>

          {/* ---------------- LIVE STAT STRIP ---------------- */}
          <section className="scroll-fade">
            <div className="lp-stats" aria-label="Live Pelagos metrics">
              {stats.map((s) => (
                <div key={s.label} className="lp-stat">
                  <span className="k">{s.label}</span>
                  <span className="v">{s.value}</span>
                  <span className="n">{s.note}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ---------------- PRODUCT SHOWCASE (scroll-driven) ---------------- */}
          <section className="lp-section" id="products">
            <div className="lp-showcase">
              {SHOWCASE.map((item, i) => (
                <FeatureRow key={item.id} item={item} index={i} />
              ))}
            </div>
          </section>

          {/* ---------------- HOW IT WORKS (pipeline) ---------------- */}
          <section className="lp-section scroll-fade" id="how">
            <div className="lp-head">
              <div className="lp-eyebrow">How Pelagos works</div>
              <h2>Market pricing in, an on-chain position out</h2>
              <p>Four stages take a live quote to a settled Sui position.</p>
            </div>
            <div className="lp-pipe">
              {PIPE.map((p, i) => (
                <div className="pipe-stage" key={p.name}>
                  <span className="pipe-idx">0{i + 1}</span>
                  <div className="pipe-node"><p.Icon size={19} /></div>
                  <div className="pipe-name">{p.name}</div>
                  <div className="pipe-sub">{p.sub}</div>
                </div>
              ))}
            </div>
          </section>

          {/* ---------------- CLOSING / EXECUTION ---------------- */}
          <section className="lp-section scroll-fade">
            <div className="lp-close">
              <div className="lp-close-left">
                <div className="lp-eyebrow">Execution rails</div>
                <h3>The plumbing stays out of your way</h3>
                <p>Pelagos folds live order books and yields into one quote, then writes the position to Sui.</p>
                <div className="lp-actions">
                  <Link className="lp-btn lp-btn-primary" href="/app">
                    Enter app <span className="lp-ar"><IconArrow /></span>
                  </Link>
                </div>
              </div>
              <div className="lp-spec">
                {[
                  ["Market data", candidate?.title ?? "Distribution candidates", candidate ? `${candidate.clob_book_count}/${candidate.band_count} CLOB books` : "Gamma + CLOB"],
                  ["Quote asset", "USDC collateral, net-route accounting", fmtUsd(net, 0)],
                  ["Vault split", "Protected sleeve vs. market upside", `${pct(protectedVaultPct, 1)} / ${pct(basketPct, 1)}`],
                  ["On-chain", "Sui testnet mock-USDC package route", "Configured"],
                ].map(([k, t, v]) => (
                  <div className="lp-spec-row" key={k}>
                    <span className="sk">{k}</span>
                    <span className="st">{t}</span>
                    <span className="sv">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ---------------- FOOTER ---------------- */}
          <footer className="lp-footer scroll-fade">
            <div className="lp-foot-main">
              <div className="lp-footer-brand">
                <strong>
                  <span className="lp-fmark" aria-hidden>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                      <path d="M3.5 13.4C5.6 10.9 7.8 9.7 10 9.7c2.6 0 3.7 2.4 6 2.4 1.6 0 2.8-.7 4.5-2.3" stroke={C.tealLight} strokeWidth="2" strokeLinecap="round" />
                      <path d="M3.5 9.1C5.6 6.6 7.8 5.4 10 5.4c2.6 0 3.7 2.4 6 2.4 1.6 0 2.8-.7 4.5-2.3" stroke={C.teal} strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </span>
                  PELAGOS
                </strong>
                <p>Structured prediction-market products, collateralized in USDC and settled on Sui.</p>
              </div>
              <div className="lp-foot-cols">
                <div className="lp-fcol">
                  <h5>Products</h5>
                  {SURFACES.map((s) => (
                    <Link key={s.id} href={s.href}>{s.title}</Link>
                  ))}
                </div>
                <div className="lp-fcol">
                  <h5>Resources</h5>
                  <Link href="/app/portfolio">Portfolio</Link>
                  <Link href="/app/docs">About &amp; docs</Link>
                  <a href="https://github.com/tharune/Pelagos-SUI-Overflow" target="_blank" rel="noreferrer">GitHub</a>
                </div>
              </div>
            </div>
            <div className="lp-footer-base">
              <span>© 2026 Pelagos · Sui testnet · USDC-collateralized</span>
              <span>Built for Sui Overflow</span>
            </div>
          </footer>
        </div>
      </PageFrame>
    </>
  );
}
