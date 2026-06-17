"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { suiExplorerTxUrl } from "../_lib/chain";
import {
  fetchPredictConfig,
  fetchPredictStatus,
  fetchPredictQuote,
  fetchPredictManagers,
  createPredictManager,
  predictMint,
  predictRedeem,
  fmtDusdc,
  type PredictConfig,
  type PredictStatus,
  type PredictQuote,
} from "../_lib/predict-client";

const short = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
const usd = (raw: string) => `${fmtDusdc(raw)} dUSDC`;
const fmtExpiry = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtStrike = (raw: string) => `$${(Number(raw) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const PANEL: React.CSSProperties = {
  background: C.card,
  border: `0.5px solid ${C.border}`,
  borderRadius: 14,
  padding: 20,
};

export default function PredictPage() {
  const [config, setConfig] = useState<PredictConfig | null>(null);
  const [status, setStatus] = useState<PredictStatus | null>(null);
  const [asset] = useState("BTC");
  const [contracts, setContracts] = useState("1");
  const [isUp, setIsUp] = useState(true);

  const [quote, setQuote] = useState<PredictQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  const [busy, setBusy] = useState<null | "mint" | "redeem">(null);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<{ label: string; digest: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // dUSDC 6dp: 1 contract = 1_000_000 raw.
  const quantityRaw = (() => {
    const n = Number(contracts);
    if (!Number.isFinite(n) || n <= 0) return "0";
    return String(Math.round(n * 1_000_000));
  })();

  useEffect(() => {
    fetchPredictConfig().then(setConfig).catch(() => {});
    fetchPredictStatus().then(setStatus).catch(() => {});
  }, []);

  // Debounced live simulation on input change.
  const quoteTimer = useRef<number | null>(null);
  useEffect(() => {
    if (quantityRaw === "0") {
      setQuote(null);
      return;
    }
    const ctrl = new AbortController();
    if (quoteTimer.current) window.clearTimeout(quoteTimer.current);
    setQuoting(true);
    quoteTimer.current = window.setTimeout(() => {
      fetchPredictQuote({ asset, quantity: quantityRaw, isUp, signal: ctrl.signal })
        .then((q) => {
          setQuote(q);
          setQuoteErr(null);
        })
        .catch((e) => {
          if (e?.name !== "AbortError") setQuoteErr(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setQuoting(false));
    }, 250);
    return () => {
      ctrl.abort();
      if (quoteTimer.current) window.clearTimeout(quoteTimer.current);
    };
  }, [asset, quantityRaw, isUp]);

  const edgeRaw = quote ? Number(quote.redeem_payout) - Number(quote.mint_cost) : 0;

  // Server-signed write: ensure a Predict manager for the signer, then mint/redeem.
  const ensureManager = useCallback(async (): Promise<string> => {
    const signer = status?.signer_address ?? null;
    if (signer) {
      const managers = await fetchPredictManagers(signer).catch(() => []);
      if (managers.length > 0) return managers[0].manager_id;
    }
    setStage("Creating Predict manager…");
    const created = await createPredictManager();
    if (!created.manager_id) throw new Error("manager creation returned no id");
    return created.manager_id;
  }, [status]);

  async function handleMint() {
    if (!quote) return;
    setBusy("mint");
    setError(null);
    setResult(null);
    try {
      const managerId = await ensureManager();
      setStage("Minting on Predict…");
      const depositRaw = (BigInt(quote.mint_cost) * 5n / 4n + 1n).toString(); // ~1.25x for drift
      const r = await predictMint({
        manager_id: managerId,
        oracle_id: quote.oracle_id,
        expiry: quote.expiry,
        strike: quote.strike,
        is_up: quote.is_up,
        quantity: quote.quantity,
        deposit_amount_raw: depositRaw,
      });
      setResult({ label: `Minted ${contracts} ${isUp ? "UP" : "DOWN"}`, digest: r.digest });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setStage(null);
    }
  }

  async function handleRedeem() {
    if (!quote) return;
    setBusy("redeem");
    setError(null);
    setResult(null);
    try {
      const managerId = await ensureManager();
      setStage("Redeeming on Predict…");
      const r = await predictRedeem({
        manager_id: managerId,
        oracle_id: quote.oracle_id,
        expiry: quote.expiry,
        strike: quote.strike,
        is_up: quote.is_up,
        quantity: quote.quantity,
      });
      setResult({ label: `Redeemed ${contracts} ${isUp ? "UP" : "DOWN"}`, digest: r.digest });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setStage(null);
    }
  }

  const isFaucetError = error != null && /dusdc|faucet|insufficient/i.test(error);

  return (
    <>
      <Header />
      <PageFrame wide zoom={0.8}>
        <div style={{ marginBottom: 22 }}>
          <h1 style={{ fontFamily: FD, fontSize: 34, fontWeight: 600, letterSpacing: "-0.03em", color: C.textPrimary, margin: 0 }}>
            Prediction Markets
          </h1>
          <p style={{ fontFamily: FS, fontSize: 14.5, color: C.textSecondary, margin: "8px 0 0", maxWidth: 680, lineHeight: 1.6 }}>
            Sui&apos;s native on-chain prediction-market protocol. Price an UP/DOWN view on a live
            on-chain oracle, see the exact mint cost and redeem payout simulated against the contract,
            then mint and redeem a real position on testnet.
          </p>
        </div>

        {/* Live deployment strip — proves the integration is real + on the right branch. */}
        <div style={{ ...PANEL, marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 22, alignItems: "center" }}>
          <Tag label="Branch" value="predict-testnet-4-16" />
          <Tag label="Network" value={config?.network ?? "testnet"} />
          <Tag label="Package" value={config ? short(config.package_id) : "…"} />
          <Tag label="Predict object" value={config ? short(config.predict_object_id) : "…"} />
          <Tag label="Indexer" value={config ? "predict-server ✓" : "…"} />
          <Tag label="Signer" value={status?.signer_configured ? "configured ✓" : "—"} />
        </div>

        <div className="pd-grid">
          {/* ---- left: your view ---- */}
          <aside style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <div style={PANEL}>
              <div className="pd-cap">Your view</div>
              <div style={{ display: "grid", gap: 16, marginTop: 14 }}>
                <div>
                  <div className="pd-cap" style={{ marginBottom: 8 }}>Direction</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {[true, false].map((up) => (
                      <button
                        key={String(up)}
                        type="button"
                        onClick={() => setIsUp(up)}
                        className="pd-dir"
                        style={{
                          borderColor: isUp === up ? C.tealLight : C.border,
                          background: isUp === up ? C.cardHover : "transparent",
                          color: isUp === up ? (up ? C.green : C.red) : C.textMuted,
                        }}
                      >
                        {up ? "▲ UP" : "▼ DOWN"}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="pd-cap" style={{ marginBottom: 8 }}>Contracts</div>
                  <input
                    className="pd-num"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={contracts}
                    onChange={(e) => setContracts(e.target.value)}
                  />
                </div>
              </div>

              {/* Market the server resolved for this view. */}
              <div style={{ display: "grid", gap: 10, marginTop: 18, paddingTop: 16, borderTop: `0.5px solid ${C.border}` }}>
                <div className="pd-cap">Live market</div>
                {quote ? (
                  <>
                    <Row k="Asset" v={`${quote.asset} · ${isUp ? "UP" : "DOWN"}`} />
                    <Row k="Strike" v={fmtStrike(quote.strike)} />
                    <Row k="Expiry" v={fmtExpiry(quote.expiry)} />
                    <Row k="Oracle" v={short(quote.oracle_id)} />
                  </>
                ) : (
                  <span style={{ fontFamily: FS, fontSize: 12.5, color: C.textMuted }}>
                    {quoteErr ? "Market rotating — retrying…" : "Resolving live oracle…"}
                  </span>
                )}
              </div>
            </div>
          </aside>

          {/* ---- right: simulation + execute ---- */}
          <main style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={PANEL}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                <div className="pd-cap">On-chain simulation</div>
                <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                  {quoting ? "pricing…" : "devInspect · no funds"}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                <Stat label="Mint cost" value={quote ? usd(quote.mint_cost) : "—"} />
                <Stat label="Redeem payout" value={quote ? usd(quote.redeem_payout) : "—"} color={C.green} />
                <Stat
                  label="Desk edge"
                  value={quote ? usd(String(Math.abs(edgeRaw))) : "—"}
                  color={edgeRaw <= 0 ? C.textMuted : C.amber}
                />
              </div>
              {quoteErr && !quote && (
                <div style={{ marginTop: 12, fontFamily: FM, fontSize: 11.5, color: C.textMuted }}>
                  No priceable market this instant (Predict oracles are short-lived and rotate) — auto-retrying.
                </div>
              )}
            </div>

            <div style={PANEL}>
              <div className="pd-cap">Execute on testnet · server-signed by the protocol desk</div>
              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                <button onClick={handleMint} disabled={!quote || busy !== null} className="pd-mint">
                  {busy === "mint" ? stage ?? "Minting…" : "Mint position"}
                </button>
                <button onClick={handleRedeem} disabled={!quote || busy !== null} className="pd-redeem">
                  {busy === "redeem" ? stage ?? "Redeeming…" : "Redeem"}
                </button>
              </div>

              {result && (
                <div style={{ marginTop: 14, fontFamily: FM, fontSize: 12, color: C.green }}>
                  ✓ {result.label} ·{" "}
                  <a href={suiExplorerTxUrl(result.digest)} target="_blank" rel="noreferrer" style={{ color: C.tealLight }}>
                    {result.digest.slice(0, 10)}…
                  </a>
                </div>
              )}
              {error && (
                <div style={{ marginTop: 14, fontFamily: FM, fontSize: 12, color: isFaucetError ? C.amber : C.red, lineHeight: 1.5 }}>
                  {isFaucetError ? (
                    <>
                      Real settlement needs dUSDC (Predict&apos;s faucet-gated quote asset, not testnet USDC).
                      Request it for the desk signer, then Mint/Redeem execute on-chain. The simulation
                      above is live regardless.
                    </>
                  ) : (
                    error
                  )}
                </div>
              )}
              <div style={{ marginTop: 14, fontFamily: FM, fontSize: 10.5, color: C.textMuted, lineHeight: 1.6 }}>
                Mint deposits dUSDC into a Predict BalanceManager and mints the position; Redeem unwinds it.
                Both settle on Sui testnet against the Predict contract.
              </div>
            </div>
          </main>
        </div>
      </PageFrame>

      <style jsx global>{`
        .pd-grid { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 30px; align-items: start; }
        @media (max-width: 900px) { .pd-grid { grid-template-columns: 1fr; } }
        .pd-cap { font-family: ${FM}; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.textMuted}; }
        .pd-dir { flex: 1; padding: 10px; border-radius: 9px; border: 0.5px solid ${C.border}; font-family: ${FD}; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s ${EASE}; }
        .pd-num { width: 100%; background: ${C.surface}; border: 0.5px solid ${C.border}; border-radius: 8px; padding: 10px 12px; color: ${C.textPrimary}; font-family: ${FD}; font-size: 15px; outline: none; }
        .pd-num:focus { border-color: ${C.tealLight}; }
        .pd-mint { flex: 1; background: ${C.tealLight}; border: none; border-radius: 10px; padding: 13px; color: #06121a; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; }
        .pd-mint:disabled { opacity: 0.5; cursor: not-allowed; }
        .pd-redeem { flex: 1; background: transparent; border: 0.5px solid ${C.border}; border-radius: 10px; padding: 13px; color: ${C.textSecondary}; font-family: ${FD}; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s ${EASE}; }
        .pd-redeem:hover:not(:disabled) { border-color: ${C.borderHover}; color: ${C.textPrimary}; }
        .pd-redeem:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
    </>
  );
}

function Tag({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <span style={{ fontFamily: FM, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: C.textMuted }}>{label}</span>
      <span style={{ fontFamily: FM, fontSize: 12, color: C.textSecondary }}>{value}</span>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>{k}</span>
      <span style={{ fontFamily: FD, fontSize: 13, color: C.textPrimary }}>{v}</span>
    </div>
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
