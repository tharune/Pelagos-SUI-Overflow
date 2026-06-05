import { Router, Request, Response } from 'express';
import {
  fetchMarkets,
  fetchMarketByConditionId,
  searchMarkets,
} from '../services/polymarket';
import {
  filterMarkets,
  FilterConfig,
  DEFAULT_FILTER_CONFIG,
} from '../services/market-filter';
import { Category } from '../services/nlp';
import { metrics } from '../services/metrics';

const router = Router();

// Polymarket CLOB endpoint. We proxy /book requests from here so the
// browser never hits CLOB directly (avoids CORS + lets us cache / batch).
const CLOB_API = 'https://clob.polymarket.com';

// Short per-token cache so rapid amount-change quotes don't hammer the
// upstream. 3-second TTL keeps quotes effectively live while giving us
// request coalescing on the hot path.
interface BookLevel { price: number; size: number }
interface CachedBook { bids: BookLevel[]; asks: BookLevel[]; fetched_at: number }
const BOOK_CACHE_TTL_MS = 3_000;
const BOOK_CACHE_MAX = 512;
const bookCache = new Map<string, CachedBook>();

function setCached(tokenId: string, book: CachedBook): void {
  if (bookCache.size >= BOOK_CACHE_MAX) {
    // Drop the oldest entry — Map preserves insertion order.
    const firstKey = bookCache.keys().next().value;
    if (firstKey) bookCache.delete(firstKey);
  }
  bookCache.set(tokenId, book);
}

async function fetchBook(tokenId: string): Promise<CachedBook | null> {
  const cached = bookCache.get(tokenId);
  if (cached && Date.now() - cached.fetched_at < BOOK_CACHE_TTL_MS) {
    return cached;
  }
  try {
    const r = await fetch(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const raw = (await r.json()) as {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    };
    // Sort best-first (bids high→low, asks low→high) BEFORE trimming so the
    // top 25 levels are the executable top-of-book — not 25 arbitrary levels.
    const trim = (
      arr: Array<{ price: string; size: string }> = [],
      side: 'bid' | 'ask',
    ): BookLevel[] =>
      arr
        .map((lvl) => ({ price: Number(lvl.price), size: Number(lvl.size) }))
        .sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
        .slice(0, 25);
    const book: CachedBook = {
      bids: trim(raw.bids, 'bid'),
      asks: trim(raw.asks, 'ask'),
      fetched_at: Date.now(),
    };
    setCached(tokenId, book);
    return book;
  } catch {
    return null;
  }
}

/**
 * GET /api/markets/orderbooks?token_ids=id1,id2,id3
 *
 * Live Polymarket CLOB orderbook snapshot for the given token ids,
 * batched and cached (3s TTL). Returned books are trimmed to the top 25
 * levels per side, which is plenty for slippage estimation on a
 * basket-buy of reasonable size.
 */
router.get('/orderbooks', async (req: Request, res: Response) => {
  const param = (req.query.token_ids as string) || '';
  const ids = param
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25); // cap fan-out per request
  if (ids.length === 0) {
    return res.status(400).json({ error: 'token_ids query parameter is required' });
  }
  const books = await Promise.all(
    ids.map(async (tokenId) => {
      const b = await fetchBook(tokenId);
      if (!b) return { token_id: tokenId, bids: [], asks: [], error: true };
      return { token_id: tokenId, bids: b.bids, asks: b.asks };
    }),
  );
  res.json({ count: books.length, books });
});

const VALID_CATEGORIES: ReadonlyArray<Category> = [
  'crypto', 'sports', 'politics', 'economics', 'entertainment', 'tech', 'world', 'other',
];

/**
 * GET /api/markets
 * List available Polymarket markets.
 * Query params: limit (default 20), active (default true)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    // Clamp to [1, 20000] — fetchMarkets auto-paginates past Gamma's 500/page
    // cap. The full active-market universe is typically <5k, but we leave
    // generous headroom so the frontend can ask for "everything" and let
    // the backend terminate naturally when Gamma returns an empty page.
    const rawLimit = parseInt(req.query.limit as string, 10) || 20;
    const limit = Math.max(1, Math.min(20000, rawLimit));
    const active = req.query.active !== 'false';

    const markets = await fetchMarkets({
      limit,
      active,
      closed: !active,
    });

    res.json({
      count: markets.length,
      markets,
    });
  } catch (err) {
    console.error('GET /api/markets error:', err);
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

/**
 * GET /api/markets/curated
 * Polymarket markets after the five-stage filter pipeline. Drops BS markets
 * (low volume, troll questions, near-duplicates, uncategorisable).
 *
 * Query params:
 *   limit        max markets returned after filtering (default 24)
 *   overfetch    raw Polymarket page size before filtering (default limit*4)
 *   category     restrict to a single category (crypto|sports|politics|...)
 *   min_volume   override default liquidity floor (USD)
 *   min_days     override minimum days-to-resolution
 *   max_days     override maximum days-to-resolution
 */
router.get('/curated', async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string, 10) || 24));
    const overfetch = Math.max(limit, Math.min(400, parseInt(req.query.overfetch as string, 10) || limit * 4));
    const categoryParam = typeof req.query.category === 'string' ? req.query.category.toLowerCase() : undefined;
    if (categoryParam && !VALID_CATEGORIES.includes(categoryParam as Category)) {
      return res.status(400).json({ error: `category must be one of ${VALID_CATEGORIES.join(', ')}` });
    }

    const overrides: Partial<FilterConfig> = {};
    const minVol = parseFloat(req.query.min_volume as string);
    if (Number.isFinite(minVol)) overrides.minVolumeUsd = minVol;
    const minDays = parseFloat(req.query.min_days as string);
    if (Number.isFinite(minDays)) overrides.minDaysToResolution = minDays;
    const maxDays = parseFloat(req.query.max_days as string);
    if (Number.isFinite(maxDays)) overrides.maxDaysToResolution = maxDays;

    const raw = await fetchMarkets({ limit: overfetch, active: true, closed: false });
    const result = filterMarkets(raw, overrides);

    // Record the run in the monitor's funnel counters
    metrics.recordFilterRun({
      timestamp: Date.now(),
      source: 'curated_list',
      input_count: result.funnel.input_count,
      kept_count: result.funnel.kept_count,
      rejected_count: result.funnel.rejected_count,
      per_stage: {
        liquidity_floor: { entered: result.funnel.per_stage.liquidity_floor.entered, rejected: result.funnel.per_stage.liquidity_floor.rejected },
        quality_nlp: { entered: result.funnel.per_stage.quality_nlp.entered, rejected: result.funnel.per_stage.quality_nlp.rejected },
        time_window: { entered: result.funnel.per_stage.time_window.entered, rejected: result.funnel.per_stage.time_window.rejected },
        category_classify: { entered: result.funnel.per_stage.category_classify.entered, rejected: result.funnel.per_stage.category_classify.rejected },
        diversity_prefilter: { entered: result.funnel.per_stage.diversity_prefilter.entered, rejected: result.funnel.per_stage.diversity_prefilter.rejected },
      },
    });

    let kept = result.kept;
    if (categoryParam) kept = kept.filter((r) => r.category === categoryParam);

    const trimmed = kept.slice(0, limit).map((r) => ({
      id: r.market.id,
      question: r.market.question,
      condition_id: r.market.condition_id,
      outcomePrices: r.market.outcomePrices,
      volume_usd: r.volumeUsd,
      end_date_iso: r.market.end_date_iso,
      days_to_resolution: r.daysToResolution,
      yes_probability: r.yesProbability,
      category: r.category,
      category_confidence: Math.round(r.categoryConfidence * 1000) / 1000,
    }));

    res.json({
      count: trimmed.length,
      total_after_filter: kept.length,
      funnel: result.funnel,
      config: result.config,
      markets: trimmed,
    });
  } catch (err) {
    console.error('GET /api/markets/curated error:', err);
    res.status(500).json({ error: 'Failed to fetch curated markets' });
  }
});

/**
 * GET /api/markets/curated/stats
 * Lifetime filter-funnel stats + last N run snapshots for the monitor.
 */
router.get('/curated/stats', (_req: Request, res: Response) => {
  res.json({
    lifetime: {
      filter_runs_total: metrics.filterRunsTotal,
      markets_seen: metrics.filterMarketsSeen,
      markets_kept: metrics.filterMarketsKept,
      markets_rejected: metrics.filterMarketsRejected,
      per_stage_rejected: metrics.filterStageRejected,
      kept_rate:
        metrics.filterMarketsSeen > 0
          ? metrics.filterMarketsKept / metrics.filterMarketsSeen
          : 0,
    },
    recent_runs: metrics.getRecentFilterRuns(10),
    default_config: DEFAULT_FILTER_CONFIG,
  });
});

/**
 * GET /api/markets/search/:query
 * Search markets by text. Must be before /:conditionId to avoid route conflict.
 */
router.get('/search/:query', async (req: Request, res: Response) => {
  try {
    const { query } = req.params;
    const limit = parseInt(req.query.limit as string, 10) || 20;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const markets = await searchMarkets(query, limit);

    res.json({
      query,
      count: markets.length,
      markets,
    });
  } catch (err) {
    console.error('GET /api/markets/search/:query error:', err);
    res.status(500).json({ error: 'Failed to search markets' });
  }
});

/**
 * GET /api/markets/:conditionId
 * Get single market details by condition ID.
 */
router.get('/:conditionId', async (req: Request, res: Response) => {
  try {
    const { conditionId } = req.params;
    const market = await fetchMarketByConditionId(conditionId);

    if (!market) {
      return res.status(404).json({ error: `Market not found: ${conditionId}` });
    }

    res.json(market);
  } catch (err) {
    console.error('GET /api/markets/:conditionId error:', err);
    res.status(500).json({ error: 'Failed to fetch market' });
  }
});

export const marketRoutes = router;
