import { Leg, Bundle, NAVResult, LegNAVContribution } from '../types';

/**
 * Calculate a single leg's contribution to NAV.
 * - Active: weight * probability
 * - Won (resolved YES): weight * 1.0
 * - Lost (resolved NO): weight * 0.0
 */
function legContribution(leg: Leg): number {
  switch (leg.status) {
    case 'won':
      return leg.weight * 1.0;
    case 'lost':
      return leg.weight * 0.0;
    case 'active':
    default:
      return leg.weight * leg.probability;
  }
}

/**
 * Calculate NAV (Net Asset Value) for a bundle given its legs.
 * NAV = sum of weighted leg contributions, clamped to [0, 1].
 */
export function calculateNAV(legs: Leg[], bundleId: string = ''): NAVResult {
  const legContributions: LegNAVContribution[] = legs.map((leg) => {
    const contribution = legContribution(leg);
    return {
      leg_id: leg.id,
      question: leg.question,
      status: leg.status,
      probability: leg.probability,
      weight: leg.weight,
      contribution,
    };
  });

  const rawNav = legContributions.reduce((sum, lc) => sum + lc.contribution, 0);
  const nav = Math.max(0, Math.min(1, rawNav));

  return {
    bundle_id: bundleId || (legs.length > 0 ? legs[0].bundle_id : ''),
    nav,
    legs: legContributions,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Calculate issue price: weighted average of leg probabilities,
 * rounded DOWN to the nearest clean cent.
 * Max 0.5 cents below fair value (i.e. floor to cent, but never more than $0.005 discount).
 */
export function calculateIssuePrice(legs: Leg[]): number {
  if (legs.length === 0) return 0;

  const fairValue = legs.reduce((sum, leg) => sum + leg.weight * leg.probability, 0);

  // Floor to nearest cent
  const floored = Math.floor(fairValue * 100) / 100;

  // Ensure max 0.5 cents below fair value
  const maxDiscount = 0.005;
  const issuePrice = Math.max(floored, fairValue - maxDiscount);

  // Round to 2 decimal places (cents)
  return Math.floor(issuePrice * 100) / 100;
}

/**
 * Calculate USDC payout when all legs are resolved.
 * Payout = tokensHeld * finalNAV (where finalNAV at resolution = actual outcome).
 * Returns 0 if bundle is not fully resolved.
 */
export function calculatePayout(bundle: Bundle, legs: Leg[], tokensHeld: number): number {
  if (!isFullyResolved(legs)) return 0;

  const navResult = calculateNAV(legs, bundle.id);
  const payout = tokensHeld * navResult.nav;

  // Round to 6 decimal places (USDC precision)
  return Math.round(payout * 1_000_000) / 1_000_000;
}

/**
 * Format NAV as a dollar string "$0.XX"
 */
export function formatNAVDisplay(nav: number): string {
  return `$${nav.toFixed(2)}`;
}

/**
 * Check if all legs in a bundle are resolved (won or lost).
 */
export function isFullyResolved(legs: Leg[]): boolean {
  if (legs.length === 0) return false;
  return legs.every((leg) => leg.status === 'won' || leg.status === 'lost');
}
