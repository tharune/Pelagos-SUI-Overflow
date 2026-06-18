/**
 * Live BTC options chain — priced on the REAL DeepBook Predict liquidity, not a model.
 *
 * DeepBook Predict natively trades on-chain RANGE positions (1 contract = $1 payout
 * if settlement lands in the band). A vanilla strike maps cleanly onto two ranges:
 *
 *   CALL @ K  ≡  range [K, K_far]      → pays $1 if BTC settles ABOVE K
 *   PUT  @ K  ≡  range [K_floor, K]    → pays $1 if BTC settles BELOW K
 *
 * Every premium here is the protocol's OWN price for that range, read live via
 * `get_range_trade_amounts` (devInspect) — the same call the market-maker prices
 * against, so it already bakes in the AMM/vault spread + the slippage of the
 * liability the order adds. We surface BOTH sides directly:
 *
 *   ask = mint_cost   (what you pay to BUY/underwrite the contract)
 *   bid = redeem_payout (what the desk pays to BUY IT BACK / you sell)
 *   mid = (bid + ask) / 2
 *
 * There is NO synthetic spread and NO Black-76 premium. The IV column is the
 * oracle's live SVI smile (real surface, shown for context); the greeks are the
 * digital risk sensitivities off that surface, bounded for display. Contracts are
 * WHOLE — 1 contract = $1 max payout, priced 0..1 dUSDC. A strike is `tradeable`
 * when its live ask sits inside the protocol's mintable [2%,98%] window.
 *
 * Sourcing: forward + SVI from the public Predict indexer; prices from a single
 * batched on-chain devInspect per expiry. `source` documents this. Cached ~4s so
 * the chain tracks the oracle in near-real-time without hammering the RPC.
 */
import {
  predictServer,
  snapStrikeToGrid,
  type PredictOracle,
} from './predict/server';
import { decodeSvi, sviImpliedVol } from './predict/vol';
import { previewRangeBatch } from './predict/index';

const PRICE_SCALE = 1_000_000_000; // 1e9 strike / forward / SVI fixed-point
const DUSDC_UNIT = 1_000_000; // 1e6 raw dUSDC; 1 contract (1e6 qty) pays $1
const CONTRACT_QTY = 1_000_000n; // 1 contract
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
// Span the FULL tenor ladder DeepBook lists (minutes → hours → days), one pill
// per distinct tenor. Testnet currently lists ~5m … 22d.
const MAX_EXPIRIES = 16;
const CACHE_TTL_MS = 4_000;

const STRIKE_STEPS = 13;
// Protocol mintable window on the per-contract ask (mirrors structured.ts).
const MIN_MINTABLE = 0.02;
const MAX_MINTABLE = 0.98;
// The strike grid scales with the IMPLIED MOVE (σ), not a fixed ±20% moneyness:
// these testnet oracles are minute/hour-dated, so the priceable + tradeable
// strikes sit within a few σ of the forward. A fixed 0.8–1.2× grid would be
// tens of σ out, where the on-chain range pricer aborts (off the SVI domain).
const GRID_SIGMA = 3; // strikes span forward ± 3σ
const WING_SIGMA = 4; // digital legs: call [K, F+4σ], put [F−4σ, K] (tail ≈ 0 mass)

export interface OptionQuote {
  mid: number; // per-contract premium (dUSDC, 0..1), REAL DeepBook mid
  bid: number; // REAL redeem-now payout per contract
  ask: number; // REAL mint cost per contract
  iv: number; // SVI smile vol (decimal) — real surface, context
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  tradeable: boolean; // ask inside the protocol's [2%,98%] mintable window
  /** raw on-chain band so the UI can route a real order at this strike/side. */
  lower_strike: string;
  higher_strike: string;
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
  /** $ payout of one whole contract (fixed; sizing is in WHOLE contracts). */
  contract_payout_usd: number;
  quote_basis: 'per-contract';
  expiries: OptionExpiry[];
}

// --- standard normal pdf/cdf (Abramowitz & Stegun) for the digital greeks ---
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

function tenorLabel(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  const min = s / 60;
  if (min < 90) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 36) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function forwardFromTick(tick: Record<string, unknown>): number | null {
  for (const k of ['forward', 'spot', 'mark', 'price', 'underlying_price']) {
    const n = Number(tick[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Digital (cash-or-nothing) risk sensitivities for a unit-payout binary, derived
 * from the live SVI IV. These are the model GREEKS shown for context — the
 * premium itself is the REAL DeepBook range price, not this. The digital call
 * value ≈ N(d2); we take analytic delta/gamma and finite-difference vega/theta
 * on that, then bound every greek for display (ultra-short testnet tenors make
 * the raw 1/√T sensitivities explode).
 */
function digitalGreeks(
  forward: number,
  strike: number,
  iv: number,
  tYears: number,
): { callDelta: number; putDelta: number; gamma: number; vega: number; theta: number } {
  const sqrtT = Math.sqrt(Math.max(tYears, 1e-9));
  const sigmaT = iv * sqrtT;
  if (!(sigmaT > 1e-9) || !(forward > 0) || !(strike > 0)) {
    return { callDelta: 0, putDelta: 0, gamma: 0, vega: 0, theta: 0 };
  }
  const d2 = (Math.log(forward / strike) - 0.5 * sigmaT * sigmaT) / sigmaT;
  const nd2 = normalPdf(d2);
  // ∂N(d2)/∂F = n(d2)·∂d2/∂F = n(d2)/(F·σ√T)
  let callDelta = nd2 / (forward * sigmaT);
  // ∂²/∂F² = -n(d2)·(d2 + σ√T)/(F²·σ²T)  (analytic second derivative)
  let gamma = (-nd2 * (d2 + sigmaT)) / (forward * forward * sigmaT * sigmaT);
  // vega/theta by central finite-difference on the digital value N(d2).
  const digit = (sig: number, t: number): number => {
    const st = sig * Math.sqrt(Math.max(t, 1e-9));
    if (!(st > 1e-12)) return forward > strike ? 1 : 0;
    return normalCdf((Math.log(forward / strike) - 0.5 * st * st) / st);
  };
  const dSig = Math.max(iv * 0.01, 1e-4);
  let vega = (digit(iv + dSig, tYears) - digit(iv - dSig, tYears)) / (2 * dSig) * 0.01; // per 1 vol-pt
  const dT = Math.max(tYears * 0.02, 1e-7);
  let theta = (digit(iv, tYears - dT) - digit(iv, tYears + dT)) / (2 * dT) / 365.25; // per day
  // Display bounds: a unit-payout digital can't sanely move more than ~1 per $
  // of forward / per vol-point / per day. Bound so testnet minute-tenors stay sane.
  const b = (x: number, lim: number) => Math.max(-lim, Math.min(lim, Number.isFinite(x) ? x : 0));
  // Express delta as the contract-value move per +1% in BTC — the intuitive,
  // readable form for a $1-payout digital (the raw ∂/∂$ is tiny). Peaks at ATM,
  // → 0 in the wings. Bounded for the ultra-short tenors.
  callDelta = b(callDelta * forward * 0.01, 2);
  gamma = b(gamma * forward * forward * 1e-4, 2); // per (1%)²
  vega = b(vega, 1);
  theta = b(theta, 1);
  return { callDelta, putDelta: -callDelta, gamma, vega, theta };
}

/**
 * Build the live options chain off REAL DeepBook range pricing. For each active
 * expiry we pull the forward + SVI, lay strikes on the moneyness grid (snapped to
 * the oracle's on-chain grid), then price every CALL [K,far] and PUT [floor,K]
 * leg at 1 contract in ONE batched on-chain devInspect.
 */
export async function buildOptionsChain(underlying = 'BTC'): Promise<OptionsChain> {
  const now = Date.now();
  const want = underlying.toUpperCase();

  const all = await predictServer.predictOracles().catch(() => predictServer.oracles());
  const sorted = all
    .filter(
      (o: PredictOracle) =>
        o.status === 'active' &&
        o.expiry > now &&
        (o.underlying_asset ?? '').toUpperCase() === want,
    )
    .sort((a, b) => a.expiry - b.expiry);
  // Build a tenor ladder spanning minutes → hours → days: one oracle per distinct
  // human tenor label (the indexer lists several oracles at the same tenor, e.g.
  // three "2h" / two "8d"), so the expiry row is a clean, full-range ladder.
  const active: PredictOracle[] = [];
  const seenTenor = new Set<string>();
  for (const o of sorted) {
    const lab = tenorLabel(o.expiry - now);
    if (seenTenor.has(lab)) continue;
    seenTenor.add(lab);
    active.push(o);
    if (active.length >= MAX_EXPIRIES) break;
  }

  const expiries: OptionExpiry[] = [];
  let spot = 0;

  // Price every expiry concurrently (each is one batched devInspect).
  const built = await Promise.all(
    active.map(async (o): Promise<OptionExpiry | null> => {
      const [priceRes, sviRes] = await Promise.all([
        predictServer.oraclePriceLatest(o.oracle_id).catch(() => null),
        predictServer.oracleSviLatest(o.oracle_id).catch(() => null),
      ]);
      if (!priceRes || !sviRes) return null;
      const fwdRaw = forwardFromTick(priceRes);
      const params = decodeSvi(sviRes);
      if (fwdRaw === null || !params) return null;

      const forward = fwdRaw / PRICE_SCALE;
      const tYears = (o.expiry - now) / YEAR_MS;
      if (!(tYears > 0)) return null;
      if (spot === 0) {
        const spotRaw = Number((priceRes as Record<string, unknown>).spot);
        spot = Number.isFinite(spotRaw) && spotRaw > 0 ? spotRaw / PRICE_SCALE : forward;
      }
      const atmIv = sviImpliedVol(params, 0, tYears);

      // σ of the implied move over this tenor (USD). Floors at a tick so a near-
      // expiry oracle still yields a usable spread of on-grid strikes.
      const sigmaUsd = Math.max(
        forward * atmIv * Math.sqrt(Math.max(tYears, 1e-9)),
        forward * 2e-4,
      );
      const minStrikeUsd = o.min_strike / PRICE_SCALE;
      const tickUsd = (o.tick_size || PRICE_SCALE) / PRICE_SCALE;
      // Strikes span forward ± 3σ, clamped on-grid above the oracle's min strike
      // (far-dated oracles have −3σ below the $50k floor).
      const hiUsd = forward + GRID_SIGMA * sigmaUsd;
      const loUsd = Math.max(minStrikeUsd + tickUsd, forward - GRID_SIGMA * sigmaUsd);
      // Digital wings: call [K, F+4σ], put [floor, K]. Floor sits BELOW the lowest
      // strike so [floor, K] is always a valid, non-empty range.
      const farRaw = snapStrikeToGrid(o, Math.round((forward + WING_SIGMA * sigmaUsd) * PRICE_SCALE));
      const floorRaw = Math.max(
        o.min_strike,
        snapStrikeToGrid(o, Math.round(Math.min(loUsd, forward - WING_SIGMA * sigmaUsd) * PRICE_SCALE)),
      );

      type StrikeDef = { strike: number; moneyness: number; kRaw: number; iv: number };
      const defs: StrikeDef[] = [];
      const seenK = new Set<number>();
      const stepUsd = (hiUsd - loUsd) / (STRIKE_STEPS - 1);
      for (let i = 0; i < STRIKE_STEPS; i++) {
        const kRaw = snapStrikeToGrid(o, Math.round((loUsd + i * stepUsd) * PRICE_SCALE));
        if (seenK.has(kRaw) || kRaw <= floorRaw || kRaw >= farRaw) continue; // distinct, valid range
        seenK.add(kRaw);
        const strike = kRaw / PRICE_SCALE;
        const iv = sviImpliedVol(params, Math.log(Math.max(strike, 1) / forward), tYears);
        defs.push({ strike, moneyness: strike / forward, kRaw, iv });
      }

      // One batched devInspect: call [K, far] + put [floor, K] for every strike.
      const bands: Array<{ lower: string; higher: string; quantity: bigint }> = [];
      for (const d of defs) {
        bands.push({ lower: String(d.kRaw), higher: String(farRaw), quantity: CONTRACT_QTY }); // call
        bands.push({ lower: String(floorRaw), higher: String(d.kRaw), quantity: CONTRACT_QTY }); // put
      }
      let priced: Array<{ mint_cost: bigint; redeem_payout: bigint; ok: boolean }> = [];
      try {
        priced = await previewRangeBatch({
          oracleId: o.oracle_id,
          expiry: String(o.expiry),
          bands,
        });
      } catch {
        return null; // no live pricing for this expiry → skip (don't fabricate)
      }

      const toQuote = (
        p: { mint_cost: bigint; redeem_payout: bigint; ok: boolean } | undefined,
        lower: string,
        higher: string,
        iv: number,
        delta: number,
        g: { gamma: number; vega: number; theta: number },
      ): OptionQuote => {
        const ask = p && p.ok ? Number(p.mint_cost) / DUSDC_UNIT : 0;
        const bid = p && p.ok ? Number(p.redeem_payout) / DUSDC_UNIT : 0;
        const mid = ask > 0 || bid > 0 ? (ask + bid) / 2 : 0;
        const tradeable = !!(p && p.ok) && ask >= MIN_MINTABLE && ask <= MAX_MINTABLE;
        return {
          mid: Number(mid.toFixed(4)),
          bid: Number(bid.toFixed(4)),
          ask: Number(ask.toFixed(4)),
          iv: Number(iv.toFixed(4)),
          delta: Number(delta.toFixed(4)),
          gamma: Number(g.gamma.toFixed(6)),
          vega: Number(g.vega.toFixed(4)),
          theta: Number(g.theta.toFixed(4)),
          tradeable,
          lower_strike: lower,
          higher_strike: higher,
        };
      };

      const strikes: OptionStrikeRow[] = defs.map((d, i) => {
        const callP = priced[i * 2];
        const putP = priced[i * 2 + 1];
        const gk = digitalGreeks(forward, d.strike, d.iv, tYears);
        return {
          strike: d.strike,
          moneyness: d.moneyness,
          call: toQuote(callP, String(d.kRaw), String(farRaw), d.iv, gk.callDelta, gk),
          put: toQuote(putP, String(floorRaw), String(d.kRaw), d.iv, gk.putDelta, gk),
        };
      });

      return {
        oracle_id: o.oracle_id,
        expiry: o.expiry,
        tenor_label: tenorLabel(o.expiry - now),
        days_to_expiry: tYears * 365.25,
        forward,
        atm_iv: atmIv,
        strikes,
      };
    }),
  );

  for (const e of built) if (e) expiries.push(e);
  if (expiries.length === 0) throw new Error('no active oracles');
  if (spot === 0) spot = expiries[0].forward;

  return {
    underlying: want,
    spot,
    generated_at: new Date().toISOString(),
    source: 'deepbook-predict-range-onchain',
    contract_payout_usd: 1,
    quote_basis: 'per-contract',
    expiries,
  };
}

// ---------------------------------------------------------------------------
// Cached entry point (~4s) + inflight de-dupe
// ---------------------------------------------------------------------------

const _cache = new Map<string, { at: number; chain: OptionsChain }>();
const _inflight = new Map<string, Promise<OptionsChain>>();

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
