"use client";

// ---------------------------------------------------------------------------
// Interactive volatility surface — a Bloomberg-OVDV-style viewer over the live
// DeepBook SVI surface. Three views: a drag-to-rotate 3D surface, a Smile (IV
// vs strike for one expiry), and a Term structure (IV vs expiry for a chosen
// ATM/OTM strike). Pure SVG, no deps. All data is the live SVI feed.
// ---------------------------------------------------------------------------

import React, { useMemo, useRef, useState } from "react";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import type { VolSurface } from "../_lib/predict-strip-client";

type ViewMode = "surface" | "smile" | "term";

// Strike presets (log-moneyness, in % of forward) for the term-structure slice.
const STRIKE_PRESETS = [
  { k: -0.1, label: "−10%" },
  { k: -0.05, label: "−5%" },
  { k: 0, label: "ATM" },
  { k: 0.05, label: "+5%" },
  { k: 0.1, label: "+10%" },
];

function rotate(x: number, y: number, z: number, yaw: number, pitch: number) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  return { x: x1, y: y2, z: z2 };
}

export function VolSurfaceInteractive({ surface }: { surface: VolSurface }) {
  // Drop seconds-to-expiry slices: as T→0 the SVI smile blows up (extreme IV/skew)
  // and distorts the surface. Keep ≥5-min tenors.
  const usable = useMemo(() => surface.slices.filter((s) => s.points.length >= 3 && s.t_years > 300 / 31_557_600), [surface]);
  const [view, setView] = useState<ViewMode>("surface");
  const [yaw, setYaw] = useState(0.62);
  const [pitch, setPitch] = useState(0.52);
  const [smileExpiry, setSmileExpiry] = useState(0);
  const [strikeIdxPreset, setStrikeIdxPreset] = useState(2); // ATM
  const drag = useRef<{ x: number; y: number } | null>(null);

  if (usable.length < 2) return null;
  const cols = Math.min(...usable.map((s) => s.points.length));
  const rows = usable.length;
  const atmCol = Math.round((cols - 1) / 2);

  let ivMin = Infinity, ivMax = -Infinity;
  for (const s of usable) for (let c = 0; c < cols; c++) { const iv = s.points[c].iv; if (iv < ivMin) ivMin = iv; if (iv > ivMax) ivMax = iv; }
  const ivN = (iv: number) => (iv - ivMin) / ((ivMax - ivMin) || 1);

  const W = 1000, H = 460;

  // map a strike preset (log-moneyness) to the nearest column index
  const colForK = (kTarget: number) => {
    let best = atmCol, bestD = Infinity;
    for (let c = 0; c < cols; c++) {
      const d = Math.abs(usable[0].points[c].log_moneyness - kTarget);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  };

  // ---- pointer drag → rotate (surface view only) ----
  function onDown(e: React.PointerEvent) {
    if (view !== "surface") return;
    drag.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setYaw((v) => v + dx * 0.006);
    setPitch((v) => Math.max(-0.2, Math.min(1.15, v + dy * 0.005)));
  }
  function onUp() { drag.current = null; }

  // ===== 3D SURFACE =====
  const surfaceSvg = useMemo(() => {
    const cx = W / 2, cy = H / 2 + 40, scale = 235, heightScale = 1.05;
    const project = (c: number, r: number, iv: number) => {
      const gx = (c / (cols - 1) - 0.5) * 2;
      const gz = (r / (rows - 1) - 0.5) * 2;
      const gy = (ivN(iv) - 0.5) * heightScale;
      const p = rotate(gx, gy, gz, yaw, pitch);
      return { sx: cx + p.x * scale, sy: cy - p.y * scale * 0.82, depth: p.z };
    };
    type Quad = { pts: string; depth: number; fill: number };
    const quads: Quad[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = project(c, r, usable[r].points[c].iv);
        const b = project(c + 1, r, usable[r].points[c + 1].iv);
        const d = project(c + 1, r + 1, usable[r + 1].points[c + 1].iv);
        const e = project(c, r + 1, usable[r + 1].points[c].iv);
        quads.push({
          pts: `${a.sx.toFixed(1)},${a.sy.toFixed(1)} ${b.sx.toFixed(1)},${b.sy.toFixed(1)} ${d.sx.toFixed(1)},${d.sy.toFixed(1)} ${e.sx.toFixed(1)},${e.sy.toFixed(1)}`,
          depth: (a.depth + b.depth + d.depth + e.depth) / 4,
          fill: ivN((usable[r].points[c].iv + usable[r + 1].points[c + 1].iv) / 2),
        });
      }
    }
    quads.sort((p, q) => p.depth - q.depth); // far (small depth) first
    const ridge = usable.map((s, r) => project(atmCol, r, s.points[atmCol].iv)).map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(" ");
    return { quads, ridge };
  }, [usable, cols, rows, atmCol, yaw, pitch, ivMin, ivMax]);

  return (
    <div>
      {/* view toggle + slice selector */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <div className="vs-seg">
          {(["surface", "smile", "term"] as ViewMode[]).map((v) => (
            <button key={v} className={`vs-seg-btn${view === v ? " is-active" : ""}`} onClick={() => setView(v)}>
              {v === "surface" ? "3D surface" : v === "smile" ? "Smile" : "Term structure"}
            </button>
          ))}
        </div>
        {view === "smile" && (
          <div className="vs-seg">
            {usable.map((s, i) => (
              <button key={s.oracle_id} className={`vs-seg-btn${smileExpiry === i ? " is-active" : ""}`} onClick={() => setSmileExpiry(i)}>{s.tenor_label}</button>
            ))}
          </div>
        )}
        {view === "term" && (
          <div className="vs-seg">
            {STRIKE_PRESETS.map((p, i) => (
              <button key={p.label} className={`vs-seg-btn${strikeIdxPreset === i ? " is-active" : ""}`} onClick={() => setStrikeIdxPreset(i)}>{p.label}</button>
            ))}
          </div>
        )}
        {view === "surface" && <span style={{ fontFamily: FM, fontSize: 10.5, color: C.textMuted }}>drag to rotate</span>}
      </div>

      {view === "surface" && (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", cursor: drag.current ? "grabbing" : "grab", touchAction: "none" }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
          {surfaceSvg.quads.map((q, i) => (
            <polygon key={i} points={q.pts} fill={C.tealLight} fillOpacity={0.07 + 0.5 * q.fill} stroke={C.tealLight} strokeOpacity={0.22} strokeWidth={0.5} />
          ))}
          <polyline points={surfaceSvg.ridge} fill="none" stroke={C.amber} strokeWidth={2} strokeOpacity={0.92} strokeLinejoin="round" />
          <text x={20} y={26} fontFamily={FM} fontSize={11} fill={C.textMuted}>near → far expiry · ±{(surface.strikes_pct * 100).toFixed(0)}% strike</text>
          <text x={W - 14} y={26} textAnchor="end" fontFamily={FM} fontSize={11} fill={C.tealLight}>IV {(ivMin * 100).toFixed(0)}–{(ivMax * 100).toFixed(0)}%</text>
          <text x={W - 14} y={H - 12} textAnchor="end" fontFamily={FM} fontSize={10} fill={C.amber}>ATM ridge</text>
        </svg>
      )}

      {view === "smile" && <Slice2D usable={usable} cols={cols} kind="smile" sliceIdx={smileExpiry} atmCol={atmCol} surface={surface} />}
      {view === "term" && <Slice2D usable={usable} cols={cols} kind="term" sliceIdx={colForK(STRIKE_PRESETS[strikeIdxPreset].k)} atmCol={atmCol} surface={surface} />}

      <style jsx global>{`
        .vs-seg { display: inline-flex; gap: 4px; padding: 3px; border-radius: 999px; border: 0.5px solid ${C.border}; background: ${C.surface}; flex-wrap: wrap; }
        .vs-seg-btn { appearance: none; border: 0; background: transparent; border-radius: 999px; padding: 5px 11px; color: ${C.textSecondary}; font-family: ${FM}; font-size: 10.5px; cursor: pointer; transition: all 0.14s ${EASE}; }
        .vs-seg-btn:hover { color: ${C.textPrimary}; }
        .vs-seg-btn.is-active { background: ${C.card}; color: ${C.textPrimary}; }
      `}</style>
    </div>
  );
}

// 2D smile / term slice.
function Slice2D({ usable, cols, kind, sliceIdx, atmCol, surface }: {
  usable: VolSurface["slices"]; cols: number; kind: "smile" | "term"; sliceIdx: number; atmCol: number; surface: VolSurface;
}) {
  const W = 1000, H = 360, padL = 56, padR = 20, padT = 24, padB = 40;
  // smile: iv across strikes for expiry=sliceIdx. term: iv across expiries at strike-col=sliceIdx.
  const pts: Array<{ label: number; iv: number }> = kind === "smile"
    ? usable[Math.min(sliceIdx, usable.length - 1)].points.slice(0, cols).map((p) => ({ label: p.log_moneyness * 100, iv: p.iv }))
    : usable.map((s) => ({ label: s.t_years, iv: s.points[Math.min(sliceIdx, cols - 1)].iv }));
  const n = pts.length;
  const ivs = pts.map((p) => p.iv);
  const lo = Math.min(...ivs) * 0.96, hi = Math.max(...ivs) * 1.04;
  const x = (i: number) => padL + (n <= 1 ? 0.5 : i / (n - 1)) * (W - padL - padR);
  const y = (iv: number) => H - padB - ((iv - lo) / ((hi - lo) || 1)) * (H - padT - padB);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.iv).toFixed(1)}`).join(" ");
  const area = `${x(0).toFixed(1)},${(H - padB).toFixed(1)} ${line} ${x(n - 1).toFixed(1)},${(H - padB).toFixed(1)}`;
  const title = kind === "smile"
    ? `IV smile · ${usable[Math.min(sliceIdx, usable.length - 1)].tenor_label} expiry · forward $${Math.round(surface.forward_usd).toLocaleString()}`
    : `ATM term structure · ${surface.slices.length} expiries`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <defs>
        <linearGradient id="vs-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.tealLight} stopOpacity="0.18" />
          <stop offset="100%" stopColor={C.tealLight} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <text x={padL} y={16} fontFamily={FM} fontSize={11} fill={C.textMuted}>{title}</text>
      {[lo, (lo + hi) / 2, hi].map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke={C.border} strokeWidth={0.5} opacity={0.5} />
          <text x={padL - 8} y={y(t) + 3} textAnchor="end" fontFamily={FM} fontSize={10} fill={C.textMuted}>{(t * 100).toFixed(0)}%</text>
        </g>
      ))}
      <polygon points={area} fill="url(#vs-fill)" />
      <polyline points={line} fill="none" stroke={kind === "term" ? C.amber : C.tealLight} strokeWidth={2} strokeLinejoin="round" />
      {pts.map((p, i) => {
        const atm = kind === "smile" ? i === atmCol : false;
        return <circle key={i} cx={x(i)} cy={y(p.iv)} r={atm ? 4.5 : 2.6} fill={atm ? C.amber : kind === "term" ? C.amber : C.tealLight} />;
      })}
      {/* x labels */}
      {pts.map((p, i) => {
        if (kind === "smile" && i % 4 !== 0 && i !== atmCol) return null;
        if (kind === "term" && i % 2 !== 0 && i !== n - 1) return null;
        return (
          <text key={`l${i}`} x={x(i)} y={H - padB + 18} textAnchor="middle" fontFamily={FM} fontSize={9.5} fill={i === atmCol && kind === "smile" ? C.amber : C.textMuted}>
            {kind === "smile" ? `${p.label >= 0 ? "+" : ""}${p.label.toFixed(0)}%` : usable[i]?.tenor_label ?? ""}
          </text>
        );
      })}
      <text x={(W + padL) / 2} y={H - 6} textAnchor="middle" fontFamily={FM} fontSize={10} fill={C.textSecondary}>
        {kind === "smile" ? "strike (% from forward)" : "tenor"}
      </text>
    </svg>
  );
}
