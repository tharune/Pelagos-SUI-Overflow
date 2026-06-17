"use client";

// ---------------------------------------------------------------------------
// Volatility desk — trade BTC implied-vs-realized vol like an equity-derivatives
// desk, kept deliberately minimal (one ticket, one accent). Long vol = a barbell
// strip (long gamma, pays on big moves); short vol = a pin strip (short gamma,
// pays if BTC stays). The vol leg is a real DeepBook Predict strip (devInspect-
// priced, wallet-minted). Position Greeks are live; the position is delta-neutral
// at entry, so the hedge panel shows the gamma drift you'd re-hedge on a BTC perp
// — mark live from a Sui venue (DeepBook / Bluefin / Pyth), routing simulated.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { friendlyWalletError } from "../_lib/chain";
import { useWalletSigner } from "../_lib/wallet-bridge";
import { ConnectModal } from "@mysten/dapp-kit";
import { ResultLine, Cap, StripStyles, openableBuckets, dollars } from "../_components/strip-products";
import {
  fetchVolDeskSurface,
  volQuote,
  ensureManager,
  prepareVolOpen,
  confirmPredict,
  usd,
  type VolQuote,
  type VolDeskSurface,
} from "../_lib/predict-strip-client";

type Side = "long" | "short";
const sideColor = (s: Side) => (s === "long" ? C.green : C.violet);
const money = (v: number, d = 2) => `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;

export default function VolatilityPage() {
  const wallet = useWalletSigner();
  const [side, setSide] = useState<Side>("long");
  const [notional, setNotional] = useState("100");
  const [surface, setSurface] = useState<VolDeskSurface | null>(null);
  const [q, setQ] = useState<VolQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hedged, setHedged] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const notionalNum = Number(notional);
  const valid = Number.isFinite(notionalNum) && notionalNum > 0;
  const accent = sideColor(side);

  useEffect(() => {
    let alive = true;
    fetchVolDeskSurface().then((s) => { if (alive) setSurface(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Price the vol position (debounced) + poll every 6s so the mark/Greeks stay live.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    setLoading(true);
    const run = () =>
      volQuote({ side, notional_usd: notionalNum, sender: wallet.address ?? undefined })
        .then((r) => { if (alive) { setQ(r); setErr(null); } })
        .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (alive) setLoading(false); });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, 250);
    const poll = window.setInterval(run, 6000);
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); window.clearInterval(poll); };
  }, [side, notionalNum, valid, wallet.address]);

  useEffect(() => { setHedged(null); }, [side, notionalNum]);

  const g = q?.greeks ?? null;
  const tradeable = q ? q.strip.buckets.filter((b) => b.tradeable).length : 0;

  // The position is delta-neutral at entry; gamma is what generates delta as BTC
  // moves. Show the delta drift per ±1% move — that's the perp re-hedge (the scalp).
  const gammaDeltaPer1pct = q && g ? g.gamma * q.forward_usd * 0.01 : 0;
  const rehedgeBtc = Math.abs(gammaDeltaPer1pct);

  async function openPosition() {
    if (!q || busy) return;
    setBusy(true); setOpenErr(null); setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const buckets = openableBuckets(q.strip.buckets);
      if (buckets.length === 0) throw new Error("No tradeable bands in this vol leg right now.");
      setStage("Building position…");
      const deposit = ((BigInt(q.strip.total_cost_raw) * 12n) / 10n).toString();
      const prep = await prepareVolOpen({ owner: wallet.address as string, manager_id: mgr, oracle_id: q.oracle_id, expiry: q.expiry, buckets, deposit_amount_raw: deposit });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult(c.digest);
    } catch (e) { setOpenErr(friendlyWalletError(e)); }
    finally { setBusy(false); setStage(null); }
  }

  function routeHedge() {
    if (!q) return;
    const dir = side === "long" ? "short" : "long"; // long gamma → short the up-drift to stay neutral
    setHedged(`${dir.toUpperCase()} ${rehedgeBtc.toFixed(4)} BTC-PERP @ ${dollars(q.mark.mark)} · simulated fill`);
  }

  const ivPct = q ? (q.atm_iv * 100).toFixed(1) : surface ? ((surface.term_structure[0]?.atm_iv ?? 0) * 100).toFixed(1) : "—";
  const rvPct = surface ? (surface.realized_vol * 100).toFixed(1) : "—";
  const vrp = surface ? surface.vol_risk_premium * 100 : 0;
  const onSui = q?.mark.chain === "sui";

  return (
    <>
      <Header />
      <PageFrame>
        <div className="vol-shell">
          {/* hero */}
          <div className="vol-hero">
            <div className="vol-eyebrow">Volatility desk · DeepBook Predict × Sui perps</div>
            <h1>Trade BTC volatility</h1>
            <p>Go long or short BTC vol, then delta-hedge the gamma drift on a BTC perp — the equity-derivatives-desk workflow, on Sui.</p>
          </div>

          {/* market strip */}
          <div className="vol-market">
            <Stat label="Implied vol" value={`${ivPct}%`} hint={q ? `${q.tenor_label} tenor` : "front tenor"} />
            <Stat label="Realized vol" value={`${rvPct}%`} hint={surface ? `${surface.rv_window_hours}h trailing` : "trailing"} />
            <Stat label="Vol premium" value={`${vrp >= 0 ? "+" : ""}${vrp.toFixed(1)}%`} hint="implied − realized" color={vrp >= 0 ? C.green : C.red} />
            <Stat label="BTC mark" value={q ? dollars(q.mark.mark) : "—"} hint={q ? q.mark.venue : "Sui venue"} dot={onSui} />
          </div>

          {err && <div className="vol-err">{err}</div>}

          {/* the ticket */}
          <div className="vol-ticket">
            {/* side toggle */}
            <div className="vol-side">
              {(["long", "short"] as Side[]).map((s) => (
                <button key={s} type="button" className={`vol-side-btn${side === s ? " is-active" : ""}`} data-side={s} onClick={() => setSide(s)}>
                  <b>{s === "long" ? "Long vol" : "Short vol"}</b>
                  <em>{s === "long" ? "pays on big moves · long gamma" : "pays if BTC stays · short gamma"}</em>
                </button>
              ))}
            </div>

            {/* notional + horizon */}
            <div className="vol-input-row">
              <div className="vol-amount">
                <Cap>Notional</Cap>
                <div className="vol-amount-in">
                  <input className="vol-num" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
                  <span>dUSDC</span>
                </div>
              </div>
              <div className="vol-horizon">
                <Cap>Horizon</Cap>
                <div className="vol-horizon-v">{q ? q.tenor_label : "—"}<span>· {tradeable} strikes</span></div>
              </div>
            </div>

            {/* payoff shape — the one data-viz */}
            <PayoffShape quote={q} accent={accent} />

            {/* results */}
            <div className="vol-results">
              <Row k="Entry cost" v={q ? usd(q.strip.total_cost_raw) : "—"} />
              <Row k="Max payout" v={q ? usd(q.strip.realized_max_payout_raw) : "—"} color={C.tealLight} />
              <Row k="Max loss" v={q ? money(q.max_loss_usd) : "—"} hint="premium paid" />
            </div>

            {/* greeks — compact inline */}
            <div className="vol-greeks">
              <GreekCell label="Δ" name="Delta" value={g ? `${g.delta_btc >= 0 ? "+" : ""}${g.delta_btc.toFixed(4)}` : "—"} />
              <GreekCell label="Γ" name="Gamma" value={g ? g.gamma.toFixed(5) : "—"} color={g ? (g.gamma >= 0 ? C.green : C.red) : undefined} />
              <GreekCell label="ν" name="Vega /pt" value={g ? `${g.vega_usd >= 0 ? "+" : ""}${money(g.vega_usd)}` : "—"} color={g ? (g.vega_usd >= 0 ? C.green : C.red) : undefined} />
              <GreekCell label="Θ" name="Theta /day" value={g ? `${g.theta_usd_day >= 0 ? "+" : ""}${money(g.theta_usd_day)}` : "—"} color={g ? (g.theta_usd_day >= 0 ? C.green : C.red) : undefined} />
            </div>
          </div>

          {/* delta / gamma hedge */}
          <div className="vol-ticket vol-hedge">
            <div className="vol-card-head">
              <Cap>Delta hedge · BTC perp</Cap>
              <span className="vol-venue">{q ? q.mark.venue : "—"}{onSui && <i className="vol-onchain">live on Sui</i>}</span>
            </div>
            <div className="vol-hedge-rows">
              <Row k="Net delta now" v={g ? `${g.delta_btc >= 0 ? "+" : ""}${g.delta_btc.toFixed(4)} BTC` : "—"} hint="delta-neutral at entry" />
              <Row k="Per ±1% BTC move" v={q ? `±${rehedgeBtc.toFixed(4)} BTC` : "—"} hint="gamma drift to re-hedge" color={accent} />
              <Row k="BTC-PERP mark" v={q ? dollars(q.mark.mark) : "—"} />
              <Row k="Funding (8h)" v={q ? `${(q.hedge.funding_rate * 100).toFixed(3)}%` : "—"} hint={q?.mark.funding_source === "bluefin" ? "Bluefin" : "est."} />
            </div>
            <button className="vol-hedge-btn" disabled={!q || Boolean(hedged)} onClick={routeHedge}>
              {hedged ? "✓ Hedge routed" : "Route gamma re-hedge on Bluefin"}
            </button>
            {hedged && <div className="vol-sim">✓ {hedged}</div>}
            <p className="vol-note">
              The vol leg mints on DeepBook Predict — real, on-chain. The BTC mark is live from {q?.mark.venue ?? "a Sui venue"}; perp order routing is simulated on testnet.
            </p>
          </div>

          {/* open */}
          <div className="vol-ticket vol-open">
            {!wallet.connected ? (
              <ConnectModal trigger={<button className="vol-open-btn">Connect a wallet to open</button>} />
            ) : (
              <button className="vol-open-btn" disabled={busy || !q || tradeable === 0} onClick={openPosition} style={{ background: accent }}>
                {busy ? (stage ?? "Submitting…") : `Open ${side} vol · ${q ? usd(q.strip.total_cost_raw) : ""}`}
              </button>
            )}
            {result && <ResultLine digest={result} label={`${side} vol opened`} />}
            {openErr && <div className="vol-err" style={{ marginTop: 10 }}>{openErr}</div>}
          </div>
        </div>
      </PageFrame>
      <StripStyles />
      <style jsx global>{VOL_CSS}</style>
    </>
  );
}

function Stat({ label, value, hint, color, dot }: { label: string; value: string; hint: string; color?: string; dot?: boolean }) {
  return (
    <div className="vol-stat">
      <span className="vol-stat-label">{label}</span>
      <strong style={color ? { color } : undefined}>{value}</strong>
      <span className="vol-stat-hint">{dot && <i className="vol-stat-dot" />}{hint}</span>
    </div>
  );
}

function GreekCell({ label, name, value, color }: { label: string; name: string; value: string; color?: string }) {
  return (
    <div className="vol-greek">
      <span className="vol-greek-sym">{label}<i>{name}</i></span>
      <strong style={color ? { color } : undefined}>{value}</strong>
    </div>
  );
}

function Row({ k, v, color, hint }: { k: string; v: string; color?: string; hint?: string }) {
  return (
    <div className="vol-row">
      <span>{k}{hint && <i>{hint}</i>}</span>
      <strong style={color ? { color } : undefined}>{v}</strong>
    </div>
  );
}

/** Payoff-shape bars: one per tradeable band, height ∝ contracts. Barbell (long
 *  vol) is wings-heavy; pin (short vol) is center-heavy. */
function PayoffShape({ quote, accent }: { quote: VolQuote | null; accent: string }) {
  const bands = quote?.strip.buckets ?? [];
  const maxQ = useMemo(() => Math.max(...bands.map((b) => (b.tradeable ? Number(b.quantity) : 0)), 1), [bands]);
  if (!quote) return <div className="vol-shape vol-shape-empty">pricing…</div>;
  const fwd = quote.forward_usd;
  return (
    <div className="vol-shape">
      <div className="vol-shape-cap">{quote.side === "long" ? "Long gamma — wings pay on a big move" : "Short gamma — center pays if BTC pins"}</div>
      <div className="vol-shape-bars">
        {bands.map((b, i) => {
          const live = b.tradeable && Number(b.quantity) > 0;
          const h = live ? (Number(b.quantity) / maxQ) * 100 : 2;
          return <div key={i} className="vol-bar" style={{ height: `${Math.max(h, 3)}%`, background: live ? accent : `${C.textMuted}33`, opacity: live ? 0.9 : 0.4 }} title={`${dollars(b.lower_usd)}–${dollars(b.higher_usd)}`} />;
        })}
      </div>
      <div className="vol-shape-axis">
        <span>{dollars(bands[0]?.lower_usd ?? fwd)}</span>
        <span className="vol-shape-fwd">forward {dollars(fwd)}</span>
        <span>{dollars(bands[bands.length - 1]?.higher_usd ?? fwd)}</span>
      </div>
    </div>
  );
}

const VOL_CSS = `
  .vol-shell { max-width: 600px; margin: 0 auto; display: grid; gap: 16px; }
  .vol-hero { text-align: center; margin-bottom: 2px; }
  .vol-hero h1 { margin: 8px 0 0; font-family: ${FD}; font-size: 30px; font-weight: 600; letter-spacing: -0.03em; color: ${C.textPrimary}; }
  .vol-hero p { margin: 9px auto 0; max-width: 520px; font-family: ${FS}; font-size: 13.5px; line-height: 1.6; color: ${C.textSecondary}; }
  .vol-eyebrow { font-family: ${FM}; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: ${C.teal}; }

  .vol-market { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 12px; overflow: hidden; }
  .vol-stat { background: ${C.card}; padding: 12px 14px; display: grid; gap: 3px; }
  .vol-stat-label { font-family: ${FM}; font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase; color: ${C.textMuted}; }
  .vol-stat strong { font-family: ${FD}; font-size: 17px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .vol-stat-hint { font-family: ${FM}; font-size: 9.5px; color: ${C.textMuted}; display: flex; align-items: center; gap: 4px; }
  .vol-stat-dot { width: 5px; height: 5px; border-radius: 50%; background: ${C.green}; box-shadow: 0 0 6px ${C.green}; flex-shrink: 0; }

  .vol-err { border: 0.5px solid ${C.red}55; background: ${C.redBg}; border-radius: 10px; padding: 11px 14px; font-family: ${FM}; font-size: 12px; color: ${C.red}; }

  .vol-ticket { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 16px; padding: 18px; display: grid; gap: 16px; }
  .vol-card-head { display: flex; justify-content: space-between; align-items: baseline; }
  .vol-venue { font-family: ${FM}; font-size: 10px; color: ${C.textMuted}; display: inline-flex; align-items: center; gap: 7px; }
  .vol-onchain { font-style: normal; font-size: 8.5px; letter-spacing: 0.06em; text-transform: uppercase; color: ${C.green}; border: 0.5px solid ${C.green}55; border-radius: 5px; padding: 1px 5px; }

  .vol-side { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .vol-side-btn { display: grid; gap: 3px; padding: 12px 14px; border-radius: 12px; border: 0.5px solid ${C.border}; background: ${C.surface}; color: ${C.textSecondary}; cursor: pointer; transition: all 0.16s ${EASE}; text-align: left; }
  .vol-side-btn b { font-family: ${FD}; font-size: 14px; font-weight: 600; }
  .vol-side-btn em { font-family: ${FM}; font-size: 9.5px; font-style: normal; font-weight: 400; color: ${C.textMuted}; }
  .vol-side-btn:hover { border-color: ${C.borderHover}; }
  .vol-side-btn[data-side="long"].is-active { border-color: ${C.green}; background: ${C.green}14; color: ${C.green}; }
  .vol-side-btn[data-side="short"].is-active { border-color: ${C.violet}; background: ${C.violet}1c; color: ${C.violet}; }
  .vol-side-btn.is-active em { color: inherit; opacity: 0.8; }

  .vol-input-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: stretch; }
  .vol-amount, .vol-horizon { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 12px; padding: 11px 14px; display: grid; gap: 6px; }
  .vol-horizon { text-align: right; min-width: 120px; }
  .vol-amount-in { display: flex; align-items: baseline; gap: 8px; }
  .vol-num { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: ${C.textPrimary}; font-family: ${FD}; font-size: 22px; font-weight: 600; padding: 0; }
  .vol-amount-in span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }
  .vol-horizon-v { font-family: ${FD}; font-size: 18px; font-weight: 600; color: ${C.textPrimary}; }
  .vol-horizon-v span { font-family: ${FM}; font-size: 10px; font-weight: 400; color: ${C.textMuted}; margin-left: 4px; }

  .vol-shape { display: grid; gap: 8px; }
  .vol-shape-empty { min-height: 132px; place-items: center; color: ${C.textMuted}; font-family: ${FM}; font-size: 11px; }
  .vol-shape-cap { font-family: ${FM}; font-size: 10px; color: ${C.textMuted}; text-align: center; letter-spacing: 0.02em; }
  .vol-shape-bars { display: flex; align-items: flex-end; gap: 4px; height: 116px; padding: 10px; border: 0.5px solid ${C.border}; border-radius: 12px; background: ${C.surface}; }
  .vol-bar { flex: 1; border-radius: 4px 4px 2px 2px; min-width: 0; transition: height 0.3s ${EASE}, background 0.3s ${EASE}; }
  .vol-shape-axis { display: flex; justify-content: space-between; font-family: ${FM}; font-size: 9.5px; color: ${C.textMuted}; }
  .vol-shape-fwd { color: ${C.tealLight}; }

  .vol-results, .vol-hedge-rows { display: grid; gap: 10px; }
  .vol-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .vol-row span { font-family: ${FM}; font-size: 11.5px; color: ${C.textSecondary}; display: flex; align-items: baseline; gap: 7px; }
  .vol-row span i { font-style: normal; font-size: 9.5px; color: ${C.textMuted}; }
  .vol-row strong { font-family: ${FD}; font-size: 14px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }

  .vol-greeks { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding-top: 4px; border-top: 0.5px solid ${C.border}; }
  .vol-greek { display: grid; gap: 5px; padding-top: 12px; }
  .vol-greek-sym { font-family: ${FM}; font-size: 11px; color: ${C.textSecondary}; display: flex; align-items: baseline; gap: 5px; }
  .vol-greek-sym i { font-style: normal; font-size: 8.5px; letter-spacing: 0.05em; text-transform: uppercase; color: ${C.textMuted}; }
  .vol-greek strong { font-family: ${FD}; font-size: 15px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }

  .vol-hedge-btn { width: 100%; height: 42px; border: 0.5px solid ${C.tealLight}55; border-radius: 11px; background: ${C.tealBg}; color: ${C.tealLight}; font-family: ${FD}; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.16s ${EASE}; }
  .vol-hedge-btn:hover:not(:disabled) { border-color: ${C.tealLight}; }
  .vol-hedge-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .vol-sim { font-family: ${FM}; font-size: 11px; color: ${C.green}; }
  .vol-note { margin: 0; font-family: ${FS}; font-size: 11px; color: ${C.textMuted}; line-height: 1.55; }

  .vol-open { padding: 16px 18px; }
  .vol-open-btn { width: 100%; height: 48px; border: none; border-radius: 13px; background: ${C.tealLight}; color: #04121d; font-family: ${FD}; font-size: 14.5px; font-weight: 600; cursor: pointer; transition: opacity 0.16s ${EASE}, transform 0.16s ${EASE}; }
  .vol-open-btn:hover:not(:disabled) { transform: translateY(-1px); }
  .vol-open-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 640px) {
    .vol-market { grid-template-columns: repeat(2, 1fr); }
    .vol-input-row { grid-template-columns: 1fr; }
  }
`;
