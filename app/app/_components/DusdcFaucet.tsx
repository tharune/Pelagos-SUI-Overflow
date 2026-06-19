"use client";

import React, { useState } from "react";
import { C, FM, EASE } from "../_lib/tokens";
import { airdropDusdc } from "../_lib/wallet-bridge";
import { suiExplorerTxUrl } from "../_lib/chain";

/**
 * "Get test dUSDC" affordance.
 *
 * dUSDC is the only asset DeepBook Predict settles in and — unlike mUSDC — is
 * faucet-gated, so a freshly-connected wallet can't open any Predict structure
 * until it holds some. This grants a small float from the operator wallet in
 * one click, so the whole flow (quote → open → settle) is testable without the
 * manual DeepBook faucet form. Testnet only.
 */
export function DusdcFaucetButton({
  address,
  amount = 25,
  onFunded,
  compact = false,
}: {
  address: string | null;
  amount?: number;
  onFunded?: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!address || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await airdropDusdc(address, amount);
      setDigest(r.digest);
      // Give the fullnode a beat to index the new coin, then refresh the balance.
      setTimeout(() => onFunded?.(), 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!address) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        title="Transfers a small dUSDC test grant from the operator wallet (testnet)"
        style={{
          appearance: "none",
          height: compact ? 28 : 32,
          padding: compact ? "0 12px" : "0 14px",
          borderRadius: 7,
          border: `0.5px solid ${C.tealLight}66`,
          background: `${C.tealLight}14`,
          color: C.tealLight,
          cursor: busy ? "default" : "pointer",
          fontFamily: FM,
          fontSize: compact ? 10.5 : 11.5,
          fontWeight: 600,
          letterSpacing: "0.02em",
          opacity: busy ? 0.6 : 1,
          transition: `background 0.15s ${EASE}, opacity 0.15s ${EASE}`,
          width: "fit-content",
        }}
      >
        {busy ? "Sending…" : `Get ${amount} test dUSDC`}
      </button>
      {digest && (
        <span style={{ fontFamily: FM, fontSize: 10.5, color: C.green }}>
          ✓ {amount} dUSDC sent ·{" "}
          <a href={suiExplorerTxUrl(digest)} target="_blank" rel="noreferrer" style={{ color: C.tealLight }}>
            {digest.slice(0, 8)}… ↗
          </a>
        </span>
      )}
      {err && <span style={{ fontFamily: FM, fontSize: 10.5, color: C.red, lineHeight: 1.5 }}>{err}</span>}
    </div>
  );
}
