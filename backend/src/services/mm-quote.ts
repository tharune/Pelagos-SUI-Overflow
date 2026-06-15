/**
 * Market-maker secondary-market quoting (Pelagos / Sui) — SIMULATED PRICING.
 *
 * The protocol acts as a market-maker: it QUOTES a bid for a pre-settlement
 * position (basket units, tranche senior/mezzanine/junior slices, or note
 * principal). Every product mints 1:1, so par is 1 USDC/unit; the MM bids a
 * product-specific spread below par reflecting risk and the cost of warehousing
 * the position to settlement. The mark, spread, and payout are all surfaced so
 * the UI can explain the fill.
 *
 * This file is the OFF-CHAIN pricing only — there is no EVM/on-chain MM rail on
 * Pelagos. An accepted bid settles as a simulated exit recorded to the ledger
 * (History) by the route layer. Pure, deterministic math: no chain reads, no
 * signing, no external calls.
 */

export type ProductKind = 'basket' | 'tranche' | 'note';
export type TrancheKind = 'senior' | 'junior' | 'mezzanine';

const BPS = 10_000;

/**
 * MM bid in bps of par per product (the fraction of $1/unit the MM pays for an
 * early exit). Riskier / longer-to-warehouse positions get a deeper discount;
 * the junior tranche absorbs first losses, so it trades furthest below par.
 * Mezzanine sits between senior and junior.
 */
export const MM_BID_BPS: Record<string, number> = {
  basket: 9_750, //                2.50% below par — basket of binaries, warehousing risk
  note: 9_900, //                  1.00% — principal-protected, trades near par
  'tranche-senior': 9_850, //      1.50% — senior slice, low risk
  'tranche-mezzanine': 9_400, //   6.00% — mezzanine, between senior and junior
  'tranche-junior': 9_000, //     10.00% — first-loss slice, deepest discount
};

export interface MmQuote {
  productType: ProductKind;
  trancheKind: TrancheKind | null;
  /** Position size being sold, display USDC (== units, since par is 1 USDC/unit). */
  size_usdc: number;
  /** MM payout, display USDC. */
  payout_usdc: number;
  /** Per-unit par mark (always 1 — products mint 1:1) and the per-unit bid. */
  mark_per_unit: number;
  bid_per_unit: number;
  /** Discount below par, in bps (par - bid). */
  spread_bps: number;
  /** This venue's MM exit is priced off-chain and settles as a simulated fill. */
  simulated: true;
}

/**
 * Quote a pre-settlement MM bid for a position. Prices a per-product bid below
 * par; the size is taken as given (the caller passes the held amount). Pure
 * pricing — no chain reads, no signature.
 */
export function quoteSellToMM(args: {
  productType: ProductKind;
  sizeUsdc: number;
  trancheKind?: TrancheKind;
}): MmQuote {
  const trancheKind: TrancheKind =
    args.trancheKind === 'junior'
      ? 'junior'
      : args.trancheKind === 'mezzanine'
        ? 'mezzanine'
        : 'senior';

  const size = Number(args.sizeUsdc);
  if (!Number.isFinite(size) || size <= 0) throw new Error('sell size must be positive');

  const bidKey = args.productType === 'tranche' ? `tranche-${trancheKind}` : args.productType;
  const bidBps = MM_BID_BPS[bidKey] ?? 9_500;
  const bidPerUnit = bidBps / BPS; // par is 1 USDC/unit, so the bid IS the per-unit price
  const payout = Math.round(size * bidPerUnit * 1e6) / 1e6;

  return {
    productType: args.productType,
    trancheKind: args.productType === 'tranche' ? trancheKind : null,
    size_usdc: size,
    payout_usdc: payout,
    mark_per_unit: 1,
    bid_per_unit: bidPerUnit,
    spread_bps: BPS - bidBps,
    simulated: true,
  };
}
