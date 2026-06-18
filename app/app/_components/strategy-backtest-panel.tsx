"use client";

// ---------------------------------------------------------------------------
// Per-strategy backtest panel for the Portfolio page.
//
// Lists the protocol's strategy classes (long-vol-straddle, short-vol-condor,
// btc-momentum, event-basket), lets you pick one + a lookback window, then
// replays it against real Coinbase / Polymarket history via the typed v2
// client. Renders a clean SVG equity curve + the headline risk/return metrics,
// the coverage note, and an honest source label.
//
// Self-contained: no chart libs, no page chrome. Matches the app's chart style
// (smoothed area + line, drop-shadow, tabular mono axis labels).
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import {
  fetchBacktest,
  fetchBacktestStrategies,
  type BacktestResult,
} from "../_lib/v2-clients";

type StrategyMeta = {
  id: string;
  name: string;
  kind: string;
  product?: string;
  description: string;
};

const WINDOWS = [30, 60, 90, 180] as const;
type WindowDays = (typeof WINDOWS)[number];

const card: React.CSSProperties = {
  background: C.card,
  border: `0.5px solid ${C.border}`,
  borderRadius: 14,
  padding: 18,
};

function Cap({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: FM,
        fontSize: 9.5,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: C.textMuted,
      }}
    >
      {children}
    </div>
  );
}

// Catmull-Rom → cubic smoothing (matches the AccountValueChart curve feel).
function smoothLine(pts: Array<[number, number]>, tension = 0.16): string {
  if (pts.length < 2) return "";
  const d = [`M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) * tension;
    const c1y = p1[1] + (p2[1] - p0[1]) * tension;
    const c2x = p2[0] - (p3[0] - p1[0]) * tension;
    const c2y = p2[1] - (p3[1] - p1[1]) * tension;
    d.push(
      `C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`,
    );
  }
  return d.join(" ");
}

function EquityCurve({ result }: { result: BacktestResult }) {
  const data = result.equity_curve;
  const W = 920,
    H = 300,
    PL = 56,
    PR = 18,
    PT = 18,
    PB = 30;
  const n = data.length;
  if (n < 2) {
    return (
      <div
        style={{
          height: 220,
          display: "grid",
          placeItems: "center",
          fontFamily: FM,
          fontSize: 12,
          color: C.textMuted,
        }}
      >
        Not enough history for this window.
      </div>
    );
  }

  const eq = data.map((d) => d.equity);
  const lo = Math.min(...eq);
  const hi = Math.max(...eq);
  const span = hi - lo || hi * 0.02 || 0.02;
  const pad = span * 0.16;
  const yMin = lo - pad;
  const yMax = hi + pad;

  const sx = (i: number) => PL + (i / (n - 1)) * (W - PL - PR);
  const sy = (v: number) =>
    PT + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PT - PB);

  const pts = eq.map((v, i): [number, number] => [sx(i), sy(v)]);
  const line = smoothLine(pts);
  const area = `${line} L ${sx(n - 1).toFixed(1)} ${(H - PB).toFixed(1)} L ${sx(0).toFixed(1)} ${(H - PB).toFixed(1)} Z`;

  const final = eq[n - 1];
  const up = final >= 1;
  const stroke = up ? C.tealLight : C.coral;
  const end = pts[pts.length - 1];

  // 4 baseline-relative y ticks shown as % off the $1 start.
  const yTicks = [yMax, (yMax * 2 + yMin) / 3, (yMax + yMin * 2) / 3, yMin];

  // x-axis date labels: start, middle, end.
  const fmtDate = (sec: number) =>
    new Date(sec * 1000).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  const xLabels = [
    { i: 0, t: data[0].t, anchor: "start" as const },
    { i: Math.floor((n - 1) / 2), t: data[Math.floor((n - 1) / 2)].t, anchor: "middle" as const },
    { i: n - 1, t: data[n - 1].t, anchor: "end" as const },
  ];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height="auto"
      preserveAspectRatio="xMidYMid meet"
      aria-label="Strategy equity curve"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id="bt-equity-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      {yTicks.map((v, i) => {
        const offPct = (v - 1) * 100;
        return (
          <g key={i}>
            <line
              x1={PL}
              x2={W - PR}
              y1={sy(v)}
              y2={sy(v)}
              stroke={C.border}
              strokeWidth="1"
              opacity={0.5}
              strokeDasharray={Math.abs(offPct) < 1e-6 ? "0" : "3 6"}
            />
            <text
              x={PL - 9}
              y={sy(v) + 3.5}
              textAnchor="end"
              fill={C.textMuted}
              fontFamily={FM}
              fontSize="10"
            >
              {`${offPct >= 0 ? "+" : ""}${offPct.toFixed(1)}%`}
            </text>
          </g>
        );
      })}

      <path d={area} fill="url(#bt-equity-fill)" />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ filter: `drop-shadow(0 1px 6px ${stroke}33)` }}
      />
      <circle cx={end[0]} cy={end[1]} r={4} fill={stroke} />
      <circle cx={end[0]} cy={end[1]} r={8} fill="none" stroke={stroke} strokeWidth="1" opacity="0.3" />

      {xLabels.map((l, k) => (
        <text
          key={k}
          x={sx(l.i)}
          y={H - 8}
          textAnchor={l.anchor}
          fill={C.textMuted}
          fontFamily={FM}
          fontSize="10"
        >
          {fmtDate(l.t)}
        </text>
      ))}
    </svg>
  );
}

function Metric({
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
    <div
      style={{
        border: `0.5px solid ${C.border}`,
        borderRadius: 10,
        padding: "12px 14px",
        background: C.surface,
      }}
    >
      <Cap>{label}</Cap>
      <div
        style={{
          fontFamily: FD,
          fontSize: 20,
          fontWeight: 600,
          color: color ?? C.textPrimary,
          marginTop: 7,
          letterSpacing: "-0.01em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: FM, fontSize: 9.5, color: C.textMuted, marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

const fmtSigned = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

export function StrategyBacktestPanel() {
  const [strategies, setStrategies] = useState<StrategyMeta[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<WindowDays>(60);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);

  // Load the strategy catalog once.
  useEffect(() => {
    let cancelled = false;
    fetchBacktestStrategies()
      .then((r) => {
        if (cancelled) return;
        setStrategies(r.strategies);
        if (r.strategies.length > 0) setActiveId(r.strategies[0].id);
      })
      .catch((e) => {
        if (!cancelled) setListErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Run the backtest whenever the selection or window changes.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setLoading(true);
    setRunErr(null);
    fetchBacktest(activeId, windowDays)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setRunErr(e instanceof Error ? e.message : String(e));
          setResult(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, windowDays]);

  const activeMeta = useMemo(
    () => strategies?.find((s) => s.id === activeId) ?? null,
    [strategies, activeId],
  );

  if (listErr) {
    return (
      <div style={{ ...card, fontFamily: FM, fontSize: 12.5, color: C.textMuted, lineHeight: 1.6 }}>
        Backtest catalog isn&apos;t available ({listErr}). Confirm the backend is running.
      </div>
    );
  }

  if (!strategies) {
    return (
      <div
        style={{
          ...card,
          height: 360,
          display: "grid",
          placeItems: "center",
          fontFamily: FM,
          fontSize: 12.5,
          color: C.textMuted,
        }}
      >
        Loading strategy catalog…
      </div>
    );
  }

  const m = result?.metrics;

  return (
    <div className="sbt-grid">
      {/* ── Left rail: strategy picker ── */}
      <aside className="sbt-rail">
        <Cap>Strategy class</Cap>
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {strategies.map((s) => {
            const on = s.id === activeId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveId(s.id)}
                style={{
                  textAlign: "left",
                  border: `0.5px solid ${on ? `${C.tealLight}66` : C.border}`,
                  background: on ? `${C.tealLight}10` : C.surface,
                  borderRadius: 10,
                  padding: "11px 13px",
                  cursor: "pointer",
                  transition: `all 0.15s ${EASE}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: on ? C.tealLight : C.textMuted,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: FD,
                      fontSize: 13,
                      fontWeight: 600,
                      color: on ? C.textPrimary : C.textSecondary,
                    }}
                  >
                    {s.name}
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: FM,
                    fontSize: 9.5,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: C.textMuted,
                    marginTop: 6,
                  }}
                >
                  {s.kind}
                  {s.product ? ` · ${s.product}` : ""}
                </div>
                <div
                  style={{
                    fontFamily: FS,
                    fontSize: 11.5,
                    color: C.textSecondary,
                    marginTop: 6,
                    lineHeight: 1.45,
                  }}
                >
                  {s.description}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── Right: equity curve + metrics ── */}
      <section style={{ display: "grid", gap: 16, minWidth: 0 }}>
        <div style={card}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 16,
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            <div>
              <Cap>Equity curve · $1 start</Cap>
              <div
                style={{
                  fontFamily: FD,
                  fontSize: 18,
                  fontWeight: 600,
                  color: C.textPrimary,
                  marginTop: 6,
                }}
              >
                {activeMeta?.name ?? "—"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 5 }}>
              {WINDOWS.map((w) => {
                const on = w === windowDays;
                return (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWindowDays(w)}
                    style={{
                      padding: "5px 12px",
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
                    {w}D
                  </button>
                );
              })}
            </div>
          </div>

          {runErr ? (
            <div
              style={{
                height: 220,
                display: "grid",
                placeItems: "center",
                fontFamily: FM,
                fontSize: 12,
                color: C.textMuted,
                textAlign: "center",
                lineHeight: 1.6,
              }}
            >
              Couldn&apos;t replay this strategy ({runErr}).
            </div>
          ) : !result || loading ? (
            <div
              style={{
                height: 300,
                display: "grid",
                placeItems: "center",
                fontFamily: FM,
                fontSize: 12.5,
                color: C.textMuted,
              }}
            >
              {loading ? "Replaying on real history…" : "Select a strategy."}
            </div>
          ) : (
            <div style={{ opacity: loading ? 0.5 : 1, transition: `opacity 0.2s ${EASE}` }}>
              <EquityCurve result={result} />
            </div>
          )}
        </div>

        {/* Metrics row */}
        <div className="sbt-metrics">
          <Metric
            label="Total return"
            value={m ? fmtSigned(m.total_return_pct) : "—"}
            color={m ? (m.total_return_pct >= 0 ? C.green : C.red) : undefined}
            sub="over window"
          />
          <Metric label="Sharpe" value={m ? m.sharpe.toFixed(2) : "—"} sub="annualized" />
          <Metric
            label="Max drawdown"
            value={m ? `${m.max_drawdown_pct.toFixed(1)}%` : "—"}
            color={C.coral}
            sub="peak-to-trough"
          />
          <Metric
            label="Win rate"
            value={m ? `${(m.win_rate * 100).toFixed(0)}%` : "—"}
            sub="positive days"
          />
          <Metric
            label="Ann. vol"
            value={m ? `${m.ann_vol_pct.toFixed(1)}%` : "—"}
            sub="realized"
          />
        </div>

        {/* Coverage + source */}
        {result && (
          <div style={{ ...card, padding: "14px 18px" }}>
            <Cap>Coverage</Cap>
            <p
              style={{
                fontFamily: FS,
                fontSize: 12.5,
                color: C.textSecondary,
                margin: "8px 0 0",
                lineHeight: 1.6,
              }}
            >
              {result.coverage_note}
            </p>
            <div
              style={{
                fontFamily: FM,
                fontSize: 10,
                color: C.textMuted,
                marginTop: 10,
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  border: `0.5px solid ${C.border}`,
                  borderRadius: 999,
                  padding: "3px 9px",
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.green }} />
                source: {result.source}
              </span>
              <span>
                Transparent strategy proxy on real history — not a return forecast.
              </span>
            </div>
          </div>
        )}
      </section>

      <style jsx global>{`
        .sbt-grid {
          display: grid;
          grid-template-columns: 290px minmax(0, 1fr);
          gap: 16px;
          align-items: start;
        }
        .sbt-rail {
          background: ${C.card};
          border: 0.5px solid ${C.border};
          border-radius: 14px;
          padding: 18px;
          position: sticky;
          top: 76px;
        }
        .sbt-metrics {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 12px;
        }
        @media (max-width: 1180px) {
          .sbt-grid {
            grid-template-columns: 1fr;
          }
          .sbt-rail {
            position: static;
          }
        }
        @media (max-width: 720px) {
          .sbt-metrics {
            grid-template-columns: repeat(2, 1fr);
          }
        }
      `}</style>
    </div>
  );
}
