/**
 * Distribution-market discovery & pricing — turns Polymarket events into
 * multi-band distribution candidates. Pulls CLOB order books (depth-gated,
 * cached) and Gamma liquidity, scores/filters candidates
 * (discoverDistributionCandidates), prices a target curve against the live
 * reference via a discrete-L2 distribution-AMM (quoteDistributionCandidate),
 * and builds launch plans (buildDistributionLaunchPlan).
 */
import { fetchEvents, fetchMarkets } from './polymarket';
import { proxiedFetch } from './proxy';
import { assessQuality, classifyCategory, type Category } from './nlp';
import { type PolymarketEvent, type PolymarketMarket } from '../types';

const CLOB_API = 'https://clob.polymarket.com';
const BOOK_CACHE_TTL_MS = 5_000;
const CANDIDATE_CACHE_TTL_MS = 900_000;

// Cap concurrent CLOB /book requests. A single discovery pass can ask for
// hundreds of order books at once; without a gate that burst exhausts outbound
// sockets and starves every other backend endpoint (bundles, markets, health).
// Requests above the cap queue instead of stampeding Polymarket.
const MAX_CONCURRENT_BOOKS = 12;
let activeBookFetches = 0;
const bookWaiters: Array<() => void> = [];
function acquireBookSlot(): Promise<void> {
  if (activeBookFetches < MAX_CONCURRENT_BOOKS) {
    activeBookFetches += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => bookWaiters.push(resolve));
}
function releaseBookSlot(): void {
  const next = bookWaiters.shift();
  if (next) next();
  else activeBookFetches -= 1;
}

// Coalesce concurrent discovery passes: a cold cache hit by several pages at
// once should run ONE compute, not one storm per caller.
let inFlightDiscover: Promise<void> | null = null;

type BookLevel = { price: number; size: number };
type CachedBook = { bids: BookLevel[]; asks: BookLevel[]; fetched_at: number };
type DepthSource = 'clob_orderbook' | 'gamma_liquidity' | 'none';

export type DistributionBand = {
  id: string;
  label: string;
  question: string;
  market_id: string;
  token_id: string | null;
  probability: number;
  normalized_probability: number;
  volume_usd: number;
  depth_usd: number;
  depth_source: DepthSource;
  clob_depth_usd: number;
  gamma_liquidity_usd: number;
  orderbook_bid_depth_usd: number;
  orderbook_ask_depth_usd: number;
  orderbook_fetched_at: string | null;
  spread: number | null;
  best_bid: number | null;
  best_ask: number | null;
  polymarket_url: string | null;
};

export type DistributionCandidate = {
  id: string;
  title: string;
  category: Category;
  category_confidence: number;
  distribution_fit: 'high' | 'medium' | 'low';
  outcome_type: 'numeric_range' | 'count' | 'winner_set' | 'price_level' | 'other';
  event_slug: string | null;
  end_date_iso: string | null;
  days_to_resolution: number | null;
  aggregate_volume_usd: number;
  aggregate_depth_usd: number;
  avg_spread: number | null;
  band_count: number;
  launch_score: number;
  launch_quality: 'excellent' | 'strong' | 'watchlist';
  reasons: string[];
  pricing_source: 'polymarket_gamma_clob';
  clob_book_count: number;
  gamma_liquidity_count: number;
  bands: DistributionBand[];
  reference_curve: number[];
  liquidity_curve: number[];
  fetched_at: string;
};

export type DistributionQuote = {
  candidate_id: string;
  candidate_title: string;
  collateral_usdc: number;
  weights: number[];
  target_curve: number[];
  reference_curve: number[];
  trade_curve: number[];
  reference_dollar_curve: number[];
  target_dollar_curve: number[];
  trade_dollar_curve: number[];
  pool_l2_norm: number;
  max_profit_usdc: number;
  max_loss_usdc: number;
  collateral_required_usdc: number;
  l2_distance: number;
  l2_norm: number;
  max_band_exposure_usdc: number;
  maker_fee_usdc: number;
  net_collateral_usdc: number;
  quote_model: 'net_usdc_discrete_l2_distribution_amm';
  pricing_source: 'polymarket_gamma_clob';
  liquidity_depth_usd: number;
  depth_coverage_ratio: number;
  bands_with_orderbook: number;
  bands_with_depth: number;
  expected_band: DistributionBand;
  pnl_curve: Array<{
    band_id: string;
    label: string;
    reference_probability: number;
    target_probability: number;
    position_usdc: number;
    liquidity_depth_usd: number;
  }>;
};

export type DistributionLaunchPlan = {
  candidate_id: string;
  title: string;
  status: 'ready_to_launch' | 'needs_more_liquidity';
  launch_score: number;
  required_depth_usd: number;
  current_depth_usd: number;
  bands: Array<{
    label: string;
    market_id: string;
    token_id: string | null;
    initial_weight: number;
    depth_usd: number;
  }>;
};

const bookCache = new Map<string, CachedBook>();
let candidateCache: { at: number; candidates: DistributionCandidate[]; funnel: DiscoveryFunnel } | null = null;

export type DiscoveryFunnel = {
  input_events: number;
  input_markets: number;
  kept_candidates: number;
  rejected: {
    too_few_bands: number;
    low_volume: number;
    low_depth: number;
    low_quality: number;
    low_distribution_fit: number;
  };
  filters: {
    min_volume_usd: number;
    min_depth_usd: number;
    min_days: number;
    max_days: number;
    min_bands: number;
  };
};

function parseVolume(raw: string | undefined): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parsePrices(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

function daysFromNow(iso?: string): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / 86_400_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function normalize(values: number[]): number[] {
  const total = values.reduce((acc, n) => acc + Math.max(0, n), 0);
  if (total <= 0) return values.map(() => 1 / Math.max(1, values.length));
  return values.map((n) => Math.max(0, n) / total);
}

function l2Norm(values: number[]): number {
  return Math.sqrt(values.reduce((acc, n) => acc + n ** 2, 0));
}

function round(n: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

function roundNormalized(values: number[], digits = 4): number[] {
  if (values.length === 0) return [];
  const rounded = values.map((value) => round(value, digits));
  const sum = rounded.reduce((acc, value) => acc + value, 0);
  const index = rounded.reduce((best, value, i) => value > rounded[best] ? i : best, 0);
  rounded[index] = round(Math.max(0, rounded[index] + (1 - sum)), digits);
  return rounded;
}

function shortLabel(question: string, eventTitle: string): string {
  const stripped = question
    .replace(/\?+$/g, '')
    .replace(/^will\s+/i, '')
    .replace(/\s+by\s+[^?]+$/i, '')
    .replace(eventTitle, '')
    .trim();
  if (stripped.length <= 46) return stripped || question.slice(0, 46);
  return `${stripped.slice(0, 43).trim()}...`;
}

function marketUrl(market: PolymarketMarket): string | null {
  if (market.event_slug) return `https://polymarket.com/event/${market.event_slug}`;
  if (market.slug) return `https://polymarket.com/market/${market.slug}`;
  return null;
}

async function fetchBook(tokenId: string | null): Promise<CachedBook | null> {
  if (!tokenId) return null;
  const cached = bookCache.get(tokenId);
  if (cached && Date.now() - cached.fetched_at < BOOK_CACHE_TTL_MS) return cached;
  await acquireBookSlot();
  try {
    const response = await proxiedFetch(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; pelagos-backend/1.0)',
      },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const raw = await response.json() as {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    };
    const parse = (levels: Array<{ price: string; size: string }> = []): BookLevel[] =>
      levels.map((level) => ({
        price: Number(level.price),
        size: Number(level.size),
      })).filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size));
    const book = {
      bids: parse(raw.bids).sort((a, b) => b.price - a.price).slice(0, 25),
      asks: parse(raw.asks).sort((a, b) => a.price - b.price).slice(0, 25),
      fetched_at: Date.now(),
    };
    bookCache.set(tokenId, book);
    return book;
  } catch {
    return null;
  } finally {
    releaseBookSlot();
  }
}

function bookMetrics(book: CachedBook | null) {
  if (!book) {
    return {
      depth_usd: 0,
      bid_depth_usd: 0,
      ask_depth_usd: 0,
      spread: null,
      best_bid: null,
      best_ask: null,
      fetched_at: null,
    };
  }
  const bestBid = book.bids[0]?.price ?? null;
  const bestAsk = book.asks[0]?.price ?? null;
  const bidDepth = book.bids.reduce((acc, level) => acc + level.price * level.size, 0);
  const askDepth = book.asks.reduce((acc, level) => acc + level.price * level.size, 0);
  return {
    depth_usd: bidDepth + askDepth,
    bid_depth_usd: bidDepth,
    ask_depth_usd: askDepth,
    spread: bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null,
    best_bid: bestBid,
    best_ask: bestAsk,
    fetched_at: new Date(book.fetched_at).toISOString(),
  };
}

function scoreCandidate(args: {
  aggregateVolume: number;
  aggregateDepth: number;
  avgSpread: number | null;
  days: number | null;
  categoryConfidence: number;
  bandCount: number;
  distributionFitScore: number;
}): number {
  const volumeScore = clamp01(Math.log10(Math.max(1, args.aggregateVolume)) / 7);
  const depthScore = clamp01(Math.log10(Math.max(1, args.aggregateDepth)) / 5.5);
  const spreadScore = args.avgSpread === null ? 0.55 : clamp01(1 - args.avgSpread / 0.12);
  const dayScore = args.days === null ? 0.4 : clamp01(1 - Math.abs(args.days - 45) / 140);
  const bandScore = clamp01(args.bandCount / 8);
  return round(
    100 * (
      volumeScore * 0.23 +
      depthScore * 0.23 +
      spreadScore * 0.14 +
      dayScore * 0.10 +
      args.distributionFitScore * 0.20 +
      args.categoryConfidence * 0.02 +
      bandScore * 0.08
    ),
    1,
  );
}

function quality(score: number): DistributionCandidate['launch_quality'] {
  if (score >= 82) return 'excellent';
  if (score >= 68) return 'strong';
  return 'watchlist';
}

function fitRank(fit: DistributionCandidate['distribution_fit']): number {
  if (fit === 'high') return 2;
  if (fit === 'medium') return 1;
  return 0;
}

function eventTitle(event: PolymarketEvent, markets: PolymarketMarket[]): string {
  return event.title || markets[0]?.event_title || markets[0]?.question || 'Live distribution candidate';
}

function eventEndDate(event: PolymarketEvent, markets: PolymarketMarket[]): string | null {
  return event.end_date_iso || markets.find((market) => market.end_date_iso)?.end_date_iso || null;
}

function classifyDistributionFit(title: string, markets: PolymarketMarket[]): {
  fit: DistributionCandidate['distribution_fit'];
  outcomeType: DistributionCandidate['outcome_type'];
  score: number;
  reason: string;
} {
  const questions = markets.map((market) => market.question).join(' ');
  const text = `${title} ${questions}`.toLowerCase();
  const numericSignals = /\b(between|less than|greater than|more than|at least|at most|over|under|above|below|market cap|price|close|closing|cpi|inflation|percentage|vote share|margin|tvl)\b/;
  const countSignals = /\b(how many|number of|rate cuts|hikes|seats|delegates|electoral votes)\b/;
  const winnerSignals = /\b(winner|champion|nominee|election|primary|mayor|president|advance to|first place)\b/;
  const priceSignals = /\b(price|market cap|close|closing|tvl|volume)\b/;
  const nonExclusiveSignals = /\b(what will happen before|before gta|endorse|acquire|will .+ before|which of these will happen)\b/;

  if (nonExclusiveSignals.test(text)) {
    return {
      fit: 'low',
      outcomeType: 'other',
      score: 0.2,
      reason: 'low distribution fit',
    };
  }
  if (countSignals.test(text)) {
    return {
      fit: 'high',
      outcomeType: 'count',
      score: 1,
      reason: 'count outcome set',
    };
  }
  if (numericSignals.test(text)) {
    return {
      fit: 'high',
      outcomeType: priceSignals.test(text) ? 'price_level' : 'numeric_range',
      score: 1,
      reason: 'numeric outcome bands',
    };
  }
  if (winnerSignals.test(text)) {
    return {
      fit: 'medium',
      outcomeType: 'winner_set',
      score: 0.68,
      reason: 'mutually exclusive outcome set',
    };
  }
  return {
    fit: 'medium',
    outcomeType: 'other',
    score: 0.52,
    reason: 'discrete outcome set',
  };
}

async function buildCandidateFromEvent(
  event: PolymarketEvent,
  fallbackMarkets: PolymarketMarket[],
  filters: DiscoveryFunnel['filters'],
): Promise<DistributionCandidate | null> {
  const liveMarkets = (event.markets?.length ? event.markets : fallbackMarkets)
    .filter((market) => market.active && !market.closed)
    .map((market) => ({
      market,
      volume: parseVolume(market.volume),
      probability: parsePrices(market.outcomePrices)[0],
      tokenId: market.tokens?.[0]?.token_id ?? null,
      days: daysFromNow(market.end_date_iso),
    }))
    .filter((row) =>
      row.volume >= filters.min_volume_usd &&
      Number.isFinite(row.probability) &&
      row.probability > 0.01 &&
      row.probability < 0.99 &&
      row.days !== null &&
      row.days >= filters.min_days &&
      row.days <= filters.max_days,
    )
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10);

  if (liveMarkets.length < filters.min_bands) return null;

  const title = eventTitle(event, liveMarkets.map((row) => row.market));
  const qualityAssessment = assessQuality(title.endsWith('?') ? title : `${title}?`);
  const category = classifyCategory(title);
  const distribution = classifyDistributionFit(title, liveMarkets.map((row) => row.market));
  if (distribution.fit === 'low') return null;
  if (!qualityAssessment.passed && category.category === 'other') return null;

  const books = await Promise.all(liveMarkets.map((row) => fetchBook(row.tokenId)));
  const rawBands = liveMarkets.map((row, index) => {
    const metrics = bookMetrics(books[index]);
    const gammaLiquidity = row.market.liquidity_usd && row.market.liquidity_usd > 0 ? row.market.liquidity_usd : 0;
    const clobDepth = metrics.depth_usd;
    const depthSource: DepthSource = clobDepth > 0
      ? 'clob_orderbook'
      : gammaLiquidity > 0
        ? 'gamma_liquidity'
        : 'none';
    const depthUsd = depthSource === 'clob_orderbook' ? clobDepth : gammaLiquidity;
    return {
      id: row.market.id,
      label: shortLabel(row.market.question, title),
      question: row.market.question,
      market_id: row.market.id,
      token_id: row.tokenId,
      probability: row.probability,
      normalized_probability: 0,
      volume_usd: row.volume,
      depth_usd: round(depthUsd, 2),
      depth_source: depthSource,
      clob_depth_usd: round(clobDepth, 2),
      gamma_liquidity_usd: round(gammaLiquidity, 2),
      orderbook_bid_depth_usd: round(metrics.bid_depth_usd, 2),
      orderbook_ask_depth_usd: round(metrics.ask_depth_usd, 2),
      orderbook_fetched_at: metrics.fetched_at,
      spread: metrics.spread ?? row.market.spread ?? null,
      best_bid: metrics.best_bid ?? row.market.best_bid ?? null,
      best_ask: metrics.best_ask ?? row.market.best_ask ?? null,
      polymarket_url: marketUrl(row.market),
    };
  });

  const depth = rawBands.reduce((acc, band) => acc + band.depth_usd, 0);
  if (depth < filters.min_depth_usd) return null;

  const reference = roundNormalized(normalize(rawBands.map((band) => band.probability)));
  const bands = rawBands.map((band, index) => ({
    ...band,
    normalized_probability: reference[index],
  }));
  const spreads = bands
    .map((band) => band.spread)
    .filter((spread): spread is number => spread !== null && spread >= 0 && spread <= 0.25);
  const avgSpread = spreads.length ? spreads.reduce((acc, n) => acc + n, 0) / spreads.length : null;
  const days = median(liveMarkets.map((row) => row.days).filter((day): day is number => day !== null));
  const aggregateVolume = bands.reduce((acc, band) => acc + band.volume_usd, 0);
  const clobBookCount = bands.filter((band) => band.depth_source === 'clob_orderbook').length;
  const gammaLiquidityCount = bands.filter((band) => band.depth_source === 'gamma_liquidity').length;
  const score = scoreCandidate({
    aggregateVolume,
    aggregateDepth: depth,
    avgSpread,
    days,
    categoryConfidence: category.confidence,
    bandCount: bands.length,
    distributionFitScore: distribution.score,
  });

  return {
    id: event.id || event.slug || bands.map((band) => band.market_id).join('-'),
    title,
    category: category.category,
    category_confidence: round(category.confidence, 3),
    distribution_fit: distribution.fit,
    outcome_type: distribution.outcomeType,
    event_slug: event.slug || liveMarkets[0]?.market.event_slug || null,
    end_date_iso: eventEndDate(event, liveMarkets.map((row) => row.market)),
    days_to_resolution: days === null ? null : round(days, 1),
    aggregate_volume_usd: round(aggregateVolume, 2),
    aggregate_depth_usd: round(depth, 2),
    avg_spread: avgSpread === null ? null : round(avgSpread, 4),
    band_count: bands.length,
    launch_score: score,
    launch_quality: quality(score),
    reasons: [
      `${bands.length} live bands`,
      `$${Math.round(aggregateVolume).toLocaleString()} aggregate volume`,
      `$${Math.round(depth).toLocaleString()} verified depth`,
      `${clobBookCount}/${bands.length} CLOB books`,
      avgSpread === null ? 'spread unavailable' : `${round(avgSpread * 100, 2)}% avg spread`,
      days === null ? 'mixed expiry' : `${round(days, 1)} days to resolution`,
      distribution.reason,
      `${category.category} NLP category`,
    ],
    pricing_source: 'polymarket_gamma_clob',
    clob_book_count: clobBookCount,
    gamma_liquidity_count: gammaLiquidityCount,
    bands,
    reference_curve: reference,
    liquidity_curve: roundNormalized(normalize(bands.map((band) => band.depth_usd))),
    fetched_at: new Date().toISOString(),
  };
}

function groupFallbackMarkets(markets: PolymarketMarket[]): PolymarketEvent[] {
  const grouped = new Map<string, PolymarketMarket[]>();
  for (const market of markets) {
    const key = market.event_id || market.event_slug || market.event_title || market.id;
    const arr = grouped.get(key) ?? [];
    arr.push(market);
    grouped.set(key, arr);
  }
  return [...grouped.entries()].map(([id, rows]) => ({
    id,
    title: rows[0]?.event_title || rows[0]?.question || id,
    slug: rows[0]?.event_slug || rows[0]?.slug || id,
    end_date_iso: rows[0]?.end_date_iso || '',
    markets: rows,
  }));
}

export async function discoverDistributionCandidates(params: {
  limit?: number;
  minVolumeUsd?: number;
  minDepthUsd?: number;
  minDays?: number;
  maxDays?: number;
  forceRefresh?: boolean;
} = {}): Promise<{ candidates: DistributionCandidate[]; funnel: DiscoveryFunnel; fetched_at: string }> {
  if (!params.forceRefresh && candidateCache && Date.now() - candidateCache.at < CANDIDATE_CACHE_TTL_MS) {
    return {
      candidates: candidateCache.candidates.slice(0, params.limit ?? 12),
      funnel: candidateCache.funnel,
      fetched_at: new Date(candidateCache.at).toISOString(),
    };
  }

  if (!inFlightDiscover) {
    inFlightDiscover = (async () => {
  const filters: DiscoveryFunnel['filters'] = {
    min_volume_usd: params.minVolumeUsd ?? 2_000,
    min_depth_usd: params.minDepthUsd ?? 100,
    min_days: params.minDays ?? 2,
    max_days: params.maxDays ?? 540,
    min_bands: 2,
  };

  // Keep the fetch small: the Polymarket relay's body-transfer bandwidth is the
  // bottleneck, so a single 100-market page (top by volume) is what completes in
  // time. Shares the cache key with /api/markets?limit=100 so one relay round
  // trip serves both the basket grid and distribution discovery.
  const [events, markets] = await Promise.all([
    fetchEvents({ limit: 100, active: true }),
    fetchMarkets({ limit: 100, active: true, closed: false }),
  ]);

  const fallbackEvents = groupFallbackMarkets(markets);
  const eventMarkets = new Map<string, PolymarketMarket[]>();
  for (const market of markets) {
    const key = market.event_id || market.event_slug || market.event_title || market.id;
    const rows = eventMarkets.get(key) ?? [];
    rows.push(market);
    eventMarkets.set(key, rows);
  }

  const combined = [
    ...events,
    ...fallbackEvents.filter((event) => !events.some((candidate) => candidate.id === event.id || candidate.slug === event.slug)),
  ];

  const funnel: DiscoveryFunnel = {
    input_events: combined.length,
    input_markets: markets.length,
    kept_candidates: 0,
    rejected: {
      too_few_bands: 0,
      low_volume: 0,
      low_depth: 0,
      low_quality: 0,
      low_distribution_fit: 0,
    },
    filters,
  };

  const built = await Promise.all(combined.slice(0, 180).map(async (event) => {
    const fallback = eventMarkets.get(event.id) ?? eventMarkets.get(event.slug) ?? [];
    const candidate = await buildCandidateFromEvent(event, fallback, filters);
    if (!candidate) return null;
    return candidate;
  }));

  const candidates = built
    .filter((candidate): candidate is DistributionCandidate => candidate !== null)
    .filter((candidate) => candidate.launch_score >= 42)
    .sort((a, b) => fitRank(b.distribution_fit) - fitRank(a.distribution_fit) || b.launch_score - a.launch_score);

  funnel.kept_candidates = candidates.length;
  funnel.rejected.too_few_bands = Math.max(0, combined.length - candidates.length);
  candidateCache = { at: Date.now(), candidates, funnel };
    })().finally(() => {
      inFlightDiscover = null;
    });
  }

  await inFlightDiscover;
  const ready = candidateCache;
  if (!ready) throw new Error('distribution discovery produced no result');
  return {
    candidates: ready.candidates.slice(0, params.limit ?? 12),
    funnel: ready.funnel,
    fetched_at: new Date(ready.at).toISOString(),
  };
}

export async function quoteDistributionCandidate(args: {
  candidateId: string;
  weights: number[];
  collateralUsdc: number;
}): Promise<DistributionQuote> {
  const { candidates } = await discoverDistributionCandidates({ limit: 40 });
  const candidate = candidates.find((item) => item.id === args.candidateId);
  if (!candidate) throw new Error(`Unknown distribution candidate: ${args.candidateId}`);
  if (args.weights.length !== candidate.bands.length) {
    throw new Error(`Expected ${candidate.bands.length} curve weights`);
  }
  const collateral = Number(args.collateralUsdc);
  if (!Number.isFinite(collateral) || collateral <= 0) throw new Error('collateral_usdc must be positive');

  // Discrete L2 approximation of the distribution-market AMM: the trader owns
  // terminal payoff g(x) - f(x), where f is the live CLOB-implied reference
  // distribution and g is the submitted target. Quote curves are funded by
  // net USDC after maker fee so gross collateral, fee, and exposure reconcile.
  const fee = collateral * 0.003;
  const net = collateral - fee;
  const poolL2Norm = net;
  const reference = candidate.reference_curve;
  const normalizedTarget = normalize(args.weights);
  const l1Diff = normalizedTarget.reduce((acc, weight, index) => acc + Math.abs(weight - reference[index]), 0);
  const target = l1Diff < 0.002 ? reference : normalizedTarget;
  const referenceNorm = Math.max(l2Norm(reference), 0.000001);
  const targetNorm = Math.max(l2Norm(target), 0.000001);
  const referenceDollarCurve = reference.map((weight) => (poolL2Norm * weight) / referenceNorm);
  const targetDollarCurve = target.map((weight) => (poolL2Norm * weight) / targetNorm);
  const tradeDollarCurve = targetDollarCurve.map((value, index) => value - referenceDollarCurve[index]);
  const trade = target.map((weight, index) => weight - reference[index]);
  const l2Distance = l2Norm(tradeDollarCurve);
  const targetL2Norm = l2Norm(targetDollarCurve);
  const maxProfit = Math.max(...tradeDollarCurve, 0);
  const maxLoss = Math.min(...tradeDollarCurve, 0);
  const collateralRequired = Math.max(0, -maxLoss);
  const maxLossWithFee = collateralRequired + fee;
  const maxBand = target.reduce((best, n, index) => n > target[best] ? index : best, 0);
  const bandsWithOrderbook = candidate.bands.filter((band) => band.depth_source === 'clob_orderbook').length;
  const bandsWithDepth = candidate.bands.filter((band) => band.depth_usd > 0).length;

  return {
    candidate_id: candidate.id,
    candidate_title: candidate.title,
    collateral_usdc: round(collateral, 2),
    weights: args.weights,
    target_curve: target.map((n) => round(n)),
    reference_curve: reference,
    trade_curve: trade.map((n) => round(n)),
    reference_dollar_curve: referenceDollarCurve.map((n) => round(n, 2)),
    target_dollar_curve: targetDollarCurve.map((n) => round(n, 2)),
    trade_dollar_curve: tradeDollarCurve.map((n) => round(n, 2)),
    pool_l2_norm: round(poolL2Norm, 2),
    max_profit_usdc: round(maxProfit, 2),
    max_loss_usdc: round(maxLossWithFee, 2),
    collateral_required_usdc: round(collateralRequired, 2),
    l2_distance: round(l2Distance, 4),
    l2_norm: round(targetL2Norm, 4),
    max_band_exposure_usdc: round(net * Math.max(...target), 2),
    maker_fee_usdc: round(fee, 2),
    net_collateral_usdc: round(net, 2),
    quote_model: 'net_usdc_discrete_l2_distribution_amm',
    pricing_source: 'polymarket_gamma_clob',
    liquidity_depth_usd: round(candidate.aggregate_depth_usd, 2),
    depth_coverage_ratio: round(bandsWithDepth / Math.max(1, candidate.bands.length), 4),
    bands_with_orderbook: bandsWithOrderbook,
    bands_with_depth: bandsWithDepth,
    expected_band: candidate.bands[maxBand],
    pnl_curve: candidate.bands.map((band, index) => ({
      band_id: band.id,
      label: band.label,
      reference_probability: reference[index],
      target_probability: round(target[index]),
      position_usdc: round(tradeDollarCurve[index], 2),
      liquidity_depth_usd: round(band.depth_usd, 2),
    })),
  };
}

export async function buildDistributionLaunchPlan(candidateId: string): Promise<DistributionLaunchPlan> {
  const { candidates } = await discoverDistributionCandidates({ limit: 40 });
  const candidate = candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Unknown distribution candidate: ${candidateId}`);
  const requiredDepth = Math.max(1_000, candidate.band_count * 500);
  return {
    candidate_id: candidate.id,
    title: candidate.title,
    status: candidate.aggregate_depth_usd >= requiredDepth ? 'ready_to_launch' : 'needs_more_liquidity',
    launch_score: candidate.launch_score,
    required_depth_usd: requiredDepth,
    current_depth_usd: candidate.aggregate_depth_usd,
    bands: candidate.bands.map((band, index) => ({
      label: band.label,
      market_id: band.market_id,
      token_id: band.token_id,
      initial_weight: candidate.reference_curve[index],
      depth_usd: band.depth_usd,
    })),
  };
}
