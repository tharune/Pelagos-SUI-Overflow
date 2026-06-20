/**
 * Pelagos tranche pricing engine (frontend canonical copy).
 *
 * The tranche product slices a basket of prediction-market positions into
 * three fixed-waterfall claims:
 *
 *   senior    - paid first out of whatever fraction of NAV the basket
 *               actually delivers. Low APY, low tail risk.
 *   mezzanine - paid next. Medium APY, medium tail risk.
 *   junior    - paid last and eats the first loss. High APY, high tail
 *               risk.
 *
 * This module turns a LIVE basket (weighted legs of Polymarket YES/NO
 * contracts with independent per-leg probabilities) into:
 *
 *   1. An outcome distribution for the basket's NAV at resolution.
 *   2. Call-spread fair value per tranche under that distribution,
 *      computed in closed form under a Normal(μ, σ²) approximation
 *      of the basket outcome.
 *   3. A fair-anchored ask price
 *          ask = fair × (1 − target_apy · τ)
 *      where `target_apy` is a tranche-kind yield pickup that scales
 *      linearly with basket σ. The ask is always ≤ fair, so a buyer's
 *      risk-neutral expected annualised return equals the yield pickup.
 *   4. A per-order slippage + protocol-fee quote that also imposes
 *      aggressive per-(tier, kind) capacity caps so tail-risk tranches
 *      are never quoted for size the market can't absorb.
 *
 * The old engine priced via `ask = 1 / (1 + target_apy · τ)` without
 * referencing fair value at all — producing e.g. a $0.94 ask on a LOW
 * junior whose fair value was $0.004, and advertising +75% APY on a
 * position with ~99.6% expected loss. The fair-anchored formula here
 * is mathematically sound across all 9 (tier, window) cells.
 *
 * Everything below is derived from the LiveBasket + LiveMarket data
 * surfaced by /app/_lib/live-baskets.ts — there are NO hard-coded per-
 * basket constants. The only constants are model hyperparameters
 * (capital cost of underwriting, tranche-kind multipliers, etc.) which
 * are all labelled inline.
 */

import type { LiveMarket } from "../_lib/live-baskets";
import type { BasketHedgeability, OrderRisk } from "./_risk";
import { computeOrderRisk, computeMaxPositionUsdc } from "./_risk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrancheKind = "senior" | "mezzanine" | "junior";

/**
 * Aggregate risk statistics for a basket. Derived from the weighted legs
 * under a CLT / independence approximation:
 *   NAV     = Σ w_i p_i
 *   sigma^2 = Σ w_i^2 p_i (1 - p_i)
 *   skew    = Σ w_i^3 (1 - 2 p_i) p_i (1 - p_i) / sigma^3
 *   N_eff   = 1 / Σ w_i^2       (Herfindahl-effective leg count)
 *
 * weakestLegVolumeUsd is the min lifetime Polymarket volume among the top
 * legs by weight; it's the bottleneck on how deep the MM can hedge the
 * basket without moving a constituent market.
 */
export interface BasketStats {
  nav: number;
  sigma: number;
  skew: number;
  effLegCount: number;
  herfindahl: number;
  maxLegWeight: number;
  weakestLegVolumeUsd: number;
  meanLegVolumeUsd: number;
  totalLegs: number;
  daysLeft: number;
  tier: 90 | 50;
  /** Fraction of notional in the single most-concentrated category. 0..1. */
  maxCategoryShare: number;
}

export interface TrancheFeeDecomp {
  /** Flat protocol take. */
  protocolBps: number;
  /** Market-maker spread baked into the ask, decomposed below. */
  mmSpreadBps: number;
  /** Underwriting / capital-at-risk premium baked into the ask. */
  underwritingBps: number;
  /** Sub-components of the MM spread (sum == mmSpreadBps ± rounding). */
  mmComponents: {
    baseBps: number;
    deltaHedgeBps: number;
    gammaHedgeBps: number;
    adverseSelectionBps: number;
    liquidityPenaltyBps: number;
    kindMultiplier: number;
  };
  /** Sub-components of the underwriting premium. */
  underwritingComponents: {
    capitalAtRisk: number;      // per $1 notional, 0..1
    horizonYears: number;
    costOfCapital: number;      // annualised, 0..1
    tailMultiplier: number;
    concentrationMultiplier: number;
    cvar95: number;             // expected shortfall (per $1 notional)
  };
}

export interface TrancheQuote {
  kind: TrancheKind;
  attach: number;               // lower bound of tranche slice, 0..1
  detach: number;               // upper bound of tranche slice, 0..1
  notionalShare: number;        // = detach - attach
  fairPrice: number;            // risk-neutral E[payoff] per $1 face
  marketPrice: number;          // ask price per token (≤ fair under current pricing)
  /**
   * Headline APY shown in UI. Yield-to-maturity at face, lightly
   * risk-adjusted by clamping against the mean return:
   *   ytm     = (1 / ask − 1) / max(30 days, τ)
   *   mean    = (fair / ask − 1) / max(30 days, τ)
   *   apy     = min(ytm, LOTTERY_UPSIDE_CAP · mean)
   * The cap prevents deep-OTM junior tranches (where ytm can reach
   * tens of thousands of percent because P[full pay] is near zero)
   * from displaying as absurd figures, while still showing an
   * amplified "lottery upside" number above the pure expected return.
   * On senior/mezz the ytm bind is usually below the cap, so the
   * display reads as plain yield-to-maturity.
   */
  expectedApyPct: number;
  /** Risk-neutral EXPECTED annualised return: (fair/ask − 1)/τ, true
   *  horizon, no 30-day floor. This is the MEAN of the payoff
   *  distribution annualised — what a holder earns on expectation
   *  under the Normal basket-outcome model. Always ≤ expectedApyPct;
   *  equals it only when fair = 1. */
  expectedReturnApyPct: number;
  attachProbability: number;    // P[basket pays anything to this tranche]
  fullPayProbability: number;   // P[basket pays the tranche fully]
  /** Greeks of the tranche call-spread at the current NAV. */
  delta: number;
  gamma: number;
  /** Capital at risk per $1 face (= 1 - fairPrice). */
  capitalAtRisk: number;
  /** Conditional tail expectation in the left tail (per $1 face). */
  cvar95: number;
  fees: TrancheFeeDecomp;
  /** Aggressive hard cap on a single order into this tranche. */
  maxOrderUsdc: number;
  /** Soft depth cap derived from weakest-leg liquidity. */
  depthCapUsdc: number;
}

export interface OrderQuote {
  tokensOut: number;
  /** Decomposed order-time fees. All in basis points. */
  protocolFeeBps: number;
  mmSpreadBps: number;
  slippageBps: number;
  totalFeeBps: number;
  /** The binding capacity used to clamp this order (min of hard cap / depth cap). */
  capacityUsdc: number;
  /** True if the order size exceeded the effective capacity. */
  overCapacity: boolean;
  /** Full risk breakdown when live hedgeability data is passed in. */
  risk?: OrderRisk;
  /**
   * Fraction of the order that the MM would have to warehouse
   * (couldn't hedge immediately in the underlying CLOB). 0..1.
   */
  warehouseFraction: number;
}

const PROFILE_STRESS_MULT: Record<90 | 70 | 50, number> = {
  90: 0.9,  // ~95 confidence
  70: 1.15, // ~50 confidence
  50: 1.4,  // ~5 confidence
};

// ---------------------------------------------------------------------------
// Model hyperparameters (labelled — nothing below is basket-specific)
// ---------------------------------------------------------------------------

/**
 * Attachment-point placement. Tier-agnostic — both K1 and K2 are
 * positioned relative to basket (μ, σ) using a common percentile
 * convention:
 *
 *   K1 = μ            (median of basket outcome)
 *   K2 = μ + 1.0σ     (~84th percentile)
 *
 * Senior sits on [0, μ]: captures basket payoff up to the median.
 * Mezzanine sits on [μ, μ+σ]: the typical-outperformance band.
 * Junior sits on [μ+σ, 1]: the right tail.
 *
 * This differs from the prior tier-specific design which pushed
 * senior down to μ − 1.5σ on HIGH-tier baskets. Senior anchored at
 * the median gives fair ≈ 0.90–0.99 on HIGH baskets with room for a
 * meaningful yield pickup, while still delivering 50%+ full-pay
 * probability.
 *
 * Under the current fair-anchored pricing each tranche is sold at
 * (1 − pickup · τ) × fair, so the user's expected return is the
 * yield pickup regardless of which slice is widest — HIGH senior,
 * LOW junior, etc. Protocol revenue is collected via per-order
 * `PROTOCOL_FEE_BPS` rather than from a markup over fair.
 */
const ATTACH_K1_SIGMA = 0.0; // K1 = μ + 0·σ = μ (median)
const ATTACH_K2_SIGMA = 1.0; // K2 = μ + 1·σ (~84th pct)

/**
 * Per-kind multiplier on the MM spread. Junior positions are
 * structurally the hardest to hedge (convex payoff, tail-dependent)
 * so the MM charges more for shouldering them.
 */
const MM_KIND_MULT: Record<TrancheKind, number> = {
  senior: 1.0,
  mezzanine: 1.18,
  junior: 1.35,
};

/**
 * Per-kind tail multiplier on the underwriting premium. A junior
 * underwriter is effectively short a deep out-of-the-money put on
 * the basket, so capital must be held against a much bigger tail loss
 * for the same notional.
 */
const UW_TAIL_MULT: Record<TrancheKind, number> = {
  senior: 1.0,
  mezzanine: 2.2,
  junior: 4.5,
};

/** Annualised cost of underwriting capital. */
const UW_COST_OF_CAPITAL = 0.15;

/**
 * Target annualised yield-pickup per tranche kind, linear in basket σ:
 *
 *   target_apy(kind) = YIELD_PICKUP_BASE[kind] + YIELD_PICKUP_SIGMA_SLOPE[kind] · σ
 *
 * clamped to [YIELD_PICKUP_BASE[kind], YIELD_PICKUP_MAX[kind]]. The
 * ask price is then anchored to FAIR VALUE with this yield pickup as
 * the user's expected annualised return, using present-value
 * discounting:
 *
 *   ask = fair / (1 + target_apy · τ)
 *
 * so the user's risk-neutral expected annualised return
 *   (fair / ask − 1) / τ
 * equals `target_apy` EXACTLY for any horizon τ. This replaces the
 * previous target-APY-inverse pricing,
 * which ignored fair value entirely and produced asks 20–200× above
 * fair on OTM tranches — a user paying $0.94 for a junior with $0.004
 * fair value was guaranteed ~99.6% expected loss despite a quoted
 * +75% APY.
 *
 * Tuned so a live basket grid produces honest DeFi-intuitive APYs:
 *   senior  3–12%    (bond-like, near-fair)
 *   mezz    12–45%   (moderate yield, moderate discount to fair)
 *   junior  35–120%  (aggressive / lottery upside, deep discount to fair)
 *
 * Protocol-side P&L note: Because every ask sits below fair, the
 * stack-level tranche revenue is
 *     Σ width_k · ask_k  =  Σ width_k · fair_k · mult_k
 *                       ≤  Σ width_k · fair_k
 *                       =  μ
 * i.e. it is ALWAYS ≤ the expected basket payout. The protocol's
 * real-world structural profit is therefore expected to come from
 *   (a) Polymarket bid-ask capture on basket construction (legs
 *       bought at bid < the `probability` mids used here as fair), and
 *   (b) per-order `PROTOCOL_FEE_BPS` collected on deposits/redemptions.
 * Neither is modelled inside this pricing engine — the engine only
 * produces user-facing quotes that are honest about risk-adjusted
 * expected return. A future revision can toggle a senior markup here
 * if the business model ever needs tranche-side margin.
 */
const YIELD_PICKUP_BASE: Record<TrancheKind, number> = {
  senior: 0.04,
  mezzanine: 0.15,
  junior: 0.40,
};
const YIELD_PICKUP_SIGMA_SLOPE: Record<TrancheKind, number> = {
  senior: 0.5,
  mezzanine: 3.0,
  junior: 8.0,
};
const YIELD_PICKUP_MAX: Record<TrancheKind, number> = {
  senior: 0.12,
  mezzanine: 0.50,
  junior: 1.20,
};

/**
 * Lower bound on the ask/fair ratio. Under present-value discounting
 * `ask = fair / (1 + pickup · τ)` is always strictly positive, but
 * for very long-dated junior baskets (pickup ≈ 1.2, τ ≈ 0.9) the ask
 * can land as low as ~47% of fair. We cap the implied discount at
 * `1 − DISCOUNT_FLOOR` to keep the price from collapsing to zero and
 * to bound the on-screen APY at a sensible multiple of the base
 * pickup.
 */
const DISCOUNT_FLOOR = 0.15; // ask ≥ 0.15 × fair

function yieldPickupFor(kind: TrancheKind, sigma: number): number {
  const raw =
    YIELD_PICKUP_BASE[kind] + YIELD_PICKUP_SIGMA_SLOPE[kind] * Math.max(0, sigma);
  return Math.max(
    YIELD_PICKUP_BASE[kind],
    Math.min(YIELD_PICKUP_MAX[kind], raw),
  );
}

/**
 * Flat protocol fee on the USDC notional, by kind. These are the
 * "full-duration" ceilings; the actual charge is scaled down by
 * `durationScale(days)` so short-dated baskets don't pay the same
 * absolute fee as a year-long position. Without scaling, 25 bps on a
 * 12-day basket annualises to ~760% APY drag, which is silly for a
 * two-week product.
 */
const PROTOCOL_FEE_BPS: Record<TrancheKind, number> = {
  senior: 25,
  mezzanine: 35,
  junior: 50,
};

/**
 * Duration-scaling factor applied to fixed-bps fees (protocol take,
 * MM base/delta-hedge/adverse-selection/liquidity). Scales with
 * sqrt(days / DURATION_REF_DAYS) so short baskets pay proportionally
 * less fixed overhead:
 *
 *   12 days  → sqrt(12/90)  ≈ 0.37  (37% of full fee)
 *   30 days  → sqrt(30/90)  ≈ 0.58  (58%)
 *   65 days  → sqrt(65/90)  ≈ 0.85  (85%)
 *   90+ days → 1.00                (full fee; this is the "reference")
 *
 * The floor keeps the fee from collapsing on 1-day legs; the ceiling
 * prevents multi-year baskets from over-paying vs the calibrated
 * reference. Sqrt scaling (rather than linear) matches how dealer
 * hedging cost and inventory carry empirically scale with holding
 * period — a 4× longer hold doesn't cost 4× more to manage, it costs
 * about 2× more.
 */
const DURATION_REF_DAYS = 90;
const DURATION_SCALE_FLOOR = 0.30;
function durationScale(daysLeft: number): number {
  const d = Math.max(1, daysLeft);
  return Math.max(
    DURATION_SCALE_FLOOR,
    Math.min(1, Math.sqrt(d / DURATION_REF_DAYS)),
  );
}

/**
 * Fraction of the weakest leg's lifetime Polymarket volume that the
 * MM is willing to take down per order before slippage becomes
 * unbounded. Scales inversely with the tranche's notional share: a
 * 5% notional junior that touches the whole basket's hedge surface
 * is capped harder than a 60% notional senior at the same weakest-
 * leg volume.
 */
const DEPTH_CAP_FRAC = 0.05;

// ---------------------------------------------------------------------------
// Standard normal helpers
// ---------------------------------------------------------------------------

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function stdNormalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

function stdNormalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 via error-function approximation.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function stdNormalSurv(z: number): number {
  return 1 - stdNormalCdf(z);
}

/**
 * Survival probability under a Normal(μ,σ²) truncated to [0,1].
 *
 * Why this matters:
 * - plain Normal tails leak probability mass above 1 and below 0.
 * - that made `P[full pay]` too high for junior (detach=1), because
 *   `P(X>=1)` on an unbounded Normal can be non-zero.
 *
 * Truncating to [0,1] keeps probabilities economically feasible for a
 * bounded basket payoff while preserving CLT-style smoothness.
 */
function boundedNormalSurv(mu: number, sigma: number, threshold: number): number {
  if (threshold <= 0) return 1;
  if (threshold >= 1) return 0;
  const z0 = (0 - mu) / sigma;
  const z1 = (1 - mu) / sigma;
  const zt = (threshold - mu) / sigma;
  const denom = Math.max(1e-9, stdNormalCdf(z1) - stdNormalCdf(z0));
  const num = Math.max(0, stdNormalCdf(z1) - stdNormalCdf(zt));
  return Math.max(0, Math.min(1, num / denom));
}

// ---------------------------------------------------------------------------
// Basket statistics
// ---------------------------------------------------------------------------

/**
 * Compute aggregate basket statistics from the weighted legs. When
 * `markets` is empty (seed/fallback path) we synthesise a plausible
 * σ from the tier-typical dispersion, so the detail page still works
 * offline. Live callers should always pass the real legs.
 */
export function computeBasketStats(
  nav: number,
  markets: LiveMarket[],
  totalLegs: number,
  daysLeft: number,
  tier: 90 | 50,
): BasketStats {
  // Defensive: if no legs given, fall back to a tier-typical dispersion.
  // This matches the worst-case σ the live pipeline produces for a
  // basket with MIN_BASKET_LEGS near-equal legs at that NAV.
  if (!markets || markets.length === 0) {
    const p = Math.max(0.01, Math.min(0.99, nav));
    const sigma = Math.sqrt((p * (1 - p)) / Math.max(1, totalLegs));
    return {
      nav: p,
      sigma: Math.max(0.005, sigma),
      skew: 0,
      effLegCount: Math.max(1, totalLegs),
      herfindahl: 1 / Math.max(1, totalLegs),
      maxLegWeight: 1 / Math.max(1, totalLegs),
      weakestLegVolumeUsd: 10_000,
      meanLegVolumeUsd: 10_000,
      totalLegs,
      daysLeft: Math.max(1, daysLeft),
      tier,
      maxCategoryShare: 1 / 3,
    };
  }

  // Normalise weights (they SHOULD sum to 1 but guard anyway).
  const rawWeights = markets.map((m) => Math.max(0, m.weight));
  const wSum = rawWeights.reduce((a, b) => a + b, 0) || 1;
  const weights = rawWeights.map((w) => w / wSum);
  const probs = markets.map((m) =>
    Math.max(0.001, Math.min(0.999, m.probability)),
  );

  let mu = 0;
  let variance = 0;
  let thirdMoment = 0;
  let herfindahl = 0;
  for (let i = 0; i < markets.length; i++) {
    const w = weights[i];
    const p = probs[i];
    mu += w * p;
    variance += w * w * p * (1 - p);
    // E[(X - p)^3] for Bernoulli = p(1-p)(1-2p); basket 3rd central
    // moment aggregates as Σ w^3 * that.
    thirdMoment += w * w * w * p * (1 - p) * (1 - 2 * p);
    herfindahl += w * w;
  }
  const sigma = Math.sqrt(Math.max(1e-8, variance));
  const skew = thirdMoment / Math.pow(sigma, 3);
  const effLegCount = 1 / Math.max(1e-8, herfindahl);
  const maxLegWeight = weights.reduce((m, w) => (w > m ? w : m), 0);

  // Top-weight legs drive the MM's hedge path; use the min of the
  // weighted top 10 as the "weakest leg" for liquidity scaling.
  const topByWeight = markets
    .map((m, i) => ({ m, w: weights[i] }))
    .sort((a, b) => b.w - a.w)
    .slice(0, Math.min(10, markets.length));
  let weakestLegVolumeUsd = Number.POSITIVE_INFINITY;
  let meanLegVolumeUsd = 0;
  let volumeCount = 0;
  for (const entry of topByWeight) {
    const v = entry.m.volumeUsd;
    if (Number.isFinite(v) && v >= 0) {
      if (v < weakestLegVolumeUsd) weakestLegVolumeUsd = v;
      meanLegVolumeUsd += v;
      volumeCount += 1;
    }
  }
  if (!Number.isFinite(weakestLegVolumeUsd)) weakestLegVolumeUsd = 10_000;
  meanLegVolumeUsd = volumeCount > 0 ? meanLegVolumeUsd / volumeCount : 10_000;

  // Category concentration: used downstream to penalise underwriting
  // when the basket is secretly a one-category bet.
  const catShare = new Map<string, number>();
  for (let i = 0; i < markets.length; i++) {
    const cat = markets[i].category ?? "other";
    catShare.set(cat, (catShare.get(cat) ?? 0) + weights[i]);
  }
  let maxCategoryShare = 0;
  for (const v of catShare.values()) {
    if (v > maxCategoryShare) maxCategoryShare = v;
  }

  return {
    nav: Math.max(0.001, Math.min(0.999, mu)),
    sigma: Math.max(0.003, sigma),
    skew,
    effLegCount,
    herfindahl,
    maxLegWeight,
    weakestLegVolumeUsd,
    meanLegVolumeUsd,
    totalLegs,
    daysLeft: Math.max(1, daysLeft),
    tier,
    maxCategoryShare,
  };
}

// ---------------------------------------------------------------------------
// Attachment points
// ---------------------------------------------------------------------------

function clamp01(x: number, floor = 0.01, ceil = 0.99): number {
  if (x < floor) return floor;
  if (x > ceil) return ceil;
  return x;
}

/**
 * Produce the three tranche slices [0..K1], [K1..K2], [K2..1] from a
 * basket's (mu, sigma). Tier-agnostic percentile placement.
 *
 * The minimum-gap enforcement needs to handle both extremes of NAV:
 *   • NAV near 1: clamp01 would pin both k1 and k2 at the 0.99 ceil,
 *     producing a zero-width mezz. We push k1 DOWN to 0.99 - MIN_GAP
 *     so mezz still has a MIN_GAP slice and junior has a [0.99, 1] slice.
 *   • NAV near 0: clamp01 pins k1 at the 0.01 floor. Pushing k2 up by
 *     MIN_GAP to 0.02 stays within the ceiling, so the simple case works.
 */
const MIN_TRANCHE_GAP = 0.01;
function attachmentPoints(stats: BasketStats): {
  k1: number;
  k2: number;
} {
  let k1 = clamp01(stats.nav + ATTACH_K1_SIGMA * stats.sigma);
  let k2 = clamp01(stats.nav + ATTACH_K2_SIGMA * stats.sigma);
  if (k2 - k1 < MIN_TRANCHE_GAP) {
    if (k1 + MIN_TRANCHE_GAP <= 0.99) {
      // Room to push k2 up (the common case for mid/low NAV).
      k2 = k1 + MIN_TRANCHE_GAP;
    } else {
      // NAV at/above the ceiling: pull k1 down instead so the junior
      // slice still sits on top of the basket outcome axis.
      k2 = 0.99;
      k1 = Math.max(0.01, k2 - MIN_TRANCHE_GAP);
    }
  }
  return { k1, k2 };
}

// ---------------------------------------------------------------------------
// Tranche call-spread math under Normal(μ, σ²)
// ---------------------------------------------------------------------------

/** Normal-call price with strike K on a payoff X ~ N(μ, σ²). */
function normalCall(mu: number, sigma: number, K: number): number {
  const z = (K - mu) / sigma;
  return sigma * stdNormalPdf(z) + (mu - K) * stdNormalSurv(z);
}

/**
 * Expected tranche payoff per unit notional (i.e. per $1 face) when
 * the basket outcome X is approximately N(μ, σ²). The tranche pays
 *   min( max(X - A, 0), D - A )
 * so its expected payoff equals call(A) - call(D), normalised by the
 * tranche width. The result is a fair price on [0, 1].
 */
function trancheFairValue(
  mu: number,
  sigma: number,
  attach: number,
  detach: number,
): number {
  const width = Math.max(1e-6, detach - attach);
  const ev = normalCall(mu, sigma, attach) - normalCall(mu, sigma, detach);
  return Math.max(0, Math.min(1, ev / width));
}

/**
 * Delta of the tranche call-spread at the current NAV. Under
 * Normal(μ, σ²) this is Φ_c(A) - Φ_c(D) normalised by the slice width:
 * it's the sensitivity of the per-$1-face fair value to μ.
 */
function trancheDelta(
  mu: number,
  sigma: number,
  attach: number,
  detach: number,
): number {
  const width = Math.max(1e-6, detach - attach);
  const survA = stdNormalSurv((attach - mu) / sigma);
  const survD = stdNormalSurv((detach - mu) / sigma);
  return (survA - survD) / width;
}

/**
 * Gamma of the tranche call-spread at the current NAV. For a
 * call-spread this is (φ((K-μ)/σ) / σ) differenced at the two strikes
 * and normalised by the slice width.
 */
function trancheGamma(
  mu: number,
  sigma: number,
  attach: number,
  detach: number,
): number {
  const width = Math.max(1e-6, detach - attach);
  const pdfA = stdNormalPdf((attach - mu) / sigma) / sigma;
  const pdfD = stdNormalPdf((detach - mu) / sigma) / sigma;
  // Curvature magnitude, always non-negative.
  return Math.abs(pdfA - pdfD) / width;
}

/**
 * Expected shortfall in the tranche's payoff conditional on the left
 * 5% tail of basket outcomes. Used to size the underwriting capital.
 * Returns a value in [0, 1] (per $1 face): 0 means the tranche pays
 * in full through the tail, 1 means full loss in the tail.
 *
 * Uses the CONDITIONAL mean E[X | X <= q05], not the quantile q05
 * itself. For a standard normal the Mills-ratio identity gives
 * E[Z | Z <= z_α] = -φ(z_α)/α. At α = 0.05, z_α = -1.6449, so
 * E[Z | Z <= -1.6449] = -φ(-1.6449)/0.05 = -2.0627. Using the quantile
 * directly (as the previous implementation did) always over-states the
 * tail payoff and under-sizes the underwriting capital — that bug has
 * been fixed here.
 */
function trancheCvar95(
  mu: number,
  sigma: number,
  attach: number,
  detach: number,
): number {
  const tailExpected = mu - 2.062713 * sigma;
  if (tailExpected <= attach) return 1; // tranche pays zero in the tail
  const width = Math.max(1e-6, detach - attach);
  const tailPayoff = Math.max(
    0,
    Math.min(1, (Math.min(detach, tailExpected) - attach) / width),
  );
  return Math.max(0, Math.min(1, 1 - tailPayoff));
}

// ---------------------------------------------------------------------------
// Fee decomposition (MM spread + underwriting)
// ---------------------------------------------------------------------------

function mmSpreadBps(
  stats: BasketStats,
  kind: TrancheKind,
  delta: number,
  gamma: number,
): TrancheFeeDecomp["mmComponents"] & { totalBps: number } {
  // Duration scale applied to the FIXED-horizon components so short
  // baskets pay proportionally less static overhead (see durationScale
  // docstring above).
  const durScale = durationScale(stats.daysLeft);

  // Base MM spread: every book charges something just to quote.
  const baseBps = 10 * durScale;

  // Delta-hedge cost: proportional to |delta|. A tranche call-spread's
  // per-$1-face delta can mathematically exceed 1 for very narrow
  // slices (delta = (Surv_A - Surv_D) / width), but economically the
  // MM can never need to hedge more than 1 unit of exposure per $1
  // notional — a 100% hedge is the hard ceiling. Clamp |Δ| to [0, 1]
  // to prevent narrow mezz slices from blowing the spread out.
  // Duration-scaled because the dealer only has to carry the hedge
  // for the basket's lifetime.
  const deltaClamped = Math.min(1, Math.abs(delta));
  const deltaHedgeBps = 60 * deltaClamped * durScale;

  // Gamma-hedge cost: proportional to gamma × σ² × sqrt(τ). Gamma for
  // a tranche call-spread under N(μ,σ²) scales as ~1/σ in narrow
  // slices, so the σ² factor collapses the σ dependence back to σ ×
  // slice-narrowness. The √τ scaling reflects the number of times the
  // book must rebalance over the basket's lifetime — so gammaHedge is
  // NOT additionally multiplied by durationScale (the √τ is already a
  // duration scaling).
  const tauYears = Math.max(1 / 365, stats.daysLeft / 365);
  const gammaHedgeBps = 200 * gamma * stats.sigma * stats.sigma * Math.sqrt(tauYears);

  // Adverse-selection: a concentrated roster of informed legs is
  // easier for a directional trader to front-run. Scale inversely
  // with sqrt(effective leg count). Duration-scaled because longer-
  // dated baskets give informed flow more time to accumulate.
  const adverseSelectionBps =
    (80 / Math.sqrt(Math.max(1, stats.effLegCount))) * durScale;

  // Liquidity penalty: kicks in when the weakest leg's lifetime volume
  // is thin. Calibrated so $10k weakest ≈ +200 bps, $100k ≈ +63 bps,
  // $1M ≈ +20 bps. Duration-scaled because the dealer only needs to
  // warehouse the thin-book risk for τ, not indefinitely.
  const liquidityPenaltyBps =
    (200 / Math.sqrt(Math.max(10_000, stats.weakestLegVolumeUsd) / 10_000)) *
    durScale;

  const kindMultiplier = MM_KIND_MULT[kind];

  const totalBps =
    kindMultiplier *
    (baseBps +
      deltaHedgeBps +
      gammaHedgeBps +
      adverseSelectionBps +
      liquidityPenaltyBps);

  return {
    baseBps,
    deltaHedgeBps,
    gammaHedgeBps,
    adverseSelectionBps,
    liquidityPenaltyBps,
    kindMultiplier,
    totalBps,
  };
}

function underwritingBps(
  stats: BasketStats,
  kind: TrancheKind,
  capitalAtRisk: number,
  cvar95: number,
): TrancheFeeDecomp["underwritingComponents"] & { totalBps: number } {
  const horizonYears = Math.max(1 / 365, stats.daysLeft / 365);
  const tailMultiplier = UW_TAIL_MULT[kind];
  // Concentration multiplier: a basket whose top category carries 60%+
  // of the weight is only nominally diversified; charge for the real
  // exposure.
  const concentrationMultiplier =
    1 + 2 * Math.max(0, stats.maxCategoryShare - 1 / 3);

  // Underwriting premium = expected-loss compensation, tail-weighted.
  //   premium_$/face = capitalAtRisk × CoC × tail_mult × conc_mult × horizon
  // where capitalAtRisk = 1 - fair = E[loss per $1 face]. This is
  // the risk-neutral expected loss under our Normal basket payoff
  // model. The kind-specific tail multiplier (senior 1.0, mezz 2.2,
  // junior 4.5) captures the convexity premium an underwriter demands
  // for deeper subordination — junior is effectively a short deep-OTM
  // put on the basket.
  //
  // Previous implementation ADDED a separate `cvar × tail_mult` term
  // on top of this, which double-counted expected-loss compensation
  // for senior tranches (CVaR was ~0.9 for LOW senior while capital-
  // at-risk was only 0.17, making the CVaR term 5× the real risk).
  const totalBps = Math.max(
    0,
    capitalAtRisk *
      UW_COST_OF_CAPITAL *
      tailMultiplier *
      concentrationMultiplier *
      horizonYears *
      10_000,
  );

  return {
    capitalAtRisk,
    horizonYears,
    costOfCapital: UW_COST_OF_CAPITAL,
    tailMultiplier,
    concentrationMultiplier,
    cvar95,
    totalBps,
  };
}

// ---------------------------------------------------------------------------
// Public quoting API
// ---------------------------------------------------------------------------

/** Build the three tranche quotes for a basket given its stats. */
export function quoteTranchesFromStats(stats: BasketStats): TrancheQuote[] {
  const { k1, k2 } = attachmentPoints(stats);
  const slices: Array<{ kind: TrancheKind; a: number; d: number }> = [
    { kind: "senior", a: 0, d: k1 },
    { kind: "mezzanine", a: k1, d: k2 },
    { kind: "junior", a: k2, d: 1 },
  ];
  return slices.map(({ kind, a, d }) => priceOneTranche(stats, kind, a, d));
}

function priceOneTranche(
  stats: BasketStats,
  kind: TrancheKind,
  attach: number,
  detach: number,
): TrancheQuote {
  const width = Math.max(1e-6, detach - attach);
  const fairPrice = trancheFairValue(stats.nav, stats.sigma, attach, detach);
  const delta = trancheDelta(stats.nav, stats.sigma, attach, detach);
  const gamma = trancheGamma(stats.nav, stats.sigma, attach, detach);
  const cvar = trancheCvar95(stats.nav, stats.sigma, attach, detach);
  const capitalAtRisk = Math.max(0, 1 - fairPrice);

  const horizonYears = Math.max(1 / 365, stats.daysLeft / 365);
  // 30-day floor when annualising APY headline numbers so short-horizon
  // products don't produce ~10,000% APYs from tiny per-period returns.
  // The discount used for pricing itself uses the true horizon — only
  // the displayed APY is floored.
  const annualizationYears = Math.max(30 / 365, horizonYears);

  // -----------------------------------------------------------------
  // Fair-anchored pricing with yield pickup.
  //
  //   ask = fair / (1 + target_apy · τ)     (floored at DISCOUNT_FLOOR × fair)
  //
  // Present-value discounting: the user pays `ask` today for an
  // expected payoff of `fair` at maturity, earning exactly
  // `target_apy` annualised regardless of horizon. The floor caps the
  // maximum effective APY on very long-dated lottery tranches.
  //
  // This replaces the old target-APY inverse pricing
  //   ask = 1 / (1 + target_apy · τ)
  // which ignored fair value entirely and produced asks 20–200× above
  // fair on OTM tranches — e.g. a LOW-tier junior with fair $0.004
  // was quoted at $0.94 with a fictional +75% APY, actually
  // guaranteeing the user a ~99.6% expected loss.
  // -----------------------------------------------------------------
  const targetApy = yieldPickupFor(kind, stats.sigma);
  const pvDiscount = 1 / (1 + targetApy * horizonYears);
  const discountMult = Math.max(DISCOUNT_FLOOR, pvDiscount);
  const rawAsk = fairPrice * discountMult;
  // Ask floor is PROPORTIONAL to fair so the `ask ≤ fair` invariant
  // holds even for microscopic-fair tranches (e.g. a junior sitting
  // ≥5σ above NAV where fair rounds to ~0). For well-behaved tranches
  // (fair ≥ 0.0005) the floor is the normal 0.0005 token-price floor.
  const askFloor = Math.min(0.0005, Math.max(0, fairPrice));
  const marketPrice = Math.max(
    askFloor,
    Math.min(0.9999, Math.max(0, rawAsk)),
  );

  const attachProbability = boundedNormalSurv(stats.nav, stats.sigma, attach);
  const fullPayProbability = boundedNormalSurv(stats.nav, stats.sigma, detach);

  // Headline APY is YIELD-TO-MATURITY at full face redemption, lightly
  // risk-adjusted by clamping against the mean-based expected return:
  //   ytm_apy  = (1 / ask − 1) / max(30 days, τ) · 100
  //   mean_apy = (fair / ask − 1) / max(30 days, τ) · 100
  //   apy      = min(ytm_apy, LOTTERY_UPSIDE_CAP · mean_apy)
  //
  // Without the cap, deep-OTM junior tranches (where P[full pay] ≈ 0)
  // quote YTMs in the tens of thousands of percent — mathematically
  // correct (that IS the return if face redemption happens) but
  // visually feral in a yield table. The multiplicative cap at 5×
  // mean keeps the display on a sensible ladder while still showing
  // meaningful lottery upside above the pure expected return.
  //
  // Because asks are fair-anchored, this is not the old engine bug:
  // the clamped APY always sits between the honest mean return and
  // the raw YTM, both of which are correct numbers. The cap is purely
  // a display compression.
  //
  // Guards: ask and fair must be above a small epsilon; if fair is
  // effectively zero we report 0% APY.
  const FAIR_EPSILON = 1e-9;
  const canQuote =
    fairPrice > FAIR_EPSILON && marketPrice > FAIR_EPSILON;
  const ytmRaw = canQuote ? 1 / marketPrice - 1 : 0;
  const expectedReturnRaw = canQuote ? fairPrice / marketPrice - 1 : 0;
  // YTM uses the 30-day floor (display smoothing on short baskets).
  const ytmApyPct = (ytmRaw / annualizationYears) * 100;
  // Mean-return used as the cap benchmark uses the TRUE horizon, so
  // short-horizon senior tranches (12-14d) can still show their
  // honest 10–15% YTM without being clamped down to a tiny mean
  // number. This is the same number exposed via `expectedReturnApyPct`.
  const meanApyTrueTau = (expectedReturnRaw / horizonYears) * 100;
  const LOTTERY_UPSIDE_CAP = 5;
  // Hard display ceiling kept in lockstep with the backend
  // (services/tranching.ts MAX_EXPECTED_YIELD_PCT) so the buy panel and the
  // composer never show divergent headline APYs.
  const MAX_EXPECTED_YIELD_PCT = 300;
  const expectedApyPct = Math.min(
    MAX_EXPECTED_YIELD_PCT,
    ytmApyPct,
    Math.max(meanApyTrueTau, LOTTERY_UPSIDE_CAP * meanApyTrueTau),
  );
  // `expectedReturnApyPct` is the MEAN-based risk-neutral expected
  // annualised return on the TRUE horizon (no 30-day floor). Shown
  // on the detail page sub-line.
  const expectedReturnApyPct = meanApyTrueTau;

  // -----------------------------------------------------------------
  // Fee decomposition (per-order fees actually deducted from USDC).
  //
  // `mmComponents` and `underwritingComponents` produce the dealer's
  // hedging cost and capital-at-risk premium from the tranche greeks,
  // liquidity, and horizon. These are the real frictions of offering
  // the tranche and we charge them on top of the fair-anchored ask so
  // the fee line items are populated honestly:
  //
  //   mmSpreadBps      = MM.totalBps   capped at MM_SPREAD_CAP_BPS
  //   underwritingBps  = UW.totalBps   capped at UW_CAP_BPS
  //
  // The caps exist because UW.totalBps in particular scales linearly
  // with `capitalAtRisk × horizon` and can balloon to 60% of notional
  // on a 1-year junior — a truthful representation of annualised
  // capital cost, but nonsensical as a single-order fee. Capping it
  // at 200 bps keeps the deduction on a realistic per-trade scale
  // while still producing tier-appropriate numbers (senior ~20 bps,
  // junior ~200 bps).
  // -----------------------------------------------------------------
  const mm = mmSpreadBps(stats, kind, delta, gamma);
  const uw = underwritingBps(stats, kind, capitalAtRisk, cvar);
  const MM_SPREAD_CAP_BPS = 300; // 3% per-order dealer spread ceiling
  const UW_CAP_BPS = 200;        // 2% per-order capital-at-risk ceiling
  const mmSpreadRealisedBps = Math.min(MM_SPREAD_CAP_BPS, Math.max(0, mm.totalBps));
  const uwRealisedBps = Math.min(UW_CAP_BPS, Math.max(0, uw.totalBps));

  const caps = capacityFor(stats, kind, width);

  return {
    kind,
    attach,
    detach,
    notionalShare: width,
    fairPrice,
    marketPrice,
    expectedApyPct,
    expectedReturnApyPct,
    attachProbability,
    fullPayProbability,
    delta,
    gamma,
    capitalAtRisk,
    cvar95: cvar,
    fees: {
      protocolBps: PROTOCOL_FEE_BPS[kind],
      mmSpreadBps: mmSpreadRealisedBps,
      underwritingBps: uwRealisedBps,
      mmComponents: {
        baseBps: mm.baseBps,
        deltaHedgeBps: mm.deltaHedgeBps,
        gammaHedgeBps: mm.gammaHedgeBps,
        adverseSelectionBps: mm.adverseSelectionBps,
        liquidityPenaltyBps: mm.liquidityPenaltyBps,
        kindMultiplier: mm.kindMultiplier,
      },
      underwritingComponents: {
        capitalAtRisk: uw.capitalAtRisk,
        horizonYears: uw.horizonYears,
        costOfCapital: uw.costOfCapital,
        tailMultiplier: uw.tailMultiplier,
        concentrationMultiplier: uw.concentrationMultiplier,
        cvar95: uw.cvar95,
      },
    },
    maxOrderUsdc: caps.hardCap,
    depthCapUsdc: caps.depthCap,
  };
}

function capacityFor(
  stats: BasketStats,
  kind: TrancheKind,
  trancheWidth: number,
): { hardCap: number; depthCap: number } {
  const kindMult: Record<TrancheKind, number> = {
    senior: 4.8,
    mezzanine: 2.8,
    junior: 1.5,
  };
  const horizonYears = Math.max(1 / 365, stats.daysLeft / 365);
  const durationPenalty = 1 / (1 + 0.42 * Math.sqrt(horizonYears));
  const concentrationPenalty = 1 / (1 + 0.75 * Math.max(0, stats.herfindahl - 0.06));
  const liquidityPenalty = 1 / Math.max(0.55, Math.sqrt(Math.max(10_000, stats.weakestLegVolumeUsd) / 28_000));
  const hardCap =
    Math.max(20_000, stats.weakestLegVolumeUsd * DEPTH_CAP_FRAC * 2.5) *
    kindMult[kind] *
    durationPenalty *
    concentrationPenalty *
    liquidityPenalty;
  // Depth cap scales with weakest-leg liquidity and the tranche's share
  // of basket notional. A wider slice (bigger trancheWidth) can absorb
  // more USDC before the underlying legs feel it.
  const depthCap = Math.max(
    stats.weakestLegVolumeUsd * DEPTH_CAP_FRAC * Math.max(0.10, trancheWidth * 1.35),
    stats.meanLegVolumeUsd * DEPTH_CAP_FRAC * 0.65,
  );
  return { hardCap, depthCap };
}

/**
 * Price a single order against a tranche quote. Returns an OrderQuote
 * decomposing the tokens-out, protocol fee, MM spread, underwriting
 * premium, and slippage, plus the binding capacity.
 *
 * `basketSlippageBps` is the weighted CLOB-walk slippage the caller
 * ALREADY computed against the tranche's actual hedge notional
 * (usdcAmount × notionalShare). This function only adds the kind-
 * specific hedge-difficulty multiplier on top — junior hedges are
 * harder to unwind so the MM passes more of the cost through.
 */
export function quoteTrancheOrder(
  quote: TrancheQuote,
  usdcAmount: number,
  basketSlippageBps: number,
  ctx?: {
    stats?: BasketStats;
    hedgeability?: BasketHedgeability;
  },
): OrderQuote {
  // Protocol fee inherits the same duration scaling as the static
  // MM components so a 12-day basket doesn't pay the same absolute
  // bps as a 330-day one. The `durationScale` floor (30%) keeps a
  // nominal take on ultra-short legs.
  const durScale = ctx?.stats
    ? durationScale(ctx.stats.daysLeft)
    : 1;
  const protocolFeeBps = PROTOCOL_FEE_BPS[quote.kind] * durScale;
  // Fixed MM premium by tranche risk profile. Kept mostly stable so
  // users are not front-loaded with a giant "slippage" number at
  // small tickets; liquidity/duration apply only mild scaling.
  const FIXED_MM_PREMIUM_BPS: Record<TrancheKind, number> = {
    senior: 25,
    mezzanine: 45,
    junior: 100,
  };
  const liqScale = ctx?.hedgeability
    ? Math.max(
        0.9,
        Math.min(
          1.35,
          Math.sqrt(
            500 / Math.max(120, ctx.hedgeability.avgBookSpreadBps),
          ),
        ),
      )
    : 1;
  const mmSpreadBps = FIXED_MM_PREMIUM_BPS[quote.kind] * durScale * liqScale;

  // Static underwriting component from quote-level tranche risk.
  const baseUnderwritingBps = quote.fees.underwritingBps;

  const hedgeDifficulty: Record<TrancheKind, number> = {
    senior: 1.0,
    mezzanine: 0.92,
    junior: 0.9,
  };
  const scaledSlippageBps = Math.max(
    0,
    basketSlippageBps * hedgeDifficulty[quote.kind],
  );

  // -----------------------------------------------------------------
  // Size-dependent risk (trading-desk style).
  //
  // When the caller provides live hedgeability data, we add on top of
  // the static MM spread:
  //   • marketImpact  — CLOB-walk cost, sqrt(size/depth)
  //   • warehouse     — cost of the unhedgeable tail the desk carries
  //   • inventory     — residual vega/theta on a fully-hedged position
  //   • concentration — penalty for sparse baskets
  //
  // The market-impact and slippage pieces are semantically overlapping
  // (both reflect CLOB-walk cost), but they're computed from different
  // inputs: `basketSlippageBps` comes from an actual CLOB walk on the
  // tranche's hedge notional, whereas `marketImpactBps` is a
  // Kyle-lambda model on the BASKET's hedge capacity. We use the MAX
  // of the two so whichever is more conservative binds; this avoids
  // double-charging and also avoids free size on baskets with no live
  // books.
  // -----------------------------------------------------------------

  // -----------------------------------------------------------------
  // Hedge notional for CONVEX tranche claims.
  //
  // The previous model used `usdcAmount × notionalShare`, treating a
  // tranche like a linear slice of basket NAV. That is correct only
  // for senior slices where delta ≈ 1 and the desk can fully replicate
  // the payoff with a delta-one basket hedge. For mezzanine and junior
  // slices the ask price is a call-spread premium — pennies per token
  // — and each user dollar buys `1 / ask` tokens of face. A $100k
  // junior clip at a $0.056 ask creates ~1.8M tokens, i.e. $1.7M of
  // max face obligation (~17× the received premium). None of that
  // tail leverage was reflected in the old `hedgeNotional` — the desk
  // was effectively short a lottery without any UW charge.
  //
  // New decomposition:
  //   tokensOutPreFee = usdcAmount / marketPrice
  //   faceObligation  = tokensOutPreFee × 1            (max payout at detach)
  //   hedgeNotional   = tokensOut × NAV × |delta|_clamped
  //                     (dollars of basket exposure for a delta-one hedge)
  //   tailExposure    = tokensOut × capitalAtRisk
  //                     (dollars of residual convex obligation the desk
  //                      must warehouse because gamma can't be hedged
  //                      linearly)
  // -----------------------------------------------------------------
  const tokensOutPreFee =
    usdcAmount / Math.max(0.0001, quote.marketPrice);
  const navForHedge = ctx?.stats
    ? Math.max(0, Math.min(1, ctx.stats.nav))
    : 1;
  const deltaClamped = Math.min(
    1,
    Math.max(0, Math.abs(quote.delta)),
  );
  const hedgeNotional = tokensOutPreFee * navForHedge * deltaClamped;
  const tailExposureUsdc = tokensOutPreFee * quote.capitalAtRisk;

  let risk: OrderRisk | undefined;
  let mmSizeComponentBps = 0;
  let warehouseBps = 0;
  let inventoryBps = 0;
  let concentrationBps = 0;
  let warehouseFraction = 0;
  let quadraticLiquidityBps = 0;
  const horizonYearsModel = ctx?.stats
    ? Math.max(1 / 365, ctx.stats.daysLeft / 365)
    : 0.25;
  const profileStressModel = ctx?.stats
    ? PROFILE_STRESS_MULT[ctx.stats.tier]
    : 1;
  const sigmaStressModel = ctx?.stats
    ? Math.max(0.7, Math.min(1.8, 0.6 + 12 * Math.max(0, ctx.stats.sigma)))
    : 1;
  if (ctx?.stats && ctx.hedgeability) {
    risk = computeOrderRisk(
      ctx.stats,
      quote.kind,
      ctx.hedgeability,
      hedgeNotional,
      quote.capitalAtRisk,
    );
    // MarketImpact vs explicit slippage: take the max, not sum.
    mmSizeComponentBps = Math.max(
      0,
      risk.marketImpactBps - scaledSlippageBps,
    );
    warehouseBps = risk.warehouseBps;
    inventoryBps = risk.inventoryBps;
    concentrationBps = risk.concentrationBps;
    warehouseFraction = risk.warehouseFraction;
    const profileStress = profileStressModel;
    const horizonYearsStress = horizonYearsModel;
    const sizeRatio = hedgeNotional / Math.max(1, ctx.hedgeability.hedgeCapacityUsdc);
    // Liquidity curve: quadratic core with an early-ramp term so
    // small/medium tickets move by visible bps (not flat), while still
    // saturating smoothly at stressed size.
    const liquidityQuadratic = Math.max(0, sizeRatio * sizeRatio);
    const liquidityRamp = Math.max(0, 0.55 * sizeRatio + 1.75 * liquidityQuadratic);
    const riskCore =
      (0.35 + quote.capitalAtRisk) *
      profileStress *
      sigmaStressModel *
      Math.sqrt(horizonYearsStress);
    const liquidityCapBps = 180 + 300 * riskCore;
    quadraticLiquidityBps =
      liquidityCapBps * (1 - Math.exp(-2.6 * liquidityRamp));
  }

  // -----------------------------------------------------------------
  // Tranche tail-risk premium.
  //
  // Charges the desk's carrying cost on the residual convex (gamma)
  // obligation that can't be laid off via linear hedging. Expressed
  // as bps of the USDC notional:
  //
  //   tailPremiumBps
  //     = (tokensOut × capitalAtRisk / usdcAmount)    ← face leverage ratio
  //     × UW_COST_OF_CAPITAL
  //     × tauYears
  //     × TAIL_PREMIUM_MULT[kind]
  //     × 10_000
  //
  // The face-leverage ratio is `capitalAtRisk / marketPrice` which
  // equals ~17 for our flagship HIGH junior (ask $0.056, fair $0.057,
  // capitalAtRisk 0.944), ~2.2 for mezz, and ~0.01 for senior — i.e.
  // junior is structurally short ~17× more tail than senior per
  // USDC dollar, exactly the leverage the old linear-notional model
  // was missing.
  //
  // Senior multiplier is 0 because senior delta ≈ 1 and its tail is
  // already priced into the static UW premium (capitalAtRisk is tiny).
  // Junior and mezz pick up a meaningful premium that the user pays
  // through the fee breakdown rather than the protocol warehousing
  // silently.
  // -----------------------------------------------------------------
  const TAIL_PREMIUM_MULT: Record<TrancheKind, number> = {
    senior: 0.0,
    mezzanine: 0.12,
    junior: 0.24,
  };
  const tauYearsTail = ctx?.stats
    ? Math.max(1 / 365, ctx.stats.daysLeft / 365)
    : 0.25;
  const tailPremiumBps =
    (tailExposureUsdc / Math.max(1, usdcAmount)) *
    UW_COST_OF_CAPITAL *
    Math.sqrt(tauYearsTail) *
    TAIL_PREMIUM_MULT[quote.kind] *
    10_000;

  // Combined MM spread: base static component + size-dependent impact
  // + inventory + concentration. Capped so ridiculous orders still
  // produce a finite number (the position cap below is what actually
  // blocks oversize orders — the cap here is just a display ceiling).
  const dynamicDealerRiskBps =
    mmSizeComponentBps +
    inventoryBps +
    concentrationBps +
    quadraticLiquidityBps;

  // Warehouse + tail premia stack on top of the static underwriting
  // bps. Per-kind hard caps let convex tranches surface a realistic
  // tail charge (senior stays tight since TAIL_PREMIUM_MULT = 0).
  const liquidityRatioForUw = ctx?.hedgeability
    ? hedgeNotional / Math.max(1, ctx.hedgeability.hedgeCapacityUsdc)
    : 0;
  const underwritingBps =
    (() => {
      const uwQuadratic = Math.max(0, liquidityRatioForUw * liquidityRatioForUw);
      const uwRamp = Math.max(0, 0.45 * liquidityRatioForUw + 1.55 * uwQuadratic);
      const uwCapBps =
        baseUnderwritingBps +
        140 +
        420 *
          quote.capitalAtRisk *
          profileStressModel *
          Math.sqrt(horizonYearsModel);
      const uwScaled =
        baseUnderwritingBps +
        (uwCapBps - baseUnderwritingBps) * (1 - Math.exp(-2.2 * uwRamp));
      return uwScaled + warehouseBps + tailPremiumBps;
    })();

  // All four fee components are deducted from the USDC notional before
  // computing tokens-out, so the displayed breakdown (protocol + MM +
  // UW + slippage) sums to the actual cost the user bears. Total fees
  // are clamped to 90% so we never produce a negative fill.
  // Slippage is now the dynamic bucket: live CLOB walk + dealer risk
  // carry + underwriting/tail-risk. MM premium stays as a separate,
  // mostly-fixed line item by tranche kind.
  const slippageBps = scaledSlippageBps + dynamicDealerRiskBps + underwritingBps;
  const rawFeeFraction =
    (protocolFeeBps + mmSpreadBps + slippageBps) / 10_000;
  const clampedFeeFraction = Math.min(0.9, Math.max(0, rawFeeFraction));
  const netUsdcForFill = usdcAmount * (1 - clampedFeeFraction);
  const tokensOut = Math.max(
    0,
    netUsdcForFill / Math.max(0.0001, quote.marketPrice),
  );

  const totalFeeBps = protocolFeeBps + mmSpreadBps + slippageBps;

  // -----------------------------------------------------------------
  // Position cap — now driven by FACE OBLIGATION, not notional share.
  //
  // The prior cap divided the desk's hedge budget by `notionalShare`
  // to convert an MM-side exposure into a USDC-side clip. That math
  // assumes a tranche is a linear claim on basket NAV; for convex
  // slices it grossly over-allocates junior/mezz (e.g. $5M+ of
  // permissible USDC input on a $50k hedge book because each user
  // dollar looks like only 3% of hedge pressure — ignoring that it
  // also creates 18× face leverage).
  //
  // New model: the desk can warehouse at most `FACE_BUDGET[kind] ×
  // hedgeCapacity` of face obligation across this tranche. Since
  // each user dollar buys `1 / marketPrice` tokens of face, that
  // face budget translates to a user USDC cap of:
  //
  //   maxUsdc = hedgeCapacity × FACE_BUDGET[kind] × marketPrice
  //
  // For our flagship HIGH junior (marketPrice $0.056, hedgeCap
  // $500k, FACE_BUDGET 0.75) this yields a ~$21k cap instead of the
  // old ~$5M. Senior with high marketPrice and FACE_BUDGET 3.0
  // retains a multi-hundred-k cap, matching its near-linear hedge.
  //
  // We keep
  // the old delta-hedge-based cap as a secondary ceiling so orders
  // that would violate the linear MM hedge budget still get blocked.
  // -----------------------------------------------------------------
  const FACE_BUDGET_MULT: Record<TrancheKind, number> = {
    senior: 3.0,
    mezzanine: 1.6,
    junior: 0.75,
  };
  let capacityUsdc: number;
  if (ctx?.stats && ctx.hedgeability) {
    const cap = computeMaxPositionUsdc(
      ctx.stats,
      quote.kind,
      ctx.hedgeability,
    );
    const maxFaceObligationUsdc =
      ctx.hedgeability.hedgeCapacityUsdc * FACE_BUDGET_MULT[quote.kind];
    const faceCapUsdc = maxFaceObligationUsdc * quote.marketPrice;
    // Retain the delta-hedge capacity as a secondary ceiling — a
    // wide senior slice on a tiny book shouldn't exceed the linear
    // hedge depth even if its face is cheap.
    const deltaHedgeCapUsdc =
      cap.maxOrderUsdc / Math.max(0.01, quote.notionalShare);
    capacityUsdc = Math.min(faceCapUsdc, deltaHedgeCapUsdc);
  } else {
    capacityUsdc = Math.min(quote.maxOrderUsdc, quote.depthCapUsdc);
  }
  const overCapacity = usdcAmount > capacityUsdc;

  return {
    tokensOut,
    protocolFeeBps,
    mmSpreadBps,
    slippageBps,
    totalFeeBps,
    capacityUsdc,
    overCapacity,
    risk,
    warehouseFraction,
  };
}

// ---------------------------------------------------------------------------
// Outcome distribution helpers (for the density chart)
// ---------------------------------------------------------------------------

