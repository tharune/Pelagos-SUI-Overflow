/**
 * Live event-basket construction — backend.
 *
 * Builds the Pelagos "Event Baskets" surface (PBU-HIGH-* / PBU-LOW-*) from
 * the live Polymarket universe and prices every constituent leg off the
 * **Polymarket CLOB order book** (midpoint), not the Gamma snapshot. This is
 * the authoritative source for the /api/baskets endpoint the frontend renders.
 *
 * Pipeline:
 *   1. Pull a wide live universe via `fetchMarkets` (cached, paginates Gamma).
 *   2. Normalize each market into TWO sided candidates (YES + NO), so a
 *      long-shot market can power a HIGH basket via its NO side.
 *   3. Bucket candidates into the 6 baskets (HIGH/LOW × SHORT/MED/LONG) with a
 *      3-pass fill: strict tier/window + category ceil, then relax, then a
 *      cross-tier rescue. Correlation dedupe on underlying / event / topic.
 *   4. Re-price every SELECTED leg from the live CLOB midpoint (one batched
 *      POST per ~50 tokens), falling back to the market BBO mid, then the
 *      Gamma outcome price. Each leg is tagged with its `priceSource`.
 *   5. Weight legs sqrt(volume) with per-leg clamps, tilt toward the tier's
 *      target NAV (HIGH→0.95, LOW→0.05), and compute NAV = Σ w·p on the
 *      CLOB-priced probabilities.
 *
 * The MID (tier 70) basket has been retired — only HIGH and LOW ship.
 */

import { fetchMarkets } from './polymarket';
import { proxiedFetch } from './proxy';
import { PolymarketMarket } from '../types';
import { buildTfIdf, tfidfCosine, type TfIdfCorpus } from './nlp';

const CLOB_API = 'https://clob.polymarket.com';

// ---------------------------------------------------------------------------
// Tier / window bands (HIGH + LOW only — MID retired)
// ---------------------------------------------------------------------------

type Tier = 90 | 50;
type WindowKey = 'week' | 'month' | 'long';

const TIER_RANGE: Record<Tier, [number, number]> = {
  90: [0.85, 0.99],  // preferred: high-conviction
  50: [0.01, 0.12],  // preferred: long-shot (floor 1% skips dead/joke markets)
};
const TIER_RANGE_EXT: Record<Tier, [number, number]> = {
  90: [0.78, 0.995],
  50: [0.01, 0.22],
};
// Tier-level NAV targets. Weights are tilted post-hoc so the weighted
// probability lands near the archetype, keeping the risk ladder legible.
const TIER_TARGET_NAV: Record<Tier, number | null> = {
  90: 0.95,
  50: 0.05,
};
const TIER_TARGET_JITTER = 0.02;
const TIER_CODE: Record<Tier, string> = { 90: 'HIGH', 50: 'LOW' };

const WINDOW_RANGE: Record<WindowKey, [number, number]> = {
  week: [1, 7],
  month: [30, 90],
  long: [180, Number.POSITIVE_INFINITY],
};
const WINDOW_RANGE_EXT: Record<WindowKey, [number, number]> = {
  week: [1, 30],
  month: [14, 150],
  long: [120, Number.POSITIVE_INFINITY],
};
const WINDOW_CODE: Record<WindowKey, string> = {
  week: 'SHORT',
  month: 'MED',
  long: 'LONG',
};

// HIGH first — it's the sparsest pool, so it gets first pick on dedupe.
// Medium (`month`) was dropped — the ladder is just SHORT and LONG now.
const TARGET_COMBOS: Array<[Tier, WindowKey]> = [
  [90, 'week'], [90, 'long'],
  [50, 'week'], [50, 'long'],
];

const MIN_BASKET_LEGS = 4;
const MIN_VOLUME_USD = 10_000;
const CATEGORY_SHARE_CEIL = 0.35;
// Cap the constituent list so a single basket can't balloon the API payload
// or fan out hundreds of CLOB calls. With the de-correlation gate below the
// real count lands wherever the uncorrelated supply runs out, usually well
// under this cap — it's a ceiling, not a target.
const MAX_BASKET_LEGS = 50;
// At most this many legs from one correlation THEME (Middle-East, US-rates, a
// single primary season, …) — they move together, so a basket of 30 election
// races isn't diversified. Complements the TF-IDF cosine gate.
const MAX_PER_THEME = 2;
// Reject a leg whose TF-IDF cosine to ANY leg already in the basket exceeds
// this — catches near-duplicate phrasings ("Will X be the Democratic nominee
// for …") that the theme map and topic fingerprint both miss.
const CORR_COSINE_MAX = 0.45;
// How wide a live universe to pull. A wider pull gives the de-correlation gate
// more distinct themes to draw from, so baskets stay deep AND uncorrelated.
const UNIVERSE_LIMIT = 1800;

const LEG_DAILY_CHANGE_CLAMP = 0.5;
const BASKET_DAILY_CHANGE_CLAMP_PCT = 30;

type Category =
  | 'crypto' | 'politics' | 'sports' | 'economics'
  | 'entertainment' | 'tech' | 'world' | 'other';

// ---------------------------------------------------------------------------
// Public shapes (the /api/baskets contract)
// ---------------------------------------------------------------------------

export interface ApiBasketLeg {
  id: string;            // "<marketId>:YES" | "<marketId>:NO"
  underlyingId: string;  // Gamma market id (stable across sides)
  question: string;      // prefixed "No: " for NO legs
  conditionId: string;
  side: 'YES' | 'NO';
  probability: number;   // side-specific, CLOB midpoint when available
  yesProbability: number;
  weight: number;        // 0..1
  volumeUsd: number;
  liquidityUsd: number;
  spread: number | null;
  endDateIso?: string;
  daysToResolution: number;
  dailyChange: number;   // signed relative ~24h move
  tokenId: string;       // CLOB token id for THIS side
  eventId?: string;
  eventTitle?: string;
  marketSlug?: string;
  eventSlug?: string;
  category: Category;
  priceSource: 'clob' | 'bbo' | 'gamma';
}

export interface ApiBasket {
  id: string;            // "PBU-HIGH-SHORT"
  tier: Tier;
  window: WindowKey;
  nav: number;
  change: number;        // 24h %
  daysLeft: number;
  issue: number;
  totalLegs: number;
  marketVolumeUsd: number;
  clobPricedLegs: number; // how many legs got a true CLOB midpoint
  legs: ApiBasketLeg[];
}

export interface LiveBasketsResult {
  baskets: ApiBasket[];
  at: number;
  source: 'live';
  universe: number;       // markets scanned
  clob_priced_legs: number;
  total_legs: number;
}

// ---------------------------------------------------------------------------
// Candidate normalization
// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  underlyingId: string;
  question: string;
  conditionId: string;
  side: 'YES' | 'NO';
  probability: number;
  yesProbability: number;
  volumeUsd: number;
  liquidityUsd: number;
  spread: number | null;
  endDateIso?: string;
  daysToResolution: number;
  dailyChange: number;
  tokenId: string;
  eventId?: string;
  eventTitle?: string;
  marketSlug?: string;
  eventSlug?: string;
  topicKey: string;
  theme: string | null;
  category: Category;
  weight: number;
  bestBid?: number;
  bestAsk?: number;
  priceSource: 'clob' | 'bbo' | 'gamma';
}

const CATEGORY_PATTERNS: Array<[Category, RegExp]> = [
  ['crypto', /\b(bitcoin|btc|ethereum|eth|ether|crypto|defi|nft|token|blockchain|altcoin|dogecoin|doge|shiba|memecoin|stablecoin|xrp|ripple|cardano|ada|polygon|matic|avalanche|avax|binance|bnb|litecoin|ltc|chainlink|link|monero|solana|sol)\b/i],
  ['sports', /\b(nfl|nba|nhl|mlb|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|boxing|fifa|world cup|super bowl|playoff|playoffs|championship|league|draft|stanley cup|world series|olympics?|mvp|heisman|pga|epl|premier league|la liga|serie a|bundesliga|champions league|f1|formula 1|nascar)\b/i],
  ['politics', /\b(president(?:ial)?|election|senator|senate|congress|primary|governor|poll|polls|trump|biden|harris|democrat|republican|parliament|prime minister|minister|congressman|congresswoman|mayor|party|vote|voting|impeach|impeachment|cabinet|supreme court|scotus|ballot|caucus|nomination|referendum)\b/i],
  ['economics', /\b(fed|federal reserve|rate cut|rate hike|recession|gdp|inflation|unemployment|earnings|ipo|stock|nasdaq|s&p|sp500|treasury|bond|yield|cpi|ppi|jobs report|oil price|gas price|gold|dollar|bull market|bear market|market cap)\b/i],
  ['entertainment', /\b(album|movie|film|box office|oscar|oscars|academy award|grammy|emmy|netflix|hbo|disney|spotify|billboard|pop star|celebrity|single|chart|taylor swift|kardashian|kanye|drake|rihanna|beyonce|bieber|eurovision|no\.? 1|number one)\b/i],
  ['tech', /\b(ai|a\.i\.|chatgpt|gpt|openai|anthropic|claude|google|apple|meta|microsoft|amazon|tesla|nvidia|spacex|starship|iphone|ios|android|github|acquisition|merger|layoff|launch|release)\b/i],
  ['world', /\b(war|ceasefire|putin|zelensky|netanyahu|xi jinping|russia|ukraine|china|iran|israel|gaza|palestine|taiwan|korea|north korea|nuclear|nato|sanctions?|un security|united nations|hostage|refugee|coup)\b/i],
];

function classifyCategory(question: string): Category {
  for (const [cat, re] of CATEGORY_PATTERNS) {
    if (re.test(question)) return cat;
  }
  return 'other';
}

const TOPIC_STOP_WORDS = new Set<string>([
  'a', 'an', 'and', 'as', 'at', 'be', 'before', 'by', 'do', 'does', 'for',
  'from', 'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or', 'out', 'over',
  'reach', 'than', 'that', 'the', 'this', 'to', 'up', 'was', 'when', 'which',
  'who', 'will', 'with', 'would',
  '2024', '2025', '2026', '2027',
]);

function topicFingerprint(question: string): string {
  const cleaned = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length >= 3 && !TOPIC_STOP_WORDS.has(tok));
  const unique = Array.from(new Set(cleaned));
  unique.sort();
  return unique.slice(0, 4).join('|');
}

// Correlation themes — markets in the same theme react to the same shocks, so a
// basket of "Iran meeting" + "Hormuz reopens" + "Israel ceasefire" is one bet,
// not three. Each market maps to at most one theme (first match wins); the
// selector admits at most MAX_PER_THEME per basket. This is the entity-level
// half of the de-correlation; tfidfCosine is the lexical half.
const THEME_CLUSTERS: Array<[string, RegExp]> = [
  ['mideast', /\b(iran|tehran|israel|israeli|gaza|hamas|hezbollah|hormuz|strait|saudi|uae|qatar|netanyahu|houthi|lebanon|syria|persian gulf)\b/i],
  ['ukraine-russia', /\b(ukraine|ukrainian|russia|russian|putin|zelensky|kremlin|moscow|kyiv|donbas|crimea)\b/i],
  ['china-taiwan', /\b(china|chinese|taiwan|taiwanese|xi jinping|beijing|taipei|south china sea)\b/i],
  ['us-monetary', /\b(fed|fomc|federal reserve|rate cut|rate hike|powell|\bcpi\b|inflation|interest rate|jobs report|unemployment)\b/i],
  ['us-politics', /\b(trump|biden|harris|vance|newsom|democratic nominee|republican nominee|presidential|gubernatorial|congressional|\bprimary\b|senate|midterm|house seat|nominee for)\b/i],
  ['btc', /\b(bitcoin|btc)\b/i],
  ['eth', /\b(ethereum|\bether\b|\beth\b)\b/i],
  ['ai-labs', /\b(openai|gpt-?5|gpt-?6|chatgpt|anthropic|claude|gemini|\bagi\b|\bllm\b)\b/i],
];

function themeOf(question: string): string | null {
  for (const [theme, re] of THEME_CLUSTERS) if (re.test(question)) return theme;
  return null;
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

function parseDaysToResolution(endDateIso?: string): number {
  if (!endDateIso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(endDateIso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (t - Date.now()) / 86_400_000);
}

function extractOneDayAbsDelta(m: PolymarketMarket): number {
  if (typeof m.one_day_price_change === 'number' && Number.isFinite(m.one_day_price_change)) {
    return m.one_day_price_change;
  }
  if (typeof m.one_week_price_change === 'number' && Number.isFinite(m.one_week_price_change)) {
    return m.one_week_price_change / 7;
  }
  return 0;
}

function relativeChange(priceToday: number, absDelta: number): number {
  const prior = priceToday - absDelta;
  if (!Number.isFinite(prior) || prior < 0.01) return 0;
  if (!Number.isFinite(absDelta)) return 0;
  const raw = absDelta / prior;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(-LEG_DAILY_CHANGE_CLAMP, Math.min(LEG_DAILY_CHANGE_CLAMP, raw));
}

function normalizeMarketCandidates(m: PolymarketMarket): Candidate[] {
  if (!m.active || m.closed) return [];
  if (!m.question || !m.id) return [];
  const yesProb = parseYesProbability(m.outcomePrices);
  if (yesProb === null) return [];
  const vol = parseFloat(m.volume);
  if (!Number.isFinite(vol) || vol < MIN_VOLUME_USD) return [];

  const daysToResolution = parseDaysToResolution(m.end_date_iso);
  if (!Number.isFinite(daysToResolution)) return [];

  const deltaAbs = extractOneDayAbsDelta(m);
  const topicKey = topicFingerprint(m.question);
  const category = classifyCategory(m.question);

  // CLOB token ids per outcome. Prefer the `tokens` array (matched by outcome
  // text); fall back to the positional clob_token_ids ([YES, NO]).
  const yesToken =
    m.tokens?.find((t) => t.outcome?.toLowerCase() === 'yes')?.token_id ??
    m.tokens?.[0]?.token_id ??
    m.clob_token_ids?.[0] ?? '';
  const noToken =
    m.tokens?.find((t) => t.outcome?.toLowerCase() === 'no')?.token_id ??
    m.tokens?.[1]?.token_id ??
    m.clob_token_ids?.[1] ?? '';

  const shared = {
    underlyingId: m.id,
    conditionId: m.condition_id,
    volumeUsd: vol,
    liquidityUsd: Number.isFinite(m.liquidity_usd as number) ? (m.liquidity_usd as number) : 0,
    spread: typeof m.spread === 'number' && Number.isFinite(m.spread) ? m.spread : null,
    endDateIso: m.end_date_iso,
    daysToResolution,
    marketSlug: m.slug,
    eventSlug: m.event_slug,
    eventId: m.event_id,
    eventTitle: m.event_title,
    topicKey,
    theme: themeOf(m.question),
    category,
    bestBid: typeof m.best_bid === 'number' ? m.best_bid : undefined,
    bestAsk: typeof m.best_ask === 'number' ? m.best_ask : undefined,
    weight: 1 / MIN_BASKET_LEGS,
    priceSource: 'gamma' as const,
  };

  const yesLeg: Candidate = {
    ...shared,
    id: `${m.id}:YES`,
    question: m.question,
    side: 'YES',
    probability: yesProb,
    yesProbability: yesProb,
    dailyChange: relativeChange(yesProb, deltaAbs),
    tokenId: yesToken,
  };
  const noProb = 1 - yesProb;
  const noLeg: Candidate = {
    ...shared,
    id: `${m.id}:NO`,
    question: `No: ${m.question}`,
    side: 'NO',
    probability: noProb,
    yesProbability: yesProb,
    dailyChange: relativeChange(noProb, -deltaAbs),
    tokenId: noToken,
  };
  return [yesLeg, noLeg];
}

// ---------------------------------------------------------------------------
// Scoring + weighting
// ---------------------------------------------------------------------------

function inRange(v: number, [lo, hi]: [number, number]): boolean {
  return v >= lo && v <= hi;
}

function fitScore(m: Candidate, tier: Tier, win: WindowKey): number | null {
  if (!inRange(m.probability, TIER_RANGE_EXT[tier])) return null;
  const strictTier = inRange(m.probability, TIER_RANGE[tier]);
  const strictWin = inRange(m.daysToResolution, WINDOW_RANGE[win]);
  const extWin = inRange(m.daysToResolution, WINDOW_RANGE_EXT[win]);
  if (!extWin) return null;
  const tierPts = strictTier ? 1000 : 400;
  const winPts = strictWin ? 200 : 50;
  const volPts = Math.min(180, Math.log10(Math.max(1, m.volumeUsd)) * 15);
  return tierPts + winPts + volPts;
}

function maxLegWeightFor(n: number): number {
  if (n <= 10) return 0.25;
  return Math.min(0.25, Math.max(0.03, 3 / n));
}
function minLegWeightFor(n: number): number {
  if (n <= 10) return 0.03;
  return Math.max(0.001, 0.3 / n);
}

function clampAndNormalize(weights: number[], minWeight: number, maxWeight: number): number[] {
  const n = weights.length;
  let w = weights.slice();
  for (let iter = 0; iter < 20; iter++) {
    let excess = 0;
    const free: number[] = [];
    w = w.map((x, i) => {
      if (x > maxWeight) { excess += x - maxWeight; return maxWeight; }
      if (x < minWeight) { excess -= minWeight - x; return minWeight; }
      free.push(i);
      return x;
    });
    if (Math.abs(excess) < 1e-6 || free.length === 0) break;
    const freeSum = free.reduce((s, i) => s + w[i], 0);
    if (freeSum <= 0) break;
    for (const i of free) w[i] = w[i] + (w[i] / freeSum) * excess;
  }
  const total = w.reduce((a, b) => a + b, 0);
  return total > 0 ? w.map((x) => x / total) : Array(n).fill(1 / n);
}

/**
 * Liquidity-weighted basket weights. Primary factor is traded VOLUME (sqrt-damped
 * so a whale market can't dominate), boosted gently by live order-book DEPTH
 * (liquidityUsd, quarter-power) so two markets with equal volume tilt toward the
 * one that's actually deep/tradeable. Both signals are liquidity; depth degrades
 * gracefully to neutral when a market doesn't report it. Then size-scaled clamps.
 */
function computeLegWeights(legs: Candidate[]): number[] {
  const n = legs.length;
  if (n === 0) return [];
  const minWeight = minLegWeightFor(n);
  const maxWeight = maxLegWeightFor(n);
  const raw = legs.map((l) => {
    const vol = Math.sqrt(Math.max(1, l.volumeUsd));
    const depth = Math.pow(Math.max(1, l.liquidityUsd || 0), 0.25); // depth boost, ≥1
    return vol * depth;
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  const start = sum > 0 ? raw.map((r) => r / sum) : Array(n).fill(1 / n);
  return clampAndNormalize(start, minWeight, maxWeight);
}

function recenterWeightsToTarget(legs: Candidate[], baseWeights: number[], targetNav: number): number[] {
  const n = legs.length;
  if (n === 0 || n !== baseWeights.length) return baseWeights;
  const minWeight = minLegWeightFor(n);
  const maxWeight = maxLegWeightFor(n);
  const probs = legs.map((l) => l.probability);
  const minP = Math.min(...probs);
  const maxP = Math.max(...probs);
  if (targetNav >= maxP || targetNav <= minP) return baseWeights;

  const applyTilt = (lam: number): { nav: number; weights: number[] } => {
    const raw = baseWeights.map((w, i) => w * Math.exp(lam * (probs[i] - targetNav)));
    const sum = raw.reduce((a, b) => a + b, 0);
    const start = sum > 0 ? raw.map((r) => r / sum) : Array(n).fill(1 / n);
    const weights = clampAndNormalize(start, minWeight, maxWeight);
    const nav = weights.reduce((s, x, i) => s + x * probs[i], 0);
    return { nav, weights };
  };

  const baseline = applyTilt(0);
  if (Math.abs(baseline.nav - targetNav) < 1e-4) return baseline.weights;
  let lo = -15, hi = 15, best = baseline;
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    const result = applyTilt(mid);
    if (Math.abs(result.nav - targetNav) < Math.abs(best.nav - targetNav)) best = result;
    if (Math.abs(result.nav - targetNav) < 1e-4) return result.weights;
    if (result.nav < targetNav) lo = mid; else hi = mid;
    if (Math.abs(hi - lo) < 1e-6) break;
  }
  return best.weights;
}

// Seeded RNG for stable per-basket NAV jitter (no Math.random — deterministic).
function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

// ---------------------------------------------------------------------------
// CLOB midpoint enrichment
// ---------------------------------------------------------------------------

/**
 * Batched live midpoints from the Polymarket CLOB. POST /midpoints takes a
 * raw array `[{token_id}]` and returns `{ "<token_id>": "<mid>" }`. Chunked so
 * one slow upstream call can't stall the whole set; a dead chunk just leaves
 * those legs to the BBO/Gamma fallback.
 */
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

/**
 * Re-price a selected leg from the live CLOB midpoint, falling back to the
 * market BBO mid, then the Gamma outcome price. Mutates probability /
 * dailyChange basis and tags the source.
 */
function applyClobPrice(leg: Candidate, mids: Map<string, number>): Candidate {
  const clob = leg.tokenId ? mids.get(leg.tokenId) : undefined;
  if (typeof clob === 'number' && Number.isFinite(clob) && clob > 0 && clob < 1) {
    return { ...leg, probability: clob, priceSource: 'clob' };
  }
  // BBO fallback: best_bid/best_ask are the YES market's top of book.
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
// Basket build
// ---------------------------------------------------------------------------

function buildBasketRosters(candidates: Candidate[]): Array<{ tier: Tier; window: WindowKey; id: string; legs: Candidate[] }> {
  const rosters: Array<{ tier: Tier; window: WindowKey; id: string; legs: Candidate[] }> = [];
  const claimedUnderlying = new Set<string>();

  // NLP de-correlation: TF-IDF over every candidate question once, then reject a
  // leg whose cosine to one already in the basket exceeds CORR_COSINE_MAX. This
  // is the lexical half — it kills near-duplicate phrasings the theme map misses.
  const corpus: TfIdfCorpus = buildTfIdf(candidates.map((c, i) => ({ id: String(i), text: c.question })));
  const corpusIdx = new Map<Candidate, number>();
  candidates.forEach((c, i) => corpusIdx.set(c, i));
  const tooSimilar = (m: Candidate, admitted: Candidate[]): boolean => {
    const mi = corpusIdx.get(m);
    if (mi === undefined) return false;
    for (const a of admitted) {
      const ai = corpusIdx.get(a);
      if (ai !== undefined && tfidfCosine(corpus, mi, ai) > CORR_COSINE_MAX) return true;
    }
    return false;
  };

  for (const [tier, win] of TARGET_COMBOS) {
    const id = `PBU-${TIER_CODE[tier]}-${WINDOW_CODE[win]}`;

    const scored: Array<{ m: Candidate; s: number }> = [];
    for (const m of candidates) {
      if (claimedUnderlying.has(m.underlyingId)) continue;
      const s = fitScore(m, tier, win);
      if (s === null) continue;
      scored.push({ m, s });
    }
    scored.sort((a, b) => b.s - a.s);

    const legs: Candidate[] = [];
    const takenUnderlying = new Set<string>();
    const takenEvents = new Set<string>();
    const takenTopics = new Set<string>();
    const themeCounts = new Map<string, number>();
    const catCounts = new Map<Category, number>();
    const admit = (m: Candidate) => {
      legs.push(m);
      takenUnderlying.add(m.underlyingId);
      if (m.eventId) takenEvents.add(m.eventId);
      if (m.topicKey) takenTopics.add(m.topicKey);
      if (m.theme) themeCounts.set(m.theme, (themeCounts.get(m.theme) ?? 0) + 1);
    };

    // Pass 1: strict dedupe + category ceil + NLP de-correlation (theme + cosine).
    for (const { m } of scored) {
      if (legs.length >= MAX_BASKET_LEGS) break;
      if (takenUnderlying.has(m.underlyingId)) continue;
      if (m.eventId && takenEvents.has(m.eventId)) continue;
      if (m.topicKey && takenTopics.has(m.topicKey)) continue;
      if (m.theme && (themeCounts.get(m.theme) ?? 0) >= MAX_PER_THEME) continue;
      if (tooSimilar(m, legs)) continue;
      const catSoFar = catCounts.get(m.category) ?? 0;
      const projected = legs.length + 1;
      const ceil = Math.max(3, Math.ceil(projected * CATEGORY_SHARE_CEIL));
      if (catSoFar + 1 > ceil) continue;
      admit(m);
      catCounts.set(m.category, catSoFar + 1);
    }

    // Pass 2: relax the category ceil if still under the floor.
    if (legs.length < MIN_BASKET_LEGS) {
      for (const { m } of scored) {
        if (legs.length >= MAX_BASKET_LEGS) break;
        if (takenUnderlying.has(m.underlyingId)) continue;
        if (m.eventId && takenEvents.has(m.eventId)) continue;
        if (m.topicKey && takenTopics.has(m.topicKey)) continue;
        admit(m);
      }
    }

    // Pass 3: cross-tier rescue — ignore the global claim so a starved combo
    // (usually LOW-SHORT) can still field a basket from the full pool.
    if (legs.length < MIN_BASKET_LEGS) {
      const rescue: Array<{ m: Candidate; s: number }> = [];
      for (const m of candidates) {
        const s = fitScore(m, tier, win);
        if (s !== null) rescue.push({ m, s });
      }
      rescue.sort((a, b) => b.s - a.s);
      for (const { m } of rescue) {
        if (legs.length >= MIN_BASKET_LEGS) break;
        if (takenUnderlying.has(m.underlyingId)) continue;
        if (m.eventId && takenEvents.has(m.eventId)) continue;
        if (m.topicKey && takenTopics.has(m.topicKey)) continue;
        admit(m);
      }
    }

    if (legs.length < MIN_BASKET_LEGS) continue; // omit; frontend keeps a seed card

    for (const leg of legs) claimedUnderlying.add(leg.underlyingId);
    rosters.push({ tier, window: win, id, legs });
  }
  return rosters;
}

function finalizeBasket(
  tier: Tier,
  win: WindowKey,
  id: string,
  legs: Candidate[],
): ApiBasket {
  const baseWeights = computeLegWeights(legs);
  const tierTarget = TIER_TARGET_NAV[tier];
  let jitteredTarget: number | null = null;
  if (tierTarget !== null) {
    const rng = seededRng(`${id}:nav-jitter`);
    rng(); rng(); rng();
    const offset = (rng() - 0.5) * 2 * TIER_TARGET_JITTER;
    jitteredTarget = Math.max(0.01, Math.min(0.99, tierTarget + offset));
  }
  const weights = jitteredTarget !== null
    ? recenterWeightsToTarget(legs, baseWeights, jitteredTarget)
    : baseWeights;

  const weighted = legs.map((leg, i) => ({ ...leg, weight: Number(weights[i].toFixed(4)) }));
  const nav = weighted.reduce((s, m) => s + m.weight * m.probability, 0);
  const rawChangePct = weighted.reduce((s, m) => s + m.weight * m.dailyChange, 0) * 100;
  const changePct = Number.isFinite(rawChangePct)
    ? Math.max(-BASKET_DAILY_CHANGE_CLAMP_PCT, Math.min(BASKET_DAILY_CHANGE_CLAMP_PCT, rawChangePct))
    : 0;
  const daysLeft = Math.max(0, Math.round(weighted.reduce((s, m) => s + m.weight * m.daysToResolution, 0)));
  const marketVolumeUsd = weighted.reduce((s, m) => s + m.volumeUsd, 0);
  const clobPricedLegs = weighted.filter((m) => m.priceSource === 'clob').length;

  const legsOut: ApiBasketLeg[] = weighted.map((m) => ({
    id: m.id,
    underlyingId: m.underlyingId,
    question: m.question,
    conditionId: m.conditionId,
    side: m.side,
    probability: Number(m.probability.toFixed(4)),
    yesProbability: Number(m.yesProbability.toFixed(4)),
    weight: m.weight,
    volumeUsd: Math.round(m.volumeUsd),
    liquidityUsd: Math.round(m.liquidityUsd),
    spread: m.spread,
    endDateIso: m.endDateIso,
    daysToResolution: Math.round(m.daysToResolution),
    dailyChange: Number(m.dailyChange.toFixed(4)),
    tokenId: m.tokenId,
    eventId: m.eventId,
    eventTitle: m.eventTitle,
    marketSlug: m.marketSlug,
    eventSlug: m.eventSlug,
    category: m.category,
    priceSource: m.priceSource,
  }));

  return {
    id,
    tier,
    window: win,
    nav: Number(nav.toFixed(4)),
    issue: Number(nav.toFixed(4)),
    change: Number(changePct.toFixed(2)),
    daysLeft,
    totalLegs: legsOut.length,
    marketVolumeUsd: Math.round(marketVolumeUsd),
    clobPricedLegs,
    legs: legsOut,
  };
}

// ---------------------------------------------------------------------------
// Cached entry point
// ---------------------------------------------------------------------------

let _cache: { at: number; result: LiveBasketsResult } | null = null;
const CACHE_TTL_MS = 120_000;
let _inflight: Promise<LiveBasketsResult> | null = null;

export async function getLiveBaskets(force = false): Promise<LiveBasketsResult> {
  const fresh = _cache && Date.now() - _cache.at < CACHE_TTL_MS;
  if (!force && fresh) return _cache!.result;
  // Stale-while-revalidate: the full rebuild (wide universe → de-correlate →
  // CLOB-price ~200 legs) takes several seconds, so once we have ANY result we
  // serve it instantly and refresh in the background. Users never block on it.
  if (!force && _cache) {
    if (!_inflight) _inflight = computeLiveBaskets().finally(() => { _inflight = null; });
    void _inflight.catch(() => { /* keep serving the stale cache */ });
    return _cache.result;
  }
  // Cold (no cache yet) or forced — must build and wait.
  if (_inflight) return _inflight;
  _inflight = computeLiveBaskets().finally(() => { _inflight = null; });
  return _inflight;
}

// Pre-warm on boot so the very first user request hits a ready cache instead of
// paying the multi-second cold build.
void getLiveBaskets().catch(() => { /* network may be cold; the route retries */ });

async function computeLiveBaskets(): Promise<LiveBasketsResult> {
  const markets = await fetchMarkets({ limit: UNIVERSE_LIMIT, active: true, closed: false });
  const candidates = markets.flatMap(normalizeMarketCandidates);

  // Select rosters from Gamma-priced candidates (stable, full pool)…
  const rosters = buildBasketRosters(candidates);

  // …then re-price the SELECTED legs off the live CLOB book.
  const tokenIds = rosters.flatMap((r) => r.legs.map((l) => l.tokenId));
  const mids = await fetchClobMidpoints(tokenIds);

  const baskets = rosters.map((r) =>
    finalizeBasket(r.tier, r.window, r.id, r.legs.map((l) => applyClobPrice(l, mids))),
  );

  // Stable display order: HIGH before LOW, SHORT→MED→LONG.
  const tierOrder: Record<Tier, number> = { 90: 0, 50: 1 };
  const winOrder: Record<WindowKey, number> = { week: 0, month: 1, long: 2 };
  baskets.sort((a, b) => (tierOrder[a.tier] - tierOrder[b.tier]) || (winOrder[a.window] - winOrder[b.window]));

  const total_legs = baskets.reduce((s, b) => s + b.totalLegs, 0);
  const clob_priced_legs = baskets.reduce((s, b) => s + b.clobPricedLegs, 0);

  const result: LiveBasketsResult = {
    baskets,
    at: Date.now(),
    source: 'live',
    universe: markets.length,
    clob_priced_legs,
    total_legs,
  };
  _cache = { at: result.at, result };
  return result;
}
