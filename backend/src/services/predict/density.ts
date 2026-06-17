/**
 * Real SVI-implied risk-neutral DENSITY for DeepBook Predict (testnet, BTC-only).
 *
 * The Distribution page used to draw f(x) as a single-σ Normal. That is wrong:
 * DeepBook prices every market off a per-oracle SVI *smile*, so the true
 * market-implied settlement distribution is SKEWED with FAT TAILS — not a
 * Normal(forward, ATM_iv·forward·√T).
 *
 * We reconstruct it straight from the live indexer (nothing fabricated):
 *
 *   forward  = latest price tick `forward` / 1e9            (the oracle's own mark)
 *   SVI      = /oracles/:id/svi/latest, decoded (reuse vol.ts decode)
 *   T        = (expiry - now) / year
 *
 * For each strike K on a grid forward·(1 ± spanPct):
 *   k    = ln(K / forward)                                   (log-moneyness)
 *   iv   = SVI iv at k  (the SMILE iv — captures skew, NOT a single ATM σ)
 *   d2   = (ln(forward / K) - 0.5·iv²·T) / (iv·√T)
 *   CDF  = P(settle ≤ K) = N(-d2)                            (risk-neutral)
 *
 * pdf = d(CDF)/dK by central differences, then normalized so Σ pdf·dK ≈ 1.
 * The result is the protocol's own implied density: a skew/kurtosis-bearing curve
 * whose tails are fatter than a Normal with the ATM vol, because each wing strike
 * is priced at its OWN (higher) smile vol.
 */
import { predictServer, findActiveOracle, snapStrikeToGrid, type PredictOracle } from './server';
import { decodeSvi, sviImpliedVol } from './vol';
import { previewTrade } from './index';

const PRICE_SCALE = 1_000_000_000; // 1e9 strike / forward / SVI fixed-point
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export interface ImpliedDensity {
  oracle_id: string;
  expiry: number;
  forward_usd: number;
  t_years: number;
  atm_iv: number;
  x: number[];
  pdf: number[];
  cdf: number[];
}

// --- standard normal CDF (Abramowitz & Stegun 7.1.26), matching structured.ts ---
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

/** Read a numeric forward (1e9 USD) from a latest-price tick, resiliently. */
function forwardFromTick(tick: Record<string, unknown>): number | null {
  for (const k of ['forward', 'spot', 'mark', 'price', 'underlying_price']) {
    const n = Number(tick[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Build the live SVI-implied risk-neutral density for one oracle.
 *
 * Resolves the oracle (given `oracleId`, else the soonest active BTC oracle),
 * pulls its live forward + latest SVI, decodes the smile, and integrates the
 * Black-style risk-neutral CDF N(-d2) across a strike grid — then differentiates
 * + normalizes to a pdf. Throws 'no oracle' so the route can 404.
 */
export async function buildImpliedDensity(
  oracleId?: string,
  steps = 121,
  spanPct = 0.18,
): Promise<ImpliedDensity> {
  const now = Date.now();

  // 1) Resolve the oracle: explicit id (from /oracles/:id/state) else soonest active BTC.
  type ResolvedOracle = Pick<PredictOracle, 'oracle_id' | 'expiry' | 'min_strike' | 'tick_size'>;
  let oracle: ResolvedOracle | null = null;
  if (oracleId) {
    const st = (await predictServer.oracleState(oracleId).catch(() => null)) as {
      oracle?: ResolvedOracle;
    } | null;
    if (st?.oracle) oracle = st.oracle;
  } else {
    const o = await findActiveOracle('BTC');
    if (o) oracle = { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size };
  }
  if (!oracle) throw new Error('no oracle');

  // 2) Live forward (latest price tick) + latest SVI smile.
  const [priceRes, sviRes] = await Promise.all([
    predictServer.oraclePriceLatest(oracle.oracle_id).catch(() => null),
    predictServer.oracleSviLatest(oracle.oracle_id).catch(() => null),
  ]);
  if (!priceRes || !sviRes) throw new Error('no oracle');
  const fwdRaw = forwardFromTick(priceRes);
  const params = decodeSvi(sviRes);
  if (fwdRaw === null || !params) throw new Error('no oracle');

  const forwardUsd = fwdRaw / PRICE_SCALE;
  const tYears = (oracle.expiry - now) / YEAR_MS;
  if (!(tYears > 0)) throw new Error('oracle expired');

  const atmIv = sviImpliedVol(params, 0, tYears); // k = 0 (strike == forward)
  const sqrtT = Math.sqrt(tYears);

  // 3) Strike grid — span ±~4.5σ of the tenor's own implied move (capped at the
  // requested spanPct), so short-dated tenors fill the grid as a proper bell
  // instead of collapsing to a spike on a too-wide fixed window.
  const n = Math.max(11, Math.floor(steps));
  const sigmaFrac = Math.max(atmIv * sqrtT, 1e-6);
  const span = Math.min(spanPct, Math.min(0.4, Math.max(0.02, 4.5 * sigmaFrac)));
  const lo = forwardUsd * (1 - span);
  const hi = forwardUsd * (1 + span);
  const dK = (hi - lo) / (n - 1);

  // 4) Risk-neutral CDF P(settle ≤ K) = N(-d2) using the SMILE iv at each strike.
  const x: number[] = new Array(n);
  const cdf: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const K = lo + i * dK;
    const k = Math.log(K / forwardUsd);
    const iv = sviImpliedVol(params, k, tYears);
    // d2 = (ln(F/K) - 0.5·iv²·T) / (iv·√T); P(settle ≤ K) = N(-d2).
    const denom = iv * sqrtT;
    const d2 = denom > 0 ? (Math.log(forwardUsd / K) - 0.5 * iv * iv * tYears) / denom : 0;
    x[i] = K;
    cdf[i] = normalCdf(-d2);
  }

  // 5) pdf = dCDF/dK by central differences (one-sided at the ends).
  const pdf: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) pdf[i] = (cdf[1] - cdf[0]) / dK;
    else if (i === n - 1) pdf[i] = (cdf[n - 1] - cdf[n - 2]) / dK;
    else pdf[i] = (cdf[i + 1] - cdf[i - 1]) / (2 * dK);
  }
  // Clamp tiny negatives from numerical noise, then NORMALIZE so Σ pdf·dK ≈ 1
  // over the surfaced span (the grid is truncated, so renormalize on it).
  let mass = 0;
  for (let i = 0; i < n; i++) {
    if (pdf[i] < 0) pdf[i] = 0;
    mass += pdf[i] * dK;
  }
  if (mass > 0) {
    for (let i = 0; i < n; i++) pdf[i] /= mass;
  }

  // Cross-check (best-effort, NON-blocking): our binary-up = N(d2) at ATM and
  // ±10% vs the protocol's own previewTrade up-leg price (mint_cost/1e6) at the
  // grid-snapped strikes. Logged for sanity, never thrown — settled/edge markets
  // can reject devInspect pricing.
  void crossCheckPreviewTrade(oracle, forwardUsd, params, tYears, sqrtT).catch(() => {});

  return {
    oracle_id: oracle.oracle_id,
    expiry: oracle.expiry,
    forward_usd: forwardUsd,
    t_years: tYears,
    atm_iv: atmIv,
    x,
    pdf,
    cdf,
  };
}

/** Model binary-up = N(d2) at K (using the smile iv there) vs forward. */
function modelUp(
  params: import('./vol').SviParams,
  forwardUsd: number,
  K: number,
  tYears: number,
  sqrtT: number,
): number {
  const k = Math.log(K / forwardUsd);
  const iv = sviImpliedVol(params, k, tYears);
  const denom = iv * sqrtT;
  const d2 = denom > 0 ? (Math.log(forwardUsd / K) - 0.5 * iv * iv * tYears) / denom : 0;
  return normalCdf(d2); // P(settle > K)
}

/**
 * NON-blocking sanity cross-check: log our model's N(d2) up-probability vs the
 * protocol's own previewTrade up-leg price (mint_cost/1e6 ≈ implied up-prob) at
 * the grid-snapped ATM and ±10% strikes. Never throws.
 */
async function crossCheckPreviewTrade(
  oracle: Pick<PredictOracle, 'oracle_id' | 'expiry' | 'min_strike' | 'tick_size'>,
  forwardUsd: number,
  params: import('./vol').SviParams,
  tYears: number,
  sqrtT: number,
): Promise<void> {
  const targets: Array<{ label: string; usd: number }> = [
    { label: '-10%', usd: forwardUsd * 0.9 },
    { label: 'ATM', usd: forwardUsd },
    { label: '+10%', usd: forwardUsd * 1.1 },
  ];
  const lines: string[] = [];
  for (const t of targets) {
    const strikeRaw = snapStrikeToGrid(
      { min_strike: oracle.min_strike, tick_size: oracle.tick_size } as PredictOracle,
      Math.round(t.usd * PRICE_SCALE),
    );
    const modelUpProb = modelUp(params, forwardUsd, strikeRaw / PRICE_SCALE, tYears, sqrtT);
    let mktUpProb: number | null = null;
    try {
      const pv = await previewTrade({
        key: { oracleId: oracle.oracle_id, expiry: String(oracle.expiry), strike: String(strikeRaw), isUp: true },
        quantity: 1_000_000n, // 1 contract = $1
      });
      mktUpProb = Number(pv.mint_cost) / 1_000_000; // mint_cost (1e6) / $1 ≈ up-prob
    } catch {
      mktUpProb = null;
    }
    lines.push(
      `${t.label}@$${(strikeRaw / PRICE_SCALE).toFixed(0)}: model=${modelUpProb.toFixed(4)}` +
        (mktUpProb !== null
          ? ` previewTrade=${mktUpProb.toFixed(4)} (Δ=${(modelUpProb - mktUpProb).toFixed(4)})`
          : ' previewTrade=n/a'),
    );
  }
  console.log(`[density] previewTrade cross-check ${oracle.oracle_id.slice(0, 10)}…: ${lines.join('  ')}`);
}
