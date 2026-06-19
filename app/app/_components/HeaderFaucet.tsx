"use client";

import React, { useState } from "react";
import { C, FM, EASE } from "../_lib/tokens";
import { useActiveWalletAddress, airdropDusdc, airdropMockUsdc } from "../_lib/wallet-bridge";

const DUSDC_GRANT = 25; // dUSDC is faucet-gated (operator float) — small grant per click
const MUSDC_GRANT = 10_000; // mUSDC mints freely — generous for vault / basket testing

/**
 * Header test-funds faucet. One click tops the connected wallet with BOTH
 * settlement assets the app uses:
 *   • 25 dUSDC   — DeepBook Predict quote (distribution / volatility / PPN /
 *                  tranche / PLP); faucet-gated, dispensed from the operator float.
 *   • 10,000 mUSDC — the freely-mintable collateral for the vault / basket products.
 * Testnet only; sits next to the wallet so UAT never stalls on funding.
 */
export function HeaderFaucet() {
  const address = useActiveWalletAddress();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!address) return null;

  async function run() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const [dusdc, musdc] = await Promise.allSettled([
      airdropDusdc(address, DUSDC_GRANT),
      airdropMockUsdc(address, MUSDC_GRANT),
    ]);
    const parts: string[] = [];
    if (dusdc.status === "fulfilled") parts.push(`+${DUSDC_GRANT} dUSDC`);
    if (musdc.status === "fulfilled") parts.push(`+${MUSDC_GRANT.toLocaleString()} mUSDC`);
    if (parts.length) {
      setMsg(parts.join(" · "));
      window.setTimeout(() => setMsg(null), 6000);
    }
    const fail = [dusdc, musdc].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (fail) setErr(fail.reason instanceof Error ? fail.reason.message : String(fail.reason));
    setBusy(false);
  }

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        title="Testnet: sends 25 dUSDC (Predict) + 10,000 mUSDC (vaults/baskets) to your wallet"
        style={{
          appearance: "none",
          height: 32,
          padding: "0 12px",
          borderRadius: 8,
          border: `0.5px solid ${C.tealLight}66`,
          background: `${C.tealLight}14`,
          color: C.tealLight,
          cursor: busy ? "default" : "pointer",
          fontFamily: FM,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.03em",
          whiteSpace: "nowrap",
          opacity: busy ? 0.6 : 1,
          transition: `background 0.15s ${EASE}, opacity 0.15s ${EASE}`,
        }}
      >
        {busy ? "Funding…" : "Test funds"}
      </button>
      {(msg || err) && (
        <div
          style={{
            position: "absolute",
            top: 38,
            right: 0,
            zIndex: 50,
            padding: "7px 10px",
            borderRadius: 7,
            border: `0.5px solid ${err ? C.red : C.tealLight}55`,
            background: C.card,
            color: err ? C.red : C.green,
            fontFamily: FM,
            fontSize: 10.5,
            lineHeight: 1.5,
            whiteSpace: "nowrap",
            boxShadow: "0 12px 30px rgba(0,0,0,0.34)",
          }}
        >
          {err ? err.slice(0, 80) : `Sent ${msg}`}
        </div>
      )}
    </div>
  );
}
