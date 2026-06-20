"use client";
/**
 * Portfolio client — reads on-chain token balances for every initialized
 * bundle so the UI can display "you hold N PBU units of bundle X" straight
 * from the chain rather than from sandbox state.
 *
 * The list of bundles and on-chain identifiers still comes from the backend
 * `/api/bundles` endpoint. Pelagos/Sui position accounting is handled by the
 * local Sui ledger used by the product pages.
 */

import { useEffect, useMemo, useState } from "react";
import { BACKEND_URL } from "./tokens";

// ---------- Bundle list ----------

export interface BundleOnchainRow {
  id: string;
  name: string;
  risk_tier: 90 | 70 | 50;
  status: "active" | "resolved" | "cancelled";
  issue_price: number;
  nav: number;
  num_legs: number;
  resolved_legs: number;
  onchain_tx_signature: string | null;
}

let _bundleList: Promise<BundleOnchainRow[]> | null = null;

/**
 * Fetch /api/bundles (cached for the session). Pass `force=true` to
 * invalidate, e.g. after an admin init-onchain call runs.
 */
export function listBundlesOnchain(
  force: boolean = false,
): Promise<BundleOnchainRow[]> {
  if (force) _bundleList = null;
  if (_bundleList) return _bundleList;
  _bundleList = (async () => {
    const res = await fetch(`${BACKEND_URL}/api/bundles`);
    if (!res.ok) {
      _bundleList = null;
      throw new Error(`Failed to load /api/bundles (HTTP ${res.status})`);
    }
    return (await res.json()) as BundleOnchainRow[];
  })();
  return _bundleList;
}

// ---------- PBU balance hook ----------

export interface PbuBalanceEntry {
  bundleId: string;
  /** UI bundle name, e.g. "PBU-HIGH-SHORT". */
  bundleName: string;
  /** UI units of PBU held by the user. */
  uiAmount: number;
  /** Raw base units (6-decimals). */
  amountRaw: bigint;
  /** Notional value at the bundle's current NAV. */
  valueAtNavUsd: number;
  nav: number;
  status: BundleOnchainRow["status"];
}

/**
 * PBU bundle metadata for the active Sui session.
 *
 * - Bundles are included with `uiAmount: 0` so the UI can render catalog
 *   rows even before local Sui holdings are grouped.
 * - Call `refresh()` to force an immediate re-fetch after a write.
 */
export function usePbuBalances(): {
  loading: boolean;
  error: string | null;
  balances: PbuBalanceEntry[];
  /** Convenience: total USD value across all bundles (at current NAV). */
  totalValueUsd: number;
  refresh: () => Promise<void>;
} {
  const [bundles, setBundles] = useState<BundleOnchainRow[] | null>(null);
  const [balances, setBalances] = useState<PbuBalanceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // Load the bundle list once (cached).
  useEffect(() => {
    let cancelled = false;
    listBundlesOnchain()
      .then((rows) => {
        if (!cancelled) setBundles(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rebuild zero-balance metadata whenever bundle rows refresh. The visible
  // Sui holdings are grouped from local position objects in the portfolio page.
  useEffect(() => {
    if (!bundles) return;
    setBalances(
      bundles.map((b) => ({
        bundleId: b.id,
        bundleName: b.name,
        uiAmount: 0,
        amountRaw: 0n,
        valueAtNavUsd: 0,
        nav: b.nav,
        status: b.status,
      })),
    );
    setLoading(false);
    setError(null);
  }, [bundles, refreshToken]);

  const refresh = useMemo(
    () =>
      async (): Promise<void> => {
        // Invalidate the module-level cache and bump the local token so the
        // inner effect re-runs.
        await listBundlesOnchain(true).then((rows) => setBundles(rows));
        setRefreshToken((n) => n + 1);
      },
    [],
  );

  const totalValueUsd = balances.reduce((s, b) => s + b.valueAtNavUsd, 0);

  return { loading, error, balances, totalValueUsd, refresh };
}

// ---------- Transaction history passthrough ----------

export interface TransactionRow {
  id: string;
  bundle_id: string;
  bundle_name?: string;
  wallet_address: string;
  type: "deposit" | "redemption" | "transfer";
  amount_usdc: number;
  tokens: number;
  fee_usdc: number;
  tx_signature?: string;
  onchain_tx_signature?: string;
  created_at: string;
}

// ---------- Basket portfolio (backend hydrate) ----------

/** Shape expected by demo-state's `basket/hydrate` action. */
export interface BasketPositionHydrate {
  bundleId: string;
  qty: number;
  avgCost: number;
  tier?: 90 | 70 | 50;
  navHint?: number;
  displayName?: string;
  maturityAt?: number;
  status?: string;
}

interface BackendPositionRow {
  position_id: string;
  bundle_id: string;
  bundle_name: string;
  bundle_status: string;
  risk_tier: number;
  resolution_date: string | null;
  tokens_held: number;
  entry_price: number;
  deposited_usdc: number;
  current_nav: number;
  current_value: number;
  unrealized_pnl: number;
  pnl_percent: number;
  created_at: string;
}

function normalizeTier(raw: number): 90 | 70 | 50 | undefined {
  if (raw === 90 || raw === 70 || raw === 50) return raw;
  return undefined;
}

/**
 * Fetch the wallet's basket positions from the backend
 * (`/api/deposit/portfolio/:wallet`) and map each row into the `BasketPosition`
 * shape the demo-state reducer expects. The portfolio page dispatches the
 * result as `{ type: "basket/hydrate", positions }` so the in-memory state
 * reflects the latest Supabase truth whenever the wallet reconnects.
 *
 * - `qty` is tokens_held (PBU) — not USDC.
 * - `avgCost` is entry_price (USDC per token) — the deposit-time NAV.
 * - `navHint` is the backend's current NAV for display; real pricing still
 *   comes from the live feed when the portfolio row is rendered.
 */
export async function fetchBasketPortfolio(
  walletAddress: string,
): Promise<BasketPositionHydrate[]> {
  const res = await fetch(
    `${BACKEND_URL}/api/deposit/portfolio/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch basket portfolio (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { positions?: BackendPositionRow[] };
  const rows = data.positions ?? [];
  // Aggregate by bundle_id. The backend stores one row per deposit (so a
  // bundle the user bought into three times has three rows), but the
  // reducer's `basketPositions` is keyed on bundleId — and downstream
  // consumers (`onchainBasketValue`, `onchainBasketPnl`, card render) do
  // `.find(p => p.bundleId === ...)` which only picks the first match.
  // Without merging, subsequent deposits silently disappear from the
  // portfolio value once hydrate overwrites the reducer.
  //
  // Aggregation math (dollar-weighted avg cost):
  //   total_qty    = Σ tokens_held
  //   total_spend  = Σ deposited_usdc (backend pro-rates this on
  //                  partial redeems, so it stays the true remaining
  //                  cost basis across a row's history)
  //   avgCost      = total_spend / total_qty    ← \$/token paid
  type Agg = {
    bundleId: string;
    qty: number;
    spend: number;
    navHint?: number;
    tier?: 90 | 70 | 50;
    displayName?: string;
    maturityAt?: number;
    status?: string;
    // Fallback when no row has deposited_usdc (legacy rows).
    fallbackAvg?: number;
  };
  const byBundle = new Map<string, Agg>();
  for (const p of rows) {
    if (p.tokens_held <= 1e-9) continue;
    const existing = byBundle.get(p.bundle_id);
    if (existing) {
      existing.qty += p.tokens_held;
      existing.spend += p.deposited_usdc;
      // Latest row wins for display metadata (nav/maturity/status).
      existing.navHint = p.current_nav;
      existing.status = p.bundle_status;
      existing.maturityAt = p.resolution_date
        ? Date.parse(p.resolution_date)
        : existing.maturityAt;
      if (existing.fallbackAvg === undefined) existing.fallbackAvg = p.entry_price;
    } else {
      byBundle.set(p.bundle_id, {
        bundleId: p.bundle_id,
        qty: p.tokens_held,
        spend: p.deposited_usdc,
        tier: normalizeTier(p.risk_tier),
        navHint: p.current_nav,
        displayName: p.bundle_name,
        maturityAt: p.resolution_date ? Date.parse(p.resolution_date) : undefined,
        status: p.bundle_status,
        fallbackAvg: p.entry_price,
      });
    }
  }
  return Array.from(byBundle.values()).map<BasketPositionHydrate>((a) => ({
    bundleId: a.bundleId,
    qty: a.qty,
    // `entry_price` in the backend row is the **live Polymarket NAV at
    // deposit time**, not the USDC-per-token the user actually paid.
    // The chain mints at the vault's fixed `issue_price_bps`, so the real
    // cost basis is `deposited_usdc / tokens_held`. Using entry_price
    // made the portfolio's top-line drift up by the NAV-vs-issue spread
    // on every purchase. Fall back to entry_price for legacy rows that
    // were written before deposited_usdc was persisted.
    avgCost:
      a.qty > 1e-9 && a.spend > 0
        ? a.spend / a.qty
        : a.fallbackAvg ?? 0,
    tier: a.tier,
    navHint: a.navHint,
    displayName: a.displayName,
    maturityAt: a.maturityAt,
    status: a.status,
  }));
}
