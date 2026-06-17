"use client";

// ---------------------------------------------------------------------------
// Live portfolio chart — mark-to-market VALUE over time, scoped to the whole
// portfolio or a single position/product. The deployed (position) portion is
// marked to the REAL BTC oracle forward (polled every 3s); idle cash stays flat.
// This plots your account value — NEVER the BTC price. The live forward is shown
// only as a small labeled reference chip. With nothing open, the chart shows a
// clean empty state (an empty book has no live marks). Drag to scrub.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { fetchForward } from "../_lib/predict-strip-client";

export interface ChartScope {
  id: string;
  label: string;
  valueUsd: number; // current $ value of this deployed position/product
}

interface Tick {
  t: number;
  forward: number;
}

const POLL_MS = 3000;
const MAX_TICKS = 160;

export function LivePortfolioChart({ portfolioValue, positions }: { portfolioValue: number; positions: ChartScope[] }) {
  const deployed = useMemo(() => positions.reduce((s, p) => s + p.valueUsd, 0), [positions]);
  const cash = Math.max(0, portfolioValue - deployed);
  const scopes = useMemo<ChartScope[]>(
    () => [{ id: "portfolio", label: "Whole portfolio", valueUsd: portfolioValue }, ...positions],
    [portfolioValue, positions],
  );
  const [scopeId, setScopeId] = useState("portfolio");
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const f0 = useRef<number | null>(null);

  // Poll the real BTC forward every 3s — the live mark driver.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const f = await fetchForward("BTC");
        if (!alive || !(f.forward > 0)) return;
        if (f0.current == null) f0.current = f.forward;
        setTicks((prev) => [...prev, { t: Date.now(), forward: f.forward }].slice(-MAX_TICKS));
      } catch {
        /* keep last marks on a transient failure */
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const scope = scopes.find((s) => s.id === scopeId) ?? scopes[0];
  // For the whole portfolio: idle cash is flat, the deployed positions mark to BTC.
  // For a single position: its whole value marks to BTC.
  const flat = scope.id === "portfolio" ? cash : 0;
  const markable = scope.id === "portfolio" ? deployed : scope.valueUsd;
  const hasValue = flat + markable > 0;
  const baseF = f0.current ?? ticks[0]?.forward ?? 0;

  // VALUE series = idle cash + deployed marked to the forward move. Never the price.
  const series = ticks.map((tk) => (baseF > 0 ? flat + markable * (tk.forward / baseF) : flat + markable));

  const W = 920;
  const H = 230;
  const padL = 8;
  const padR = 8;
  const padT = 16;
  const padB = 22;
  const n = series.length;
  const lo = n ? Math.min(...series) : 0;
  const hi = n ? Math.max(...series) : 1;
  const span = hi - lo || Math.max(1, Math.abs(hi) * 0.02 || 1);
  const yLo = lo - span * 0.18;
  const yHi = hi + span * 0.18;
  const x = (i: number) => padL + (n <= 1 ? 0.5 : i / (n - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - yLo) / (yHi - yLo || 1)) * (H - padT - padB);

  const linePts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaPts = n ? `${x(0).toFixed(1)},${(H - padB).toFixed(1)} ${linePts} ${x(n - 1).toFixed(1)},${(H - padB).toFixed(1)}` : "";

  const idx = hoverIdx != null && hoverIdx < n ? hoverIdx : n - 1;
  const cur = series[idx] ?? flat + markable;
  const first = series[0] ?? cur;
  const delta = cur - first;
  const deltaPct = first ? (delta / first) * 100 : 0;
  const fmtUsd = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const svgRef = useRef<SVGSVGElement | null>(null);
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (n === 0 || !hasValue) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - padL) / (W - padL - padR)) * (n - 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, i)));
  }

  return (
    <div>
      {/* scope selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <div className="lpc-scopes">
          {scopes.map((s) => (
            <button key={s.id} className={`lpc-scope${s.id === scopeId ? " is-active" : ""}`} onClick={() => { setScopeId(s.id); setHoverIdx(null); }}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* headline value (real account value — never the BTC price) */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{ fontFamily: FD, fontSize: 26, fontWeight: 600, color: C.textPrimary, letterSpacing: "-0.02em" }}>
          {fmtUsd(hasValue ? cur : 0)}
        </span>
        {hasValue && markable > 0 && n > 1 && (
          <span style={{ fontFamily: FM, fontSize: 12, color: delta >= 0 ? C.green : C.red }}>
            {delta >= 0 ? "+" : ""}{fmtUsd(delta)} ({deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(2)}%)
          </span>
        )}
        <span style={{ fontFamily: FM, fontSize: 10.5, color: C.textMuted }}>
          {!hasValue ? "no open positions" : markable > 0 ? "mark-to-market" : "idle cash"}
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block", touchAction: "none", cursor: hasValue ? "crosshair" : "default" }}
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="lpc-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.tealLight} stopOpacity="0.22" />
            <stop offset="100%" stopColor={C.tealLight} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {!hasValue ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontFamily={FM} fontSize={12} fill={C.textMuted}>
            No open positions yet. Open a strip to see its live mark-to-market here.
          </text>
        ) : n > 0 ? (
          <>
            <polygon points={areaPts} fill="url(#lpc-fill)" />
            <polyline points={linePts} fill="none" stroke={C.tealLight} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <line x1={x(idx)} y1={padT} x2={x(idx)} y2={H - padB} stroke={C.textMuted} strokeWidth={0.5} strokeDasharray="3 4" opacity={0.7} vectorEffect="non-scaling-stroke" />
            <circle cx={x(idx)} cy={y(cur)} r={3.5} fill={C.tealLight} />
          </>
        ) : (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontFamily={FM} fontSize={12} fill={C.textMuted}>waiting for first tick…</text>
        )}
      </svg>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontFamily: FM, fontSize: 9.5, color: C.textMuted }}>
        <span>{ticks[0] ? new Date(ticks[0].t).toLocaleTimeString() : "—"}</span>
        <span style={{ color: C.textSecondary }}>
          {hasValue && hoverIdx != null && ticks[idx] ? `${new Date(ticks[idx].t).toLocaleTimeString()} · ${fmtUsd(cur)}` : hasValue ? "drag across to scrub" : ""}
        </span>
        <span>now</span>
      </div>

      <style jsx global>{`
        @keyframes lpc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        .lpc-scopes { display: flex; gap: 6px; flex-wrap: wrap; min-width: 0; }
        .lpc-scope { padding: 5px 11px; border-radius: 999px; border: 0.5px solid ${C.border}; background: transparent; color: ${C.textSecondary}; font-family: ${FD}; font-size: 11.5px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: all 0.14s ${EASE}; }
        .lpc-scope:hover { border-color: ${C.borderHover}; color: ${C.textPrimary}; }
        .lpc-scope.is-active { border-color: ${C.tealLight}; background: ${C.cardHover}; color: ${C.textPrimary}; }
      `}</style>
    </div>
  );
}
