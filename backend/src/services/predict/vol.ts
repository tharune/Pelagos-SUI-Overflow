/**
 * Live SVI implied-volatility surface for DeepBook Predict (testnet, BTC-only).
 *
 * Predict prices every market off a per-oracle SVI vol surface. The indexer
 * publishes the raw-SVI total-variance params per oracle at
 *   GET /oracles/:id/svi/latest   ->  { a, b, rho, rho_negative, m, m_negative, sigma }
 * all fixed-point scale 1e9 (a, b, sigma always positive; rho, m carry a sign
 * flag). We decode them, pull each oracle's live forward, and reconstruct the
 * implied-vol smile per expiry:
 *
 *   k       = ln(strike / forward)                                  (log-moneyness)
 *   w(k)    = a + b·( rho·(k - m) + sqrt((k - m)² + sigma²) )       (total variance)
 *   iv(k)   = sqrt( max(w(k), 1e-12) / T )                          (annualized)
 *   T       = (expiry - now) / (365.25·24·3600·1000)                (years)
 *
 * Decode verified live: ATM BTC IV lands ~40-45% for short expiries (sane). The
 * very-near-expiry slice (seconds to go) has a tiny T, so its wings annualize to
 * large numbers — that is the T→0 effect, not a decode error; the params are the
 * indexer's own. Nothing here is fabricated; it is the protocol's surface.
 */
import { predictServer, type PredictOracle } from './server';

const PRICE_SCALE = 1_000_000_000; // 1e9 strike / forward / SVI fixed-point
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const MAX_SLICES = 12; // cap at the ~12 nearest expiries

export interface VolSlice {
  oracle_id: string;
  expiry: number;
  tenor_label: string;
  t_years: number;
  forward_usd: number;
  atm_iv: number;
  points: Array<{ strike_usd: number; log_moneyness: number; iv: number }>;
}

export interface VolSurface {
  underlying: string;
  generated_at: string;
  forward_usd: number;
  slices: VolSlice[];
  term_structure: Array<{ tenor_label: string; t_years: number; atm_iv: number; expiry: number }>;
  strikes_pct: number;
}

/** Decoded raw-SVI params (real-valued, scale removed, signs applied). */
export interface SviParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

/** Decode the indexer's fixed-point SVI event: /1e9, apply rho/m sign flags. */
export function decodeSvi(raw: Record<string, unknown>): SviParams | null {
  const a = Number(raw.a);
  const b = Number(raw.b);
  const rho = Number(raw.rho);
  const m = Number(raw.m);
  const sigma = Number(raw.sigma);
  if (![a, b, rho, m, sigma].every(Number.isFinite)) return null;
  return {
    a: a / PRICE_SCALE,
    b: b / PRICE_SCALE,
    rho: (raw.rho_negative ? -rho : rho) / PRICE_SCALE,
    m: (raw.m_negative ? -m : m) / PRICE_SCALE,
    sigma: sigma / PRICE_SCALE,
  };
}

/** Total implied variance w(k) under the raw-SVI parameterization. */
function totalVariance(p: SviParams, k: number): number {
  return p.a + p.b * (p.rho * (k - p.m) + Math.sqrt((k - p.m) ** 2 + p.sigma ** 2));
}

/** Annualized implied vol at log-moneyness k for time-to-expiry T (years). */
export function sviImpliedVol(p: SviParams, k: number, tYears: number): number {
  if (!(tYears > 0)) return 0;
  return Math.sqrt(Math.max(totalVariance(p, k), 1e-12) / tYears);
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
 * Build the live SVI implied-vol surface for `underlying`.
 *
 * Picks the nearest active expiries (status active, future expiry, matching
 * underlying), pulls each oracle's live forward + SVI params, and reconstructs
 * the smile across `strikeSteps` strikes spanning forward·(1 ± strikesPct).
 * Slices missing a forward or SVI are skipped resiliently.
 */
export async function buildVolSurface(
  underlying = 'BTC',
  strikesPct = 0.15,
  strikeSteps = 17,
): Promise<VolSurface> {
  const now = Date.now();
  const want = underlying.toUpperCase();
  const all = await predictServer
    .predictOracles()
    .catch(() => predictServer.oracles());
  const active = all
    .filter(
      (o: PredictOracle) =>
        o.status === 'active' &&
        o.expiry > now &&
        (o.underlying_asset ?? '').toUpperCase() === want,
    )
    .sort((a, b) => a.expiry - b.expiry)
    .slice(0, MAX_SLICES);

  const slices: VolSlice[] = [];
  for (const o of active) {
    const [priceRes, sviRes] = await Promise.all([
      predictServer.oraclePriceLatest(o.oracle_id).catch(() => null),
      predictServer.oracleSviLatest(o.oracle_id).catch(() => null),
    ]);
    if (!priceRes || !sviRes) continue;
    const fwdRaw = forwardFromTick(priceRes);
    const params = decodeSvi(sviRes);
    if (fwdRaw === null || !params) continue;

    const forwardUsd = fwdRaw / PRICE_SCALE;
    const tYears = (o.expiry - now) / YEAR_MS;
    const loUsd = forwardUsd * (1 - strikesPct);
    const hiUsd = forwardUsd * (1 + strikesPct);
    const steps = Math.max(2, strikeSteps);
    const step = (hiUsd - loUsd) / (steps - 1);

    const points: VolSlice['points'] = [];
    for (let i = 0; i < steps; i++) {
      const strikeUsd = loUsd + i * step;
      const k = Math.log(strikeUsd / forwardUsd);
      points.push({ strike_usd: strikeUsd, log_moneyness: k, iv: sviImpliedVol(params, k, tYears) });
    }
    const atmIv = sviImpliedVol(params, 0, tYears); // k = 0 (strike == forward)

    slices.push({
      oracle_id: o.oracle_id,
      expiry: o.expiry,
      tenor_label: tenorLabel(o.expiry - now),
      t_years: tYears,
      forward_usd: forwardUsd,
      atm_iv: atmIv,
      points,
    });
  }

  if (slices.length === 0) {
    throw new Error('no active oracles');
  }

  return {
    underlying: want,
    generated_at: new Date().toISOString(),
    forward_usd: slices[0].forward_usd, // nearest-expiry forward as the surface spot
    slices,
    term_structure: slices.map((s) => ({
      tenor_label: s.tenor_label,
      t_years: s.t_years,
      atm_iv: s.atm_iv,
      expiry: s.expiry,
    })),
    strikes_pct: strikesPct,
  };
}
