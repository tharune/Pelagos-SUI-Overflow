/**
 * Vault-price fetch helper for the Pelagos backend.
 *
 * This is the one backend client that lives outside app/app/_lib — it is imported
 * by the basket detail page to read a bundle's fixed vault issue price. The
 * app-wide backend base URL lives in app/app/_lib/tokens.ts (BACKEND_URL).
 */

const BACKEND_URL =
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

export interface VaultPriceResponse {
  bundle_id: string;
  bundle_name: string;
  /** Vault's fixed issue price in USD (issuePriceBps / 10_000). */
  issue_price: number | null;
  fee_bps: number | null;
  /** "active" | "finalized" | "closed" — active supports early exit; finalized uses redeem payout. */
  vault_state?: string | null;
}

export function fetchVaultPrice(bundleId: string) {
  return safeJson<VaultPriceResponse>(`/api/deposit/vault-price/${bundleId}`, undefined, 10_000);
}
