/**
 * Polymarket relay support (Pelagos backend).
 *
 * Polymarket's Gamma + CLOB APIs geo-block US IPs (CFTC): from a blocked region
 * Cloudflare drops the connection, so a direct `fetch` THROWS (curl shows HTTP
 * 000). Set POLYMARKET_RELAY_URL to a token-gated HTTPS relay on a NON-US host;
 * ONLY Polymarket requests route through it (everything else stays direct).
 *
 *   POLYMARKET_RELAY_URL=https://<lease-host>/?token=<TOKEN>&url={url}
 *
 * RESILIENCE: the relay is a leased box that can die. We must NOT hard-depend on
 * it — when it's down but the network reaches Polymarket directly (e.g. a non-US
 * box, or a relay that just lapsed), forcing the relay would break ALL live
 * pricing. So `proxiedFetch` tries BOTH transports and adopts whichever works:
 *   - default order is DIRECT first (correct + fast on open networks),
 *   - on a transport-level failure (throw/timeout — exactly how a geo-block or a
 *     dead relay presents) it falls back to the other transport,
 *   - and it remembers the winner, so a geo-blocked box settles on the relay and
 *     an open box settles on direct, without paying the loser's latency twice.
 *
 * If POLYMARKET_RELAY_URL is unset, `proxiedFetch` is a thin pass-through.
 */

// The relay adds a hop AND fetches Polymarket itself; it caps its own upstream
// fetch at ~25s, so give relayed requests their own budget. Direct access should
// be quick when reachable — a longer budget just delays the relay fallback.
const RELAY_TIMEOUT_MS = 25_000;
const DIRECT_TIMEOUT_MS = 12_000;

function relayTarget(url: string): string | null {
  const relay = process.env.POLYMARKET_RELAY_URL?.trim();
  if (!relay) return null;
  const enc = encodeURIComponent(url);
  return relay.includes('{url}') ? relay.replace('{url}', enc) : relay + enc;
}

export function relayConfigured(): boolean {
  return Boolean(process.env.POLYMARKET_RELAY_URL?.trim());
}

type Transport = 'direct' | 'relay';
// Adaptive preference: start direct-first; flip to whichever transport last
// succeeded. A dead relay becomes non-fatal (direct serves), and a geo-blocked
// box converges on the relay after one failed direct attempt.
let preferred: Transport = 'direct';

function logTransport(t: Transport): void {
  console.log(`[proxy] Polymarket transport → ${t.toUpperCase()}${t === 'relay' ? ' (POLYMARKET_RELAY_URL)' : ' (direct)'}`);
}

async function directFetch(url: string, init?: RequestInit): Promise<Response> {
  // Honor a caller-supplied signal if present; otherwise apply our own timeout
  // so a hung direct connection still fails fast enough to fall back to the relay.
  if (init?.signal) return fetch(url, init);
  return fetch(url, { ...init, signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS) });
}

async function relayFetch(relayed: string): Promise<Response> {
  // The relay fetches the target itself and sets its own headers, so we forward
  // only the abort signal (timeout); the original `init` is intentionally dropped.
  return fetch(relayed, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
}

/**
 * `fetch` for Polymarket — tries direct + relay (when configured) and adopts the
 * transport that works. Returns a standard web `Response`. Only transport-level
 * failures (throws/timeouts) trigger fallback; a returned non-2xx Response is
 * handed back to the caller (which already inspects status/body).
 */
export async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  const relayed = relayTarget(url);
  if (!relayed) return fetch(url, init); // no relay configured → direct pass-through

  const order: Transport[] = preferred === 'direct' ? ['direct', 'relay'] : ['relay', 'direct'];
  let lastErr: unknown;
  for (const t of order) {
    try {
      const res = t === 'direct' ? await directFetch(url, init) : await relayFetch(relayed);
      if (preferred !== t) {
        preferred = t;
        logTransport(t);
      }
      return res;
    } catch (err) {
      lastErr = err;
      // transport failed (geo-block drop / dead relay / timeout) → try the other
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('proxiedFetch: all transports failed');
}
