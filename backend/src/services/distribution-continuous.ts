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
import { toBase64 } from '@mysten/sui/utils';
import { getSuiClient, signerAddress } from './predict/sui';
import { mintMockUsdc } from './mock-usdc';

const MOCK_USDC_TYPE =
  process.env.MOCK_USDC_TYPE ??
  '0xa630b97e9c5f1cd9804553018c9c14cf38a3ce51c341899ba7bc92a5f7c6a2af::mock_usdc::MOCK_USDC';
const USDC_DECIMALS = Number(process.env.MOCK_USDC_DECIMALS ?? 6);
const GRID_POINTS = 121;
const MAKER_FEE_BPS = 30; // 0.30%

// ---------------------------------------------------------------------------
// Markets (simulated continuous forwards)
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
}

const SEED: Array<{ id: string; underlying: string; question: string; unit: string; mu: number; sigma: number }> = [
  { id: 'eth-usd-30d', underlying: 'ETH', question: 'ETH/USD forward, 30d', unit: 'USD', mu: 2500, sigma: 320 },
  { id: 'btc-usd-30d', underlying: 'BTC', question: 'BTC/USD forward, 30d', unit: 'USD', mu: 68000, sigma: 7000 },
  { id: 'sol-usd-30d', underlying: 'SOL', question: 'SOL/USD forward, 30d', unit: 'USD', mu: 155, sigma: 28 },
];

function driftedMu(base: number): number {
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

  const lo = Math.min(muM - 4 * sigM, muT - 4 * sigT);
  const hi = Math.max(muM + 4 * sigM, muT + 4 * sigT);
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
  const core = quoteCore({
    marketMu: market.mu,
    marketSigma: market.sigma,
    targetMu: args.targetMu,
    targetSigma: args.targetSigma,
    collateral: args.collateralUsdc,
  });
  return { ...core, market_id: market.id, question: market.question, unit: market.unit };
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

  const bytes = await tx.build({ client });
  let dry: PreparedOpen['dry_run'] = { ok: false, status: 'unknown' };
  try {
    const dr = await client.dryRunTransactionBlock({ transactionBlock: bytes });
    dry = { ok: dr.effects?.status.status === 'success', status: dr.effects?.status.status ?? 'unknown', error: dr.effects?.status.error };
  } catch (e) {
    dry = { ok: false, status: 'dry_run_error', error: (e as Error).message };
  }

  return { tx_bytes: toBase64(bytes), sender: args.owner, collateral_usdc: quote.collateral_required_usdc, treasury, quote, dry_run: dry };
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
