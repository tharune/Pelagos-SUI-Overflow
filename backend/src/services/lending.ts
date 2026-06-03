/**
 * Pelagos lending service.
 *
 * Single USDC pool with a utilization-based rate curve. Basket / tranche
 * tokens are posted as collateral at a tier-specific loan-to-value ratio.
 * State is in-memory for the hackathon; the `PoolSnapshot` object is the
 * contract the routes expose.
 *
 * Design trade-offs:
 *   - Rates are a piecewise linear curve so the math stays readable in a demo.
 *   - LTV is deterministic per tier, so users can see exactly what they can
 *     borrow before confirming.
 *   - "Demo lend" deposits earn the current borrow rate * utilization, so the
 *     lend-side APY scales with pool activity.
 */

export type CollateralKind = "basket" | "tranche";
export type TrancheKind = "senior" | "mezzanine" | "junior";

export interface PoolSnapshot {
  total_deposits: number; // USDC supplied by lenders
  total_borrows: number; // USDC outstanding on loans
  utilization: number; // [0, 1]
  borrow_rate_apy: number; // rate paid by borrowers
  supply_rate_apy: number; // rate earned by lenders
  ltv_table: {
    basket: Record<90 | 70 | 50, number>; // LTV per basket tier
    tranche: Record<TrancheKind, number>; // LTV per tranche kind
  };
  reserve_factor: number; // protocol share of interest (for display)
}

/** In-memory pool state. Persists only for process lifetime. */
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

/** Piecewise linear utilization curve. */
function borrowApy(util: number): number {
  if (util <= 0.8) return 0.02 + util * 0.08; // 2% to 8.4% linearly
  return 0.084 + (util - 0.8) * 0.6; // steep slope above 80%
}

export function snapshot(): PoolSnapshot {
  const util = state.total_deposits > 0 ? state.total_borrows / state.total_deposits : 0;
  const bAPY = borrowApy(Math.min(1, util));
  const sAPY = bAPY * util * (1 - RESERVE_FACTOR);
  return {
    total_deposits: state.total_deposits,
    total_borrows: state.total_borrows,
    utilization: +util.toFixed(4),
    borrow_rate_apy: +(bAPY * 100).toFixed(2),
    supply_rate_apy: +(sAPY * 100).toFixed(2),
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
