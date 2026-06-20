"use client";

// ---------------------------------------------------------------------------
// DeepBook — structured strategies built on DeepBook, plus Protected Notes.
//
// Two linked surfaces, switched by an in-page tab:
//   1. Strategies     — 7 prebuilt DeepBook range-strip strategies. Pick one +
//                       a notional → live on-chain quote (priced via DeepBook's
//                       get_range_trade_amounts), a payoff shape, greeks, max
//                       loss, and a Deploy CTA that routes the strip on-chain.
//   2. Protected Notes — PPN allocation. Principal → a protected floor + a real
//                       Sui DeFi yield sleeve (DeFiLlama pools) whose YIELD funds
//                       a deployed DeepBook upside strip.
//
// Basic mode  = clean, legible: tagged strategy cards → simple quote + Deploy;
//               note preset picker → floor / expected / best + Deploy.
// Advanced mode = the exact deployment: full strip buckets (range bands, qty,
//               cost, payout, slippage), greeks, on-chain oracle/expiry routing,
//               and for notes the full yield-sleeve breakdown + deployed strip.
//
// All numbers are live (DeepBook Predict pricing + DeFiLlama pool APYs). The
// strip deploy routes through the existing predict strip open flow.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { useMode } from "../_lib/mode";
import { friendlyWalletError } from "../_lib/chain";
import { useWalletSigner } from "../_lib/wallet-bridge";
import { ConnectModal } from "@mysten/dapp-kit";
import { ResultLine } from "../_components/strip-products";
import {
  ensureManager,
  prepareOpenStrip,
  prepareVolOpen,
  volQuote,
  confirmPredict,
  usd,
  type VolStrategy,
} from "../_lib/predict-strip-client";
import {
  fetchDeepBookStrategies,
  fetchDeepBookExpiries,
  quoteDeepBookStrategy,
  fetchNotePresets,
  quoteNote,
  type DeepBookStrategy,
  type DeepBookExpiry,
  type DeepBookQuote,
  type DeepBookBucket,
  type NotePreset,
  type NoteQuote,
} from "../_lib/v2-clients";
import { CurrencySelect, type Currency } from "../_components/CurrencySelect";

// ───────────────────────── formatters ─────────────────────────
const money = (v: number, d = 0) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const money2 = (v: number) => money(v, 2);
const pctSigned = (v: number) => {
  const r = Number(v.toFixed(2));
  return r > 0 ? `+${r.toFixed(2)}%` : `${r.toFixed(2)}%`;
};
// raw (6-dp dUSDC) → ui number
const ui = (raw: string) => Number(raw) / 1e6;

const RISK_COLOR: Record<string, string> = {
  low: C.green,
  med: C.amber,
  medium: C.amber,
  high: C.red,
};
const CONVEX_COLOR: Record<string, string> = {
  long: C.tealLight,
  short: C.violet,
  neutral: C.textSecondary,
};

// payoff glyph path per shape (18×14 viewBox)
function shapePath(shape: string): string {
  switch (shape) {
    case "pin": return "M2 12 L9 3 L16 12";
    case "plateau": return "M2 12 L5 5 L13 5 L16 12";
    case "wings": return "M2 4 L9 11 L16 4";
    case "tail": return "M2 11 L4 11 L9 11 L13 5 L16 3";
    case "ladder": return "M2 12 L6 9 L9 6 L12 6 L16 3";
    case "capped": return "M2 11 L6 5 L12 5 L16 11";
    default: return "M2 11 L9 5 L16 11";
  }
}

function ShapeIcon({ shape, color, w = 22, h = 16 }: { shape: string; color: string; w?: number; h?: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 18 14" fill="none" style={{ flexShrink: 0 }}>
      <path d={shapePath(shape)} stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Tag({ label, color }: { label: string; color: string }) {
  return (
    <span className="db-tag" style={{ color, borderColor: `${color}44`, background: `${color}12` }}>
      {label}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════
export default function DeepBookPage() {
  const { mode } = useMode();
  const wallet = useWalletSigner();
  const [tab, setTab] = useState<"strategies" | "notes">("strategies");

  return (
    <>
      <Header />
      <PageFrame wide>
        <div className="db">
          {/* header */}
          <div className="db-head">
            <div>
              <div className="db-eyebrow">STRUCTURED STRATEGIES · BUILT ON DEEPBOOK</div>
              <h1>DeepBook</h1>
              <p>
                Prebuilt range-strip strategies priced live off the DeepBook order book, plus principal-protected
                notes that route real Sui DeFi yield into a deployed DeepBook upside strip.
              </p>
            </div>
            <div className="db-tabs" role="tablist" aria-label="Surface">
              <button role="tab" aria-selected={tab === "strategies"} className={tab === "strategies" ? "is-on" : ""} onClick={() => setTab("strategies")}>
                Strategies
              </button>
              <button role="tab" aria-selected={tab === "notes"} className={tab === "notes" ? "is-on" : ""} onClick={() => setTab("notes")}>
                Protected Notes
              </button>
            </div>
          </div>

          {tab === "strategies"
            ? <StrategiesSurface wallet={wallet} mode={mode} />
            : <NotesSurface wallet={wallet} mode={mode} />}
        </div>
      </PageFrame>
      <style jsx global>{DB_CSS}</style>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
//  STRATEGIES SURFACE
// ═══════════════════════════════════════════════════════════════
function StrategiesSurface({ wallet, mode }: { wallet: ReturnType<typeof useWalletSigner>; mode: "basic" | "advanced" }) {
  const [strategies, setStrategies] = useState<DeepBookStrategy[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notional, setNotional] = useState("25000");
  const [expiryPref, setExpiryPref] = useState<"near" | "mid" | "far">("mid");
  const [oracleId, setOracleId] = useState<string | null>(null);   // advanced: a specific expiry
  const [expiries, setExpiries] = useState<DeepBookExpiry[]>([]);
  const [currency, setCurrency] = useState<Currency>("dUSDC");
  const [quote, setQuote] = useState<DeepBookQuote | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [pricing, setPricing] = useState(false);

  // deploy state
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const notionalNum = Number(notional);
  const valid = Number.isFinite(notionalNum) && notionalNum > 0;

  useEffect(() => {
    let alive = true;
    fetchDeepBookStrategies()
      .then((r) => { if (alive) { setStrategies(r.strategies); if (!selected && r.strategies[0]) setSelected(r.strategies[0].id); } })
      .catch((e) => { if (alive) setLoadErr(e instanceof Error ? e.message : String(e)); });
    fetchDeepBookExpiries()
      .then((r) => { if (alive) setExpiries(r.expiries); })
      .catch(() => { /* expiry strip stays empty → falls back to near/mid/far */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // price the selected strategy (debounced)
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!selected || !valid) { setQuote(null); return; }
    let alive = true;
    setPricing(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      quoteDeepBookStrategy({ strategy_id: selected, notional_usd: notionalNum, expiry_pref: expiryPref, oracle_id: mode === "advanced" && oracleId ? oracleId : undefined, sender: wallet.address ?? undefined })
        .then((q) => { if (alive) { setQuote(q); setQErr(null); } })
        .catch((e) => { if (alive) setQErr(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (alive) setPricing(false); });
    }, 220);
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); };
  }, [selected, notionalNum, valid, expiryPref, oracleId, mode, wallet.address]);

  // reset deploy result when the structure changes
  useEffect(() => { setResult(null); setOpenErr(null); }, [selected, notionalNum, expiryPref, oracleId]);

  const sel = strategies?.find((s) => s.id === selected) ?? null;
  const accent = sel ? CONVEX_COLOR[sel.convexity] ?? C.tealLight : C.tealLight;
  const tradeableBuckets = quote ? quote.strip.buckets.filter((b) => b.tradeable && Number(b.quantity) > 0) : [];

  async function deploy() {
    if (!quote || busy) return;
    setBusy(true); setOpenErr(null); setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const buckets = tradeableBuckets.map((b) => ({ lower: b.lower, higher: b.higher, quantity: b.quantity }));
      if (buckets.length === 0) throw new Error("No tradeable legs in this strategy right now.");
      setStage("Building strip…");
      const deposit = ((BigInt(quote.strip.total_cost_raw) * 12n) / 10n).toString();
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
      setResult(c.digest);
    } catch (e) { setOpenErr(friendlyWalletError(e)); }
    finally { setBusy(false); setStage(null); }
  }

  // ── loading / error / empty
  if (loadErr && !strategies) {
    return <div className="db-banner err">Couldn’t load DeepBook strategies — {loadErr}</div>;
  }
  if (!strategies) {
    return (
      <div className="db-strat-grid">
        {Array.from({ length: 7 }).map((_, i) => <div key={i} className="db-card db-skel" style={{ height: 132 }} />)}
      </div>
    );
  }

  const deployBtn = (
    !wallet.connected ? (
      <ConnectModal trigger={<button className="db-cta" style={{ background: accent }}>Connect a wallet</button>} />
    ) : (
      <button className="db-cta" style={{ background: accent }} disabled={busy || !quote || tradeableBuckets.length === 0} onClick={deploy}>
        {busy ? (stage ?? "Submitting…") : `Deploy · ${quote ? usd(quote.strip.total_cost_raw) : "—"}`}
      </button>
    )
  );

  return (
    <div className="db-surface">
      {/* strategy cards */}
      <div className="db-strat-grid">
        {strategies.map((s) => {
          const on = s.id === selected;
          const rc = RISK_COLOR[s.tail_risk] ?? C.textMuted;
          const cc = CONVEX_COLOR[s.convexity] ?? C.textSecondary;
          return (
            <button key={s.id} className={`db-card db-strat${on ? " is-active" : ""}`} style={on ? { borderColor: cc, background: `${cc}10` } : undefined} onClick={() => setSelected(s.id)}>
              <div className="db-strat-top">
                <ShapeIcon shape={s.payoff_shape} color={on ? cc : C.textMuted} />
                <div className="db-strat-tags">
                  <Tag label={s.tail_risk === "med" ? "MED RISK" : `${s.tail_risk.toUpperCase()} RISK`} color={rc} />
                </div>
              </div>
              <b style={on ? { color: cc } : undefined}>{s.name}</b>
              <em>{s.thesis}</em>
              <span className="db-strat-foot">{s.convexity} gamma · {s.payoff_shape}</span>
            </button>
          );
        })}
      </div>

      {/* controls — text left · expiry options middle · order box right */}
      <div className="db-card db-controls">
        <div className="db-controls-meta">
          <span className="db-cap">Horizon</span>
          <strong>{quote ? quote.tenor_label : pricing ? "…" : "—"}</strong>
          <span className="db-controls-thesis">{sel?.thesis ?? "Select a strategy."}</span>
        </div>
        <div className="db-expiry">
          <span className="db-cap">Expiry</span>
          {mode === "advanced" && expiries.length > 0 ? (
            <div className="db-strike-strip">
              {expiries.map((e) => {
                const on = oracleId ? e.oracle_id === oracleId : quote?.oracle_id === e.oracle_id;
                return (
                  <button key={e.oracle_id} type="button" className={`db-strike${on ? " is-on" : ""}`} onClick={() => setOracleId(e.oracle_id)}>
                    {e.tenor_label}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="db-seg">
              {(["near", "mid", "far"] as const).map((p) => (
                <button key={p} type="button" className={expiryPref === p ? "is-on" : ""} onClick={() => setExpiryPref(p)}>{p}</button>
              ))}
            </div>
          )}
        </div>
        <div className="db-amount">
          <span className="db-cap">Notional</span>
          <div className="db-amount-in">
            <span className="db-amount-cur">$</span>
            <input className="db-num" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
            <CurrencySelect value={currency} onChange={setCurrency} />
          </div>
        </div>
      </div>

      {qErr && !quote && <div className="db-banner err">{qErr}</div>}

      {/* quote */}
      {mode === "basic"
        ? <StrategyBasic quote={quote} pricing={pricing} accent={accent} deployBtn={deployBtn} result={result} openErr={openErr} tradeable={tradeableBuckets.length} />
        : <StrategyAdvanced quote={quote} pricing={pricing} accent={accent} deployBtn={deployBtn} result={result} openErr={openErr} buckets={tradeableBuckets} />}
    </div>
  );
}

// ── BASIC: simple quote (cost, max payout, payoff shape, deploy)
function StrategyBasic({ quote, pricing, accent, deployBtn, result, openErr, tradeable }: {
  quote: DeepBookQuote | null; pricing: boolean; accent: string; deployBtn: React.ReactNode; result: string | null; openErr: string | null; tradeable: number;
}) {
  if (!quote) {
    return <div className="db-card db-empty">{pricing ? "Pricing the strip on DeepBook…" : "Enter a notional to price this strategy."}</div>;
  }
  const cost = ui(quote.strip.total_cost_raw);
  const best = ui(quote.strip.realized_max_payout_raw);
  const mult = cost > 0 ? best / cost : 0;
  return (
    <div className="db-basic">
      {/* the payoff chart is the hero — full width, front and centre */}
      <div className="db-card db-payoff db-hero">
        <div className="db-card-head"><span className="db-cap">Payoff at expiry</span><span className="db-dim">{quote.name}</span></div>
        <PayoffDiagram quote={quote} accent={accent} />
        <p className="db-risk">{quote.risk_note}</p>
      </div>

      <div className="db-quote-row">
        <div className="db-card">
          <div className="db-card-head"><span className="db-cap">Quote</span><span className="db-dim">{tradeable} legs · live</span></div>
          <div className="db-metrics">
            <Metric label="Cost to deploy" value={usd(quote.strip.total_cost_raw)} />
            <Metric label="Max payout" value={usd(quote.strip.realized_max_payout_raw)} color={accent} />
            <Metric label="Payout multiple" value={`${mult.toFixed(2)}×`} />
            <Metric label="Max loss" value={money2(quote.max_loss_usd)} hint="premium" />
          </div>
        </div>
        <div className="db-card db-deploy-card">
          {deployBtn}
          {result && <ResultLine digest={result} label={`${quote.name} deployed`} />}
          {openErr && <div className="db-banner err" style={{ marginTop: 10 }}>{openErr}</div>}
          <p className="db-note">Strip minted on-chain on Sui via DeepBook Predict. Pricing live from the order book; settles on testnet.</p>
        </div>
      </div>
    </div>
  );
}

// ── ADVANCED: full strip buckets + greeks + routing
function StrategyAdvanced({ quote, pricing, accent, deployBtn, result, openErr, buckets }: {
  quote: DeepBookQuote | null; pricing: boolean; accent: string; deployBtn: React.ReactNode; result: string | null; openErr: string | null; buckets: DeepBookBucket[];
}) {
  if (!quote) {
    return <div className="db-card db-empty">{pricing ? "Pricing the strip on DeepBook…" : "Enter a notional to price this strategy."}</div>;
  }
  const g = quote.greeks;
  // theta now smooth-squashes toward its position-value cap; near the cap the
  // per-day number is no longer meaningful, so show "—" with a short-tenor note.
  const thetaSaturated = Math.abs(g.theta_usd_day) >= 0.9 * Math.abs(g.position_value_usd);
  return (
    <div className="db-adv">
      {/* top: payoff chart front-and-centre (big) + greeks / deploy beside it */}
      <div className="db-adv-top">
        <div className="db-card db-payoff db-hero">
          <div className="db-card-head"><span className="db-cap">Payoff at expiry</span><span className="db-dim">{quote.payoff_shape}</span></div>
          <PayoffDiagram quote={quote} accent={accent} />
        </div>
        <div className="db-side">
          <div className="db-card">
            <div className="db-card-head"><span className="db-cap">Greeks</span><span className="db-dim">position</span></div>
            <div className="db-greeks">
              <Greek sym="Δ" name="Delta" val={`${g.delta_btc >= 0 ? "+" : ""}${g.delta_btc.toFixed(4)}`} unit="BTC" />
              <Greek sym="Γ" name="Gamma" val={g.gamma.toFixed(5)} color={g.gamma >= 0 ? C.green : C.red} />
              <Greek sym="ν" name="Vega" val={`${g.vega_usd >= 0 ? "+" : ""}${money2(g.vega_usd)}`} unit="/pt" color={g.vega_usd >= 0 ? C.green : C.red} />
              <Greek sym="Θ" name="Theta" val={thetaSaturated ? "—" : `${g.theta_usd_day >= 0 ? "+" : ""}${money2(g.theta_usd_day)}`} unit={thetaSaturated ? "short tenor" : "/day"} color={thetaSaturated ? undefined : (g.theta_usd_day >= 0 ? C.green : C.red)} />
            </div>
            <div className="db-greek-foot">
              <RouteHandle k="Position value" v={money2(g.position_value_usd)} />
              <RouteHandle k="Max loss" v={money2(quote.max_loss_usd)} />
            </div>
          </div>
          <div className="db-card db-deploy-card">
            {deployBtn}
            {result && <ResultLine digest={result} label={`${quote.name} deployed`} />}
            {openErr && <div className="db-banner err" style={{ marginTop: 10 }}>{openErr}</div>}
          </div>
        </div>
      </div>

      {/* under: the live DeepBook order book — the deployed range bands */}
      <div className="db-card db-book">
        <div className="db-card-head">
          <span className="db-cap">Order book · range bands on DeepBook</span>
          <span className="db-dim">{buckets.length} / {quote.strip.buckets.length} tradeable</span>
        </div>
        <div className="db-book-table">
          <div className="db-brow db-brow-h">
            <span>Range band</span><span>Qty</span><span>Cost</span><span>Pays</span><span>Slippage</span><span>Spread</span>
          </div>
          {quote.strip.buckets.map((b, i) => {
            const t = b.tradeable && Number(b.quantity) > 0;
            return (
              <div className={`db-brow${t ? "" : " is-dim"}`} key={i}>
                <span className="db-band">{money(b.lower_usd)}–{money(b.higher_usd)}</span>
                <span>{t ? (Number(b.quantity) / 1e6).toFixed(0) : "—"}</span>
                <span>{t ? usd(b.mint_cost_raw) : "—"}</span>
                <span style={t ? { color: accent } : undefined}>{t ? usd(b.max_payout_raw) : "—"}</span>
                <span className="db-slip">{t ? usd(b.slippage_raw, 4) : "—"}</span>
                <span className="db-slip">{t ? usd(b.spread_raw) : "—"}</span>
              </div>
            );
          })}
          <div className="db-brow db-brow-tot">
            <span>Total</span>
            <span>—</span>
            <span>{usd(quote.strip.total_cost_raw)}</span>
            <span style={{ color: accent }}>{usd(quote.strip.realized_max_payout_raw)}</span>
            <span className="db-slip">{usd(quote.strip.total_slippage_raw, 4)}</span>
            <span className="db-slip">{usd(quote.strip.round_trip_spread_raw)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  PROTECTED NOTES SURFACE
// ═══════════════════════════════════════════════════════════════
function NotesSurface({ wallet, mode }: { wallet: ReturnType<typeof useWalletSigner>; mode: "basic" | "advanced" }) {
  const [presets, setPresets] = useState<NotePreset[] | null>(null);
  const [apySources, setApySources] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [principal, setPrincipal] = useState("10000");
  const [currency, setCurrency] = useState<Currency>("dUSDC");
  const [tenor, setTenor] = useState<number | null>(null);
  const [quote, setQuote] = useState<NoteQuote | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [pricing, setPricing] = useState(false);

  const principalNum = Number(principal);
  const valid = Number.isFinite(principalNum) && principalNum > 0;

  useEffect(() => {
    let alive = true;
    fetchNotePresets()
      .then((r) => {
        if (!alive) return;
        setPresets(r.presets); setApySources(r.apy_sources);
        if (r.presets[0]) { setSelected(r.presets[0].id); setTenor(r.presets[0].default_tenor_days); }
      })
      .catch((e) => { if (alive) setLoadErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const sel = presets?.find((p) => p.id === selected) ?? null;
  const effTenor = tenor ?? sel?.default_tenor_days ?? 180;

  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!selected || !valid) { setQuote(null); return; }
    let alive = true;
    setPricing(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      quoteNote({ principal_usd: principalNum, preset_id: selected, tenor_days: effTenor })
        .then((q) => { if (alive) { setQuote(q); setQErr(null); } })
        .catch((e) => { if (alive) setQErr(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (alive) setPricing(false); });
    }, 220);
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); };
  }, [selected, principalNum, valid, effTenor]);

  if (loadErr && !presets) return <div className="db-banner err">Couldn’t load note presets — {loadErr}</div>;
  if (!presets) {
    return <div className="db-note-grid">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="db-card db-skel" style={{ height: 150 }} />)}</div>;
  }

  return (
    <div className="db-surface">
      {/* narrative strip */}
      <div className="db-card db-narrative">
        <span className="db-cap">How a protected note works</span>
        <div className="db-flow">
          <span className="db-flow-step"><i style={{ background: C.textSecondary }} />Principal</span>
          <span className="db-flow-arr">→</span>
          <span className="db-flow-step"><i style={{ background: C.green }} />Floor protected</span>
          <span className="db-flow-arr">+</span>
          <span className="db-flow-step"><i style={{ background: C.teal }} />Yield sleeve (Sui DeFi)</span>
          <span className="db-flow-arr">→</span>
          <span className="db-flow-step"><i style={{ background: C.tealLight }} />Yield funds a DeepBook upside strip</span>
        </div>
      </div>

      {/* preset cards */}
      <div className="db-note-grid">
        {presets.map((p) => {
          const on = p.id === selected;
          const rc = RISK_COLOR[p.tail_risk] ?? C.textMuted;
          return (
            <button key={p.id} className={`db-card db-strat${on ? " is-active" : ""}`} style={on ? { borderColor: C.tealLight, background: `${C.tealLight}0d` } : undefined} onClick={() => { setSelected(p.id); setTenor(p.default_tenor_days); }}>
              <div className="db-strat-top">
                <b style={on ? { color: C.tealLight } : undefined}>{p.name}</b>
                <Tag label={`${p.tail_risk.toUpperCase()} TAIL`} color={rc} />
              </div>
              <em>{p.blurb}</em>
              <div className="db-note-stats">
                <span>Floor <b>{Math.round(p.floor_pct * 100)}%</b></span>
                <span>Live APY <b style={{ color: C.green }}>{(p.live_apy * 100).toFixed(2)}%</b></span>
                <span>Strip <b style={{ textTransform: "capitalize" }}>{p.strategy}</b></span>
              </div>
            </button>
          );
        })}
      </div>

      {/* controls — blended APY (left) · tenor slider (middle) · principal order box (right) */}
      <div className="db-card db-controls">
        <div className="db-controls-meta">
          <span className="db-cap">Blended APY</span>
          <strong style={{ color: C.green }}>{quote ? `${(quote.blended_apy * 100).toFixed(2)}%` : pricing ? "…" : "—"}</strong>
          <span className="db-controls-thesis">{sel?.blurb ?? "Select a preset."}</span>
        </div>
        <div className="db-tenor">
          <span className="db-cap">Tenor · {effTenor}d</span>
          <input type="range" className="db-range" min={30} max={365} step={5} value={effTenor} onChange={(e) => setTenor(Number(e.target.value))} />
        </div>
        <div className="db-amount">
          <span className="db-cap">Principal</span>
          <div className="db-amount-in">
            <span className="db-amount-cur">$</span>
            <input className="db-num" inputMode="decimal" value={principal} onChange={(e) => setPrincipal(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
            <CurrencySelect value={currency} onChange={setCurrency} />
          </div>
        </div>
      </div>

      {qErr && !quote && <div className="db-banner err">{qErr}</div>}

      {mode === "basic"
        ? <NoteBasic quote={quote} pricing={pricing} principal={principalNum} wallet={wallet} strategy={sel?.strategy} />
        : <NoteAdvanced quote={quote} pricing={pricing} apySources={apySources} wallet={wallet} strategy={sel?.strategy} />}
    </div>
  );
}

// ── BASIC: floor / expected / best + projected bar + deploy note
function NoteBasic({ quote, pricing, principal, wallet, strategy }: { quote: NoteQuote | null; pricing: boolean; principal: number; wallet: ReturnType<typeof useWalletSigner>; strategy?: string }) {
  if (!quote) return <div className="db-card db-empty">{pricing ? "Pricing the note…" : "Enter a principal to price this note."}</div>;
  const { floor_usd, expected_usd, best_usd } = quote.projected;
  const gainExp = pctSigned(((expected_usd - principal) / principal) * 100);
  const gainBest = pctSigned(((best_usd - principal) / principal) * 100);
  const floorPctOfPrincipal = principal > 0 ? (floor_usd / principal) * 100 : 0;
  // bar scaled so best = 100%
  const span = Math.max(best_usd, principal) || 1;
  return (
    <div className="db-quote-grid">
      <div className="db-card">
        <div className="db-card-head"><span className="db-cap">Projected outcome</span><span className="db-dim">{quote.preset_name}</span></div>
        <div className="db-proj">
          <ProjRow label="Protected floor" value={money(floor_usd)} note={`${floorPctOfPrincipal.toFixed(0)}% of principal`} color={C.green} width={(floor_usd / span) * 100} barColor={C.green} />
          <ProjRow label="Expected" value={money(expected_usd)} note={gainExp} color={C.textPrimary} width={(expected_usd / span) * 100} barColor={C.teal} />
          <ProjRow label="Best case" value={money(best_usd)} note={gainBest} color={C.tealLight} width={(best_usd / span) * 100} barColor={C.tealLight} />
        </div>
        <p className="db-note">
          Your <b style={{ color: C.textPrimary }}>{money(principal)}</b> principal floor is protected at{" "}
          <b style={{ color: C.green }}>{money(floor_usd)}</b>. The yield it earns ({money2(quote.upside_budget_usd)}) is deployed
          into a {quote.upside_strategy.name} on DeepBook for the upside.
        </p>
      </div>

      <div className="db-side">
        <div className="db-card">
          <div className="db-card-head"><span className="db-cap">Yield sleeve</span><span className="db-dim">{quote.yield_sleeve.length} pools · live</span></div>
          <div className="db-sleeve">
            {quote.yield_sleeve.map((p, i) => (
              <div className="db-sleeve-row" key={i}>
                <span className="db-sleeve-pool">{p.pool}</span>
                <span className="db-sleeve-apy" style={{ color: C.green }}>{(p.apy * 100).toFixed(2)}%</span>
                <span className="db-sleeve-alloc">{money(p.allocation_usd)}</span>
              </div>
            ))}
          </div>
          <div className="db-metrics" style={{ marginTop: 14 }}>
            <Metric label="Upside budget" value={money2(quote.upside_budget_usd)} color={C.tealLight} />
            <Metric label="Upside strip" value={quote.upside_strategy.name} />
          </div>
        </div>
        <div className="db-card">
          <NoteDeployButton quote={quote} wallet={wallet} strategy={strategy} label={`Deploy protected note · ${money(principal)}`} />
          <p className="db-note">Allocation routes principal to the yield sleeve and deploys the yield as a DeepBook strip. Pool APYs live from DeFiLlama.</p>
        </div>
      </div>
    </div>
  );
}

// ── ADVANCED: full yield-sleeve breakdown + deployed strip detail
function NoteAdvanced({ quote, pricing, apySources, wallet, strategy }: { quote: NoteQuote | null; pricing: boolean; apySources: string[]; wallet: ReturnType<typeof useWalletSigner>; strategy?: string }) {
  if (!quote) return <div className="db-card db-empty">{pricing ? "Pricing the note…" : "Enter a principal to price this note."}</div>;
  const sleeveTotal = quote.yield_sleeve.reduce((a, p) => a + p.allocation_usd, 0) || 1;
  return (
    <div className="db-adv-grid">
      {/* left: yield sleeve breakdown */}
      <div className="db-card db-book">
        <div className="db-card-head"><span className="db-cap">Yield sleeve · Sui DeFi pools</span><span className="db-dim">DeFiLlama · live APY</span></div>
        <div className="db-sleeve-table">
          <div className="db-srow db-srow-h"><span>Pool</span><span>APY</span><span>Allocation</span><span>Weight</span><span>Source</span></div>
          {quote.yield_sleeve.map((p, i) => (
            <div className="db-srow" key={i}>
              <span className="db-band">{p.pool}</span>
              <span style={{ color: C.green }}>{(p.apy * 100).toFixed(2)}%</span>
              <span>{money2(p.allocation_usd)}</span>
              <span>{((p.allocation_usd / sleeveTotal) * 100).toFixed(0)}%</span>
              <span className="db-slip">{p.source.replace("defillama:", "")}</span>
            </div>
          ))}
          <div className="db-srow db-srow-tot">
            <span>Blended</span>
            <span style={{ color: C.green }}>{(quote.blended_apy * 100).toFixed(2)}%</span>
            <span>{money2(sleeveTotal)}</span>
            <span>100%</span>
            <span className="db-slip">{quote.yield_sleeve.length} pools</span>
          </div>
        </div>

        {/* deployed upside strip */}
        <div className="db-card-head" style={{ marginTop: 18 }}>
          <span className="db-cap">Deployed upside strip · DeepBook</span>
          <span className="db-dim">{quote.upside_strategy.shape}</span>
        </div>
        <div className="db-deployed">
          <DeployStat label="Strategy" value={quote.upside_strategy.name} />
          <DeployStat label="Upside budget" value={money2(quote.upside_budget_usd)} color={C.tealLight} />
          <DeployStat label="Expected best" value={money2(quote.upside_strategy.expected_best_usd)} color={C.green} />
          <DeployStat label="Expected worst" value={money2(quote.upside_strategy.expected_worst_usd)} color={C.textMuted} />
        </div>
        <div className="db-srcs">
          <span className="db-cap" style={{ fontSize: 9 }}>APY universe</span>
          <div className="db-src-chips">
            {apySources.map((s) => <span key={s} className="db-chip">{s.replace("defillama:", "")}</span>)}
          </div>
        </div>
      </div>

      {/* right: projected + principal split */}
      <div className="db-side">
        <div className="db-card">
          <div className="db-card-head"><span className="db-cap">Projected</span><span className="db-dim">{quote.preset_name}</span></div>
          <div className="db-metrics">
            <Metric label="Protected floor" value={money2(quote.projected.floor_usd)} color={C.green} />
            <Metric label="Expected" value={money2(quote.projected.expected_usd)} />
            <Metric label="Best case" value={money2(quote.projected.best_usd)} color={C.tealLight} />
            <Metric label="Principal" value={money2(quote.principal_usd)} />
          </div>
        </div>
        <div className="db-card">
          <div className="db-card-head"><span className="db-cap">Allocation</span><span className="db-dim">floor vs yield</span></div>
          <div className="db-alloc-bar">
            <span style={{ flex: quote.protected_floor_usd, background: C.green }} />
            <span style={{ flex: Math.max(quote.upside_budget_usd, quote.principal_usd * 0.01), background: C.tealLight }} />
          </div>
          <div className="db-alloc-key">
            <span><i style={{ background: C.green }} />Floor (yield sleeve) <b>{money2(quote.protected_floor_usd)}</b></span>
            <span><i style={{ background: C.tealLight }} />Yield → strip <b>{money2(quote.upside_budget_usd)}</b></span>
          </div>
        </div>
        <div className="db-card">
          <NoteDeployButton quote={quote} wallet={wallet} strategy={strategy} label="Deploy protected note" />
          <p className="db-note">Floor allocated to the live yield sleeve; the yield funds a deployed DeepBook strip. Settles on Sui testnet.</p>
        </div>
      </div>
    </div>
  );
}

// ── note deploy: routes the floor's yield budget into a real on-chain DeepBook
//    strip. The note's upside is the preset's vol-style strip (straddle / strangle
//    / butterfly), priced live for the real upside_budget_usd notional, then opened
//    via the SAME predict open/sign/confirm plumbing Strategies uses.
const VOL_STRATEGIES: VolStrategy[] = ["straddle", "strangle", "butterfly", "condor"];
function asVolStrategy(s: string | undefined): VolStrategy {
  const k = (s ?? "").toLowerCase();
  return (VOL_STRATEGIES as string[]).includes(k) ? (k as VolStrategy) : "straddle";
}

function NoteDeployButton({ quote, wallet, strategy, label }: {
  quote: NoteQuote; wallet: ReturnType<typeof useWalletSigner>; strategy: string | undefined; label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  // reset the deploy result whenever the priced note changes
  useEffect(() => { setResult(null); setOpenErr(null); }, [quote.preset_id, quote.principal_usd, quote.upside_budget_usd]);

  async function deploy() {
    if (busy) return;
    setBusy(true); setOpenErr(null); setResult(null);
    try {
      setStage("Pricing upside strip…");
      const vq = await volQuote({ strategy: asVolStrategy(strategy), side: "long", notional_usd: quote.upside_budget_usd });
      const buckets = vq.strip.buckets
        .filter((b) => b.tradeable && Number(b.quantity) > 0)
        .map((b) => ({ lower: b.lower, higher: b.higher, quantity: b.quantity }));
      if (buckets.length === 0) throw new Error("No tradeable upside legs in this note right now.");
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      setStage("Building note…");
      const deposit = ((BigInt(vq.strip.total_cost_raw) * 12n) / 10n).toString();
      const prep = await prepareVolOpen({
        owner: wallet.address as string,
        manager_id: mgr,
        oracle_id: vq.oracle_id,
        expiry: vq.expiry,
        buckets,
        deposit_amount_raw: deposit,
      });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult(c.digest);
    } catch (e) { setOpenErr(friendlyWalletError(e)); }
    finally { setBusy(false); setStage(null); }
  }

  return (
    <>
      {!wallet.connected ? (
        <ConnectModal trigger={<button className="db-cta" style={{ background: C.tealLight }}>Connect a wallet</button>} />
      ) : (
        <button className="db-cta" style={{ background: C.tealLight }} disabled={busy} onClick={deploy}>
          {busy ? (stage ?? "Submitting…") : label}
        </button>
      )}
      {result && <ResultLine digest={result} label={`${quote.preset_name} deployed`} />}
      {openErr && <div className="db-banner err" style={{ marginTop: 10 }}>{openErr}</div>}
    </>
  );
}

// ───────────────────────── small shared bits ─────────────────────────
function Metric({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div className="db-metric">
      <span className="db-metric-k">{label}{hint && <i>{hint}</i>}</span>
      <strong style={color ? { color } : undefined}>{value}</strong>
    </div>
  );
}
function Greek({ sym, name, val, unit, color }: { sym: string; name: string; val: string; unit?: string; color?: string }) {
  return (
    <div className="db-greek">
      <span className="db-greek-k">{sym}<i>{name}</i></span>
      <strong style={color ? { color } : undefined}>{val}{unit && <em>{unit}</em>}</strong>
    </div>
  );
}
function RouteHandle({ k, v }: { k: string; v: string }) {
  return (
    <div className="db-rh">
      <span>{k}</span>
      <strong title={v}>{v}</strong>
    </div>
  );
}
function DeployStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="db-dstat">
      <span>{label}</span>
      <strong style={color ? { color } : undefined}>{value}</strong>
    </div>
  );
}
function ProjRow({ label, value, note, color, width, barColor }: { label: string; value: string; note: string; color: string; width: number; barColor: string }) {
  return (
    <div className="db-proj-row">
      <div className="db-proj-top">
        <span className="db-proj-label">{label}</span>
        <span className="db-proj-val" style={{ color }}>{value}<i>{note}</i></span>
      </div>
      <div className="db-proj-track"><span style={{ width: `${Math.max(2, Math.min(100, width))}%`, background: barColor }} /></div>
    </div>
  );
}

// The payoff svg renders at width:100% with preserveAspectRatio="none", so the
// viewBox x-axis stretches by ratio r = containerWidth / viewBoxWidth while y is
// fixed — that distorts <text> glyphs (strokes are already non-scaling). Measure
// the live ratio and counter-scale each label horizontally by 1/r about its own
// anchor x so positions/numbers stay identical, only the distortion is removed.
function useSvgXRatio(viewBoxW: number) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [ratio, setRatio] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth || el.getBoundingClientRect().width;
      if (w > 0) setRatio(w / viewBoxW);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewBoxW]);
  return { ref, ratio };
}
// Horizontal counter-scale about anchor x: matrix(1/r,0,0,1, x*(1-1/r), 0).
const noStretchX = (x: number, ratio: number): string =>
  `matrix(${(1 / ratio).toFixed(5)},0,0,1,${(x * (1 - 1 / ratio)).toFixed(3)},0)`;

// payoff diagram: contract payout vs settlement (range strip)
function PayoffDiagram({ quote, accent, compact }: { quote: DeepBookQuote; accent: string; compact?: boolean }) {
  const W = 760, H = compact ? 168 : 300, PL = 46, PR = 14, PT = 12, PB = 24;
  const { ref, ratio } = useSvgXRatio(W);
  const model = useMemo(() => {
    const bands = quote.strip.buckets.filter((b) => b.tradeable && Number(b.quantity) > 0);
    if (bands.length === 0) return null;
    const cost = ui(quote.strip.total_cost_raw);
    const fwd = quote.forward_usd;
    const sig = quote.sigma_usd || fwd * 0.04;
    const lo = Math.max(0, Math.min(bands[0].lower_usd, fwd - 3.2 * sig));
    const hi = Math.max(bands[bands.length - 1].higher_usd, fwd + 3.2 * sig);
    const payoff = (x: number) => {
      for (const b of bands) if (x > b.lower_usd && x <= b.higher_usd) return Number(b.quantity) / 1e6;
      return 0;
    };
    const N = 180;
    const pts = Array.from({ length: N }, (_, i) => {
      const x = lo + (i / (N - 1)) * (hi - lo);
      return { x, pnl: payoff(x) - cost };
    });
    const ys = pts.map((p) => p.pnl);
    return { pts, lo, hi, fwd, yMin: Math.min(...ys, 0), yMax: Math.max(...ys, 0) };
  }, [quote]);

  if (!model) return <div className="db-payoff-empty" style={{ height: H }}>no tradeable legs</div>;
  const { pts, lo, hi, fwd, yMin, yMax } = model;
  const sx = (x: number) => PL + ((x - lo) / (hi - lo || 1)) * (W - PL - PR);
  const yPad = (yMax - yMin) * 0.12 || 1;
  const lo2 = yMin - yPad, hi2 = yMax + yPad;
  const sy = (v: number) => PT + (1 - (v - lo2) / (hi2 - lo2 || 1)) * (H - PT - PB);
  const zeroY = sy(0);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.pnl).toFixed(1)}`).join(" ");
  const area = `${line} L ${sx(hi).toFixed(1)} ${zeroY} L ${sx(lo).toFixed(1)} ${zeroY} Z`;

  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
      <defs>
        <clipPath id="db-pos"><rect x={PL} y={PT} width={W - PL - PR} height={Math.max(0, zeroY - PT)} /></clipPath>
        <clipPath id="db-neg"><rect x={PL} y={zeroY} width={W - PL - PR} height={Math.max(0, H - PB - zeroY)} /></clipPath>
      </defs>
      {[yMax, 0, yMin].map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke={C.border} strokeWidth="1" opacity={v === 0 ? 0.9 : 0.4} vectorEffect="non-scaling-stroke" />
          <text x={PL - 7} y={sy(v) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9" transform={noStretchX(PL - 7, ratio)}>{v >= 0 ? "+$" : "-$"}{Math.abs(Math.round(v)).toLocaleString()}</text>
        </g>
      ))}
      <g clipPath="url(#db-pos)"><path d={area} fill={accent} opacity={0.16} /></g>
      <g clipPath="url(#db-neg)"><path d={area} fill={C.red} opacity={0.12} /></g>
      <line x1={sx(fwd)} x2={sx(fwd)} y1={PT} y2={H - PB} stroke={C.textMuted} strokeWidth="1" strokeDasharray="3 3" opacity={0.6} />
      <text x={sx(fwd)} y={H - 7} textAnchor="middle" fill={C.textMuted} fontFamily={FM} fontSize="9" transform={noStretchX(sx(fwd), ratio)}>fwd {money(fwd)}</text>
      <path d={line} fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════
const DB_CSS = `
  .db { max-width: 1640px; margin: 0 auto; display: grid; gap: 16px; min-width: 0; }
  .db-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; }
  .db-eyebrow { font-family: ${FM}; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: ${C.teal}; }
  .db-head h1 { margin: 7px 0 0; font-family: ${FD}; font-size: 30px; font-weight: 600; letter-spacing: -0.03em; color: ${C.textPrimary}; }
  .db-head p { margin: 9px 0 0; max-width: 620px; font-family: ${FS}; font-size: 13px; line-height: 1.55; color: ${C.textSecondary}; }
  .db-tabs { display: inline-flex; gap: 3px; padding: 3px; border-radius: 10px; border: 0.5px solid ${C.border}; background: ${C.surface}; flex-shrink: 0; }
  .db-tabs button { appearance: none; border: 0; background: transparent; border-radius: 7px; padding: 9px 16px; color: ${C.textSecondary}; font-family: ${FM}; font-size: 11.5px; letter-spacing: 0.02em; cursor: pointer; transition: all 0.15s ${EASE}; }
  .db-tabs button:hover { color: ${C.textPrimary}; }
  .db-tabs button.is-on { background: ${C.card}; color: ${C.textPrimary}; box-shadow: 0 1px 0 ${C.border}; }

  .db-surface { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
  .db-card { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 15px 16px; min-width: 0; }
  .db-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .db-cap { font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.13em; text-transform: uppercase; color: ${C.textMuted}; }
  .db-dim { font-family: ${FM}; font-size: 10px; color: ${C.textMuted}; }

  .db-banner { border-radius: 10px; padding: 12px 14px; font-family: ${FM}; font-size: 12px; line-height: 1.5; }
  .db-banner.err { border: 0.5px solid ${C.red}55; background: ${C.redBg}; color: ${C.red}; }
  .db-empty { display: grid; place-items: center; min-height: 180px; font-family: ${FM}; font-size: 12px; color: ${C.textMuted}; }
  .db-skel { border-radius: 14px; background: linear-gradient(90deg, ${C.card}, ${C.surface}, ${C.card}); background-size: 200% 100%; animation: db-sk 1.4s ${EASE} infinite; }
  @keyframes db-sk { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  /* strategy / preset cards — flex with centered wrap so 7 cards never leave a
     ragged empty cell: the trailing row (3) centers under a full row of 4. */
  .db-strat-grid { display: flex; flex-wrap: wrap; gap: 11px; justify-content: center; }
  .db-strat-grid > .db-strat { flex: 1 1 220px; max-width: calc((100% - 33px) / 4); }
  @media (max-width: 1180px) { .db-strat-grid > .db-strat { max-width: calc((100% - 22px) / 3); } }
  @media (max-width: 820px) { .db-strat-grid > .db-strat { max-width: calc((100% - 11px) / 2); } }
  .db-note-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 900px) { .db-note-grid { grid-template-columns: 1fr; } }
  .db-strat { text-align: left; display: grid; gap: 7px; align-content: start; cursor: pointer; transition: all 0.15s ${EASE}; }
  .db-strat:hover { border-color: ${C.borderHover}; transform: translateY(-1px); }
  .db-strat-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .db-strat-tags { display: inline-flex; gap: 5px; }
  .db-strat b { font-family: ${FD}; font-size: 13.5px; font-weight: 600; color: ${C.textPrimary}; }
  .db-strat em { font-family: ${FS}; font-style: normal; font-size: 11px; line-height: 1.45; color: ${C.textSecondary}; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 47px; }
  .db-strat-foot { font-family: ${FM}; font-size: 9.5px; color: ${C.textMuted}; text-transform: capitalize; letter-spacing: 0.02em; }
  .db-tag { font-family: ${FM}; font-size: 8.5px; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 5px; border: 0.5px solid; white-space: nowrap; }

  .db-note-stats { display: flex; gap: 14px; flex-wrap: wrap; padding-top: 9px; border-top: 0.5px solid ${C.border}; }
  .db-note-stats span { font-family: ${FM}; font-size: 9.5px; color: ${C.textMuted}; letter-spacing: 0.04em; }
  .db-note-stats b { font-family: ${FD}; font-size: 12px; font-weight: 600; color: ${C.textPrimary}; margin-left: 4px; }

  /* controls — flexible columns aligned to a shared bottom baseline; the segmented
     Expiry control stretches to fill its column instead of floating/overflowing. */
  /* controls: text (left) · expiry options (middle, widest) · order box (right) */
  .db-controls { display: grid; grid-template-columns: minmax(190px, 1fr) minmax(0, 1.9fr) minmax(238px, 268px); gap: 24px; align-items: start; min-width: 0; }
  @media (max-width: 980px) { .db-controls { grid-template-columns: 1fr; } }
  .db-amount, .db-expiry, .db-tenor { display: grid; gap: 8px; min-width: 0; }
  .db-amount-in { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 7px; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 10px; padding: 8px 10px 8px 12px; }
  .db-amount-cur { font-family: ${FD}; font-size: 18px; font-weight: 600; color: ${C.textMuted}; line-height: 1; }
  .db-num { min-width: 0; width: 100%; background: transparent; border: none; outline: none; color: ${C.textPrimary}; font-family: ${FD}; font-size: 21px; font-weight: 600; padding: 0; }
  .db-seg { display: flex; width: 100%; gap: 2px; padding: 3px; border-radius: 9px; border: 0.5px solid ${C.border}; background: ${C.surface}; }
  /* individual-expiry strip (advanced): one compact chip per live oracle, horizontally scrollable so 19 tenors never overlap */
  .db-strike-strip { display: flex; gap: 5px; min-width: 0; overflow-x: auto; overflow-y: hidden; padding-bottom: 5px; scrollbar-width: thin; }
  .db-strike-strip::-webkit-scrollbar { height: 5px; }
  .db-strike-strip::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 999px; }
  .db-strike { flex: 0 0 auto; appearance: none; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; height: 32px; padding: 0 12px; color: ${C.textMuted}; font-family: ${FM}; font-size: 11px; font-weight: 560; white-space: nowrap; cursor: pointer; transition: all 0.13s ${EASE}; }
  .db-strike:hover { color: ${C.textSecondary}; border-color: ${C.borderHover}; }
  .db-strike.is-on { background: ${C.tealBg}; border-color: ${C.tealLight}; color: ${C.tealLight}; }
  .db-seg button { flex: 1; appearance: none; border: 0; background: transparent; border-radius: 6px; padding: 8px 10px; color: ${C.textMuted}; font-family: ${FM}; font-size: 10.5px; cursor: pointer; transition: all 0.14s ${EASE}; text-transform: capitalize; }
  .db-seg button:hover { color: ${C.textSecondary}; }
  .db-seg button.is-on { background: ${C.card}; color: ${C.textPrimary}; }
  .db-controls-meta { display: grid; gap: 4px; align-content: center; min-width: 0; }
  .db-controls-meta strong { font-family: ${FD}; font-size: 17px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .db-controls-thesis { font-family: ${FS}; font-size: 11.5px; line-height: 1.45; color: ${C.textSecondary}; }
  .db-range { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 4px; background: ${C.border}; outline: none; }
  .db-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 50%; background: ${C.tealLight}; cursor: pointer; border: none; }
  .db-range::-moz-range-thumb { width: 15px; height: 15px; border-radius: 50%; background: ${C.tealLight}; cursor: pointer; border: none; }

  /* quote layouts */
  /* chart-first layouts — payoff is the full-width hero, supporting cards below/beside */
  .db-basic, .db-adv { display: grid; gap: 14px; min-width: 0; }
  .db-quote-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(300px, 1fr); gap: 14px; align-items: stretch; }
  .db-adv-top { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(320px, 0.95fr); gap: 14px; align-items: start; }
  @media (max-width: 1000px) { .db-quote-row, .db-adv-top { grid-template-columns: 1fr; } }
  .db-side { display: grid; gap: 14px; min-width: 0; align-content: start; }
  .db-deploy-card { display: grid; gap: 0; align-content: start; }

  .db-quote-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(310px, 0.95fr); gap: 14px; align-items: start; }
  .db-adv-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(320px, 0.92fr); gap: 14px; align-items: start; }
  @media (max-width: 1100px) { .db-quote-grid, .db-adv-grid { grid-template-columns: 1fr; } }

  .db-payoff p.db-risk { margin: 10px 0 0; font-family: ${FS}; font-size: 11px; line-height: 1.5; color: ${C.textMuted}; }
  .db-payoff-empty { display: grid; place-items: center; font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }

  .db-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; }
  .db-metric { background: ${C.card}; padding: 11px 13px; display: grid; gap: 4px; }
  .db-metric-k { font-family: ${FM}; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; display: flex; align-items: baseline; gap: 6px; }
  .db-metric-k i { font-style: normal; font-size: 8.5px; opacity: 0.7; }
  .db-metric strong { font-family: ${FD}; font-size: 16px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }

  .db-cta { width: 100%; height: 44px; border: none; border-radius: 11px; color: #04121d; font-family: ${FD}; font-size: 13.5px; font-weight: 600; cursor: pointer; transition: transform 0.15s ${EASE}, opacity 0.15s ${EASE}; }
  .db-cta:hover:not(:disabled) { transform: translateY(-1px); }
  .db-cta:disabled { opacity: 0.5; cursor: not-allowed; }
  .db-note { margin: 11px 0 0; font-family: ${FS}; font-size: 10.5px; line-height: 1.5; color: ${C.textMuted}; }

  /* advanced book table */
  .db-book-table { border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; }
  .db-brow { display: grid; grid-template-columns: minmax(0, 1.7fr) 0.8fr 1fr 1fr 1fr 1fr; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 0.5px solid ${C.border}; font-family: ${FM}; font-size: 11px; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .db-brow:last-child { border-bottom: 0; }
  .db-brow span:not(.db-band) { text-align: right; }
  .db-band { color: ${C.textSecondary}; }
  .db-brow.is-dim { opacity: 0.4; }
  .db-brow-h { background: ${C.surface}; font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; }
  .db-brow-tot { background: ${C.surface}; font-weight: 600; }
  .db-brow-tot .db-band { color: ${C.textPrimary}; }
  .db-slip { color: ${C.textMuted}; }

  .db-rh { background: ${C.card}; padding: 9px 12px; display: grid; gap: 3px; }
  .db-rh span { font-family: ${FM}; font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; }
  .db-rh strong { font-family: ${FD}; font-size: 12px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .db-greeks { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .db-greek { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 10px; padding: 10px 12px; display: grid; gap: 5px; }
  .db-greek-k { font-family: ${FM}; font-size: 11px; color: ${C.textSecondary}; display: flex; align-items: baseline; gap: 5px; }
  .db-greek-k i { font-style: normal; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.05em; color: ${C.textMuted}; }
  .db-greek strong { font-family: ${FD}; font-size: 16px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .db-greek strong em { font-family: ${FM}; font-size: 9px; font-style: normal; color: ${C.textMuted}; margin-left: 3px; }
  .db-greek-foot { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; margin-top: 10px; }

  /* notes narrative */
  .db-narrative { display: grid; gap: 11px; }
  .db-flow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .db-flow-step { display: inline-flex; align-items: center; gap: 7px; font-family: ${FM}; font-size: 11px; color: ${C.textSecondary}; }
  .db-flow-step i { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
  .db-flow-arr { font-family: ${FM}; font-size: 13px; color: ${C.textMuted}; }

  /* basic note projected */
  .db-proj { display: grid; gap: 14px; }
  .db-proj-row { display: grid; gap: 6px; }
  .db-proj-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .db-proj-label { font-family: ${FM}; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: ${C.textMuted}; }
  .db-proj-val { font-family: ${FD}; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .db-proj-val i { font-family: ${FM}; font-size: 10px; font-style: normal; color: ${C.textMuted}; margin-left: 8px; }
  .db-proj-track { height: 8px; border-radius: 5px; background: ${C.surface}; overflow: hidden; }
  .db-proj-track span { display: block; height: 100%; border-radius: 5px; transition: width 0.3s ${EASE}; }

  .db-sleeve { display: grid; gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; }
  .db-sleeve-row { background: ${C.card}; display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: baseline; padding: 10px 13px; }
  .db-sleeve-pool { font-family: ${FD}; font-size: 13px; font-weight: 600; color: ${C.textPrimary}; }
  .db-sleeve-apy { font-family: ${FM}; font-size: 12px; font-variant-numeric: tabular-nums; }
  .db-sleeve-alloc { font-family: ${FD}; font-size: 13px; color: ${C.textSecondary}; font-variant-numeric: tabular-nums; }

  /* advanced sleeve table */
  .db-sleeve-table { border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; }
  .db-srow { display: grid; grid-template-columns: minmax(0, 1.4fr) 0.9fr 1.1fr 0.7fr 1.2fr; gap: 8px; align-items: center; padding: 9px 13px; border-bottom: 0.5px solid ${C.border}; font-family: ${FM}; font-size: 11.5px; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .db-srow:last-child { border-bottom: 0; }
  .db-srow span:not(.db-band) { text-align: right; }
  .db-srow-h { background: ${C.surface}; font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; }
  .db-srow-tot { background: ${C.surface}; font-weight: 600; }

  .db-deployed { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; }
  .db-dstat { background: ${C.card}; padding: 10px 13px; display: grid; gap: 4px; }
  .db-dstat span { font-family: ${FM}; font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; }
  .db-dstat strong { font-family: ${FD}; font-size: 14px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }

  .db-srcs { margin-top: 13px; display: grid; gap: 8px; }
  .db-src-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .db-chip { font-family: ${FM}; font-size: 9.5px; color: ${C.textSecondary}; padding: 4px 8px; border-radius: 6px; border: 0.5px solid ${C.border}; background: ${C.surface}; }

  .db-alloc-bar { display: flex; gap: 2px; height: 12px; border-radius: 6px; overflow: hidden; }
  .db-alloc-bar span { display: block; height: 100%; }
  .db-alloc-key { display: flex; justify-content: space-between; gap: 12px; margin-top: 11px; flex-wrap: wrap; }
  .db-alloc-key span { display: inline-flex; align-items: center; gap: 6px; font-family: ${FM}; font-size: 10px; color: ${C.textMuted}; }
  .db-alloc-key i { width: 7px; height: 7px; border-radius: 2px; flex: 0 0 auto; }
  .db-alloc-key b { font-family: ${FD}; color: ${C.textPrimary}; font-weight: 600; margin-left: 2px; }
`;
