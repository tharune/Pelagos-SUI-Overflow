/**
 * Pelagos structured-product engine over DeepBook Predict (testnet).
 *
 * Turns a continuous μ/σ "view" into a strip of on-grid Predict RANGE positions,
 * prices each bucket live off the SVI surface (devInspect, no funds), and builds
 * NON-CUSTODIAL PTBs (unsigned `tx.toJSON()` for the user's wallet) for:
 *   - mint a range strip (Distribution Markets / Tranches / PPN upside)
 *   - redeem a range bucket (live or permissionless after settlement)
 *   - PLP supply / withdraw  (PPN floor = "be the house")
 *   - create a PredictManager (first-open)
 *
 * Custody: the user's wallet owns the PredictManager and signs. The backend only
 * builds the unsigned tx and dry-runs a throwaway copy (mirrors vault/index.ts).
 * Quote asset is dUSDC (the only asset Predict accepts). Scales: strikes/prob 1e9,
 * dUSDC 1e6, quantity 1_000_000 = 1 contract = $1 payout.
 */
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { getSuiClient } from './sui';
import { PREDICT } from './config';
import {
  addCreateManager,
  addDeposit,
  addMintRange,
  addRedeemRange,
  addSupply,
  addWithdraw,
} from './ptb';
import { previewRange } from './index';

const PRICE_SCALE = 1_000_000_000; // 1e9 strike / probability fixed-point
const CONTRACT_UNIT = 1_000_000n; // 1e6 raw = 1 contract = $1 payout

export interface GridOracle {
  oracle_id: string;
  expiry: number | string;
  min_strike: number;
  tick_size: number;
}

function explorerTx(d: string): string {
  return `https://suiscan.xyz/${PREDICT.network}/tx/${d}`;
}

// --- standard normal CDF (Abramowitz & Stegun 7.1.26) for Normal-mass weights ---
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

function snapToGrid(o: GridOracle, valueRaw: number): number {
  if (!o.tick_size || o.tick_size <= 0) return o.min_strike;
  const k = Math.max(0, Math.round((valueRaw - o.min_strike) / o.tick_size));
  return o.min_strike + k * o.tick_size;
}

// ---------------------------------------------------------------------------
// Strip construction + live pricing
// ---------------------------------------------------------------------------

export interface StripBucket {
  lower: string; // 1e9 strike
  higher: string; // 1e9 strike
  weight: number; // Normal mass in (lower, higher]
}

/**
 * Slice a Normal(μ,σ) view (raw 1e9 strike units) into `n` contiguous on-grid
 * buckets spanning ±`spanSigma`·σ, weighted by the Normal mass each covers.
 * Buckets are de-duplicated and guaranteed lower<higher on the oracle's grid.
 */
export function buildStripBuckets(
  o: GridOracle,
  muRaw: number,
  sigmaRaw: number,
  n: number,
  spanSigma = 2,
): StripBucket[] {
  if (sigmaRaw <= 0) throw new Error('sigma must be positive');
  const span = spanSigma * sigmaRaw;
  const lo = muRaw - span;
  const hi = muRaw + span;
  const bandRaw = (hi - lo) / Math.max(1, n);
  const out: StripBucket[] = [];
  let prevHigher = -Infinity;
  for (let i = 0; i < n; i++) {
    let lower = snapToGrid(o, lo + i * bandRaw);
    let higher = snapToGrid(o, lo + (i + 1) * bandRaw);
    if (lower < prevHigher) lower = prevHigher; // keep contiguous, non-overlapping
    if (higher <= lower) higher = lower + o.tick_size; // enforce lower<higher on grid
    const w = normalCdf((higher - muRaw) / sigmaRaw) - normalCdf((lower - muRaw) / sigmaRaw);
    out.push({ lower: String(lower), higher: String(higher), weight: Math.max(w, 0) });
    prevHigher = higher;
  }
  return out;
}

export interface PricedBucket extends StripBucket {
  unit_price: number; // implied prob-in-band (mint_cost per $1 contract), 0..1
  quantity: string; // raw protocol qty (1e6 = 1 contract)
  cost_raw: string; // dUSDC 1e6
  max_payout_raw: string; // dUSDC 1e6 ( = quantity )
  lower_usd: number;
  higher_usd: number;
  /** false when the band prices outside the protocol's [min_ask,max_ask] bounds. */
  tradeable: boolean;
}

export interface StripQuote {
  oracle_id: string;
  expiry: string;
  mu_usd: number;
  sigma_usd: number;
  n: number;
  budget_raw: string;
  buckets: PricedBucket[];
  total_cost_raw: string;
  total_max_payout_raw: string;
  /** crude EV proxy: Σ weightᵢ·payoutᵢ − cost (informational). */
  expected_value_raw: string;
}

/**
 * Price a strip: allocate `budgetRaw` (dUSDC) across buckets by Normal weight,
 * size each bucket's quantity from its live per-contract cost (devInspect).
 */
export async function previewStrip(args: {
  oracle: GridOracle;
  muRaw: number;
  sigmaRaw: number;
  n: number;
  budgetRaw: bigint;
  spanSigma?: number;
  sender?: string;
}): Promise<StripQuote> {
  const { oracle, muRaw, sigmaRaw, n, budgetRaw } = args;
  const raw = buildStripBuckets(oracle, muRaw, sigmaRaw, n, args.spanSigma);

  // Pass 1: price each bucket per-contract via devInspect. Far-from-ATM bands can
  // abort in the protocol's spread/ask-bounds check (EAskPriceOutOfBounds); those
  // are marked untradeable and excluded from sizing rather than failing the strip.
  const unit: Array<{ b: StripBucket; unitCost: bigint; tradeable: boolean }> = [];
  for (const b of raw) {
    try {
      const u = await previewRange({
        key: { oracleId: oracle.oracle_id, expiry: String(oracle.expiry), lowerStrike: b.lower, higherStrike: b.higher },
        quantity: CONTRACT_UNIT,
        sender: args.sender,
      });
      const c = BigInt(u.mint_cost);
      unit.push({ b, unitCost: c, tradeable: c > 0n });
    } catch {
      unit.push({ b, unitCost: 0n, tradeable: false });
    }
  }

  // Pass 2: size each TRADEABLE bucket's QUANTITY proportional to its Normal
  // weight, scaled so total mint cost ≈ budget. This makes the payoff profile
  // mirror the user's view (most payout where they're most confident), instead of
  // letting cheap OTM bands soak the budget into huge lottery notionals.
  //   qtyᵢ = K·weightᵢ ,  K = budget·CONTRACT_UNIT / Σ(unitCostⱼ·weightⱼ)
  const denom = unit
    .filter((x) => x.tradeable && x.unitCost > 0n)
    .reduce((s, x) => s + Number(x.unitCost) * x.b.weight, 0);
  const K = denom > 0 ? (Number(budgetRaw) * Number(CONTRACT_UNIT)) / denom : 0;
  const priced: PricedBucket[] = [];
  let totalCost = 0n;
  let totalPayout = 0n;
  for (const { b, unitCost, tradeable } of unit) {
    let quantity = 0n;
    let cost = 0n;
    if (tradeable && unitCost > 0n && K > 0) {
      quantity = BigInt(Math.max(0, Math.floor(K * b.weight)));
      cost = (unitCost * quantity) / CONTRACT_UNIT;
    }
    totalCost += cost;
    totalPayout += quantity;
    priced.push({
      ...b,
      tradeable,
      unit_price: Number(unitCost) / Number(CONTRACT_UNIT),
      quantity: quantity.toString(),
      cost_raw: cost.toString(),
      max_payout_raw: quantity.toString(),
      lower_usd: Number(b.lower) / PRICE_SCALE,
      higher_usd: Number(b.higher) / PRICE_SCALE,
    });
  }
  // EV proxy under the user's own Normal view: Σ weightᵢ·payoutᵢ − cost.
  const evNum = priced.reduce((s, b) => s + b.weight * Number(b.max_payout_raw), 0);
  const ev = BigInt(Math.round(evNum)) - totalCost;
  return {
    oracle_id: oracle.oracle_id,
    expiry: String(oracle.expiry),
    mu_usd: muRaw / PRICE_SCALE,
    sigma_usd: sigmaRaw / PRICE_SCALE,
    n,
    budget_raw: budgetRaw.toString(),
    buckets: priced,
    total_cost_raw: totalCost.toString(),
    total_max_payout_raw: totalPayout.toString(),
    expected_value_raw: ev.toString(),
  };
}

// ---------------------------------------------------------------------------
// Non-custodial PTB builders (return unsigned tx_bytes for the wallet)
// ---------------------------------------------------------------------------

export interface PreparedTx {
  tx_bytes: string;
  sender: string;
  dry_run: { ok: boolean; status: string; gas_used?: string; error?: string };
}

/** Serialize an unsigned tx + dry-run a throwaway copy (mirrors vault/index.ts). */
async function buildAndDryRun(tx: Transaction, sender: string): Promise<PreparedTx> {
  const client = getSuiClient();
  tx.setSender(sender);
  const serialized = await tx.toJSON();
  let dry: PreparedTx['dry_run'] = { ok: false, status: 'unknown' };
  try {
    const probe = Transaction.from(serialized);
    probe.setSender(sender);
    const bytes = await probe.build({ client });
    const dr = await client.dryRunTransactionBlock({ transactionBlock: bytes });
    const status = dr.effects?.status.status ?? 'unknown';
    const g = dr.effects?.gasUsed;
    dry = {
      ok: status === 'success',
      status,
      gas_used: g
        ? (BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate)).toString()
        : undefined,
      error: dr.effects?.status.error,
    };
  } catch (e) {
    dry = { ok: false, status: 'dry_run_error', error: (e as Error).message };
  }
  return { tx_bytes: serialized, sender, dry_run: dry };
}

/** Select the owner's dUSDC, merge, split an exact-amount coin for this PTB. */
async function prepareDusdc(
  tx: Transaction,
  owner: string,
  amountRaw: bigint,
): Promise<TransactionObjectArgument> {
  const client = getSuiClient();
  const { data } = await client.getCoins({ owner, coinType: PREDICT.dusdcType });
  const total = data.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (total < amountRaw) {
    throw new Error(
      `Insufficient dUSDC: ${owner} holds ${total} raw, needs ${amountRaw}. ` +
        `dUSDC is faucet-gated — request it at https://tally.so/r/Xx102L.`,
    );
  }
  const [primary, ...rest] = data.map((c) => c.coinObjectId);
  if (rest.length > 0) tx.mergeCoins(tx.object(primary), rest.map((id) => tx.object(id)));
  const [coin] = tx.splitCoins(tx.object(primary), [tx.pure.u64(amountRaw)]);
  return coin;
}

/** First-open: create + share a PredictManager owned by the user's wallet. */
export async function prepareCreateManager(owner: string): Promise<PreparedTx> {
  const tx = new Transaction();
  addCreateManager(tx);
  return buildAndDryRun(tx, owner);
}

/** Mint a range strip into the user's manager (optionally funding dUSDC first). */
export async function prepareMintStrip(args: {
  owner: string;
  managerId: string;
  oracleId: string;
  expiry: number | string;
  buckets: Array<{ lower: string; higher: string; quantity: string }>;
  depositRaw?: bigint;
}): Promise<PreparedTx & { bucket_count: number }> {
  if (args.buckets.length === 0) throw new Error('strip has no buckets');
  const tx = new Transaction();
  if (args.depositRaw && args.depositRaw > 0n) {
    const coin = await prepareDusdc(tx, args.owner, args.depositRaw);
    addDeposit(tx, args.managerId, coin);
  }
  for (const b of args.buckets) {
    if (BigInt(b.quantity) <= 0n) continue;
    addMintRange(tx, {
      managerId: args.managerId,
      key: { oracleId: args.oracleId, expiry: String(args.expiry), lowerStrike: b.lower, higherStrike: b.higher },
      quantity: b.quantity,
    });
  }
  const prepared = await buildAndDryRun(tx, args.owner);
  return { ...prepared, bucket_count: args.buckets.length };
}

/** Redeem one range bucket (live or, after settlement, permissionless). */
export async function prepareRedeemRange(args: {
  owner: string;
  managerId: string;
  oracleId: string;
  expiry: number | string;
  lower: string;
  higher: string;
  quantity: string;
}): Promise<PreparedTx> {
  const tx = new Transaction();
  addRedeemRange(tx, {
    managerId: args.managerId,
    key: { oracleId: args.oracleId, expiry: String(args.expiry), lowerStrike: args.lower, higherStrike: args.higher },
    quantity: args.quantity,
  });
  return buildAndDryRun(tx, args.owner);
}

/** PPN floor / "be the house": supply dUSDC to the PLP vault, PLP coin to user. */
export async function preparePlpSupply(args: { owner: string; amountRaw: bigint }): Promise<PreparedTx> {
  const tx = new Transaction();
  const coin = await prepareDusdc(tx, args.owner, args.amountRaw);
  const plp = addSupply(tx, coin);
  tx.transferObjects([plp], tx.pure.address(args.owner));
  return buildAndDryRun(tx, args.owner);
}

/** Burn PLP for dUSDC back to the user (full balance unless sharesRaw given). */
export async function preparePlpWithdraw(args: {
  owner: string;
  plpCoinId?: string;
  sharesRaw?: bigint;
}): Promise<PreparedTx> {
  const client = getSuiClient();
  const tx = new Transaction();
  const plpType = `${PREDICT.packageId}::plp::PLP`;
  let lpCoin: TransactionObjectArgument;
  if (args.plpCoinId) {
    lpCoin = args.sharesRaw
      ? tx.splitCoins(tx.object(args.plpCoinId), [tx.pure.u64(args.sharesRaw)])[0]
      : tx.object(args.plpCoinId);
  } else {
    const { data } = await client.getCoins({ owner: args.owner, coinType: plpType });
    if (data.length === 0) throw new Error(`${args.owner} holds no PLP (${plpType}).`);
    const [primary, ...rest] = data.map((c) => c.coinObjectId);
    if (rest.length > 0) tx.mergeCoins(tx.object(primary), rest.map((id) => tx.object(id)));
    lpCoin = args.sharesRaw
      ? tx.splitCoins(tx.object(primary), [tx.pure.u64(args.sharesRaw)])[0]
      : tx.object(primary);
  }
  const quote = addWithdraw(tx, lpCoin);
  tx.transferObjects([quote], tx.pure.address(args.owner));
  return buildAndDryRun(tx, args.owner);
}

export interface DigestConfirmation {
  ok: boolean;
  status: string;
  digest: string;
  explorer_url: string;
  events: { type: string; parsedJson?: unknown }[];
  created_manager_id?: string | null;
}

/** Verify a wallet-executed Predict digest on-chain and surface its events. */
export async function confirmPredictDigest(digest: string): Promise<DigestConfirmation> {
  const client = getSuiClient();
  try {
    const tx = await client.waitForTransaction({
      digest,
      timeout: 12_000,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    const status = tx.effects?.status.status ?? 'unknown';
    const created = (tx.objectChanges ?? []).find(
      (c) => c.type === 'created' && 'objectType' in c && c.objectType.includes('::predict_manager::PredictManager'),
    );
    return {
      ok: status === 'success',
      status,
      digest,
      explorer_url: explorerTx(digest),
      events: (tx.events ?? []).map((e) => ({ type: e.type, parsedJson: e.parsedJson })),
      created_manager_id: created && 'objectId' in created ? created.objectId : null,
    };
  } catch {
    return { ok: false, status: 'not_found', digest, explorer_url: explorerTx(digest), events: [] };
  }
}
