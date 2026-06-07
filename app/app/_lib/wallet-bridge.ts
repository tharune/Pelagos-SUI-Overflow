"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { suiExplorerTxUrl } from "./chain";
import { BACKEND_URL } from "./tokens";

export interface WalletSigner {
  connected: boolean;
  address: string | null;
  /** Sign + execute a backend-built transaction (base64 tx bytes) with the
   *  connected wallet; resolves to the on-chain digest. */
  signAndExecute: (txBytesB64: string) => Promise<string>;
}

/**
 * Real non-custodial signer backed by @mysten/dapp-kit. The address is the
 * user's connected wallet; signing happens in their wallet extension.
 */
export function useWalletSigner(): WalletSigner {
  const account = useCurrentAccount();
  const { mutateAsync } = useSignAndExecuteTransaction();

  const signAndExecute = useCallback(
    async (txBytesB64: string): Promise<string> => {
      const tx = Transaction.from(fromBase64(txBytesB64));
      const res = await mutateAsync({ transaction: tx });
      return res.digest;
    },
    [mutateAsync],
  );

  return {
    connected: Boolean(account),
    address: account?.address ?? null,
    signAndExecute,
  };
}

/**
 * The wallet address the read flows (portfolio, positions, tx history) read.
 * It is the connected wallet, or an empty string when nothing is connected.
 *
 * Disconnected returns "" on purpose: every read flow guards on a falsy address
 * and renders an empty "connect your wallet" state, so a visitor never sees the
 * deployer's positions (or the NaN that synthetic deployer rows produced).
 */
export function useActiveWalletAddress(): string {
  const account = useCurrentAccount();
  return account?.address ?? "";
}

export function useUsdcBalance() {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const [state, setState] = useState({
    uiAmount: 0,
    loading: false,
    error: null as string | null,
  });

  // Guards against overlapping refreshes — the 15s poll and any post-write
  // refresh() share this flag so a slow status call can't stack requests.
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    if (!address) {
      setState({ uiAmount: 0, loading: false, error: null });
      return;
    }
    inFlight.current = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      // Real mUSDC balance of the CONNECTED wallet (not the deployer).
      const res = await fetch(`${BACKEND_URL}/api/dev/balances/${address}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { usdc?: number };
      setState({ uiAmount: Number(data.usdc ?? 0), loading: false, error: null });
    } catch (err) {
      // KEEP the last-known balance on a transient failure (e.g. an RPC blip or
      // a rate-limited burst on a busy page) — never flash $0, which would
      // wrongly trip "Insufficient USDC". A quick retry + the poll self-correct.
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      window.setTimeout(() => void refresh(), 2_500);
    } finally {
      inFlight.current = false;
    }
  }, [address]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 8_000);
    // Re-check when the user returns to the tab (e.g. after signing in-wallet).
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { ...state, refresh };
}

export function explorerTxUrl(digest: string): string {
  return suiExplorerTxUrl(digest);
}
