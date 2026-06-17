/**
 * Continuous distribution markets (Paradigm-style), end to end on-chain.
 *
 *   - The market view is a continuous Normal pdf  f = N(muM, sigmaM).
 *   - The trader submits their own continuous Normal pdf  g = N(muT, sigmaT).
 *   - Both are normalized to unit L2 norm (constant-L2 AMM), then the position
 *     g(x) - f(x) is scaled so its worst point (-min) equals the trader's
 *     collateral. Payoff at the realized outcome x* is  scale * (g(x*)-f(x*)).
 *
 * On-chain settlement (market + outcome are simulated, money is real):
 *   - OPEN  : the wallet signs a tx that escrows the collateral (mUSDC) to the
 *             protocol treasury. The position + a locked-in realized outcome are
 *             recorded server-side, keyed by the open digest.
 *   - SETTLE: the protocol pays the realized net (collateral + payoff, clamped
 *             >= 0) back to the trader by minting mUSDC (it holds the treasury
 *             cap). Net wallet change == payoff. Profit and loss both reconcile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import { getSuiClient, signerAddress } from './predict/sui';
import { mintMockUsdc } from './mock-usdc';
import { discoverDistributionCandidates, type DistributionCandidate } from './distribution';
import { fetchRealizedVol } from './bluefin';

const MOCK_USDC_TYPE =
  process.env.MOCK_USDC_TYPE ??
  '0xa630b97e9c5f1cd9804553018c9c14cf38a3ce51c341899ba7bc92a5f7c6a2af::mock_usdc::MOCK_USDC';
const USDC_DECIMALS = Number(process.env.MOCK_USDC_DECIMALS ?? 6);
const GRID_POINTS = 121;
const MAKER_FEE_BPS = 30; // 0.30%

// ---------------------------------------------------------------------------
// Markets (live forwards: Polymarket CLOB-implied + spot oracles)
// ---------------------------------------------------------------------------

export interface ContinuousMarket {
  id: string;
  underlying: string;
  question: string;
  unit: string;
  expiry_ts: number;
  mu: number;
  sigma: number;
  mu_min: number;
  mu_max: number;
  sigma_min: number;
  sigma_max: number;
  step: number;
  /** live Polymarket CLOB · live spot oracle · reference forward. */
  source: 'polymarket' | 'spot' | 'reference';
  /** Aggregate market volume (real for Polymarket/spot, indicative otherwise). */
  volume_usd: number;
  /** Outcome category — crypto | economics | commodities | sports | politics. */
  category: string;
  polymarket_url: string | null;
  /** Live-depth AMM backing `b` (= pool liquidity), seedable. */
  pool_liquidity_usdc: number;
  /** AMM backing `b` (Paradigm distribution-market notation). */
  backing_usdc: number;
  /** AMM L2-norm constant `k` (fixed per market; backing varies with seeding). */
  l2_norm_k: number;
}

// ---------------------------------------------------------------------------
// Real Polymarket forwards: fit a Normal N(mu,sigma) to the live CLOB-implied
// distribution of a numeric market group (e.g. "Bitcoin price 2026", "Fed rate
// cuts", "Crude oil by June"). The mean/spread come from real outcome prices.
// ---------------------------------------------------------------------------

/**
 * Pull a numeric value out of a Polymarket band label.
 *  - "$"-prefixed amount wins: "Bitcoin reach $250,000" -> 250000
 *  - else a leading integer: "1 Fed rate cut" -> 1, "4 Fed rate cuts" -> 4
 *  - else "no ..." -> 0  ("no Fed rate cuts happen in 2026")
 *  - else null (non-numeric, e.g. "the San Antonio Spurs win ...")
 */
function parseBandValue(label: string): number | null {
  const money = label.match(/\$\s?([\d][\d,]*(?:\.\d+)?)/);
  if (money) {
    const n = Number(money[1].replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  const lead = label.match(/^\s*(\d+(?:\.\d+)?)\b/);
  if (lead) {
    const n = Number(lead[1]);
    if (Number.isFinite(n)) return n;
  }
  if (/\bno\b/i.test(label)) return 0;
  return null;
}

/** Probability-weighted mean + std of a discrete distribution. */
function deriveNormal(values: number[], probs: number[]): { mu: number; sigma: number } | null {
  const total = probs.reduce((s, p) => s + p, 0);
  if (total <= 0 || values.length < 2) return null;
  const w = probs.map((p) => p / total);
  const mu = values.reduce((s, v, i) => s + w[i] * v, 0);
  const variance = values.reduce((s, v, i) => s + w[i] * (v - mu) ** 2, 0);
  let sigma = Math.sqrt(variance);
  if (!Number.isFinite(sigma) || sigma <= 0) {
    const range = Math.max(...values) - Math.min(...values);
    sigma = range > 0 ? range * 0.25 : Math.max(1, Math.abs(mu) * 0.1);
  }
  return { mu, sigma };
}

function niceStep(span: number): number {
  const raw = span / 200;
  if (raw >= 1) return Math.max(1, Math.round(raw));
  return Math.max(0.01, Math.round(raw * 100) / 100);
}

function shortLabel(title: string): string {
  const t = title.replace(/[?]/g, '').trim();
  if (/bitcoin|btc/i.test(t)) return 'BTC';
  if (/ethereum|\beth\b/i.test(t)) return 'ETH';
  if (/solana|\bsol\b/i.test(t)) return 'SOL';
  if (/crude|oil|brent|\bwti\b/i.test(t)) return 'OIL';
  if (/fed|rate cut/i.test(t)) return 'FED';
  if (/gold/i.test(t)) return 'GOLD';
  return t.split(/\s+/).slice(0, 2).join(' ').toUpperCase().slice(0, 10);
}

/** Build a continuous forward from a discovered Polymarket candidate, or null. */
function marketFromCandidate(c: DistributionCandidate): ContinuousMarket | null {
  const pairs = c.bands
    .map((b) => ({ v: parseBandValue(b.label), p: b.normalized_probability || b.probability || 0 }))
    .filter((x): x is { v: number; p: number } => x.v !== null && Number.isFinite(x.v) && x.p > 0);
  if (pairs.length < 3) return null; // need a real distribution over a numeric axis

  const norm = deriveNormal(pairs.map((x) => x.v), pairs.map((x) => x.p));
  if (!norm) return null;
  const { mu } = norm;
  // Moment-matching a Normal to a heavily right-skewed market (e.g. Bitcoin,
  // where low-probability tail bands like $250k inflate the variance) yields a
  // sigma so large the left tail goes negative. Cap it at 60% of the mean for
  // price markets so the forward stays sensible and non-negative on screen.
  const sigma = c.outcome_type === 'count' ? norm.sigma : Math.min(norm.sigma, Math.max(mu * 0.6, 1));
  if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma <= 0) return null;

  const muMin = Math.max(0, mu - 3.5 * sigma);
  const muMax = mu + 3.5 * sigma;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // AMM backing = REAL liquidity behind this market: the live CLOB book depth
  // (summed bid+ask across bands), floored by a slice of cumulative volume.
  // No fabricated/seeded number — thin books get shallow pools (lower capacity).
  const base = liveBacking(Math.max(c.aggregate_depth_usd, c.aggregate_volume_usd * 0.01));

  return withPool(
    {
      id: `pm-${c.id}`,
      underlying: shortLabel(c.title),
      question: c.title,
      unit: c.outcome_type === 'count' ? 'count' : 'USD',
      expiry_ts: c.end_date_iso ? new Date(c.end_date_iso).getTime() : Date.now() + 30 * 86_400_000,
      mu: r2(mu),
      sigma: r2(sigma),
      mu_min: r2(muMin),
      mu_max: r2(muMax),
      sigma_max: r2(sigma * 2.5),
      step: niceStep(muMax - muMin),
      source: 'polymarket',
      volume_usd: Math.round(c.aggregate_volume_usd),
      category: c.category,
      polymarket_url: c.bands.find((b) => b.polymarket_url)?.polymarket_url ?? null,
    },
    base,
  );
}

// ---------------------------------------------------------------------------
// Curated continuous single-outcome markets (Parabola-style). Crypto is
// anchored to LIVE spot; macro/commodities/sports are reference forwards.
// A distribution market is over ONE continuous outcome — never a bag of binary
// events — so each entry has a genuine numeric realization axis.
// ---------------------------------------------------------------------------

interface SpotData {
  prices: Record<string, number>;
  volumes: Record<string, number>; // real 24h USD volume per asset (drives pool depth)
}
let spotCache: { at: number } & SpotData | null = null;
const SPOT_FALLBACK: Record<string, number> = {
  BTC: 68_000, ETH: 2_500, SOL: 155, BNB: 600, XRP: 0.6, DOGE: 0.12, GOLD: 2_650,
};
// Order-of-magnitude 24h-volume fallback (only used if CoinGecko omits volume),
// so a spot forward still gets a realistic pool depth rather than a floor.
const VOL_FALLBACK: Record<string, number> = {
  BTC: 25e9, ETH: 12e9, SOL: 3e9, BNB: 1.5e9, XRP: 2e9, DOGE: 1e9, GOLD: 3e8,
};
const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple', DOGE: 'dogecoin', GOLD: 'pax-gold',
};
/** Live spot price + real 24h volume from CoinGecko (PAX-Gold tracks gold/oz). Cached 60s. */
async function fetchSpot(): Promise<SpotData> {
  if (spotCache && Date.now() - spotCache.at < 60_000) return spotCache;
  try {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_vol=true`,
      { signal: AbortSignal.timeout(5000) },
    );
    const j = (await res.json()) as Record<string, { usd?: number; usd_24h_vol?: number }>;
    const prices: Record<string, number> = {};
    const volumes: Record<string, number> = {};
    for (const [sym, id] of Object.entries(COINGECKO_IDS)) {
      prices[sym] = j[id]?.usd ?? 0;
      volumes[sym] = j[id]?.usd_24h_vol ?? 0;
    }
    if (prices.BTC && prices.ETH && prices.SOL) {
      // Backfill any individually-missing coin so a partial response still works.
      for (const k of Object.keys(SPOT_FALLBACK)) {
        if (!prices[k]) prices[k] = SPOT_FALLBACK[k];
        if (!volumes[k]) volumes[k] = VOL_FALLBACK[k];
      }
      spotCache = { at: Date.now(), prices, volumes };
      return spotCache;
    }
  } catch {
    /* fall through to last-good / fallback */
  }
  return spotCache ?? { prices: SPOT_FALLBACK, volumes: VOL_FALLBACK };
}

interface CuratedSpec {
  id: string;
  underlying: string;
  question: string;
  unit: string;
  category: string;
  mu: number;
  sigma: number;
  volume_usd: number;
  source: 'spot' | 'reference';
}

/** Clamp a live liquidity figure into a sane AMM backing band ($10k–$2M). */
function liveBacking(liquidityUsd: number): number {
  return Math.round(Math.min(2_000_000, Math.max(10_000, liquidityUsd || 0)));
}

function specToMarket(s: CuratedSpec): ContinuousMarket {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const sigma = Math.max(s.sigma, 1e-6);
  const muMin = Math.max(0, s.mu - 3.5 * sigma);
  const muMax = s.mu + 3.5 * sigma;
  // Back the pool off the asset's REAL 24h volume (s.volume_usd), so liquid
  // assets get deep pools and thin ones don't — no fabricated depth.
  const base = liveBacking(s.volume_usd * 0.00008);
  return withPool(
    {
      id: s.id,
      underlying: s.underlying,
      question: s.question,
      unit: s.unit,
      expiry_ts: Date.now() + 30 * 86_400_000,
      mu: r2(s.mu),
      sigma: r2(sigma),
      mu_min: r2(muMin),
      mu_max: r2(muMax),
      sigma_max: r2(sigma * 2.5),
      step: niceStep(muMax - muMin),
      source: s.source,
      volume_usd: s.volume_usd,
      category: s.category,
      polymarket_url: null,
    },
    base,
  );
}

// Coinbase product per asset for realized-vol (BNB isn't on Coinbase → fallback).
const COINBASE_VOL_PRODUCT: Record<string, string | null> = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', GOLD: 'PAXG-USD', BNB: null,
};
// Annualized-vol fallback when an asset has no Coinbase candle feed.
const ANNUAL_VOL_FALLBACK: Record<string, number> = {
  BTC: 0.55, ETH: 0.7, SOL: 0.9, BNB: 0.6, XRP: 0.85, DOGE: 1.0, GOLD: 0.15,
};
let volCache: { at: number; vols: Record<string, number> } | null = null;

/** Real annualized realized vol per asset from Coinbase candles (cached 5m). */
async function annualVols(): Promise<Record<string, number>> {
  if (volCache && Date.now() - volCache.at < 5 * 60_000) return volCache.vols;
  const assets = Object.keys(ANNUAL_VOL_FALLBACK);
  const results = await Promise.all(
    assets.map(async (a) => {
      const product = COINBASE_VOL_PRODUCT[a];
      if (!product) return [a, ANNUAL_VOL_FALLBACK[a]] as const;
      const rv = await fetchRealizedVol(168, product).catch(() => null);
      return [a, rv && rv.source === 'coinbase' && rv.realized_vol > 0 ? rv.realized_vol : ANNUAL_VOL_FALLBACK[a]] as const;
    }),
  );
  const vols = Object.fromEntries(results);
  volCache = { at: Date.now(), vols };
  return vols;
}

async function curatedMarkets(): Promise<ContinuousMarket[]> {
  const [{ prices: spot, volumes: vol }, av] = await Promise.all([fetchSpot(), annualVols()]);
  // σ = spot × REAL annualized vol × √(horizon/yr): every μ (CoinGecko), σ (Coinbase
  // realized vol) and 24h volume is live. PAX-Gold tracks gold/oz.
  const sig = (asset: string, mu: number, days: number) => mu * av[asset] * Math.sqrt(days / 365);
  const specs: CuratedSpec[] = [
    { id: 'btc-usd-7d', underlying: 'BTC', question: 'BTC/USD · 7-day forward', unit: 'USD', category: 'crypto', mu: spot.BTC, sigma: sig('BTC', spot.BTC, 7), volume_usd: vol.BTC, source: 'spot' },
    { id: 'eth-usd-30d', underlying: 'ETH', question: 'ETH/USD · 30-day forward', unit: 'USD', category: 'crypto', mu: spot.ETH, sigma: sig('ETH', spot.ETH, 30), volume_usd: vol.ETH, source: 'spot' },
    { id: 'sol-usd-30d', underlying: 'SOL', question: 'SOL/USD · 30-day forward', unit: 'USD', category: 'crypto', mu: spot.SOL, sigma: sig('SOL', spot.SOL, 30), volume_usd: vol.SOL, source: 'spot' },
    { id: 'bnb-usd-30d', underlying: 'BNB', question: 'BNB/USD · 30-day forward', unit: 'USD', category: 'crypto', mu: spot.BNB, sigma: sig('BNB', spot.BNB, 30), volume_usd: vol.BNB, source: 'spot' },
    { id: 'xrp-usd-30d', underlying: 'XRP', question: 'XRP/USD · 30-day forward', unit: 'USD', category: 'crypto', mu: spot.XRP, sigma: sig('XRP', spot.XRP, 30), volume_usd: vol.XRP, source: 'spot' },
    { id: 'doge-usd-30d', underlying: 'DOGE', question: 'DOGE/USD · 30-day forward', unit: 'USD', category: 'crypto', mu: spot.DOGE, sigma: sig('DOGE', spot.DOGE, 30), volume_usd: vol.DOGE, source: 'spot' },
    { id: 'gold-usd-30d', underlying: 'GOLD', question: 'Gold /oz · 30-day forward', unit: 'USD', category: 'commodities', mu: spot.GOLD, sigma: sig('GOLD', spot.GOLD, 30), volume_usd: vol.GOLD, source: 'spot' },
  ];
  return specs.filter((s) => s.mu > 0 && s.sigma > 0).map(specToMarket);
}

// ---------------------------------------------------------------------------
// Live-depth AMM liquidity pool, per market (seedable).
//
// Following Paradigm's distribution-market paper (Normal case): the AMM holds a
// backing `b` and an L2-norm constant `k`. For a Normal view the backing
// constraint is  max f = k / (sigma * sqrt(pi)) <= b, i.e.
//     sigma >= k^2 * sqrt(pi) / b^2.
// `k` is fixed per market; `b` (= pool liquidity) grows when liquidity is
// seeded, which LOWERS the minimum sigma the market will accept — so deeper
// pools let traders express sharper (more peaked) distributions. This is the
// concrete "liquidity reshapes the distribution" link.
// ---------------------------------------------------------------------------

const SQRT_PI = Math.sqrt(Math.PI);
const SIGMA_MIN_FRAC = 0.25; // at the initial backing, sigma_min = 25% of the market sigma

interface Pool {
  base_usdc: number; // backing from live CLOB depth / 24h volume
  seeded_usdc: number; // additional liquidity seeded this session
  k: number; // fixed L2-norm constant, calibrated at pool creation
}

// Pools are file-backed (alongside positions). Without this, a backend restart
// would re-seed every pool with a fresh random backing — so a position opened
// before the restart would unwind (close-before-settle) against a DIFFERENT
// pool than it was sized against, corrupting the slippage charged on the sell.
// Persisting the backing + calibrated k keeps both the buy (open/cap) and the
// sell (close/slippage) sides quoting against the same liquidity across runs.
const POOL_STORE_FILE = path.join(process.cwd(), '.distribution-pools.json');
function loadPools(): Map<string, Pool> {
  try {
    const raw = JSON.parse(fs.readFileSync(POOL_STORE_FILE, 'utf8')) as Record<string, Pool>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}
const pools = loadPools();
function savePools(): void {
  try {
    fs.writeFileSync(POOL_STORE_FILE, JSON.stringify(Object.fromEntries(pools)));
  } catch {
    /* best effort */
  }
}

/** Calibrate k so sigma_min(base) == SIGMA_MIN_FRAC * sigma (then it falls as b grows). */
function calibrateK(base: number, sigma: number): number {
  const targetSigmaMin = Math.max(SIGMA_MIN_FRAC * sigma, 1e-9);
  return base * Math.sqrt(targetSigmaMin / SQRT_PI);
}

function ensurePool(id: string, base: number, sigma: number): Pool {
  let p = pools.get(id);
  if (!p) {
    // Backing = the market's LIVE liquidity (`base`, from real CLOB depth / 24h
    // volume). No random seed — depth is real and only grows when a user
    // explicitly seeds liquidity. k is calibrated at b so the displayed min σ is
    // a sensible 25% of σ at the live backing.
    p = { base_usdc: base, seeded_usdc: 0, k: calibrateK(base, sigma) };
    pools.set(id, p);
    savePools();
  }
  return p;
}

/** Current backing b = base + seeded. */
function poolBacking(id: string, base: number, sigma: number): number {
  const p = ensurePool(id, base, sigma);
  return p.base_usdc + p.seeded_usdc;
}

/** Backing-constrained minimum sigma: k^2 * sqrt(pi) / b^2 (falls as b grows). */
function poolSigmaMin(id: string, base: number, sigma: number): number {
  const p = ensurePool(id, base, sigma);
  const b = p.base_usdc + p.seeded_usdc;
  return (p.k * p.k * SQRT_PI) / (b * b);
}

export function seedLiquidity(id: string, amountUsdc: number): { market_id: string; pool_liquidity_usdc: number; seeded_usdc: number } {
  const amount = Number(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount_usdc must be positive');
  if (amount > 5_000_000) throw new Error('amount_usdc too large (max 5,000,000 simulated)');
  const p = pools.get(id) ?? ensurePool(id, 50_000, 1);
  p.seeded_usdc += amount;
  pools.set(id, p);
  savePools();
  return { market_id: id, pool_liquidity_usdc: p.base_usdc + p.seeded_usdc, seeded_usdc: p.seeded_usdc };
}

/** Drop all cached pool backings so every market re-derives its backing from
 *  LIVE depth on next access (also clears any user-seeded liquidity). This
 *  replaces the old random "seed-all" with a deterministic resync to live data. */
export function resetPoolsToLive(): { count: number; cleared: string[] } {
  const cleared = [...pools.keys()];
  pools.clear();
  savePools();
  return { count: cleared.length, cleared };
}

/** Attach pool-derived fields (backing b, k, liquidity-dependent sigma_min) to a market. */
function withPool(m: Omit<ContinuousMarket, 'pool_liquidity_usdc' | 'backing_usdc' | 'l2_norm_k' | 'sigma_min'>, base: number): ContinuousMarket {
  const pool = ensurePool(m.id, base, m.sigma);
  const b = pool.base_usdc + pool.seeded_usdc;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    ...m,
    sigma_min: r2(Math.max(poolSigmaMin(m.id, base, m.sigma), m.sigma * 0.02)),
    pool_liquidity_usdc: Math.round(b),
    backing_usdc: Math.round(b),
    l2_norm_k: r2(pool.k),
  };
}

// ---------------------------------------------------------------------------
// Market registry — live Polymarket forwards (cached), synthetic fallback.
// ---------------------------------------------------------------------------

const marketCache = new Map<string, ContinuousMarket>();
let liveBuiltAt = 0;
const LIVE_TTL_MS = 60_000;

/**
 * Build the full market set: live Polymarket CLOB forwards (numeric markets
 * fitted to real odds) + curated continuous markets (live-spot crypto, macro,
 * commodities, sports). Cached for the synchronous quote/open lookups.
 */
export async function listContinuousMarketsLive(): Promise<ContinuousMarket[]> {
  let live: ContinuousMarket[] = [];
  try {
    const { candidates } = await discoverDistributionCandidates({ limit: 30 });
    live = candidates.map(marketFromCandidate).filter((m): m is ContinuousMarket => m !== null);
  } catch {
    live = [];
  }
  let curated: ContinuousMarket[] = [];
  try {
    curated = await curatedMarkets();
  } catch {
    curated = [];
  }
  // Dedupe by id; feature live Polymarket numeric markets first, then spot
  // forwards, ranked by real volume within each group (crypto 24h volume is in
  // the billions and would otherwise bury the prediction markets).
  const seen = new Set<string>();
  const all = [...live, ...curated].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  all.sort(bySourceThenVolume);
  marketCache.clear();
  for (const m of all) marketCache.set(m.id, m);
  liveBuiltAt = Date.now();
  return all.slice(0, 10);
}

const SOURCE_RANK: Record<ContinuousMarket['source'], number> = { polymarket: 0, spot: 1, reference: 2 };
function bySourceThenVolume(a: ContinuousMarket, b: ContinuousMarket): number {
  const s = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  return s !== 0 ? s : b.volume_usd - a.volume_usd;
}

/** Synchronous list from cache (refreshing in the background if stale). */
export function listContinuousMarkets(): ContinuousMarket[] {
  if (Date.now() - liveBuiltAt > LIVE_TTL_MS) void listContinuousMarketsLive();
  return [...marketCache.values()].sort(bySourceThenVolume).slice(0, 10);
}

export function getContinuousMarket(id: string): ContinuousMarket | undefined {
  return marketCache.get(id);
}

// ---------------------------------------------------------------------------
// Quote math (continuous Normal, constant-L2 AMM, g - f payoff)
// ---------------------------------------------------------------------------

function normalPdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

export interface ContinuousQuote {
  market_mu: number;
  market_sigma: number;
  target_mu: number;
  target_sigma: number;
  collateral_usdc: number;
  maker_fee_usdc: number;
  net_usdc: number;
  x: number[];
  market_pdf: number[];
  target_pdf: number[];
  market_curve: number[];
  target_curve: number[];
  trade_curve: number[];
  collateral_required_usdc: number;
  max_profit_usdc: number;
  max_loss_usdc: number;
  expected_value_usdc: number;
  l2_distance: number;
  /** Live-depth AMM backing b (= pool liquidity). */
  pool_liquidity_usdc: number;
  /** Price impact at this trade size against the backing (informational). */
  price_impact_bps: number;
  /** Backing-constrained minimum sigma (k^2*sqrt(pi)/b^2) at the live pool. */
  sigma_min: number;
  /** Largest collateral the pool can back (max payout <= pool, lock <= pool). */
  max_collateral_usdc: number;
  /** True when the requested size exceeded the pool and was capped. */
  capacity_exceeded: boolean;
  quote_model: 'continuous_normal_l2_distribution_amm';
}

/** Core quote from explicit market/target params (used by quote + settlement). */
function quoteCore(p: {
  marketMu: number;
  marketSigma: number;
  targetMu: number;
  targetSigma: number;
  collateral: number;
}): ContinuousQuote {
  const { marketMu: muM, marketSigma: sigM } = p;
  const muT = Number(p.targetMu);
  const sigT = Number(p.targetSigma);
  const collateral = Number(p.collateral);
  if (!Number.isFinite(muT)) throw new Error('target_mu must be a number');
  if (!Number.isFinite(sigT) || sigT <= 0) throw new Error('target_sigma must be positive');
  if (!Number.isFinite(collateral) || collateral <= 0) throw new Error('collateral_usdc must be positive');

  let lo = Math.min(muM - 4 * sigM, muT - 4 * sigT);
  const hi = Math.max(muM + 4 * sigM, muT + 4 * sigT);
  // Non-negative quantities (prices, counts) can't realize below 0 — clamp the
  // grid floor so the curve doesn't render a meaningless negative left tail.
  // Applied in both the open quote and settlement so the two stay consistent.
  if (muM > 0 && muT > 0) lo = Math.max(lo, 0);
  const dx = (hi - lo) / (GRID_POINTS - 1);
  const x = Array.from({ length: GRID_POINTS }, (_, i) => lo + i * dx);
  const marketPdf = x.map((xi) => normalPdf(xi, muM, sigM));
  const targetPdf = x.map((xi) => normalPdf(xi, muT, sigT));

  const fee = (collateral * MAKER_FEE_BPS) / 10_000;
  const net = collateral - fee;

  const l2 = (arr: number[]): number => Math.sqrt(arr.reduce((s, v) => s + v * v * dx, 0));
  const fUnit = marketPdf.map((v) => v / Math.max(l2(marketPdf), 1e-9));
  const gUnit = targetPdf.map((v) => v / Math.max(l2(targetPdf), 1e-9));
  const tradeUnit = gUnit.map((v, i) => v - fUnit[i]);
  const downsideUnit = -Math.min(...tradeUnit);
  const flat = downsideUnit < 1e-6;
  const scale = flat ? 0 : net / downsideUnit;

  const marketCurve = fUnit.map((v) => v * scale);
  const targetCurve = gUnit.map((v) => v * scale);
  const tradeCurve = tradeUnit.map((v) => v * scale);
  const maxTrade = Math.max(...tradeCurve, 0);
  const collateralRequired = flat ? 0 : collateral;
  const gMass = targetPdf.reduce((s, v) => s + v * dx, 0) || 1;
  const ev = tradeCurve.reduce((s, v, i) => s + v * (targetPdf[i] / gMass) * dx, 0);

  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    market_mu: r(muM),
    market_sigma: r(sigM),
    target_mu: r(muT),
    target_sigma: r(sigT),
    collateral_usdc: r(collateral),
    maker_fee_usdc: r(flat ? 0 : fee),
    net_usdc: r(flat ? 0 : net),
    x: x.map((n) => r(n, 2)),
    market_pdf: marketPdf.map((n) => r(n, 8)),
    target_pdf: targetPdf.map((n) => r(n, 8)),
    market_curve: marketCurve.map((n) => r(n)),
    target_curve: targetCurve.map((n) => r(n)),
    trade_curve: tradeCurve.map((n) => r(n)),
    collateral_required_usdc: r(collateralRequired),
    max_profit_usdc: r(maxTrade),
    max_loss_usdc: r(collateralRequired),
    expected_value_usdc: r(ev),
    l2_distance: r(l2(tradeCurve), 4),
    pool_liquidity_usdc: 0, // filled in by quoteContinuous (knows the market's pool)
    price_impact_bps: 0,
    sigma_min: 0,
    max_collateral_usdc: 0,
    capacity_exceeded: false,
    quote_model: 'continuous_normal_l2_distribution_amm',
  };
}

export function quoteContinuous(args: {
  marketId: string;
  targetMu: number;
  targetSigma: number;
  collateralUsdc: number;
}): ContinuousQuote & { market_id: string; question: string; unit: string } {
  const market = getContinuousMarket(args.marketId);
  if (!market) throw new Error(`Unknown continuous market: ${args.marketId}`);
  const poolLiquidity = poolBacking(market.id, market.pool_liquidity_usdc, market.sigma);

  const coreOf = (collateral: number) =>
    quoteCore({
      marketMu: market.mu,
      marketSigma: market.sigma,
      targetMu: args.targetMu,
      targetSigma: args.targetSigma,
      collateral,
    });

  // First pass to read the geometry (max payout scales linearly with size).
  const probe = coreOf(args.collateralUsdc);

  // AMM solvency cap: the pool must be able to back the worst-case payout. The
  // position can neither lock more than the pool, nor have a max profit the pool
  // can't pay. max_profit is linear in collateral, so the cap is a stable bound.
  const requested = args.collateralUsdc;
  const profitCap =
    probe.max_profit_usdc > 0 ? (poolLiquidity * requested) / probe.max_profit_usdc : Infinity;
  const maxCollateral = Math.max(0, Math.min(poolLiquidity, profitCap));
  const effective = maxCollateral > 0 ? Math.min(requested, maxCollateral) : requested;
  const capacityExceeded = effective < requested - 1e-6;

  // Re-quote at the capped size so every dollar figure shown is actually backable.
  const core = capacityExceeded ? coreOf(effective) : probe;

  const sigmaMin = Math.max(poolSigmaMin(market.id, market.pool_liquidity_usdc, market.sigma), market.sigma * 0.02);
  const utilization = core.collateral_required_usdc / (poolLiquidity || 1);
  const priceImpactBps = Math.round(Math.min(2000, 5000 * utilization)); // cap 20%
  return {
    ...core,
    pool_liquidity_usdc: Math.round(poolLiquidity),
    price_impact_bps: priceImpactBps,
    sigma_min: Math.round(sigmaMin * 100) / 100,
    max_collateral_usdc: Math.round(maxCollateral),
    capacity_exceeded: capacityExceeded,
    market_id: market.id,
    question: market.question,
    unit: market.unit,
  };
}

/** Linear-interpolate the trade payoff at a realized outcome x*. */
function payoffAt(quote: ContinuousQuote, xStar: number): number {
  const xs = quote.x;
  const ys = quote.trade_curve;
  const n = xs.length;
  if (xStar <= xs[0]) return ys[0];
  if (xStar >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (xStar <= xs[i]) {
      const t = (xStar - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
      return ys[i - 1] + t * (ys[i] - ys[i - 1]);
    }
  }
  return ys[n - 1];
}

// Seeded Normal draw so a position's realized outcome is fixed at open time.
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function drawNormal(mu: number, sigma: number, seedStr: string): number {
  const rng = mulberry32(hashSeed(seedStr));
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mu + sigma * z;
}

// ---------------------------------------------------------------------------
// Position store (file-backed so it survives a backend restart mid-demo)
// ---------------------------------------------------------------------------

export interface ContinuousPosition {
  id: string; // == open digest
  owner: string;
  market_id: string;
  question: string;
  market_mu: number;
  market_sigma: number;
  target_mu: number;
  target_sigma: number;
  collateral_usdc: number;
  max_profit_usdc: number;
  open_digest: string;
  opened_at: number;
  realized_x: number;
  settled: boolean;
  settle_digest?: string;
  payoff_usdc?: number;
  net_usdc?: number;
  settled_at?: number;
}

const STORE_FILE = path.join(process.cwd(), '.distribution-positions.json');

function loadStore(): Map<string, ContinuousPosition> {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as Record<string, ContinuousPosition>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}
const store = loadStore();
function saveStore(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(store)));
  } catch {
    /* best effort */
  }
}

function treasuryAddress(): string {
  const addr = signerAddress();
  if (!addr) throw new Error('Protocol treasury (signer) is not configured.');
  return addr;
}

// ---------------------------------------------------------------------------
// Open: escrow collateral to the treasury (wallet-signed)
// ---------------------------------------------------------------------------

export interface PreparedOpen {
  tx_bytes: string;
  sender: string;
  collateral_usdc: number;
  treasury: string;
  quote: ContinuousQuote & { market_id: string; question: string; unit: string };
  dry_run: { ok: boolean; status: string; error?: string };
}

export async function prepareContinuousOpen(args: {
  owner: string;
  marketId: string;
  targetMu: number;
  targetSigma: number;
  collateralUsdc: number;
}): Promise<PreparedOpen> {
  const quote = quoteContinuous(args);
  if (quote.collateral_required_usdc <= 0) {
    throw new Error('Set a view different from the market (move mu or sigma) before opening a position.');
  }
  const client = getSuiClient();
  const treasury = treasuryAddress();
  const rawLock = BigInt(Math.round(quote.collateral_required_usdc * 10 ** USDC_DECIMALS));

  const { data: coins } = await client.getCoins({ owner: args.owner, coinType: MOCK_USDC_TYPE });
  const total = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (total < rawLock) {
    const held = Number(total) / 10 ** USDC_DECIMALS;
    throw new Error(
      `Insufficient mUSDC: holds ${held.toFixed(2)}, needs ${quote.collateral_required_usdc}. Use the faucet first.`,
    );
  }

  const tx = new Transaction();
  const ids = coins.map((c) => c.coinObjectId);
  const [primary, ...rest] = ids;
  if (rest.length > 0) tx.mergeCoins(tx.object(primary), rest.map((id) => tx.object(id)));
  const [payment] = tx.splitCoins(tx.object(primary), [tx.pure.u64(rawLock)]);
  tx.transferObjects([payment], tx.pure.address(treasury));
  tx.setSender(args.owner);

  // Return the UNBUILT transaction (serialized, no gas resolved) so the wallet
  // builds + signs + executes it itself — broadly compatible with every wallet
  // type including zkLogin/social (Slush-with-Google). A throwaway build is used
  // only for the server-side dry-run.
  const serialized = await tx.toJSON();
  let dry: PreparedOpen['dry_run'] = { ok: false, status: 'unknown' };
  try {
    const probe = Transaction.from(serialized);
    probe.setSender(args.owner);
    const bytes = await probe.build({ client });
    const dr = await client.dryRunTransactionBlock({ transactionBlock: bytes });
    dry = { ok: dr.effects?.status.status === 'success', status: dr.effects?.status.status ?? 'unknown', error: dr.effects?.status.error };
  } catch (e) {
    dry = { ok: false, status: 'dry_run_error', error: (e as Error).message };
  }

  return { tx_bytes: serialized, sender: args.owner, collateral_usdc: quote.collateral_required_usdc, treasury, quote, dry_run: dry };
}

async function digestSucceeded(digest: string): Promise<boolean> {
  try {
    await getSuiClient().waitForTransaction({ digest }).catch(() => {});
    const tx = await getSuiClient().getTransactionBlock({ digest, options: { showEffects: true } });
    return tx.effects?.status.status === 'success';
  } catch {
    return false;
  }
}

/** Record the position after the wallet has executed the escrow tx. */
export async function confirmContinuousOpen(args: {
  owner: string;
  marketId: string;
  targetMu: number;
  targetSigma: number;
  collateralUsdc: number;
  digest: string;
}): Promise<ContinuousPosition> {
  if (!args.digest) throw new Error('digest is required');
  if (!(await digestSucceeded(args.digest))) {
    throw new Error('Open transaction not found or did not succeed on-chain.');
  }
  const quote = quoteContinuous(args);
  const realized = drawNormal(quote.market_mu, quote.market_sigma, args.digest);
  const pos: ContinuousPosition = {
    id: args.digest,
    owner: args.owner,
    market_id: quote.market_id,
    question: quote.question,
    market_mu: quote.market_mu,
    market_sigma: quote.market_sigma,
    target_mu: quote.target_mu,
    target_sigma: quote.target_sigma,
    collateral_usdc: quote.collateral_required_usdc,
    max_profit_usdc: quote.max_profit_usdc,
    open_digest: args.digest,
    opened_at: Date.now(),
    realized_x: Math.round(realized * 100) / 100,
    settled: false,
  };
  store.set(pos.id, pos);
  saveStore();
  return pos;
}

export function listContinuousPositions(owner: string): ContinuousPosition[] {
  return [...store.values()]
    .filter((p) => p.owner.toLowerCase() === owner.toLowerCase())
    .sort((a, b) => b.opened_at - a.opened_at);
}

// ---------------------------------------------------------------------------
// Settle: protocol pays the realized net (mints to the trader)
// ---------------------------------------------------------------------------

export interface SettleResult {
  position_id: string;
  realized_x: number;
  payoff_usdc: number;
  net_usdc: number;
  pnl_usdc: number;
  settle_digest: string | null;
  explorer_url: string | null;
}

export async function settleContinuousPosition(args: { owner: string; positionId: string }): Promise<SettleResult> {
  const pos = store.get(args.positionId);
  if (!pos) throw new Error('Position not found.');
  if (pos.owner.toLowerCase() !== args.owner.toLowerCase()) throw new Error('Not your position.');
  if (pos.settled) throw new Error('Position already settled.');

  const quote = quoteCore({
    marketMu: pos.market_mu,
    marketSigma: pos.market_sigma,
    targetMu: pos.target_mu,
    targetSigma: pos.target_sigma,
    collateral: pos.collateral_usdc,
  });
  const payoff = payoffAt(quote, pos.realized_x);
  // Net returned to the trader = collateral + payoff, never below 0 (they can
  // lose at most the collateral they escrowed on open).
  const net = Math.max(0, Math.round((pos.collateral_usdc + payoff) * 100) / 100);

  let settleDigest: string | null = null;
  let explorer: string | null = null;
  if (net > 0) {
    const minted = await mintMockUsdc(pos.owner, net); // protocol pays out (real on-chain)
    settleDigest = minted.digest;
    explorer = minted.explorer_url;
  }

  pos.settled = true;
  pos.settle_digest = settleDigest ?? undefined;
  pos.payoff_usdc = Math.round(payoff * 100) / 100;
  pos.net_usdc = net;
  pos.settled_at = Date.now();
  store.set(pos.id, pos);
  saveStore();

  return {
    position_id: pos.id,
    realized_x: pos.realized_x,
    payoff_usdc: pos.payoff_usdc,
    net_usdc: net,
    pnl_usdc: Math.round((net - pos.collateral_usdc) * 100) / 100,
    settle_digest: settleDigest,
    explorer_url: explorer,
  };
}

// ---------------------------------------------------------------------------
// Sell / close BEFORE settlement — route the unwind through the AMM.
//
// Per the Paradigm paper, exiting a position means taking the opposing side:
// moving the AMM from the trader's curve g back toward the market curve f. The
// trader realizes the position's mark-to-market under the CURRENT market belief
// f (∫ (g-f)(x) · f̂(x) dx) and pays the round-trip AMM cost: the maker fee plus
// price-impact slippage against the pool's finite backing. Deeper pools (more
// seeded liquidity) → less slippage. The protocol pays the net out on-chain.
// ---------------------------------------------------------------------------

export interface CloseResult {
  position_id: string;
  mark_usdc: number; // mark-to-market of g-f under the current market f
  slippage_usdc: number;
  fee_usdc: number;
  net_usdc: number; // returned to the trader
  pnl_usdc: number;
  price_impact_bps: number;
  close_digest: string | null;
  explorer_url: string | null;
}

export async function closeContinuousPosition(args: { owner: string; positionId: string }): Promise<CloseResult> {
  const pos = store.get(args.positionId);
  if (!pos) throw new Error('Position not found.');
  if (pos.owner.toLowerCase() !== args.owner.toLowerCase()) throw new Error('Not your position.');
  if (pos.settled) throw new Error('Position already settled or closed.');

  const quote = quoteCore({
    marketMu: pos.market_mu,
    marketSigma: pos.market_sigma,
    targetMu: pos.target_mu,
    targetSigma: pos.target_sigma,
    collateral: pos.collateral_usdc,
  });
  // Mark-to-market of the trade curve (g-f) under the current market pdf f.
  const xs = quote.x;
  const dx = xs.length > 1 ? xs[1] - xs[0] : 1;
  const fMass = quote.market_pdf.reduce((s, v) => s + v * dx, 0) || 1;
  const mark = quote.trade_curve.reduce((s, v, i) => s + v * (quote.market_pdf[i] / fMass) * dx, 0);

  // Round-trip AMM cost: price impact vs pool backing + the maker fee. Use the
  // market's real base (and the persisted pool) so the sell quotes against the
  // SAME liquidity the buy was sized against, even across a backend restart.
  const mkt = getContinuousMarket(pos.market_id);
  const pool = poolBacking(pos.market_id, mkt?.pool_liquidity_usdc ?? 50_000, pos.market_sigma);
  const utilization = pos.collateral_usdc / (pool || 1);
  const impactFrac = Math.min(0.2, 0.5 * utilization);
  const slippage = pos.collateral_usdc * impactFrac * 0.5;
  const fee = (pos.collateral_usdc * MAKER_FEE_BPS) / 10_000;

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const net = Math.max(0, r2(pos.collateral_usdc + mark - slippage - fee));

  let closeDigest: string | null = null;
  let explorer: string | null = null;
  if (net > 0) {
    const minted = await mintMockUsdc(pos.owner, net);
    closeDigest = minted.digest;
    explorer = minted.explorer_url;
  }

  pos.settled = true;
  pos.settle_digest = closeDigest ?? undefined;
  pos.payoff_usdc = r2(mark);
  pos.net_usdc = net;
  pos.settled_at = Date.now();
  store.set(pos.id, pos);
  saveStore();

  return {
    position_id: pos.id,
    mark_usdc: r2(mark),
    slippage_usdc: r2(slippage),
    fee_usdc: r2(fee),
    net_usdc: net,
    pnl_usdc: r2(net - pos.collateral_usdc),
    price_impact_bps: Math.round(impactFrac * 10_000),
    close_digest: closeDigest,
    explorer_url: explorer,
  };
}
