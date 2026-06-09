/**
 * Live-basket synthesis.
 *
 * The /app/basket page shows "synthetic" baskets — groupings of real, live
 * Polymarket markets bucketed by:
 *   - probability tier         (90 = 85-99%, 70 = 25-75%, 50 = 1-12%)
 *   - resolution window        (week = <7d, month = 30-90d, long = 180d+)
 *
 * Each underlying Polymarket market contributes TWO candidate legs — its YES
 * side and its NO side — and the bucket each side lands in depends on its
 * own probability. That means a low-probability market can still power a
 * high-tier basket by taking its NO side, which widens the pool of eligible
 * legs without having to lower liquidity or tier thresholds.
 *
 * Correlation dedupe runs on three axes so no two legs track the same bet:
 *   1. underlying market id — a given market contributes at most one leg
 *      across all nine baskets (prevents YES in 50-tier + NO in 90-tier).
 *   2. Polymarket `event_id` — every market in one event (e.g. "What will
 *      happen before GTA VI?") shares a resolution frame and is therefore
 *      correlated; only one market per event wins a basket slot across the
 *      whole grid.
 *   3. question-topic fingerprint — a coarse token-set hash so near-duplicate
 *      questions without a shared event (rare, but happens) are still
 *      treated as correlated.
 *
 * We build baskets client-side from the backend's /api/markets feed so the
 * UI always reflects the current state of Polymarket, without needing a
 * persisted basket table per (tier,window) combo on the backend.
 */

import { BACKEND_URL } from "./tokens";
import type { Bundle } from "./bundles";

// ---------------- Raw API shapes ----------------

/**
 * Shape returned by GET /api/markets (proxied from Polymarket Gamma API).
 * Prices / volume arrive as strings and must be parsed.
 *
 * Price-change fields are absolute YES-price deltas in probability space,
 * i.e. `one_week_price_change = -0.02` means YES is 2 points lower than a
 * week ago. We derive a ~24h delta by dividing the weekly number by 7 when
 * Gamma does not expose a direct `one_day_price_change`.
 */
export type RawMarket = {
  id: string;
  question: string;
  condition_id: string;
  outcomePrices: string; // JSON-encoded e.g. '["0.85","0.15"]'
  volume: string;
  active: boolean;
  closed: boolean;
  end_date_iso?: string;
  slug?: string;
  event_id?: string;
  event_slug?: string;
  event_title?: string;
  // Forwarded from Polymarket Gamma — each outcome (YES / NO) has its
  // own CLOB token id, which is what the orderbook endpoint needs.
  tokens?: Array<{ token_id: string; outcome: string; price: number }>;
  last_trade_price?: number;
  one_day_price_change?: number;
  one_week_price_change?: number;
  one_month_price_change?: number;
};

// ---------------- Parsed / normalized market ----------------

/**
 * A single basket leg. This is a *sided* view of an underlying Polymarket
 * market — the same `underlyingId` can in principle be represented twice
 * (YES and NO) in the candidate pool, but only one of the two ever lands
 * inside any basket thanks to the global dedupe in `buildLiveBaskets`.
 *
 * `yesProbability` always mirrors the underlying market's YES odds.
 * `probability` is the side-specific odds used for scoring and NAV
 *   (= `yesProbability` for YES legs, `1 - yesProbability` for NO legs).
 * `dailyChange` is the signed 24h relative move in this side's price.
 */
export type Category =
  | "crypto"
  | "politics"
  | "sports"
  | "economics"
  | "entertainment"
  | "tech"
  | "world"
  | "other";

export type LiveMarket = {
  id: string;                  // unique per side, e.g. "540816:YES"
  underlyingId: string;        // Gamma market id — stable across sides
  question: string;            // prefixed with "No: " when side === "NO"
  conditionId: string;
  side: "YES" | "NO";
  probability: number;         // 0..1, side-specific
  yesProbability: number;      // 0..1, always from the YES outcome
  volumeUsd: number;
  endDateIso?: string;
  daysToResolution: number;    // may be Infinity if no end date
  dailyChange: number;         // signed relative change over ~24h (e.g. 0.012 = +1.2%)
  marketSlug?: string;         // polymarket.com/market/<slug>
  eventSlug?: string;          // polymarket.com/event/<slug>[/<marketSlug>]
  eventId?: string;            // used by buildLiveBaskets for correlation dedupe
  topicKey: string;            // coarse token-set hash used as a correlation fallback
  category: Category;          // coarse category from keyword classifier
  weight: number;              // fraction of basket NAV (0..1); set in buildLiveBaskets
  /**
   * CLOB token id for THIS side (YES or NO). Empty string when Gamma
   * didn’t return token metadata for the market. The buy panel feeds
   * these ids into /api/markets/orderbooks to get live bid/ask depth
   * for the per-leg slippage calculation.
   */
  tokenId: string;
};

// ---------------- Bucketing rules ----------------

/**
 * Tier bands on Polymarket yes-probability.
 *
 * We keep a preferred (tight) band and an extended (fallback) band. Every
 * basket tries to fill with markets from the preferred band first; if there
 * aren't 10 such markets for a given (tier, window) combo, we top up from
 * the extended band so every surfaced basket has exactly 10 real legs.
 */
export const TIER_RANGE: Record<90 | 70 | 50, [number, number]> = {
  90: [0.85, 0.99], // preferred: "extremely high"
  70: [0.25, 0.75], // preferred: "mid"
  50: [0.01, 0.12], // preferred: "long-shot" — floor at 1% to skip dead/joke markets
};

export const TIER_RANGE_EXT: Record<90 | 70 | 50, [number, number]> = {
  90: [0.78, 0.995],
  70: [0.15, 0.85],
  50: [0.01, 0.22],
};

/**
 * Tier-level NAV targets. When set, the roster's sqrt(volume) weights are
 * tilted post-hoc so the weighted probability (= NAV) lands near the
 * target, without violating the per-leg min/max caps. Each basket then
 * gets a seeded ±TIER_TARGET_JITTER offset so the three tranches of a
 * tier don't all land on the same NAV.
 *
 * All three tiers are pinned: HIGH targets 0.95, MID 0.50, LOW 0.05.
 * Pinning keeps each tier's NAV visibly centered on an intuitive
 * archetype ("near-cert" / "coinflip" / "long-shot") regardless of how
 * Polymarket's long tail happens to skew on any given day. Without
 * pinning the natural NAVs would drift — e.g. MID in the low 40s and
 * HIGH in the low 90s — which makes the three cards read as "random"
 * instead of as a clean risk ladder.
 */
export const TIER_TARGET_NAV: Record<90 | 70 | 50, number | null> = {
  90: 0.95,
  70: 0.5,
  50: 0.05,
};

/**
 * Per-basket jitter applied on top of `TIER_TARGET_NAV` so the three
 * tranches in a tilted tier don't all read as the exact same NAV — which
 * would look synthetic. Seeded by basket id so the offset is stable
 * across renders. Amplitude is ±2 percentage points, which keeps the
 * basket visibly centered on the tier target while giving each card its
 * own individual read (e.g. 48.6% / 50.8% / 49.2% for MID; 93.4% / 95.6%
 * / 96.1% for HIGH; 4.2% / 5.8% / 4.9% for LOW).
 */
const TIER_TARGET_JITTER = 0.02;

export type WindowKey = "week" | "month" | "long";

/**
 * Resolution windows (preferred). Week starts at 1 day so baskets whose
 * legs are all resolving today don't surface as "Resolving".
 */
export const WINDOW_RANGE: Record<WindowKey, [number, number]> = {
  week: [1, 7],
  month: [30, 90],
  long: [180, Number.POSITIVE_INFINITY],
};

const WINDOW_RANGE_EXT: Record<WindowKey, [number, number]> = {
  week: [1, 30], // stretch into "soon" if < 10 strictly-weekly markets exist
  month: [14, 150],
  long: [120, Number.POSITIVE_INFINITY],
};

// Human-readable basket id segments. We used to build ids like `PBU-90-W`,
// which required the reader to memorise that 90 = high-probability tier and
// W = short window. The id now reads its risk + duration directly, e.g.
// `PBU-HIGH-SHORT`, `PBU-MID-MED`, `PBU-LOW-LONG`.
const TIER_CODE: Record<90 | 70 | 50, string> = {
  90: "HIGH",
  70: "MID",
  50: "LOW",
};
const WINDOW_CODE: Record<WindowKey, string> = {
  week: "SHORT",
  month: "MED",
  long: "LONG",
};

// All 3×3 tier×window combos we attempt to build a basket for.
const TARGET_COMBOS: Array<[90 | 70 | 50, WindowKey]> = [
  [90, "week"], [90, "month"], [90, "long"],
  [70, "week"], [70, "month"], [70, "long"],
  [50, "week"], [50, "month"], [50, "long"],
];

// Minimum legs required before a basket is considered "live". If a (tier,
// window) combo can't reach this floor after dedupe, we surface a
// placeholder card instead. There is NO upper cap on basket size — every
// non-correlated, liquid candidate that fits the tier is included.
const MIN_BASKET_LEGS = 10;
// Liquidity floor per constituent — lifetime Polymarket volume. Raising
// this above the old $1K floor drops dead / joke / troll markets that
// would otherwise pass the probability + window filters and dilute the
// basket. $10K is where the first meaningfully-traded markets start.
const MIN_VOLUME_USD = 10_000;
// Soft per-category cap: no single category can make up more than this
// fraction of a basket's legs in the strict pass. Second-pass fill ignores
// the cap so we never ship fewer than MIN_BASKET_LEGS when more legs exist.
const CATEGORY_SHARE_CEIL = 0.35;
// Index-fund-style weight clamps. Both bounds scale with basket size:
//   • max weight collapses toward `3 / n` so a single leg can never exceed
//     3× the equal-weight baseline of the basket (with a 3% hard floor and
//     25% absolute ceiling).
//   • min weight scales down to `0.3 / n` (30% of equal-weight) so a
//     200-leg basket can still carry 0.15% tail legs without being
//     distorted by a 3% floor.
function maxLegWeightFor(n: number): number {
  if (n <= 0) return 0.25;
  if (n <= 10) return 0.25;
  return Math.min(0.25, Math.max(0.03, 3 / n));
}
function minLegWeightFor(n: number): number {
  if (n <= 10) return 0.03;
  return Math.max(0.001, 0.3 / n);
}

// ---------------- Category classifier ----------------

/**
 * Keyword-based category classifier. Intentionally dumb but ordered: the
 * first regex that matches wins. Keyword lists are tuned for Polymarket's
 * question style ("Will X happen by Y?"). Anything that doesn't match any
 * bucket gets tagged "other", which still participates in basket
 * construction but counts against the per-category cap.
 */
const CATEGORY_PATTERNS: Array<[Category, RegExp]> = [
  [
    "crypto",
    /\b(bitcoin|btc|ethereum|eth|ether|crypto|defi|nft|token|blockchain|altcoin|dogecoin|doge|shiba|memecoin|stablecoin|xrp|ripple|cardano|ada|polygon|matic|avalanche|avax|binance|bnb|litecoin|ltc|chainlink|link|monero)\b/i,
  ],
  [
    "sports",
    /\b(nfl|nba|nhl|mlb|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|boxing|fifa|world cup|super bowl|playoff|playoffs|championship|league|draft|stanley cup|world series|olympics?|mvp|heisman|pga|epl|premier league|la liga|serie a|bundesliga|champions league|f1|formula 1|nascar)\b/i,
  ],
  [
    "politics",
    /\b(president(?:ial)?|election|senator|senate|congress|primary|governor|poll|polls|trump|biden|harris|democrat|republican|parliament|prime minister|minister|congressman|congresswoman|mayor|party|vote|voting|impeach|impeachment|cabinet|supreme court|scotus|ballot|caucus|nomination|referendum)\b/i,
  ],
  [
    "economics",
    /\b(fed|federal reserve|rate cut|rate hike|recession|gdp|inflation|unemployment|earnings|ipo|stock|nasdaq|s&p|sp500|treasury|bond|yield|cpi|ppi|jobs report|oil price|gas price|gold|dollar|bull market|bear market|market cap)\b/i,
  ],
  [
    "entertainment",
    /\b(album|movie|film|box office|oscar|oscars|academy award|grammy|emmy|netflix|hbo|disney|spotify|billboard|pop star|celebrity|single|chart|taylor swift|kardashian|kanye|drake|rihanna|beyonc\u00e9|beyonce|bieber|eurovision|no\.? 1|number one)\b/i,
  ],
  [
    "tech",
    /\b(ai|a\.i\.|chatgpt|gpt|openai|anthropic|claude|google|apple|meta|microsoft|amazon|tesla|nvidia|spacex|starship|iphone|ios|android|github|acquisition|merger|layoff|launch|release)\b/i,
  ],
  [
    "world",
    /\b(war|ceasefire|putin|zelensky|netanyahu|xi jinping|russia|ukraine|china|iran|israel|gaza|palestine|taiwan|korea|north korea|nuclear|nato|sanctions?|un security|united nations|hostage|refugee|coup)\b/i,
  ],
];

function classifyCategory(question: string): Category {
  for (const [cat, re] of CATEGORY_PATTERNS) {
    if (re.test(question)) return cat;
  }
  return "other";
}

// ---------------- Parsing helpers ----------------

function parseYesProbability(outcomePrices: string): number | null {
  try {
    const arr = JSON.parse(outcomePrices);
    if (Array.isArray(arr) && arr.length > 0) {
      const p = parseFloat(arr[0]);
      if (Number.isFinite(p) && p >= 0 && p <= 1) return p;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function parseDaysToResolution(endDateIso?: string): number {
  if (!endDateIso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(endDateIso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (t - Date.now()) / 86400_000);
}

/**
 * Absolute 24h YES-price delta.
 *
 * Gamma populates `one_day_price_change` unreliably — especially for
 * HIGH-tier markets that only tick a handful of times a day — which
 * produced the "+0.0% today" readings on baskets whose legs simply
 * didn't have a daily number. We now fall back to
 * `one_week_price_change / 7` when the daily field is absent.
 *
 * The historical concern with the weekly-pro-rated fallback was that
 * pro-rating a 2-point weekly move on the NO side of a 5%-YES market
 * looked like a huge relative daily change. That concern is already
 * contained downstream:
 *   • `relativeChange` guards against priors < 1¢ (return 0),
 *   • clamps the relative change to ±LEG_DAILY_CHANGE_CLAMP (50%),
 *   • and the basket-level clamp is BASKET_DAILY_CHANGE_CLAMP_PCT (30%).
 * So the safest behaviour is to use whatever signal Gamma gives us
 * and let the clamps truncate outliers — better than a silent 0 that
 * rounds the whole basket's move to 0.0%.
 */
function extractOneDayAbsDelta(m: RawMarket): number {
  if (typeof m.one_day_price_change === "number" && Number.isFinite(m.one_day_price_change)) {
    return m.one_day_price_change;
  }
  if (
    typeof m.one_week_price_change === "number" &&
    Number.isFinite(m.one_week_price_change)
  ) {
    return m.one_week_price_change / 7;
  }
  return 0;
}

// Per-leg daily change is clamped so a near-zero "yesterday's price" can't
// turn a small absolute move into an absurd percentage. ±50% covers every
// plausible real move while still killing data-glitch outliers.
const LEG_DAILY_CHANGE_CLAMP = 0.5;
// Final basket-level change is clamped more tightly — a diversified index
// fund of 100+ legs moving 30% in a day would itself be an outlier.
const BASKET_DAILY_CHANGE_CLAMP_PCT = 30;

// Words removed before building the topic fingerprint. These are stop-words
// plus hackathon-era filler that shows up in near every question ("will",
// "before", year tokens, etc.) and drowns out the discriminating tokens.
const TOPIC_STOP_WORDS = new Set<string>([
  "a", "an", "and", "as", "at", "be", "before", "by", "do", "does", "for",
  "from", "has", "have", "in", "is", "it", "of", "on", "or", "out", "over",
  "reach", "than", "that", "the", "this", "to", "up", "was", "when", "which",
  "who", "will", "with", "would",
  "2024", "2025", "2026", "2027",
]);

/**
 * Coarse fingerprint of the question used as a fallback correlation signal.
 * Strategy:
 *   1. Lowercase + strip punctuation.
 *   2. Drop stop-words / year tokens.
 *   3. Sort the remaining tokens so word-order differences don't matter
 *      ("Arvell Reese first pick" and "first pick Arvell Reese" collide).
 *   4. Keep the first 4 tokens so long headlines still collide on the core
 *      entity / action tokens.
 */
function topicFingerprint(question: string): string {
  const cleaned = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((tok) => tok.length >= 3 && !TOPIC_STOP_WORDS.has(tok));
  const unique = Array.from(new Set(cleaned));
  unique.sort();
  return unique.slice(0, 4).join("|");
}

/**
 * Emit up to two candidates per raw market: the YES side and the NO side.
 * Each candidate has its own side-specific probability and signed daily
 * change (YES: +∆, NO: −∆ of the same underlying move). Both sides share
 * the same `underlyingId`, `eventId`, and `topicKey` so correlation dedupe
 * collapses them together.
 */
function normalizeMarketCandidates(m: RawMarket): LiveMarket[] {
  if (!m.active || m.closed) return [];
  if (!m.question || !m.id) return [];
  const yesProb = parseYesProbability(m.outcomePrices);
  if (yesProb === null) return [];
  const vol = parseFloat(m.volume);
  if (!Number.isFinite(vol) || vol < MIN_VOLUME_USD) return [];

  const daysToResolution = parseDaysToResolution(m.end_date_iso);
  // Markets with no end_date_iso (daysToResolution = Infinity) can't be
  // meaningfully time-bucketed and would surface as "Infinityd remaining /
  // resolves Invalid Date" on the basket card. Drop them from the candidate
  // pool entirely.
  if (!Number.isFinite(daysToResolution)) return [];

  const deltaAbs = extractOneDayAbsDelta(m);
  const topicKey = topicFingerprint(m.question);

  // Relative change on a given side: ∆price / (price − ∆price) (i.e. vs.
  // yesterday's price). Clamped to ±LEG_DAILY_CHANGE_CLAMP so a small
  // absolute move against a near-zero prior doesn't explode.
  const relativeChange = (priceToday: number, absDelta: number): number => {
    const prior = priceToday - absDelta;
    // Need at least 1 cent of prior to make a % meaningful, else the leg
    // doesn't have a usable daily change.
    if (!Number.isFinite(prior) || prior < 0.01) return 0;
    if (!Number.isFinite(absDelta)) return 0;
    const raw = absDelta / prior;
    if (!Number.isFinite(raw)) return 0;
    if (raw > LEG_DAILY_CHANGE_CLAMP) return LEG_DAILY_CHANGE_CLAMP;
    if (raw < -LEG_DAILY_CHANGE_CLAMP) return -LEG_DAILY_CHANGE_CLAMP;
    return raw;
  };

  const category = classifyCategory(m.question);

  // Pull CLOB token ids for each outcome. Polymarket Gamma returns them
  // in the `tokens` array; we match by `outcome` text because order is
  // not guaranteed across markets. Fall back to index-based lookup if
  // the outcome strings are non-standard.
  const yesToken =
    m.tokens?.find((t) => t.outcome.toLowerCase() === "yes") ?? m.tokens?.[0];
  const noToken =
    m.tokens?.find((t) => t.outcome.toLowerCase() === "no") ?? m.tokens?.[1];

  const shared = {
    underlyingId: m.id,
    conditionId: m.condition_id,
    volumeUsd: vol,
    endDateIso: m.end_date_iso,
    daysToResolution,
    marketSlug: m.slug,
    eventSlug: m.event_slug,
    eventId: m.event_id,
    topicKey,
    category,
    // Placeholder weight; real weight is computed per-basket in buildLiveBaskets.
    weight: 1 / MIN_BASKET_LEGS,
  };

  const yesLeg: LiveMarket = {
    ...shared,
    id: `${m.id}:YES`,
    question: m.question,
    side: "YES",
    probability: yesProb,
    yesProbability: yesProb,
    dailyChange: relativeChange(yesProb, deltaAbs),
    tokenId: yesToken?.token_id ?? "",
  };

  const noProb = 1 - yesProb;
  const noLeg: LiveMarket = {
    ...shared,
    id: `${m.id}:NO`,
    question: `No: ${m.question}`,
    side: "NO",
    probability: noProb,
    yesProbability: yesProb,
    // NO side moves in the opposite direction of YES, so negate the delta.
    dailyChange: relativeChange(noProb, -deltaAbs),
    tokenId: noToken?.token_id ?? "",
  };

  return [yesLeg, noLeg];
}

/**
 * Index-fund-style weighting. Step 1 is a square-root volume weighting
 * (reduces whale dominance), step 2 iteratively clamps each weight to
 * `[minLegWeightFor(n), maxLegWeightFor(n)]` and redistributes the leftover
 * pro-rata until the vector is valid. Both bounds scale with basket size
 * so a 200-leg basket doesn't get distorted by a 3% floor or a 25% cap.
 * Returns weights summing to 1.
 */
function computeLegWeights(legs: LiveMarket[]): number[] {
  const n = legs.length;
  if (n === 0) return [];
  const minWeight = minLegWeightFor(n);
  const maxWeight = maxLegWeightFor(n);

  const raw = legs.map((l) => Math.sqrt(Math.max(1, l.volumeUsd)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const start = sum > 0 ? raw.map((r) => r / sum) : Array(n).fill(1 / n);
  return clampAndNormalize(start, minWeight, maxWeight);
}

/**
 * Shared min/max-clamp + renormalize pass used by both `computeLegWeights`
 * and `recenterWeightsToTarget`. Walks an arbitrary starting weight
 * vector into one that satisfies `[minWeight, maxWeight]` per leg and
 * sums to 1, redistributing clamped excess across the still-free legs
 * pro-rata.
 */
function clampAndNormalize(
  weights: number[],
  minWeight: number,
  maxWeight: number,
): number[] {
  const n = weights.length;
  let w = weights.slice();
  for (let iter = 0; iter < 20; iter++) {
    let excess = 0;
    const free: number[] = [];
    w = w.map((x, i) => {
      if (x > maxWeight) {
        excess += x - maxWeight;
        return maxWeight;
      }
      if (x < minWeight) {
        excess -= minWeight - x;
        return minWeight;
      }
      free.push(i);
      return x;
    });
    if (Math.abs(excess) < 1e-6 || free.length === 0) break;
    const freeSum = free.reduce((s, i) => s + w[i], 0);
    if (freeSum <= 0) break;
    for (const i of free) {
      w[i] = w[i] + (w[i] / freeSum) * excess;
    }
  }
  const total = w.reduce((a, b) => a + b, 0);
  return total > 0 ? w.map((x) => x / total) : Array(n).fill(1 / n);
}

/**
 * Tilt a baseline weight vector toward a target weighted-probability
 * (= target NAV) using exponential reweighting:
 *
 *     w_i' ∝ baseWeights_i · exp(λ · (p_i − target))
 *
 * λ is found by bisection so the post-clamp weighted NAV lands within
 * 1 bp of `targetNav`. Positive λ concentrates weight on legs above the
 * target; negative λ on legs below. The same per-leg min/max clamps
 * from `computeLegWeights` are applied after the tilt so a single leg
 * can't dominate the basket regardless of how aggressive λ gets.
 *
 * If the target sits outside the [min p, max p] span of the legs we
 * can't reach it with any weighting, so the baseline is returned
 * unchanged — the caller's NAV will just drift slightly off target.
 */
function recenterWeightsToTarget(
  legs: LiveMarket[],
  baseWeights: number[],
  targetNav: number,
): number[] {
  const n = legs.length;
  if (n === 0) return baseWeights;
  if (n !== baseWeights.length) return baseWeights;
  const minWeight = minLegWeightFor(n);
  const maxWeight = maxLegWeightFor(n);
  const probs = legs.map((l) => l.probability);
  const minP = Math.min(...probs);
  const maxP = Math.max(...probs);
  if (targetNav >= maxP || targetNav <= minP) return baseWeights;

  const applyTilt = (lam: number): { nav: number; weights: number[] } => {
    const raw = baseWeights.map((w, i) =>
      w * Math.exp(lam * (probs[i] - targetNav)),
    );
    const sum = raw.reduce((a, b) => a + b, 0);
    const start =
      sum > 0 ? raw.map((r) => r / sum) : Array(n).fill(1 / n);
    const weights = clampAndNormalize(start, minWeight, maxWeight);
    const nav = weights.reduce((s, x, i) => s + x * probs[i], 0);
    return { nav, weights };
  };

  const baseline = applyTilt(0);
  if (Math.abs(baseline.nav - targetNav) < 1e-4) return baseline.weights;

  // λ range ±15 is plenty. exp(15 · 0.5) ≈ 1800× effectively puts all
  // pre-clamp mass on the farthest-in-direction legs; the clamp then
  // re-spreads it back up to the per-leg ceiling.
  let lo = -15;
  let hi = 15;
  let best = baseline;
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    const result = applyTilt(mid);
    if (Math.abs(result.nav - targetNav) < Math.abs(best.nav - targetNav)) {
      best = result;
    }
    if (Math.abs(result.nav - targetNav) < 1e-4) return result.weights;
    if (result.nav < targetNav) lo = mid;
    else hi = mid;
    if (Math.abs(hi - lo) < 1e-6) break;
  }
  return best.weights;
}

// ---------------- Fetch ----------------

/**
 * Pull the full live Polymarket universe via the backend (which paginates
 * Gamma underneath). 20000 is far beyond the usual active-market count,
 * which forces the backend to keep paginating until Gamma returns an empty
 * page — i.e. we grab everything that's live.
 *
 * Returns a flat list of sided candidates: each underlying market yields
 * both its YES and NO candidate legs.
 */
export async function fetchLiveMarkets(limit = 1_500): Promise<LiveMarket[]> {
  // 1.5k active markets is ample to build 9 baskets and loads in ~1s; the old
  // 20k pull paginated Gamma ~40x and routinely timed out -> "seeded" fallback.
  const url = `${BACKEND_URL}/api/markets?limit=${limit}&active=true`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Markets fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { markets?: RawMarket[] };
  const raw = body.markets ?? [];
  return raw.flatMap(normalizeMarketCandidates);
}

// ---------------- Scoring ----------------

function inRange(v: number, [lo, hi]: [number, number]): boolean {
  return v >= lo && v <= hi;
}

/**
 * How well a sided candidate fits a (tier, window) intent. Higher = better.
 *
 * Tier matching is done against the candidate's side-specific `probability`
 * so that a NO leg of a 10% market (NO prob = 90%) can legitimately land in
 * the 90 tier.
 *
 * Scoring is layered so we prefer exact fits, and only fall back to
 * extended-band candidates when a combo can't fill the basket strictly:
 *   - Tier is the hard constraint: a side outside the extended tier
 *     range for a target is never admitted into that basket.
 *   - Inside the extended tier, a strict-tier side beats an extended-only.
 *   - Inside the tier constraint, strict-window beats extended-window.
 *   - Volume is the within-bucket tiebreaker: a $10M market ranks above a
 *     $100K market at the same tier/window fit, so the most-liquid legs
 *     land first.
 */
function fitScore(
  m: LiveMarket,
  tier: 90 | 70 | 50,
  win: WindowKey,
): number | null {
  if (!inRange(m.probability, TIER_RANGE_EXT[tier])) return null;
  const strictTier = inRange(m.probability, TIER_RANGE[tier]);
  const strictWin = inRange(m.daysToResolution, WINDOW_RANGE[win]);
  const extWin = inRange(m.daysToResolution, WINDOW_RANGE_EXT[win]);
  if (!extWin) return null;
  const tierPts = strictTier ? 1000 : 400;
  const winPts = strictWin ? 200 : 50;
  // log10(volume) gives: 10K → 60, 100K → 75, 1M → 90, 10M → 105, 100M → 120.
  // Range up to ~120 means volume can rearrange ties inside a tier/window
  // bucket but can't promote an extended-fit leg over a strict-fit one.
  const volPts = Math.min(180, Math.log10(Math.max(1, m.volumeUsd)) * 15);
  return tierPts + winPts + volPts;
}

// ---------------- Basket synthesis ----------------

export type LiveBasket = Bundle & {
  live: true;
  markets: LiveMarket[];
  window: WindowKey;
};

/**
 * Surfaced when a (tier, window) combo doesn't have 10 live markets to
 * fill a real basket. The UI renders these as dimmed "not yet available"
 * cards so the grid stays a consistent 3×3.
 */
export type BasketSlot =
  | LiveBasket
  | {
      kind: "placeholder";
      tier: 90 | 70 | 50;
      window: WindowKey;
      id: string;
      legsAvailable: number;
    };

/**
 * Deterministic 0..1 hash from a string seed. Used to anchor a pseudo-history
 * walk so the sparkline is stable across renders without real 30-day data.
 */
function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/**
 * Seeded intraday NAV synthesis. Walks backward from `finalNav` with a
 * small symmetric noise, then reverses so the last point is exactly the
 * live NAV. Used for the 1H and 1D chart ranges where `synthHistory`'s
 * year-scale mean-reversion band would be far too wide.
 *
 * `stepVol` is the per-step noise fraction (e.g. 0.0008 ≈ 0.08% per tick).
 * Returns `steps + 1` points.
 */
function synthIntradayHistory(
  finalNav: number,
  steps: number,
  seedId: string,
  stepVol: number,
): number[] {
  const rng = seededRng(seedId);
  const band = Math.max(0.0003, finalNav * stepVol);
  const rev: number[] = [Number(finalNav.toFixed(6))];
  let v = finalNav;
  for (let i = 0; i < steps; i++) {
    const noise = (rng() - 0.5) * band;
    v = Math.max(0.0005, Math.min(0.9995, v + noise));
    rev.push(Number(v.toFixed(6)));
  }
  rev.reverse();
  return rev;
}

function synthHistory(finalNav: number, days: number, seedId: string): number[] {
  const rng = seededRng(seedId);
  // Band scales with tier so high-tier baskets (0.90) don't jitter into the
  // low tier's (0.05) territory, and low-tier baskets stay in a tight
  // probability-space band instead of getting clipped to the floor.
  const band = Math.max(0.01, Math.min(0.06, finalNav * 0.12));
  // Walk BACKWARD from the live NAV (anchor first, then reverse) so the
  // most-recent point is EXACTLY `finalNav` and the series eases into it.
  // The previous forward walk + hard final-anchor produced an end-of-series
  // cliff (the walk could be ~0.99 the step before the 0.945 anchor), which
  // rendered as a vertical drop that bled below the chart. A backward walk
  // is continuous at the anchor by construction — no cliff. A gentle pull
  // toward `finalNav` keeps the whole series in a realistic band around the
  // current level rather than drifting away over 365 steps.
  const rev: number[] = [Number(finalNav.toFixed(4))];
  let v = finalNav;
  for (let i = 0; i < days; i++) {
    const pull = (finalNav - v) * 0.05;
    const noise = (rng() - 0.5) * band * 0.5;
    v = Math.max(0.005, Math.min(0.995, v + pull + noise));
    rev.push(Number(v.toFixed(4)));
  }
  rev.reverse();
  return rev;
}

function formatResolutionDate(daysLeft: number): string {
  if (!Number.isFinite(daysLeft)) return "TBD";
  const d = new Date(Date.now() + daysLeft * 86400_000);
  if (Number.isNaN(d.getTime())) return "TBD";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Build the 3×3 grid of baskets from a pool of sided candidates.
 *
 * Basket filling is *comprehensive*: each (tier, window) combo collects
 * every candidate that passes the liquidity + correlation filters. There
 * is no upper cap on basket size — the more uncorrelated, liquid legs a
 * (tier, window) can field, the bigger the basket. MIN_BASKET_LEGS acts as
 * a floor: below it we surface a placeholder card instead.
 *
 * Correlation dedupe has two scopes:
 *   Global (across all nine baskets): only `underlyingId`. This prevents
 *     the YES of a market landing in one tranche while its NO lands in
 *     another — those two sides exactly offset. Event / topic collisions
 *     are allowed across baskets because different tranches represent
 *     different risk profiles; one GTA-VI market can sit in the 90-week
 *     basket while another from the same event sits in the 70-long.
 *   Per-basket: `underlyingId`, `eventId`, and `topicKey` are all strict.
 *     Within a single basket no two legs may share an underlying market,
 *     event, or near-duplicate question — so the basket itself never
 *     contains correlated legs.
 *
 * Per-basket diversity:
 *   • category ceil  — first pass holds each category to
 *                      CATEGORY_SHARE_CEIL of the running basket size so a
 *                      hot topic (election week, NFL playoffs) can't
 *                      dominate. Second pass ignores the ceil to top up
 *                      toward MIN_BASKET_LEGS when the strict pass was too
 *                      restrictive.
 *
 * Weighting:
 *   • After the roster is locked, weights come from an index-fund style
 *     sqrt(volume) model with per-leg min/max clamps that scale with basket
 *     size (see `computeLegWeights`). NAV and 24h change are weighted sums
 *     over the legs. `issue` tracks the live NAV so the "issue price" tile
 *     on the detail page is never stale.
 *   • Tiers listed in `TIER_TARGET_NAV` get a second pass: weights are
 *     tilted exponentially (still under the per-leg caps) so the weighted
 *     probability lands near the tier's target NAV, plus a seeded
 *     ±TIER_TARGET_JITTER offset per basket. All three tiers are pinned:
 *     HIGH→~95%, MID→~50%, LOW→~5%.
 *
 * Combo processing order matters: higher-tier baskets go first because
 * they're typically the sparsest pool of candidates. If we let the 70 tier
 * claim first pick, the extreme tiers would starve.
 */
export function buildLiveBaskets(candidates: LiveMarket[]): BasketSlot[] {
  const out: BasketSlot[] = [];
  // Global claims: only underlying market id, to prevent YES+NO offsets
  // across tiers. Event / topic collisions are allowed across tiers so
  // bigger baskets don't starve later ones of candidates.
  const claimedUnderlying = new Set<string>();

  for (const [tier, win] of TARGET_COMBOS) {
    const id = `PBU-${TIER_CODE[tier]}-${WINDOW_CODE[win]}`;

    // Score every candidate whose side fits this (tier, window). Only the
    // global underlyingId claim filters here; event/topic dedupe happens
    // within the basket below.
    const scored: Array<{ m: LiveMarket; s: number }> = [];
    for (const m of candidates) {
      if (claimedUnderlying.has(m.underlyingId)) continue;
      const s = fitScore(m, tier, win);
      if (s === null) continue;
      scored.push({ m, s });
    }
    scored.sort((a, b) => b.s - a.s);

    // Pass 1: dedupe on (underlying, event, topic) and enforce the
    // dynamic category ceil. No upper limit on basket size — every
    // qualifying candidate lands here.
    const legs: LiveMarket[] = [];
    const takenUnderlying = new Set<string>();
    const takenEvents = new Set<string>();
    const takenTopics = new Set<string>();
    const catCounts = new Map<Category, number>();
    for (const { m } of scored) {
      if (takenUnderlying.has(m.underlyingId)) continue;
      if (m.eventId && takenEvents.has(m.eventId)) continue;
      if (m.topicKey && takenTopics.has(m.topicKey)) continue;
      // Category ceil is evaluated against the projected basket size after
      // this leg lands; apply a sensible floor so small baskets still allow
      // 3 legs per category before any ceil kicks in.
      const catSoFar = catCounts.get(m.category) ?? 0;
      const projected = legs.length + 1;
      const ceil = Math.max(3, Math.ceil(projected * CATEGORY_SHARE_CEIL));
      if (catSoFar + 1 > ceil) continue;
      legs.push(m);
      takenUnderlying.add(m.underlyingId);
      if (m.eventId) takenEvents.add(m.eventId);
      if (m.topicKey) takenTopics.add(m.topicKey);
      catCounts.set(m.category, catSoFar + 1);
    }

    // Pass 2: if the category ceil left us below the MIN floor, top up
    // without the ceil so we never ship a placeholder when enough
    // uncorrelated legs exist.
    if (legs.length < MIN_BASKET_LEGS) {
      for (const { m } of scored) {
        if (takenUnderlying.has(m.underlyingId)) continue;
        if (m.eventId && takenEvents.has(m.eventId)) continue;
        if (m.topicKey && takenTopics.has(m.topicKey)) continue;
        legs.push(m);
        takenUnderlying.add(m.underlyingId);
        if (m.eventId) takenEvents.add(m.eventId);
        if (m.topicKey) takenTopics.add(m.topicKey);
      }
    }

    // Pass 3 (cross-tier rescue): a combo can still starve when earlier,
    // higher-tier baskets GLOBALLY claimed the underlying markets it needs —
    // most often LOW-SHORT, whose long-shot legs are exactly the NO sides of
    // the high-probability short markets that HIGH-SHORT already took (so the
    // whole LOW-SHORT card was dropping out of the grid). Top up from the FULL
    // candidate pool, ignoring the cross-tier `claimedUnderlying` claim. The
    // per-basket underlying/event/topic dedupe below still prevents correlated
    // legs WITHIN this basket (a market only ever contributes one side here),
    // so every (tier, window) of the 3×3 grid surfaces a real basket.
    if (legs.length < MIN_BASKET_LEGS) {
      const rescue: Array<{ m: LiveMarket; s: number }> = [];
      for (const m of candidates) {
        const s = fitScore(m, tier, win);
        if (s !== null) rescue.push({ m, s });
      }
      rescue.sort((a, b) => b.s - a.s);
      for (const { m } of rescue) {
        if (takenUnderlying.has(m.underlyingId)) continue;
        if (m.eventId && takenEvents.has(m.eventId)) continue;
        if (m.topicKey && takenTopics.has(m.topicKey)) continue;
        legs.push(m);
        takenUnderlying.add(m.underlyingId);
        if (m.eventId) takenEvents.add(m.eventId);
        if (m.topicKey) takenTopics.add(m.topicKey);
        if (legs.length >= MIN_BASKET_LEGS) break;
      }
    }

    if (legs.length < MIN_BASKET_LEGS) {
      out.push({
        kind: "placeholder",
        tier,
        window: win,
        id,
        legsAvailable: legs.length,
      });
      continue;
    }

    // Commit global claims so downstream combos don't repick the same
    // underlying market (which would mean YES/NO of the same market in
    // different tranches — perfectly offsetting).
    for (const leg of legs) {
      claimedUnderlying.add(leg.underlyingId);
    }

    // Index-fund-style weights from leg volume, with cap/floor clamping.
    // For tiers with a target NAV (currently MID only), re-tilt the
    // weights so the weighted probability lands near that target, with a
    // seeded ±TIER_TARGET_JITTER offset per basket so all three tranches
    // of the tier don't land on the identical NAV.
    const baseWeights = computeLegWeights(legs);
    const tierTarget = TIER_TARGET_NAV[tier];
    let jitteredTarget: number | null = null;
    if (tierTarget !== null) {
      const jitterRng = seededRng(`${id}:nav-jitter`);
      // Basket ids share long common prefixes (`PBU-MID-`), which the
      // FNV/xorshift in `seededRng` turns into near-identical first
      // draws. Burn three draws before reading so sibling tranches
      // actually see different jitter offsets.
      jitterRng(); jitterRng(); jitterRng();
      const offset = (jitterRng() - 0.5) * 2 * TIER_TARGET_JITTER;
      jitteredTarget = Math.max(0.01, Math.min(0.99, tierTarget + offset));
    }
    const weights =
      jitteredTarget !== null
        ? recenterWeightsToTarget(legs, baseWeights, jitteredTarget)
        : baseWeights;
    const weightedLegs: LiveMarket[] = legs.map((leg, i) => ({
      ...leg,
      weight: Number(weights[i].toFixed(4)),
    }));

    // NAV = Σ(weight × probability) — the basket's expected payout per token
    // if every leg resolved at its current market price.
    const nav = weightedLegs.reduce((s, m) => s + m.weight * m.probability, 0);

    // 24h relative change = weighted sum of leg-level changes, as a
    // percent. Additionally clamped at the basket level to suppress rare
    // outliers where many legs all got data-glitched the same day.
    const rawChangePct =
      weightedLegs.reduce((s, m) => s + m.weight * m.dailyChange, 0) * 100;
    const changePct = Number.isFinite(rawChangePct)
      ? Math.max(
          -BASKET_DAILY_CHANGE_CLAMP_PCT,
          Math.min(BASKET_DAILY_CHANGE_CLAMP_PCT, rawChangePct),
        )
      : 0;

    const daysLeft = Math.max(
      0,
      Math.round(
        weightedLegs.reduce((s, m) => s + m.weight * m.daysToResolution, 0),
      ),
    );
    const date = formatResolutionDate(daysLeft);
    // Three parallel histories keyed off the basket id so they stay
    // deterministic across renders. Each powers a different chart range:
    //   • history       – daily, last 365 days (7D / 30D / 6M / 1Y)
    //   • dayHistory    – 5-min, last 24 hours (1D)
    //   • hourHistory   – 1-min, last 60 minutes (1H)
    // All three end at exactly `nav` so every range shows the same
    // current value.
    const history = synthHistory(nav, 364, id);
    const dayHistory = synthIntradayHistory(nav, 287, `${id}:day`, 0.0018);
    const hourHistory = synthIntradayHistory(nav, 59, `${id}:hour`, 0.0008);

    out.push({
      id,
      tier,
      date,
      daysLeft,
      nav: Number(nav.toFixed(4)),
      // Issue price tracks the live NAV so the detail-page tile is never
      // stale. Rounded lightly so display stays stable across ticks.
      issue: Number(nav.toFixed(4)),
      change: Number(changePct.toFixed(2)),
      // `hot` and `resolved` are legacy Bundle fields. The UI no longer
      // reads them — the live pipeline filters on `active && !closed`
      // upstream, so `resolved` is structurally 0 for every leg, and the
      // "hot" badge was removed from the cards. Kept here so the type
      // continues to satisfy `Bundle & { live }`.
      hot: false,
      resolved: 0,
      totalLegs: weightedLegs.length,
      history,
      hourHistory,
      dayHistory,
      live: true,
      window: win,
      markets: weightedLegs,
    });
  }

  return out;
}

export function isLiveBasket(s: BasketSlot): s is LiveBasket {
  return (s as { kind?: string }).kind !== "placeholder";
}
