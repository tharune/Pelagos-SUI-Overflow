/**
 * Continuous distribution markets (Paradigm-style).
 *
 * Unlike the discrete band model in `distribution.ts` (which approximates a
 * distribution from a Polymarket categorical event), this is a *continuous*
 * distribution market over a real-valued underlying:
 *
 *   - The market view is a continuous Normal pdf  f = N(muM, sigmaM).
 *   - The trader submits their own continuous Normal pdf  g = N(muT, sigmaT).
 *   - Both curves are scaled to a fixed pool L2 norm (the constant-L2-norm AMM
 *     from the paper: ||f||2 = ||g||2 = k).
 *   - The trader's position is the continuous payoff  g(x) - f(x), settled at
 *     the realized outcome x.  Collateral = -min_x (g(x) - f(x)).
 *
 * The market distribution + settlement are SIMULATED (seeded forwards). The
 * actual trade is settled ON-CHAIN: opening a position escrows the required
 * collateral into `pelagos_vault::vault` via a real wallet-signed Sui tx
 * (reusing the verified vault deposit), tagged with the position parameters.
 */
import { prepareDeposit, listShares, type PreparedTx } from './vault';

const GRID_POINTS = 121;          // odd, so the mean lands on a sample
const MAKER_FEE_BPS = 30;         // 0.30%
const POSITION_LABEL_PREFIX = 'distx';

export interface ContinuousMarket {
  id: string;
  underlying: string;
  question: string;
  unit: string;
  expiry_ts: number;
  /** Market-implied mean (the simulated forward). */
  mu: number;
  /** Market-implied standard deviation. */
  sigma: number;
  /** Sensible UI bounds for the trader's mean control. */
  mu_min: number;
  mu_max: number;
  /** Sensible UI bounds for the trader's stdev control. */
  sigma_min: number;
  sigma_max: number;
  step: number;
}

// Seeded continuous forwards. Simulated on purpose (the brief allows a
// simulated market); only the on-chain settlement leg is real. A small
// deterministic drift keeps them from looking frozen without needing a live
// price feed.
const SEED: Array<Omit<ContinuousMarket, 'expiry_ts' | 'mu_min' | 'mu_max' | 'sigma_min' | 'sigma_max' | 'step'>> = [
  { id: 'eth-usd-30d', underlying: 'ETH', question: 'ETH/USD forward, 30d', unit: 'USD', mu: 2500, sigma: 320 },
  { id: 'btc-usd-30d', underlying: 'BTC', question: 'BTC/USD forward, 30d', unit: 'USD', mu: 68000, sigma: 7000 },
  { id: 'sol-usd-30d', underlying: 'SOL', question: 'SOL/USD forward, 30d', unit: 'USD', mu: 155, sigma: 28 },
];

function driftedMu(base: number): number {
  // +/- ~1.5% slow sine drift keyed off the hour, so the forward moves a little.
  const hours = Date.now() / 3_600_000;
  return base * (1 + 0.015 * Math.sin(hours / 6));
}

export function listContinuousMarkets(): ContinuousMarket[] {
  const expiry = Date.now() + 30 * 86_400_000;
  return SEED.map((s) => {
    const mu = Math.round(driftedMu(s.mu) * 100) / 100;
    return {
      ...s,
      mu,
      expiry_ts: expiry,
      mu_min: Math.round(mu - 3 * s.sigma),
      mu_max: Math.round(mu + 3 * s.sigma),
      sigma_min: Math.round(s.sigma * 0.4),
      sigma_max: Math.round(s.sigma * 2.2),
      step: Math.max(1, Math.round(s.sigma / 50)),
    };
  });
}

export function getContinuousMarket(id: string): ContinuousMarket | undefined {
  return listContinuousMarkets().find((m) => m.id === id);
}

function normalPdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

export interface ContinuousQuote {
  market_id: string;
  question: string;
  unit: string;
  market_mu: number;
  market_sigma: number;
  target_mu: number;
  target_sigma: number;
  collateral_usdc: number;
  maker_fee_usdc: number;
  net_usdc: number;
  /** Sample grid (x-axis, in underlying units). */
  x: number[];
  /** Raw pdfs (for plotting the bell curves). */
  market_pdf: number[];
  target_pdf: number[];
  /** Dollar-scaled curves under the constant-L2 pool. */
  market_curve: number[];
  target_curve: number[];
  /** The position the trader owns: target_curve - market_curve. */
  trade_curve: number[];
  collateral_required_usdc: number;
  max_profit_usdc: number;
  max_loss_usdc: number;
  /** Expected payoff if the trader's view (g) is correct. */
  expected_value_usdc: number;
  /** L2 distance moved (how big the trade is). */
  l2_distance: number;
  quote_model: 'continuous_normal_l2_distribution_amm';
}

export function quoteContinuous(args: {
  marketId: string;
  targetMu: number;
  targetSigma: number;
  collateralUsdc: number;
}): ContinuousQuote {
  const market = getContinuousMarket(args.marketId);
  if (!market) throw new Error(`Unknown continuous market: ${args.marketId}`);

  const muM = market.mu;
  const sigM = market.sigma;
  const muT = Number(args.targetMu);
  const sigT = Number(args.targetSigma);
  const collateral = Number(args.collateralUsdc);
  if (!Number.isFinite(muT)) throw new Error('target_mu must be a number');
  if (!Number.isFinite(sigT) || sigT <= 0) throw new Error('target_sigma must be positive');
  if (!Number.isFinite(collateral) || collateral <= 0) throw new Error('collateral_usdc must be positive');

  // Grid covering both curves out to 4 sigma.
  const lo = Math.min(muM - 4 * sigM, muT - 4 * sigT);
  const hi = Math.max(muM + 4 * sigM, muT + 4 * sigT);
  const dx = (hi - lo) / (GRID_POINTS - 1);
  const x = Array.from({ length: GRID_POINTS }, (_, i) => lo + i * dx);

  const marketPdf = x.map((xi) => normalPdf(xi, muM, sigM));
  const targetPdf = x.map((xi) => normalPdf(xi, muT, sigT));

  const fee = (collateral * MAKER_FEE_BPS) / 10_000;
  const net = collateral - fee; // amount actually at risk in the position

  // Constant-L2-norm AMM: normalize both pdfs to unit L2 norm, then scale the
  // position g - f so its worst point (-min) equals the trader's risk budget.
  // That makes the collateral the trader locks == the collateral they input.
  const l2 = (p: number[]): number => Math.sqrt(p.reduce((s, v) => s + v * v * dx, 0));
  const fUnit = marketPdf.map((v) => v / Math.max(l2(marketPdf), 1e-9));
  const gUnit = targetPdf.map((v) => v / Math.max(l2(targetPdf), 1e-9));
  const tradeUnit = gUnit.map((v, i) => v - fUnit[i]);
  const downsideUnit = -Math.min(...tradeUnit); // >= 0; ~0 only when g == f
  const flat = downsideUnit < 1e-6;
  const scale = flat ? 0 : net / downsideUnit;

  const marketCurve = fUnit.map((v) => v * scale);
  const targetCurve = gUnit.map((v) => v * scale);
  const tradeCurve = tradeUnit.map((v) => v * scale);
  const maxTrade = Math.max(...tradeCurve, 0);
  const collateralRequired = flat ? 0 : collateral; // locked on-chain
  // Probability-weighted expected payoff if the trader's view g is correct.
  const gMass = targetPdf.reduce((s, v) => s + v * dx, 0) || 1;
  const ev = tradeCurve.reduce((s, v, i) => s + v * (targetPdf[i] / gMass) * dx, 0);
  const l2Distance = l2(tradeCurve);

  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    market_id: market.id,
    question: market.question,
    unit: market.unit,
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
    max_profit_usdc: r(Math.max(0, maxTrade)),
    max_loss_usdc: r(collateralRequired),
    expected_value_usdc: r(ev),
    l2_distance: r(l2Distance, 4),
    quote_model: 'continuous_normal_l2_distribution_amm',
  };
}

/** Compact on-chain label, e.g. "distx:eth-usd-30d:2600:250". Kept short for the Move vector<u8>. */
function encodeLabel(marketId: string, muT: number, sigT: number): string {
  return `${POSITION_LABEL_PREFIX}:${marketId}:${Math.round(muT)}:${Math.round(sigT)}`;
}

function decodeLabel(label: string): { marketId: string; targetMu: number; targetSigma: number } | null {
  const parts = label.split(':');
  if (parts.length < 4 || parts[0] !== POSITION_LABEL_PREFIX) return null;
  const targetMu = Number(parts[2]);
  const targetSigma = Number(parts[3]);
  if (!Number.isFinite(targetMu) || !Number.isFinite(targetSigma)) return null;
  return { marketId: parts[1], targetMu, targetSigma };
}

/**
 * Build the REAL on-chain open: escrow the quote's required collateral into the
 * vault, tagged with the position parameters. The wallet signs the returned
 * tx_bytes. Returns the quote alongside so the UI can confirm what was opened.
 */
export async function prepareContinuousOpen(args: {
  owner: string;
  marketId: string;
  targetMu: number;
  targetSigma: number;
  collateralUsdc: number;
}): Promise<PreparedTx & { quote: ContinuousQuote; label: string }> {
  const quote = quoteContinuous(args);
  if (quote.collateral_required_usdc <= 0) {
    throw new Error('Set a view different from the market (move mu or sigma) before opening a position.');
  }
  const lock = quote.collateral_required_usdc; // lock the trader's risk budget on-chain
  const label = encodeLabel(args.marketId, args.targetMu, args.targetSigma);
  const prepared = await prepareDeposit({ owner: args.owner, amount_usdc: lock, label });
  return { ...prepared, quote, label };
}

export interface ContinuousPosition {
  share_id: string;
  market_id: string;
  question: string;
  target_mu: number;
  target_sigma: number;
  market_mu: number;
  market_sigma: number;
  collateral_usdc: number;
}

/** Read a wallet's open continuous-distribution positions from on-chain shares. */
export async function listContinuousPositions(owner: string): Promise<ContinuousPosition[]> {
  const shares = await listShares(owner);
  const out: ContinuousPosition[] = [];
  for (const s of shares) {
    const decoded = decodeLabel(s.label);
    if (!decoded) continue;
    const market = getContinuousMarket(decoded.marketId);
    out.push({
      share_id: s.share_id,
      market_id: decoded.marketId,
      question: market?.question ?? decoded.marketId,
      target_mu: decoded.targetMu,
      target_sigma: decoded.targetSigma,
      market_mu: market?.mu ?? 0,
      market_sigma: market?.sigma ?? 0,
      collateral_usdc: s.principal_usdc,
    });
  }
  return out;
}
