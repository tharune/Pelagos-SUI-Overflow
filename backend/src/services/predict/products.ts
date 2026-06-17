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

// ---------------------------------------------------------------------------
// TERM BASKETS — calendar bundles across BTC expiries (distinct from the
// single-expiry Distribution product). One ticket holds a central strip on each
// of several live tenors, so you own a slice of the whole BTC term structure.
// ---------------------------------------------------------------------------

function shortTenor(ms: number): string {
  if (ms <= 0) return 'expired';
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export interface TermBasketRecipe {
  id: string;
  name: string;
  description: string;
  /** Pick which tenor indices (into the expiry-sorted live oracle list) the basket spans. */
  pick: (n: number) => number[];
}

export const DEEPBOOK_TERM_BASKETS: TermBasketRecipe[] = [
  { id: 'near-ladder', name: 'Near Ladder', description: 'Equal weight across the three nearest expiries — smooth near-term coverage.', pick: (n) => [0, 1, 2].filter((i) => i < n) },
  { id: 'barbell', name: 'Barbell', description: 'Nearest + farthest expiry — short-dated response plus long-dated coverage.', pick: (n) => (n >= 2 ? [0, n - 1] : [0]) },
  { id: 'full-term', name: 'Full Term', description: 'Equal weight across every live expiry — the whole BTC term structure in one ticket.', pick: (n) => Array.from({ length: n }, (_, i) => i) },
];

interface TermOracle extends GridOracle { forward_raw: number; tenor_label: string; t_years: number; }

/** Live BTC oracles (active, ≥6m to expiry) sorted near→far, each with its live forward. */
async function resolveTermOracles(asset: string): Promise<TermOracle[]> {
  const now = Date.now();
  const want = asset.toUpperCase();
  const oracles = await predictServer.predictOracles().catch(() => predictServer.oracles());
  const active = oracles
    .filter((o) => o.status === 'active' && o.expiry > now + 6 * 60_000)
    .filter((o) => o.underlying_asset?.toUpperCase() === want)
    .sort((a, b) => a.expiry - b.expiry);
  return Promise.all(
    active.map(async (o) => {
      const p = (await predictServer.oraclePriceLatest(o.oracle_id).catch(() => null)) as { forward?: number; spot?: number } | null;
      const fwd = Number(p?.forward ?? p?.spot ?? o.min_strike);
      return {
        oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size,
        forward_raw: fwd, tenor_label: shortTenor(o.expiry - now), t_years: (o.expiry - now) / YEAR_MS,
      };
    }),
  );
}

export interface TermBasketLeg {
  oracle_id: string;
  expiry: string;
  tenor_label: string;
  t_years: number;
  forward_usd: number;
  weight: number;
  strip: StripQuote;
}

export interface TermBasketQuote {
  basket: { id: string; name: string; description: string };
  legs: TermBasketLeg[];
  total_cost_raw: string;
  total_best_raw: string;        // Σ realized best across legs (independent expiries)
  round_trip_spread_raw: string;
  forward_usd: number;
  dusdc_decimals: number;
}

/** Price a term basket: equal-weight the budget across the recipe's tenors and
 *  price each leg's central strip through the real MM (previewStrip). */
export async function quoteTermBasket(args: { asset: string; basketId: string; budgetRaw: bigint; sender?: string }): Promise<TermBasketQuote> {
  const recipe = DEEPBOOK_TERM_BASKETS.find((b) => b.id === args.basketId);
  if (!recipe) throw new Error(`unknown term basket ${args.basketId}; valid: ${DEEPBOOK_TERM_BASKETS.map((b) => b.id).join(', ')}`);
  const oracles = await resolveTermOracles(args.asset);
  if (oracles.length === 0) throw new Error(`no active ${args.asset} oracles`);
  const picked = recipe.pick(oracles.length).map((i) => oracles[i]).filter((o): o is TermOracle => Boolean(o));
  if (picked.length === 0) throw new Error('term basket resolved no legs');
  const perLeg = args.budgetRaw / BigInt(picked.length);
  const weight = 1 / picked.length;
  const legs = await Promise.all(
    picked.map(async (o): Promise<TermBasketLeg> => {
      const sigma = await impliedSigmaRaw(o, o.forward_raw, Math.max(o.tick_size, Math.round(o.forward_raw * 0.005)));
      const strip = await previewStrip({ oracle: o, muRaw: o.forward_raw, sigmaRaw: sigma, n: 4, budgetRaw: perLeg, sender: args.sender });
      return { oracle_id: o.oracle_id, expiry: String(o.expiry), tenor_label: o.tenor_label, t_years: o.t_years, forward_usd: o.forward_raw / 1e9, weight, strip };
    }),
  );
  const sum = (f: (s: StripQuote) => string) => legs.reduce((a, l) => a + BigInt(f(l.strip)), 0n);
  return {
    basket: { id: recipe.id, name: recipe.name, description: recipe.description },
    legs,
    total_cost_raw: sum((s) => s.total_cost_raw).toString(),
    total_best_raw: sum((s) => s.realized_max_payout_raw).toString(),
    round_trip_spread_raw: sum((s) => s.round_trip_spread_raw).toString(),
    forward_usd: picked[0].forward_raw / 1e9,
    dusdc_decimals: 6,
  };
}

export { DUSDC };
