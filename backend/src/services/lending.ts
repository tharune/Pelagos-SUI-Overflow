/**
 * Pelagos lending service.
 *
 * Single USDC pool with a utilization-based rate curve, ANCHORED TO LIVE Sui
 * lending-market rates. Basket / tranche tokens are posted as collateral at a
 * tier-specific loan-to-value ratio.
 *
 *   - `market_supply_apy` is the REAL, live TVL-weighted Sui USDC supply APY from
 *     DeFiLlama (NAVI / Scallop / Suilend …), cached, with a documented fallback.
 *   - `borrow_rate_apy` is that live market rate grossed up for the reserve cut
 *     plus a utilization premium over THIS pool's draw — so the borrow cost
 *     tracks the real market and rises as the pool is stressed.
 *   - `supply_rate_apy` is what a lender to THIS pool earns = borrow·util·(1−rf).
 *   - Pool deposits/borrows are in-memory: there is no on-chain Pelagos lending
 *     contract, so the lend/borrow/repay actions are a labeled demo (no real
 *     flow). LTVs are Pelagos risk parameters (indicative), not market prices.
 */

export type CollateralKind = "basket" | "tranche";
export type TrancheKind = "senior" | "mezzanine" | "junior";

export interface PoolSnapshot {
  total_deposits: number; // USDC supplied by lenders (this demo pool)
  total_borrows: number; // USDC outstanding on loans (this demo pool)
  utilization: number; // [0, 1]
  borrow_rate_apy: number; // rate paid by borrowers (market-anchored + util premium)
  supply_rate_apy: number; // rate earned by lenders to this pool
  /** Live TVL-weighted Sui USDC supply APY the pool's rates are anchored to. */
  market_supply_apy: number;
  /** Where the live market rate came from ('defillama:…' or 'fallback'). */
  rate_source: string;
  ltv_table: {
    basket: Record<90 | 70 | 50, number>; // LTV per basket tier
    tranche: Record<TrancheKind, number>; // LTV per tranche kind
  };
  reserve_factor: number; // protocol share of interest (for display)
}

/** In-memory pool state. Persists only for process lifetime (demo flow). */
const state = {
  total_deposits: 50_000,
  total_borrows: 0,
};

const LTV_BASKET: Record<90 | 70 | 50, number> = { 90: 0.85, 70: 0.6, 50: 0.4 };
const LTV_TRANCHE: Record<TrancheKind, number> = {
  senior: 0.88,
  mezzanine: 0.6,
  junior: 0.3,
};
const RESERVE_FACTOR = 0.1;
// Utilization implicit in DeFiLlama's quoted supply APY — used to back out the
// market's implied borrow rate (supply = borrow·util·(1−rf)).
const REF_UTIL = 0.85;

// ---------------------------------------------------------------------------
// Live Sui USDC lending rate (DeFiLlama), cached like the vault-yield aggregator.
// ---------------------------------------------------------------------------

const LENDING_PROJECTS = new Set([
  "navi-lending", "navi", "scallop-lend", "scallop", "suilend", "kai-finance", "bucket",
]);
const RATE_TTL_MS = 5 * 60_000;
const FALLBACK_SUPPLY_APY = 0.055; // documented fallback if DeFiLlama is unreachable
let rateCache: { apy: number; source: string; at: number } | null = null;
let rateInflight: Promise<void> | null = null;

interface LlamaPool { chain?: string; project?: string; symbol?: string; tvlUsd?: number | null; apyBase?: number | null; apy?: number | null; }

async function refreshRate(): Promise<void> {
  try {
    const res = await fetch("https://yields.llama.fi/pools", { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: LlamaPool[] };
    const pools = (body.data ?? []).filter(
      (p) =>
        p.chain === "Sui" &&
        typeof p.symbol === "string" &&
        /(^|[^A-Z])USDC($|[^A-Z])/i.test(p.symbol) &&
        p.project && LENDING_PROJECTS.has(p.project) &&
        (p.tvlUsd ?? 0) > 50_000,
    );
    let wsum = 0;
    let w = 0;
    const venues = new Set<string>();
    for (const p of pools) {
      const apy = typeof p.apyBase === "number" ? p.apyBase : typeof p.apy === "number" ? p.apy : null;
      const tvl = p.tvlUsd ?? 0;
      if (apy === null || tvl <= 0) continue;
      wsum += (apy / 100) * tvl; // DeFiLlama APY is in percent
      w += tvl;
      venues.add((p.project ?? "").replace("-lending", "").replace("-lend", ""));
    }
    if (w > 0) {
      rateCache = { apy: wsum / w, source: `defillama:${[...venues].join(",")}`, at: Date.now() };
    }
  } catch {
    /* keep last-good / fallback */
  }
}

/** Live TVL-weighted Sui USDC supply APY (cached; refreshes in the background). */
function liveSupply(): { apy: number; source: string } {
  if (!rateCache || Date.now() - rateCache.at > RATE_TTL_MS) {
    if (!rateInflight) rateInflight = refreshRate().finally(() => { rateInflight = null; });
  }
  return rateCache ? { apy: rateCache.apy, source: rateCache.source } : { apy: FALLBACK_SUPPLY_APY, source: "fallback" };
}

/** Warm the live rate at boot so the first snapshot is already live. */
export function warmLendingRate(): Promise<void> {
  return refreshRate();
}

/** Utilization premium over the market borrow rate: 0 below 80%, steep above. */
function utilizationPremium(util: number): number {
  return util <= 0.8 ? util * 0.02 : 0.016 + (util - 0.8) * 0.5;
}

export function snapshot(): PoolSnapshot {
  const { apy: marketSupply, source } = liveSupply();
  const util = state.total_deposits > 0 ? state.total_borrows / state.total_deposits : 0;
  const u = Math.min(1, util);
  // Market-implied borrow rate (gross up the live supply for util + reserve),
  // plus a premium as THIS pool is drawn down.
  const marketBorrow = marketSupply / (REF_UTIL * (1 - RESERVE_FACTOR));
  const bAPY = marketBorrow + utilizationPremium(u);
  const sAPY = bAPY * u * (1 - RESERVE_FACTOR);
  return {
    total_deposits: state.total_deposits,
    total_borrows: state.total_borrows,
    utilization: +util.toFixed(4),
    borrow_rate_apy: +(bAPY * 100).toFixed(2),
    supply_rate_apy: +(sAPY * 100).toFixed(2),
    market_supply_apy: +(marketSupply * 100).toFixed(2),
    rate_source: source,
    ltv_table: { basket: LTV_BASKET, tranche: LTV_TRANCHE },
    reserve_factor: RESERVE_FACTOR,
  };
}

export class LendingError extends Error {
  code: "ZERO_AMOUNT" | "INSUFFICIENT_LIQUIDITY" | "WITHDRAW_EXCEEDS_BALANCE" | "REPAY_EXCEEDS_DEBT";
  constructor(
    code: LendingError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

function requirePositive(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new LendingError("ZERO_AMOUNT", "amount must be a positive number");
  }
}

export function deposit(amountUsdc: number): PoolSnapshot {
  requirePositive(amountUsdc);
  state.total_deposits += amountUsdc;
  return snapshot();
}
export function withdraw(amountUsdc: number): PoolSnapshot {
  requirePositive(amountUsdc);
  const available = state.total_deposits - state.total_borrows;
  if (amountUsdc > available) {
    throw new LendingError(
      "INSUFFICIENT_LIQUIDITY",
      `Only ${available} USDC is withdrawable (${state.total_borrows} is on loan).`,
    );
  }
  if (amountUsdc > state.total_deposits) {
    throw new LendingError(
      "WITHDRAW_EXCEEDS_BALANCE",
      `Pool only holds ${state.total_deposits} USDC total.`,
    );
  }
  state.total_deposits -= amountUsdc;
  return snapshot();
}
export function borrow(amountUsdc: number): PoolSnapshot {
  requirePositive(amountUsdc);
  const available = state.total_deposits - state.total_borrows;
  if (amountUsdc > available) {
    throw new LendingError(
      "INSUFFICIENT_LIQUIDITY",
      `Pool can lend at most ${available} USDC right now.`,
    );
  }
  state.total_borrows += amountUsdc;
  return snapshot();
}
export function repay(amountUsdc: number): PoolSnapshot {
  requirePositive(amountUsdc);
  if (amountUsdc > state.total_borrows) {
    throw new LendingError(
      "REPAY_EXCEEDS_DEBT",
      `Total outstanding is only ${state.total_borrows} USDC.`,
    );
  }
  state.total_borrows -= amountUsdc;
  return snapshot();
}

export function maxBorrow(args: {
  kind: CollateralKind;
  tier?: 90 | 70 | 50; // basket only
  trancheKind?: TrancheKind; // tranche only
  collateralValueUsd: number;
}): { ltv: number; maxBorrow: number } {
  const ltv =
    args.kind === "basket"
      ? LTV_BASKET[args.tier ?? 90]
      : LTV_TRANCHE[args.trancheKind ?? "senior"];
  return { ltv, maxBorrow: +(args.collateralValueUsd * ltv).toFixed(2) };
}
