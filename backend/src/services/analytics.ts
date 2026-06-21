/**
 * Bundle diversification analytics. Exports analyzeDiversification, which
 * scores a bundle's legs (HHI weight concentration, probability dispersion,
 * expected/std-dev NAV, best/worst scenarios, and per-leg risk contribution)
 * into a 0-100 diversification score.
 */
import { Leg } from '../types';

/**
 * Analyze the diversification quality of a bundle's legs.
 * Higher diversification = better risk distribution.
 */

export interface DiversificationAnalysis {
  // Overall diversification score 0-100
  diversification_score: number;

  // Herfindahl-Hirschman Index of weights (0-1, lower = more diversified)
  weight_concentration: number;

  // How spread out the probabilities are (higher = more diverse outcomes)
  probability_dispersion: number;

  // Expected value and standard deviation
  expected_nav: number;
  nav_std_dev: number;

  // Scenario analysis
  scenarios: {
    best_case: number;   // NAV if all active legs win
    worst_case: number;  // NAV if all active legs lose
    expected: number;    // Current weighted NAV
    upside: number;      // best_case - expected (potential gain)
    downside: number;    // expected - worst_case (potential loss)
  };

  // Per-leg risk contribution
  leg_risk: {
    leg_id: string;
    question: string;
    weight: number;
    probability: number;
    risk_contribution: number;  // How much this leg contributes to overall risk
    marginal_impact: number;    // NAV impact if this leg loses
  }[];
}

/**
 * Calculate the Herfindahl-Hirschman Index of weights.
 * HHI = sum of squared weights. Range [1/n, 1].
 * Lower = more evenly distributed weights.
 */
function calculateHHI(weights: number[]): number {
  return weights.reduce((sum, w) => sum + w * w, 0);
}

/**
 * Calculate the coefficient of variation of probabilities.
 * Higher = more diverse probability outcomes.
 */
function probabilityDispersion(probs: number[]): number {
  if (probs.length === 0) return 0;
  const mean = probs.reduce((s, p) => s + p, 0) / probs.length;
  if (mean === 0) return 0;
  const variance = probs.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / probs.length;
  return Math.sqrt(variance) / mean; // coefficient of variation
}

export function analyzeDiversification(legs: Leg[]): DiversificationAnalysis {
  const activeLegs = legs.filter(l => l.status === 'active');
  const wonLegs = legs.filter(l => l.status === 'won');

  // Weights and probabilities
  const weights = legs.map(l => l.weight);
  const activeProbs = activeLegs.map(l => l.probability);

  // HHI of weights
  const hhi = calculateHHI(weights);

  // Probability dispersion (only active legs)
  const dispersion = probabilityDispersion(activeProbs);

  // Expected NAV (current)
  const expectedNav = legs.reduce((sum, l) => {
    if (l.status === 'won') return sum + l.weight * 1.0;
    if (l.status === 'lost') return sum + l.weight * 0.0;
    return sum + l.weight * l.probability;
  }, 0);

  // NAV standard deviation (based on each leg being a Bernoulli variable)
  // Var(NAV) = sum(w_i^2 * p_i * (1 - p_i)) for active legs
  const navVariance = activeLegs.reduce((sum, l) => {
    return sum + l.weight * l.weight * l.probability * (1 - l.probability);
  }, 0);
  const navStdDev = Math.sqrt(navVariance);

  // Resolved legs contribution (fixed)
  const resolvedNav = wonLegs.reduce((s, l) => s + l.weight, 0);

  // Scenario analysis
  const bestCase = resolvedNav + activeLegs.reduce((s, l) => s + l.weight * 1.0, 0);
  const worstCase = resolvedNav + 0; // all active legs lose

  // Per-leg risk contribution
  const legRisk = legs.map(l => {
    const marginalImpact = l.status === 'active'
      ? l.weight * l.probability  // losing this leg removes this much NAV
      : 0;

    // Risk contribution: weight^2 * p * (1-p) / total variance
    const legVariance = l.status === 'active'
      ? l.weight * l.weight * l.probability * (1 - l.probability)
      : 0;
    const riskContribution = navVariance > 0 ? legVariance / navVariance : 0;

    return {
      leg_id: l.id,
      question: l.question,
      weight: l.weight,
      probability: l.probability,
      risk_contribution: Math.round(riskContribution * 10000) / 10000,
      marginal_impact: Math.round(marginalImpact * 10000) / 10000,
    };
  });

  // Diversification score (0-100):
  // Factors: equal weights (low HHI), many legs, diverse probabilities, low concentration
  const numLegsScore = Math.min(1, legs.length / 10); // max at 10+ legs
  const hhiScore = 1 - hhi; // lower HHI = better
  const dispersionScore = Math.min(1, dispersion * 2); // some dispersion is good

  const diversificationScore = Math.round(
    (numLegsScore * 30 + hhiScore * 40 + dispersionScore * 30)
  );

  return {
    diversification_score: diversificationScore,
    weight_concentration: Math.round(hhi * 10000) / 10000,
    probability_dispersion: Math.round(dispersion * 10000) / 10000,
    expected_nav: Math.round(expectedNav * 10000) / 10000,
    nav_std_dev: Math.round(navStdDev * 10000) / 10000,
    scenarios: {
      best_case: Math.round(bestCase * 10000) / 10000,
      worst_case: Math.round(worstCase * 10000) / 10000,
      expected: Math.round(expectedNav * 10000) / 10000,
      upside: Math.round((bestCase - expectedNav) * 10000) / 10000,
      downside: Math.round((expectedNav - worstCase) * 10000) / 10000,
    },
    leg_risk: legRisk,
  };
}
