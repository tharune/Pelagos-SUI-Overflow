"use client";

// ---------------------------------------------------------------------------
// DeepBook baskets — the structured BTC strips (Pin / Spread / Wide), priced
// live on a chosen expiry (tenor). Master-detail: pick a tenor, pick a strip,
// see its live on-chain bucket ladder (ask + bid from get_range_trade_amounts)
// and open it in one signature. Testnet DeepBook Predict lists BTC only, so the
// tenor selector spans BTC's live expiries (near → far term).
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { C, FD, FM, FS, EASE, BACKEND_URL } from "../_lib/tokens";
import { friendlyWalletError } from "../_lib/chain";
import {
  stripPreview,
  listBaskets,
  ensureManager,
  prepareOpenStrip,
  confirmPredict,
  usd,
  type StripQuote,
  type BasketRecipe,
} from "../_lib/predict-strip-client";
import { useWalletSigner } from "../_lib/wallet-bridge";
import {
  BucketLadder,
  OpenButton,
  ResultLine,
  Cap,
  Stat,
  StripStyles,
  openableBuckets,
  dollars,
} from "./strip-products";

type Wallet = ReturnType<typeof useWalletSigner>;

interface Oracle {
  oracle_id: string;
  expiry: number;
  status: string;
}

function tenorLabel(expiry: number): string {
  const ms = expiry - Date.now();
  if (ms <= 0) return "expired";
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const ACCENT: Record<string, string> = {
  "btc-pin": "#8fe3ff",
  "btc-spread": "#4da2ff",
  "btc-convex": "#1f5fd1",
};

export function DeepBookBaskets() {
  const wallet = useWalletSigner();
  const [oracles, setOracles] = useState<Oracle[] | null>(null);
  const [tenorId, setTenorId] = useState<string | null>(null);
  const [recipes, setRecipes] = useState<BasketRecipe[]>([]);
  const [budget, setBudget] = useState("100");

  const [forward, setForward] = useState<number | null>(null);
  const [quotes, setQuotes] = useState<Record<string, StripQuote>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const budgetNum = Number(budget);
  const validBudget = Number.isFinite(budgetNum) && budgetNum > 0;

  // Load the live BTC tenors + the recipe presets once.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${BACKEND_URL}/api/predict/oracles?active=true&underlying=BTC`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((arr: Oracle[]) => {
        if (!Array.isArray(arr)) return;
        // Skip near-expiry oracles: within a few minutes the implied distribution
        // collapses and wide shapes price every band out of the mintable window.
        const now = Date.now();
        const live = arr.filter((o) => o.status === "active" && o.expiry > now).sort((a, b) => a.expiry - b.expiry);
        const buffered = live.filter((o) => o.expiry - now >= 6 * 60_000);
        const active = (buffered.length >= 3 ? buffered : live).slice(0, 6);
        setOracles(active);
        setTenorId((cur) => cur ?? active[0]?.oracle_id ?? null);
      })
      .catch(() => setErr("Couldn't load live BTC expiries — is the backend running?"));
    listBaskets().then(setRecipes).catch(() => {});
    return () => ctrl.abort();
  }, []);

  // Price the three strips on the selected tenor whenever it / budget changes.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!tenorId || recipes.length === 0 || !validBudget) return;
    if (timer.current) window.clearTimeout(timer.current);
    setLoading(true);
    const ctrl = new AbortController();
    timer.current = window.setTimeout(async () => {
      try {
        // One default preview resolves the live forward for this oracle.
        const base = await stripPreview({ oracle_id: tenorId, n: 4, budget_usd: budgetNum, sender: wallet.address ?? undefined }, ctrl.signal);
        setForward(base.forward_usd);
        const priced = await Promise.all(
          recipes.map((r) =>
            stripPreview(
              { oracle_id: tenorId, sigma_usd: r.sigma_pct * base.forward_usd, n: r.n, budget_usd: budgetNum, sender: wallet.address ?? undefined },
              ctrl.signal,
            )
              .then((q) => [r.id, q] as const)
              .catch(() => null),
          ),
        );
        const next: Record<string, StripQuote> = {};
        for (const p of priced) if (p) next[p[0]] = p[1];
        setQuotes(next);
        setErr(null);
        setSelected((cur) => (cur && next[cur] ? cur : recipes[0]?.id ?? null));
      } catch (e) {
        if ((e as { name?: string })?.name !== "AbortError") setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      ctrl.abort();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [tenorId, recipes, budgetNum, validBudget, wallet.address]);

  const selectedRecipe = recipes.find((r) => r.id === selected) ?? null;
  const selectedQuote = selected ? quotes[selected] : null;

  async function open() {
    if (!selectedQuote || !tenorId) return;
    setBusy(true);
    setOpenErr(null);
    setResult(null);
    try {
      setStage("Preparing manager…");
      const mgr = await ensureManager(wallet.address as string, wallet.signAndExecute);
      const buckets = openableBuckets(selectedQuote.buckets);
      if (buckets.length === 0) throw new Error("No tradeable buckets on this tenor — try a wider basket or another expiry.");
      setStage("Building basket…");
      const deposit = ((BigInt(selectedQuote.total_cost_raw) * 12n) / 10n).toString();
      const prep = await prepareOpenStrip({
        owner: wallet.address as string,
        manager_id: mgr,
        oracle_id: selectedQuote.oracle_id,
        expiry: selectedQuote.expiry,
        buckets,
        deposit_amount_raw: deposit,
      });
      setStage("Sign in wallet…");
      const digest = await wallet.signAndExecute(prep.tx_bytes);
      setStage("Confirming…");
      const c = await confirmPredict(digest);
      setResult(c.digest);
    } catch (e) {
      setOpenErr(friendlyWalletError(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <div className="db-wrap">
      {/* tenor + budget controls */}
      <div className="db-controls">
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <Cap>Expiry · live BTC tenors</Cap>
          <div className="db-tenors">
            {oracles === null ? (
              <span style={{ fontFamily: FM, fontSize: 11.5, color: C.textMuted }}>loading tenors…</span>
            ) : oracles.length === 0 ? (
              <span style={{ fontFamily: FM, fontSize: 11.5, color: C.textMuted }}>no live BTC expiries right now</span>
            ) : (
              oracles.map((o) => (
                <button
                  key={o.oracle_id}
                  className={`db-tenor${o.oracle_id === tenorId ? " is-active" : ""}`}
                  onClick={() => setTenorId(o.oracle_id)}
                >
                  {tenorLabel(o.expiry)}
                </button>
              ))
            )}
          </div>
        </div>
        <div style={{ display: "grid", gap: 7 }}>
          <Cap>Budget (dUSDC)</Cap>
          <input className="db-num" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
        <div style={{ display: "grid", gap: 3 }}>
          <Cap>Forward</Cap>
          <span style={{ fontFamily: FD, fontSize: 18, fontWeight: 600, color: C.tealLight }}>
            {forward ? dollars(forward) : loading ? "…" : "—"}
          </span>
        </div>
      </div>

      {err && <div className="db-warn">{err}</div>}

      <div className="db-grid">
        {/* left: strip cards */}
        <div className="db-cards">
          {recipes.map((r) => {
            const q = quotes[r.id];
            const accent = ACCENT[r.id] ?? C.teal;
            const on = r.id === selected;
            const tradeable = q ? q.buckets.filter((b) => b.tradeable).length : 0;
            return (
              <button
                key={r.id}
                className={`db-card${on ? " is-active" : ""}`}
                style={on ? { borderColor: `${accent}88`, boxShadow: `inset 2px 0 0 ${accent}` } : undefined}
                onClick={() => setSelected(r.id)}
              >
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontFamily: FD, fontSize: 15, fontWeight: 600, color: accent }}>{r.name}</span>
                    <span style={{ fontFamily: FM, fontSize: 9.5, color: C.textMuted }}>σ {(r.sigma_pct * 100).toFixed(1)}% · N{r.n}</span>
                  </div>
                  <span style={{ fontFamily: FS, fontSize: 12, color: C.textSecondary, lineHeight: 1.45, marginTop: 6, display: "block" }}>
                    {r.description}
                  </span>
                </div>
                <div style={{ marginTop: "auto", paddingTop: 12, borderTop: `0.5px solid ${C.border}`, display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.1em", color: C.textMuted }}>ASK</span>
                    <span style={{ fontFamily: FD, fontSize: 13, color: C.textPrimary }}>{q && tradeable > 0 ? usd(q.total_cost_raw) : loading ? "…" : "—"}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.1em", color: C.textMuted }}>BEST CASE</span>
                    <span style={{ fontFamily: FD, fontSize: 13, color: accent }}>{q && tradeable > 0 ? usd(q.realized_max_payout_raw) : loading ? "…" : "—"}</span>
                  </div>
                  <div style={{ fontFamily: FM, fontSize: 9.5, color: q && tradeable > 0 ? C.green : C.textMuted }}>
                    {q ? (tradeable > 0 ? `${tradeable}/${q.buckets.length} bands tradeable` : "rolls at this tenor") : ""}
                  </div>
                </div>
              </button>
            );
          })}
          {recipes.length === 0 && <div className="db-warn">Loading DeepBook strips…</div>}
        </div>

        {/* right: live ladder + open for the selected strip */}
        <div className="db-detail">
          {selectedRecipe && selectedQuote ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                <div>
                  <Cap>{selectedRecipe.name} · live on-chain MM (ask + bid)</Cap>
                  <div style={{ fontFamily: FM, fontSize: 10.5, color: C.textMuted, marginTop: 5 }}>
                    {tenorId && oracles ? `${tenorLabel(oracles.find((o) => o.oracle_id === tenorId)?.expiry ?? 0)} expiry · ${selectedQuote.oracle_id.slice(0, 8)}…` : ""}
                  </div>
                </div>
                <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>{loading ? "pricing…" : `${selectedQuote.buckets.length} buckets`}</span>
              </div>

              <BucketLadder quote={selectedQuote} />

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginTop: 16, paddingTop: 16, borderTop: `0.5px solid ${C.border}` }}>
                <Stat label="Total ask" value={usd(selectedQuote.total_cost_raw)} />
                <Stat label="Best-case max payout" value={usd(selectedQuote.realized_max_payout_raw)} color={C.tealLight} />
                <Stat label="Round-trip spread" value={usd(selectedQuote.round_trip_spread_raw)} color={C.amber} />
              </div>

              <div style={{ marginTop: 16 }}>
                <OpenButton
                  wallet={wallet}
                  busy={busy}
                  disabled={!selectedQuote}
                  label={`Open ${selectedRecipe.name} · ${usd(selectedQuote.total_cost_raw)}`}
                  busyLabel={stage ?? "Submitting…"}
                  onOpen={open}
                />
                {result && <ResultLine digest={result} label={`${selectedRecipe.name} opened`} />}
                {openErr && <div style={{ marginTop: 12, fontFamily: FM, fontSize: 12, color: C.red, lineHeight: 1.5 }}>{openErr}</div>}
              </div>
            </>
          ) : (
            <div style={{ height: 280, display: "grid", placeItems: "center", fontFamily: FM, fontSize: 12, color: C.textMuted }}>
              {loading ? "Pricing live strips…" : "Select a strip to see its live ladder."}
            </div>
          )}
        </div>
      </div>

      <style jsx global>{`
        .db-wrap { display: grid; gap: 14px; min-width: 0; }
        .db-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 24px; border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 12px; padding: 16px 18px; }
        .db-tenors { display: flex; gap: 6px; flex-wrap: wrap; }
        .db-tenor { padding: 6px 12px; border-radius: 8px; border: 0.5px solid ${C.border}; background: ${C.surface}; color: ${C.textSecondary}; font-family: ${FM}; font-size: 11.5px; cursor: pointer; transition: all 0.14s ${EASE}; }
        .db-tenor:hover { border-color: ${C.borderHover}; color: ${C.textPrimary}; }
        .db-tenor.is-active { border-color: ${C.tealLight}; color: ${C.textPrimary}; background: ${C.cardHover}; }
        .db-num { width: 130px; box-sizing: border-box; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 8px; padding: 9px 12px; color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; outline: none; }
        .db-num:focus { border-color: ${C.tealLight}; }
        .db-warn { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 10px; padding: 12px 14px; font-family: ${FM}; font-size: 12px; color: ${C.textMuted}; }
        .db-grid { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.5fr); gap: 16px; align-items: stretch; }
        @media (max-width: 980px) { .db-grid { grid-template-columns: 1fr; } }
        .db-cards { display: grid; gap: 12px; grid-auto-rows: 1fr; }
        .db-card { display: flex; flex-direction: column; text-align: left; border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 12px; padding: 16px; cursor: pointer; transition: border-color 0.14s ${EASE}, background 0.14s ${EASE}, transform 0.14s ${EASE}; }
        .db-card:hover { border-color: ${C.borderHover}; background: ${C.cardHover}; transform: translateY(-2px); }
        .db-detail { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 14px; padding: 20px; min-width: 0; display: flex; flex-direction: column; }
      `}</style>
      <StripStyles />
    </div>
  );
}
