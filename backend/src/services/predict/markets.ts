/**
 * Markets-depth snapshot for DeepBook Predict (testnet, BTC-only).
 *
 * Surfaces ALL the live DeepBook data the frontend needs in one call: a vault
 * block (from /vault/summary) plus one resilient row per active oracle with its
 * live forward, ATM IV, SVI skew, ATM binary-up, and grid params. Everything is
 * indexer-derived (forward from the latest price tick, IV/skew from the live SVI
 * smile) — nothing fabricated. Oracles missing a forward or SVI are skipped.
 */
import { predictServer, type PredictOracle } from './server';
import { decodeSvi, sviImpliedVol } from './vol';

const PRICE_SCALE = 1_000_000_000; // 1e9 strike / forward / SVI fixed-point
const DUSDC_SCALE = 1_000_000; // 1e6 dUSDC raw -> USD
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const SKEW_MONEYNESS = 0.1; // ±10% strikes for the smile skew measure
const MAX_MARKETS = 24; // cap at the nearest active oracles

export interface MarketRow {
  oracle_id: string;
  expiry: number;
  tenor_label: string;
  forward_usd: number;
  atm_iv: number;
  /** iv@-10% − iv@+10% off the SVI smile, in vol points (down-skew > 0). */
  skew: number;
  /** N(d2) at K=forward = risk-neutral P(settle > forward). */
  binary_up_atm: number;
  min_strike_usd: number;
  tick_size_usd: number;
}

export interface MarketsDepth {
  vault: {
    tvl_usd: number;
    share_price: number;
    utilization: number;
    total_max_payout_usd: number;
  };
  markets: MarketRow[];
}

// --- standard normal CDF (A&S 7.1.26), matching structured.ts / density.ts ---
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Human tenor from a duration in ms: "45s","16m","1h","4h","1d","3d". */
function tenorLabel(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  const min = s / 60;
  if (min < 90) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 36) return `${Math.round(h)}h`;
  const d = h / 24;
  return `${Math.round(d)}d`;
}

/** Read a numeric forward (1e9 USD) from a latest-price tick, resiliently. */
function forwardFromTick(tick: Record<string, unknown>): number | null {
  for (const k of ['forward', 'spot', 'mark', 'price', 'underlying_price']) {
    const n = Number(tick[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Build the markets-depth snapshot for `underlying` (BTC on testnet).
 *
 * Pulls /vault/summary for the vault block and, per nearest active oracle, the
 * live forward + SVI smile to derive ATM IV, ±10% skew, and the ATM binary-up
 * N(d2). Oracles missing a forward or SVI are skipped resiliently.
 */
export async function buildMarketsDepth(underlying = 'BTC'): Promise<MarketsDepth> {
  const now = Date.now();
  const want = underlying.toUpperCase();

  const [vaultRaw, all] = await Promise.all([
    predictServer.vaultSummary().catch(() => ({}) as Record<string, unknown>),
    predictServer.predictOracles().catch(() => predictServer.oracles()),
  ]);

  const active = all
    .filter(
      (o: PredictOracle) =>
        o.status === 'active' &&
        o.expiry > now &&
        (o.underlying_asset ?? '').toUpperCase() === want,
    )
    .sort((a, b) => a.expiry - b.expiry)
    .slice(0, MAX_MARKETS);

  // Each row is an independent price+SVI round-trip; fan them out concurrently and
  // preserve the (expiry-sorted) ordering by mapping then filtering nulls.
  const built = await Promise.all(
    active.map(async (o): Promise<MarketRow | null> => {
      const [priceRes, sviRes] = await Promise.all([
        predictServer.oraclePriceLatest(o.oracle_id).catch(() => null),
        predictServer.oracleSviLatest(o.oracle_id).catch(() => null),
      ]);
      if (!priceRes || !sviRes) return null; // skip: missing forward/SVI
      const fwdRaw = forwardFromTick(priceRes);
      const params = decodeSvi(sviRes);
      if (fwdRaw === null || !params) return null;

      const forwardUsd = fwdRaw / PRICE_SCALE;
      const tYears = (o.expiry - now) / YEAR_MS;
      if (!(tYears > 0)) return null;

      const atmIv = sviImpliedVol(params, 0, tYears); // k = 0
      // SVI smile skew: iv at ln(0.9) (−10%) minus iv at ln(1.1) (+10%), in vol pts.
      const ivDown = sviImpliedVol(params, Math.log(1 - SKEW_MONEYNESS), tYears);
      const ivUp = sviImpliedVol(params, Math.log(1 + SKEW_MONEYNESS), tYears);
      const skew = ivDown - ivUp;
      // ATM binary-up = N(d2) at K=forward => d2 = -0.5·iv·√T; P(settle > forward).
      const sqrtT = Math.sqrt(tYears);
      const d2Atm = atmIv > 0 && sqrtT > 0 ? -0.5 * atmIv * sqrtT : 0;
      const binaryUpAtm = normalCdf(d2Atm);

      return {
        oracle_id: o.oracle_id,
        expiry: o.expiry,
        tenor_label: tenorLabel(o.expiry - now),
        forward_usd: forwardUsd,
        atm_iv: atmIv,
        skew,
        binary_up_atm: binaryUpAtm,
        min_strike_usd: o.min_strike / PRICE_SCALE,
        tick_size_usd: o.tick_size / PRICE_SCALE,
      };
    }),
  );
  const markets: MarketRow[] = built.filter((r): r is MarketRow => r !== null);

  const num = (k: string): number => {
    const n = Number((vaultRaw as Record<string, unknown>)[k]);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    vault: {
      tvl_usd: num('vault_value') / DUSDC_SCALE, // dUSDC 1e6 -> USD
      share_price: num('plp_share_price'), // already a ratio
      utilization: num('utilization'), // already a fraction
      total_max_payout_usd: num('total_max_payout') / DUSDC_SCALE,
    },
    markets,
  };
}
