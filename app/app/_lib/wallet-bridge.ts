"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SUI_ACTIVE_ADDRESS, suiExplorerTxUrl } from "./chain";
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
 * The wallet address the read flows (portfolio, positions, tx history) should
 * show. When a wallet is connected, that's the connected wallet; otherwise we
 * fall back to the configured demo address (NEXT_PUBLIC_SUI_ACTIVE_ADDRESS) so
 * an unconnected visitor still sees the seeded sample portfolio.
 *
 * Read flows MUST use this instead of SUI_ACTIVE_ADDRESS directly — otherwise a
 * connected user would see the deployer's positions instead of their own (the
 * write paths already key everything on the connected wallet).
 */
export function useActiveWalletAddress(): string {
  const account = useCurrentAccount();
  return account?.address ?? SUI_ACTIVE_ADDRESS;
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
      const data = (await res.json()) as { usdc?: number };
      setState({ uiAmount: Number(data.usdc ?? 0), loading: false, error: null });
    } catch (err) {
      setState({
        uiAmount: 0,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight.current = false;
    }
  }, [address]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refresh]);

  return { ...state, refresh };
}

export function explorerTxUrl(digest: string): string {
  return suiExplorerTxUrl(digest);
}
