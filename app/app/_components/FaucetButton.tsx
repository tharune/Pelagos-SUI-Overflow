"use client";

import { useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { BACKEND_URL } from "../_lib/tokens";
import { C, FM } from "../_lib/tokens";

/**
 * Testnet faucet — mints mock USDC to the connected wallet so a fresh wallet
 * can actually deposit. Only shown when a wallet is connected.
 */
export function FaucetButton() {
  const account = useCurrentAccount();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!account) return null;

  async function getUsdc() {
    if (!account) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/dev/airdrop-mock-usdc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: account.address, amount: 1000 }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMsg("+1,000 mUSDC");
      setTimeout(() => setMsg(null), 3000);
    } catch (e) {
      setMsg((e as Error).message.slice(0, 36));
      setTimeout(() => setMsg(null), 4000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={getUsdc}
      disabled={busy}
      title="Mint 1,000 testnet mUSDC to your connected wallet"
      style={{
        height: 32,
        padding: "0 12px",
        borderRadius: 8,
        border: `0.5px solid ${C.border}`,
        background: C.surface,
        color: C.textSecondary,
        fontFamily: FM,
        fontSize: 11,
        letterSpacing: "0.02em",
        cursor: busy ? "default" : "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {busy ? "Minting…" : msg ?? "Get test mUSDC"}
    </button>
  );
}
