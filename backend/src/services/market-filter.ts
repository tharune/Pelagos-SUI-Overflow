/**
 * Pelagos market-filter pipeline.
 *
 * Consumes raw Polymarket listings and runs them through a five-stage funnel,
 * rejecting "BS markets" before they ever reach basket construction.
 *
 * Stages (applied in order; once a market fails a stage it does not proceed):
 *
 *   1. liquidity_floor    — drop low-volume/inactive markets
 *   2. quality_nlp        — drop joke/troll/unanswerable questions via NLP
 *   3. time_window        — drop markets resolving too soon or too far out
 *   4. category_classify  — attach a category label (does not reject by default,
 *                           but will reject 'other' unless explicitly allowed)
 *   5. diversity_prefilter— dedupe semantically-overlapping markets using the
 *                           correlation service + TF-IDF cosine distance
 *
 * Every stage emits a per-stage result so the monitor can show a full funnel
 * breakdown. The pipeline is synchronous and side-effect-free; callers decide
 * whether to cache or persist the result.
 */

import {
  assessQuality,
  classifyCategory,
  Category,
  buildTfIdf,
  tfidfCosine,
  tokenize,
} from './nlp';
import { scoreLegPair, LegMetadata } from './correlation';
import { PolymarketMarket } from '../types';

// ---------- Inputs / outputs ----------

export type FilterStage =
  | 'liquidity_floor'
  | 'quality_nlp'
  | 'time_window'
  | 'category_classify'
  | 'diversity_prefilter';

export interface FilterConfig {
  /** Minimum lifetime USD volume to consider a market tradable. Default 5_000. */
  minVolumeUsd: number;
  /** Lower bound on days-to-resolution. Too-soon markets resolve before a
   *  bundle can be built. Default 2. */
  minDaysToResolution: number;
  /** Upper bound on days-to-resolution. Too-far-out markets have stale
   *  probabilities. Default 180. */
  maxDaysToResolution: number;
  /** Categories accepted by default. `'other'` is allowed only if listed here. */
  allowedCategories: Category[];
  /** Cosine similarity threshold in TF-IDF space for semantic dedupe. */
  dedupeCosineThreshold: number;
  /** Pair-correlation threshold (from the correlation service) for dedupe. */
  dedupeCorrThreshold: number;
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  minVolumeUsd: 5_000,
  minDaysToResolution: 2,
  maxDaysToResolution: 180,
  allowedCategories: ['crypto', 'sports', 'politics', 'economics', 'tech', 'world'],
  dedupeCosineThreshold: 0.55,
  dedupeCorrThreshold: 0.6,
};

export interface StageResult {
  stage: FilterStage;
  passed: boolean;
  reasons: string[];
}

export interface FilteredMarket {
  market: PolymarketMarket;
  volumeUsd: number;
  daysToResolution: number | null;
  category: Category;
  categoryConfidence: number;
  yesProbability: number | null;
  stages: StageResult[];
  droppedAt: FilterStage | null;
}

export interface FilterFunnel {
  input_count: number;
  kept_count: number;
  rejected_count: number;
  per_stage: Record<FilterStage, { entered: number; rejected: number; kept: number }>;
  rejection_examples: Array<{ id: string; question: string; stage: FilterStage; reasons: string[] }>;
}

export interface FilterResult {
  kept: FilteredMarket[];
  rejected: FilteredMarket[];
  funnel: FilterFunnel;
  config: FilterConfig;
}

// ---------- Helpers ----------

function parseVolume(v: string | undefined): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve the index of the YES outcome. Polymarket does NOT guarantee the
 * outcome order is [Yes, No] — match the outcome/token whose label is
 * (case-insensitive) 'yes' and read the price at that index. Falls back to
 * index 0 only when the YES label can't be located.
 */
function resolveYesIndex(m: PolymarketMarket): number {
  const tokenIdx = m.tokens?.findIndex((t) => t.outcome?.trim().toLowerCase() === 'yes');
  if (typeof tokenIdx === 'number' && tokenIdx >= 0) return tokenIdx;
  return 0;
}

function parseYesProbability(m: PolymarketMarket): number | null {
  try {
    const parsed = JSON.parse(m.outcomePrices);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const idx = resolveYesIndex(m);
      const p = parseFloat(parsed[idx] ?? parsed[0]);
      if (Number.isFinite(p)) return p;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function daysFromNow(iso?: string): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / 86_400_000;
}

function emptyFunnel(): FilterFunnel {
  const perStage = (): { entered: number; rejected: number; kept: number } => ({
    entered: 0,
    rejected: 0,
    kept: 0,
  });
  return {
    input_count: 0,
    kept_count: 0,
    rejected_count: 0,
    per_stage: {
      liquidity_floor: perStage(),
      quality_nlp: perStage(),
      time_window: perStage(),
      category_classify: perStage(),
      diversity_prefilter: perStage(),
    },
    rejection_examples: [],
  };
}

// ---------- Stages ----------

function stageLiquidityFloor(m: FilteredMarket, cfg: FilterConfig): StageResult {
  const reasons: string[] = [];
  if (m.market.closed) reasons.push('market closed');
  if (!m.market.active) reasons.push('market inactive');
  if (m.volumeUsd < cfg.minVolumeUsd) {
    reasons.push(`volume ${Math.round(m.volumeUsd)} < ${cfg.minVolumeUsd}`);
  }
  if (m.yesProbability === null) reasons.push('no yes-side price');
  return { stage: 'liquidity_floor', passed: reasons.length === 0, reasons };
}

function stageQualityNlp(m: FilteredMarket): StageResult {
  const a = assessQuality(m.market.question);
  return { stage: 'quality_nlp', passed: a.passed, reasons: a.reasons };
}

function stageTimeWindow(m: FilteredMarket, cfg: FilterConfig): StageResult {
  const reasons: string[] = [];
  if (m.daysToResolution === null) {
    reasons.push('no resolution date');
  } else {
    if (m.daysToResolution < cfg.minDaysToResolution) {
      reasons.push(`resolves in ${m.daysToResolution.toFixed(1)}d < ${cfg.minDaysToResolution}d`);
    }
    if (m.daysToResolution > cfg.maxDaysToResolution) {
      reasons.push(`resolves in ${m.daysToResolution.toFixed(1)}d > ${cfg.maxDaysToResolution}d`);
    }
  }
  return { stage: 'time_window', passed: reasons.length === 0, reasons };
}

function stageCategoryClassify(m: FilteredMarket, cfg: FilterConfig): StageResult {
  const score = classifyCategory(m.market.question);
  m.category = score.category;
  m.categoryConfidence = score.confidence;
  if (!cfg.allowedCategories.includes(score.category)) {
    return {
      stage: 'category_classify',
      passed: false,
      reasons: [`category '${score.category}' not in allowed set`],
    };
  }
  return { stage: 'category_classify', passed: true, reasons: [] };
}

/**
 * Diversity pre-filter.
 *
 * Two markets are considered near-duplicates if either:
 *   - their TF-IDF cosine similarity exceeds `dedupeCosineThreshold`, or
 *   - the correlation service's pair-score exceeds `dedupeCorrThreshold`.
 *
 * When a duplicate cluster is found, the market with higher volume wins and
 * the rest are rejected. Runs in O(N^2) over `candidates`, which is fine at
 * the Polymarket scale (<= a few hundred live markets at a time).
 */
function stageDiversity(
  candidates: FilteredMarket[],
  cfg: FilterConfig,
): Map<string, StageResult> {
  const results = new Map<string, StageResult>();
  if (candidates.length === 0) return results;

  const corpus = buildTfIdf(
    candidates.map((c) => ({ id: c.market.id, text: c.market.question })),
  );

  // Order by descending volume so higher-liquidity markets anchor clusters.
  const order = candidates
    .map((c, i) => ({ i, vol: c.volumeUsd }))
    .sort((a, b) => b.vol - a.vol)
    .map((o) => o.i);

  const dropped = new Set<number>();
  for (let a = 0; a < order.length; a++) {
    const ia = order[a];
    if (dropped.has(ia)) continue;
    const ma = candidates[ia];
    for (let b = a + 1; b < order.length; b++) {
      const ib = order[b];
      if (dropped.has(ib)) continue;
      const mb = candidates[ib];

      // Fast skip: if zero token overlap, cannot be a duplicate
      const aToks = new Set(tokenize(ma.market.question));
      const bToks = new Set(tokenize(mb.market.question));
      let inter = 0;
      for (const t of aToks) if (bToks.has(t)) inter++;
      if (inter === 0) continue;

      const cos = tfidfCosine(corpus, ia, ib);
      let corr = 0;
      if (cos >= cfg.dedupeCosineThreshold * 0.7) {
        // Only invoke correlation on plausible dupes to keep it cheap
        const la: LegMetadata = { id: ma.market.id, question: ma.market.question, end_date_iso: ma.market.end_date_iso };
        const lb: LegMetadata = { id: mb.market.id, question: mb.market.question, end_date_iso: mb.market.end_date_iso };
        corr = scoreLegPair(la, lb);
      }
      if (cos >= cfg.dedupeCosineThreshold || corr >= cfg.dedupeCorrThreshold) {
        dropped.add(ib);
        results.set(mb.market.id, {
          stage: 'diversity_prefilter',
          passed: false,
          reasons: [
            `near-duplicate of market ${ma.market.id}`,
            `cosine ${cos.toFixed(3)} (threshold ${cfg.dedupeCosineThreshold})`,
            `corr ${corr.toFixed(3)} (threshold ${cfg.dedupeCorrThreshold})`,
          ],
        });
      }
    }
  }
  // Anyone not in `dropped` passes
  for (const c of candidates) {
    if (!results.has(c.market.id)) {
      results.set(c.market.id, { stage: 'diversity_prefilter', passed: true, reasons: [] });
    }
  }
  return results;
}

// ---------- Pipeline ----------

/**
 * Run the full five-stage filter on a batch of Polymarket markets.
 *
 * Returns kept + rejected separately along with a per-stage funnel breakdown.
 * The caller can downstream-filter by `kept[*].category` to get a category-scoped
 * view (e.g., curated?category=crypto).
 */
export function filterMarkets(
  markets: PolymarketMarket[],
  partial: Partial<FilterConfig> = {},
): FilterResult {
  const cfg: FilterConfig = { ...DEFAULT_FILTER_CONFIG, ...partial };
  const funnel = emptyFunnel();
  funnel.input_count = markets.length;

  // Initialise FilteredMarket records
  const records: FilteredMarket[] = markets.map((m) => ({
    market: m,
    volumeUsd: parseVolume(m.volume),
    daysToResolution: daysFromNow(m.end_date_iso),
    category: 'other',
    categoryConfidence: 0,
    yesProbability: parseYesProbability(m),
    stages: [],
    droppedAt: null,
  }));

  // Stages 1–4 are per-market
  const stagesInOrder: Array<[FilterStage, (r: FilteredMarket) => StageResult]> = [
    ['liquidity_floor', (r) => stageLiquidityFloor(r, cfg)],
    ['quality_nlp', (r) => stageQualityNlp(r)],
    ['time_window', (r) => stageTimeWindow(r, cfg)],
    ['category_classify', (r) => stageCategoryClassify(r, cfg)],
  ];

  for (const r of records) {
    for (const [name, fn] of stagesInOrder) {
      funnel.per_stage[name].entered += 1;
      const res = fn(r);
      r.stages.push(res);
      if (!res.passed) {
        funnel.per_stage[name].rejected += 1;
        r.droppedAt = name;
        if (funnel.rejection_examples.length < 20) {
          funnel.rejection_examples.push({
            id: r.market.id,
            question: r.market.question,
            stage: name,
            reasons: res.reasons,
          });
        }
        break; // short-circuit: don't run later stages for a dropped market
      }
      funnel.per_stage[name].kept += 1;
    }
  }

  // Stage 5 sees only survivors
  const survivors = records.filter((r) => r.droppedAt === null);
  funnel.per_stage.diversity_prefilter.entered = survivors.length;
  const diversityResults = stageDiversity(survivors, cfg);
  for (const r of survivors) {
    const res = diversityResults.get(r.market.id) ?? {
      stage: 'diversity_prefilter' as FilterStage,
      passed: true,
      reasons: [],
    };
    r.stages.push(res);
    if (!res.passed) {
      funnel.per_stage.diversity_prefilter.rejected += 1;
      r.droppedAt = 'diversity_prefilter';
      if (funnel.rejection_examples.length < 20) {
        funnel.rejection_examples.push({
          id: r.market.id,
          question: r.market.question,
          stage: 'diversity_prefilter',
          reasons: res.reasons,
        });
      }
    } else {
      funnel.per_stage.diversity_prefilter.kept += 1;
    }
  }

  const kept = records.filter((r) => r.droppedAt === null);
  const rejected = records.filter((r) => r.droppedAt !== null);
  funnel.kept_count = kept.length;
  funnel.rejected_count = rejected.length;

  return { kept, rejected, funnel, config: cfg };
}

/**
 * Bundle-gate check for a single leg.
 *
 * Unlike `filterSingleMarket`, this does NOT short-circuit — every gate stage
 * runs independently so the caller sees the full picture even if an earlier
 * stage failed. The three gate stages are:
 *
 *   - activity (closed/inactive markets can never be bundle legs)
 *   - quality_nlp (caller-supplied question must be well-formed)
 *   - time_window (market's resolution date must land in the accept window)
 *
 * `liquidity_floor` volume and `category_classify` are intentionally NOT
 * gate stages — a bundle may legitimately include thin-volume or
 * uncategorised markets. `diversity_prefilter` is also excluded because it
 * is a cross-market check, not a per-leg check.
 *
 * Returns a FilteredMarket-shaped record plus a simple boolean. All stage
 * results (pass and fail) are recorded so the monitor's funnel counters see
 * every check, not just the first failure.
 */
export function gateCheckLeg(
  market: PolymarketMarket,
  question: string,
  partial: Partial<FilterConfig> = {},
): { passed: boolean; record: FilteredMarket } {
  const cfg: FilterConfig = { ...DEFAULT_FILTER_CONFIG, ...partial };
  const record: FilteredMarket = {
    market,
    volumeUsd: parseFloat(market.volume ?? '0') || 0,
    daysToResolution: (() => {
      if (!market.end_date_iso) return null;
      const t = new Date(market.end_date_iso).getTime();
      return Number.isFinite(t) ? (t - Date.now()) / 86_400_000 : null;
    })(),
    category: 'other',
    categoryConfidence: 0,
    yesProbability: null,
    stages: [],
    droppedAt: null,
  };

  // Stage A: market activity (subset of liquidity_floor; ignores volume)
  const activityReasons: string[] = [];
  if (market.closed) activityReasons.push('market closed');
  if (!market.active) activityReasons.push('market inactive');
  const activityResult: StageResult = {
    stage: 'liquidity_floor',
    passed: activityReasons.length === 0,
    reasons: activityReasons,
  };
  record.stages.push(activityResult);

  // Stage B: NLP quality on the caller-supplied question
  const { passed: qPassed, reasons: qReasons } = assessQuality(question);
  const qualityResult: StageResult = {
    stage: 'quality_nlp',
    passed: qPassed,
    reasons: qReasons,
  };
  record.stages.push(qualityResult);

  // Stage C: time window
  const timeReasons: string[] = [];
  if (record.daysToResolution === null) {
    timeReasons.push('no resolution date');
  } else {
    if (record.daysToResolution < cfg.minDaysToResolution) {
      timeReasons.push(`resolves in ${record.daysToResolution.toFixed(1)}d < ${cfg.minDaysToResolution}d`);
    }
    if (record.daysToResolution > cfg.maxDaysToResolution) {
      timeReasons.push(`resolves in ${record.daysToResolution.toFixed(1)}d > ${cfg.maxDaysToResolution}d`);
    }
  }
  const timeResult: StageResult = {
    stage: 'time_window',
    passed: timeReasons.length === 0,
    reasons: timeReasons,
  };
  record.stages.push(timeResult);

  // First-failing stage (ordered by the enum) is the dropped-at marker
  const firstFail = record.stages.find((s) => !s.passed);
  record.droppedAt = firstFail ? firstFail.stage : null;

  return { passed: record.droppedAt === null, record };
}
