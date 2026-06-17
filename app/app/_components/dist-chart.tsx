"use client";

// ---------------------------------------------------------------------------
// Distribution chart — the market's implied forward f(x) (dashed) vs your view
// g(x) (solid), plus the payoff-at-settlement profile g(x) − f(x). Pure SVG,
// reusable across every DeepBook market surface. The frame is computed locally
// (buildChartFrame) so it slides continuously as μ/σ drag; priced $ numbers come
// from the real strip quote alongside it.
// ---------------------------------------------------------------------------

import React from "react";
import { C, FD, FM } from "../_lib/tokens";
import { monotonePath } from "../_lib/curve";

const price = (v: number) =>
  v >= 1000 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(v < 10 ? 2 : 0)}`;
export const fmtVal = (unit: string, v: number) =>
  unit === "count" ? (Math.round(v * 100) / 100).toString() : price(v);

function normalPdf(x: number, mu: number, sigma: number): number {
  const s = Math.max(sigma, 1e-9);
  const z = (x - mu) / s;
  return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
}

export interface ChartData {
  x: number[];
  market_pdf: number[];
  target_pdf: number[];
  trade_curve: number[];
  market_mu: number;
  target_mu: number;
  unit: "usd" | "count";
}

/** Build a 121-pt chart frame: market Normal f(μ_m, σ_m), your Normal g(μ_t, σ_t),
 *  and the L2-normalised payoff g − f. Mirrors the engine's quote math. */
export function buildChartFrame(
  marketMu: number,
  marketSigma: number,
  targetMu: number,
  targetSigma: number,
  unit: "usd" | "count" = "usd",
): ChartData {
  const muM = marketMu;
  const sigM = Math.max(marketSigma, 1e-9);
  const muT = targetMu;
  const sigT = Math.max(targetSigma, 1e-9);
  let lo = Math.min(muM - 4 * sigM, muT - 4 * sigT);
  const hi = Math.max(muM + 4 * sigM, muT + 4 * sigT);
  if (muM > 0 && muT > 0) lo = Math.max(lo, 0);
  const N = 121;
  const dx = (hi - lo) / (N - 1) || 1;
  const x = Array.from({ length: N }, (_, i) => lo + i * dx);
  const market_pdf = x.map((xi) => normalPdf(xi, muM, sigM));
  const rawG = x.map((xi) => normalPdf(xi, muT, sigT));
  const l2 = (a: number[]) => Math.max(Math.sqrt(a.reduce((s, v) => s + v * v * dx, 0)), 1e-9);
  const fU = market_pdf.map((v) => v / l2(market_pdf));
  const gU = rawG.map((v) => v / l2(rawG));
  const trade_curve = gU.map((v, i) => v - fU[i]);
  const peakF = Math.max(...market_pdf, 1e-12);
  const peakG = Math.max(...rawG, 1e-12);
  const gScale = peakG > 4 * peakF ? (4 * peakF) / peakG : 1;
  const target_pdf = rawG.map((v) => v * gScale);
  return { x, market_pdf, target_pdf, trade_curve, market_mu: muM, target_mu: muT, unit };
}

/** Frame from the REAL SVI-implied market density (skewed/fat-tailed) for f(x),
 *  with your Normal(μ, σ) view g(x) on the same strike grid. This is what makes
 *  the chart's f(x) match the protocol's actual distribution, not a Gaussian. */
export function buildFrameFromDensity(
  x: number[],
  marketPdf: number[],
  targetMu: number,
  targetSigma: number,
): ChartData {
  const n = x.length;
  const dx = n > 1 ? (x[n - 1] - x[0]) / (n - 1) : 1;
  const rawG = x.map((xi) => normalPdf(xi, targetMu, Math.max(targetSigma, 1e-9)));
  const l2 = (a: number[]) => Math.max(Math.sqrt(a.reduce((s, v) => s + v * v * dx, 0)), 1e-9);
  const fU = marketPdf.map((v) => v / l2(marketPdf));
  const gU = rawG.map((v) => v / l2(rawG));
  const trade_curve = gU.map((v, i) => v - fU[i]);
  const peakF = Math.max(...marketPdf, 1e-12);
  const peakG = Math.max(...rawG, 1e-12);
  const gScale = peakG > 4 * peakF ? (4 * peakF) / peakG : 1;
  const target_pdf = rawG.map((v) => v * gScale);
  // market mode (argmax of the implied density) for the guide line.
  let mode = x[0];
  let best = -Infinity;
  for (let i = 0; i < n; i++) if (marketPdf[i] > best) { best = marketPdf[i]; mode = x[i]; }
  return { x, market_pdf: marketPdf, target_pdf, trade_curve, market_mu: mode, target_mu: targetMu, unit: "usd" };
}

export function DistChart({ quote }: { quote: ChartData }) {
  const W = 760;
  const HP = 210; // distributions panel
  const HB = 96; // payoff panel
  const P = 30;
  const xs = quote.x;
  const n = xs.length;
  if (n < 2) return null;
  const xMin = xs[0];
  const xMax = xs[n - 1];
  const sx = (xv: number) => P + ((xv - xMin) / (xMax - xMin || 1)) * (W - 2 * P);

  const pdfMax = Math.max(...quote.market_pdf, ...quote.target_pdf, 1e-12);
  const syF = (p: number) => HP - P + 6 - (p / pdfMax) * (HP - 2 * P);
  const marketPts = xs.map((xv, i) => [sx(xv), syF(quote.market_pdf[i])] as [number, number]);
  const targetPts = xs.map((xv, i) => [sx(xv), syF(quote.target_pdf[i])] as [number, number]);
  const targetFill = `${monotonePath(targetPts)} L ${sx(xMax)} ${HP - P + 6} L ${sx(xMin)} ${HP - P + 6} Z`;

  const payAbs = Math.max(...quote.trade_curve.map((v) => Math.abs(v)), 1e-9);
  const zeroY = HB / 2;
  const syPay = (v: number) => zeroY - (v / payAbs) * (HB / 2 - 10);
  const barW = Math.max(1.2, (W - 2 * P) / n - 0.6);

  const rawTicks: Array<{ v: number; anchor: "start" | "middle" | "end" }> = [
    { v: xMin, anchor: "start" },
    { v: quote.market_mu, anchor: "middle" },
    { v: quote.target_mu, anchor: "middle" },
    { v: xMax, anchor: "end" },
  ];
  rawTicks.sort((a, b) => a.v - b.v);

  const placedTicks: Array<{ v: number; anchor: "start" | "middle" | "end"; row: number; label: string }> = [];
  const rowRight = [-Infinity, -Infinity];
  for (let i = 0; i < rawTicks.length; i++) {
    const t = rawTicks[i];
    if (i > 0 && Math.abs(sx(t.v) - sx(rawTicks[i - 1].v)) < 3) continue;
    const label = fmtVal(quote.unit, t.v);
    const halfW = (label.length * 5.6) / 2;
    const px = sx(t.v);
    const left = px - halfW;
    const right = px + halfW;
    let row = 0;
    if (left < rowRight[0] + 6) row = left < rowRight[1] + 6 ? 0 : 1;
    rowRight[row] = right;
    placedTicks.push({ ...t, row, label });
  }

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${HP}`} width="100%" style={{ display: "block" }}>
        <line x1={sx(quote.market_mu)} x2={sx(quote.market_mu)} y1={P - 8} y2={HP - P + 6} stroke={C.textMuted} strokeWidth="1" strokeDasharray="3 3" opacity={0.5} />
        <line x1={sx(quote.target_mu)} x2={sx(quote.target_mu)} y1={P - 8} y2={HP - P + 6} stroke={C.tealLight} strokeWidth="1" strokeDasharray="3 3" opacity={0.6} />
        <path d={targetFill} fill={C.tealLight} opacity={0.12} />
        <path d={monotonePath(targetPts)} fill="none" stroke={C.tealLight} strokeWidth="2" />
        <path d={monotonePath(marketPts)} fill="none" stroke={C.textSecondary} strokeWidth="1.5" strokeDasharray="5 4" opacity={0.85} />
        {placedTicks.map((t, i) => (
          <text key={i} x={sx(t.v)} y={HP - 13 + t.row * 11} fill={C.textMuted} fontFamily={FM} fontSize="9.5" textAnchor={t.anchor}>
            {t.label}
          </text>
        ))}
      </svg>
      <div style={{ display: "flex", gap: 16, margin: "2px 0 10px", fontFamily: FM, fontSize: 10.5 }}>
        <span style={{ color: C.textSecondary }}>— — market f(x)</span>
        <span style={{ color: C.tealLight }}>—— your view g(x)</span>
      </div>
      <div style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.12em", color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>
        Your payoff at settlement · g(x) − f(x)
      </div>
      <svg viewBox={`0 0 ${W} ${HB}`} width="100%" style={{ display: "block" }}>
        <line x1={P} x2={W - P} y1={zeroY} y2={zeroY} stroke={C.border} strokeWidth="1" />
        {xs.map((xv, i) => {
          const v = quote.trade_curve[i];
          const y = syPay(v);
          return (
            <rect key={i} x={sx(xv) - barW / 2} y={Math.min(zeroY, y)} width={barW} height={Math.abs(zeroY - y)} fill={v >= 0 ? C.green : C.red} opacity={0.75} />
          );
        })}
      </svg>
    </div>
  );
}
