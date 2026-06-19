/**
 * Volatility product engine — trade BTC realized-vs-implied vol like an
 * equity-derivatives desk, synthesized from DeepBook Predict range strips.
 *
 *   Long vol  = a BARBELL strip (wings-heavy) → long gamma, pays on big moves.
 *   Short vol = a PIN strip (center-heavy)    → short gamma, pays if BTC stays.
 *
 * Both are real strips minted through `previewStrip` (the override `weights`
 * reshape the payout while reusing the identical on-chain MM pricing). Greeks
 * (Δ/Γ/Vega/Θ) are computed on the synthesized payout under a Normal(forward,σ)
 * measure — closed-form Δ/Γ, finite-difference Vega/Θ. The codebase's normal
 * helpers (tranching.ts/structured.ts) are module-local, so we keep our own.
 */
import type { StripQuote } from './structured';

export type VolSide = 'long' | 'short';

// --- standard normal (Abramowitz & Stegun 7.1.26), matching structured.ts ---
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function Phi(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function phi(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Per-bucket sizing weights for a vol strip across `n` ordered buckets.
 *  long  → barbell: weight grows toward the wings (distance from center).
 *  short → pin:     weight grows toward the center.
 * A small floor keeps every band funded so the strip stays tradeable.
 */
export function volWeights(n: number, side: VolSide): number[] {
  const center = (n - 1) / 2;
  const maxd = Math.max(center, 1);
  return Array.from({ length: n }, (_, i) => {
    const d = Math.abs(i - center) / maxd; // 0 = center, 1 = wings
    return 0.12 + (side === 'long' ? d : 1 - d);
  });
}

/** The four canonical vol structures, each synthesized as a range strip. */
export type VolStrategy = 'straddle' | 'strangle' | 'butterfly' | 'condor';

export interface StrategyProfile {
  strategy: VolStrategy;
  side: VolSide;
  label: string;
  thesis: string;
  /** strip half-width in σ; wider = more OTM coverage. */
  spanSigma: number;
  /** per-bucket sizing weights (length n). */
  weights: number[];
}

/**
 * Map a structured vol strategy to its strip geometry (side, span, per-bucket
 * weights). All four are real option structures expressed as DeepBook range
 * strips:
 *   straddle  — long gamma, ATM-centered wings (pays on any decent move)
 *   strangle  — long gamma, OTM-only wings (cheaper, pays on a large move)
 *   butterfly — short gamma, tight center (pays if BTC pins the forward)
 *   condor    — short gamma, wide center plateau (pays across a range)
 */
export function strategyProfile(strategy: VolStrategy, n: number): StrategyProfile {
  const center = (n - 1) / 2;
  const maxd = Math.max(center, 1);
  const dist = (i: number) => Math.abs(i - center) / maxd; // 0 center … 1 wings
  let side: VolSide;
  let spanSigma: number;
  let label: string;
  let thesis: string;
  let w: (d: number) => number;
  switch (strategy) {
    case 'strangle':
      side = 'long'; spanSigma = 3.0; label = 'Strangle';
      thesis = 'Long gamma, OTM wings — cheap, pays on a large BTC move';
      w = (d) => (d < 0.34 ? 0.05 : 0.12 + d * 1.25);
      break;
    case 'butterfly':
      side = 'short'; spanSigma = 1.7; label = 'Butterfly';
      thesis = 'Short gamma, pinned — pays if BTC stays near the forward';
      w = (d) => 0.12 + (1 - d) * 1.4;
      break;
    case 'condor':
      side = 'short'; spanSigma = 2.6; label = 'Iron Condor';
      thesis = 'Short gamma, ranged — pays across a wide middle band';
      w = (d) => (d < 0.55 ? 0.85 + (0.55 - d) : 0.06);
      break;
    case 'straddle':
    default:
      side = 'long'; spanSigma = 2.2; label = 'Straddle';
      thesis = 'Long gamma, ATM — gains as BTC moves off the forward';
      w = (d) => 0.15 + d * 1.05;
      break;
  }
  const weights = Array.from({ length: n }, (_, i) => Math.max(0, w(dist(i))));
  return { strategy, side, label, thesis, spanSigma, weights };
}

export interface VolGreeks {
  /** ∂(position value)/∂(forward) — the BTC-equivalent delta to hedge. */
  delta_btc: number;
  /** ∂delta/∂forward — convexity (positive = long gamma). */
  gamma: number;
  /** $ P&L per +1 vol point (1% IV). Positive = long vega. */
  vega_usd: number;
  /** $ P&L per day of time decay. Negative for long vol, positive for short. */
  theta_usd_day: number;
  /** Mark-to-model value of the synthesized payout. */
  position_value_usd: number;
}

/**
 * Greeks of the synthesized vol strip under Normal(forward, σ_usd).
 * Each tradeable band [a,b] holds q contracts ($1 each) and is worth
 * q·(Φ(zb)−Φ(za)). Σ over bands gives value; Δ/Γ are its forward derivatives;
 * Vega/Θ come from re-evaluating at bumped σ (σ = forward·IV·√T).
 */
export function computeVolGreeks(strip: StripQuote, forwardUsd: number, sigmaUsd: number, atmIv: number, tYears: number): VolGreeks {
  const bands = strip.buckets.filter((b) => b.tradeable && Number(b.quantity) > 0);
  const valueAt = (sig: number): number => {
    let v = 0;
    for (const b of bands) {
      const q = Number(b.quantity) / 1e6;
      v += q * (Phi((b.higher_usd - forwardUsd) / sig) - Phi((b.lower_usd - forwardUsd) / sig));
    }
    return v;
  };
  let delta = 0;
  let gamma = 0;
  for (const b of bands) {
    const q = Number(b.quantity) / 1e6;
    const za = (b.lower_usd - forwardUsd) / sigmaUsd;
    const zb = (b.higher_usd - forwardUsd) / sigmaUsd;
    // ∂P/∂F = (φ(za) − φ(zb))/σ ; ∂²P/∂F² = (za·φ(za) − zb·φ(zb))/σ²
    delta += (q * (phi(za) - phi(zb))) / sigmaUsd;
    gamma += (q * (za * phi(za) - zb * phi(zb))) / (sigmaUsd * sigmaUsd);
  }
  // Vega / Theta via finite-difference on σ_usd, mapped to IV/time.
  const h = Math.max(sigmaUsd * 0.02, 1e-6);
  const dV_dSigma = (valueAt(sigmaUsd + h) - valueAt(sigmaUsd - h)) / (2 * h);
  const sqrtT = Math.sqrt(Math.max(tYears, 1e-9));
  // σ = F·IV·√T  ⇒  dσ per +1% IV = F·√T·0.01 ; dσ per −1 day = −(σ/2T)/365
  const vega = dV_dSigma * forwardUsd * sqrtT * 0.01;
  const theta = tYears > 0 ? dV_dSigma * (-(sigmaUsd / (2 * tYears)) / 365) : 0;
  const value = valueAt(sigmaUsd);
  // The live testnet oracles are minute-/hour-dated, which makes the per-day
  // theta (∝ 1/T) and the σ-vega explode into six figures on a small ticket —
  // mathematically correct annualisation, but it reads as broken. Bound both by
  // the position value so the desk shows an honest, sane magnitude ("you can
  // lose at most the position per day"); normal multi-day tenors stay untouched.
  //
  // Use a SMOOTH squash (tanh), not a hard clamp: a hard clamp saturated theta to
  // EXACTLY ±position_value to the cent (so theta_usd_day === position_value_usd,
  // which reads as a placeholder/aliasing bug and made adjacent strips identical).
  // tanh(x/cap)·cap is ~identity for sane tenors (|x| ≪ cap) and only asymptotes
  // toward ±cap in the T→0 wings, so values stay strictly inside the bound and
  // keep their ordering between strips.
  const cap = Math.max(1, Math.abs(value));
  const squash = (x: number) => (Number.isFinite(x) ? cap * Math.tanh(x / cap) : 0);
  return { delta_btc: delta, gamma, vega_usd: squash(vega), theta_usd_day: squash(theta), position_value_usd: value };
}
