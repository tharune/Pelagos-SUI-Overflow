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

/** One product's contribution to the blended exit cost. */
export interface ExitLeg {
  product: SleeveProduct | 'floor';
  label: string;
  /** Share of the whole note this leg represents (floor + legs sum to 1). */
  weight: number;
  /** This product's own redemption/unwind fee, in bps. */
  fee_bps: number;
  /** weight · fee on the deposit, in USDC. */
  fee_usdc: number;
}

/**
 * Exit pricing for the note. Redeeming a note unwinds EVERY sleeve at once —
 * the floor vault plus each basket / tranche / distribution leg — so the cost
 * to exit is the allocation-weighted blend of every product's own exit fee, not
 * just the vault redeem fee. This is what makes "exit everything in unison"
 * priced honestly.
 */
export interface NoteExitPlan {
  blended_fee_bps: number; // allocation-weighted across floor + all legs
  est_fee_usdc: number; // blended fee on the deposit
  legs: ExitLeg[]; // per-product breakdown
}

export interface NoteAllocation {
  profile: string;
  deposit_usdc: number;
  apy: number;
  maturity_days: number;
  floor: { pct: number; usdc: number; at_maturity_usdc: number };
  risk_sleeve: { pct: number; usdc: number; legs: SleeveLeg[] };
  exit: NoteExitPlan;
}

// Per-product exit (redemption / unwind) fees, in bps. Floor = the vault redeem
// fee; basket = protocol + MM spread + bid-side slippage; tranche grows with
// subordination (junior pays the most adverse-selection on the way out);
// distribution = AMM maker fee + round-trip price impact.
const FLOOR_EXIT_BPS = 30;
const BASKET_EXIT_BPS = 60;
const TRANCHE_EXIT_BPS: Record<TrancheKind, number> = {
  senior: 45,
  mezzanine: 90,
  junior: 160,
};
const DIST_EXIT_BPS = 55;

function productExitBps(leg: SleeveLeg): number {
  if (leg.product === 'tranche' && leg.kind) return TRANCHE_EXIT_BPS[leg.kind];
  if (leg.product === 'basket') return BASKET_EXIT_BPS;
  return DIST_EXIT_BPS;
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

const TRANCHE_KINDS: TrancheKind[] = ['senior', 'mezzanine', 'junior'];

function normalize(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  return sum > 0 ? weights.map((w) => w / sum) : weights.map(() => 1 / weights.length);
}

// ---- Deterministic per-build variation -------------------------------------
// Each note fans the risk sleeve across 3–9 positions with non-round amounts.
// The exact count and the amount jitter are seeded off the build parameters so
// a given (profile, amount, apy, days) is stable across renders — no flicker —
// yet different builds genuinely differ.
function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Apportion `target` integer legs across the three products by mix weight,
 * giving every present product at least its `min` and never exceeding `max`.
 * Leftover legs go to the product with the highest weight-per-leg (diminishing
 * returns), so the dominant sleeve gets the most positions.
 */
function apportion(
  target: number,
  weights: Record<SleeveProduct, number>,
  mins: Record<SleeveProduct, number>,
  maxes: Record<SleeveProduct, number>,
): Record<SleeveProduct, number> {
  const keys: SleeveProduct[] = ['basket', 'tranche', 'distribution'];
  const counts: Record<SleeveProduct, number> = { basket: 0, tranche: 0, distribution: 0 };
  let used = 0;
  for (const k of keys) {
    counts[k] = Math.min(mins[k], maxes[k]);
    used += counts[k];
  }
  let remaining = target - used;
  while (remaining > 0) {
    let best: SleeveProduct | null = null;
    let bestScore = -1;
    for (const k of keys) {
      if (counts[k] >= maxes[k]) continue;
      const score = weights[k] / (counts[k] + 1);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (!best) break;
    counts[best] += 1;
    remaining -= 1;
  }
  return counts;
}

/** Pick `count` tranche bands centred on `primary`, expanding to neighbours. */
function pickTrancheKinds(primary: TrancheKind, count: number): TrancheKind[] {
  const base = TRANCHE_KINDS.indexOf(primary);
  const order: TrancheKind[] = [primary];
  for (let d = 1; d < TRANCHE_KINDS.length && order.length < count; d++) {
    for (const idx of [base - d, base + d]) {
      if (idx >= 0 && idx < TRANCHE_KINDS.length && !order.includes(TRANCHE_KINDS[idx])) {
        order.push(TRANCHE_KINDS[idx]);
      }
    }
  }
  return order.slice(0, count);
}

/** Seeded non-round split weights for `count` legs (descending, jittered). */
function splitWeights(count: number, rng: () => number): number[] {
  if (count <= 1) return [1];
  const raw: number[] = [];
  for (let i = 0; i < count; i++) {
    // Descending base (earlier legs larger) + ±35% seeded jitter so amounts
    // never land on flat, round shares.
    const base = count - i;
    const jitter = 0.65 + rng() * 0.7;
    raw.push(base * jitter);
  }
  return normalize(raw);
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
  const mixWeights: Record<SleeveProduct, number> = {
    basket: mix.basket,
    tranche: mix.tranche,
    distribution: mix.distribution,
  };

  // Real candidate labels — basket ids + distribution market names. Capped at 3
  // legs each; with up to 3 tranche bands that's up to 9 positions per build.
  const baskets = (args.baskets?.filter(Boolean).length ? args.baskets! : [args.basketLabel ?? 'market basket']).slice(0, 3);
  const dists = (args.distributions?.filter(Boolean).length ? args.distributions! : [args.distributionLabel ?? 'distribution curve']).slice(0, 3);

  const rng = mulberry32(seedFrom(`${args.profile}:${Math.round(amount)}:${Math.round(apy * 1e4)}:${days}`));

  const maxes: Record<SleeveProduct, number> = {
    basket: Math.min(3, baskets.length),
    tranche: 3,
    distribution: Math.min(3, dists.length),
  };
  const mins: Record<SleeveProduct, number> = {
    basket: maxes.basket > 0 ? 1 : 0,
    tranche: 1,
    distribution: maxes.distribution > 0 ? 1 : 0,
  };
  const totalMin = Math.max(3, mins.basket + mins.tranche + mins.distribution);
  const totalMax = maxes.basket + maxes.tranche + maxes.distribution;
  // Target 3–9 legs, seeded, clamped to what the candidate pool can field.
  const targetTotal = Math.max(totalMin, Math.min(totalMax, 3 + Math.floor(rng() * 7)));
  const counts = apportion(targetTotal, mixWeights, mins, maxes);

  const legs: SleeveLeg[] = [];

  // Basket sleeve
  const bKinds = baskets.slice(0, counts.basket);
  const bW = splitWeights(bKinds.length, rng);
  bKinds.forEach((b, i) => {
    const w = mix.basket * bW[i];
    legs.push({ product: 'basket', pct: w, usdc: r2(sleeveUsdc * w), label: b });
  });

  // Tranche sleeve — fan across `counts.tranche` adjacent seniority bands.
  const tKinds = pickTrancheKinds(mix.trancheKind, counts.tranche);
  const tW = splitWeights(tKinds.length, rng);
  tKinds.forEach((kind, i) => {
    const w = mix.tranche * tW[i];
    legs.push({ product: 'tranche', kind, pct: w, usdc: r2(sleeveUsdc * w), label: `${kind} tranche` });
  });

  // Distribution sleeve
  const dKinds = dists.slice(0, counts.distribution);
  const dW = splitWeights(dKinds.length, rng);
  dKinds.forEach((d, i) => {
    const w = mix.distribution * dW[i];
    legs.push({ product: 'distribution', pct: w, usdc: r2(sleeveUsdc * w), label: d });
  });

  // Blended exit cost: redeeming the note unwinds the floor vault AND every
  // product leg at once, so the exit fee is the allocation-weighted blend of
  // each product's own exit fee — not just the vault redeem fee. floor weight
  // is vaultPct; each leg's weight of the WHOLE note is sleevePct · leg.pct
  // (legs sum to 1.0 of the sleeve), so all weights sum to 1.0.
  const r4 = (n: number): number => Math.round(n * 10000) / 10000;
  const blendedBps =
    vaultPct * FLOOR_EXIT_BPS +
    legs.reduce((s, l) => s + sleevePct * l.pct * productExitBps(l), 0);
  const exitLegs: ExitLeg[] = [
    {
      product: 'floor',
      label: 'protected vault',
      weight: r4(vaultPct),
      fee_bps: FLOOR_EXIT_BPS,
      fee_usdc: r2((amount * vaultPct * FLOOR_EXIT_BPS) / 10000),
    },
    ...legs.map((l): ExitLeg => {
      const weight = sleevePct * l.pct;
      const feeBps = productExitBps(l);
      return {
        product: l.product,
        label: l.label,
        weight: r4(weight),
        fee_bps: feeBps,
        fee_usdc: r2((amount * weight * feeBps) / 10000),
      };
    }),
  ];
  const exit: NoteExitPlan = {
    blended_fee_bps: Math.round(blendedBps * 100) / 100,
    est_fee_usdc: r2((amount * blendedBps) / 10000),
    legs: exitLegs,
  };

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
    exit,
  };
}
