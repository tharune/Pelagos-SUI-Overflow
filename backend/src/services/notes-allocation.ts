/**
 * Principal-Protected Notes (PPN) via DeFi-yield allocation — pricing engine.
 *
 * A PPN promises a protected floor (e.g. 100% of principal) at maturity while
 * routing the *yield* the principal earns over the tenor into a convex upside
 * strategy. The mechanic:
 *
 *   1. Park (most of) the principal in a real Sui USDC yield venue. Over the
 *      tenor that sleeve accrues `principal · apy · tenor` of yield.
 *   2. That accrued yield is the UPSIDE BUDGET — capital we can lose entirely
 *      without breaching the floor, because the floor is the principal itself.
 *   3. Deploy the upside budget into a DeepBook range-strip option structure
 *      (straddle / strangle / butterfly) for convexity. If the strategy pays
 *      nothing the holder still gets the floor; if it pays, that's the coupon.
 *
 * Presets trade tail-risk for convexity by choosing (a) the protected floor and
 * (b) how much of the yield buys convexity vs. is retained in the floor buffer:
 *
 *   Capital Guard      — 100% floor, conservative convexity (butterfly/pin),
 *                        a slice of yield retained → lowest tail-risk.
 *   Balanced Convexity — 100% floor, ATM straddle, most of the yield deployed.
 *   Long Tail          — 100% floor, OTM strangle, ALL yield deployed →
 *                        highest convexity, biggest best-case, zero downside.
 *
 * LIVE: the yield APY is the real Sui USDC supply rate. We pull named DeFiLlama
 * pools directly (same universe the vault-yield aggregator uses) and tag each
 * sleeve row with its real pool/source; on any upstream miss we fall back to the
 * lending service's live TVL-weighted anchor (`snapshot().market_supply_apy`),
 * and only then to a documented constant — never a fabricated "live" number.
 *
 * The DeepBook upside strip geometry is REUSED from the volatility engine
 * (`strategyProfile`) so a note's convexity shape matches the tradeable product.
 */

import { snapshot as lendingSnapshot } from './lending';
import { strategyProfile, type VolStrategy } from './predict/volatility';

// ---------------------------------------------------------------------------
// Live Sui USDC yield pools (DeFiLlama), cached like the vault-yield aggregator.
// ---------------------------------------------------------------------------

interface LlamaPool {
  chain?: string;
  project?: string;
  symbol?: string;
  stablecoin?: boolean;
  tvlUsd?: number | null;
  apyBase?: number | null;
  apy?: number | null;
  pool?: string;
}

export interface YieldPool {
  pool: string; // display name (humanized DeFiLlama project)
  project: string; // DeFiLlama project slug
  apy: number; // decimal, e.g. 0.064
  tvlUsd: number;
  source: string; // 'defillama:<project>' | 'lending-anchor' | 'fallback'
}

const YIELD_TTL_MS = 5 * 60_000;
const MIN_POOL_TVL_USD = 100_000;
const FALLBACK_APY = 0.055; // documented cold-boot fallback (matches lending.ts)
// A note's protection budget must come from a real USDC *supply* rate, not a
// volatile LP/AMM yield (which can quote triple-digit APYs that would mint a
// budget larger than principal — dishonest as "protection"). So we restrict to
// the same curated Sui lending venues the lending service anchors to, and cap
// the usable supply APY at a sane ceiling.
const LENDING_PROJECTS = new Set([
  'navi-lending', 'navi', 'scallop-lend', 'scallop', 'suilend',
  'kai-finance', 'kai', 'bucket', 'ember-protocol', 'ember', 'current',
]);
const MAX_SUPPLY_APY = 0.25; // ceiling for an honest USDC supply rate

let poolCache: { pools: YieldPool[]; at: number } | null = null;
let poolInflight: Promise<void> | null = null;

/** Humanize a DeFiLlama project slug for display: "navi-lending" -> "Navi". */
function humanizeProject(slug: string): string {
  return (
    slug
      .replace(/-(lending|lend|finance|protocol)$/i, '')
      .split('-')
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(' ') || slug
  );
}

function readApy(row: LlamaPool): number | null {
  const a = typeof row.apy === 'number' ? row.apy : null;
  if (a !== null && a > 0) return a / 100; // DeFiLlama APY is in percent
  const b = typeof row.apyBase === 'number' ? row.apyBase : null;
  if (b !== null && b > 0) return b / 100;
  return null;
}

function isSuiUsdcSupply(row: LlamaPool): boolean {
  if (row.chain !== 'Sui') return false;
  if (typeof row.symbol !== 'string') return false;
  // Single-asset USDC only (no LP pairs like "USDC-SUI").
  if (!/^USDC$/i.test(row.symbol)) return false;
  // Curated lending/supply venues only — excludes volatile LP/AMM yields.
  const slug = typeof row.project === 'string' ? row.project.toLowerCase() : '';
  return LENDING_PROJECTS.has(slug);
}

async function refreshPools(): Promise<void> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: LlamaPool[] };
    if (!Array.isArray(body.data)) return;
    const pools: YieldPool[] = body.data
      .filter(isSuiUsdcSupply)
      .map((row) => {
        const apy = readApy(row);
        const tvl = typeof row.tvlUsd === 'number' ? row.tvlUsd : 0;
        if (apy === null || apy > MAX_SUPPLY_APY || tvl < MIN_POOL_TVL_USD) return null;
        const slug = typeof row.project === 'string' ? row.project.toLowerCase() : '';
        return {
          pool: humanizeProject(slug),
          project: slug,
          apy,
          tvlUsd: tvl,
          source: `defillama:${slug}`,
        } as YieldPool;
      })
      .filter((p): p is YieldPool => p !== null)
      // Rank by APY desc — the protection budget is maximized by the best honest
      // live rate; ties broken by TVL so we prefer the deeper, safer pool.
      .sort((a, b) => b.apy - a.apy || b.tvlUsd - a.tvlUsd);
    // Keep one pool per venue (highest-APY hit) so a diversified sleeve spans
    // distinct protocols rather than two rows of the same venue.
    const byProject = new Map<string, YieldPool>();
    for (const p of pools) {
      if (!byProject.has(p.project)) byProject.set(p.project, p);
    }
    const deduped = Array.from(byProject.values());
    if (deduped.length > 0) {
      poolCache = { pools: deduped, at: Date.now() };
    }
  } catch {
    /* keep last-good / fall back to the lending anchor */
  }
}

/**
 * Top live Sui USDC yield pools (cached; refreshes in the background). Falls
 * back to the lending service's live TVL-weighted anchor, then a constant — the
 * returned `source` always tells the truth about provenance.
 */
function liveYieldPools(): YieldPool[] {
  if (!poolCache || Date.now() - poolCache.at > YIELD_TTL_MS) {
    if (!poolInflight) {
      poolInflight = refreshPools().finally(() => {
        poolInflight = null;
      });
    }
  }
  if (poolCache && poolCache.pools.length > 0) return poolCache.pools;
  // Fallback: the lending service's live market supply rate (DeFiLlama-anchored).
  const lend = lendingSnapshot();
  const apy = lend.market_supply_apy / 100; // snapshot reports percent
  const fromLending = lend.rate_source && lend.rate_source !== 'fallback';
  return [
    {
      pool: fromLending ? `Sui USDC market (${lend.rate_source.replace('defillama:', '')})` : 'Sui USDC market',
      project: 'sui-usdc',
      apy: apy > 0 ? apy : FALLBACK_APY,
      tvlUsd: 0,
      source: fromLending ? 'lending-anchor' : 'fallback',
    },
  ];
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface NotePreset {
  id: string;
  name: string;
  tail_risk: 'low' | 'medium' | 'high';
  /** Fraction of principal protected at maturity (1.0 = full principal back). */
  floor_pct: number;
  /** Fraction of the accrued yield deployed into convexity (rest stays in floor). */
  convexity_pct: number;
  /** Which DeepBook range-strip structure the upside budget buys. */
  strategy: VolStrategy;
  /** Default tenor if the caller doesn't pass one. */
  default_tenor_days: number;
  blurb: string;
}

/**
 * Three presets along the tail-risk / convexity ladder. All protect 100% of
 * principal; they differ in how aggressively the yield is spent on convexity and
 * in the *shape* of that convexity (pinned vs ATM vs OTM tail).
 */
// Institutional protected-note lineup — every preset is 100% principal-protected
// (floor_pct 1.0); they differ by the upside strip's shape, how much of the yield
// is spent on it (convexity_pct) and tenor, spanning all four strip geometries
// (butterfly pin · condor plateau · ATM straddle · OTM strangle).
const NOTE_PRESETS: NotePreset[] = [
  {
    id: 'capital-guard',
    name: 'Capital Guard',
    tail_risk: 'low',
    floor_pct: 1.0,
    convexity_pct: 0.55, // retain ~45% of the yield as an extra floor buffer
    strategy: 'butterfly', // short-gamma pin: pays if BTC stays, cheap convexity
    default_tenor_days: 90,
    blurb: 'Full principal floor with the largest yield buffer retained and a tight pinned-convexity strip. The lowest tail-risk note.',
  },
  {
    id: 'range-income',
    name: 'Range Income',
    tail_risk: 'low',
    floor_pct: 1.0,
    convexity_pct: 0.7,
    strategy: 'condor', // wide plateau: pays across a range around the forward
    default_tenor_days: 120,
    blurb: 'Full principal floor, a wide condor plateau that pays across a range, with part of the yield retained.',
  },
  {
    id: 'steady-straddle',
    name: 'Steady Straddle',
    tail_risk: 'medium',
    floor_pct: 1.0,
    convexity_pct: 0.8,
    strategy: 'straddle',
    default_tenor_days: 90,
    blurb: 'Full principal floor on a short tenor, most of the yield into a near-ATM straddle for faster two-sided convexity.',
  },
  {
    id: 'balanced-convexity',
    name: 'Balanced Convexity',
    tail_risk: 'medium',
    floor_pct: 1.0,
    convexity_pct: 0.9,
    strategy: 'straddle', // long-gamma ATM: gains as BTC moves either way
    default_tenor_days: 180,
    blurb: 'Full principal floor, most of the yield into an ATM straddle for balanced two-sided upside.',
  },
  {
    id: 'two-way-breakout',
    name: 'Two-Way Breakout',
    tail_risk: 'medium',
    floor_pct: 1.0,
    convexity_pct: 0.85,
    strategy: 'strangle', // OTM wings, cheaper than a straddle
    default_tenor_days: 120,
    blurb: 'Full principal floor, the yield into OTM strangle wings — cheaper carry that pays on a decisive move either way.',
  },
  {
    id: 'full-gamma',
    name: 'Full Gamma',
    tail_risk: 'high',
    floor_pct: 1.0,
    convexity_pct: 1.0,
    strategy: 'straddle', // entire yield into an ATM straddle
    default_tenor_days: 270,
    blurb: 'Full principal floor, the entire yield into an ATM straddle for maximal two-sided gamma.',
  },
  {
    id: 'long-tail',
    name: 'Long Tail',
    tail_risk: 'high',
    floor_pct: 1.0,
    convexity_pct: 1.0, // spend the entire yield on the tail
    strategy: 'strangle', // long-gamma OTM wings: cheap, pays big on a large move
    default_tenor_days: 365,
    blurb: 'Full principal floor, all yield into far OTM strangle wings. Highest convexity and the biggest best-case.',
  },
];

function presetById(id: string): NotePreset | undefined {
  return NOTE_PRESETS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Upside-strip payoff geometry (reused from the volatility engine)
// ---------------------------------------------------------------------------

const STRIP_BUCKETS = 11; // odd → a clean center band, matches vol-surface strips

/**
 * Model the convexity a `budget` of premium buys in `strategy`'s strip. We use
 * the volatility engine's `strategyProfile` to get the real per-bucket sizing
 * weights, then translate budget → expected best/worst payoff with a payoff
 * multiple that reflects the structure's leverage (long-gamma OTM strips pay a
 * larger multiple in the tail; pinned short-gamma strips pay a tighter, more
 * likely coupon). This mirrors how the on-chain strip would settle without
 * needing a live DeepBook price here.
 */
function upsideStrategy(strategy: VolStrategy, budgetUsd: number): {
  name: string;
  shape: string;
  expected_best_usd: number;
  expected_worst_usd: number;
  payoff_multiple_best: number;
  thesis: string;
} {
  const profile = strategyProfile(strategy, STRIP_BUCKETS);
  // Concentration of the strip = how peaked the weights are (max share of total).
  // A peaked strip (butterfly) has a high hit-probability but low multiple; a
  // flat/wing-heavy strip (strangle) has a low hit-probability but high multiple.
  const wSum = profile.weights.reduce((a, b) => a + b, 0) || 1;
  const peak = Math.max(...profile.weights) / wSum; // 0..1
  // Best-case payoff multiple: wings-heavy long-gamma strips lever the budget up;
  // pinned strips cap nearer 1×. spanSigma widens the tail multiple.
  const multiple =
    profile.side === 'long'
      ? 1 + profile.spanSigma * (1.1 - peak) * 2.4 // long: 2.5×–7× range
      : 1 + (1 - peak) * 1.6; // short/pinned: ~1.2×–2×
  const expectedBest = budgetUsd * multiple;
  // Worst case for a long premium-spend strip is losing the premium (budget),
  // which is exactly the yield — the FLOOR is untouched, so the note worst-case
  // is still the protected principal. We report the strip's own worst here.
  const expectedWorst = 0; // strip can expire worthless; note floor protects principal
  return {
    name: profile.label,
    shape: profile.side === 'long' ? `long-gamma ${strategy}` : `short-gamma ${strategy}`,
    expected_best_usd: round2(expectedBest),
    expected_worst_usd: round2(expectedWorst),
    payoff_multiple_best: round2(multiple),
    thesis: profile.thesis,
  };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export interface YieldSleeveRow {
  pool: string;
  apy: number;
  allocation_usd: number;
  source: string;
}

export interface NoteQuote {
  preset_id: string;
  preset_name: string;
  principal_usd: number;
  tenor_days: number;
  protected_floor_usd: number;
  blended_apy: number;
  yield_sleeve: YieldSleeveRow[];
  upside_budget_usd: number;
  upside_strategy: {
    name: string;
    shape: string;
    expected_best_usd: number;
    expected_worst_usd: number;
  };
  projected: {
    floor_usd: number; // worst case at maturity (protected)
    expected_usd: number; // floor + a probability-weighted slice of upside
    best_usd: number; // floor + full strip best-case
  };
  sources: string[];
}

export class NoteQuoteError extends Error {
  code: 'BAD_PRINCIPAL' | 'UNKNOWN_PRESET' | 'BAD_TENOR';
  constructor(code: NoteQuoteError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Build a single yield sleeve from the live pools. To keep the protection budget
 * honest and diversified we split the principal across up to two top live pools
 * (best-APY first), so a single venue's rate spike doesn't dominate the note.
 */
function buildYieldSleeve(principalUsd: number): { rows: YieldSleeveRow[]; blendedApy: number } {
  const pools = liveYieldPools();
  const take = pools.slice(0, Math.min(2, pools.length));
  // Weight toward the higher-APY pool but keep the second funded for diversification.
  const weights = take.length === 2 ? [0.65, 0.35] : [1];
  let blended = 0;
  const rows: YieldSleeveRow[] = take.map((p, i) => {
    const alloc = principalUsd * weights[i];
    blended += p.apy * weights[i];
    return {
      pool: p.pool,
      apy: round4(p.apy),
      allocation_usd: round2(alloc),
      source: p.source,
    };
  });
  return { rows, blendedApy: blended };
}

export function quoteNote(args: {
  principalUsd: number;
  presetId: string;
  tenorDays?: number;
}): NoteQuote {
  const principal = Number(args.principalUsd);
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new NoteQuoteError('BAD_PRINCIPAL', 'principal_usd must be a positive number');
  }
  const preset = presetById(String(args.presetId));
  if (!preset) {
    throw new NoteQuoteError(
      'UNKNOWN_PRESET',
      `unknown preset_id '${args.presetId}'. Valid: ${NOTE_PRESETS.map((p) => p.id).join(', ')}`,
    );
  }
  const tenorRaw = args.tenorDays === undefined ? preset.default_tenor_days : Number(args.tenorDays);
  if (!Number.isFinite(tenorRaw) || tenorRaw <= 0) {
    throw new NoteQuoteError('BAD_TENOR', 'tenor_days must be a positive number');
  }
  const tenorDays = Math.min(1825, tenorRaw); // cap at 5y so the yield math stays sane

  // Floor: the protected principal returned at maturity.
  const protectedFloor = principal * preset.floor_pct;

  // Yield sleeve over the tenor. Simple (non-compounding) accrual on the live APY
  // gives the protection/upside budget: principal · apy · (tenor / 365).
  const { rows, blendedApy } = buildYieldSleeve(principal);
  const yearFrac = tenorDays / 365;
  const accruedYield = principal * blendedApy * yearFrac;

  // Convexity split: how much of the yield buys the strip vs. stays in the floor
  // buffer (the retained slice cushions any floor shortfall / fees).
  const upsideBudget = accruedYield * preset.convexity_pct;

  const strip = upsideStrategy(preset.strategy, upsideBudget);

  // Probability-weighted "expected" coupon: a long-gamma strip with a high best
  // multiple has a lower hit-probability, so we damp the expected by 1/multiple
  // (rough fair-value: budget ≈ p_hit · payoff). Pinned short-gamma strips hit
  // more often → larger expected slice. Honest middle estimate, not a promise.
  const hitProb = strip.payoff_multiple_best > 0 ? 1 / strip.payoff_multiple_best : 0;
  const expectedCoupon = strip.expected_best_usd * hitProb;

  const sources = Array.from(new Set(rows.map((r) => r.source)));

  return {
    preset_id: preset.id,
    preset_name: preset.name,
    principal_usd: round2(principal),
    tenor_days: tenorDays,
    protected_floor_usd: round2(protectedFloor),
    blended_apy: round4(blendedApy),
    yield_sleeve: rows,
    upside_budget_usd: round2(upsideBudget),
    upside_strategy: {
      name: strip.name,
      shape: strip.shape,
      expected_best_usd: strip.expected_best_usd,
      expected_worst_usd: strip.expected_worst_usd,
    },
    projected: {
      floor_usd: round2(protectedFloor),
      expected_usd: round2(protectedFloor + expectedCoupon),
      best_usd: round2(protectedFloor + strip.expected_best_usd),
    },
    sources,
  };
}

/** Preset cards for the strategies endpoint, each carrying a live blended APY +
 *  an indicative best-case on a $10k / default-tenor note so the UI can rank. */
export function listStrategies(): {
  presets: Array<
    NotePreset & {
      live_apy: number;
      apy_source: string;
      sample: { principal_usd: number; tenor_days: number; upside_budget_usd: number; best_usd: number };
    }
  >;
  apy_sources: string[];
} {
  const pools = liveYieldPools();
  const apySource = pools[0]?.source ?? 'fallback';
  const SAMPLE = 10_000;
  const presets = NOTE_PRESETS.map((p) => {
    const q = quoteNote({ principalUsd: SAMPLE, presetId: p.id, tenorDays: p.default_tenor_days });
    return {
      ...p,
      live_apy: round4(q.blended_apy),
      apy_source: apySource,
      sample: {
        principal_usd: SAMPLE,
        tenor_days: p.default_tenor_days,
        upside_budget_usd: q.upside_budget_usd,
        best_usd: q.projected.best_usd,
      },
    };
  });
  return { presets, apy_sources: Array.from(new Set([apySource, ...pools.map((p) => p.source)])) };
}
