/**
 * Market-maker secondary-market quoting (Pelagos / Sui).
 *
 * The protocol acts as a market-maker: it QUOTES a bid for a pre-settlement
 * position (basket units, tranche senior/mezzanine/junior slices, or note
 * principal). The bid is anchored to the position's LIVE mark — the basket's
 * live NAV, the tranche's model fair value, or par for a principal-protected
 * note — and the MM takes a product-specific spread BELOW that mark for the risk
 * + cost of warehousing the position to settlement. So the mark is real; only
 * the spread (the MM's edge) and the off-chain fill are simulated. The mark,
 * its source, the spread, and the payout are all surfaced so the UI can explain
 * the fill honestly.
 *
 * This file is the OFF-CHAIN pricing math only — there is no on-chain MM rail on
 * Pelagos, so the caller supplies the live `markPerUnit` (resolved in the route
 * from getLiveNAV / quoteTranches). Pure, deterministic: no chain reads here.
 */

export type ProductKind = 'basket' | 'tranche' | 'note';
export type TrancheKind = 'senior' | 'junior' | 'mezzanine';
/** Where the per-unit mark came from (live vs par). */
export type MarkSource = 'live_nav' | 'tranche_model' | 'par';

const BPS = 10_000;

/**
 * MM bid as bps of the LIVE mark per product (the fraction of the mark the MM
 * pays for an early exit). Riskier / longer-to-warehouse positions get a deeper
 * discount; the junior tranche absorbs first losses, so it trades furthest below
 * its mark. Mezzanine sits between senior and junior.
 */
export const MM_BID_BPS: Record<string, number> = {
  basket: 9_750, //                2.50% below mark — basket of binaries, warehousing risk
  note: 9_900, //                  1.00% — principal-protected, trades near par
  'tranche-senior': 9_850, //      1.50% — senior slice, low risk
  'tranche-mezzanine': 9_400, //   6.00% — mezzanine, between senior and junior
  'tranche-junior': 9_000, //     10.00% — first-loss slice, deepest discount
};

export interface MmQuote {
  productType: ProductKind;
  trancheKind: TrancheKind | null;
  /** Units being sold (par-USDC face). Live value = size × mark_per_unit. */
  size_usdc: number;
  /** MM payout, display USDC = size × bid_per_unit. */
  payout_usdc: number;
  /** LIVE per-unit mark (basket NAV / tranche fair value / par for a note). */
  mark_per_unit: number;
  /** Where the mark came from — live NAV, tranche model, or par. */
  mark_source: MarkSource;
  /** Per-unit MM bid = mark × (1 − spread). */
  bid_per_unit: number;
  /** MM spread below the live mark, in bps (the simulated MM edge). */
  spread_bps: number;
  /** The mark is LIVE; the spread + the off-chain fill are simulated. */
  simulated: true;
}

/**
 * Quote a pre-settlement MM bid for a position. The bid sits a product-specific
 * spread below the LIVE per-unit mark the caller supplies (`markPerUnit`,
 * defaulting to par when no live mark is available). Pure pricing — no chain
 * reads, no signature.
 */
export function quoteSellToMM(args: {
  productType: ProductKind;
  sizeUsdc: number;
  trancheKind?: TrancheKind;
  /** Live per-unit mark; defaults to par (1) when the route can't resolve one. */
  markPerUnit?: number;
  markSource?: MarkSource;
}): MmQuote {
  const trancheKind: TrancheKind =
    args.trancheKind === 'junior'
      ? 'junior'
      : args.trancheKind === 'mezzanine'
        ? 'mezzanine'
        : 'senior';

  const size = Number(args.sizeUsdc);
  if (!Number.isFinite(size) || size <= 0) throw new Error('sell size must be positive');

  const mark =
    Number.isFinite(args.markPerUnit) && (args.markPerUnit as number) > 0 ? (args.markPerUnit as number) : 1;
  const markSource: MarkSource = args.markSource ?? (mark === 1 ? 'par' : 'live_nav');

  const bidKey = args.productType === 'tranche' ? `tranche-${trancheKind}` : args.productType;
  const bidBps = MM_BID_BPS[bidKey] ?? 9_500;
  const bidPerUnit = (mark * bidBps) / BPS; // spread applied to the LIVE mark, not par
  const payout = Math.round(size * bidPerUnit * 1e6) / 1e6;

  return {
    productType: args.productType,
    trancheKind: args.productType === 'tranche' ? trancheKind : null,
    size_usdc: size,
    payout_usdc: payout,
    mark_per_unit: Math.round(mark * 1e6) / 1e6,
    mark_source: markSource,
    bid_per_unit: Math.round(bidPerUnit * 1e6) / 1e6,
    spread_bps: BPS - bidBps,
    simulated: true,
  };
}
