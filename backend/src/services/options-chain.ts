/**
 * Live OPTIONS CHAIN derived from the DeepBook Predict SVI vol surface.
 *
 * DeepBook Predict only natively trades binaries / ranges, but it publishes a
 * full per-oracle SVI implied-vol smile + a live on-chain forward. That is
 * exactly the input a vanilla option needs, so we synthesize a real European
 * options chain on top of it:
 *
 *   forward F   = the oracle's live price tick `forward` / 1e9        (on-chain)
 *   iv(K)       = SVI smile vol at log-moneyness ln(K/F)              (real IV)
 *   T           = (expiry - now) / year
 *   call/put    = Black-76 on (F, K, iv, T) with r = 0               (forward-priced)
 *   greeks      = analytic Black-76 delta / gamma / vega / theta
 *
 * Nothing here is fabricated as "market" — the IVs and the forward are the
 * protocol's own live surface; the option premia are Black-76 *derived* from
 * them, and the `source` field documents exactly that. Each strike is marked
 * `tradeable` when it snaps onto the oracle's on-chain strike grid (so the UI
 * can route a real binary/range order to Predict at that strike).
 *
 * We reuse the surface decode (decodeSvi) and smile evaluator (sviImpliedVol)
 * from vol.ts rather than re-deriving the SVI math, and snapStrikeToGrid /
 * predictServer from the Predict client. Cached ~5s like the other live reads.
 */
import {
  predictServer,
  snapStrikeToGrid,
  type PredictOracle,
} from './predict/server';
import { decodeSvi, sviImpliedVol } from './predict/vol';

const PRICE_SCALE = 1_000_000_000; // 1e9 strike / forward / SVI fixed-point
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const MAX_EXPIRIES = 12; // cap at the ~12 nearest expiries
const CACHE_TTL_MS = 5_000;

const MONEYNESS_LO = 0.8;
const MONEYNESS_HI = 1.2;
const STRIKE_STEPS = 13; // 13 strikes across 0.8..1.2 moneyness
const SPREAD_PCT = 0.02; // synthetic bid/ask = mid ± 1% (2% wide)

export interface OptionQuote {
  mid: number;
  bid: number;
  ask: number;
  iv: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  tradeable: boolean;
}

export interface OptionStrikeRow {
  strike: number;
  moneyness: number;
  call: OptionQuote;
  put: OptionQuote;
}

export interface OptionExpiry {
  oracle_id: string;
  expiry: number;
  tenor_label: string;
  days_to_expiry: number;
  forward: number;
  atm_iv: number;
  strikes: OptionStrikeRow[];
}

export interface OptionsChain {
  underlying: string;
  spot: number;
  generated_at: string;
  source: string;
  expiries: OptionExpiry[];
}

// --- standard normal pdf/cdf (Abramowitz & Stegun 7.1.26), matching density.ts ---
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
function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
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
 * Black-76 (forward-priced, r = 0) call & put premia + analytic greeks for one
 * strike. `iv` is the strike's own smile vol (so the chain carries the surface's
 * skew, not a single ATM σ). Delta/gamma are spot-equivalent (∂/∂F), vega is per
 * 1.00 vol (i.e. per 100 vol-points), theta is per CALENDAR DAY (negative for
 * long options). Degenerate T→0 / σ→0 collapses to intrinsic with hard greeks.
 */
function black76(
  forward: number,
  strike: number,
  iv: number,
  tYears: number,
): { call: Omit<OptionQuote, 'tradeable'>; put: Omit<OptionQuote, 'tradeable'> } {
  const sqrtT = Math.sqrt(Math.max(tYears, 0));
  const sigmaT = iv * sqrtT;

  // Degenerate slice (essentially at expiry or zero vol) → intrinsic value.
  if (!(sigmaT > 1e-9) || !(forward > 0) || !(strike > 0)) {
    const callIntrinsic = Math.max(forward - strike, 0);
    const putIntrinsic = Math.max(strike - forward, 0);
    const callDelta = forward > strike ? 1 : 0;
    return {
      call: { mid: callIntrinsic, bid: 0, ask: 0, iv, delta: callDelta, gamma: 0, vega: 0, theta: 0 },
      put: { mid: putIntrinsic, bid: 0, ask: 0, iv, delta: callDelta - 1, gamma: 0, vega: 0, theta: 0 },
    };
  }

  const d1 = (Math.log(forward / strike) + 0.5 * sigmaT * sigmaT) / sigmaT;
  const d2 = d1 - sigmaT;
  const Nd1 = normalCdf(d1);
  const Nd2 = normalCdf(d2);
  const nd1 = normalPdf(d1);

  // Premia (r = 0 ⇒ no discount factor).
  const callMid = forward * Nd1 - strike * Nd2;
  const putMid = strike * normalCdf(-d2) - forward * normalCdf(-d1);

  // Greeks (r = 0). delta = ∂V/∂F, gamma = ∂²V/∂F², vega = ∂V/∂σ, theta = ∂V/∂t.
  const callDelta = Nd1;
  const putDelta = Nd1 - 1;
  const gamma = nd1 / (forward * sigmaT);
  const vega = forward * nd1 * sqrtT; // per 1.00 of vol
  // theta = -F·n(d1)·σ / (2√T)  [annualized] → per calendar day.
  const thetaAnnual = (-forward * nd1 * iv) / (2 * sqrtT);
  const thetaDay = thetaAnnual / 365.25;

  const halfSpread = SPREAD_PCT / 2;
  const quote = (mid: number, delta: number): Omit<OptionQuote, 'tradeable'> => ({
    mid,
    bid: Math.max(0, mid * (1 - halfSpread)),
    ask: mid * (1 + halfSpread),
    iv,
    delta,
    gamma,
    vega,
    theta: thetaDay,
  });

  return {
    call: quote(callMid, callDelta),
    put: quote(putMid, putDelta),
  };
}

/**
 * Build the live options chain for `underlying` off the SVI surface.
 *
 * Picks the nearest active expiries (matching underlying, future expiry), pulls
 * each oracle's live forward + SVI smile, and prices a CALL + PUT at every
 * strike on a moneyness grid (0.8..1.2 × forward) via Black-76 using the smile
 * IV at each strike. A strike is `tradeable` when it snaps onto the oracle's
 * on-chain strike grid within half a tick (so the UI can route a Predict order
 * there). Slices missing a forward / SVI are skipped resiliently.
 */
export async function buildOptionsChain(underlying = 'BTC'): Promise<OptionsChain> {
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
    .slice(0, MAX_EXPIRIES);

  const expiries: OptionExpiry[] = [];
  let spot = 0;

  for (const o of active) {
    const [priceRes, sviRes] = await Promise.all([
      predictServer.oraclePriceLatest(o.oracle_id).catch(() => null),
      predictServer.oracleSviLatest(o.oracle_id).catch(() => null),
    ]);
    if (!priceRes || !sviRes) continue;
    const fwdRaw = forwardFromTick(priceRes);
    const params = decodeSvi(sviRes);
    if (fwdRaw === null || !params) continue;

    const forward = fwdRaw / PRICE_SCALE;
    const tYears = (o.expiry - now) / YEAR_MS;
    if (!(tYears > 0)) continue;
    if (spot === 0) {
      // Use the nearest-expiry spot tick as the chain spot (forward of the front).
      const spotRaw = Number((priceRes as Record<string, unknown>).spot);
      spot = Number.isFinite(spotRaw) && spotRaw > 0 ? spotRaw / PRICE_SCALE : forward;
    }

    const atmIv = sviImpliedVol(params, 0, tYears); // k = 0 (strike == forward)
    const halfTick = (o.tick_size || 0) / 2;

    const strikes: OptionStrikeRow[] = [];
    const step = (MONEYNESS_HI - MONEYNESS_LO) / (STRIKE_STEPS - 1);
    for (let i = 0; i < STRIKE_STEPS; i++) {
      const moneyness = MONEYNESS_LO + i * step;
      const strike = forward * moneyness;
      const k = Math.log(strike / forward); // = ln(moneyness)
      const iv = sviImpliedVol(params, k, tYears);

      // Tradeable iff this strike snaps onto the oracle's on-chain grid within
      // half a tick (otherwise Predict's pricing_config aborts off-grid).
      const strikeRaw = Math.round(strike * PRICE_SCALE);
      const snapped = snapStrikeToGrid(o, strikeRaw);
      const tradeable =
        halfTick > 0 ? Math.abs(snapped - strikeRaw) <= halfTick * PRICE_SCALE : false;

      const { call, put } = black76(forward, strike, iv, tYears);
      strikes.push({
        strike,
        moneyness,
        call: { ...call, tradeable },
        put: { ...put, tradeable },
      });
    }

    expiries.push({
      oracle_id: o.oracle_id,
      expiry: o.expiry,
      tenor_label: tenorLabel(o.expiry - now),
      days_to_expiry: tYears * 365.25,
      forward,
      atm_iv: atmIv,
      strikes,
    });
  }

  if (expiries.length === 0) {
    throw new Error('no active oracles');
  }
  if (spot === 0) spot = expiries[0].forward;

  return {
    underlying: want,
    spot,
    generated_at: new Date().toISOString(),
    source: 'black76-on-live-svi-surface',
    expiries,
  };
}

// ---------------------------------------------------------------------------
// Cached entry point (~5s, like the other live indexer reads)
// ---------------------------------------------------------------------------

const _cache = new Map<string, { at: number; chain: OptionsChain }>();
let _inflight = new Map<string, Promise<OptionsChain>>();

export async function getOptionsChain(underlying = 'BTC'): Promise<OptionsChain> {
  const key = underlying.toUpperCase();
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.chain;
  const existing = _inflight.get(key);
  if (existing) return existing;

  const p = buildOptionsChain(key)
    .then((chain) => {
      _cache.set(key, { at: Date.now(), chain });
      return chain;
    })
    .finally(() => {
      _inflight.delete(key);
    });
  _inflight.set(key, p);
  return p;
}
