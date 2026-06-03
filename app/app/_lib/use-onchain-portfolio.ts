"use client";
/**
 * On-chain portfolio aggregator.
 *
 * Pulls the three position families every /app/portfolio row needs —
 * basket holdings, tranche notes, and plain PPN vaults — directly from
 * chain + backend, with no dependency on the in-memory sandbox reducer.
 * The portfolio page subscribes to this hook and re-renders whenever
 * any of the underlying sources tick.
 *
 * Sources:
 *   - `usePbuBalances()` → on-chain PBU unit balances per bundle,
 *     polled every 15 s. Each bundle's backend NAV is used to price
 *     the position. `uiAmount === 0` rows are filtered out so the
 *     portfolio only shows real holdings.
 *   - `fetchPpnPortfolio(wallet)` → every PPN note (active + matured)
 *     for the wallet, including tranche-overlay metadata. We split
 *     entries with `tranche_kind` set into the tranche bucket and the
 *     rest into the PPN bucket.
 *   - `fetchTransactionHistory(wallet)` → the backend-persisted deposit
 *     log. We use it to compute a weighted average entry price per
 *     bundle so the UI can show "+/- $X since entry" next to each
 *     basket row. Redemptions are ignored for avg-cost purposes so
 *     the number tracks the user's realized entry, not a moving-target
 *     mark.
 *
 * Refresh semantics: the hook polls on its own, but the consumer can
 * also call `refresh()` right after a deposit or redeem confirms so
 * the UI doesn't wait up to 15 s for the next poll.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  usePbuBalances,
  fetchTransactionHistory,
  type PbuBalanceEntry,
  type TransactionRow,
} from "./portfolio-client";
import { fetchPpnPortfolio, type PpnPortfolioEntry } from "./ppn-client";
import { SUI_ACTIVE_ADDRESS } from "./chain";

// ---------- Derived position types ----------

export interface BasketPositionOnchain {
  /** Backend bundle UUID. Matches PBU-balance bundleId. */
  bundleId: string;
  /** UI-visible bundle label, e.g. "PBU-HIGH-SHORT". */
  bundleName: string;
  /** PBU units held (UI units). */
  qty: number;
  /** Backend NAV at poll time — used for the current mark. */
  nav: number;
  /**
   * Weighted avg entry cost per token derived from deposit history.
   * Null if no deposit rows are available yet (still loading or pure
   * side-channel transfer in).
   */
  avgCost: number | null;
  /** Current mark-to-backend-NAV value (qty × nav). */
  valueUsd: number;
  /** Tier tag (90 / 70 / 50) parsed from the bundle name. */
  tier: 90 | 70 | 50 | null;
  /** Passed through so the UI can dim resolved / cancelled baskets. */
  status: PbuBalanceEntry["status"];
}

export interface TranchePositionOnchain {
  /** PPN note id that owns this tranche position. Used for redeem. */
  vaultId: string;
  /** Backend bundle UUID the tranche sits on. */
  bundleId: string;
  /** UI-visible bundle label. */
  bundleName: string;
  /** 'senior' / 'mezzanine' / 'junior'. */
  kind: "senior" | "mezzanine" | "junior";
  /** Attach / detach fractions, 0-1. */
  attach: number;
  detach: number;
  /** Principal locked in the note — face value of the tranche. */
  principalUsdc: number;
  /** Yield accrued on this tranche since inception. */
  accruedYield: number;
  /** Current value = principal + accrued yield. */
  totalValue: number;
  /** Note APY the tranche was issued at. */
  apy: number;
  maturityDays: number;
  daysElapsed: number;
  daysRemaining: number;
  status: PpnPortfolioEntry["status"];
  createdAt: string;
}

export interface PpnVaultOnchain {
  vaultId: string;
  bundleId: string;
  bundleName: string;
  principalUsdc: number;
  accruedYield: number;
  totalValue: number;
  apy: number;
  maturityDays: number;
  daysElapsed: number;
  daysRemaining: number;
  status: PpnPortfolioEntry["status"];
  createdAt: string;
}

export interface OnchainPortfolioTotals {
  basketValue: number;
  trancheValue: number;
  ppnValue: number;
  totalValue: number;
  unrealizedPnl: number;
}

export interface OnchainPortfolio {
  loading: boolean;
  error: string | null;
  baskets: BasketPositionOnchain[];
  tranches: TranchePositionOnchain[];
  ppns: PpnVaultOnchain[];
  totals: OnchainPortfolioTotals;
  /** Force-refresh all sources. Call after a tx confirms. */
  refresh: () => Promise<void>;
}

// ---------- Helpers ----------

const PPN_POLL_MS = 15_000;

function tierFromName(name: string): 90 | 70 | 50 | null {
  const upper = name.toUpperCase();
  if (/-90-|HIGH/.test(upper)) return 90;
  if (/-70-|MID/.test(upper)) return 70;
  if (/-50-|LOW/.test(upper)) return 50;
  return null;
}

/**
 * Build a `bundleId → weighted avg cost` map from the deposit history.
 * We skip non-deposit rows and any row missing tokens so a bad row
 * can't divide by zero. Anything this function can't compute is left
 * absent from the map; the caller treats absent → `avgCost: null`.
 */
function buildAvgCostMap(rows: TransactionRow[]): Map<string, number> {
  const acc = new Map<string, { usd: number; tokens: number }>();
  for (const row of rows) {
    if (row.type !== "deposit") continue;
    if (!row.tokens || row.tokens <= 0) continue;
    if (!row.amount_usdc || row.amount_usdc <= 0) continue;
    const prev = acc.get(row.bundle_id) ?? { usd: 0, tokens: 0 };
    prev.usd += row.amount_usdc;
    prev.tokens += row.tokens;
    acc.set(row.bundle_id, prev);
  }
  const out = new Map<string, number>();
  for (const [bundleId, agg] of acc) {
    if (agg.tokens > 0) out.set(bundleId, agg.usd / agg.tokens);
  }
  return out;
}

// ---------- Hook ----------

export function useOnchainPortfolio(): OnchainPortfolio {
  const pbuBalances = usePbuBalances();
  const walletAddress = SUI_ACTIVE_ADDRESS;

  // --- Transaction history (for avg cost per basket) ----------------
  const [txRows, setTxRows] = useState<TransactionRow[]>([]);
  const [txError, setTxError] = useState<string | null>(null);
  const loadTxHistory = useCallback(async () => {
    if (!walletAddress) {
      setTxRows([]);
      return;
    }
    try {
      const rows = await fetchTransactionHistory(walletAddress);
      setTxRows(rows);
      setTxError(null);
    } catch (err) {
      // Tx history is a nice-to-have (avg-cost label only). We swallow
      // the error rather than failing the whole portfolio render.
      setTxError(err instanceof Error ? err.message : String(err));
      setTxRows([]);
    }
  }, [walletAddress]);
  useEffect(() => {
    void loadTxHistory();
  }, [loadTxHistory]);

  // --- PPN portfolio (vaults + tranches) ---------------------------
  const [ppnEntries, setPpnEntries] = useState<PpnPortfolioEntry[]>([]);
  const [ppnLoading, setPpnLoading] = useState(false);
  const [ppnError, setPpnError] = useState<string | null>(null);
  const loadPpn = useCallback(async () => {
    if (!walletAddress) {
      setPpnEntries([]);
      return;
    }
    setPpnLoading(true);
    try {
      const portfolio = await fetchPpnPortfolio(walletAddress);
      setPpnEntries(portfolio.vaults);
      setPpnError(null);
    } catch (err) {
      // An empty wallet returns 200 + an empty vault list; actual
      // failures (backend down) surface here as a soft error so the
      // rest of the page still renders.
      setPpnError(err instanceof Error ? err.message : String(err));
      setPpnEntries([]);
    } finally {
      setPpnLoading(false);
    }
  }, [walletAddress]);
  useEffect(() => {
    void loadPpn();
    if (!walletAddress) return;
    const id = setInterval(() => void loadPpn(), PPN_POLL_MS);
    return () => clearInterval(id);
  }, [loadPpn, walletAddress]);

  // --- Derive baskets -----------------------------------------------
  const baskets = useMemo<BasketPositionOnchain[]>(() => {
    const avgCostMap = buildAvgCostMap(txRows);
    return pbuBalances.balances
      // Only show bundles the wallet actually holds. `uiAmount === 0`
      // covers both "initialized but nothing bought yet" and
      // "fully redeemed" cases — either way it doesn't belong on the
      // portfolio page.
      .filter((b) => b.uiAmount > 1e-9)
      .map<BasketPositionOnchain>((b) => ({
        bundleId: b.bundleId,
        bundleName: b.bundleName,
        qty: b.uiAmount,
        nav: b.nav,
        avgCost: avgCostMap.get(b.bundleId) ?? null,
        valueUsd: b.valueAtNavUsd,
        tier: tierFromName(b.bundleName),
        status: b.status,
      }));
  }, [pbuBalances.balances, txRows]);

  // --- Derive tranches vs plain PPNs --------------------------------
  const { tranches, ppns } = useMemo<{
    tranches: TranchePositionOnchain[];
    ppns: PpnVaultOnchain[];
  }>(() => {
    const tr: TranchePositionOnchain[] = [];
    const pn: PpnVaultOnchain[] = [];
    for (const e of ppnEntries) {
      // Only surface live positions. Matured + withdrawn notes already
      // paid out; showing them as open positions would mislead the
      // user about current exposure.
      if (e.status !== "active") continue;
      const base = {
        vaultId: e.vault_id,
        bundleId: e.bundle_id,
        bundleName: e.bundle_name,
        principalUsdc: e.principal_usdc,
        accruedYield: e.accrued_yield,
        totalValue: e.total_value,
        apy: e.estimated_apy,
        maturityDays: e.days_elapsed + e.days_remaining,
        daysElapsed: e.days_elapsed,
        daysRemaining: e.days_remaining,
        status: e.status,
        createdAt: e.created_at,
      };
      if (
        e.tranche_kind &&
        typeof e.tranche_attach === "number" &&
        typeof e.tranche_detach === "number"
      ) {
        tr.push({
          ...base,
          kind: e.tranche_kind,
          attach: e.tranche_attach,
          detach: e.tranche_detach,
        });
      } else {
        pn.push(base);
      }
    }
    return { tranches: tr, ppns: pn };
  }, [ppnEntries]);

  // --- Totals --------------------------------------------------------
  const totals = useMemo<OnchainPortfolioTotals>(() => {
    const basketValue = baskets.reduce((s, p) => s + p.valueUsd, 0);
    const trancheValue = tranches.reduce((s, p) => s + p.totalValue, 0);
    const ppnValue = ppns.reduce((s, p) => s + p.totalValue, 0);
    const unrealizedPnl = baskets.reduce((s, p) => {
      if (p.avgCost == null) return s;
      return s + p.qty * (p.nav - p.avgCost);
    }, 0);
    return {
      basketValue,
      trancheValue,
      ppnValue,
      totalValue: basketValue + trancheValue + ppnValue,
      unrealizedPnl,
    };
  }, [baskets, tranches, ppns]);

  // --- Composite refresh --------------------------------------------
  const refresh = useCallback(async () => {
    await Promise.all([pbuBalances.refresh(), loadPpn(), loadTxHistory()]);
  }, [pbuBalances, loadPpn, loadTxHistory]);

  const loading = pbuBalances.loading || ppnLoading;
  const error = pbuBalances.error ?? ppnError ?? txError;

  return {
    loading,
    error,
    baskets,
    tranches,
    ppns,
    totals,
    refresh,
  };
}
