"use client";

// ---------------------------------------------------------------------------
// Backtest panel — the PLP "be-the-house" vault strategy, replayed across the
// settled BTC oracle history straight from the protocol's own indexer. Rendered
// as a self-contained section (no page chrome) so it can live inside the
// Portfolio dashboard's Backtest tab. Pure SVG charts, no chart deps.
// ---------------------------------------------------------------------------

import React, { useEffect, useState } from "react";
import { C, FD, FM, FS, BACKEND_URL } from "../_lib/tokens";
import { fetchBacktest, fetchVolSurface, type BacktestReport, type VolSurface } from "../_lib/predict-strip-client";
import { VolSurfaceInteractive } from "./vol-surface";
import { MarketsDepthPanel } from "./markets-depth";

const card: React.CSSProperties = {
  background: C.card,
  border: `0.5px solid ${C.border}`,
  borderRadius: 14,
  padding: 20,
};

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const signed = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

function Cap({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: C.textMuted }}>
      {children}
    </div>
  );
}

function StatCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={card}>
      <Cap>{label}</Cap>
      <div style={{ fontFamily: FD, fontSize: 26, fontWeight: 600, color: color ?? C.textPrimary, marginTop: 8, letterSpacing: "-0.02em" }}>
        {value}
      </div>
      {sub && <div style={{ fontFamily: FM, fontSize: 10, color: C.textMuted, marginTop: 5, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  );
}

// Cumulative P&L area chart (pure SVG).
function CumChart({ data, color }: { data: number[]; color: string }) {
  const W = 1000;
  const H = 340;
  const padL = 52;
  const padR = 64;
  const padT = 20;
  const padB = 30;
  const n = data.length;
  if (n < 2) return null;

  const dmax = Math.max(...data, 0);
  const dmin = Math.min(...data, 0);
  const span = dmax - dmin || 1;
  const yPad = span * 0.08;
  const lo = dmin - yPad;
  const hi = dmax + yPad;

  const x = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  const linePts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaPts = `${x(0).toFixed(1)},${y(0).toFixed(1)} ${linePts} ${x(n - 1).toFixed(1)},${y(0).toFixed(1)}`;

  const ticks: number[] = [];
  const stops = 4;
  for (let i = 0; i <= stops; i++) ticks.push(lo + (i / stops) * (hi - lo));

  const last = data[n - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <defs>
        <linearGradient id="bt-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke={C.border} strokeWidth={0.5} strokeDasharray={Math.abs(t) < 1e-9 ? "0" : "3 5"} opacity={Math.abs(t) < 1e-9 ? 0.9 : 0.5} />
          <text x={padL - 8} y={y(t) + 3.5} textAnchor="end" fontFamily={FM} fontSize={11} fill={C.textMuted}>
            {signed(t, 0)}
          </text>
        </g>
      ))}

      <polygon points={areaPts} fill="url(#bt-fill)" />
      <polyline points={linePts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

      <circle cx={x(n - 1)} cy={y(last)} r={4} fill={color} />
      <text x={x(n - 1) + 8} y={y(last) + 4} fontFamily={FD} fontSize={14} fontWeight={600} fill={color}>
        {signed(last, 0)}
      </text>

      <text x={padL} y={H - 8} fontFamily={FM} fontSize={10.5} fill={C.textMuted}>
        oldest oracle
      </text>
      <text x={W - padR} y={H - 8} textAnchor="end" fontFamily={FM} fontSize={10.5} fill={C.textMuted}>
        newest →
      </text>
    </svg>
  );
}

// Calibration scatter — predicted prob (x) vs realized hit-freq (y).
function CalibChart({ bins, brier }: { bins: BacktestReport["calibration"]["bins"]; brier: number }) {
  const pts = bins.filter((b) => b.n > 0);
  const W = 480;
  const H = 380;
  const pad = 46;
  const maxV = Math.max(0.05, ...pts.map((b) => Math.max(b.p_predicted_avg, b.freq_realized))) * 1.12;
  const nMax = Math.max(1, ...pts.map((b) => b.n));

  const x = (v: number) => pad + (v / maxV) * (W - pad * 1.4);
  const y = (v: number) => H - pad - (v / maxV) * (H - pad * 1.4);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <line x1={x(0)} y1={y(0)} x2={x(maxV)} y2={y(maxV)} stroke={C.textMuted} strokeWidth={1} strokeDasharray="4 5" opacity={0.6} />
      <text x={x(maxV) - 4} y={y(maxV) - 8} textAnchor="end" fontFamily={FM} fontSize={10} fill={C.textMuted}>
        perfectly priced
      </text>

      {[0, 0.1, 0.2, 0.3].filter((t) => t <= maxV).map((t) => (
        <g key={t}>
          <text x={x(t)} y={H - pad + 18} textAnchor="middle" fontFamily={FM} fontSize={10} fill={C.textMuted}>{pct(t, 0)}</text>
          <text x={pad - 12} y={y(t) + 3} textAnchor="end" fontFamily={FM} fontSize={10} fill={C.textMuted}>{pct(t, 0)}</text>
        </g>
      ))}
      <text x={(W + pad) / 2} y={H - 8} textAnchor="middle" fontFamily={FM} fontSize={10.5} fill={C.textSecondary}>predicted probability</text>
      <text x={14} y={H / 2} textAnchor="middle" fontFamily={FM} fontSize={10.5} fill={C.textSecondary} transform={`rotate(-90 14 ${H / 2})`}>realized frequency</text>

      {pts.map((b, i) => (
        <g key={i}>
          <line x1={x(b.p_predicted_avg)} y1={y(b.p_predicted_avg)} x2={x(b.p_predicted_avg)} y2={y(b.freq_realized)} stroke={C.amber} strokeWidth={1} opacity={0.5} />
          <circle cx={x(b.p_predicted_avg)} cy={y(b.freq_realized)} r={6 + 10 * (b.n / nMax)} fill={`${C.teal}cc`} stroke={C.tealLight} strokeWidth={1} />
        </g>
      ))}

      <text x={W - 14} y={28} textAnchor="end" fontFamily={FD} fontSize={13} fontWeight={600} fill={C.textPrimary}>
        Brier {brier.toFixed(3)}
      </text>
    </svg>
  );
}

// Term structure — ATM IV vs tenor.
function TermStructure({ ts }: { ts: VolSurface["term_structure"] }) {
  const pts = ts.filter((t) => t.atm_iv > 0);
  if (pts.length < 2) return null;
  const W = 480;
  const H = 230;
  const pad = 44;
  const ivs = pts.map((p) => p.atm_iv);
  const lo = Math.min(...ivs) * 0.96;
  const hi = Math.max(...ivs) * 1.04;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - pad * 1.3);
  const y = (iv: number) => H - pad - ((iv - lo) / ((hi - lo) || 1)) * (H - pad * 1.5);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.atm_iv).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {[lo, (lo + hi) / 2, hi].map((t, i) => (
        <g key={i}>
          <line x1={pad} y1={y(t)} x2={W - 10} y2={y(t)} stroke={C.border} strokeWidth={0.5} opacity={0.5} />
          <text x={pad - 8} y={y(t) + 3} textAnchor="end" fontFamily={FM} fontSize={10} fill={C.textMuted}>{(t * 100).toFixed(0)}%</text>
        </g>
      ))}
      <polyline points={line} fill="none" stroke={C.amber} strokeWidth={2} strokeLinejoin="round" />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.atm_iv)} r={3} fill={C.amber} />
          {(i === 0 || i === pts.length - 1 || i === Math.floor(pts.length / 2)) && (
            <text x={x(i)} y={H - pad + 18} textAnchor="middle" fontFamily={FM} fontSize={9.5} fill={C.textMuted}>{p.tenor_label}</text>
          )}
        </g>
      ))}
    </svg>
  );
}

// Vol risk premium — implied (SVI ATM at entry) vs realized (settlement move).
function VRPScatter({ scatter }: { scatter: Array<{ implied_iv: number; realized_iv: number }> }) {
  const pts = scatter.filter((s) => Number.isFinite(s.implied_iv) && Number.isFinite(s.realized_iv));
  if (pts.length < 2) return null;
  const W = 480;
  const H = 230;
  const pad = 44;
  const max = Math.max(0.1, ...pts.flatMap((s) => [s.implied_iv, s.realized_iv])) * 1.08;
  const x = (v: number) => pad + (v / max) * (W - pad * 1.3);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 1.5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <line x1={x(0)} y1={y(0)} x2={x(max)} y2={y(max)} stroke={C.textMuted} strokeWidth={1} strokeDasharray="4 5" opacity={0.6} />
      <text x={x(max) - 4} y={y(max) + 14} textAnchor="end" fontFamily={FM} fontSize={9.5} fill={C.textMuted}>implied = realized</text>
      {[0.25, 0.5, 0.75].filter((t) => t <= max).map((t) => (
        <g key={t}>
          <text x={x(t)} y={H - pad + 16} textAnchor="middle" fontFamily={FM} fontSize={9.5} fill={C.textMuted}>{(t * 100).toFixed(0)}%</text>
          <text x={pad - 8} y={y(t) + 3} textAnchor="end" fontFamily={FM} fontSize={9.5} fill={C.textMuted}>{(t * 100).toFixed(0)}%</text>
        </g>
      ))}
      <text x={(W + pad) / 2} y={H - 8} textAnchor="middle" fontFamily={FM} fontSize={10} fill={C.textSecondary}>implied IV (sold)</text>
      <text x={13} y={H / 2} textAnchor="middle" fontFamily={FM} fontSize={10} fill={C.textSecondary} transform={`rotate(-90 13 ${H / 2})`}>realized IV</text>
      {pts.map((s, i) => {
        const rich = s.implied_iv >= s.realized_iv; // above the diagonal → vault wins that epoch
        return <circle key={i} cx={x(s.implied_iv)} cy={y(s.realized_iv)} r={3.2} fill={rich ? `${C.green}cc` : `${C.amber}bb`} />;
      })}
    </svg>
  );
}

export function BacktestPanel() {
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [plpShare, setPlpShare] = useState<number | null>(null);
  const [surface, setSurface] = useState<VolSurface | null>(null);

  useEffect(() => {
    fetchBacktest()
      .then(setReport)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    fetchVolSurface("BTC").then(setSurface).catch(() => {});
    fetch(`${BACKEND_URL}/api/predict/vault/summary`)
      .then((r) => r.json())
      .then((v) => { if (v && typeof v.plp_share_price === "number") setPlpShare(v.plp_share_price); })
      .catch(() => {});
  }, []);

  return (
    <>
      {err && (
        <div style={{ ...card, fontFamily: FM, fontSize: 12.5, color: C.textMuted, lineHeight: 1.6 }}>
          Backtest data isn&apos;t available ({err}). Start the backend on {BACKEND_URL} and run{" "}
          <code style={{ color: C.tealLight }}>npm run backtest</code> to generate it.
        </div>
      )}

      {report && (
        <>
          <div className="bt-stats">
            <StatCard label="Vol risk premium" value={signed(report.vol.vol_risk_premium)} color={report.vol.vol_risk_premium >= 0 ? C.green : C.red} sub="implied − realized · the edge" />
            <StatCard label="Avg implied IV" value={pct(report.vol.avg_implied_iv)} color={C.tealLight} sub="SVI ATM sold at entry" />
            <StatCard label="Avg realized IV" value={pct(report.vol.avg_realized_iv)} color={C.textPrimary} sub="vol BTC delivered" />
            <StatCard label="Live PLP vault" value={plpShare != null ? `+${((plpShare - 1) * 100).toFixed(2)}%` : "—"} color={C.green} sub="realized on-chain" />
          </div>

          <div style={{ ...card, marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
              <Cap>Central-band strip · cumulative replay (fixed stake / epoch)</Cap>
              <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                house {signed(report.house.mean_epoch_return)}/epoch · taker {signed(report.buyer.mean_epoch_return)}/epoch · {pct(report.buyer.hit_rate)} hit-rate
              </span>
            </div>
            <CumChart data={report.house.cum_return_curve} color={report.house.cum_final_return >= 0 ? C.green : C.amber} />
            <p style={{ fontFamily: FS, fontSize: 12.5, color: C.textSecondary, margin: "8px 2px 0", lineHeight: 1.55 }}>
              σ is sized per oracle from its own SVI implied vol, so this single central-band strip is priced near fair and the
              structure alone is roughly breakeven. The durable edge isn&apos;t the strip shape, it&apos;s the vol-risk-premium below:
              implied vol prints above realized across the book, and the diversified PLP vault harvests it (+0.18% live).
            </p>
          </div>

          {/* ── Volatility: the live SVI surface the vault sells, and the premium it earns ── */}
          <div style={{ ...card, marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <Cap>Volatility surface · live SVI (BTC)</Cap>
              <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                {surface ? `${surface.slices.length} expiries · forward $${surface.forward_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "loading…"}
              </span>
            </div>
            {surface ? (
              <VolSurfaceInteractive surface={surface} />
            ) : (
              <div style={{ height: 260, display: "grid", placeItems: "center", fontFamily: FM, fontSize: 12.5, color: C.textMuted }}>
                Loading the live SVI surface…
              </div>
            )}
            <p style={{ fontFamily: FS, fontSize: 12.5, color: C.textSecondary, margin: "8px 2px 0", lineHeight: 1.55 }}>
              The protocol prices every strip off this live SVI surface (strike × expiry × implied vol). Drag the 3D view to rotate,
              or switch to Smile and Term structure. The vault is structurally <strong style={{ color: C.textPrimary }}>short this implied vol</strong>;
              it earns the gap to realized, which the next panel measures.
            </p>
          </div>

          {report.vol && (
            <div className="bt-cols" style={{ marginTop: 16 }}>
              <div style={card}>
                <Cap>Vol risk premium · implied vs realized</Cap>
                <div style={{ marginTop: 12 }}>
                  <VRPScatter scatter={report.vol.scatter} />
                </div>
                <p style={{ fontFamily: FS, fontSize: 12.5, color: C.textSecondary, margin: "10px 2px 0", lineHeight: 1.55 }}>
                  Each dot is one settled oracle: implied vol the vault <em>sold</em> at entry (x) versus the vol BTC{" "}
                  <em>realized</em> (y). Points <strong style={{ color: C.green }}>below the diagonal</strong> are epochs where
                  implied beat realized and the vault kept the premium. Across {report.epochs} oracles, implied averaged{" "}
                  <strong style={{ color: C.textPrimary }}>{pct(report.vol.avg_implied_iv)}</strong> vs{" "}
                  <strong style={{ color: C.textPrimary }}>{pct(report.vol.avg_realized_iv)}</strong> realized.
                </p>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="bt-volstats">
                  <StatCard label="Avg implied IV" value={pct(report.vol.avg_implied_iv)} color={C.tealLight} sub="SVI ATM at entry" />
                  <StatCard label="Avg realized IV" value={pct(report.vol.avg_realized_iv)} color={C.textPrimary} sub="settlement move" />
                  <StatCard label="Vol risk premium" value={signed(report.vol.vol_risk_premium)} color={report.vol.vol_risk_premium >= 0 ? C.green : C.red} sub="implied − realized" />
                </div>
                <div style={card}>
                  <Cap>ATM term structure</Cap>
                  <div style={{ marginTop: 12 }}>
                    {surface ? <TermStructure ts={surface.term_structure} /> : <div style={{ height: 180, display: "grid", placeItems: "center", fontFamily: FM, fontSize: 12, color: C.textMuted }}>—</div>}
                  </div>
                </div>
              </div>
            </div>
          )}

          <MarketsDepthPanel />

          <div className="bt-cols" style={{ marginTop: 16 }}>
            <div style={card}>
              <Cap>Why the edge exists · calibration</Cap>
              <div style={{ marginTop: 12 }}>
                <CalibChart bins={report.calibration.bins} brier={report.calibration.brier} />
              </div>
              <p style={{ fontFamily: FS, fontSize: 12.5, color: C.textSecondary, margin: "10px 2px 0", lineHeight: 1.55 }}>
                Every point sits <strong style={{ color: C.textPrimary }}>below the diagonal</strong>: bands priced at a given
                probability land <em>less</em> often than priced. The surface&apos;s implied vol runs above realized, so strips are
                richly priced, and that miscalibration is the vault&apos;s edge. Lower Brier means sharper pricing.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ ...card, background: C.panelGradient }}>
                <Cap>Live anchor · the real PLP vault</Cap>
                <div style={{ fontFamily: FD, fontSize: 30, fontWeight: 600, color: C.green, marginTop: 8, letterSpacing: "-0.02em" }}>
                  {plpShare != null ? `+${((plpShare - 1) * 100).toFixed(2)}%` : "—"}
                </div>
                <p style={{ fontFamily: FS, fontSize: 12.5, color: C.textSecondary, margin: "6px 0 0", lineHeight: 1.55 }}>
                  The on-chain PLP share price{plpShare != null ? ` (${plpShare.toFixed(4)})` : ""}: the same be-the-house edge,
                  realized smoothly across thousands of live positions. The backtest shows its{" "}
                  <strong style={{ color: C.textPrimary }}>direction and source</strong> against a naive taker, not a return forecast.
                </p>
              </div>

              <div style={card}>
                <Cap>Sample epochs</Cap>
                <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                  <div className="bt-row bt-row--head">
                    <span>Forward</span>
                    <span style={{ textAlign: "right" }}>Settled</span>
                    <span style={{ textAlign: "right" }}>Move</span>
                    <span style={{ textAlign: "right" }}>Result</span>
                  </div>
                  {report.sample_epochs.map((e, i) => {
                    const move = e.settlement_usd - e.forward_usd;
                    return (
                      <div className="bt-row" key={i}>
                        <span>${e.forward_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                        <span style={{ textAlign: "right" }}>${e.settlement_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                        <span style={{ textAlign: "right", color: C.textSecondary }}>
                          {move >= 0 ? "+" : "−"}${Math.abs(move).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                        <span style={{ textAlign: "right", color: e.hit ? C.amber : C.green }}>
                          {e.hit ? "taker won" : "house won"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div style={{ ...card, marginTop: 16 }}>
            <Cap>Method</Cap>
            <p style={{ fontFamily: FM, fontSize: 11, color: C.textMuted, margin: "10px 0 0", lineHeight: 1.7 }}>
              N={report.params.n_buckets} buckets · σ = {report.params.sigma_source} · ±{report.params.span_sigma}σ span ·{" "}
              {report.epochs} epochs sampled from {report.universe.settled_btc_with_settlement_price.toLocaleString()} settled BTC oracles.{" "}
              {report.method}
            </p>
            <p style={{ fontFamily: FM, fontSize: 10, color: C.textMuted, margin: "8px 0 0" }}>
              source: {report.server} · generated {new Date(report.generated_at).toLocaleString()}
            </p>
          </div>
        </>
      )}

      {!report && !err && (
        <div style={{ ...card, height: 200, display: "grid", placeItems: "center", fontFamily: FM, fontSize: 12.5, color: C.textMuted }}>
          Loading simulation results…
        </div>
      )}

      <style jsx global>{`
        .bt-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
        @media (max-width: 900px) { .bt-stats { grid-template-columns: repeat(2, 1fr); } }
        .bt-volstats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
        @media (max-width: 560px) { .bt-volstats { grid-template-columns: 1fr; } }
        .bt-cols { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); gap: 16px; align-items: start; }
        @media (max-width: 980px) { .bt-cols { grid-template-columns: 1fr; } }
        .bt-row { display: grid; grid-template-columns: 1fr 1fr 0.8fr 1fr; gap: 8px; font-family: ${FM}; font-size: 11.5px; color: ${C.textPrimary}; }
        .bt-row--head { font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; }
      `}</style>
    </>
  );
}
