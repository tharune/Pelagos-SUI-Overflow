/**
 * DeepBook Strategy Engine — prebuilt structured strategies deployed on the
 * DeepBook Predict platform, each one a real range-strip geometry on a live BTC
 * oracle.
 *
 * Every strategy is a parameterization of the SAME on-chain MM-priced range strip
 * (`previewStrip` → `get_range_trade_amounts` devInspect). A strategy maps to:
 *   - a strip half-width in σ (`spanSigma`), and
 *   - a per-bucket sizing geometry (`shape(d)`, d = 0 center … 1 wings)
 * exactly like `strategyProfile` in volatility.ts — we reuse that pin/barbell
 * weight idea and extend it to the full risk-profile taxonomy the UI tags
 * (tail-risk / convexity / payoff shape). NOTHING here invents a price: the strip
 * cost, slippage, and max payout are the protocol's real numbers, and the Greeks
 * come from the shared `computeVolGreeks` measure.
 *
 * The σ that sizes the bands is the oracle's own live implied move
 * (`impliedSigmaRaw`, tenor-aware SVI), so bands stay inside the mintable window.
 */
import * as structured from './predict/structured';
import { impliedSigmaRaw } from './predict/products';
import { computeVolGreeks, type VolGreeks } from './predict/volatility';
import { predictServer, findActiveOracle } from './predict/server';

const PRICE_SCALE = 1_000_000_000; // 1e9 strike / forward
const DUSDC_DECIMALS = 6;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export type TailRisk = 'low' | 'med' | 'high';
export type Convexity = 'long' | 'short' | 'neutral';
export type PayoffShape = 'pin' | 'plateau' | 'wings' | 'tail' | 'ladder' | 'capped';
export type ExpiryPref = 'near' | 'mid' | 'far';

export interface StrategyDef {
  id: string;
  name: string;
  thesis: string;
  tail_risk: TailRisk;
  convexity: Convexity;
  payoff_shape: PayoffShape;
  /** strip half-width in σ; wider = more OTM coverage. */
  spanSigma: number;
  /** band count (tuned so every band lands inside the mintable window). */
  n: number;
  /** per-bucket sizing weight given normalized distance from center d∈[0,1]. */
  shape: (d: number) => number;
  /** UI summary of the worst case relative to premium paid. */
  risk_note: string;
}

/**
 * The prebuilt catalogue — spans pin/short-gamma, breakout/long-gamma, convex
 * long-tail, protected/capped-downside, and term-ladder. `shape` mirrors the
 * pin↔barbell geometry already used by volatility.ts (center-heavy = short
 * gamma; wings-heavy = long gamma; plateau = ranged).
 */
export const STRATEGY_DEFS: StrategyDef[] = [
  {
    id: 'pin-short-gamma',
    name: 'Pin (Short Gamma)',
    thesis: 'Conviction BTC stays near the forward — center-heavy strip that pays if it pins.',
    tail_risk: 'low',
    convexity: 'short',
    payoff_shape: 'pin',
    spanSigma: 1.6,
    n: 6,
    shape: (d) => 0.12 + (1 - d) * 1.5,
    risk_note: 'Max loss = premium paid; best when BTC pins the forward, worst on a large move.',
  },
  {
    id: 'range-plateau',
    name: 'Range Plateau (Iron Condor)',
    thesis: 'BTC trades inside a band — wide central plateau, cheap wings, steady hit-rate.',
    tail_risk: 'low',
    convexity: 'short',
    payoff_shape: 'plateau',
    spanSigma: 2.6,
    n: 8,
    shape: (d) => (d < 0.55 ? 0.9 + (0.55 - d) : 0.06),
    risk_note: 'Max loss = premium; pays across a wide middle band, decays if BTC breaks out.',
  },
  {
    id: 'breakout-long-gamma',
    name: 'Breakout (Long Gamma)',
    thesis: 'Expecting a decisive BTC move either way — ATM-centered wings, long gamma.',
    tail_risk: 'med',
    convexity: 'long',
    payoff_shape: 'wings',
    spanSigma: 2.2,
    n: 8,
    shape: (d) => 0.15 + d * 1.1,
    risk_note: 'Max loss = premium; gains as BTC moves off the forward in either direction.',
  },
  {
    id: 'convex-tail',
    name: 'Convex Tail (Long Wings)',
    thesis: 'Cheap long-tail convexity — OTM-only wings that pay big on a violent move.',
    tail_risk: 'high',
    convexity: 'long',
    payoff_shape: 'tail',
    spanSigma: 3.2,
    n: 8,
    shape: (d) => (d < 0.4 ? 0.04 : 0.1 + d * 1.4),
    risk_note: 'Low premium, large convex payout on a tail event; expires worthless if BTC is calm.',
  },
  {
    id: 'protected-core',
    name: 'Protected Core (Capped Downside)',
    thesis: 'Funded mostly at the ATM core with capped wing exposure — defensive, high hit-rate.',
    tail_risk: 'low',
    convexity: 'neutral',
    payoff_shape: 'capped',
    spanSigma: 1.9,
    n: 6,
    shape: (d) => Math.max(0.1, 1.1 - d * 0.9),
    risk_note: 'Max loss = premium; concentrated near the forward, wings capped to limit cost.',
  },
  {
    id: 'skew-up',
    name: 'Upside Skew (Directional Convexity)',
    thesis: 'Tilted long the upside tail — pays more on a rally than a sell-off.',
    tail_risk: 'med',
    convexity: 'long',
    payoff_shape: 'wings',
    spanSigma: 2.8,
    n: 8,
    // asymmetric: weight grows on the upper half (signed distance via shapeSigned)
    shape: (d) => 0.12 + d * 1.0,
    risk_note: 'Max loss = premium; convexity skewed toward an upside BTC move.',
  },
  {
    id: 'term-ladder',
    name: 'Term Ladder (Stepped Strip)',
    thesis: 'A laddered strip stepping out from the core — graduated coverage across the range.',
    tail_risk: 'med',
    convexity: 'neutral',
    payoff_shape: 'ladder',
    spanSigma: 2.4,
    n: 8,
    shape: (d) => 0.2 + (1 - Math.abs(d - 0.5) * 2) * 0.9,
    risk_note: 'Max loss = premium; smooth graduated payout from core out to the wings.',
  },
];

/** Public list shape for GET /strategies (no internal geometry leaked). */
export interface StrategyListItem {
  id: string;
  name: string;
  thesis: string;
  tail_risk: TailRisk;
  convexity: Convexity;
  payoff_shape: PayoffShape;
}

export function listStrategies(): StrategyListItem[] {
  return STRATEGY_DEFS.map((s) => ({
    id: s.id,
    name: s.name,
    thesis: s.thesis,
    tail_risk: s.tail_risk,
    convexity: s.convexity,
    payoff_shape: s.payoff_shape,
  }));
}

export function findStrategy(id: string): StrategyDef | undefined {
  return STRATEGY_DEFS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Oracle resolution (near / mid / far across live BTC tenors)
// ---------------------------------------------------------------------------

interface ResolvedOracle {
  oracle_id: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  forward_raw: number;
}

function tenorLabel(ms: number): string {
  if (ms <= 0) return 'expired';
  const m = ms / 60_000;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  const d = h / 24;
  return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}

/**
 * Resolve a live BTC oracle by expiry preference. `near`/`mid`/`far` pick the
 * first/middle/last of the active BTC oracles sorted near→far (mirrors the term
 * basket's `resolveTermOracles`). Falls back to the soonest active oracle.
 */
async function resolveOracle(pref: ExpiryPref): Promise<ResolvedOracle> {
  const now = Date.now();
  const oracles = await predictServer.predictOracles().catch(() => predictServer.oracles());
  const active = oracles
    .filter((o) => o.status === 'active' && o.expiry > now + 6 * 60_000 && o.underlying_asset?.toUpperCase() === 'BTC')
    .sort((a, b) => a.expiry - b.expiry);
  let chosen = active[0];
  if (active.length > 0) {
    if (pref === 'far') chosen = active[active.length - 1];
    else if (pref === 'mid') chosen = active[Math.floor((active.length - 1) / 2)];
    else chosen = active[0];
  }
  if (!chosen) {
    const f = await findActiveOracle('BTC');
    if (!f) throw new Error('no active BTC oracle');
    const fp = (await predictServer.oraclePriceLatest(f.oracle_id)) as { forward?: number; spot?: number };
    return {
      oracle_id: f.oracle_id,
      expiry: f.expiry,
      min_strike: f.min_strike,
      tick_size: f.tick_size,
      forward_raw: Number(fp.forward ?? fp.spot ?? f.min_strike),
    };
  }
  const p = (await predictServer.oraclePriceLatest(chosen.oracle_id)) as { forward?: number; spot?: number };
  return {
    oracle_id: chosen.oracle_id,
    expiry: chosen.expiry,
    min_strike: chosen.min_strike,
    tick_size: chosen.tick_size,
    forward_raw: Number(p.forward ?? p.spot ?? chosen.min_strike),
  };
}

// ---------------------------------------------------------------------------
// Quote (real on-chain pricing via previewStrip)
// ---------------------------------------------------------------------------

export interface StrategyQuote {
  strategy_id: string;
  name: string;
  thesis: string;
  tail_risk: TailRisk;
  convexity: Convexity;
  payoff_shape: PayoffShape;
  risk_note: string;
  oracle_id: string;
  expiry: string;
  tenor_label: string;
  notional_usd: number;
  forward_usd: number;
  sigma_usd: number;
  atm_iv: number;
  t_years: number;
  /** worst case = premium paid (a bought strip). */
  max_loss_usd: number;
  strip: structured.StripQuote;
  greeks: VolGreeks;
  dusdc_decimals: number;
  /** tags the data origin so the UI never mistakes a fallback for a live mark. */
  source: 'deepbook-onchain' | 'deepbook-onchain-untradeable';
}

// Small in-memory cache: a strip quote fires many devInspect reads, so we serve
// identical (strategy, notional, tenor) requests from the last real on-chain
// result for a short window. Keyed without sender (pricing is sender-independent).
const QUOTE_TTL_MS = 8_000;
const quoteCache = new Map<string, { at: number; quote: StrategyQuote }>();

/** Build the per-bucket weight vector for a strategy across n ordered buckets. */
function strategyWeights(def: StrategyDef): number[] {
  const center = (def.n - 1) / 2;
  const maxd = Math.max(center, 1);
  const upper = def.id === 'skew-up';
  return Array.from({ length: def.n }, (_, i) => {
    const d = Math.abs(i - center) / maxd; // 0 center … 1 wings
    let w = Math.max(0, def.shape(d));
    // Upside-skew: bias mass to the upper half of the strip (above the forward).
    if (upper && i < center) w *= 0.35;
    return w;
  });
}

export async function quoteStrategy(args: {
  strategyId: string;
  notionalUsd: number;
  expiryPref?: ExpiryPref;
  sender?: string;
}): Promise<StrategyQuote> {
  const def = findStrategy(args.strategyId);
  if (!def) {
    throw new Error(`unknown strategy ${args.strategyId}; valid: ${STRATEGY_DEFS.map((s) => s.id).join(', ')}`);
  }
  const pref: ExpiryPref = args.expiryPref ?? 'mid';
  const notionalUsd = Math.max(1, Number(args.notionalUsd) || 100);

  const cacheKey = `${def.id}|${notionalUsd}|${pref}`;
  const hit = quoteCache.get(cacheKey);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.quote;

  const o = await resolveOracle(pref);
  const budgetRaw = BigInt(Math.round(notionalUsd * 10 ** DUSDC_DECIMALS));

  // σ = the oracle's live implied move (tenor-aware SVI), floored to the grid so
  // every band sits inside the protocol's mintable window.
  const sigmaRaw = await impliedSigmaRaw(
    { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
    o.forward_raw,
    Math.max(o.tick_size, Math.round(o.forward_raw * 0.005)),
  );

  const strip = await structured.previewStrip({
    oracle: { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
    muRaw: o.forward_raw,
    sigmaRaw,
    n: def.n,
    budgetRaw,
    spanSigma: def.spanSigma,
    weights: strategyWeights(def),
    sender: args.sender,
  });

  const forwardUsd = o.forward_raw / PRICE_SCALE;
  const sigmaUsd = sigmaRaw / PRICE_SCALE;
  const tYears = (Number(o.expiry) - Date.now()) / YEAR_MS;
  const atmIv = sigmaUsd / (forwardUsd * Math.sqrt(Math.max(tYears, 1e-9)));
  const greeks = computeVolGreeks(strip, forwardUsd, sigmaUsd, atmIv, tYears);

  const tradeable = strip.buckets.some((b) => b.tradeable && Number(b.quantity) > 0);
  const maxLossUsd = Number(strip.total_cost_raw) / 10 ** DUSDC_DECIMALS;

  const quote: StrategyQuote = {
    strategy_id: def.id,
    name: def.name,
    thesis: def.thesis,
    tail_risk: def.tail_risk,
    convexity: def.convexity,
    payoff_shape: def.payoff_shape,
    risk_note: def.risk_note,
    oracle_id: o.oracle_id,
    expiry: String(o.expiry),
    tenor_label: tenorLabel(Number(o.expiry) - Date.now()),
    notional_usd: notionalUsd,
    forward_usd: forwardUsd,
    sigma_usd: sigmaUsd,
    atm_iv: atmIv,
    t_years: tYears,
    max_loss_usd: maxLossUsd,
    strip,
    greeks,
    dusdc_decimals: DUSDC_DECIMALS,
    source: tradeable ? 'deepbook-onchain' : 'deepbook-onchain-untradeable',
  };
  quoteCache.set(cacheKey, { at: Date.now(), quote });
  return quote;
}
