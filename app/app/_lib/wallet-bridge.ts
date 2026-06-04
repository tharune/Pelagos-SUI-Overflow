"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SUI_ACTIVE_ADDRESS, suiExplorerTxUrl } from "./chain";
import { fetchSuiStatus, sumSuiCoinBalance } from "./sui-client";

export function useWalletSigner() {
  return {
    connected: Boolean(SUI_ACTIVE_ADDRESS),
    address: SUI_ACTIVE_ADDRESS || null,
  };
}

export function useUsdcBalance() {
  const [state, setState] = useState({
    uiAmount: 0,
    loading: false,
    error: null as string | null,
  });

  // Guards against overlapping refreshes — the 15s poll and any post-write
  // refresh() share this flag so a slow status call can't stack requests
  // against the backend / testnet RPC.
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const status = await fetchSuiStatus();
      const uiAmount = sumSuiCoinBalance(status.balances?.mock_usdc);
      setState({ uiAmount, loading: false, error: null });
    } catch (err) {
      setState({
        uiAmount: 0,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight.current = false;
    }
  }, []);

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
