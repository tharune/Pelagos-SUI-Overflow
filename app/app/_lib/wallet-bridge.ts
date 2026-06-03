"use client";

import { useCallback, useEffect, useState } from "react";
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

  const refresh = useCallback(async () => {
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
