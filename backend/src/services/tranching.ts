/**
 * Backend tranche pricing service.
 *
 * Mirror of the frontend canonical pricing module in
 * `app/app/tranche/_quote.ts`. Both sides must agree on fair value, MM
 * spread, and underwriting premium so the AI portfolio composer (which
 * cites tranche APYs back to the LLM) and the user-facing buy panel
 * never disagree. When the model changes, keep this file in lockstep
 * with the frontend.
 */

export type TrancheKind = "senior" | "mezzanine" | "junior";

export interface TrancheSpec {
  kind: TrancheKind;
  attach: number;
  detach: number;
}

export interface TrancheQuote {
  kind: TrancheKind;
  attach: number;
  detach: number;
  /** Issue / ask price as a fraction of $1 face. */
  pricePerToken: number;
  /** Risk-neutral expected payoff per $1 face. */
  fairPrice: number;
  /** Annualised simple return at fair payout (percent). */
  expectedYieldPct: number;
  attachProbability: number;
  fullPayProbability: number;
  /** Always $1 per token. Kept for compat with the old API. */
  faceValue: number;
  /** Same as expectedYieldPct; kept so existing callers still compile. */
  recommendedApr: number;
  mmSpreadBps: number;
  underwritingBps: number;
  protocolFeeBps: number;
  delta: number;
  gamma: number;
  capitalAtRisk: number;
  cvar95: number;
  maxOrderUsdc: number;
}

// ---------------------------------------------------------------------------
// Hyperparameters (must match the frontend module exactly)
// ---------------------------------------------------------------------------

// Percentile-based attach: K1 = μ (median), K2 = μ + σ (~84th pct).
// Tier-agnostic — matches frontend `_quote.ts`.
const ATTACH_K1_SIGMA = 0.0;
const ATTACH_K2_SIGMA = 1.0;

const MM_KIND_MULT: Record<TrancheKind, number> = {
  senior: 1.0,
  mezzanine: 1.18,
  junior: 1.35,
};

const UW_TAIL_MULT: Record<TrancheKind, number> = {
  senior: 1.0,
  mezzanine: 2.2,
  junior: 4.5,
};

const UW_COST_OF_CAPITAL = 0.15;

/**
 * Target annualised APY per tranche kind, linear in basket σ. Used
 * for inverse pricing so the displayed yield lands in DeFi-intuitive
 * ranges. Must match the frontend `_quote.ts` constants exactly.
 */
const TARGET_APY_BASE: Record<TrancheKind, number> = {
  senior: 0.04,
  mezzanine: 0.15,
  junior: 0.40,
};
const TARGET_APY_SIGMA_SLOPE: Record<TrancheKind, number> = {
  senior: 0.5,
  mezzanine: 3.0,
  junior: 8.0,
};
const TARGET_APY_MAX: Record<TrancheKind, number> = {
  senior: 0.12,
  mezzanine: 0.50,
  junior: 1.20,
};

function targetApyFor(kind: TrancheKind, sigma: number): number {
  const raw =
    TARGET_APY_BASE[kind] + TARGET_APY_SIGMA_SLOPE[kind] * Math.max(0, sigma);
  return Math.max(
    TARGET_APY_BASE[kind],
    Math.min(TARGET_APY_MAX[kind], raw),
  );
}

const PROTOCOL_FEE_BPS: Record<TrancheKind, number> = {
  senior: 25,
  mezzanine: 35,
  junior: 50,
};

const DISCOUNT_FLOOR = 0.15;
/** Display ceiling for annualised tranche yield. Deep-junior lottery tranches
 *  can still imply very high APYs, but we clamp to a believable ceiling so the
 *  UI never advertises absurd 3-5 digit figures. */
const MAX_EXPECTED_YIELD_PCT = 300;
const DURATION_REF_DAYS = 90;
const DURATION_SCALE_FLOOR = 0.30;

function durationScale(daysLeft: number): number {
  const d = Math.max(1, daysLeft);
  return Math.max(
    DURATION_SCALE_FLOOR,
    Math.min(1, Math.sqrt(d / DURATION_REF_DAYS)),
  );
}

// ---------------------------------------------------------------------------
// Standard normal helpers
// ---------------------------------------------------------------------------

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function stdNormalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

function stdNormalCdf(z: number): number {
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

function normalCall(mu: number, sigma: number, K: number): number {
  const z = (K - mu) / sigma;
  return sigma * stdNormalPdf(z) + (mu - K) * stdNormalSurv(z);
}

function clamp01(x: number, floor = 0.01, ceil = 0.99): number {
  if (x < floor) return floor;
  if (x > ceil) return ceil;
  return x;
}

function tierFromNav(nav: number): 90 | 70 | 50 {
  if (nav >= 0.7) return 90;
  if (nav >= 0.25) return 70;
  return 50;
}

function dynamicOrderCapUsdc(
  kind: TrancheKind,
  tier: 90 | 70 | 50,
  weakestLegVolumeUsd: number,
  horizonDays: number,
  herfindahl: number,
): number {
  const profileRiskMult: Record<90 | 70 | 50, number> = {
    90: 0.9,  // ~95 confidence
    70: 1.15, // ~50 confidence
    50: 1.4,  // ~5 confidence
  };
  const kindMult: Record<TrancheKind, number> = {
    senior: 4.8,
    mezzanine: 2.8,
    junior: 1.5,
  };
  const horizonYears = Math.max(1 / 365, horizonDays / 365);
  const durationPenalty = 1 / (1 + 0.42 * Math.sqrt(horizonYears));
  const concentrationPenalty = 1 / (1 + 0.75 * Math.max(0, herfindahl - 0.06));
  const liquidityPenalty =
    1 / Math.max(0.55, Math.sqrt(Math.max(10_000, weakestLegVolumeUsd) / 28_000));
  const baseDepth = Math.max(20_000, weakestLegVolumeUsd * 0.125);
  return (
    baseDepth *
    kindMult[kind] *
    durationPenalty *
    concentrationPenalty *
    liquidityPenalty /
    profileRiskMult[tier]
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface QuoteTranchesInputs {
  bundleNav: number;
  totalLegs: number;
  horizonDays: number;
  /** Optional; inferred from NAV band when omitted. */
  tier?: 90 | 70 | 50;
  /** Optional explicit basket σ. Defaults to sqrt(p(1-p)/N). */
  sigma?: number;
  /** Weakest-leg lifetime volume (USD). Defaults to $50k. */
  weakestLegVolumeUsd?: number;
  /** Herfindahl-effective leg count. Defaults to totalLegs. */
  effLegCount?: number;
  /** Legacy knob: custom tranche specs. Ignored — attachment points
   *  are now derived from (tier, σ). Kept so legacy callers compile. */
  tranches?: TrancheSpec[];
}

/**
 * σ of a basket's NAV from its REAL per-leg live probabilities:
 *   NAV = Σ wᵢ·pᵢ  ⇒  Var(NAV) = Σ wᵢ²·pᵢ(1−pᵢ)  (independent binaries),
 *   so σ = √(Σ wᵢ²·pᵢ(1−pᵢ)) over the still-active legs (resolved legs add no
 *   variance). This generalizes the √(p(1−p)/N) approximation — which assumes
 *   every leg equals the NAV — to the actual heterogeneous live odds, so tranche
 *   fair value / APY / Greeks price off real per-leg risk. Returns null when no
 *   usable leg probabilities are available (caller keeps the binomial default).
 */
export function basketSigmaFromLegs(
  legs: Array<{ probability: number; weight: number; status?: string }>,
): number | null {
  if (!Array.isArray(legs) || legs.length === 0) return null;
  const totalW = legs.reduce((s, l) => s + (Number(l.weight) || 0), 0) || 0;
  if (totalW <= 0) return null;
  let v = 0;
  let counted = 0;
  for (const l of legs) {
    if (l.status && l.status !== 'active') continue; // resolved legs add no variance
    const p = Math.min(0.999, Math.max(0.001, Number(l.probability)));
    if (!Number.isFinite(p)) continue;
    const w = (Number(l.weight) || 0) / totalW;
    v += w * w * p * (1 - p);
    counted++;
  }
  if (counted === 0) return null;
  return Math.sqrt(Math.max(v, 1e-9));
}

export function quoteTranches(opts: QuoteTranchesInputs): TrancheQuote[] {
  const nav = Math.max(0.001, Math.min(0.999, opts.bundleNav));
  const totalLegs = Math.max(1, opts.totalLegs);
  const horizonDays = Math.max(1, opts.horizonDays);
  const tier = opts.tier ?? tierFromNav(nav);
  const sigma =
    opts.sigma && opts.sigma > 0
      ? Math.max(0.003, opts.sigma)
      : Math.max(0.005, Math.sqrt((nav * (1 - nav)) / totalLegs));
  const weakestLegVolumeUsd = Math.max(
    10_000,
    opts.weakestLegVolumeUsd ?? 50_000,
  );
  const effLegCount = Math.max(1, opts.effLegCount ?? totalLegs);
  const herfindahl = 1 / effLegCount;
  const horizonYears = Math.max(1 / 365, horizonDays / 365);
  const durScale = durationScale(horizonDays);

  const k1 = clamp01(nav + ATTACH_K1_SIGMA * sigma);
  let k2 = clamp01(nav + ATTACH_K2_SIGMA * sigma);
  if (k2 <= k1 + 0.01) k2 = clamp01(k1 + 0.01);

  const slices: Array<{ kind: TrancheKind; a: number; d: number }> = [
    { kind: "senior", a: 0, d: k1 },
    { kind: "mezzanine", a: k1, d: k2 },
    { kind: "junior", a: k2, d: 1 },
  ];

  return slices.map(({ kind, a, d }) => {
    const width = Math.max(1e-6, d - a);
    const callA = normalCall(nav, sigma, a);
    const callD = normalCall(nav, sigma, d);
    const fair = Math.max(0, Math.min(1, (callA - callD) / width));

    const survA = stdNormalSurv((a - nav) / sigma);
    const survD = stdNormalSurv((d - nav) / sigma);
    const delta = (survA - survD) / width;

    const pdfA = stdNormalPdf((a - nav) / sigma) / sigma;
    const pdfD = stdNormalPdf((d - nav) / sigma) / sigma;
    const gamma = Math.abs(pdfA - pdfD) / width;

    // CVaR_95: expected shortfall in tranche payoff when basket lands
    // in its left 5% tail. Uses the Mills-ratio conditional mean
    // E[Z | Z <= z_0.05] = -2.0627 instead of the quantile q05 itself
    // — the quantile over-states payoff in the tail and under-sizes
    // underwriting capital.
    const tailExpected = nav - 2.062713 * sigma;
    let cvar95 = 0;
    if (tailExpected <= a) {
      cvar95 = 1;
    } else {
      const tailPayoff = Math.max(
        0,
        Math.min(1, (Math.min(d, tailExpected) - a) / width),
      );
      cvar95 = Math.max(0, Math.min(1, 1 - tailPayoff));
    }

    const capitalAtRisk = Math.max(0, 1 - fair);

    // MM spread decomposition — identical to frontend.
    const baseBps = 10 * durScale;
    // Clamp |Δ| to [0, 1]: economically the MM never hedges more than
    // 1 unit of exposure per $1 notional, even if the raw per-$1-face
    // delta of a narrow slice is mathematically larger.
    const deltaClamped = Math.min(1, Math.abs(delta));
    const deltaHedgeBps = 60 * deltaClamped * durScale;
    const gammaHedgeBps =
      200 * gamma * sigma * sigma * Math.sqrt(horizonYears);
    const adverseSelectionBps = (80 / Math.sqrt(effLegCount)) * durScale;
    const liquidityPenaltyBps =
      (200 / Math.sqrt(weakestLegVolumeUsd / 10_000)) * durScale;
    const mmSpreadRawBps =
      MM_KIND_MULT[kind] *
      (baseBps +
        deltaHedgeBps +
        gammaHedgeBps +
        adverseSelectionBps +
        liquidityPenaltyBps);

    // Underwriting premium = capitalAtRisk × CoC × tail_mult × horizon.
    // capitalAtRisk = 1 - fair = E[loss per $1 face]; the tail mult
    // (senior 1.0, mezz 2.2, junior 4.5) captures the subordination
    // convexity premium. Matches the frontend model; see
    // app/app/tranche/_quote.ts for full derivation.
    const underwritingRawBps = Math.max(
      0,
      capitalAtRisk *
        UW_COST_OF_CAPITAL *
        UW_TAIL_MULT[kind] *
        horizonYears *
        10_000,
    );
    const mmSpreadBps = Math.min(300, Math.max(0, mmSpreadRawBps));
    const underwritingBps = Math.min(200, Math.max(0, underwritingRawBps));

    // Fair-anchored discounting: ask = fair / (1 + targetApy * tau).
    const annualizationYears = Math.max(30 / 365, horizonYears);
    const targetApy = targetApyFor(kind, sigma);
    const pvDiscount = 1 / (1 + targetApy * horizonYears);
    const discountMult = Math.max(DISCOUNT_FLOOR, pvDiscount);
    const rawAsk = fair * discountMult;
    const askFloor = Math.min(0.0005, Math.max(0, fair));
    const pricePerToken = Math.max(
      askFloor,
      Math.min(0.9999, Math.max(0, rawAsk)),
    );

    // Yield-to-maturity at face (with 30-day annualisation floor), clamped to a
    // sane display ceiling — a deep-junior price annualised over a short horizon
    // can otherwise produce nonsensical 5-digit APYs.
    const periodReturn = 1 / pricePerToken - 1;
    const expectedYieldPct = Math.min(
      MAX_EXPECTED_YIELD_PCT,
      Math.max(0, (periodReturn / annualizationYears) * 100),
    );

    const maxOrderUsdc = dynamicOrderCapUsdc(
      kind,
      tier,
      weakestLegVolumeUsd,
      horizonDays,
      herfindahl,
    );

    return {
      kind,
      attach: +a.toFixed(4),
      detach: +d.toFixed(4),
      pricePerToken: +pricePerToken.toFixed(4),
      fairPrice: +fair.toFixed(4),
      expectedYieldPct: +expectedYieldPct.toFixed(2),
      attachProbability: +boundedNormalSurv(nav, sigma, a).toFixed(4),
      fullPayProbability: +boundedNormalSurv(nav, sigma, d).toFixed(4),
      faceValue: 1,
      recommendedApr: +expectedYieldPct.toFixed(2),
      mmSpreadBps: +mmSpreadBps.toFixed(1),
      underwritingBps: +underwritingBps.toFixed(1),
      protocolFeeBps: +(PROTOCOL_FEE_BPS[kind] * durScale).toFixed(1),
      delta: +delta.toFixed(4),
      gamma: +gamma.toFixed(4),
      capitalAtRisk: +capitalAtRisk.toFixed(4),
      cvar95: +cvar95.toFixed(4),
      maxOrderUsdc,
    };
  });
}
