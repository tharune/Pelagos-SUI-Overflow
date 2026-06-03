/**
 * Shared API helpers for talking to the Pelagos Express backend.
 *
 * Usage: set BACKEND_URL in the frontend env (or fall back to http://localhost:13101).
 * Safe for both server and client components  -  nothing browser-specific here.
 */

export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? process.env.BACKEND_URL ?? 'http://localhost:13101';

async function safeJson<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      signal: controller.signal,
      // Always fetch fresh data for live dashboards.
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Types ----------

export interface HealthService {
  status: 'ok' | 'error';
  latency_ms: number;
  error?: string;
}
export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime_seconds: number;
  memory_mb: number;
  services: { supabase: HealthService; polymarket: HealthService };
}

export interface OnchainObject {
  name: string;
  object_id: string;
  deployed: boolean;
  owner: string | null;
  data_size: number;
  latency_ms: number;
}
export interface OnchainStatus {
  chain: 'sui';
  network: string;
  rpc_url: string;
  checkpoint: number | null;
  epoch: number | null;
  objects: { package: OnchainObject; market_admin_cap: OnchainObject };
  total_latency_ms: number;
  timestamp: string;
}

export interface MLMetrics {
  model: string;
  execution_status: string;
  all_checks_passed: boolean;
  metrics: {
    classifier_precision: number;
    walkforward_mean_improvement: number;
    walkforward_p_value: number;
    var_95: number;
    var_99: number;
    cvar_95: number;
    cvar_99: number;
  };
}

export interface PolymarketMarket {
  id: string;
  question: string;
  condition_id: string;
  outcomePrices?: string;
  volume?: string;
  active?: boolean;
  closed?: boolean;
  end_date_iso?: string;
}
export interface MarketsResponse {
  count: number;
  markets: PolymarketMarket[];
}

// ---------- Fetchers ----------

export function fetchHealth() {
  return safeJson<HealthResponse>('/api/health', undefined, 15_000);
}
export function fetchOnchainStatus() {
  return safeJson<OnchainStatus>('/api/onchain/status', undefined, 15_000);
}
export function fetchMLMetrics() {
  return safeJson<MLMetrics>('/api/ml/metrics');
}
export function fetchMarkets(limit = 6) {
  return safeJson<MarketsResponse>(`/api/markets?limit=${limit}`);
}

export interface VaultPriceResponse {
  bundle_id: string;
  bundle_name: string;
  /** Vault's fixed issue price in USD (issuePriceBps / 10_000). */
  issue_price: number | null;
  fee_bps: number | null;
  /** "active" | "finalized" | "closed" — active supports early exit; finalized uses redeem payout. */
  vault_state?: string | null;
}
export interface VaultPricesResponse {
  count: number;
  prices: VaultPriceResponse[];
}
export function fetchVaultPrice(bundleId: string) {
  return safeJson<VaultPriceResponse>(`/api/deposit/vault-price/${bundleId}`, undefined, 10_000);
}
export function fetchAllVaultPrices() {
  return safeJson<VaultPricesResponse>('/api/deposit/vault-prices', undefined, 15_000);
}
