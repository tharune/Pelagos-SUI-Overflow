/**
 * Polymarket relay support (Pelagos backend).
 *
 * Polymarket's Gamma + CLOB APIs geo-block US IPs (CFTC): from a blocked region
 * Cloudflare drops the connection, so `fetch` fails (curl shows HTTP 000). Set
 * POLYMARKET_RELAY_URL to a token-gated HTTPS relay running on a NON-US host;
 * ONLY Polymarket requests route through it (everything else stays direct).
 *
 * The relay is reached over normal HTTPS:443, so it passes restrictive networks
 * (e.g. work wifi) that block VPN/Tor/odd ports. The target URL is URL-encoded
 * into the `{url}` placeholder:
 *
 *   POLYMARKET_RELAY_URL=https://<lease-host>/?token=<TOKEN>&url={url}
 *
 * If POLYMARKET_RELAY_URL is unset, `proxiedFetch` is a thin pass-through to the
 * platform `fetch` — no behavior change.
 */

// The relay adds a network hop AND fetches Polymarket itself, so a caller's
// tight per-request timeout (tuned for DIRECT access — Pelagos uses ~4s) is too
// aggressive over the relay and trips a `TimeoutError` -> HTTP 500. Relayed
// requests get their own, longer budget instead (the relay caps its own
// upstream fetch at 25s, so this stays under that).
const RELAY_TIMEOUT_MS = 55_000;

function relayTarget(url: string): string | null {
  const relay = process.env.POLYMARKET_RELAY_URL?.trim();
  if (!relay) return null;
  const enc = encodeURIComponent(url);
  return relay.includes('{url}') ? relay.replace('{url}', enc) : relay + enc;
}

export function relayConfigured(): boolean {
  return Boolean(process.env.POLYMARKET_RELAY_URL?.trim());
}

let relayLogged = false;

/**
 * `fetch` for Polymarket — transparently routed through POLYMARKET_RELAY_URL when
 * set, otherwise the platform `fetch`. The relay fetches the target itself and
 * sets its own headers, so when relaying we forward only the abort signal
 * (timeout); direct calls pass `init` verbatim. Returns a standard web `Response`.
 */
export async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  const relayed = relayTarget(url);
  if (!relayed) return fetch(url, init);
  if (!relayLogged) {
    console.log('[proxy] Polymarket requests routed via RELAY (POLYMARKET_RELAY_URL)');
    relayLogged = true;
  }
  // Use a relay-appropriate timeout rather than the caller's tight direct-access
  // signal — over the relay the original 4s budget trips a TimeoutError.
  return fetch(relayed, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
}
