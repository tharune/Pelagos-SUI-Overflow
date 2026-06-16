"use client";
/**
 * Shared chart + card primitives — orbital dark-space theme.
 */

import React, { useEffect, useRef, useState } from "react";
import { C, FM, FS, FD, EASE, lightenColor, darkenColor, tc } from "../_lib/tokens";
import { traceMonotone } from "../_lib/curve";

export function Sparkline({
  data,
  color,
  height = 48,
  width,
}: {
  data: number[];
  color: string;
  height?: number;
  /**
   * Optional explicit pixel width. When omitted (preferred), the chart sizes
   * itself to its container via ResizeObserver so the rightmost data point
   * always lands at the right edge of the card instead of being clipped by
   * `overflow: hidden` on narrower parents.
   */
  width?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);

  // Track the container's actual rendered width. We intentionally ignore the
  // `width` prop here when not supplied — container-driven sizing keeps the
  // sparkline crisp at every zoom level / viewport width.
  useEffect(() => {
    if (width !== undefined) return; // caller pinned an explicit width
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.max(1, Math.round(entries[0].contentRect.width));
      setMeasured(w);
    });
    ro.observe(el);
    // Prime once synchronously so the first paint isn't empty.
    setMeasured(Math.max(1, Math.round(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, [width]);

  const renderWidth = width ?? measured;

  useEffect(() => {
    const c = ref.current;
    if (!c || !renderWidth) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    c.width = renderWidth * dpr;
    c.height = height * dpr;
    c.style.width = renderWidth + "px";
    c.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, renderWidth, height);
    // Need >= 2 points to draw a line; bail cleanly on empty/single data
    // (Math.min(...[]) is Infinity and pts[last] would be undefined → crash).
    if (!data || data.length < 2) return;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 0.01;
    const pad = 3;
    const pts = data.map((v, i) => ({
      x: pad + (i / (data.length - 1)) * (renderWidth - pad * 2),
      y: pad + (1 - (v - min) / range) * (height - pad * 2),
    }));
    // Larger charts (e.g. the basket-detail hero) get the premium treatment —
    // a thicker glowing line and an endpoint marker. Tiny card sparklines stay
    // minimal so they don't pick up clutter.
    const big = height >= 80;
    const last = pts[pts.length - 1];

    // Smoothed area fill with a vertical gradient fade. Uses the same monotone
    // curve as every other chart so the line reads identically app-wide.
    ctx.beginPath();
    traceMonotone(ctx, pts);
    ctx.lineTo(last.x, height);
    ctx.lineTo(pts[0].x, height);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad, 0, height);
    grad.addColorStop(0, color + (big ? "30" : "20"));
    grad.addColorStop(1, color + "00");
    ctx.fillStyle = grad;
    ctx.fill();

    // Stroke the line on top of the fill.
    ctx.beginPath();
    traceMonotone(ctx, pts);
    ctx.strokeStyle = color;
    ctx.lineWidth = big ? 2 : 1.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (big) {
      ctx.shadowColor = color + "66";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.shadowOffsetY = 0;

    // Endpoint marker for the large variant.
    if (big) {
      ctx.beginPath();
      ctx.arc(last.x, last.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }, [data, color, height, renderWidth]);

  // Wrapper div is what ResizeObserver watches — it always fills the parent
  // horizontally. The canvas is sized to match in pixels so its drawing
  // coordinates line up 1:1 with the displayed box (no more fixed 520px
  // overflow that the previous implementation produced).
  return (
    <div
      ref={wrapRef}
      style={{ display: "block", width: "100%", height: height + "px", position: "relative" }}
    >
      <canvas ref={ref} style={{ display: "block" }} />
    </div>
  );
}

export function PulseGauge({
  prob,
  color,
  size = 56,
}: {
  prob: number;
  color: string;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    c.style.width = size + "px";
    c.style.height = size + "px";
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(45, 212, 191, 0.12)";
    ctx.lineCap = "round";
    ctx.stroke();
    const endAngle = Math.PI * 0.75 + (prob / 100) * Math.PI * 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 0.75, endAngle);
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.stroke();
  }, [prob, color, size]);
  return <canvas ref={ref} />;
}

// ---------- SVG donut ----------

function polarToCartesian(cx: number, cy: number, r: number, angleRad: number) {
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function arcPath(cx: number, cy: number, rOuter: number, rInner: number, startAngle: number, endAngle: number) {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const start = polarToCartesian(cx, cy, rOuter, startAngle);
  const end = polarToCartesian(cx, cy, rOuter, endAngle);
  const startIn = polarToCartesian(cx, cy, rInner, endAngle);
  const endIn = polarToCartesian(cx, cy, rInner, startAngle);
  return `M ${start.x} ${start.y} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${end.x} ${end.y} L ${startIn.x} ${startIn.y} A ${rInner} ${rInner} 0 ${largeArc} 0 ${endIn.x} ${endIn.y} Z`;
}

export function SvgDonut({
  data,
  size,
  activeId,
  onHover,
  isEmpty,
  lightMode = false,
}: {
  data: { id: string; value: number; color: string }[];
  size: number;
  activeId: string | null;
  onHover: (id: string | null) => void;
  isEmpty?: boolean;
  /** Flat white hole + no inner gradient wash. Dark mode (default) keeps
   *  the navy `innerFrost` gradient that reads well on a dark card. */
  lightMode?: boolean;
}) {
  const PAD = 32;
  const TOTAL = size + PAD * 2;
  const cx = TOTAL / 2;
  const cy = TOTAL / 2;
  const baseR = size * 0.355;
  const thickness = size * 0.11;
  const gap = 0.024;

  if (isEmpty || data.length === 0) {
    return (
      <svg width={TOTAL} height={TOTAL} style={{ display: "block" }}>
        <circle cx={cx} cy={cy} r={baseR + thickness / 2} fill="none" stroke="rgba(45, 212, 191, 0.08)" strokeWidth={thickness} opacity={0.5} />
        <circle cx={cx} cy={cy} r={baseR - 1} fill={C.surface} stroke="rgba(45, 212, 191, 0.08)" strokeWidth={0.5} />
      </svg>
    );
  }

  const total = data.reduce((s, d) => s + d.value, 0);
  type Slice = { id: string; value: number; color: string; start: number; end: number };
  const slices: Slice[] = data.reduce<Slice[]>((acc, d) => {
    const start = acc.length ? acc[acc.length - 1].end : -Math.PI / 2;
    const span = (d.value / total) * Math.PI * 2;
    acc.push({ ...d, start, end: start + span });
    return acc;
  }, []);

  return (
    <svg width={TOTAL} height={TOTAL} style={{ display: "block" }} onMouseLeave={() => onHover(null)}>
      <defs>
        {slices.map((s) => (
          <linearGradient key={`grad-${s.id}`} id={`grad-${s.id}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={lightenColor(s.color, 0.25)} />
            <stop offset="50%" stopColor={s.color} />
            <stop offset="100%" stopColor={darkenColor(s.color, 0.18)} />
          </linearGradient>
        ))}
        <radialGradient id="innerFrost" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#1a2536" stopOpacity="1" />
          <stop offset="70%" stopColor={C.card} stopOpacity="1" />
          <stop offset="100%" stopColor="#0c131c" stopOpacity="1" />
        </radialGradient>
      </defs>
      {slices.map((s) => {
        const isActive = activeId === s.id;
        const isNone = activeId === null;
        const midAngle = (s.start + s.end) / 2;
        const offsetDist = isActive ? 6 : 0;
        const ox = Math.cos(midAngle) * offsetDist;
        const oy = Math.sin(midAngle) * offsetDist;
        const outerR = baseR + thickness + (isActive ? 8 : 0);
        const innerR = baseR - (isActive ? 1 : 0);
        const adjStart = s.start + gap / 2;
        const adjEnd = s.end - gap / 2;
        return (
          <g
            key={s.id}
            transform={`translate(${ox} ${oy})`}
            style={{
              opacity: isNone ? 1 : isActive ? 1 : 0.18,
              transition: `opacity 0.35s ${EASE}, transform 0.4s ${EASE}`,
              cursor: "pointer",
            }}
            onMouseEnter={() => onHover(s.id)}
          >
            <path d={arcPath(cx, cy, outerR, innerR, adjStart, adjEnd)} fill={`url(#grad-${s.id})`} style={{ transition: `d 0.4s ${EASE}` }} />
            <path d={arcPath(cx, cy, outerR, outerR - 2, adjStart, adjEnd)} fill={lightenColor(s.color, 0.45)} opacity="0.5" />
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={baseR - 1} fill={lightMode ? "#ffffff" : "url(#innerFrost)"} />
      <circle cx={cx} cy={cy} r={baseR - 1} fill="none" stroke="rgba(45, 212, 191, 0.1)" strokeWidth="0.5" opacity="0.6" />
    </svg>
  );
}

// ---------- Cards ----------

export function BundleCard({
  bundle,
  onClick,
}: {
  bundle: { id: string; tier: number; nav: number; change: number; history: number[]; date: string; daysLeft: number; resolved: number; totalLegs: number };
  onClick: () => void;
}) {
  const [hov, setHov] = React.useState(false);
  const color = tc(bundle.tier);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: hov
          ? C.cardGradientHover
          : C.cardGradient,
        border: `0.5px solid ${hov ? color + "50" : "rgba(255, 255, 255, 0.06)"}`,
        borderRadius: 16,
        padding: "18px 20px 14px",
        cursor: "pointer",
        transition: `all 0.3s ${EASE}`,
        position: "relative",
        overflow: "hidden",
        transform: hov ? "translateY(-2px)" : "translateY(0)",
        boxShadow: hov ? `0 12px 32px rgba(0,0,0,0.4), 0 0 24px ${color}18` : "0 4px 14px rgba(0,0,0,0.2)",
        backdropFilter: "blur(10px)",
      }}
    >
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: color, opacity: hov ? 1 : 0.75 }} />
      <div style={{ position: "absolute", top: -60, right: -60, width: 180, height: 180, background: `radial-gradient(circle, ${color}20 0%, transparent 65%)`, pointerEvents: "none", opacity: hov ? 1 : 0.4, transition: `opacity 0.3s ${EASE}` }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, position: "relative" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD, marginBottom: 4, letterSpacing: "0.01em" }}>{bundle.id}</div>
          <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FM, letterSpacing: "0.04em" }}>
            {bundle.resolved}/{bundle.totalLegs} resolved · {bundle.daysLeft}d left
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 26, fontWeight: 300, color, fontFamily: FD, lineHeight: 1, letterSpacing: "-0.02em" }}>{(bundle.nav * 100).toFixed(1)}%</div>
          <div style={{ fontSize: 11, color: C.textSecondary, fontFamily: FM, marginTop: 3 }}>${bundle.nav.toFixed(3)}</div>
        </div>
      </div>
      <div style={{ marginBottom: 10, height: 44 }}>
        <Sparkline data={bundle.history} color={color} height={44} width={300} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: FM, letterSpacing: "0.02em", position: "relative" }}>
        <span style={{ color: bundle.change >= 0 ? C.green : C.red, fontWeight: 500 }}>
          {bundle.change >= 0 ? "+" : ""}{bundle.change.toFixed(1)}% today
        </span>
        <span style={{ color: C.textMuted }}>Resolves {bundle.date}</span>
      </div>
    </div>
  );
}

export function MetricTile({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div style={{
      background: C.cardGradient,
      border: `0.5px solid ${C.border}`,
      borderRadius: 14,
      padding: "18px 20px",
      position: "relative",
      overflow: "hidden",
      backdropFilter: "blur(10px)",
    }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1.5, background: `linear-gradient(to right, transparent, ${color || C.tealLight}66, transparent)`, opacity: 0.6 }} />
      <div style={{ position: "absolute", top: -40, right: -40, width: 120, height: 120, borderRadius: "50%", background: `radial-gradient(circle, ${color || C.tealLight}15 0%, transparent 65%)`, pointerEvents: "none" }} />
      <div style={{ fontSize: 10, color: C.textMuted, fontFamily: FM, letterSpacing: "0.14em", marginBottom: 10, position: "relative" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, color: color ?? C.textPrimary, fontFamily: FD, letterSpacing: "-0.01em", position: "relative" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, marginTop: 6, position: "relative" }}>{sub}</div>}
    </div>
  );
}

export function Pill({
  children,
  active,
  onClick,
  color,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "7px 16px",
        borderRadius: 100,
        border: `0.5px solid ${active ? (color || C.tealLight) : "rgba(255, 255, 255, 0.08)"}`,
        background: active ? `${color || C.tealLight}15` : C.surface,
        color: active ? (color || C.tealLight) : C.textSecondary,
        fontSize: 12,
        fontFamily: FD,
        cursor: "pointer",
        transition: `all 0.2s ${EASE}`,
        fontWeight: active ? 500 : 400,
        boxShadow: active ? `0 0 16px ${color || C.tealLight}20` : "none",
        letterSpacing: "0.01em",
      }}
    >
      {children}
    </button>
  );
}