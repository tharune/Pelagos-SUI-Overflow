"use client";

import React, { useState } from "react";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { useActiveWalletAddress, faucetTestFunds } from "../_lib/wallet-bridge";
import { suiExplorerTxUrl } from "../_lib/chain";

// What a single Mint hands out. Kept in sync with the backend dispenseTestFunds.
const GRANTS: Array<{ asset: string; amount: string; use: string; color: string }> = [
  { asset: "dUSDC", amount: "25", use: "DeepBook Predict quote — distribution, volatility, PPN, tranches", color: C.tealLight },
  { asset: "mUSDC", amount: "10,000", use: "Vault collateral — baskets & risk slices", color: C.blue },
  { asset: "SUI", amount: "0.05", use: "Gas, so you can sign your first transaction", color: C.violet },
];

/**
 * Header "Test funds" faucet. The button sits in the top bar; clicking it opens
 * a modal that spells out exactly what the faucet will send (every asset, amount
 * and what it's for), then a single Mint button dispenses all three in one
 * operator transaction. Testnet only.
 */
export function HeaderFaucet() {
  const address = useActiveWalletAddress();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ digest: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!address) return null;

  async function mint() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await faucetTestFunds(address);
      setDone({ digest: r.digest });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setOpen(false);
    // reset after the close transition so a reopen starts fresh
    window.setTimeout(() => {
      setDone(null);
      setErr(null);
    }, 200);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Get testnet funds (dUSDC, mUSDC, SUI)"
        style={{
          appearance: "none",
          height: 32,
          padding: "0 12px",
          borderRadius: 8,
          border: `0.5px solid ${C.tealLight}66`,
          background: `${C.tealLight}14`,
          color: C.tealLight,
          cursor: "pointer",
          fontFamily: FM,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.03em",
          whiteSpace: "nowrap",
          transition: `background 0.15s ${EASE}`,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = `${C.tealLight}22`)}
        onMouseLeave={(e) => (e.currentTarget.style.background = `${C.tealLight}14`)}
      >
        Test funds
      </button>

      {open && (
        <div
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(2,6,10,0.62)",
            backdropFilter: "blur(3px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(460px, 100%)",
              borderRadius: 14,
              border: `0.5px solid ${C.border}`,
              background: C.card,
              boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
              padding: 22,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
              <span style={{ fontFamily: FM, fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: C.textMuted }}>
                Testnet faucet
              </span>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                style={{ appearance: "none", border: "none", background: "transparent", color: C.textMuted, cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 2 }}
              >
                ✕
              </button>
            </div>
            <h3 style={{ fontFamily: FD, fontSize: 18, fontWeight: 640, color: C.textPrimary, margin: "0 0 4px" }}>
              Get test funds
            </h3>
            <p style={{ fontFamily: FS, fontSize: 12.5, color: C.textSecondary, lineHeight: 1.55, margin: "0 0 16px" }}>
              One transaction sends your connected wallet everything you need to run the full app — listed below. Nothing leaves your wallet.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              {GRANTS.map((g) => (
                <div
                  key={g.asset}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    gap: 12,
                    alignItems: "center",
                    border: `0.5px solid ${C.border}`,
                    borderRadius: 10,
                    padding: "11px 13px",
                    background: C.surface,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 96 }}>
                    <strong style={{ fontFamily: FD, fontSize: 16, fontWeight: 660, color: g.color, fontVariantNumeric: "tabular-nums" }}>
                      {g.amount}
                    </strong>
                    <span style={{ fontFamily: FM, fontSize: 10.5, fontWeight: 600, color: g.color }}>{g.asset}</span>
                  </div>
                  <span style={{ fontFamily: FS, fontSize: 11.5, color: C.textMuted, lineHeight: 1.45 }}>{g.use}</span>
                </div>
              ))}
            </div>

            {done ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontFamily: FM, fontSize: 12, color: C.green, lineHeight: 1.5 }}>
                  ✓ Funds sent to your wallet ·{" "}
                  <a href={suiExplorerTxUrl(done.digest)} target="_blank" rel="noreferrer" style={{ color: C.tealLight }}>
                    {done.digest.slice(0, 10)}… ↗
                  </a>
                </div>
                <button type="button" onClick={close} style={ghostBtn}>
                  Done
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={mint}
                disabled={busy}
                style={{
                  width: "100%",
                  height: 44,
                  borderRadius: 10,
                  border: "none",
                  cursor: busy ? "progress" : "pointer",
                  fontFamily: FD,
                  fontSize: 14,
                  fontWeight: 620,
                  color: "#03111d",
                  background: C.tealLight,
                  opacity: busy ? 0.65 : 1,
                  transition: `opacity 0.15s ${EASE}`,
                }}
              >
                {busy ? "Minting…" : "Mint test funds"}
              </button>
            )}
            {err && <div style={{ marginTop: 10, fontFamily: FM, fontSize: 11, color: C.red, lineHeight: 1.5 }}>{err}</div>}
          </div>
        </div>
      )}
    </>
  );
}

const ghostBtn: React.CSSProperties = {
  width: "100%",
  height: 40,
  borderRadius: 10,
  border: `0.5px solid ${C.border}`,
  background: "transparent",
  color: C.textPrimary,
  cursor: "pointer",
  fontFamily: FD,
  fontSize: 13,
  fontWeight: 600,
};
