import { PolymarketMarket, PolymarketEvent } from '../types';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

interface GammaMarketResponse {
  id: string;
  question: string;
  conditionId: string;
  outcomePrices: string;
  volume: string;
  active: boolean;
  closed: boolean;
  endDate?: string;
  slug: string;
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  outcomes?: string;
  clobTokenIds?: string;
  liquidity?: string;
  liquidityNum?: number;
  liquidityClob?: number;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
  // Parent events: Polymarket groups correlated questions under one event
  // (e.g. "What will happen before GTA VI?"). The first entry is used for
  // linking and for cross-basket correlation dedupe.
  events?: Array<{
    id?: string;
    slug?: string;
    title?: string;
  }>;
  // Price telemetry (all optional — newer markets may not have long-horizon
  // changes yet, and Gamma does not always emit oneDayPriceChange on every
  // row; we forward whichever fields are present).
  lastTradePrice?: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
}

interface GammaEventResponse {
  id: string;
  title: string;
  slug: string;
  endDate?: string;
  markets: GammaMarketResponse[];
}

// Gamma commonly caps /markets pages at 100 even when a larger limit is
// requested. Keep requests at 100 so offset pagination actually walks the
// live universe instead of stopping after the first capped page.
const GAMMA_PAGE_MAX = 100;
// Browser-style UA — some Polymarket edges 403 default User-Agents.
const POLY_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; pelagos-backend/1.0)',
  'Accept': 'application/json',
};

async function fetchWithRetry(url: string, retries = 1): Promise<Response | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: POLY_FETCH_HEADERS,
        // Hard timeout: Gamma's deep-offset pages currently hang for tens of
        // seconds. Without this, a single bad page stalls the whole backend.
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok) return response;
      if (response.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      console.error(`Polymarket API ${response.status}: ${url}`);
      return null;
    } catch (err) {
      // A timeout won't get better on retry, so bail immediately and let the
      // caller proceed with whatever it has already collected.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      if (!timedOut && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      console.error(`Polymarket API fetch failed: ${url}`, err instanceof Error ? err.name : err);
      return null;
    }
  }
  return null;
}

function parseOutcomePrices(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((p: string) => parseFloat(p));
    }
  } catch {
    console.error('Failed to parse outcomePrices:', raw);
  }
  return [];
}

function parseStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function tokensFromClobIds(m: GammaMarketResponse): GammaMarketResponse['tokens'] {
  if (m.tokens?.length) return m.tokens;
  const ids = parseStringArray(m.clobTokenIds);
  if (ids.length === 0) return [];
  const outcomes = parseStringArray(m.outcomes);
  const prices = parseOutcomePrices(m.outcomePrices);
  return ids.map((id, index) => ({
    token_id: id,
    outcome: outcomes[index] ?? (index === 0 ? 'Yes' : index === 1 ? 'No' : `Outcome ${index + 1}`),
    price: prices[index] ?? 0,
  }));
}

function toPolymarketMarket(m: GammaMarketResponse): PolymarketMarket {
  const primaryEvent = m.events?.[0];
  return {
    id: m.id,
    question: m.question,
    condition_id: m.conditionId,
    tokens: tokensFromClobIds(m) || [],
    outcomePrices: m.outcomePrices,
    volume: m.volume,
    active: m.active,
    closed: m.closed,
    end_date_iso: m.endDate,
    slug: m.slug,
    event_id: primaryEvent?.id,
    event_slug: primaryEvent?.slug,
    event_title: primaryEvent?.title,
    last_trade_price: m.lastTradePrice,
    one_day_price_change: m.oneDayPriceChange,
    one_week_price_change: m.oneWeekPriceChange,
    one_month_price_change: m.oneMonthPriceChange,
    clob_token_ids: parseStringArray(m.clobTokenIds),
    liquidity_usd: m.liquidityClob ?? m.liquidityNum ?? Number(m.liquidity ?? 0),
    spread: m.spread,
    best_bid: m.bestBid,
    best_ask: m.bestAsk,
  };
}

function toPolymarketEvent(e: GammaEventResponse): PolymarketEvent {
  return {
    id: e.id,
    title: e.title,
    slug: e.slug,
    end_date_iso: e.endDate || '',
    markets: (e.markets || []).map(toPolymarketMarket),
  };
}

/**
 * Fetch Polymarket markets. When the caller asks for more than Gamma's
 * per-page cap (500), we paginate via `offset` until we have enough.
 *
 * Callers can pass limit up to ~5000 to retrieve the full live universe.
 */
async function fetchMarketsRaw(params: {
  limit?: number;
  active?: boolean;
  closed?: boolean;
}): Promise<PolymarketMarket[]> {
  const want = params.limit ?? GAMMA_PAGE_MAX;
  const collected: GammaMarketResponse[] = [];
  let offset = 0;

  while (collected.length < want) {
    const pageSize = Math.min(GAMMA_PAGE_MAX, want - collected.length);
    const searchParams = new URLSearchParams();
    searchParams.set('limit', String(pageSize));
    if (params.active !== undefined) searchParams.set('active', String(params.active));
    if (params.closed !== undefined) searchParams.set('closed', String(params.closed));
    // Volume-sorted so the highest-value markets land in the first (reachable)
    // pages. Gamma's deep-offset pages are currently unreliable, so ranking the
    // top pages by volume is what keeps baskets + distribution populated.
    searchParams.set('order', 'volumeNum');
    searchParams.set('ascending', 'false');
    searchParams.set('offset', String(offset));

    const url = `${GAMMA_API}/markets?${searchParams.toString()}`;
    const res = await fetchWithRetry(url);
    if (!res) break;

    const batch = (await res.json()) as GammaMarketResponse[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    collected.push(...batch);

    // Gamma signalled end-of-results by returning fewer than requested.
    if (batch.length < pageSize) break;
    offset += batch.length;
  }

  return collected.map(toPolymarketMarket);
}

// Cache + coalesce market-universe fetches. The same params get requested by
// /api/bundles, /api/markets, distribution discovery, and the cron within
// seconds of each other; without this each one re-walks dozens of slow Gamma
// pages. One fetch (≤60s old) is shared across all callers.
const marketsCache = new Map<string, { at: number; data: PolymarketMarket[] }>();
const marketsInFlight = new Map<string, Promise<PolymarketMarket[]>>();
const MARKETS_CACHE_TTL_MS = 60_000;
export async function fetchMarkets(params: {
  limit?: number;
  active?: boolean;
  closed?: boolean;
}): Promise<PolymarketMarket[]> {
  const key = `${params.limit ?? GAMMA_PAGE_MAX}:${params.active}:${params.closed}`;
  const cached = marketsCache.get(key);
  if (cached && Date.now() - cached.at < MARKETS_CACHE_TTL_MS) return cached.data;
  const existing = marketsInFlight.get(key);
  if (existing) return existing;
  const pending = fetchMarketsRaw(params)
    .then((data) => {
      if (data.length) marketsCache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => marketsInFlight.delete(key));
  marketsInFlight.set(key, pending);
  return pending;
}

export async function fetchMarketByConditionId(
  conditionId: string
): Promise<PolymarketMarket | null> {
  // 0x… condition ids must use the `condition_ids` query (returns an array);
  // the numeric `/markets/{id}` path 422s on them. Numeric ids use the path.
  const is0x = conditionId.startsWith('0x');
  const url = is0x
    ? `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`
    : `${GAMMA_API}/markets/${conditionId}`;
  const res = await fetchWithRetry(url);
  if (!res) return null;

  const data = (await res.json()) as GammaMarketResponse | GammaMarketResponse[];
  const market = Array.isArray(data) ? data[0] : data;
  if (market && market.question) {
    return toPolymarketMarket(market);
  }
  return null;
}

export async function fetchEvents(params: {
  limit?: number;
  active?: boolean;
}): Promise<PolymarketEvent[]> {
  const searchParams = new URLSearchParams();
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.active !== undefined) searchParams.set('active', String(params.active));

  const url = `${GAMMA_API}/events?${searchParams.toString()}`;
  const res = await fetchWithRetry(url);
  if (!res) return [];

  const data = (await res.json()) as GammaEventResponse[];
  return data.map(toPolymarketEvent);
}

export async function fetchEventById(eventId: string): Promise<PolymarketEvent | null> {
  const url = `${GAMMA_API}/events/${eventId}`;
  const res = await fetchWithRetry(url);
  if (!res) return null;

  const data = (await res.json()) as GammaEventResponse;
  return toPolymarketEvent(data);
}

export async function getMarketProbability(conditionId: string): Promise<number | null> {
  const market = await fetchMarketByConditionId(conditionId);
  if (!market) return null;

  const prices = parseOutcomePrices(market.outcomePrices);
  if (prices.length === 0) return null;

  return prices[0]; // first outcome = YES
}

export async function getBatchProbabilities(
  conditionIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (conditionIds.length === 0) return result;

  const promises = conditionIds.map(async (id) => {
    const prob = await getMarketProbability(id);
    if (prob !== null) {
      result.set(id, prob);
    }
  });

  await Promise.all(promises);
  return result;
}

export async function searchMarkets(
  query: string,
  limit: number = 20
): Promise<PolymarketMarket[]> {
  const q = query.trim().toLowerCase();
  // Overfetch the active feed (Gamma's `text_query` is unreliable on the
  // markets endpoint) and filter client-side by question text so the query
  // genuinely narrows results instead of returning the same default feed.
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(Math.max(limit * 6, 60)));
  searchParams.set('active', 'true');
  searchParams.set('closed', 'false');
  searchParams.set('order', 'volume24hr');
  searchParams.set('ascending', 'false');
  if (q) searchParams.set('text_query', query);

  const url = `${GAMMA_API}/markets?${searchParams.toString()}`;
  const res = await fetchWithRetry(url);
  if (!res) return [];

  const data = (await res.json()) as GammaMarketResponse[];
  let markets = data.map(toPolymarketMarket);
  if (q) {
    // Always narrow by the query — a no-match returns [] rather than silently
    // falling back to the default high-volume feed (which reads as "search works"
    // when it doesn't).
    markets = markets.filter((m) => m.question?.toLowerCase().includes(q));
  }
  return markets.slice(0, limit);
}

export async function getHighLiquidityMarkets(
  minVolume: number,
  limit: number
): Promise<PolymarketMarket[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit * 3)); // overfetch to account for volume filtering
  searchParams.set('active', 'true');
  searchParams.set('closed', 'false');
  searchParams.set('order', 'volume');
  searchParams.set('ascending', 'false');

  const url = `${GAMMA_API}/markets?${searchParams.toString()}`;
  const res = await fetchWithRetry(url);
  if (!res) return [];

  const data = (await res.json()) as GammaMarketResponse[];
  return data
    .filter((m) => parseFloat(m.volume) >= minVolume)
    .slice(0, limit)
    .map(toPolymarketMarket);
}

// ---------------------------------------------------------------------------
// Basket NAV computation from live Polymarket data
//
// Mirrors the bucketing logic in the frontend live-baskets.ts so the backend
// produces the same weighted probability numbers displayed in the UI.
// ---------------------------------------------------------------------------

export interface BasketNAVResult {
  id: string;          // e.g. "PBU-MID-MED"
  nav: number;         // weighted average probability of selected legs
  leg_count: number;
  daily_change: number; // signed pct move (e.g. 0.042 = +4.2%)
}

// Extended tier bands — mirrors TIER_RANGE_EXT from live-baskets.ts.
// Using the extended bands (not the tight preferred bands) so the backend
// captures the same legs the frontend does.
const TIER_BANDS: Record<'HIGH' | 'MID' | 'LOW', [number, number]> = {
  HIGH: [0.78, 0.995],
  MID:  [0.15, 0.85],
  LOW:  [0.01, 0.22],
};
// Extended window ranges — mirrors WINDOW_RANGE_EXT from live-baskets.ts.
const WINDOW_DAYS: Record<'SHORT' | 'MED' | 'LONG', [number, number]> = {
  SHORT: [1,   30],
  MED:   [14,  150],
  LONG:  [120, Infinity],
};
const MIN_VOLUME_USD = 10_000;
const MAX_LEGS_PER_BASKET = 2000; // generous cap — frontend has no upper limit

type TierKey = 'HIGH' | 'MID' | 'LOW';
type WinKey  = 'SHORT' | 'MED' | 'LONG';

interface Candidate {
  marketId: string;
  eventId: string | undefined;
  probability: number;
  volumeUsd: number;
  dailyChangePct: number; // absolute daily change in probability space
}

// A candidate leg can fit MULTIPLE windows (extended ranges overlap).
// Return all windows it qualifies for so it can be placed in each basket.
function windowsFor(endDateIso: string | undefined): WinKey[] {
  if (!endDateIso) return [];
  const daysLeft = (new Date(endDateIso).getTime() - Date.now()) / 86_400_000;
  if (daysLeft < 1) return []; // already resolving today or past
  const wins: WinKey[] = [];
  for (const [win, [lo, hi]] of Object.entries(WINDOW_DAYS) as [WinKey, [number, number]][]) {
    if (daysLeft >= lo && daysLeft <= hi) wins.push(win);
  }
  return wins;
}

function tierFor(prob: number): TierKey | null {
  for (const [tier, [lo, hi]] of Object.entries(TIER_BANDS) as [TierKey, [number, number]][]) {
    if (prob >= lo && prob <= hi) return tier;
  }
  return null;
}

// 2-minute cache so the cron and API routes share the same computation.
let _basketNAVCache: { at: number; results: Map<string, BasketNAVResult> } | null = null;
const BASKET_NAV_TTL_MS = 120_000;

export async function getPolymarketBasketNAVs(): Promise<Map<string, BasketNAVResult>> {
  if (_basketNAVCache && Date.now() - _basketNAVCache.at < BASKET_NAV_TTL_MS) {
    return _basketNAVCache.results;
  }

  // Fetch the full live Polymarket universe — 5000 covers all active markets.
  const markets = await fetchMarkets({ limit: 5000, active: true, closed: false });

  // Build candidate pool: each market yields a YES side and a NO side.
  // Candidates that pass volume + tier + window filters go into buckets.
  const buckets = new Map<string, Candidate[]>();
  for (const basket of [
    'PBU-HIGH-SHORT','PBU-HIGH-MED','PBU-HIGH-LONG',
    'PBU-MID-SHORT', 'PBU-MID-MED', 'PBU-MID-LONG',
    'PBU-LOW-SHORT', 'PBU-LOW-MED', 'PBU-LOW-LONG',
  ]) buckets.set(basket, []);

  // Track which market IDs and event IDs are already claimed per basket
  // (same per-basket dedupe as the frontend).
  const claimedPerBasket = new Map<string, { markets: Set<string>; events: Set<string> }>();
  for (const k of buckets.keys()) {
    claimedPerBasket.set(k, { markets: new Set(), events: new Set() });
  }

  const volOf = (m: { volume?: string }) => parseFloat(m.volume ?? '0');

  // Sort by volume desc so highest-liquidity markets win dedup ties.
  const sorted = [...markets].sort((a, b) => volOf(b) - volOf(a));

  // Global claim: each underlying market ID goes to at most ONE basket
  // (either its YES or NO side), matching the frontend's global dedup.
  const globalClaimedMarkets = new Set<string>();

  for (const m of sorted) {
    if (!m.active || m.closed) continue;
    const vol = volOf(m);
    if (vol < MIN_VOLUME_USD) continue;

    const prices = (() => {
      try { return JSON.parse(m.outcomePrices).map(Number); } catch { return []; }
    })() as number[];
    if (prices.length < 2) continue;

    const yesProb = prices[0];
    if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) continue;

    const wins = windowsFor(m.end_date_iso);
    if (wins.length === 0) continue;

    const dailyAbs = typeof m.one_day_price_change === 'number' && Number.isFinite(m.one_day_price_change)
      ? m.one_day_price_change
      : typeof m.one_week_price_change === 'number' ? m.one_week_price_change / 7
      : 0;

    // Check both YES and NO sides; pick the first basket that accepts it.
    const sides: [number, number][] = [[yesProb, dailyAbs], [1 - yesProb, -dailyAbs]];
    for (const [prob, dayChg] of sides) {
      const tier = tierFor(prob);
      if (!tier) continue;

      // Global market dedup — a market contributes at most one leg across all baskets.
      if (globalClaimedMarkets.has(m.id)) continue;

      for (const win of wins) {
        const basketId = `PBU-${tier}-${win}`;
        const claimed = claimedPerBasket.get(basketId)!;

        // Per-basket event dedup — one leg per event per basket.
        if (m.event_id && claimed.events.has(m.event_id)) continue;

        globalClaimedMarkets.add(m.id);
        if (m.event_id) claimed.events.add(m.event_id);
        claimed.markets.add(m.id);

        buckets.get(basketId)!.push({
          marketId: m.id,
          eventId: m.event_id,
          probability: prob,
          volumeUsd: vol,
          dailyChangePct: dailyAbs,
        });
        break; // place this market in one basket only
      }
      if (globalClaimedMarkets.has(m.id)) break; // side placed, stop trying the other
    }
  }

  const results = new Map<string, BasketNAVResult>();
  for (const [basketId, candidates] of buckets.entries()) {
    const legs = candidates.slice(0, MAX_LEGS_PER_BASKET);
    if (legs.length === 0) continue;

    const probs = legs.map((c) => c.probability);
    // sqrt(volume) base weights → honest volume-weighted average probability.
    // No tilt toward a hardcoded tier target, no seeded jitter.
    const baseWeights = legs.map((c) => Math.sqrt(Math.max(1, c.volumeUsd)));
    const totalW = baseWeights.reduce((s, w) => s + w, 0);
    const navRaw = probs.reduce((s, p, i) => s + (baseWeights[i] / totalW) * p, 0);

    // Weighted daily change (raw volume-weighted).
    const dailyChange = legs.reduce((s, c, i) => s + (baseWeights[i] / totalW) * c.dailyChangePct, 0);

    results.set(basketId, {
      id: basketId,
      nav: Math.round(navRaw * 10_000) / 10_000,
      leg_count: legs.length,
      daily_change: Math.round(dailyChange * 10_000) / 10_000,
    });
  }

  _basketNAVCache = { at: Date.now(), results };
  return results;
}
