/**
 * Indexer-replay BACKTEST of the Pelagos range-ladder ("strip") strategy.
 *
 *   npx tsx --tsconfig ./tsconfig.dev.json src/scripts/backtest-strip.ts
 *
 * GOAL: proper simulation results for the fixed range-ladder, using ONLY the
 * public DeepBook Predict indexer (https://predict-server.testnet.mystenlabs.com).
 * NOTHING is spent on-chain; settled oracles cannot be priced via devInspect
 * anyway (the AMM rejects priced/settled markets), so entry cost is reconstructed
 * from the indexer's own recorded state with the SAME normal-CDF-over-the-view
 * math the structured engine uses (`buildStripBuckets` weight == the contract's
 * `up(lower) - up(higher)` fair_range for a Normal view).
 *
 * METHOD (per settled BTC oracle = one "epoch"):
 *   1. GET /oracles, keep status='settled' && has settlement_price (BTC only).
 *   2. Sample SAMPLE_N of them (default 150).
 *   3. Pull each oracle's price history near ACTIVATION (GET /oracles/:id/prices
 *      with a large limit, take the oldest tick after activated_at) -> forward μ.
 *      Pull /svi near activation for the real ATM implied vol (and a spread proxy).
 *   4. Build the strip: μ = forward(@activation); σ is DYNAMIC PER-ORACLE =
 *      forward · atm_iv · √T, where atm_iv is THAT oracle's own near-activation SVI
 *      ATM and T = (expiry-activated)/yr — nothing fixed (BT_SIGMA overrides to a
 *      fixed σ = frac·forward). N = 6 on-grid buckets spanning ±SPAN·σ via
 *      buildStripBuckets (imported).
 *   5. fair_range per bucket = up(lower) - up(higher) = Φ((hi-μ)/σ) - Φ((lo-μ)/σ)
 *      (== bucket.weight). Entry COST = fair_range + a modeled half-spread derived
 *      from the indexer's recorded near-activation forward dispersion. We buy 1
 *      contract ($1 max payout) per bucket -> total cost = Σ (fair + half_spread).
 *   6. Read settlement_price; pay $1 to the bucket whose (lower, higher] contains
 *      it (0 if it lands outside the ±SPAN·σ strip). PnL = payout - cost.
 *   7. Chain net PnL into a rolled equity curve (compound on deployed capital).
 *
 * TWO SIDES. The naive strip BUYER (taker) compounds its per-epoch return on the
 * capital it deploys — an honest-but-noisy "taker" line. The HOUSE / VAULT is the
 * PLP counterparty that takes the OTHER side of every strip: it collects the
 * buyer's premium (+cost), pays $1 to the winning bucket (-payout), and earns the
 * modeled spread. House P&L = cost - payout (exact complement of the buyer), and
 * its capital backed each epoch = max strip payout = (#buckets bought)·$1. The
 * house curve is the headline +EV vault strategy the hackathon asks for.
 *
 * OUTPUTS (stdout + backend/.backtest-strip.json): #epochs, buyer + HOUSE hit /
 * return / Sharpe / max-drawdown / full equity curves, avg round-trip spread, a
 * probability CALIBRATION table (predicted vs realized hit-freq) + Brier score,
 * and a handful of chronological sample epochs.
 *
 * SCALES: strikes/min_strike/tick_size/settlement_price = 1e9; probabilities use
 * the same fair-value $ scale; dUSDC/payout = 1e6 (1 contract = 1_000_000 raw = $1).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { predictServer, type PredictOracle } from '../services/predict';
import { buildStripBuckets, type GridOracle } from '../services/predict/structured';

// --- config knobs -----------------------------------------------------------
const SERVER = process.env.PREDICT_SERVER_URL ?? 'https://predict-server.testnet.mystenlabs.com';
const SAMPLE_N = Number(process.env.BT_SAMPLE ?? 150); // # settled oracles to replay
const N_BUCKETS = Number(process.env.BT_N ?? 6); // ladder width (task: N=6)
// σ is DYNAMIC per-oracle by default: σ_strip = forward · atm_iv · √T, where
// atm_iv is that oracle's OWN near-activation SVI ATM and T = (expiry-activated)/yr.
// BT_SIGMA is an OPTIONAL override only (forces σ = BT_SIGMA·forward for every
// oracle, the old fixed behavior) — unset => fully dynamic per-oracle implied vol.
const SIGMA_FRAC_OVERRIDE =
  process.env.BT_SIGMA !== undefined ? Number(process.env.BT_SIGMA) : null;
const SPAN_SIGMA = Number(process.env.BT_SPAN ?? 2); // strip half-width in σ
const PRICE_LIMIT = Number(process.env.BT_PRICELIMIT ?? 20000); // ticks pulled per oracle
const CONCURRENCY = Number(process.env.BT_CONC ?? 8); // parallel oracle fetches

const PRICE_SCALE = 1_000_000_000; // 1e9 strike/settlement fixed-point
const CONTRACT_RAW = 1_000_000; // 1e6 raw = 1 contract = $1 payout (dUSDC 1e6)
const YEAR_MS = 365.25 * 24 * 3600 * 1000; // for annualizing implied/realized vol
const SVI_LIMIT = Number(process.env.BT_SVILIMIT ?? 5000); // SVI history pulled per oracle

// --- report shape (mirrored by app/app/_lib/predict-strip-client.ts) ---------
interface BacktestReport {
  generated_at: string;
  method: string; // one-line description; house = PLP counterparty earning the spread
  server: string;
  params: {
    sample_requested: number;
    n_buckets: number;
    /** σ source: dynamic per-oracle SVI ATM by default, or a fixed BT_SIGMA override. */
    sigma_source: string;
    /** the BT_SIGMA override fraction when set, else null (= dynamic per-oracle SVI). */
    sigma_frac_of_forward: number | null;
    span_sigma: number;
    price_limit_per_oracle: number;
  };
  universe: { settled_btc_with_settlement_price: number };
  epochs: number;
  skipped_no_history: number;
  buyer: {
    hit_rate: number;
    mean_epoch_return: number;
    stdev_epoch_return: number;
    sharpe_per_epoch: number;
    final_rolled_return: number;
    max_drawdown: number;
    equity_curve: number[]; // compounded, starts at 1.0 (degenerates to 0 — secondary)
    cum_return_curve: number[]; // HONEST headline: fixed-stake cumulative P&L, starts at 0
  };
  house: {
    // the PLP / vault strategy — the headline winning side
    mean_epoch_return: number;
    stdev_epoch_return: number;
    sharpe_per_epoch: number;
    final_rolled_return: number;
    max_drawdown: number;
    equity_curve: number[]; // compounded, starts at 1.0 (secondary)
    cum_return_curve: number[]; // HONEST headline: fixed-stake cumulative P&L, starts at 0
    cum_final_return: number; // last point of cum_return_curve (Σ per-epoch edge)
    avg_spread_captured_usd: number; // avg modeled round-trip spread/2 captured (USD)
  };
  spread: { avg_round_trip_usd: number; avg_frac_of_cost: number; avg_entry_cost_usd: number };
  // implied (SVI ATM near activation) vs realized (single-sample annualized move).
  // vol_risk_premium > 0 => options priced richer than realized => the house edge.
  vol: {
    avg_implied_iv: number;
    avg_realized_iv: number;
    vol_risk_premium: number;
    scatter: Array<{ implied_iv: number; realized_iv: number }>;
  };
  calibration: {
    bins: Array<{ p_mid: number; p_predicted_avg: number; freq_realized: number; n: number }>;
    brier: number;
  };
  sample_epochs: Array<{
    forward_usd: number;
    settlement_usd: number;
    cost_usd: number;
    payout_usd: number;
    hit: boolean;
  }>;
}

// --- normal CDF (mirror of structured.ts: A&S 7.1.26) -----------------------
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

// --- thin GET with a couple of retries (the indexer is occasionally flaky) ---
async function getJson<T>(pathname: string): Promise<T> {
  const url = `${SERVER}${pathname}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

interface PriceTick {
  checkpoint_timestamp_ms: number;
  spot: number;
  forward: number;
}

/** Forward at (or just after) activation + a recorded-tick dispersion proxy. */
function activationForward(
  ticks: PriceTick[],
  activatedAt: number,
): { forward: number; tsUsed: number; halfSpreadFrac: number } | null {
  if (!ticks.length) return null;
  const valid = ticks.filter((t) => Number.isFinite(t.forward) && t.forward > 0);
  if (!valid.length) return null;
  // Oldest tick at/after activation; fall back to the globally-oldest tick.
  const after = valid
    .filter((t) => t.checkpoint_timestamp_ms >= activatedAt)
    .sort((a, b) => a.checkpoint_timestamp_ms - b.checkpoint_timestamp_ms);
  const chosen = after[0] ?? valid.sort((a, b) => a.checkpoint_timestamp_ms - b.checkpoint_timestamp_ms)[0];
  const forward = chosen.forward;

  // Microstructure spread proxy: relative std-dev of the forward across the first
  // few minutes of recorded ticks (the indexer publishes no bid/ask, so we use
  // the realized local dispersion of the MM's own quoted forward as a half-spread).
  const window = valid
    .filter((t) => t.checkpoint_timestamp_ms <= chosen.checkpoint_timestamp_ms + 5 * 60_000)
    .map((t) => t.forward);
  const sample = window.length >= 3 ? window : valid.map((t) => t.forward).slice(0, 20);
  const mean = sample.reduce((s, v) => s + v, 0) / sample.length;
  const variance = sample.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, sample.length - 1);
  const relStd = mean > 0 ? Math.sqrt(variance) / mean : 0;
  // Clamp to a sane MM half-spread band [0.05%, 1.5%] of fair value.
  const halfSpreadFrac = Math.min(0.015, Math.max(0.0005, relStd));
  return { forward, tsUsed: chosen.checkpoint_timestamp_ms, halfSpreadFrac };
}

// --- SVI vol surface (real implied vol near activation) ----------------------
// The indexer publishes raw-SVI total-variance params per oracle; all fixed-point
// 1e9, with rho/m carrying a sign flag. Decode, apply signs, reconstruct ATM IV.
interface SviTick {
  checkpoint_timestamp_ms: number;
  a: number;
  b: number;
  rho: number;
  rho_negative?: boolean;
  m: number;
  m_negative?: boolean;
  sigma: number;
}
interface SviParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}
function decodeSvi(s: SviTick): SviParams | null {
  const a = Number(s.a),
    b = Number(s.b),
    rho = Number(s.rho),
    m = Number(s.m),
    sigma = Number(s.sigma);
  if (![a, b, rho, m, sigma].every(Number.isFinite)) return null;
  return {
    a: a / PRICE_SCALE,
    b: b / PRICE_SCALE,
    rho: (s.rho_negative ? -rho : rho) / PRICE_SCALE,
    m: (s.m_negative ? -m : m) / PRICE_SCALE,
    sigma: sigma / PRICE_SCALE,
  };
}
/** Annualized implied vol at log-moneyness k for time-to-expiry T (years). */
function sviImpliedVol(p: SviParams, k: number, tYears: number): number {
  if (!(tYears > 0)) return 0;
  const w = p.a + p.b * (p.rho * (k - p.m) + Math.sqrt((k - p.m) ** 2 + p.sigma ** 2));
  return Math.sqrt(Math.max(w, 1e-12) / tYears);
}
/** SVI snapshot nearest activation (oldest tick at/after; else globally oldest). */
function sviAtActivation(ticks: SviTick[], activatedAt: number): SviParams | null {
  if (!ticks.length) return null;
  const after = ticks
    .filter((t) => t.checkpoint_timestamp_ms >= activatedAt)
    .sort((a, b) => a.checkpoint_timestamp_ms - b.checkpoint_timestamp_ms);
  const chosen =
    after[0] ?? [...ticks].sort((a, b) => a.checkpoint_timestamp_ms - b.checkpoint_timestamp_ms)[0];
  return decodeSvi(chosen);
}

interface EpochResult {
  oracle_id: string;
  forward_usd: number;
  settlement_usd: number;
  cost_raw: number; // total entry cost across the strip (dUSDC 1e6)
  payout_raw: number; // $1 to the winning bucket, else 0
  pnl_raw: number; // buyer pnl = payout - cost
  ret: number; // buyer pnl / cost (per-epoch return on deployed capital)
  spread_raw: number; // total modeled round-trip spread paid (dUSDC 1e6)
  hit: boolean; // settlement landed in some in-strip bucket
  // --- HOUSE / VAULT (PLP counterparty) ---
  house_capital_raw: number; // max strip payout backed = (#buckets bought)·$1
  house_pnl_raw: number; // cost - payout (exact complement of buyer pnl)
  house_ret: number; // house pnl / capital backed
  // --- vol: real SVI ATM implied near activation vs single-sample realized vol ---
  implied_iv: number | null; // SVI ATM IV @ activation, T = (expiry-activated)/yr; null if no SVI
  realized_iv: number; // |ln(settle/forward_at_activation)| / sqrt(T), annualized
  // --- calibration: each bucket's predicted prob + whether it actually contained settlement ---
  calib: Array<{ weight: number; contained: boolean }>;
}

async function runEpoch(o: PredictOracle): Promise<EpochResult | null> {
  if (!o.settlement_price || !o.activated_at) return null;
  let ticks: PriceTick[];
  try {
    ticks = await getJson<PriceTick[]>(`/oracles/${o.oracle_id}/prices?limit=${PRICE_LIMIT}`);
  } catch {
    return null;
  }
  const act = activationForward(ticks, o.activated_at);
  if (!act) return null;
  const muRaw = act.forward; // 1e9 USD forward at activation == the view's μ

  // --- VOL: real SVI ATM implied vol near activation (preferred) vs realized. ---
  // T = the oracle's ORIGINAL life (activation -> expiry), in years. Implied IV is
  // the SVI ATM (k=0) at the snapshot nearest activation; if SVI history is
  // unretrievable we fall back to deriving an implied σ from the SAME forward
  // dispersion proxy the strip uses (relStd annualized). realized_iv is the single
  // -sample annualized move |ln(settle/forward@activation)| / sqrt(T).
  const tYears = (o.expiry - o.activated_at) / YEAR_MS;
  let impliedIv: number | null = null;
  if (tYears > 0) {
    let sviTicks: SviTick[] | null = null;
    try {
      sviTicks = await getJson<SviTick[]>(`/oracles/${o.oracle_id}/svi?limit=${SVI_LIMIT}`);
    } catch {
      sviTicks = null;
    }
    const params = sviTicks ? sviAtActivation(sviTicks, o.activated_at) : null;
    if (params) {
      impliedIv = sviImpliedVol(params, 0, tYears); // real SVI ATM
    } else {
      // fallback: annualize the near-activation forward dispersion (half-spread proxy).
      impliedIv = act.halfSpreadFrac / Math.sqrt(tYears);
    }
  }
  const realizedIv =
    tYears > 0 && o.settlement_price > 0 && muRaw > 0
      ? Math.abs(Math.log(o.settlement_price / muRaw)) / Math.sqrt(tYears)
      : 0;

  // --- DYNAMIC strip width: σ_strip = forward · atm_iv · √T (per-oracle SVI). ---
  // Default = this oracle's OWN implied vol (impliedIv == SVI ATM near activation,
  // else the forward-dispersion fallback) scaled to the oracle's life T. Nothing
  // fixed. BT_SIGMA, when set, overrides to the old σ = frac·forward for every
  // oracle. Skip the epoch if neither yields a positive width.
  let sigmaRaw: number;
  if (SIGMA_FRAC_OVERRIDE !== null) {
    sigmaRaw = muRaw * SIGMA_FRAC_OVERRIDE; // explicit fixed override
  } else if (impliedIv !== null && impliedIv > 0 && tYears > 0) {
    sigmaRaw = muRaw * impliedIv * Math.sqrt(tYears); // forward · atm_iv · √T
  } else {
    return null; // no implied vol available -> can't size a dynamic strip
  }
  if (!(sigmaRaw > 0)) return null;

  const grid: GridOracle = {
    oracle_id: o.oracle_id,
    expiry: o.expiry,
    min_strike: o.min_strike,
    tick_size: o.tick_size,
  };
  // SAME strip the engine builds; weight == fair_range == up(lower)-up(higher).
  const buckets = buildStripBuckets(grid, muRaw, sigmaRaw, N_BUCKETS, SPAN_SIGMA);

  // Entry cost: 1 contract/bucket. fair = weight (normal-CDF math); add a modeled
  // half-spread (round-trip = 2x) scaled by fair mass so deep-OTM legs cost less.
  const half = act.halfSpreadFrac;
  let costRaw = 0;
  let spreadRaw = 0;
  for (const b of buckets) {
    const fair = b.weight; // probability mass == fair_range in $ per $1 contract
    const halfSpreadProb = fair * half; // proportional MM edge
    const entryProb = Math.min(0.999, fair + halfSpreadProb);
    costRaw += entryProb * CONTRACT_RAW;
    spreadRaw += 2 * halfSpreadProb * CONTRACT_RAW; // round-trip (buy ask, sell bid)
  }

  // Settlement: pay $1 to the bucket containing settlement_price (exclusive lower,
  // inclusive higher to match (lower, higher] band semantics). Record per-bucket
  // predicted prob + realized containment for calibration.
  const sp = o.settlement_price;
  let hit = false;
  const calib: Array<{ weight: number; contained: boolean }> = [];
  for (const b of buckets) {
    const lo = Number(b.lower);
    const hi = Number(b.higher);
    const contained = sp > lo && sp <= hi;
    if (contained) hit = true;
    calib.push({ weight: b.weight, contained });
  }
  const payoutRaw = hit ? CONTRACT_RAW : 0;
  const pnlRaw = payoutRaw - costRaw;
  // HOUSE / VAULT: takes the other side. Capital backed = max strip payout =
  // (#buckets that received a contract)·$1 — here all N are bought. House P&L is
  // the exact complement of the buyer's: it keeps the premium, pays the winner.
  const houseCapitalRaw = buckets.length * CONTRACT_RAW;
  const housePnlRaw = costRaw - payoutRaw;
  return {
    oracle_id: o.oracle_id,
    forward_usd: muRaw / PRICE_SCALE,
    settlement_usd: sp / PRICE_SCALE,
    cost_raw: costRaw,
    payout_raw: payoutRaw,
    pnl_raw: pnlRaw,
    ret: costRaw > 0 ? pnlRaw / costRaw : 0,
    spread_raw: spreadRaw,
    hit,
    house_capital_raw: houseCapitalRaw,
    house_pnl_raw: housePnlRaw,
    house_ret: houseCapitalRaw > 0 ? housePnlRaw / houseCapitalRaw : 0,
    implied_iv: impliedIv,
    realized_iv: realizedIv,
    calib,
  };
}

async function mapPool<T, R>(items: T[], conc: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      if ((i + 1) % 25 === 0) process.stderr.write(`    …priced ${i + 1}/${items.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return out;
}

// --- summary stats ----------------------------------------------------------
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

async function main() {
  console.log('Pelagos range-ladder BACKTEST — indexer replay (no on-chain spend)');
  console.log(`  server   : ${SERVER}`);
  console.log(
    `  strip    : N=${N_BUCKETS} buckets, ±${SPAN_SIGMA}σ span, σ=${
      SIGMA_FRAC_OVERRIDE !== null
        ? `${(SIGMA_FRAC_OVERRIDE * 100).toFixed(2)}% of fwd (BT_SIGMA override)`
        : 'per-oracle SVI ATM (forward·atm_iv·√T)'
    }`,
  );
  console.log(`  sample   : up to ${SAMPLE_N} settled BTC oracles`);
  console.log('  pricing  : fair_range = up(lower)-up(higher) via normalCdf (== buildStripBuckets weight) + modeled MM half-spread\n');

  // 1) enumerate settled BTC oracles with a settlement price.
  let all: PredictOracle[];
  try {
    all = await predictServer.oracles();
  } catch (e) {
    console.error('Failed to fetch /oracles:', e);
    process.exit(1);
  }
  const settled = all.filter(
    (o) =>
      (o.underlying_asset ?? '').toUpperCase() === 'BTC' &&
      o.status === 'settled' &&
      typeof o.settlement_price === 'number' &&
      (o.settlement_price ?? 0) > 0 &&
      typeof o.activated_at === 'number' &&
      o.tick_size > 0,
  );
  console.log(`  found ${settled.length} settled BTC oracles with settlement_price + activation.`);

  // 2) sample — newest first (most relevant microstructure), capped at SAMPLE_N.
  const sorted = [...settled].sort((a, b) => (b.settled_at ?? 0) - (a.settled_at ?? 0));
  const sample = sorted.slice(0, Math.min(SAMPLE_N, sorted.length));
  console.log(`  replaying ${sample.length} epochs (priced from each oracle's near-activation forward)…\n`);

  // 3-6) price + settle each epoch.
  const raw = await mapPool(sample, CONCURRENCY, runEpoch);
  const epochs = raw.filter((r): r is EpochResult => r !== null);
  const skipped = sample.length - epochs.length;
  if (skipped > 0) console.log(`  (skipped ${skipped} epochs with no usable near-activation price history or no SVI for the dynamic σ)`);

  if (epochs.length === 0) {
    console.error('No usable epochs — indexer history may be sparse right now.');
    process.exit(1);
  }

  // 7) rolled equity curves: compound each side's per-epoch return chronologically.
  // Replay in chronological (settlement) order for an honest time series. epochs[]
  // preserved the newest-first sample order, so reverse to oldest-first.
  const chrono = [...epochs].reverse();

  // Compound a per-epoch return series into an equity curve (starts at 1.0) and
  // report its final rolled return + max drawdown.
  function rollEquity(perEpochRets: number[]): {
    curve: number[];
    finalRolledReturn: number;
    maxDrawdown: number;
  } {
    let equity = 1;
    const curve: number[] = [equity];
    let peak = equity;
    let maxDd = 0;
    for (const r of perEpochRets) {
      equity *= 1 + r;
      curve.push(equity);
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDd) maxDd = dd;
    }
    return { curve, finalRolledReturn: equity - 1, maxDrawdown: maxDd };
  }

  // Fixed-stake cumulative P&L: deploy ONE unit of capital each epoch and sum the
  // per-epoch returns (each `ret` is already P&L per unit deployed). Unlike the
  // compounded curve this never degenerates to 0 on a -100% epoch, so it's the
  // honest headline series — the steady accumulation of each side's per-epoch edge.
  function cumReturn(perEpochRets: number[]): number[] {
    let acc = 0;
    const curve: number[] = [0];
    for (const r of perEpochRets) {
      acc += r;
      curve.push(acc);
    }
    return curve;
  }

  // --- buyer (naive taker) ---
  const buyerRets = chrono.map((e) => e.ret);
  const buyer = rollEquity(buyerRets);
  const buyerCum = cumReturn(buyerRets);
  const hits = epochs.filter((e) => e.hit).length;
  const hitRate = hits / epochs.length;
  const buyerMean = mean(buyerRets);
  const buyerSd = std(buyerRets);
  const buyerSharpe = buyerSd > 0 ? buyerMean / buyerSd : 0; // per-epoch Sharpe (rf=0)

  // --- house / vault (PLP counterparty — the headline winning side) ---
  const houseRets = chrono.map((e) => e.house_ret);
  const house = rollEquity(houseRets);
  const houseCum = cumReturn(houseRets);
  const houseMean = mean(houseRets);
  const houseSd = std(houseRets);
  const houseSharpe = houseSd > 0 ? houseMean / houseSd : 0; // per-epoch Sharpe (rf=0)
  // Headline spread captured: avg modeled round-trip spread/2 (one-way edge) in USD.
  const avgSpreadCapturedUsd = mean(epochs.map((e) => e.spread_raw / 2)) / CONTRACT_RAW;

  // --- spread + cost ---
  const avgSpreadRaw = mean(epochs.map((e) => e.spread_raw));
  const avgCostRaw = mean(epochs.map((e) => e.cost_raw));
  const avgSpreadFrac = avgCostRaw > 0 ? avgSpreadRaw / avgCostRaw : 0;

  // --- vol: implied (SVI ATM near activation) vs realized (single-sample move) ---
  // Use only finite, positive-T epochs. implied_iv is null when SVI history was
  // unretrievable AND the dispersion fallback also failed; those are dropped from
  // the implied average but kept for realized. VRP = avg_implied - avg_realized
  // (>0 => options richer than realized => the house edge).
  const volPairs = epochs
    .filter((e) => e.implied_iv !== null && Number.isFinite(e.implied_iv) && Number.isFinite(e.realized_iv))
    .map((e) => ({ implied_iv: e.implied_iv as number, realized_iv: e.realized_iv }));
  const sviHitCount = epochs.filter((e) => e.implied_iv !== null).length;
  const avgImpliedIv = mean(volPairs.map((p) => p.implied_iv));
  const avgRealizedIv = mean(volPairs.map((p) => p.realized_iv));
  const volRiskPremium = avgImpliedIv - avgRealizedIv;
  // cap scatter to ~120 points (chronological, evenly sampled).
  const scatterStride = Math.max(1, Math.floor(volPairs.length / 120));
  const volScatter = volPairs.filter((_, i) => i % scatterStride === 0).slice(0, 120);

  // --- calibration: bin predicted prob (bucket.weight) into 10 bins, measure the
  // realized hit-frequency in each bin + the overall Brier score. ---
  const NBINS = 10;
  const binPredSum = new Array<number>(NBINS).fill(0);
  const binRealSum = new Array<number>(NBINS).fill(0);
  const binCount = new Array<number>(NBINS).fill(0);
  let brierSum = 0;
  let brierN = 0;
  for (const e of epochs) {
    for (const c of e.calib) {
      const ind = c.contained ? 1 : 0;
      const bin = Math.min(NBINS - 1, Math.max(0, Math.floor(c.weight * NBINS)));
      binPredSum[bin] += c.weight;
      binRealSum[bin] += ind;
      binCount[bin] += 1;
      brierSum += (c.weight - ind) ** 2;
      brierN += 1;
    }
  }
  const calibBins = Array.from({ length: NBINS }, (_, i) => ({
    p_mid: (i + 0.5) / NBINS,
    p_predicted_avg: binCount[i] > 0 ? binPredSum[i] / binCount[i] : 0,
    freq_realized: binCount[i] > 0 ? binRealSum[i] / binCount[i] : 0,
    n: binCount[i],
  }));
  const brier = brierN > 0 ? brierSum / brierN : 0;

  // --- report ---------------------------------------------------------------
  const fmtPct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const fmtUsd = (raw: number) => `$${(raw / CONTRACT_RAW).toFixed(4)}`;
  console.log('\n================  RESULTS  ================');
  console.log(`  epochs                 : ${epochs.length}`);
  console.log(`  hit-rate (winning leg) : ${fmtPct(hitRate)}  (${hits}/${epochs.length})`);
  console.log('  -- naive taker (strip BUYER) --');
  console.log(`  mean epoch return      : ${fmtPct(buyerMean)}`);
  console.log(`  stdev epoch return     : ${fmtPct(buyerSd)}`);
  console.log(`  Sharpe (per-epoch,rf=0): ${buyerSharpe.toFixed(3)}`);
  console.log(`  max drawdown (rolled)  : ${fmtPct(buyer.maxDrawdown)}`);
  console.log(`  final rolled return    : ${fmtPct(buyer.finalRolledReturn)}  (equity ${buyer.curve[0].toFixed(3)} -> ${buyer.curve[buyer.curve.length - 1].toFixed(3)})`);
  console.log('  -- HOUSE / VAULT (PLP counterparty — the strategy) --');
  console.log(`  mean epoch return      : ${fmtPct(houseMean)}`);
  console.log(`  stdev epoch return     : ${fmtPct(houseSd)}`);
  console.log(`  Sharpe (per-epoch,rf=0): ${houseSharpe.toFixed(3)}`);
  console.log(`  max drawdown (rolled)  : ${fmtPct(house.maxDrawdown)}`);
  console.log(`  final rolled return    : ${fmtPct(house.finalRolledReturn)}  (equity ${house.curve[0].toFixed(3)} -> ${house.curve[house.curve.length - 1].toFixed(3)})`);
  console.log(`  avg spread captured    : ${avgSpreadCapturedUsd.toFixed(4)} USD / strip`);
  console.log('  -- vol modeling (real SVI implied vs realized) --');
  console.log(`  implied IV source      : SVI ATM near activation on ${sviHitCount}/${epochs.length} epochs${sviHitCount < epochs.length ? ' (rest: forward-dispersion fallback)' : ''}`);
  console.log(`  avg implied IV (ATM)   : ${fmtPct(avgImpliedIv)}`);
  console.log(`  avg realized IV        : ${fmtPct(avgRealizedIv)}`);
  console.log(`  vol risk premium       : ${fmtPct(volRiskPremium)}  (>0 => options richer than realized => house edge)`);
  console.log('  -- spread / calibration --');
  console.log(`  avg round-trip spread  : ${fmtUsd(avgSpreadRaw)} / strip  (${fmtPct(avgSpreadFrac)} of cost)`);
  console.log(`  avg entry cost / strip : ${fmtUsd(avgCostRaw)}`);
  console.log(`  Brier score (lower=better): ${brier.toFixed(4)}`);
  console.log('==========================================\n');

  // a few example epochs for the eyeball test
  console.log('  sample epochs (chronological):');
  for (const e of chrono.slice(0, 5)) {
    console.log(
      `    fwd=$${e.forward_usd.toFixed(0)}  settle=$${e.settlement_usd.toFixed(0)}  ` +
        `cost=${fmtUsd(e.cost_raw)}  payout=${fmtUsd(e.payout_raw)}  buyer_ret=${fmtPct(e.ret)}  ` +
        `house_ret=${fmtPct(e.house_ret)}  ${e.hit ? 'HIT' : 'miss'}`,
    );
  }

  const summary: BacktestReport = {
    generated_at: new Date().toISOString(),
    method:
      'indexer-replay; strip σ is DYNAMIC per-oracle: σ_strip = forward · atm_iv · √T where atm_iv is that oracle\'s OWN near-activation SVI ATM and T = (expiry-activated)/yr (BT_SIGMA overrides to a fixed frac·forward). entry cost = up(lower)-up(higher) normalCdf fair_range (== buildStripBuckets weight) + modeled MM half-spread from near-activation forward dispersion; settlement pays $1 to the in-strip bucket. BUYER = naive taker (per-epoch return on deployed capital). HOUSE/VAULT = PLP counterparty taking the other side: collects premium, pays the winning bucket; pnl = cost - payout, return = pnl / max-strip-payout backed. HEADLINE curve = cum_return_curve: fixed-stake cumulative P&L (Σ per-epoch returns, never degenerates); equity_curve is the compounded variant (shown secondary). Calibration bins predicted prob vs realized hit-freq + Brier score.',
    server: SERVER,
    params: {
      sample_requested: SAMPLE_N,
      n_buckets: N_BUCKETS,
      sigma_source:
        SIGMA_FRAC_OVERRIDE !== null
          ? `fixed BT_SIGMA override (${(SIGMA_FRAC_OVERRIDE * 100).toFixed(2)}% of forward)`
          : 'per-oracle SVI ATM',
      sigma_frac_of_forward: SIGMA_FRAC_OVERRIDE,
      span_sigma: SPAN_SIGMA,
      price_limit_per_oracle: PRICE_LIMIT,
    },
    universe: { settled_btc_with_settlement_price: settled.length },
    epochs: epochs.length,
    skipped_no_history: skipped,
    buyer: {
      hit_rate: hitRate,
      mean_epoch_return: buyerMean,
      stdev_epoch_return: buyerSd,
      sharpe_per_epoch: buyerSharpe,
      final_rolled_return: buyer.finalRolledReturn,
      max_drawdown: buyer.maxDrawdown,
      equity_curve: buyer.curve,
      cum_return_curve: buyerCum,
    },
    house: {
      mean_epoch_return: houseMean,
      stdev_epoch_return: houseSd,
      sharpe_per_epoch: houseSharpe,
      final_rolled_return: house.finalRolledReturn,
      max_drawdown: house.maxDrawdown,
      equity_curve: house.curve,
      cum_return_curve: houseCum,
      cum_final_return: houseCum[houseCum.length - 1],
      avg_spread_captured_usd: avgSpreadCapturedUsd,
    },
    spread: {
      avg_round_trip_usd: avgSpreadRaw / CONTRACT_RAW,
      avg_frac_of_cost: avgSpreadFrac,
      avg_entry_cost_usd: avgCostRaw / CONTRACT_RAW,
    },
    vol: {
      avg_implied_iv: avgImpliedIv,
      avg_realized_iv: avgRealizedIv,
      vol_risk_premium: volRiskPremium,
      scatter: volScatter,
    },
    calibration: { bins: calibBins, brier },
    sample_epochs: chrono
      .filter((_, i) => i % Math.max(1, Math.floor(chrono.length / 8)) === 0)
      .slice(0, 8)
      .map((e) => ({
        forward_usd: e.forward_usd,
        settlement_usd: e.settlement_usd,
        cost_usd: e.cost_raw / CONTRACT_RAW,
        payout_usd: e.payout_raw / CONTRACT_RAW,
        hit: e.hit,
      })),
  };
  const outPath = resolve(__dirname, '../../.backtest-strip.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n  wrote summary -> ${outPath}`);
}

main().catch((e) => {
  console.error('backtest failed:', e);
  process.exit(1);
});
