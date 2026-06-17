"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE, BACKEND_URL } from "../_lib/tokens";
import { suiExplorerTxUrl, friendlyWalletError } from "../_lib/chain";
import { ConnectModal } from "@mysten/dapp-kit";
import { useWalletSigner, useUsdcBalance } from "../_lib/wallet-bridge";
import { DistChart, buildChartFrame, buildFrameFromDensity, type ChartData } from "../_components/dist-chart";
import { Stat, openableBuckets } from "../_components/strip-products";
import {
  stripPreview,
  ensureManager,
  prepareOpenStrip,
  confirmPredict,
  fetchVolSurface,
  fetchDensity,
  type StripQuote,
  type ImpliedDensity,
} from "../_lib/predict-strip-client";

const usd = (v: number) => `$${v.toFixed(2)}`;
const r6 = (raw: string | number) => Number(raw) / 1e6;
const compact = (v: number) =>
  v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`;

// A DeepBook "market" is a live BTC expiry. f(x) = Normal(forward, σ_implied),
// where σ_implied (in $) = forward · ATM_IV · √T from the live SVI surface.
interface DeepBookMarket {
  id: string; // oracle_id
  expiry: number;
  tenor: string;
  forward: number;
  atmIv: number;
  tYears: number;
  sigmaImpl: number;
}

const N_BUCKETS = 6;

// Default view: a mild conviction long of the market's own forward — mean
// unchanged, spread tightened ~20% so "trade where we are" is openable on load.
function convictionSigma(m: DeepBookMarket): number {
  return Math.max(m.sigmaImpl * 0.15, Math.min(m.sigmaImpl * 3, m.sigmaImpl * 0.8));
}

const PANEL: React.CSSProperties = { background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 20 };

function Slider({ label, value, min, max, step, fmt, onChange }: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontFamily: FM, fontSize: 10.5, letterSpacing: "0.1em", color: C.textMuted, textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontFamily: FD, fontSize: 14, color: C.textPrimary }}>{fmt(value)}</span>
      </div>
      <input type="range" className="dc-range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

export default function DistributionPage() {
  const wallet = useWalletSigner();
  const usdc = useUsdcBalance();

  const [markets, setMarkets] = useState<DeepBookMarket[]>([]);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [poolTvl, setPoolTvl] = useState<number | null>(null);
  const [mu, setMu] = useState(0);
  const [sigma, setSigma] = useState(0);
  const [budget, setBudget] = useState("100");

  const [density, setDensity] = useState<ImpliedDensity | null>(null);
  const [quote, setQuote] = useState<StripQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<{ digest: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const market = useMemo(() => markets.find((m) => m.id === marketId) ?? null, [markets, marketId]);

  // Load the live BTC tenors (the markets) from the SVI surface + the PLP pool.
  useEffect(() => {
    fetchVolSurface("BTC")
      .then((s) => {
        // Drop seconds-to-expiry slices: as T→0 the implied σ collapses to a spike,
        // which is correct but degenerate to trade/plot. Keep ≥5-min tenors.
        const T_MIN = 300 / 31_557_600;
        const mk: DeepBookMarket[] = s.slices
          .filter((sl) => sl.t_years > T_MIN)
          .map((sl) => ({
            id: sl.oracle_id,
            expiry: sl.expiry,
            tenor: sl.tenor_label,
            forward: sl.forward_usd,
            atmIv: sl.atm_iv,
            tYears: sl.t_years,
            sigmaImpl: Math.max(1, sl.forward_usd * sl.atm_iv * Math.sqrt(Math.max(sl.t_years, 1e-9))),
          }));
        setMarkets(mk);
        // Default to a mid-to-long tenor — the widest, most distribution-like bell,
        // not the soonest (near-expiry spike).
        const def = mk[Math.min(mk.length - 1, Math.floor(mk.length * 0.55))];
        if (def) {
          setMarketId(def.id);
          setMu(def.forward);
          setSigma(convictionSigma(def));
        }
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
    fetch(`${BACKEND_URL}/api/predict/vault/summary`)
      .then((r) => r.json())
      .then((v) => { if (v && typeof v.vault_value === "number") setPoolTvl(v.vault_value / 1e6); })
      .catch(() => {});
  }, []);

  const selectMarket = useCallback((m: DeepBookMarket) => {
    setMarketId(m.id);
    setMu(m.forward);
    setSigma(convictionSigma(m));
    setQuote(null);
    setResult(null);
    setError(null);
  }, []);

  // f(x) is the REAL SVI-implied market density (skewed/fat-tailed) — fetched
  // once per market (oracle), independent of your μ/σ view.
  useEffect(() => {
    if (!marketId) { setDensity(null); return; }
    let alive = true;
    setDensity(null);
    fetchDensity(marketId).then((d) => { if (alive) setDensity(d); }).catch(() => { if (alive) setDensity(null); });
    return () => { alive = false; };
  }, [marketId]);

  // Debounced live strip quote (real on-chain MM via get_range_trade_amounts).
  const quoteTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!market) return;
    const b = Number(budget);
    if (!Number.isFinite(b) || b <= 0) { setQuote(null); return; }
    const ctrl = new AbortController();
    if (quoteTimer.current) window.clearTimeout(quoteTimer.current);
    setQuoting(true);
    quoteTimer.current = window.setTimeout(() => {
      stripPreview({ oracle_id: market.id, mu_usd: mu, sigma_usd: sigma, n: N_BUCKETS, budget_usd: b, sender: wallet.address ?? undefined }, ctrl.signal)
        .then((q) => { setQuote(q); setError(null); })
        .catch((e) => { if ((e as { name?: string })?.name !== "AbortError") setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => setQuoting(false));
    }, 200);
    return () => { ctrl.abort(); if (quoteTimer.current) window.clearTimeout(quoteTimer.current); };
  }, [market, mu, sigma, budget, wallet.address]);

  // Chart frame: f(x) = the real SVI-implied market density when loaded (matches
  // the DeepBook backend); your μ/σ Normal for g(x). Falls back to a Normal f(x)
  // (from the SVI ATM σ) only while the density is still loading.
  const frame = useMemo<ChartData | null>(() => {
    if (!market) return null;
    if (density && density.oracle_id === market.id && density.pdf.length > 2) {
      return buildFrameFromDensity(density.x, density.pdf, mu, sigma);
    }
    return buildChartFrame(market.forward, market.sigmaImpl, mu, sigma, "usd");
  }, [market, mu, sigma, density]);

  const tradeable = quote ? quote.buckets.filter((b) => b.tradeable && Number(b.quantity) > 0).length : 0;
  const flat = !quote || tradeable === 0;
  const canOpen = wallet.connected && !!quote && !flat && !busy;

  const lock = quote ? r6(quote.total_cost_raw) : 0;
  const maxProfit = quote ? r6(quote.realized_max_payout_raw) - r6(quote.total_cost_raw) : 0;
  const ev = quote ? r6(quote.expected_value_raw) : 0;

  async function open() {
    if (!market || !quote) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const buckets = openableBuckets(quote.buckets);
      if (buckets.length === 0) throw new Error("No tradeable bands — widen σ or pick another expiry.");
      setStage("Building strip…");
      const deposit = ((BigInt(quote.total_cost_raw) * 12n) / 10n).toString();
      const prep = await prepareOpenStrip({
        owner: wallet.address as string,
        manager_id: mgr,
        oracle_id: quote.oracle_id,
        expiry: quote.expiry,
        buckets,
        deposit_amount_raw: deposit,
      });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult({ digest: c.digest });
      usdc.refresh();
    } catch (e) {
      setError(friendlyWalletError(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  const muMin = market ? market.forward - Math.max(market.forward * 0.06, 4 * market.sigmaImpl) : 0;
  const muMax = market ? market.forward + Math.max(market.forward * 0.06, 4 * market.sigmaImpl) : 1;
  const sigMin = market ? market.sigmaImpl * 0.15 : 0;
  const sigMax = market ? market.sigmaImpl * 3 : 1;
  const step = market ? Math.max(1, Math.round(market.forward / 4000)) : 1;

  return (
    <>
      <Header />
      <PageFrame wide zoom={0.8}>
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontFamily: FM, fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase", color: C.teal, marginBottom: 10 }}>
            BTC · Distribution
          </div>
          <h1 style={{ fontFamily: FD, fontSize: 34, fontWeight: 600, letterSpacing: "-0.03em", color: C.textPrimary, margin: 0 }}>
            Distribution
          </h1>
          <p style={{ fontFamily: FS, fontSize: 14.5, color: C.textSecondary, margin: "8px 0 0", maxWidth: 680, lineHeight: 1.6 }}>
            Trade your <strong style={{ color: C.textPrimary }}>whole view</strong> of where BTC settles, not one strike.
            f(x) is the market&apos;s live implied distribution from the DeepBook SVI surface. Move μ and σ to set your view
            g(x), then mint the matching range strip. Priced and settled on-chain.
          </p>
        </div>

        <div className="dc-grid">
          {/* ---- left: market list (live BTC tenors) + your view ---- */}
          <aside style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <div style={PANEL}>
              <div className="dc-cap">Markets · live BTC tenors</div>
              <div className="dc-market-scroll">
                {markets.map((m) => {
                  const on = m.id === marketId;
                  return (
                    <button key={m.id} onClick={() => selectMarket(m)} className="dc-market" style={{ borderColor: on ? C.tealLight : C.border, background: on ? C.cardHover : "transparent" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 8 }}>
                        <span style={{ flex: 1, minWidth: 0, fontFamily: FD, fontSize: 14, color: C.textPrimary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          BTC · {m.tenor} expiry
                        </span>
                        <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", height: 18, fontFamily: FM, fontSize: 9, lineHeight: 1, letterSpacing: "0.06em", textTransform: "uppercase", color: "#7de7ff", background: "#7de7ff1f", borderRadius: 999, padding: "0 8px" }}>
                          Crypto
                        </span>
                      </div>
                      <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                        f = N(${Math.round(m.forward).toLocaleString()}, ${Math.round(m.sigmaImpl).toLocaleString()})
                      </span>
                      <div style={{ display: "flex", gap: 10, marginTop: 2, fontFamily: FM, fontSize: 10, color: C.textMuted }}>
                        <span>IV {(m.atmIv * 100).toFixed(0)}%</span>
                        {poolTvl != null && <span>pool {compact(poolTvl)}</span>}
                        <span style={{ color: `${C.green}cc` }}>live</span>
                      </div>
                    </button>
                  );
                })}
                {markets.length === 0 && (
                  <span style={{ fontFamily: FS, fontSize: 12.5, color: C.textMuted, lineHeight: 1.5 }}>
                    {loadErr ? "Live tenors offline — start the backend." : "Loading live BTC tenors…"}
                  </span>
                )}
              </div>
            </div>

            {market && (
              <div style={PANEL}>
                <div className="dc-cap">Your view · g(x)</div>
                <div style={{ display: "grid", gap: 18, marginTop: 14 }}>
                  <Slider label="Mean (μ)" value={mu} min={muMin} max={muMax} step={step} fmt={(v) => `$${Math.round(v).toLocaleString()}`} onChange={setMu} />
                  <Slider label="Std dev (σ) · conviction" value={sigma} min={sigMin} max={sigMax} step={step} fmt={(v) => `±$${Math.round(v).toLocaleString()}`} onChange={setSigma} />
                  <div>
                    <div className="dc-cap" style={{ marginBottom: 6 }}>Budget (dUSDC) · max loss</div>
                    <input className="dc-num" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} />
                  </div>
                  <button onClick={() => selectMarket(market)} className="dc-reset">Reset to live forward</button>
                </div>

                <div style={{ display: "grid", gap: 14, paddingTop: 18 }}>
                  <div style={{ borderTop: `0.5px solid ${C.border}`, paddingTop: 14 }}>
                    <span className="dc-cap">Pool liquidity · PLP</span>
                    <div style={{ fontFamily: FD, fontSize: 22, fontWeight: 600, color: C.textPrimary, marginTop: 6 }}>
                      {poolTvl != null ? compact(poolTvl) : "—"}
                    </div>
                  </div>
                  <div style={{ borderTop: `0.5px solid ${C.border}`, paddingTop: 12, display: "grid", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                      <span>Expiry</span>
                      <span style={{ color: C.textSecondary }}>{new Date(market.expiry).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                      <span>Oracle</span>
                      <span style={{ color: C.textSecondary }}>{market.id.slice(0, 8)}…</span>
                    </div>
                    {wallet.connected && (
                      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                        <span>Balance</span>
                        <span style={{ color: C.textPrimary }}>{usdc.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} mUSDC</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </aside>

          {/* ---- right: chart + quote + open ---- */}
          <main style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={PANEL}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                <div className="dc-cap">{market ? `BTC · ${market.tenor} expiry · forward f(x)` : "Select a market"}</div>
                {market && (
                  <div style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                    SVI surface · {quoting ? "pricing…" : "121-pt grid"}
                  </div>
                )}
              </div>
              {frame ? <DistChart quote={frame} /> : <div style={{ height: 300 }} />}
            </div>

            <div style={PANEL}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
                <Stat label="You lock" value={quote ? usd(lock) : "—"} />
                <Stat label="Max profit" value={quote ? usd(maxProfit) : "—"} color={C.green} />
                <Stat label="Max loss" value={quote ? usd(lock) : "—"} color={C.red} />
                <Stat label="EV under your view" value={quote ? usd(ev) : "—"} color={quote && ev >= 0 ? C.green : C.red} />
              </div>

              {quote && (
                <div style={{ display: "flex", gap: 18, marginTop: 12, fontFamily: FM, fontSize: 11, color: C.textMuted, flexWrap: "wrap" }}>
                  <span>round-trip spread {usd(r6(quote.round_trip_spread_raw))}</span>
                  <span>{tradeable}/{quote.buckets.length} bands live</span>
                  <span>best payout {usd(r6(quote.realized_max_payout_raw))}</span>
                </div>
              )}

              {!wallet.connected ? (
                <ConnectModal trigger={<button className="dc-open" style={{ marginTop: 18, cursor: "pointer" }}>Connect a wallet to trade</button>} />
              ) : (
                <button onClick={open} disabled={!canOpen} className="dc-open" style={{ marginTop: 18, opacity: canOpen ? 1 : 0.5, cursor: canOpen ? "pointer" : "not-allowed" }}>
                  {busy ? stage ?? "Submitting…" : flat ? "Widen σ to build a tradeable strip" : `Open strip · lock ${quote ? usd(lock) : ""}`}
                </button>
              )}

              {wallet.connected && (
                <div style={{ marginTop: 12, fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                  Opening needs dUSDC (Predict&apos;s faucet-gated quote asset). Balance {usdc.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} mUSDC.
                </div>
              )}

              {result && (
                <div style={{ marginTop: 12, fontFamily: FM, fontSize: 12, color: C.green }}>
                  ✓ Strip opened on testnet ·{" "}
                  <a href={suiExplorerTxUrl(result.digest)} target="_blank" rel="noreferrer" style={{ color: C.tealLight }}>
                    {result.digest.slice(0, 10)}… ↗
                  </a>
                </div>
              )}
              {error && <div style={{ marginTop: 12, fontFamily: FM, fontSize: 12, color: C.red, lineHeight: 1.5 }}>{error}</div>}
            </div>
          </main>
        </div>
      </PageFrame>

      <style jsx global>{`
        .dc-grid { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 30px; align-items: start; }
        @media (max-width: 900px) { .dc-grid { grid-template-columns: 1fr; } }
        .dc-cap { font-family: ${FM}; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.textMuted}; }
        .dc-market-scroll { display: grid; gap: 8px; margin-top: 12px; max-height: 320px; overflow-y: auto; overflow-x: hidden; padding-right: 2px; scrollbar-width: none; -ms-overflow-style: none; }
        .dc-market-scroll::-webkit-scrollbar { width: 0; height: 0; display: none; }
        .dc-market { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; overflow: hidden; padding: 12px 14px; border: 0.5px solid ${C.border}; border-radius: 10px; cursor: pointer; text-align: left; transition: border-color 0.15s ${EASE}, background 0.15s ${EASE}; }
        .dc-market:hover { border-color: ${C.borderHover}; }
        .dc-num { width: 100%; box-sizing: border-box; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 8px; padding: 10px 12px; color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; outline: none; }
        .dc-num:focus { border-color: ${C.tealLight}; }
        .dc-reset { background: transparent; border: 0.5px solid ${C.border}; border-radius: 8px; padding: 8px; color: ${C.textSecondary}; font-family: ${FM}; font-size: 11px; cursor: pointer; }
        .dc-reset:hover { border-color: ${C.borderHover}; color: ${C.textPrimary}; }
        .dc-open { width: 100%; background: ${C.tealLight}; border: none; border-radius: 10px; padding: 14px; color: #06121a; font-family: ${FD}; font-size: 14px; font-weight: 600; }
        .dc-range { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 4px; background: ${C.border}; outline: none; }
        .dc-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 50%; background: ${C.tealLight}; cursor: pointer; border: none; }
        .dc-range::-moz-range-thumb { width: 15px; height: 15px; border-radius: 50%; background: ${C.tealLight}; cursor: pointer; border: none; }
      `}</style>
    </>
  );
}
