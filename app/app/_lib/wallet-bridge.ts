"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { suiExplorerTxUrl, SUI_NETWORK } from "./chain";
import { BACKEND_URL } from "./tokens";

export interface WalletSigner {
  connected: boolean;
  address: string | null;
  /** Build (in the wallet), sign + execute a backend-prepared UNBUILT
   *  transaction (serialized JSON) with the connected wallet; resolves to the
   *  on-chain digest. */
  signAndExecute: (txJson: string) => Promise<string>;
}

/**
 * Real non-custodial signer backed by @mysten/dapp-kit. The address is the
 * user's connected wallet; signing happens in their wallet extension.
 */
export function useWalletSigner(): WalletSigner {
  const account = useCurrentAccount();
  const { mutateAsync } = useSignAndExecuteTransaction();

  const signAndExecute = useCallback(
    async (txJson: string): Promise<string> => {
      // The backend sends an UNBUILT transaction (serialized JSON). The connected
      // wallet builds it with its own gas coin, signs, and executes — the
      // standard dapp-kit flow that works for EVERY wallet type: seed-phrase,
      // hardware, and zkLogin / social login (Slush-with-Google). Nothing is
      // pre-built on our side, so no wallet ever has to re-process a fully-built
      // transaction (the failure mode that broke zkLogin signing).
      const tx = Transaction.from(txJson);
      // Pass the chain explicitly (e.g. "sui:testnet"). Some wallets — notably
      // zkLogin / social-login (Slush-with-Google) — need to be told which chain
      // to build the gas + sign against; without it their signer can fail with
      // an opaque error. This also guards against a wallet whose active network
      // differs from the dApp's.
      const res = await mutateAsync({
        transaction: tx,
        chain: `sui:${SUI_NETWORK}`,
      });
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

/**
 * Live dUSDC balance of the connected wallet — the asset DeepBook Predict
 * actually settles in (distribution / volatility / PPN / tranche / term
 * baskets). Distinct from {@link useUsdcBalance} (mUSDC, used by the vault /
 * basket products): a wallet can hold plenty of mUSDC and still be unable to
 * open a Predict structure, so these surfaces must gate on THIS balance.
 */
export function useDusdcBalance() {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const [state, setState] = useState({ uiAmount: 0, loading: false, error: null as string | null });
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
      const res = await fetch(`${BACKEND_URL}/api/dev/dusdc-balance/${address}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { dusdc?: number };
      setState({ uiAmount: Number(data.dusdc ?? 0), loading: false, error: null });
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, error: err instanceof Error ? err.message : String(err) }));
      window.setTimeout(() => void refresh(), 2_500);
    } finally {
      inFlight.current = false;
    }
  }, [address]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 8_000);
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

/**
 * Request a small dUSDC test grant for `address` from the operator float.
 * dUSDC is faucet-gated (it cannot be minted like mUSDC), so this transfers
 * from the operator wallet — letting anyone run the full Predict flow without
 * the manual DeepBook faucet form. Returns the tx digest.
 */
export async function airdropDusdc(address: string, amount = 25): Promise<{ digest: string; amount: number; explorer_url: string }> {
  const res = await fetch(`${BACKEND_URL}/api/dev/airdrop-dusdc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: address, amount }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * Combined "Test funds" grant — one operator tx that tops the wallet with mUSDC,
 * dUSDC, and 0.4 SUI for gas. Returns the dispensed amounts + tx digest.
 */
export async function faucetTestFunds(address: string): Promise<{
  digest: string;
  dusdc: number;
  musdc: number;
  sui: number;
  explorer_url: string;
}> {
  const res = await fetch(`${BACKEND_URL}/api/dev/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: address }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

export function explorerTxUrl(digest: string): string {
  return suiExplorerTxUrl(digest);
}
