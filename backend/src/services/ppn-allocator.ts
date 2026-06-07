/**
 * PPN capital allocator.
 *
 * A principal-protected note splits a deposit into a FLOOR sleeve (parked in the
 * protected vault to compound back to principal by maturity) and a RISK sleeve
 * (the residual that buys upside). This allocator deploys that risk sleeve across
 * three prediction-market products — baskets, tranches, and distribution markets
 * — with a mix chosen by the strategy profile:
 *
 *   Principal  — capital-preservation: mostly basket, a senior tranche, a little curve.
 *   Income     — balanced carry: basket + mezzanine tranche + a curve sleeve.
 *   Convexity  — upside-seeking: light basket, junior tranche, heavy distribution.
 *   Curve      — distribution-led: a curve-dominant book paired with a basket/tranche.
 *
 * On-chain the whole deposit escrows to the existing vault in one transaction; the
 * legs below are the recorded deployment plan for that collateral.
 */

export type SleeveProduct = 'basket' | 'tranche' | 'distribution';
export type TrancheKind = 'senior' | 'mezzanine' | 'junior';

export interface SleeveLeg {
  product: SleeveProduct;
  kind?: TrancheKind;
  pct: number; // share of the risk sleeve
  usdc: number;
  label: string;
}

export interface NoteAllocation {
  profile: string;
  deposit_usdc: number;
  apy: number;
  maturity_days: number;
  floor: { pct: number; usdc: number; at_maturity_usdc: number };
  risk_sleeve: { pct: number; usdc: number; legs: SleeveLeg[] };
}

interface Mix {
  basket: number;
  tranche: number;
  distribution: number;
  trancheKind: TrancheKind;
}

const SLEEVE_MIX: Record<string, Mix> = {
  Principal: { basket: 0.6, tranche: 0.3, distribution: 0.1, trancheKind: 'senior' },
  Income: { basket: 0.4, tranche: 0.35, distribution: 0.25, trancheKind: 'mezzanine' },
  Convexity: { basket: 0.25, tranche: 0.2, distribution: 0.55, trancheKind: 'junior' },
  Curve: { basket: 0.2, tranche: 0.25, distribution: 0.55, trancheKind: 'mezzanine' },
};

const r2 = (n: number): number => Math.round(n * 100) / 100;

// Spread weights so the sleeve fans across MULTIPLE positions per product with
// varied (non-round) amounts — never a single hardcoded market at a flat %.
const BASKET_SPREAD = [0.58, 0.42];
const TRANCHE_SPREAD = [0.64, 0.36];
const DIST_SPREAD = [0.44, 0.33, 0.23];
const TRANCHE_KINDS: TrancheKind[] = ['senior', 'mezzanine', 'junior'];

function normalize(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  return sum > 0 ? weights.map((w) => w / sum) : weights.map(() => 1 / weights.length);
}

export function allocateNote(args: {
  profile: string;
  amountUsdc: number;
  apy: number; // decimal, e.g. 0.07
  days: number;
  basketLabel?: string;
  distributionLabel?: string;
  baskets?: string[]; // multiple baskets to fan the basket sleeve across
  distributions?: string[]; // multiple distribution markets for the curve sleeve
}): NoteAllocation {
  const amount = Math.max(0, Number(args.amountUsdc) || 0);
  const apy = Math.max(0, Number(args.apy) || 0);
  const days = Math.max(1, Number(args.days) || 30);

  // Floor sleeve: present value that compounds back to principal at maturity.
  const vaultPct = apy > 0 ? 1 / Math.pow(1 + apy / 365, days) : 0.99;
  const floorUsdc = amount * vaultPct;
  const sleevePct = 1 - vaultPct;
  const sleeveUsdc = amount * sleevePct;

  const mix = SLEEVE_MIX[args.profile] ?? SLEEVE_MIX.Income;

  const baskets = (args.baskets?.filter(Boolean).length ? args.baskets! : [args.basketLabel ?? 'market basket']).slice(0, 2);
  const dists = (args.distributions?.filter(Boolean).length ? args.distributions! : [args.distributionLabel ?? 'distribution curve']).slice(0, 3);

  // The tranche sleeve splits across two adjacent seniority bands (e.g. a
  // Convexity note holds junior + mezzanine), so the deployment is never one leg.
  const baseIdx = TRANCHE_KINDS.indexOf(mix.trancheKind);
  const trancheKinds: TrancheKind[] = [
    mix.trancheKind,
    TRANCHE_KINDS[Math.min(TRANCHE_KINDS.length - 1, Math.max(0, baseIdx === 0 ? 1 : baseIdx - 1))],
  ].filter((k, i, a) => a.indexOf(k) === i);

  const legs: SleeveLeg[] = [];

  const bW = normalize(BASKET_SPREAD.slice(0, baskets.length));
  baskets.forEach((b, i) => {
    const w = mix.basket * bW[i];
    legs.push({ product: 'basket', pct: w, usdc: r2(sleeveUsdc * w), label: b });
  });

  const tW = normalize(TRANCHE_SPREAD.slice(0, trancheKinds.length));
  trancheKinds.forEach((kind, i) => {
    const w = mix.tranche * tW[i];
    legs.push({ product: 'tranche', kind, pct: w, usdc: r2(sleeveUsdc * w), label: `${kind} tranche` });
  });

  const dW = normalize(DIST_SPREAD.slice(0, dists.length));
  dists.forEach((d, i) => {
    const w = mix.distribution * dW[i];
    legs.push({ product: 'distribution', pct: w, usdc: r2(sleeveUsdc * w), label: d });
  });

  return {
    profile: args.profile,
    deposit_usdc: r2(amount),
    apy,
    maturity_days: days,
    floor: {
      pct: vaultPct,
      usdc: r2(floorUsdc),
      at_maturity_usdc: r2(floorUsdc * Math.pow(1 + apy / 365, days)),
    },
    risk_sleeve: { pct: sleevePct, usdc: r2(sleeveUsdc), legs },
  };
}
