/**
 * Polymarket / external-API fetch helper (Pelagos backend).
 *
 * Polymarket's Gamma + CLOB APIs are reached DIRECTLY. We wrap `fetch` only to
 * apply a sane timeout so a hung upstream connection fails fast instead of
 * blocking the request for the platform default.
 *
 * NOTE: a token-gated geo-bypass relay was used previously to reach Polymarket
 * from US-blocked dev hosts. It has been removed — the production backend runs
 * on a non-US host with direct Polymarket access.
 */

const DIRECT_TIMEOUT_MS = 12_000;

/**
 * `fetch` for Polymarket and other external APIs — a direct request with a
 * timeout. Honors a caller-supplied AbortSignal if present; otherwise applies
 * DIRECT_TIMEOUT_MS so a hung connection fails fast.
 */
export async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  if (init?.signal) return fetch(url, init);
  return fetch(url, { ...init, signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS) });
}
