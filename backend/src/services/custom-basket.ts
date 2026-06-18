/**
 * Custom Basket Builder — backend.
 *
 * Builds a bespoke, diversified, low-correlation Polymarket event basket on
 * demand (from a free-text query OR a curated theme) using the SAME Cumulant-Arc
 * methodology Pelagos already ships for its standing Event Baskets:
 *
 *   1. Pull a candidate universe:
 *        - query   -> searchMarkets(query) (text-narrowed live feed)
 *        - theme   -> getHighLiquidityMarkets(...) over the theme keyword set
 *      (falls back to the cached fetchMarkets universe if the upstream is thin).
 *   2. Run the 5-stage market-filter funnel (filterMarkets) to drop dead /
 *      joke / too-soon / mis-categorised / near-duplicate markets.
 *   3. Normalise each survivor into its single best SIDE (YES vs NO) so a
 *      long-shot market can still power a basket via its NO leg.
 *   4. Greedy DECORRELATED selection: walk candidates best-first and admit a leg
 *      only if its max predicted pair-correlation (scoreLegPair, the noisy-OR
 *      classifier stand-in) against the already-selected set is below a ceiling,
 *      AND the per-category cap is not exceeded. Targets `target_legs` legs.
 *   5. Inverse-variance / decorrelated weights via optimizeWeights (clamped
 *      2%–25%), then re-price every SELECTED leg off the live CLOB midpoint
 *      (one batched POST), falling back to BBO mid then the Gamma price.
 *   6. NAV = Σ wᵢ·pᵢ, basket σ from the real per-leg odds (basketSigmaFromLegs),
 *      VaR/CVaR risk gate (assessBasketRisk, risk_ratio ≤ 1.25), the
 *      diversification report (avg pairwise corr, effective leg count), tranche
 *      quotes (quoteTranches) and an MM entry quote (same fee/spread pattern as
 *      the basket-buy path).
 *
 * Everything priced here is LIVE where possible; each leg carries a
 * `priceSource` tag and the response carries a `sources` block so the frontend
 * never presents a fallback number as a live one.
 */

import { searchMarkets, getHighLiquidityMarkets, fetchMarkets } from './polymarket';
import { filterMarkets } from './market-filter';
import { optimizeWeights, assessBasketRisk, scoreLegPair, LegMetadata } from './correlation';
import { classifyCategory } from './nlp';
import { basketSigmaFromLegs, quoteTranches, TrancheQuote } from './tranching';
import { MM_BID_BPS } from './mm-quote';
import { proxiedFetch } from './proxy';
import { PolymarketMarket } from '../types';

const CLOB_API = 'https://clob.polymarket.com';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const DEFAULT_TARGET_LEGS = 12;
const MAX_TARGET_LEGS = 24;
const MIN_TARGET_LEGS = 4;
const DEFAULT_MAX_PER_CATEGORY = 4;
// Pair-correlation ceiling for greedy decorrelated admission. scoreLegPair is a
// conservative noisy-OR stand-in for the trained |rho|>=0.6 classifier; a leg is
// rejected if it co-moves with ANY already-selected leg above this.
const PAIR_CORR_CEIL = 0.35;
const MIN_VOLUME_USD = 10_000;
// How wide a candidate pool to pull before filtering.
const QUERY_FETCH = 80;
const THEME_FETCH = 120;
const UNIVERSE_FALLBACK_LIMIT = 1200;

// Protocol fee taken on a primary basket mint (bps of NAV notional). Mirrors the
// senior-basket protocol fee in tranching.ts so the entry quote stays in family.
const PROTOCOL_FEE_BPS = 25;
// MM entry spread above NAV (bps). Symmetric to the basket SELL discount the MM
// rail quotes (MM_BID_BPS.basket = 9_750 => 2.50% below mark); the buyer pays the
// same edge above the live mark on entry.
const MM_ENTRY_SPREAD_BPS = 10_000 - MM_BID_BPS.basket; // 250 bps

type Tier = 90 | 50;

type Category =
  | 'crypto' | 'politics' | 'sports' | 'economics'
  | 'entertainment' | 'tech' | 'world' | 'other';

// ---------------------------------------------------------------------------
// Curated themes
// ---------------------------------------------------------------------------

export interface ThemePreset {
  id: string;
  label: string;
  description: string;
  /** Keywords used to score/filter the high-liquidity universe for this theme. */
  keywords: string[];
  /** Default tier for this preset (90 = high-conviction, 50 = long-shot). */
  tier: Tier;
}

export const THEMES: ThemePreset[] = [
  {
    id: 'macro-2026',
    label: 'Macro 2026',
    description: 'Rates, inflation, recession, equity indices and the dollar into 2026.',
    keywords: ['fed', 'rate', 'inflation', 'recession', 'gdp', 'cpi', 'unemployment', 's&p', 'nasdaq', 'treasury', 'yield', 'gold', 'oil', 'dollar', 'earnings'],
    tier: 90,
  },
  {
    id: 'crypto',
    label: 'Crypto',
    description: 'BTC / ETH / majors price levels, ETFs, and on-chain catalysts.',
    keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'xrp', 'crypto', 'etf', 'stablecoin', 'defi', 'token', 'altcoin', 'halving'],
    tier: 90,
  },
  {
    id: 'geopolitics',
    label: 'Geopolitics',
    description: 'Conflict, ceasefires, elections abroad and great-power risk.',
    keywords: ['war', 'ceasefire', 'russia', 'ukraine', 'china', 'taiwan', 'iran', 'israel', 'gaza', 'nato', 'nuclear', 'sanctions', 'putin', 'xi'],
    tier: 90,
  },
  {
    id: 'ai-tech',
    label: 'AI & Tech',
    description: 'Model releases, big-tech milestones, AI capability and shipping bets.',
    keywords: ['ai', 'gpt', 'openai', 'anthropic', 'claude', 'gemini', 'nvidia', 'tesla', 'apple', 'meta', 'google', 'spacex', 'starship', 'launch', 'agi'],
    tier: 90,
  },
  {
    id: 'sports',
    label: 'Sports',
    description: 'Championships, finals and season outcomes across major leagues.',
    keywords: ['nfl', 'nba', 'mlb', 'nhl', 'super bowl', 'champions league', 'premier league', 'world cup', 'playoff', 'championship', 'finals', 'f1', 'ufc'],
    tier: 90,
  },
];

// ---------------------------------------------------------------------------
// Public shapes (the /api/custom-baskets/build contract)
// ---------------------------------------------------------------------------

export interface CustomBasketLeg {
  market_id: string;        // Gamma market id (stable across sides)
  conditionId: string;
  question: string;         // prefixed "No: " for NO legs
  side: 'YES' | 'NO';
  probability: number;      // side-specific, CLOB midpoint when available
  weight: number;           // 0..1
  volumeUsd: number;
  category: Category;
  eventTitle?: string;
  tokenId: string;          // CLOB token id for THIS side
  priceSource: 'clob' | 'bbo' | 'gamma';
}

export interface DiversificationReport {
  avg_pair_corr: number;
  eff_leg_count: number;
  risk_ratio: number;
  accepted: boolean;
  reason: string | null;
}

export interface CustomBasketTranche {
  kind: 'senior' | 'mezzanine' | 'junior';
  attach: number;
  detach: number;
  pricePerToken: number;
  expectedYieldPct: number;
}

export interface CustomBasketResult {
  query: string | null;
  theme: string | null;
  nav: number;
  sigma: number;
  accepted: boolean;
  diversification: DiversificationReport;
  legs: CustomBasketLeg[];
  tranches: CustomBasketTranche[];
  mm: {
    entry_cost_per_token: number;
    protocol_bps: number;
    mm_spread_bps: number;
  };
  sources: {
    universe: 'search' | 'theme' | 'universe_fallback';
    candidates_scanned: number;
    kept_after_filter: number;
    clob_priced_legs: number;
    price: 'clob+gamma' | 'gamma';
    correlation_model: string;
    at: number;
  };
}

// ---------------------------------------------------------------------------
// Candidate normalisation (single best side per market)
// ---------------------------------------------------------------------------

interface Candidate {
  marketId: string;
  conditionId: string;
  question: string;
  side: 'YES' | 'NO';
  probability: number;
  volumeUsd: number;
  category: Category;
  eventId?: string;
  eventTitle?: string;
  endDateIso?: string;
  tokenId: string;
  bestBid?: number;
  bestAsk?: number;
  priceSource: 'clob' | 'bbo' | 'gamma';
  fitScore: number;
}

function parseYesProbability(outcomePrices: string): number | null {
  try {
    const arr = JSON.parse(outcomePrices);
    if (Array.isArray(arr) && arr.length > 0) {
      const p = parseFloat(arr[0]);
      if (Number.isFinite(p) && p >= 0 && p <= 1) return p;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Tier-fit: prefer the side whose probability sits in the tier band. For a
 * HIGH (90) basket we want high-conviction legs (~0.6–0.97); for a LOW (50)
 * basket we want long-shots (~0.03–0.30). Returns the better side + a fit score.
 */
function bestSideFor(
  m: PolymarketMarket,
  tier: Tier,
  category: Category,
): Candidate | null {
  if (!m.active || m.closed) return null;
  if (!m.question || !m.id) return null;
  const yesProb = parseYesProbability(m.outcomePrices);
  if (yesProb === null) return null;
  const vol = parseFloat(m.volume);
  if (!Number.isFinite(vol) || vol < MIN_VOLUME_USD) return null;

  const yesToken =
    m.tokens?.find((t) => t.outcome?.toLowerCase() === 'yes')?.token_id ??
    m.tokens?.[0]?.token_id ??
    m.clob_token_ids?.[0] ?? '';
  const noToken =
    m.tokens?.find((t) => t.outcome?.toLowerCase() === 'no')?.token_id ??
    m.tokens?.[1]?.token_id ??
    m.clob_token_ids?.[1] ?? '';

  // Tier-preferred probability band (post-side selection).
  const band: [number, number] = tier === 90 ? [0.55, 0.97] : [0.03, 0.35];
  const center = tier === 90 ? 0.85 : 0.1;

  const sides: Array<{ side: 'YES' | 'NO'; prob: number; question: string; token: string }> = [
    { side: 'YES', prob: yesProb, question: m.question, token: yesToken },
    { side: 'NO', prob: 1 - yesProb, question: `No: ${m.question}`, token: noToken },
  ];

  let best: Candidate | null = null;
  for (const s of sides) {
    if (s.prob < band[0] || s.prob > band[1]) continue;
    // Closer to the tier center + higher volume ranks better.
    const proximity = 1 - Math.abs(s.prob - center);
    const volPts = Math.min(1, Math.log10(Math.max(1, vol)) / 7);
    const fitScore = proximity * 1000 + volPts * 180;
    if (!best || fitScore > best.fitScore) {
      best = {
        marketId: m.id,
        conditionId: m.condition_id,
        question: s.question,
        side: s.side,
        probability: s.prob,
        volumeUsd: vol,
        category,
        eventId: m.event_id,
        eventTitle: m.event_title,
        endDateIso: m.end_date_iso,
        tokenId: s.token,
        bestBid: typeof m.best_bid === 'number' ? m.best_bid : undefined,
        bestAsk: typeof m.best_ask === 'number' ? m.best_ask : undefined,
        priceSource: 'gamma',
        fitScore,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// CLOB midpoint enrichment (mirrors services/baskets.ts)
// ---------------------------------------------------------------------------

async function fetchClobMidpoints(tokenIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = Array.from(new Set(tokenIds.filter(Boolean)));
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const res = await proxiedFetch(`${CLOB_API}/midpoints`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk.map((token_id) => ({ token_id }))),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, string>;
      for (const [tid, mid] of Object.entries(json)) {
        const v = Number(mid);
        if (Number.isFinite(v) && v > 0 && v < 1) out.set(tid, v);
      }
    } catch {
      // Leave this chunk's legs to the BBO/Gamma fallback.
    }
  }
  return out;
}

function applyClobPrice(leg: Candidate, mids: Map<string, number>): Candidate {
  const clob = leg.tokenId ? mids.get(leg.tokenId) : undefined;
  if (typeof clob === 'number' && Number.isFinite(clob) && clob > 0 && clob < 1) {
    return { ...leg, probability: clob, priceSource: 'clob' };
  }
  if (typeof leg.bestBid === 'number' && typeof leg.bestAsk === 'number') {
    const yesMid = (leg.bestBid + leg.bestAsk) / 2;
    if (Number.isFinite(yesMid) && yesMid > 0 && yesMid < 1) {
      const sided = leg.side === 'YES' ? yesMid : 1 - yesMid;
      return { ...leg, probability: sided, priceSource: 'bbo' };
    }
  }
  return { ...leg, priceSource: 'gamma' };
}

// ---------------------------------------------------------------------------
// Theme keyword scoring
// ---------------------------------------------------------------------------

function themeMatchScore(question: string, keywords: string[]): number {
  const q = question.toLowerCase();
  let hits = 0;
  for (const kw of keywords) if (q.includes(kw)) hits++;
  return hits;
}

// ---------------------------------------------------------------------------
// Greedy decorrelated selection
// ---------------------------------------------------------------------------

function legMeta(c: Candidate): LegMetadata {
  return {
    id: c.marketId,
    question: c.question,
    end_date_iso: c.endDateIso,
    probability: c.probability,
    tags: [c.category],
  };
}

/**
 * Walk candidates best-first and admit a leg only if (a) it doesn't co-move with
 * any already-selected leg above PAIR_CORR_CEIL, (b) the per-category cap isn't
 * exceeded, and (c) it's not a duplicate event/market. Targets `targetLegs`.
 * Two passes: strict ceiling, then a relaxed ceiling to backfill toward the floor.
 */
function selectDecorrelated(
  candidates: Candidate[],
  targetLegs: number,
  maxPerCategory: number,
): Candidate[] {
  const selected: Candidate[] = [];
  const catCounts = new Map<Category, number>();
  const takenMarkets = new Set<string>();
  const takenEvents = new Set<string>();

  const tryAdmit = (corrCeil: number) => {
    for (const c of candidates) {
      if (selected.length >= targetLegs) break;
      if (takenMarkets.has(c.marketId)) continue;
      if (c.eventId && takenEvents.has(c.eventId)) continue;
      const catSoFar = catCounts.get(c.category) ?? 0;
      if (catSoFar >= maxPerCategory) continue;
      // Max predicted pair-correlation against the already-selected set.
      const meta = legMeta(c);
      let maxCorr = 0;
      for (const s of selected) {
        const corr = scoreLegPair(meta, legMeta(s));
        if (corr > maxCorr) maxCorr = corr;
        if (maxCorr >= corrCeil) break;
      }
      if (maxCorr >= corrCeil) continue;
      selected.push(c);
      takenMarkets.add(c.marketId);
      if (c.eventId) takenEvents.add(c.eventId);
      catCounts.set(c.category, catSoFar + 1);
    }
  };

  tryAdmit(PAIR_CORR_CEIL);
  if (selected.length < Math.min(targetLegs, MIN_TARGET_LEGS)) {
    tryAdmit(Math.min(0.6, PAIR_CORR_CEIL + 0.2));
  }
  return selected;
}

function avgPairwiseCorr(legs: LegMetadata[]): number {
  const n = legs.length;
  if (n < 2) return 0;
  let s = 0;
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      s += scoreLegPair(legs[i], legs[j]);
      pairs++;
    }
  }
  return pairs > 0 ? s / pairs : 0;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildArgs {
  query?: string;
  theme?: string;
  target_legs?: number;
  tier?: 90 | 50;
  max_per_category?: number;
}

function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// Small in-memory cache keyed on the normalised request (CLOB + filter passes
// are expensive). 90s TTL keeps repeat builds of the same theme/query snappy.
const _cache = new Map<string, { at: number; result: CustomBasketResult }>();
const CACHE_TTL_MS = 90_000;

export async function buildCustomBasket(args: BuildArgs): Promise<CustomBasketResult> {
  const query = (args.query ?? '').trim() || null;
  const themeId = (args.theme ?? '').trim() || null;
  const targetLegs = clampInt(args.target_legs, MIN_TARGET_LEGS, MAX_TARGET_LEGS, DEFAULT_TARGET_LEGS);
  const maxPerCategory = clampInt(args.max_per_category, 1, 12, DEFAULT_MAX_PER_CATEGORY);

  const theme = themeId ? THEMES.find((t) => t.id === themeId) ?? null : null;
  const tier: Tier = (args.tier === 50 ? 50 : args.tier === 90 ? 90 : theme?.tier ?? 90);

  const cacheKey = `${query ?? ''}|${themeId ?? ''}|${targetLegs}|${tier}|${maxPerCategory}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  // 1) Candidate universe.
  let raw: PolymarketMarket[] = [];
  let universeSource: CustomBasketResult['sources']['universe'] = 'theme';
  if (query) {
    raw = await searchMarkets(query, QUERY_FETCH);
    universeSource = 'search';
  } else if (theme) {
    raw = await getHighLiquidityMarkets(MIN_VOLUME_USD, THEME_FETCH);
    universeSource = 'theme';
  }
  // Fallback to the cached live universe when the targeted pull is thin.
  if (raw.length < targetLegs * 2) {
    const universe = await fetchMarkets({ limit: UNIVERSE_FALLBACK_LIMIT, active: true, closed: false });
    if (theme) {
      raw = universe
        .filter((m) => themeMatchScore(m.question ?? '', theme.keywords) > 0)
        .concat(raw);
    } else if (query) {
      const q = query.toLowerCase();
      raw = universe.filter((m) => m.question?.toLowerCase().includes(q)).concat(raw);
    } else {
      raw = universe;
    }
    if (raw.length === 0) raw = universe;
    universeSource = raw.length && !query && !theme ? 'universe_fallback' : universeSource;
  }
  // De-dupe by market id (search + universe-fallback can overlap).
  {
    const seen = new Set<string>();
    raw = raw.filter((m) => (m.id && !seen.has(m.id) ? (seen.add(m.id), true) : false));
  }
  const candidatesScanned = raw.length;

  // 2) Five-stage filter funnel.
  const filtered = filterMarkets(raw, { minVolumeUsd: MIN_VOLUME_USD });
  const keptMarkets = filtered.kept.map((k) => k.market);

  // 3) Normalise each survivor into its single best side.
  let candidates: Candidate[] = [];
  for (const m of keptMarkets) {
    const category = classifyCategory(m.question).category as Category;
    const c = bestSideFor(m, tier, category);
    if (c) candidates.push(c);
  }
  // For a theme build, bias the order toward keyword relevance, then fit.
  if (theme) {
    candidates.sort(
      (a, b) =>
        themeMatchScore(b.question, theme.keywords) - themeMatchScore(a.question, theme.keywords) ||
        b.fitScore - a.fitScore,
    );
  } else {
    candidates.sort((a, b) => b.fitScore - a.fitScore);
  }

  // 4) Greedy decorrelated selection.
  let selected = selectDecorrelated(candidates, targetLegs, maxPerCategory);

  // 5) Re-price selected legs off the live CLOB book.
  const mids = await fetchClobMidpoints(selected.map((l) => l.tokenId));
  selected = selected.map((l) => applyClobPrice(l, mids));

  // 6) Weights (inverse-variance / decorrelated, clamped 2%–25%).
  const metas = selected.map(legMeta);
  const wr = optimizeWeights(metas, { floorBps: 200, capBps: 2_500 });
  const weights = wr.weights.length === selected.length
    ? wr.weights
    : selected.map(() => 1 / Math.max(1, selected.length));

  const legs: CustomBasketLeg[] = selected.map((c, i) => ({
    market_id: c.marketId,
    conditionId: c.conditionId,
    question: c.question,
    side: c.side,
    probability: Number(c.probability.toFixed(4)),
    weight: Number((weights[i] ?? 0).toFixed(4)),
    volumeUsd: Math.round(c.volumeUsd),
    category: c.category,
    eventTitle: c.eventTitle,
    tokenId: c.tokenId,
    priceSource: c.priceSource,
  }));

  // NAV + σ from the REAL per-leg odds.
  const nav = legs.reduce((s, l) => s + l.weight * l.probability, 0);
  const sigma =
    basketSigmaFromLegs(legs.map((l) => ({ probability: l.probability, weight: l.weight }))) ??
    Math.max(0.005, Math.sqrt((nav * (1 - nav)) / Math.max(1, legs.length)));

  // Risk gate (VaR/CVaR, risk_ratio ≤ 1.25) + diversification report.
  const risk = assessBasketRisk(metas, weights);
  const avgCorr = avgPairwiseCorr(metas);
  // Herfindahl-effective leg count from the final weights.
  const hhi = weights.reduce((s, w) => s + w * w, 0);
  const effLegCount = hhi > 0 ? 1 / hhi : legs.length;
  const riskRatio = Math.sqrt(
    legs.length * risk.internal_corr_mean + 1 - risk.internal_corr_mean,
  );

  const diversification: DiversificationReport = {
    avg_pair_corr: Number(avgCorr.toFixed(4)),
    eff_leg_count: Number(effLegCount.toFixed(2)),
    risk_ratio: Number(riskRatio.toFixed(4)),
    accepted: risk.accepted,
    reason: risk.reason ?? null,
  };

  // Horizon: weighted days-to-resolution of the selected legs.
  const now = Date.now();
  const horizonDays = (() => {
    let s = 0;
    let wsum = 0;
    selected.forEach((c, i) => {
      if (!c.endDateIso) return;
      const d = (new Date(c.endDateIso).getTime() - now) / 86_400_000;
      if (Number.isFinite(d) && d > 0) {
        s += (weights[i] ?? 0) * d;
        wsum += weights[i] ?? 0;
      }
    });
    return wsum > 0 ? s / wsum : 30;
  })();

  // Tranche quotes off the live NAV + σ.
  const weakestLegVolumeUsd = legs.length
    ? Math.min(...legs.map((l) => l.volumeUsd))
    : 50_000;
  const trancheQuotes: TrancheQuote[] = legs.length
    ? quoteTranches({
        bundleNav: nav,
        totalLegs: legs.length,
        horizonDays,
        sigma,
        weakestLegVolumeUsd,
        effLegCount,
      })
    : [];
  const tranches: CustomBasketTranche[] = trancheQuotes.map((t) => ({
    kind: t.kind,
    attach: t.attach,
    detach: t.detach,
    pricePerToken: t.pricePerToken,
    expectedYieldPct: t.expectedYieldPct,
  }));

  // MM entry quote — buyer pays NAV plus the same edge the basket MM rail charges
  // on exit (250 bps) plus the protocol fee. Mirrors the basket buy pattern.
  const entryPerToken =
    nav * (1 + MM_ENTRY_SPREAD_BPS / 10_000) * (1 + PROTOCOL_FEE_BPS / 10_000);

  const clobPricedLegs = legs.filter((l) => l.priceSource === 'clob').length;

  const result: CustomBasketResult = {
    query,
    theme: theme?.id ?? null,
    nav: Number(nav.toFixed(4)),
    sigma: Number(sigma.toFixed(4)),
    accepted: risk.accepted,
    diversification,
    legs,
    tranches,
    mm: {
      entry_cost_per_token: Number(entryPerToken.toFixed(4)),
      protocol_bps: PROTOCOL_FEE_BPS,
      mm_spread_bps: MM_ENTRY_SPREAD_BPS,
    },
    sources: {
      universe: universeSource,
      candidates_scanned: candidatesScanned,
      kept_after_filter: filtered.kept.length,
      clob_priced_legs: clobPricedLegs,
      price: clobPricedLegs > 0 ? 'clob+gamma' : 'gamma',
      correlation_model: wr.model_version,
      at: Date.now(),
    },
  };

  _cache.set(cacheKey, { at: Date.now(), result });
  return result;
}
