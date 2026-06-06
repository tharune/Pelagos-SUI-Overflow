"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE, BACKEND_URL } from "../_lib/tokens";
import { monotonePath } from "../_lib/curve";
import { suiExplorerTxUrl } from "../_lib/chain";
import { useWalletSigner, useActiveWalletAddress, useUsdcBalance } from "../_lib/wallet-bridge";
import {
  fetchContinuousMarkets,
  quoteContinuous,
  fetchContinuousPositions,
  openContinuousPosition,
  settleContinuousPosition,
  type ContinuousMarket,
  type ContinuousQuote,
  type ContinuousPosition,
  type SettleResult,
} from "../_lib/distribution-continuous-client";

const price = (v: number) =>
  v >= 1000 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(v < 10 ? 2 : 0)}`;
const usd = (v: number) => `$${v.toFixed(2)}`;

// ---------------------------------------------------------------------------
// Chart: the two continuous Normal curves (market f vs your view g) + payoff.
// ---------------------------------------------------------------------------
function DistChart({ quote }: { quote: ContinuousQuote }) {
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

  const ticks = [xMin, quote.market_mu, quote.target_mu, xMax].sort((a, b) => a - b);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${HP}`} width="100%" style={{ display: "block" }}>
        {/* market mean + your mean guide lines */}
        <line x1={sx(quote.market_mu)} x2={sx(quote.market_mu)} y1={P - 8} y2={HP - P + 6} stroke={C.textMuted} strokeWidth="1" strokeDasharray="3 3" opacity={0.5} />
        <line x1={sx(quote.target_mu)} x2={sx(quote.target_mu)} y1={P - 8} y2={HP - P + 6} stroke={C.tealLight} strokeWidth="1" strokeDasharray="3 3" opacity={0.6} />
        {/* your view: fill + line */}
        <path d={targetFill} fill={C.tealLight} opacity={0.12} />
        <path d={monotonePath(targetPts)} fill="none" stroke={C.tealLight} strokeWidth="2" />
        {/* market view: line */}
        <path d={monotonePath(marketPts)} fill="none" stroke={C.textSecondary} strokeWidth="1.5" strokeDasharray="5 4" opacity={0.85} />
        {/* x ticks */}
        {ticks.map((t, i) => (
          <text key={i} x={sx(t)} y={HP - 6} fill={C.textMuted} fontFamily={FM} fontSize="9.5" textAnchor="middle">
            {price(t)}
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
            <rect
              key={i}
              x={sx(xv) - barW / 2}
              y={Math.min(zeroY, y)}
              width={barW}
              height={Math.abs(zeroY - y)}
              fill={v >= 0 ? C.green : C.red}
              opacity={0.75}
            />
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Slider({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontFamily: FM, fontSize: 10.5, letterSpacing: "0.1em", color: C.textMuted, textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontFamily: FD, fontSize: 14, color: C.textPrimary }}>{fmt(value)}</span>
      </div>
      <input
        type="range"
        className="dc-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

const PANEL: React.CSSProperties = {
  background: C.card,
  border: `0.5px solid ${C.border}`,
  borderRadius: 14,
  padding: 20,
};

export default function DistributionPage() {
  const wallet = useWalletSigner();
  const activeAddress = useActiveWalletAddress();

  const [markets, setMarkets] = useState<ContinuousMarket[]>([]);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [mu, setMu] = useState(0);
  const [sigma, setSigma] = useState(0);
  const [collateral, setCollateral] = useState("25");
  const [quote, setQuote] = useState<ContinuousQuote | null>(null);
  const [positions, setPositions] = useState<ContinuousPosition[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<{ digest: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usdc = useUsdcBalance();
  const [settling, setSettling] = useState<string | null>(null);
  const [, setSettleResults] = useState<Record<string, SettleResult>>({});

  const market = useMemo(() => markets.find((m) => m.id === marketId) ?? null, [markets, marketId]);

  // Load markets once.
  useEffect(() => {
    fetchContinuousMarkets()
      .then(({ markets }) => {
        setMarkets(markets);
        if (markets[0]) {
          setMarketId(markets[0].id);
          setMu(markets[0].mu);
          setSigma(markets[0].sigma);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // When the selected market changes, reset the view to the market's own curve.
  const selectMarket = useCallback((m: ContinuousMarket) => {
    setMarketId(m.id);
    setMu(m.mu);
    setSigma(m.sigma);
    setQuote(null);
    setResult(null);
    setError(null);
  }, []);

  // Debounced quote on any input change.
  const quoteTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!market) return;
    const coll = Number(collateral);
    if (!Number.isFinite(coll) || coll <= 0) {
      setQuote(null);
      return;
    }
    if (quoteTimer.current) window.clearTimeout(quoteTimer.current);
    quoteTimer.current = window.setTimeout(() => {
      quoteContinuous({ marketId: market.id, targetMu: mu, targetSigma: sigma, collateralUsdc: coll })
        .then((q) => {
          setQuote(q);
          setError(null);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }, 180);
    return () => {
      if (quoteTimer.current) window.clearTimeout(quoteTimer.current);
    };
  }, [market, mu, sigma, collateral]);

  // Positions for the active wallet.
  const refreshPositions = useCallback(() => {
    if (!activeAddress) {
      setPositions([]);
      return;
    }
    fetchContinuousPositions(activeAddress)
      .then(({ positions }) => setPositions(positions))
      .catch(() => setPositions([]));
  }, [activeAddress]);
  useEffect(() => {
    refreshPositions();
  }, [refreshPositions]);

  const flat = !quote || quote.collateral_required_usdc <= 0;
  const canOpen = wallet.connected && quote && !flat && !busy;

  async function open() {
    if (!market || !quote) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setStage("Building deposit…");
      const res = await openContinuousPosition({
        wallet,
        marketId: market.id,
        targetMu: mu,
        targetSigma: sigma,
        collateralUsdc: Number(collateral),
      });
      setStage(null);
      setResult({ digest: res.digest });
      refreshPositions();
      usdc.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  async function settle(positionId: string) {
    if (!activeAddress) return;
    setSettling(positionId);
    setError(null);
    try {
      const r = await settleContinuousPosition({ owner: activeAddress, positionId });
      setSettleResults((prev) => ({ ...prev, [positionId]: r }));
      refreshPositions();
      usdc.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettling(null);
    }
  }

  async function getFaucet() {
    if (!wallet.address) return;
    setBusy(true);
    try {
      await fetch(`${BACKEND_URL}/api/dev/airdrop-mock-usdc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet.address, amount: 1000 }),
      });
      window.setTimeout(() => usdc.refresh(), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const openPositions = positions.filter((p) => !p.settled);
  const settledPositions = positions.filter((p) => p.settled);

  return (
    <>
      <Header />
      <PageFrame wide>
        <div style={{ marginBottom: 22 }}>
          <h1 style={{ fontFamily: FD, fontSize: 34, fontWeight: 600, letterSpacing: "-0.03em", color: C.textPrimary, margin: 0 }}>
            Distribution Markets
          </h1>
          <p style={{ fontFamily: FS, fontSize: 14.5, color: C.textSecondary, margin: "8px 0 0", maxWidth: 640, lineHeight: 1.6 }}>
            Trade a continuous probability distribution. The market prices a Normal forward f(x); set your own
            view g(x) by moving the mean and spread. Your position pays g(x) − f(x) at the realized outcome, and
            the collateral is escrowed on Sui testnet.
          </p>
        </div>

        <div className="dc-grid">
          {/* ---- left: market list + your view controls ---- */}
          <aside style={{ display: "grid", gap: 16, alignContent: "start" }}>
            <div style={PANEL}>
              <div className="dc-cap">Forwards</div>
              <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                {markets.map((m) => {
                  const on = m.id === marketId;
                  return (
                    <button
                      key={m.id}
                      onClick={() => selectMarket(m)}
                      className="dc-market"
                      style={{ borderColor: on ? C.tealLight : C.border, background: on ? C.cardHover : "transparent" }}
                    >
                      <span style={{ fontFamily: FD, fontSize: 14, color: C.textPrimary }}>{m.underlying}/USD</span>
                      <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                        f = N({price(m.mu)}, {Math.round(m.sigma)})
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {market && (
              <div style={PANEL}>
                <div className="dc-cap">Your view · g(x)</div>
                <div style={{ display: "grid", gap: 18, marginTop: 14 }}>
                  <Slider label="Mean (μ)" value={mu} min={market.mu_min} max={market.mu_max} step={market.step} fmt={price} onChange={setMu} />
                  <Slider label="Std dev (σ) · conviction" value={sigma} min={market.sigma_min} max={market.sigma_max} step={market.step} fmt={(v) => `±${Math.round(v).toLocaleString()}`} onChange={setSigma} />
                  <div>
                    <div className="dc-cap" style={{ marginBottom: 6 }}>Collateral (USDC) · max loss</div>
                    <input className="dc-num" type="number" min={1} value={collateral} onChange={(e) => setCollateral(e.target.value)} />
                  </div>
                  <button onClick={() => market && (setMu(market.mu), setSigma(market.sigma))} className="dc-reset">
                    Reset to market
                  </button>
                  {wallet.connected && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `0.5px solid ${C.border}`, paddingTop: 12 }}>
                      <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                        Balance:{" "}
                        <span style={{ color: C.textPrimary }}>
                          {usdc.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} mUSDC
                        </span>
                      </span>
                      <button onClick={getFaucet} disabled={busy} className="dc-reset" style={{ width: "auto", padding: "6px 10px" }}>
                        Get test mUSDC
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>

          {/* ---- right: chart + quote + open ---- */}
          <main style={{ display: "grid", gap: 16, alignContent: "start" }}>
            <div style={PANEL}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                <div className="dc-cap">{market ? `${market.underlying}/USD forward · 30d` : "Select a market"}</div>
                {quote && (
                  <div style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                    continuous · L2 AMM · {quote.x.length}-pt grid
                  </div>
                )}
              </div>
              {quote ? <DistChart quote={quote} /> : <div style={{ height: 300 }} />}
            </div>

            <div style={PANEL}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
                <Stat label="You lock" value={quote ? usd(quote.collateral_required_usdc) : "—"} />
                <Stat label="Max profit" value={quote ? usd(quote.max_profit_usdc) : "—"} color={C.green} />
                <Stat label="Max loss" value={quote ? usd(quote.max_loss_usdc) : "—"} color={C.red} />
                <Stat label="EV if you're right" value={quote ? usd(quote.expected_value_usdc) : "—"} color={quote && quote.expected_value_usdc >= 0 ? C.green : C.red} />
              </div>

              <button onClick={open} disabled={!canOpen} className="dc-open" style={{ marginTop: 18, opacity: canOpen ? 1 : 0.5, cursor: canOpen ? "pointer" : "not-allowed" }}>
                {busy ? stage ?? "Submitting…" : !wallet.connected ? "Connect wallet to trade" : flat ? "Move your view off the market" : `Open position · lock ${quote ? usd(quote.collateral_required_usdc) : ""}`}
              </button>

              {result && (
                <div style={{ marginTop: 12, fontFamily: FM, fontSize: 12, color: C.green }}>
                  ✓ Position opened on testnet ·{" "}
                  <a href={suiExplorerTxUrl(result.digest)} target="_blank" rel="noreferrer" style={{ color: C.tealLight }}>
                    {result.digest.slice(0, 10)}…
                  </a>{" "}
                  <span style={{ color: C.textMuted }}>· settle it below to realize the outcome</span>
                </div>
              )}
              {error && <div style={{ marginTop: 12, fontFamily: FM, fontSize: 12, color: C.red }}>{error}</div>}
            </div>

            {openPositions.length > 0 && (
              <div style={PANEL}>
                <div className="dc-cap">Open positions ({openPositions.length})</div>
                <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                  {openPositions.map((p) => (
                    <div key={p.id} className="dc-pos" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "grid", gap: 2 }}>
                        <span style={{ fontFamily: FD, fontSize: 13, color: C.textPrimary }}>{p.question}</span>
                        <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                          g = N({price(p.target_mu)}, {Math.round(p.target_sigma)}) · {usd(p.collateral_usdc)} locked · up to {usd(p.max_profit_usdc)}
                        </span>
                      </div>
                      <button onClick={() => settle(p.id)} disabled={settling === p.id} className="dc-settle">
                        {settling === p.id ? "Settling…" : "Settle"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {settledPositions.length > 0 && (
              <div style={PANEL}>
                <div className="dc-cap">Settled ({settledPositions.length})</div>
                <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                  {settledPositions.map((p) => {
                    const pnl = (p.net_usdc ?? 0) - p.collateral_usdc;
                    const win = pnl >= 0;
                    return (
                      <div key={p.id} className="dc-pos" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "grid", gap: 2 }}>
                          <span style={{ fontFamily: FD, fontSize: 13, color: C.textPrimary }}>{p.question}</span>
                          <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                            resolved at {price(p.realized_x)} · returned {usd(p.net_usdc ?? 0)}
                            {p.settle_digest ? (
                              <>
                                {" · "}
                                <a href={suiExplorerTxUrl(p.settle_digest)} target="_blank" rel="noreferrer" style={{ color: C.tealLight }}>
                                  payout
                                </a>
                              </>
                            ) : null}
                          </span>
                        </div>
                        <span style={{ fontFamily: FD, fontSize: 14, color: win ? C.green : C.red }}>
                          {win ? "+" : ""}
                          {usd(pnl)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </main>
        </div>
      </PageFrame>

      <style jsx global>{`
        .dc-grid { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; align-items: start; }
        @media (max-width: 900px) { .dc-grid { grid-template-columns: 1fr; } }
        .dc-cap { font-family: ${FM}; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.textMuted}; }
        .dc-market { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 12px 14px; border: 0.5px solid ${C.border}; border-radius: 10px; cursor: pointer; text-align: left; transition: border-color 0.15s ${EASE}, background 0.15s ${EASE}; }
        .dc-market:hover { border-color: ${C.borderHover}; }
        .dc-num { width: 100%; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 8px; padding: 10px 12px; color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; outline: none; }
        .dc-num:focus { border-color: ${C.tealLight}; }
        .dc-reset { background: transparent; border: 0.5px solid ${C.border}; border-radius: 8px; padding: 8px; color: ${C.textSecondary}; font-family: ${FM}; font-size: 11px; cursor: pointer; }
        .dc-reset:hover { border-color: ${C.borderHover}; color: ${C.textPrimary}; }
        .dc-open { width: 100%; background: ${C.tealLight}; border: none; border-radius: 10px; padding: 14px; color: #06121a; font-family: ${FD}; font-size: 14px; font-weight: 600; }
        .dc-pos { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 0.5px solid ${C.border}; border-radius: 10px; }
        .dc-settle { background: ${C.tealLight}; border: none; border-radius: 8px; padding: 7px 14px; color: #06121a; font-family: ${FD}; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .dc-settle:disabled { opacity: 0.5; cursor: not-allowed; }
        .dc-range { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 4px; background: ${C.border}; outline: none; }
        .dc-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 50%; background: ${C.tealLight}; cursor: pointer; border: none; }
        .dc-range::-moz-range-thumb { width: 15px; height: 15px; border-radius: 50%; background: ${C.tealLight}; cursor: pointer; border: none; }
      `}</style>
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: C.textMuted }}>{label}</div>
      <div style={{ fontFamily: FD, fontSize: 19, fontWeight: 600, color: color ?? C.textPrimary, marginTop: 4 }}>{value}</div>
    </div>
  );
}
