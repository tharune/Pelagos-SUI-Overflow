/**
 * Pelagos product layer over the DeepBook Predict strip engine.
 *
 * Every product is a parameterization of the same real, MM-priced range strip:
 *  - Distribution Markets : the strip itself (previewStrip).
 *  - PPN                  : a PLP "floor" sleeve + a range-strip "upside" sleeve.
 *  - Tranches/Risk Slices : senior/mezz/junior = the strip at 0.5σ / 1σ / 2σ width
 *                           (narrow ATM = lower hit-rate/biggest multiple; wide = high
 *                           hit-rate/lower multiple — confirmed against live max payouts).
 *  - DeepBook baskets     : curated μ/σ recipes (replace the old 50% coin-flip basket).
 *
 * All pricing flows through previewStrip → on-chain get_range_trade_amounts, so
 * costs, slippage and both-sided spreads are the protocol's real numbers.
 */
import { previewStrip, type GridOracle, type StripQuote } from './structured';
import { predictServer } from './server';
import { decodeSvi, sviImpliedVol } from './vol';

const DUSDC = 1e6;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/**
 * Resolve the σ that sizes a tranche/strip's bands to the protocol's OWN live
 * distribution. We read the oracle's latest SVI smile and take the at-the-money
 * implied move σ = forward · iv_atm · √T (raw 1e9). This is tenor-aware: it
 * shrinks as expiry approaches, so the bands always track the real distribution
 * and central buckets stay inside the [2%,98%] mintable window instead of going
 * "too certain" near expiry. Floored to a few ticks (and a small % of forward)
 * so the grid can never collapse the buckets; falls back to `flatSigmaRaw` (the
 * route's flat default) when the SVI feed is unavailable.
 */
export async function impliedSigmaRaw(oracle: GridOracle, forwardRaw: number, flatSigmaRaw: number): Promise<number> {
  let base = flatSigmaRaw;
  try {
    const svi = await predictServer.oracleSviLatest(oracle.oracle_id);
    const params = decodeSvi(svi);
    const tYears = (Number(oracle.expiry) - Date.now()) / YEAR_MS;
    if (params && tYears > 0) {
      const atmIv = sviImpliedVol(params, 0, tYears);
      const implied = forwardRaw * atmIv * Math.sqrt(tYears);
      if (Number.isFinite(implied) && implied > 0) base = implied;
    }
  } catch {
    /* keep flat fallback */
  }
  return Math.max(base, 4 * (oracle.tick_size || 1), forwardRaw * 0.0015);
}

export interface PpnQuote {
  budget_raw: string;
  floor_raw: string; // supplied to PLP vault
  upside_raw: string; // spent on the range strip
  protection_pct: number; // floor / budget
  strip: StripQuote;
  /** principal kept safe in PLP (≈ floor, grows with PLP share price). */
  protected_principal_raw: string;
  /** floor + strip max payout (best case). */
  total_max_payout_raw: string;
  dusdc_decimals: number;
}

export async function quotePpn(args: {
  oracle: GridOracle;
  forwardRaw: number;
  budgetRaw: bigint;
  floorPct: number; // 0..1 (e.g. 0.8 = 80% protected in PLP)
  sigmaRaw: number;
  n: number;
  sender?: string;
}): Promise<PpnQuote> {
  const floorPct = Math.min(0.99, Math.max(0.01, args.floorPct));
  const floorRaw = BigInt(Math.floor(Number(args.budgetRaw) * floorPct));
  const upsideRaw = args.budgetRaw - floorRaw;
  const strip = await previewStrip({
    oracle: args.oracle, muRaw: args.forwardRaw, sigmaRaw: args.sigmaRaw, n: args.n, budgetRaw: upsideRaw, sender: args.sender,
  });
  return {
    budget_raw: args.budgetRaw.toString(),
    floor_raw: floorRaw.toString(),
    upside_raw: upsideRaw.toString(),
    protection_pct: floorPct,
    strip,
    protected_principal_raw: floorRaw.toString(),
    // Best case = principal floor back + the largest single upside band settling.
    total_max_payout_raw: (floorRaw + BigInt(strip.realized_max_payout_raw)).toString(),
    dusdc_decimals: 6,
  };
}

export interface TrancheProfile {
  tranche: 'senior' | 'mezz' | 'junior';
  sigma_mult: number;
  label: string;
  strip: StripQuote;
}

// Credit-style waterfall over ONE forward, sized by conviction width. Senior is
// the WIDE, defensive slice (high hit-rate, steady multiple); junior is the
// TIGHT ATM slice (lower hit-rate, biggest multiple) — the empirical relation
// on the live book is narrow → high payout multiple, wide → low. `n` is tuned
// per slice so each band lands inside the mintable window across tenors.
const TRANCHE_DEFS: Array<{ tranche: TrancheProfile['tranche']; mult: number; n: number; label: string }> = [
  { tranche: 'senior', mult: 1.8, n: 6, label: 'Senior — wide coverage, high hit-rate, steady multiple' },
  { tranche: 'mezz', mult: 1.0, n: 6, label: 'Mezzanine — balanced width' },
  { tranche: 'junior', mult: 0.5, n: 5, label: 'Junior — tight ATM, lower hit-rate, biggest multiple' },
];

export async function quoteTranches(args: {
  oracle: GridOracle;
  forwardRaw: number;
  budgetRaw: bigint;
  sigmaRaw: number;
  n: number;
  sender?: string;
}): Promise<{ tranches: TrancheProfile[] }> {
  // Size every slice off the oracle's live implied move so the bands track the
  // real distribution (never the near-expiry "all bands out of band" collapse).
  const sigmaBase = await impliedSigmaRaw(args.oracle, args.forwardRaw, args.sigmaRaw);
  const tranches: TrancheProfile[] = [];
  for (const d of TRANCHE_DEFS) {
    const strip = await previewStrip({
      oracle: args.oracle, muRaw: args.forwardRaw, sigmaRaw: Math.round(sigmaBase * d.mult), n: d.n, budgetRaw: args.budgetRaw, sender: args.sender,
    });
    tranches.push({ tranche: d.tranche, sigma_mult: d.mult, label: d.label, strip });
  }
  return { tranches };
}

export interface BasketRecipe {
  id: string;
  name: string;
  description: string;
  sigma_pct: number; // σ as a fraction of forward
  n: number;
}

/** DeepBook BTC structured baskets — replace the dropped ~50% Polymarket basket. */
export const DEEPBOOK_BASKETS: BasketRecipe[] = [
  { id: 'btc-pin', name: 'BTC Pin', description: 'Tight at-the-money distribution — conviction on a level.', sigma_pct: 0.003, n: 4 },
  { id: 'btc-spread', name: 'BTC Spread', description: 'Balanced distribution around the forward.', sigma_pct: 0.006, n: 6 },
  { id: 'btc-convex', name: 'BTC Wide', description: 'Broad distribution — wide coverage around the forward.', sigma_pct: 0.010, n: 8 },
];

export async function quoteBasket(args: {
  oracle: GridOracle;
  forwardRaw: number;
  basketId: string;
  budgetRaw: bigint;
  sender?: string;
}): Promise<{ basket: BasketRecipe; strip: StripQuote }> {
  const basket = DEEPBOOK_BASKETS.find((b) => b.id === args.basketId);
  if (!basket) throw new Error(`unknown basket ${args.basketId}; valid: ${DEEPBOOK_BASKETS.map((b) => b.id).join(', ')}`);
  const strip = await previewStrip({
    oracle: args.oracle, muRaw: args.forwardRaw, sigmaRaw: Math.round(args.forwardRaw * basket.sigma_pct), n: basket.n, budgetRaw: args.budgetRaw, sender: args.sender,
  });
  return { basket, strip };
}

export { DUSDC };
