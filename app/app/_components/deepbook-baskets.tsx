"use client";

// ---------------------------------------------------------------------------
// BTC Term Baskets — calendar bundles across DeepBook Predict expiries. One
// ticket holds a central strip on each of several live tenors, so you own a
// slice of the whole BTC term structure (distinct from Distribution, which
// trades a single expiry's curve). Master-detail: pick a basket shape, read its
// composition (the legs across the term structure), open it in one signature.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { friendlyWalletError } from "../_lib/chain";
import { useWalletSigner } from "../_lib/wallet-bridge";
import {
  listTermBaskets,
  termBasketQuote,
  ensureManager,
  prepareTermBasketOpen,
  confirmPredict,
  usd,
  type TermBasketQuote,
} from "../_lib/predict-strip-client";
import { OpenButton, ResultLine, Cap, openableBuckets, StripStyles } from "./strip-products";

const ACCENT: Record<string, string> = { "near-ladder": "#7de7ff", barbell: "#4da2ff", "full-term": "#8b5cf6" };

export function DeepBookBaskets() {
  const wallet = useWalletSigner();
  const [baskets, setBaskets] = useState<Array<{ id: string; name: string; description: string }> | null>(null);
  const [selected, setSelected] = useState<string>("near-ladder");
  const [budget, setBudget] = useState("150");
  const [quote, setQuote] = useState<TermBasketQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const budgetNum = Number(budget);
  const valid = Number.isFinite(budgetNum) && budgetNum > 0;

  useEffect(() => {
    listTermBaskets().then((b) => { setBaskets(b); if (b[0]) setSelected((s) => (b.some((x) => x.id === s) ? s : b[0].id)); }).catch(() => setBaskets([]));
  }, []);

  // Price the selected basket whenever it / the budget changes (debounced).
  useEffect(() => {
    if (!selected || !valid) return;
    let alive = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      termBasketQuote({ asset: "BTC", basket_id: selected, budget_usd: budgetNum, sender: wallet.address ?? undefined })
        .then((q) => { if (alive) { setQuote(q); setErr(null); } })
        .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (alive) setLoading(false); });
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [selected, budgetNum, valid, wallet.address]);

  const meta = useMemo(() => baskets?.find((b) => b.id === selected) ?? null, [baskets, selected]);
  const maxWeight = quote ? Math.max(...quote.legs.map((l) => l.weight), 0.01) : 1;

  async function open() {
    if (!quote || busy) return;
    setBusy(true); setOpenErr(null); setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const legs = quote.legs
        .map((l) => ({ oracleId: l.oracle_id, expiry: l.expiry, buckets: openableBuckets(l.strip.buckets) }))
        .filter((l) => l.buckets.length > 0);
      if (legs.length === 0) throw new Error("No tradeable legs in this basket right now.");
      setStage("Building basket…");
      const deposit = ((BigInt(quote.total_cost_raw) * 12n) / 10n).toString();
      const prep = await prepareTermBasketOpen({ owner: wallet.address as string, manager_id: mgr, legs, deposit_amount_raw: deposit });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult(c.digest);
    } catch (e) { setOpenErr(friendlyWalletError(e)); }
    finally { setBusy(false); setStage(null); }
  }

  return (
    <div className="tb-wrap">
      <div className="tb-grid">
        {/* left: basket shapes */}
        <div className="tb-presets">
          {baskets === null ? (
            <div className="tb-skel" />
          ) : (
            baskets.map((b) => {
              const on = b.id === selected;
              const accent = ACCENT[b.id] ?? C.teal;
              return (
                <button key={b.id} className={`tb-preset${on ? " is-active" : ""}`} style={on ? { borderColor: `${accent}88`, boxShadow: `inset 2px 0 0 ${accent}` } : undefined} onClick={() => setSelected(b.id)}>
                  <span style={{ color: accent }}>{b.name}</span>
                  <p>{b.description}</p>
                </button>
              );
            })
          )}
        </div>

        {/* right: composition */}
        <div className="tb-detail">
          <div className="tb-detail-head">
            <div>
              <Cap>{meta?.name ?? "Term basket"} · composition</Cap>
              <div className="tb-sub">{quote ? `${quote.legs.length} legs across the BTC term structure` : "calendar bundle across live expiries"}</div>
            </div>
            <div className="tb-budget">
              <Cap style={{ marginBottom: 5 }}>Budget (dUSDC)</Cap>
              <input className="tb-num" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
          </div>

          {err && <div className="tb-warn">{err}</div>}

          {quote ? (
            <>
              <div className="tb-legs">
                <div className="tb-leg tb-leg-head"><span>Expiry</span><span>Weight</span><span>Cost</span><span>Best case</span></div>
                {quote.legs.map((l) => {
                  const cost = Number(l.strip.total_cost_raw) / 1e6;
                  const best = Number(l.strip.realized_max_payout_raw) / 1e6;
                  const accent = ACCENT[selected] ?? C.teal;
                  return (
                    <div className="tb-leg" key={l.oracle_id}>
                      <span className="tb-leg-tenor">
                        <span className="tb-leg-bar" style={{ width: `${(l.weight / maxWeight) * 100}%`, background: `${accent}33`, borderLeft: `2px solid ${accent}` }} />
                        <b>{l.tenor_label}</b>
                      </span>
                      <span>{(l.weight * 100).toFixed(0)}%</span>
                      <span>${cost.toFixed(2)}</span>
                      <span style={{ color: best >= cost ? C.green : C.textSecondary }}>${best.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>

              <div className="tb-totals">
                <div><Cap>Total cost</Cap><strong>{usd(quote.total_cost_raw)}</strong></div>
                <div><Cap>Best case</Cap><strong style={{ color: C.tealLight }}>{usd(quote.total_best_raw)}</strong></div>
                <div><Cap>Round-trip spread</Cap><strong style={{ color: C.amber }}>{usd(quote.round_trip_spread_raw)}</strong></div>
              </div>

              <div style={{ marginTop: 16 }}>
                <OpenButton wallet={wallet} busy={busy} disabled={!quote} label={`Open ${meta?.name ?? "basket"} · ${usd(quote.total_cost_raw)}`} busyLabel={stage ?? "Submitting…"} onOpen={open} />
                {result && <ResultLine digest={result} label={`${meta?.name ?? "Basket"} opened`} />}
                {openErr && <div className="tb-warn" style={{ marginTop: 12 }}>{openErr}</div>}
              </div>
            </>
          ) : (
            <div className="tb-empty">{loading ? "Pricing the term basket…" : "Select a basket shape."}</div>
          )}
        </div>
      </div>

      <style jsx global>{`
        .tb-wrap { display: grid; gap: 14px; min-width: 0; }
        .tb-grid { display: grid; grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr); gap: 16px; align-items: stretch; }
        @media (max-width: 980px) { .tb-grid { grid-template-columns: 1fr; } }
        .tb-presets { display: grid; gap: 12px; grid-auto-rows: 1fr; }
        .tb-preset { display: flex; flex-direction: column; gap: 6px; text-align: left; border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 12px; padding: 16px; cursor: pointer; transition: border-color 0.14s ${EASE}, background 0.14s ${EASE}, transform 0.14s ${EASE}; }
        .tb-preset:hover { border-color: ${C.borderHover}; background: ${C.cardHover}; transform: translateY(-2px); }
        .tb-preset span { font-family: ${FD}; font-size: 15px; font-weight: 600; }
        .tb-preset p { margin: 0; font-family: ${FS}; font-size: 12px; color: ${C.textSecondary}; line-height: 1.45; }
        .tb-detail { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 18px 20px; min-width: 0; display: flex; flex-direction: column; }
        .tb-detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
        .tb-sub { font-family: ${FS}; font-size: 12.5px; color: ${C.textSecondary}; margin-top: 6px; }
        .tb-budget { text-align: right; }
        .tb-num { width: 120px; box-sizing: border-box; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 8px; padding: 9px 12px; color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; outline: none; text-align: right; }
        .tb-num:focus { border-color: ${C.tealLight}; }
        .tb-legs { border: 0.5px solid ${C.border}; border-radius: 10px; overflow: hidden; }
        .tb-leg { display: grid; grid-template-columns: minmax(0,1.5fr) 64px 1fr 1fr; gap: 10px; align-items: center; padding: 11px 13px; border-bottom: 0.5px solid ${C.border}; font-family: ${FM}; font-size: 12px; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
        .tb-leg:last-child { border-bottom: 0; }
        .tb-leg span:not(.tb-leg-tenor) { text-align: right; }
        .tb-leg-head { background: ${C.surface}; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.textMuted}; }
        .tb-leg-tenor { position: relative; display: flex; align-items: center; min-width: 0; }
        .tb-leg-tenor .tb-leg-bar { position: absolute; inset: -11px auto -11px 0; border-radius: 4px; }
        .tb-leg-tenor b { position: relative; font-weight: 600; }
        .tb-totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 16px; padding-top: 16px; border-top: 0.5px solid ${C.border}; }
        .tb-totals div { display: grid; gap: 5px; }
        .tb-totals strong { font-family: ${FD}; font-size: 19px; font-weight: 600; color: ${C.textPrimary}; }
        .tb-warn { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 10px; padding: 12px 14px; font-family: ${FM}; font-size: 12px; color: ${C.textMuted}; }
        .tb-empty { flex: 1; min-height: 220px; display: grid; place-items: center; font-family: ${FM}; font-size: 12px; color: ${C.textMuted}; }
        .tb-skel { min-height: 360px; border: 0.5px solid ${C.border}; border-radius: 12px; background: ${C.card}; opacity: 0.5; }
      `}</style>
      <StripStyles />
    </div>
  );
}
