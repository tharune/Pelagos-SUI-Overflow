"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE, BACKEND_URL } from "../_lib/tokens";
import { suiExplorerTxUrl, friendlyWalletError } from "../_lib/chain";
import { ConnectModal } from "@mysten/dapp-kit";
import { useMode } from "../_lib/mode";
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
import {
  fetchOptionsChain,
  fetchBandDepth,
  type OptionsChain,
  type OptionExpiry,
  type OptionStrike,
  type OptionQuote,
  type BandDepth,
} from "../_lib/v2-clients";

const usd = (v: number) => `$${v.toFixed(2)}`;
const r6 = (raw: string | number) => Number(raw) / 1e6;
const compact = (v: number) =>
  v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`;

// =====================================================================================
// PAGE — mode-aware. Basic = a live options-chain terminal (guided). Advanced = the
// existing f(x)/g(x) SVI distribution desk (preserved, open/sign flow intact).
// =====================================================================================
export default function DistributionPage() {
  const { mode } = useMode();
  return mode === "advanced" ? <AdvancedDistribution /> : <BasicOptionsChain />;
}

// =====================================================================================
// BASIC — LIVE OPTIONS CHAIN TERMINAL
// =====================================================================================

// Money formatting tuned for a dense chain: large premiums compact, small ones
// fixed. Near-expiry far-OTM premiums collapse to ~0 — that's correct, render a
// clean "0.00" (never NaN / blank).
const px = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  if (v <= 0) return "0.00";
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(2);
};
const strikeFmt = (v: number) => Math.round(v).toLocaleString();
const ivFmt = (v: number) => (Number.isFinite(v) && v > 0 ? `${(v * 100).toFixed(0)}%` : "—");
const dltFmt = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "—");
const spot$ = (v: number) => `$${Math.round(v).toLocaleString()}`;

type Side = "call" | "put";
interface Sel { expiryIdx: number; strikeIdx: number; side: Side }

function BasicOptionsChain() {
  const wallet = useWalletSigner();
  const usdc = useUsdcBalance();

  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [expIdx, setExpIdx] = useState(0);
  const [sel, setSel] = useState<Sel | null>(null);
  const [contracts, setContracts] = useState("1");

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<{ digest: string } | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [depth, setDepth] = useState<BandDepth | null>(null);

  // Poll the live chain every 3s so marks/IV stay fresh.
  useEffect(() => {
    let alive = true;
    const run = () =>
      fetchOptionsChain("BTC")
        .then((c) => { if (alive) { setChain(c); setLoadErr(null); } })
        .catch((e) => { if (alive) setLoadErr(e instanceof Error ? e.message : String(e)); });
    run();
    const id = window.setInterval(run, 3_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // Keep the selected expiry in range when the chain changes.
  useEffect(() => {
    if (!chain) return;
    if (expIdx > chain.expiries.length - 1) {
      const def = Math.min(chain.expiries.length - 1, Math.floor(chain.expiries.length * 0.35));
      setExpIdx(Math.max(0, def));
    }
  }, [chain, expIdx]);

  // First load → pick a mid tenor (avoid the 7-minute near-expiry spike) + ATM.
  const seeded = useRef(false);
  useEffect(() => {
    if (!chain || seeded.current) return;
    seeded.current = true;
    const def = Math.min(chain.expiries.length - 1, Math.floor(chain.expiries.length * 0.35));
    setExpIdx(Math.max(0, def));
  }, [chain]);

  const exp: OptionExpiry | null = chain ? chain.expiries[Math.min(expIdx, chain.expiries.length - 1)] ?? null : null;
  const spot = chain?.spot ?? 0;

  // ATM strike index (closest moneyness to 1) for highlight + ATM-IV readout.
  const atmIdx = useMemo(() => {
    if (!exp) return -1;
    let best = -1, bestD = Infinity;
    exp.strikes.forEach((s, i) => { const d = Math.abs(s.moneyness - 1); if (d < bestD) { bestD = d; best = i; } });
    return best;
  }, [exp]);

  const selStrike: OptionStrike | null = useMemo(() => {
    if (!sel || !chain) return null;
    const e = chain.expiries[sel.expiryIdx];
    return e?.strikes[sel.strikeIdx] ?? null;
  }, [sel, chain]);
  const selQuote: OptionQuote | null = selStrike ? selStrike[sel!.side] : null;
  const selExp = sel && chain ? chain.expiries[sel.expiryIdx] : null;

  // Live liquidity-depth / risk cap for the selected band. Re-fetched only when the
  // strike/side (band) changes — not on every 3s chain poll (server-cached too).
  const selLower = selQuote?.lower_strike;
  const selHigher = selQuote?.higher_strike;
  const selOracle = selExp?.oracle_id;
  useEffect(() => {
    if (!selOracle || !selExp || !selLower || !selHigher || !selQuote?.tradeable) { setDepth(null); return; }
    let alive = true;
    setDepth(null);
    fetchBandDepth({ oracle_id: selOracle, expiry: selExp.expiry, lower: selLower, higher: selHigher })
      .then((d) => { if (alive) setDepth(d); })
      .catch(() => { if (alive) setDepth(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selOracle, selLower, selHigher]);

  const pickStrike = useCallback((strikeIdx: number, side: Side) => {
    // Guard: never select an infeasible (non-mintable) strike, even if a stray
    // click reaches here — the ticket should only ever load a tradeable contract.
    const q = chain?.expiries[expIdx]?.strikes[strikeIdx]?.[side];
    if (!q || !q.tradeable) return;
    setSel({ expiryIdx: expIdx, strikeIdx, side });
    setResult(null);
    setOpenErr(null);
  }, [expIdx, chain]);

  // Reset selection when switching expiries (strike indices map across expiries,
  // but the chosen side may collapse to 0 premium — clearer to re-pick).
  const selectExpiry = useCallback((i: number) => {
    setExpIdx(i);
    setSel((s) => (s ? { ...s, expiryIdx: i } : s));
    setResult(null);
    setOpenErr(null);
  }, []);

  // A strike is genuinely OPENABLE if its premium is a live, non-trivial number.
  // Near-expiry far-OTM legs are tradeable=true but mid≈0 → we label those
  // "indicative" (no premium to lock), not openable.
  const liveMid = selQuote ? selQuote.mid : 0;
  const openable = !!selQuote && selQuote.tradeable && liveMid > 0.005;
  // Whole contracts only — 1 contract pays $1 if in-the-money.
  const nContracts = Math.max(0, Math.floor(Number(contracts) || 0));
  const orderCost = selQuote ? selQuote.ask * nContracts : 0; // dUSDC you pay (ask × qty)
  const maxGain = Math.max(0, nContracts - orderCost); // net profit if it settles ITM
  // Liquidity-depth / risk cap: the pool can't safely back more than this in one
  // order (≤15% market impact AND ≤2% of available pool liquidity).
  const maxContracts = depth?.max_contracts ?? null;
  const overCap = maxContracts != null && nContracts > maxContracts;
  // ITM / OTM / ATM for the selected leg. For a $1 binary the mid IS ~P(pays), so
  // mid>0.5 ⟺ in-the-money (high probability, high cost, low convexity).
  const moneyState: "ITM" | "OTM" | "ATM" =
    liveMid >= 0.56 ? "ITM" : liveMid <= 0.44 ? "OTM" : "ATM";

  // --- Open flow: mint EXACTLY this contract's live on-chain range band at `n`
  // whole contracts (the quote's [lower,higher] from get_range_trade_amounts),
  // then open + sign + confirm. No re-derived strip, no fractional fills. --------
  async function openStrike() {
    if (!selExp || !selQuote || !selStrike || !openable || busy) return;
    if (nContracts < 1) { setOpenErr("Enter a whole number of contracts (minimum 1)."); return; }
    if (maxContracts != null && nContracts > maxContracts) {
      setOpenErr(`Order exceeds pool depth — max ${maxContracts.toLocaleString()} contracts for this strike.`);
      return;
    }
    setBusy(true); setOpenErr(null); setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      setStage("Building position…");
      // 1e6 raw = 1 contract = $1 payout. Fund the real premium (ask × n) plus a
      // buffer for post-trade slippage on the live book.
      const qtyRaw = String(nContracts * 1_000_000);
      const depositRaw = String(Math.ceil(selQuote.ask * nContracts * 1.25 * 1_000_000) + 1_000_000);
      const prep = await prepareOpenStrip({
        owner: wallet.address as string,
        manager_id: mgr,
        oracle_id: selExp.oracle_id,
        expiry: String(selExp.expiry),
        buckets: [{ lower: selQuote.lower_strike, higher: selQuote.higher_strike, quantity: qtyRaw }],
        deposit_amount_raw: depositRaw,
      });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult({ digest: c.digest });
      usdc.refresh();
    } catch (e) {
      setOpenErr(friendlyWalletError(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  const atmIv = exp && atmIdx >= 0 ? (exp.strikes[atmIdx].call.iv || exp.strikes[atmIdx].put.iv) : 0;

  return (
    <>
      <Header />
      <PageFrame wide>
        <div className="oc">
          {/* ---- header ---- */}
          <div className="oc-head">
            <div>
              <div className="oc-eyebrow">BTC · DeepBook Predict</div>
              <h1>Distributed Options</h1>
              <p>The live BTC options chain — calls and puts across every on-chain expiry. Each contract is a DeepBook Predict range, priced live off the protocol&apos;s own liquidity (real bid/ask, whole contracts). Settled on Sui.</p>
            </div>
          </div>

          {/* ---- top market bar ---- */}
          <div className="oc-bar">
            <Cell k="BTC spot" v={chain ? spot$(spot) : "—"} accent={C.tealLight} live />
            <Cell k="Forward" v={exp ? spot$(exp.forward) : "—"} hint={exp ? `${exp.tenor_label} expiry` : "—"} />
            <Cell k="ATM implied vol" v={exp ? ivFmt(atmIv) : "—"} hint="at-the-money" />
            <Cell k="Days to expiry" v={exp ? (exp.days_to_expiry < 1 ? `${(exp.days_to_expiry * 24).toFixed(1)}h` : `${exp.days_to_expiry.toFixed(1)}d`) : "—"} hint="testnet · ultra-short" />
            <Cell k="Source" v="DeepBook book" hint="get_range_trade_amounts · on-chain" />
          </div>

          {loadErr && !chain && (
            <div className="oc-err">Live chain offline — start the backend on :13101. <span>{loadErr}</span></div>
          )}

          {/* ---- expiry selector ---- */}
          <div className="oc-exps">
            {chain
              ? chain.expiries.map((e, i) => {
                  const on = i === expIdx;
                  return (
                    <button key={e.oracle_id} className={`oc-pill${on ? " on" : ""}`} onClick={() => selectExpiry(i)}>
                      {e.tenor_label}
                    </button>
                  );
                })
              : Array.from({ length: 7 }).map((_, i) => <span key={i} className="oc-pill skel" />)}
          </div>

          {/* ---- desk: chain (left) + ticket (right) ---- */}
          <div className="oc-grid">
            {/* CHAIN TABLE */}
            <div className="oc-card oc-chain">
              <div className="oc-chain-head">
                <span className="oc-side-cap oc-call">Calls</span>
                <span className="oc-strike-cap">Strike</span>
                <span className="oc-side-cap oc-put">Puts</span>
              </div>
              <div className="oc-cols">
                <div className="oc-colhead call"><span>Mid</span><span>IV</span><span>Δ</span></div>
                <span className="oc-kcol">K</span>
                <div className="oc-colhead put"><span>Mid</span><span>IV</span><span>Δ</span></div>
              </div>
              <div className="oc-rows">
                {exp ? (
                  exp.strikes.map((s, i) => {
                    const isAtm = i === atmIdx;
                    const callSelected = sel?.expiryIdx === expIdx && sel?.strikeIdx === i && sel?.side === "call";
                    const putSelected = sel?.expiryIdx === expIdx && sel?.strikeIdx === i && sel?.side === "put";
                    return (
                      <div className={`oc-row${isAtm ? " atm" : ""}`} key={s.strike}>
                        <SideCells q={s.call} side="call" selected={callSelected} onClick={() => pickStrike(i, "call")} />
                        <button
                          className={`oc-k${isAtm ? " atm" : ""}`}
                          onClick={() => {
                            // Default to the OUT-of-the-money (convex) side at this
                            // strike: above the forward → the cheap OTM CALL; below →
                            // the cheap OTM PUT. Buying the ITM side is a low-convexity
                            // trade (pay ~$0.9 to win ~$0.1) — you can still click that
                            // cell directly, but a strike click shouldn't default there.
                            const pref: Side = s.moneyness >= 1 ? "call" : "put";
                            const chosen: Side | null = s[pref].tradeable
                              ? pref
                              : s.call.tradeable ? "call" : s.put.tradeable ? "put" : null;
                            if (chosen) pickStrike(i, chosen);
                          }}
                        >
                          {strikeFmt(s.strike)}
                          {isAtm && <i>ATM</i>}
                        </button>
                        <SideCells q={s.put} side="put" selected={putSelected} onClick={() => pickStrike(i, "put")} />
                      </div>
                    );
                  })
                ) : (
                  Array.from({ length: 11 }).map((_, i) => <div className="oc-row skel" key={i} />)
                )}
              </div>
              <div className="oc-chain-foot">
                Greyed strikes sit outside the protocol&apos;s mintable 2–98% band (deep ITM / OTM) — the pool won&apos;t underwrite them, so they aren&apos;t tradeable. Live strikes price off the DeepBook book; a call and put at the same strike sum to ~$1.00 (the ATM pair is ~$0.50 each — correct for a $1-payout binary).
              </div>
            </div>

            {/* TICKET */}
            <div className="oc-card oc-ticket">
              {!selStrike || !selQuote || !selExp ? (
                <div className="oc-ticket-empty">
                  <div className="oc-tkt-cap">Order ticket</div>
                  <p>Click a <strong>call</strong> or <strong>put</strong> in the chain to load its Greeks and open a position.</p>
                </div>
              ) : (
                <>
                  <div className="oc-tkt-head">
                    <div>
                      <div className="oc-tkt-cap">Order ticket</div>
                      <div className="oc-tkt-title">
                        <span className={`oc-badge ${sel!.side}`}>{sel!.side === "call" ? "CALL" : "PUT"}</span>
                        BTC {strikeFmt(selStrike.strike)} · {selExp.tenor_label}
                        <span className={`oc-mny ${moneyState.toLowerCase()}`}>{moneyState}</span>
                      </div>
                    </div>
                    {!openable && <span className="oc-indicative">indicative</span>}
                  </div>

                  <div className="oc-quote">
                    <div className="oc-q-mid">
                      <span>Mid · per contract <i className="oc-dot" style={{ display: "inline-block", marginLeft: 5, verticalAlign: "middle" }} /></span>
                      <strong>{liveMid > 0 ? `$${px(liveMid)}` : "$0.00"}</strong>
                    </div>
                    <div className="oc-q-ba">
                      <div><span>Bid</span><b style={{ color: C.green }}>${px(selQuote.bid)}</b></div>
                      <div><span>Ask</span><b style={{ color: C.red }}>${px(selQuote.ask)}</b></div>
                    </div>
                  </div>

                  <div className="oc-greeks">
                    <Grk k="IV" v={ivFmt(selQuote.iv)} accent={C.tealLight} />
                    <Grk k="Δ Delta" v={dltFmt(selQuote.delta)} />
                    <Grk k="Γ Gamma" v={fmtSmall(selQuote.gamma)} />
                    <Grk k="ν Vega" v={fmtSmall(selQuote.vega)} />
                    <Grk k="Θ Theta" v={Math.abs(selQuote.theta) >= 0.98 ? "—" : fmtSmall(selQuote.theta)} />
                    <Grk k="Moneyness" v={`${(selStrike.moneyness * 100).toFixed(0)}%`} />
                  </div>

                  <div className="oc-rows-info">
                    <Info k="Underlying" v={`BTC · ${spot$(spot)}`} />
                    <Info k="Forward" v={spot$(selExp.forward)} />
                    <Info k="Expiry" v={new Date(selExp.expiry).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} />
                    {wallet.connected && <Info k="Balance" v={`${usdc.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} dUSDC`} />}
                  </div>

                  {openable ? (
                    <>
                      <div className="oc-budget">
                        <div className="oc-budget-cap">
                          <span className="oc-tkt-cap">Contracts · whole only</span>
                          {maxContracts != null && (
                            <span className={`oc-depth${overCap ? " over" : ""}`}>max {maxContracts.toLocaleString()} · pool depth</span>
                          )}
                        </div>
                        <div className="oc-budget-in">
                          <input inputMode="numeric" value={contracts} onChange={(e) => setContracts(e.target.value.replace(/[^0-9]/g, ""))} placeholder="1" />
                          <span>× $1 payout</span>
                        </div>
                      </div>
                      <div className="oc-rows-info">
                        <Info k="Cost · ask × qty" v={`$${orderCost.toFixed(2)} dUSDC`} />
                        <Info k="Max gain" v={`$${maxGain.toFixed(2)} dUSDC`} />
                        <Info k="Max loss" v={`$${orderCost.toFixed(2)} dUSDC`} />
                      </div>
                      {!wallet.connected ? (
                        <ConnectModal trigger={<button className="oc-open">Connect a wallet to trade</button>} />
                      ) : (
                        <button className="oc-open" disabled={busy || nContracts < 1 || overCap} onClick={openStrike} style={{ opacity: busy || nContracts < 1 || overCap ? 0.6 : 1, cursor: busy ? "wait" : "pointer" }}>
                          {busy ? (stage ?? "Submitting…") : overCap ? `Exceeds pool depth · max ${maxContracts!.toLocaleString()}` : `Buy ${nContracts} ${sel!.side} ${nContracts === 1 ? "contract" : "contracts"} · $${orderCost.toFixed(2)}`}
                        </button>
                      )}
                      <p className="oc-note">Buys {nContracts} whole {sel!.side} {nContracts === 1 ? "contract" : "contracts"} as a live on-chain DeepBook Predict range — priced off the book (real bid/ask), settled on Sui testnet.</p>
                    </>
                  ) : (
                    <div className="oc-indic-box">
                      This strike is far out-of-the-money this close to expiry, so its premium has collapsed to ~0 — there is nothing to lock. It is shown for reference only. Pick a nearer-the-money strike, or a longer expiry, to trade.
                    </div>
                  )}

                  {result && (
                    <div className="oc-ok">
                      ✓ Position opened on testnet ·{" "}
                      <a href={suiExplorerTxUrl(result.digest)} target="_blank" rel="noreferrer">{result.digest.slice(0, 10)}… ↗</a>
                    </div>
                  )}
                  {openErr && <div className="oc-err inline">{openErr}</div>}
                </>
              )}
            </div>
          </div>
        </div>
      </PageFrame>
      <style jsx global>{OC_CSS}</style>
    </>
  );
}

// One cell-group for one side of a chain row (3 columns: mid / iv / delta).
function SideCells({ q, side, selected, onClick }: { q: OptionQuote; side: Side; selected: boolean; onClick: () => void }) {
  const mid = q.mid;
  // A non-tradeable leg sits OUTSIDE the protocol's mintable [2%,98%] band — a $1
  // payout for ~$1 (deep ITM) or a ~$0 lottery (deep OTM). The pool won't
  // underwrite it, so black it out and make it non-interactive: you can never
  // select / open an infeasible position.
  if (!q.tradeable) {
    return (
      <div className={`oc-cells ${side} blackout`} title="Not tradeable — outside the protocol's mintable 2–98% band">
        <span className="oc-mid">{mid > 0.005 ? px(mid) : "·"}</span>
        <span className="oc-iv">{ivFmt(q.iv)}</span>
        <span className="oc-dlt">—</span>
      </div>
    );
  }
  return (
    <button className={`oc-cells ${side}${selected ? " sel" : ""}`} onClick={onClick}>
      <span className="oc-mid">{px(mid)}</span>
      <span className="oc-iv">{ivFmt(q.iv)}</span>
      <span className="oc-dlt">{dltFmt(q.delta)}</span>
    </button>
  );
}

function Cell({ k, v, hint, accent, live }: { k: string; v: string; hint?: string; accent?: string; live?: boolean }) {
  return (
    <div className="oc-cell">
      <span className="oc-cell-k">{k}{live && <i className="oc-dot" />}</span>
      <strong style={accent ? { color: accent } : undefined}>{v}</strong>
      {hint && <span className="oc-cell-h">{hint}</span>}
    </div>
  );
}
function Grk({ k, v, accent }: { k: string; v: string; accent?: string }) {
  return (
    <div className="oc-grk">
      <span>{k}</span>
      <strong style={accent ? { color: accent } : undefined}>{v}</strong>
    </div>
  );
}
function Info({ k, v }: { k: string; v: string }) {
  return <div className="oc-info"><span>{k}</span><b>{v}</b></div>;
}
// Greek display: ALWAYS a plain decimal, never scientific notation — a small
// vega should read "0.0018", not "1.8e-3". Trailing zeros trimmed; truly
// negligible values collapse to a clean "0".
function fmtSmall(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a < 5e-8) return "0";
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
}

const OC_CSS = `
  .oc { max-width: 1480px; margin: 0 auto; display: grid; gap: 14px; min-width: 0; }
  .oc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .oc-eyebrow { font-family: ${FM}; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: ${C.teal}; }
  .oc-head h1 { margin: 6px 0 0; font-family: ${FD}; font-size: 30px; font-weight: 600; letter-spacing: -0.03em; color: ${C.textPrimary}; display: flex; align-items: center; }
  .oc-head p { margin: 8px 0 0; max-width: 640px; font-family: ${FS}; font-size: 13px; line-height: 1.55; color: ${C.textSecondary}; }

  .oc-bar { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 12px; overflow: hidden; }
  .oc-cell { background: ${C.card}; padding: 11px 14px; display: grid; gap: 3px; min-width: 0; }
  .oc-cell-k { font-family: ${FM}; font-size: 9px; letter-spacing: 0.09em; text-transform: uppercase; color: ${C.textMuted}; display: inline-flex; align-items: center; gap: 6px; }
  .oc-cell strong { font-family: ${FD}; font-size: 18px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .oc-cell-h { font-family: ${FM}; font-size: 9.5px; color: ${C.textMuted}; }
  .oc-dot { width: 6px; height: 6px; border-radius: 50%; background: ${C.green}; box-shadow: 0 0 7px ${C.green}; animation: oc-pulse 2s ${EASE} infinite; }
  @keyframes oc-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  .oc-err { border: 0.5px solid ${C.red}55; background: ${C.redBg}; border-radius: 10px; padding: 11px 14px; font-family: ${FM}; font-size: 12px; color: ${C.red}; }
  .oc-err span { color: ${C.textMuted}; opacity: 0.8; }
  .oc-err.inline { margin-top: 10px; }

  .oc-exps { display: flex; flex-wrap: wrap; gap: 7px; }
  .oc-pill { font-family: ${FM}; font-size: 11px; letter-spacing: 0.03em; padding: 7px 13px; border-radius: 8px; border: 0.5px solid ${C.border}; background: ${C.card}; color: ${C.textSecondary}; cursor: pointer; transition: all 0.14s ${EASE}; font-variant-numeric: tabular-nums; }
  .oc-pill:hover { border-color: ${C.borderHover}; color: ${C.textPrimary}; }
  .oc-pill.on { background: ${C.tealLight}; border-color: ${C.tealLight}; color: #04121d; font-weight: 600; }
  .oc-pill.skel { width: 52px; height: 30px; opacity: 0.5; animation: oc-sk 1.3s ${EASE} infinite; cursor: default; }
  @keyframes oc-sk { 0%,100% { opacity: 0.35; } 50% { opacity: 0.6; } }

  .oc-grid { display: grid; grid-template-columns: minmax(0, 1.72fr) minmax(320px, 0.86fr); gap: 14px; align-items: start; }
  @media (max-width: 1080px) { .oc-grid { grid-template-columns: 1fr; } .oc-bar { grid-template-columns: repeat(2, 1fr); } }
  .oc-card { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; min-width: 0; }

  /* chain table */
  .oc-chain { padding: 0; overflow: hidden; }
  .oc-chain-head { display: grid; grid-template-columns: 1fr 132px 1fr; align-items: center; padding: 12px 14px 8px; }
  .oc-side-cap { font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
  .oc-side-cap.oc-call { color: ${C.green}; text-align: left; }
  .oc-side-cap.oc-put { color: ${C.violet}; text-align: right; }
  .oc-strike-cap { font-family: ${FM}; font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.textMuted}; text-align: center; }
  /* Column headers MUST mirror .oc-cells exactly (same 3×1fr, 6px gap, 14px
     horizontal padding, RTL on the put side) so every label sits dead-centre
     over its data column. */
  .oc-cols { display: grid; grid-template-columns: 1fr 132px 1fr; align-items: center; padding: 0 0 7px; border-bottom: 0.5px solid ${C.border}; }
  .oc-colhead { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; padding: 0 14px; }
  .oc-colhead span { font-family: ${FM}; font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; text-align: right; }
  .oc-colhead.put { direction: rtl; }
  .oc-colhead.put span { direction: ltr; text-align: left; }
  .oc-cols .oc-kcol { font-family: ${FM}; font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; text-align: center; }

  .oc-rows { display: grid; }
  .oc-row { display: grid; grid-template-columns: 1fr 132px 1fr; align-items: stretch; border-bottom: 0.5px solid ${C.border}; }
  .oc-row:last-child { border-bottom: 0; }
  .oc-row.atm { background: ${C.tealLight}0c; }
  .oc-row.skel { height: 34px; opacity: 0.4; animation: oc-sk 1.3s ${EASE} infinite; }

  .oc-cells { display: grid; grid-template-columns: 1fr 1fr 1fr; align-items: center; gap: 6px; padding: 8px 14px; background: transparent; border: none; cursor: pointer; font-variant-numeric: tabular-nums; transition: background 0.12s ${EASE}; }
  .oc-cells span { font-family: ${FM}; font-size: 12px; }
  .oc-cells.call span { text-align: right; }
  .oc-cells.put { direction: rtl; }
  .oc-cells.put span { text-align: left; direction: ltr; }
  .oc-cells:hover { background: ${C.cardHover}; }
  .oc-cells.sel { background: ${C.tealLight}22; }
  .oc-cells.call.sel { box-shadow: inset 3px 0 0 ${C.tealLight}; }
  .oc-cells.put.sel { box-shadow: inset -3px 0 0 ${C.tealLight}; }
  .oc-cells.blackout { cursor: default; opacity: 0.5; }
  .oc-cells.blackout:hover { background: transparent; }
  .oc-cells.blackout span { color: ${C.textMuted}; }
  .oc-mid { color: ${C.textPrimary}; font-weight: 500; }
  .oc-iv { color: ${C.textSecondary}; }
  .oc-dlt { color: ${C.textMuted}; }

  .oc-k { font-family: ${FM}; font-size: 12.5px; font-weight: 600; color: ${C.textPrimary}; background: ${C.surface}; border: none; border-left: 0.5px solid ${C.border}; border-right: 0.5px solid ${C.border}; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; font-variant-numeric: tabular-nums; transition: background 0.12s ${EASE}; }
  .oc-k:hover { background: ${C.cardHover}; }
  .oc-k.atm { color: ${C.tealLight}; background: ${C.tealLight}14; }
  .oc-k i { font-style: normal; font-family: ${FM}; font-size: 7.5px; letter-spacing: 0.1em; color: ${C.tealLight}; }

  .oc-chain-foot { padding: 9px 14px; border-top: 0.5px solid ${C.border}; font-family: ${FM}; font-size: 10px; line-height: 1.5; color: ${C.textMuted}; background: ${C.surface}; }

  /* ticket */
  .oc-ticket { padding: 12px 16px 16px; display: grid; gap: 13px; align-content: start; }
  .oc-tkt-cap { font-family: ${FM}; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: ${C.textMuted}; }
  .oc-ticket-empty { display: grid; gap: 10px; padding: 0 0 8px; }
  .oc-ticket-empty p { margin: 0; font-family: ${FS}; font-size: 12.5px; line-height: 1.55; color: ${C.textSecondary}; }
  .oc-tkt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .oc-tkt-title { margin-top: 6px; font-family: ${FD}; font-size: 16px; font-weight: 600; color: ${C.textPrimary}; display: flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
  .oc-badge { font-family: ${FM}; font-size: 9px; font-weight: 600; letter-spacing: 0.08em; padding: 3px 7px; border-radius: 5px; }
  .oc-badge.call { color: ${C.green}; background: ${C.green}1c; }
  .oc-badge.put { color: ${C.violet}; background: ${C.violet}22; }
  .oc-mny { font-family: ${FM}; font-size: 8.5px; font-weight: 600; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 4px; margin-left: 2px; }
  .oc-mny.itm { color: ${C.amber}; background: ${C.amber}1f; }
  .oc-mny.otm { color: ${C.teal}; background: ${C.teal}1f; }
  .oc-mny.atm { color: ${C.textSecondary}; background: ${C.textMuted}1f; }
  .oc-indicative { font-family: ${FM}; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.amber}; border: 0.5px solid ${C.amber}66; background: ${C.amber}14; border-radius: 5px; padding: 3px 7px; white-space: nowrap; }

  .oc-quote { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 11px; padding: 12px 14px; display: grid; gap: 10px; }
  .oc-q-mid { display: flex; justify-content: space-between; align-items: baseline; }
  .oc-q-mid span { font-family: ${FM}; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: ${C.textMuted}; }
  .oc-q-mid strong { font-family: ${FD}; font-size: 24px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }
  .oc-q-ba { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; border-top: 0.5px solid ${C.border}; padding-top: 10px; }
  .oc-q-ba div { display: flex; justify-content: space-between; align-items: baseline; }
  .oc-q-ba span { font-family: ${FM}; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: ${C.textMuted}; }
  .oc-q-ba b { font-family: ${FD}; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }

  .oc-greeks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: ${C.border}; border: 0.5px solid ${C.border}; border-radius: 11px; overflow: hidden; }
  .oc-grk { background: ${C.card}; padding: 9px 11px; display: grid; gap: 3px; }
  .oc-grk span { font-family: ${FM}; font-size: 8.5px; letter-spacing: 0.05em; text-transform: uppercase; color: ${C.textMuted}; }
  .oc-grk strong { font-family: ${FD}; font-size: 14px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }

  .oc-rows-info { display: grid; gap: 8px; }
  .oc-info { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .oc-info span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }
  .oc-info b { font-family: ${FD}; font-size: 12.5px; font-weight: 600; color: ${C.textPrimary}; font-variant-numeric: tabular-nums; }

  .oc-budget { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 11px; padding: 10px 13px; display: grid; gap: 6px; }
  .oc-budget-cap { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .oc-depth { font-family: ${FM}; font-size: 9px; letter-spacing: 0.04em; color: ${C.textMuted}; white-space: nowrap; }
  .oc-depth.over { color: ${C.amber}; }
  .oc-budget-in { display: flex; align-items: baseline; gap: 8px; }
  .oc-budget-in input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: ${C.textPrimary}; font-family: ${FD}; font-size: 20px; font-weight: 600; padding: 0; }
  .oc-budget-in span { font-family: ${FM}; font-size: 11px; color: ${C.textMuted}; }

  .oc-open { width: 100%; height: 46px; border: none; border-radius: 12px; background: ${C.tealLight}; color: #04121d; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: transform 0.15s ${EASE}; }
  .oc-open:hover:not(:disabled) { transform: translateY(-1px); }
  .oc-note { margin: 0; font-family: ${FS}; font-size: 10.5px; line-height: 1.5; color: ${C.textMuted}; }
  .oc-indic-box { border: 0.5px solid ${C.amber}44; background: ${C.amber}10; border-radius: 11px; padding: 12px 14px; font-family: ${FS}; font-size: 11.5px; line-height: 1.55; color: ${C.textSecondary}; }

  .oc-ok { font-family: ${FM}; font-size: 12px; color: ${C.green}; line-height: 1.5; }
  .oc-ok a { color: ${C.tealLight}; }
`;

// =====================================================================================
// ADVANCED — the existing f(x)/g(x) SVI DISTRIBUTION DESK (preserved verbatim).
// =====================================================================================

interface DeepBookMarket {
  id: string;
  expiry: number;
  tenor: string;
  forward: number;
  atmIv: number;
  tYears: number;
  sigmaImpl: number;
}

const N_BUCKETS = 6;

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

function AdvancedDistribution() {
  const wallet = useWalletSigner();
  const usdc = useUsdcBalance();

  const [markets, setMarkets] = useState<DeepBookMarket[]>([]);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [poolTvl, setPoolTvl] = useState<number | null>(null);
  const [poolCapUsd, setPoolCapUsd] = useState<number | null>(null); // 2% of available pool liquidity
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

  useEffect(() => {
    fetchVolSurface("BTC")
      .then((s) => {
        const T_MIN = (12 * 60) / 31_557_600; // 12-min floor — same market set as Basic
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
      .then((v) => {
        if (v && typeof v.vault_value === "number") setPoolTvl(v.vault_value / 1e6);
        // Same risk cap as the Basic chain: one position's max payout ≤ 2% of the
        // pool's available liquidity, so a custom strip can't over-extend the book.
        const avail = Number(v?.available_liquidity ?? v?.vault_value);
        if (Number.isFinite(avail) && avail > 0) setPoolCapUsd((avail / 1e6) * 0.02);
      })
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

  useEffect(() => {
    if (!marketId) { setDensity(null); return; }
    let alive = true;
    setDensity(null);
    fetchDensity(marketId).then((d) => { if (alive) setDensity(d); }).catch(() => { if (alive) setDensity(null); });
    return () => { alive = false; };
  }, [marketId]);

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

  const frame = useMemo<ChartData | null>(() => {
    if (!market) return null;
    if (density && density.oracle_id === market.id && density.pdf.length > 2) {
      return buildFrameFromDensity(density.x, density.pdf, mu, sigma);
    }
    return buildChartFrame(market.forward, market.sigmaImpl, mu, sigma, "usd");
  }, [market, mu, sigma, density]);

  const tradeable = quote ? quote.buckets.filter((b) => b.tradeable && Number(b.quantity) > 0).length : 0;
  const flat = !quote || tradeable === 0;
  // Pool-depth / risk cap (same as Basic): the strip's total max payout — the
  // pool's liability if it lands worst-case — must stay ≤ 2% of available liquidity.
  const stripMaxPayout = quote ? r6(quote.total_max_payout_raw) : 0;
  const overPoolCap = poolCapUsd != null && stripMaxPayout > poolCapUsd;
  const canOpen = wallet.connected && !!quote && !flat && !busy && !overPoolCap;

  const lock = quote ? r6(quote.total_cost_raw) : 0;
  const maxProfit = quote ? r6(quote.realized_max_payout_raw) - r6(quote.total_cost_raw) : 0;
  const ev = quote ? r6(quote.expected_value_raw) : 0;

  async function open() {
    if (!market || !quote) return;
    if (overPoolCap) { setError(`Strip max payout ($${stripMaxPayout.toFixed(0)}) exceeds pool depth — reduce budget (max ≈ $${poolCapUsd!.toFixed(0)}).`); return; }
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
            BTC · DeepBook Predict
          </div>
          <h1 style={{ fontFamily: FD, fontSize: 34, fontWeight: 600, letterSpacing: "-0.03em", color: C.textPrimary, margin: 0, display: "flex", alignItems: "center", gap: 10 }}>
            Distributed Options
          </h1>
          <p style={{ fontFamily: FS, fontSize: 14.5, color: C.textSecondary, margin: "8px 0 0", maxWidth: 680, lineHeight: 1.6 }}>
            Trade your <strong style={{ color: C.textPrimary }}>whole view</strong>{" "}of where BTC settles, not one strike.
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
                        <span style={{ color: C.textPrimary }}>{usdc.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} dUSDC</span>
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
                  {busy ? stage ?? "Submitting…" : flat ? "Widen σ to build a tradeable strip" : overPoolCap ? `Exceeds pool depth · reduce budget` : `Open strip · lock ${quote ? usd(lock) : ""}`}
                </button>
              )}

              {wallet.connected && (
                <div style={{ marginTop: 12, fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                  Opening needs dUSDC (Predict&apos;s faucet-gated quote asset). Balance {usdc.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} dUSDC.
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
        .dc-market-scroll { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent); }
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
