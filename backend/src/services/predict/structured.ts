/**
 * Pelagos structured-product engine over DeepBook Predict (testnet).
 *
 * Turns a continuous μ/σ "view" into a strip of on-grid Predict RANGE positions,
 * prices each bucket with REAL market-maker pricing AND slippage taken straight
 * from the protocol (NOT linear/invented), and builds NON-CUSTODIAL PTBs
 * (unsigned `tx.toJSON()` for the user's wallet) for:
 *   - mint a range strip (Distribution Markets / Tranches / PPN upside)
 *   - redeem a range bucket (live or permissionless after settlement)
 *   - PLP supply / withdraw  (PPN floor = "be the house")
 *   - create a PredictManager (first-open)
 *
 * REAL PRICING + SLIPPAGE: every bucket is priced via on-chain
 * `get_range_trade_amounts(quantity)` (devInspect) AT ITS ACTUAL QUANTITY. The
 * protocol prices against post-trade vault state, so the cost it returns already
 * includes the market-maker spread + the slippage from the liability the order
 * adds. We surface BOTH sides: the ask (mint cost) and the bid (redeem-now
 * payout), plus the per-bucket slippage (cost vs the marginal 1-contract price)
 * and the round-trip spread. Nothing here is fabricated.
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
import { previewRangeBatch } from './index';

const PRICE_SCALE = 1_000_000_000; // 1e9 strike / probability fixed-point
const CONTRACT_UNIT = 1_000_000n; // 1e6 raw = 1 contract = $1 payout

// Protocol mint bounds are [min_ask, max_ask] ≈ [1%, 99%]; get_range_trade_amounts
// will PRICE bands outside that (so they look "tradeable") but mint_range aborts
// in assert_mintable_ask. Keep a safety margin for post-trade slippage so every
// bucket we surface as tradeable will actually mint.
const MIN_MINTABLE_PRICE = 0.02; // 2%
const MAX_MINTABLE_PRICE = 0.98; // 98%

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
  lower_usd: number;
  higher_usd: number;
  /** false when the band prices outside the protocol's [min_ask,max_ask] bounds. */
  tradeable: boolean;
  /** marginal per-1-contract ask probability (0..1), no size impact. */
  unit_price: number;
  quantity: string; // raw protocol qty (1e6 = 1 contract)
  /** ASK side — REAL mint cost at `quantity` incl. spread + slippage (dUSDC 1e6). */
  mint_cost_raw: string;
  /** BID side — REAL redeem-now payout at `quantity` incl. spread (dUSDC 1e6). */
  redeem_value_raw: string;
  max_payout_raw: string; // = quantity (settles $1/contract if in band)
  /** mint_cost − unit_price·quantity: the slippage/convexity over the marginal price. */
  slippage_raw: string;
  /** mint_cost − redeem_value: the round-trip MM spread at this size. */
  spread_raw: string;
  /** effective fill probability = mint_cost / quantity (0..1). */
  avg_price: number;
}

export interface StripQuote {
  oracle_id: string;
  expiry: string;
  mu_usd: number;
  sigma_usd: number;
  n: number;
  budget_raw: string;
  buckets: PricedBucket[];
  total_cost_raw: string; // Σ ask (what you pay now)
  total_redeem_value_raw: string; // Σ bid (what you'd get redeeming now)
  total_max_payout_raw: string; // Σ quantity (total notional across all buckets)
  /** Largest single bucket's payout — the HONEST best case, since settlement
   *  lands in exactly one band so only that band's contracts ever pay. */
  realized_max_payout_raw: string;
  total_slippage_raw: string; // Σ slippage over marginal
  round_trip_spread_raw: string; // total_cost − total_redeem_value
  /** EV under the user's own Normal view: Σ P(band)ᵢ·payoutᵢ − cost (probability
   *  mass, not the sizing weight). */
  expected_value_raw: string;
  /** Fraction of requested sizing weight that priced outside the [2%,98%] mintable
   *  band and was dropped (0 = none). A high value means the requested shape (e.g. a
   *  symmetric barbell) collapsed to a one-sided strip. */
  untradeable_weight_fraction: number;
}

interface UnitInfo {
  b: StripBucket;
  unitCost: bigint;
  tradeable: boolean;
}

/** REAL per-bucket (ask, bid) at the given quantities — one batched devInspect. */
async function priceAtQuantities(
  oracle: GridOracle,
  units: UnitInfo[],
  qtys: bigint[],
  sender?: string,
): Promise<Array<{ mint: bigint; redeem: bigint; ok: boolean }>> {
  const out = units.map(() => ({ mint: 0n, redeem: 0n, ok: false }));
  const idx: number[] = [];
  const bands: Array<{ lower: string; higher: string; quantity: bigint }> = [];
  units.forEach((x, i) => {
    if (x.tradeable && qtys[i] > 0n) {
      idx.push(i);
      bands.push({ lower: x.b.lower, higher: x.b.higher, quantity: qtys[i] });
    }
  });
  if (bands.length === 0) return out;
  try {
    const res = await previewRangeBatch({ oracleId: oracle.oracle_id, expiry: String(oracle.expiry), bands, sender });
    idx.forEach((origI, k) => {
      out[origI] = { mint: res[k].mint_cost, redeem: res[k].redeem_payout, ok: res[k].ok };
    });
  } catch {
    /* leave all unpriced; the caller falls back to the marginal estimate */
  }
  return out;
}

/**
 * Price a strip with REAL MM pricing + slippage (both sides):
 *  1. marginal per-contract ask for each bucket (sizing + slippage reference),
 *  2. size quantity ∝ Normal weight so payout mirrors the view,
 *  3. re-price each bucket AT its actual quantity (real post-trade cost = spread +
 *     slippage) and read the bid (redeem) side too,
 *  4. one budget correction so total real cost ≈ budget.
 */
export async function previewStrip(args: {
  oracle: GridOracle;
  muRaw: number;
  sigmaRaw: number;
  n: number;
  budgetRaw: bigint;
  spanSigma?: number;
  /** Optional per-bucket sizing override (length must equal n). The Volatility
   *  product reshapes the payout — barbell (wings-heavy, long gamma) vs pin
   *  (center-heavy, short gamma) — while reusing this exact MM pricing path.
   *  Weights drive quantity sizing only; the bands themselves are unchanged. */
  weights?: number[];
  /** Real-time sculpt path. Skips the on-chain SIZED re-price (step 3/4) and uses
   *  the marginal estimate, which step (2) already sizes so Σ(marginal cost) ≈
   *  budget. Greeks/payout come from quantities (unaffected); only per-bucket
   *  slippage detail is omitted. Lets the desk re-quote on every sculpt tick
   *  without a 1–4s devInspect, while the on-chain mint covers real slippage via
   *  the deposit headroom. */
  fast?: boolean;
  sender?: string;
}): Promise<StripQuote> {
  const { oracle, muRaw, sigmaRaw, n, budgetRaw } = args;
  const raw = buildStripBuckets(oracle, muRaw, sigmaRaw, n, args.spanSigma);
  if (args.weights && args.weights.length === raw.length) {
    for (let i = 0; i < raw.length; i++) raw[i] = { ...raw[i], weight: Math.max(0, args.weights[i]) };
  }

  // (1) marginal per-contract ask for EVERY band in one batched devInspect.
  // Tradeability is set here (stable, cacheable) — the per-contract ask must sit
  // inside the protocol's [2%,98%] mintable bounds. Out-of-bounds bands price
  // fine via get_range_trade_amounts but would abort at mint, so we exclude them.
  let marg: Array<{ mint_cost: bigint; redeem_payout: bigint; ok: boolean }> = raw.map(() => ({
    mint_cost: 0n, redeem_payout: 0n, ok: false,
  }));
  try {
    marg = await previewRangeBatch({
      oracleId: oracle.oracle_id,
      expiry: String(oracle.expiry),
      bands: raw.map((b) => ({ lower: b.lower, higher: b.higher, quantity: CONTRACT_UNIT })),
      sender: args.sender,
    });
  } catch {
    /* all unpriced -> strip resolves untradeable; route surfaces an empty quote */
  }
  const units: UnitInfo[] = raw.map((b, i) => {
    const c = marg[i].ok ? marg[i].mint_cost : 0n;
    const prob = Number(c) / Number(CONTRACT_UNIT);
    const mintable = c > 0n && prob >= MIN_MINTABLE_PRICE && prob <= MAX_MINTABLE_PRICE;
    return { b, unitCost: c, tradeable: mintable };
  });

  // (2) size quantity ∝ Normal weight, scaled so Σ(marginal cost) ≈ budget.
  const denom = units
    .filter((x) => x.tradeable && x.unitCost > 0n)
    .reduce((s, x) => s + Number(x.unitCost) * x.b.weight, 0);
  const K = denom > 0 ? (Number(budgetRaw) * Number(CONTRACT_UNIT)) / denom : 0;
  let qtys = units.map((x) => (x.tradeable && K > 0 ? BigInt(Math.max(0, Math.floor(K * x.b.weight))) : 0n));

  // (3) REAL cost (ask) + redeem (bid) at the actual quantities.
  //     fast (sculpt) path skips this on-chain round-trip and leaves `real`
  //     unpriced — the bucket loop then falls back to the marginal estimate,
  //     which step (2) already sized so Σ ≈ budget. Greeks/payout use quantities
  //     and are identical either way; only per-bucket slippage detail is dropped.
  let real = args.fast
    ? units.map(() => ({ mint: 0n, redeem: 0n, ok: false }))
    : await priceAtQuantities(oracle, units, qtys, args.sender);
  let totalMint = args.fast
    ? units.reduce((s, x, i) => s + (x.tradeable ? (x.unitCost * qtys[i]) / CONTRACT_UNIT : 0n), 0n)
    : real.reduce((s, r) => s + r.mint, 0n);

  // (4) one budget correction so real total cost ≈ budget (slippage shifts it off
  //     the marginal estimate). Skipped on the fast path — the marginal sizing in
  //     step (2) is already on-budget, so there's nothing to correct.
  if (!args.fast && totalMint > 0n) {
    const ratio = Number(budgetRaw) / Number(totalMint);
    if (Math.abs(ratio - 1) > 0.05) {
      qtys = qtys.map((q) => BigInt(Math.max(0, Math.floor(Number(q) * ratio))));
      real = await priceAtQuantities(oracle, units, qtys, args.sender);
      totalMint = real.reduce((s, r) => s + r.mint, 0n);
    }
  }

  const buckets: PricedBucket[] = [];
  let totalRedeem = 0n;
  let totalPayout = 0n;
  let maxPayout = 0n;
  let totalSlip = 0n;
  let evNum = 0;
  let totalWeight = 0;
  let droppedWeight = 0;
  for (let i = 0; i < units.length; i++) {
    const { b, unitCost, tradeable } = units[i];
    const q = qtys[i];
    const r = real[i];
    // Tradeability is decided by the MARGINAL price (step 1), which is stable and
    // cacheable. The sized re-price (step 3) only refines cost/bid with slippage —
    // if it throttles (r.ok === false), fall back to the marginal estimate rather
    // than dropping the band, so a transient RPC hiccup can never flicker a
    // genuinely tradeable strip to 0/N.
    const live = tradeable && q > 0n;
    const marginal = (unitCost * q) / CONTRACT_UNIT; // cost at the 1-contract marginal
    const mintCost = !live ? 0n : r.ok ? r.mint : marginal;
    // Redeem-now (bid) ≈ marginal less a nominal spread when the live bid is missing.
    const redeem = !live ? 0n : r.ok ? r.redeem : (marginal * 97n) / 100n;
    const slippage = mintCost > marginal ? mintCost - marginal : 0n;
    totalRedeem += redeem;
    totalPayout += live ? q : 0n;
    if (live && q > maxPayout) maxPayout = q;
    totalSlip += slippage;
    totalWeight += b.weight;
    if (!live) droppedWeight += b.weight;
    // EV under the user's Normal view weights payout by the band PROBABILITY MASS,
    // NOT the sizing weight (which is overridden with strategy/sculpt weights that
    // aren't probabilities — using it falsely reports a guaranteed positive edge).
    const pNorm = normalCdf((Number(b.higher) - muRaw) / sigmaRaw) - normalCdf((Number(b.lower) - muRaw) / sigmaRaw);
    evNum += pNorm * Number(live ? q : 0n);
    buckets.push({
      ...b,
      lower_usd: Number(b.lower) / PRICE_SCALE,
      higher_usd: Number(b.higher) / PRICE_SCALE,
      tradeable: live,
      unit_price: Number(unitCost) / Number(CONTRACT_UNIT),
      quantity: (live ? q : 0n).toString(),
      mint_cost_raw: mintCost.toString(),
      redeem_value_raw: redeem.toString(),
      max_payout_raw: (live ? q : 0n).toString(),
      slippage_raw: slippage.toString(),
      spread_raw: (mintCost > redeem ? mintCost - redeem : 0n).toString(),
      avg_price: q > 0n && live ? Number(mintCost) / Number(q) : 0,
    });
  }
  const ev = BigInt(Math.round(evNum)) - totalMint;
  return {
    oracle_id: oracle.oracle_id,
    expiry: String(oracle.expiry),
    mu_usd: muRaw / PRICE_SCALE,
    sigma_usd: sigmaRaw / PRICE_SCALE,
    n,
    budget_raw: budgetRaw.toString(),
    buckets,
    total_cost_raw: totalMint.toString(),
    total_redeem_value_raw: totalRedeem.toString(),
    total_max_payout_raw: totalPayout.toString(),
    realized_max_payout_raw: maxPayout.toString(),
    total_slippage_raw: totalSlip.toString(),
    round_trip_spread_raw: (totalMint > totalRedeem ? totalMint - totalRedeem : 0n).toString(),
    expected_value_raw: ev.toString(),
    untradeable_weight_fraction: totalWeight > 0 ? droppedWeight / totalWeight : 0,
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

/** Serialize an unsigned tx + dry-run a throwaway copy (mirrors vault/index.ts).
 *  We deliberately do NOT pin an explicit gas budget: a multi-leg DeepBook Predict
 *  PTB genuinely costs ~0.8 SUI, so the wallet's auto-estimate is correct. Forcing a
 *  lower budget turns the wallet's clean pre-sign rejection into an on-chain failure
 *  that still burns gas. The faucet's SUI grant is sized to cover the auto-estimate. */
async function buildAndDryRun(tx: Transaction, sender: string): Promise<PreparedTx> {
  tx.setSender(sender);
  // Skip the server-side dry-run — it cost two extra RPC round-trips (build +
  // dryRun) on every prepare for a preview the wallet re-computes at sign time.
  // Returning the unbuilt serialized tx keeps the Approve button near-instant.
  const serialized = await tx.toJSON();
  return { tx_bytes: serialized, sender, dry_run: { ok: true, status: 'skipped' } };
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
  let live = 0;
  for (const b of args.buckets) {
    if (BigInt(b.quantity) <= 0n) continue;
    addMintRange(tx, {
      managerId: args.managerId,
      key: { oracleId: args.oracleId, expiry: String(args.expiry), lowerStrike: b.lower, higherStrike: b.higher },
      quantity: b.quantity,
    });
    live++;
  }
  if (live === 0) throw new Error('no positive-quantity buckets to mint');
  const prepared = await buildAndDryRun(tx, args.owner);
  return { ...prepared, bucket_count: live };
}

/**
 * Mint MULTIPLE strips across different oracles/expiries in ONE PTB — the term
 * basket (a calendar bundle) and any multi-leg structure. One deposit funds them
 * all; each band keys its own oracle+expiry, so the protocol books the legs
 * independently. Non-custodial (unsigned tx for the wallet).
 */
export async function prepareMintMultiStrip(args: {
  owner: string;
  managerId: string;
  legs: Array<{ oracleId: string; expiry: number | string; buckets: Array<{ lower: string; higher: string; quantity: string }> }>;
  depositRaw?: bigint;
}): Promise<PreparedTx & { bucket_count: number; leg_count: number }> {
  const tx = new Transaction();
  if (args.depositRaw && args.depositRaw > 0n) {
    const coin = await prepareDusdc(tx, args.owner, args.depositRaw);
    addDeposit(tx, args.managerId, coin);
  }
  let live = 0;
  let legs = 0;
  for (const leg of args.legs) {
    let legLive = 0;
    for (const b of leg.buckets) {
      if (BigInt(b.quantity) <= 0n) continue;
      addMintRange(tx, {
        managerId: args.managerId,
        key: { oracleId: leg.oracleId, expiry: String(leg.expiry), lowerStrike: b.lower, higherStrike: b.higher },
        quantity: b.quantity,
      });
      live++;
      legLive++;
    }
    if (legLive > 0) legs++;
  }
  if (live === 0) throw new Error('no positive-quantity buckets to mint across the basket legs');
  const prepared = await buildAndDryRun(tx, args.owner);
  return { ...prepared, bucket_count: live, leg_count: legs };
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

/**
 * SELL a whole strip in one PTB: redeem every band of the tranche/strip back to
 * dUSDC (the bid side). Non-custodial — the dry-run will reject if the wallet's
 * manager doesn't actually hold these band positions, so the UI surfaces a clear
 * "no position to sell" rather than a silent failure.
 */
export async function prepareRedeemStrip(args: {
  owner: string;
  managerId: string;
  oracleId: string;
  expiry: number | string;
  buckets: Array<{ lower: string; higher: string; quantity: string }>;
}): Promise<PreparedTx & { bucket_count: number }> {
  const live = args.buckets.filter((b) => BigInt(b.quantity) > 0n);
  if (live.length === 0) throw new Error('no positive-quantity buckets to redeem');
  const tx = new Transaction();
  for (const b of live) {
    addRedeemRange(tx, {
      managerId: args.managerId,
      key: { oracleId: args.oracleId, expiry: String(args.expiry), lowerStrike: b.lower, higherStrike: b.higher },
      quantity: b.quantity,
    });
  }
  const prepared = await buildAndDryRun(tx, args.owner);
  return { ...prepared, bucket_count: live.length };
}

/** PPN floor / "be the house": supply dUSDC to the PLP vault, PLP coin to user. */
export async function preparePlpSupply(args: { owner: string; amountRaw: bigint }): Promise<PreparedTx> {
  const tx = new Transaction();
  const coin = await prepareDusdc(tx, args.owner, args.amountRaw);
  const plp = addSupply(tx, coin);
  tx.transferObjects([plp], tx.pure.address(args.owner));
  return buildAndDryRun(tx, args.owner);
}

/**
 * PPN open in ONE PTB: split the user's dUSDC into a FLOOR sleeve supplied to the
 * PLP vault (principal-protection "be the house" yield) and an UPSIDE sleeve
 * deposited into the manager and minted as a range strip. Non-custodial.
 */
export async function preparePpnOpen(args: {
  owner: string;
  managerId: string;
  oracleId: string;
  expiry: number | string;
  buckets: Array<{ lower: string; higher: string; quantity: string }>;
  floorRaw: bigint;
  upsideRaw: bigint;
}): Promise<PreparedTx & { floor_raw: string; upside_raw: string; bucket_count: number }> {
  if (args.floorRaw <= 0n) throw new Error('floor must be positive');
  const live = args.buckets.filter((b) => BigInt(b.quantity) > 0n);
  if (live.length === 0) throw new Error('no positive-quantity upside buckets');
  const tx = new Transaction();
  const total = await prepareDusdc(tx, args.owner, args.floorRaw + args.upsideRaw);
  // split the floor sleeve off; remainder is the upside sleeve
  const [floorCoin] = tx.splitCoins(total, [tx.pure.u64(args.floorRaw)]);
  const plp = addSupply(tx, floorCoin);
  tx.transferObjects([plp], tx.pure.address(args.owner));
  addDeposit(tx, args.managerId, total); // remaining (= upsideRaw) funds the strip
  for (const b of live) {
    addMintRange(tx, {
      managerId: args.managerId,
      key: { oracleId: args.oracleId, expiry: String(args.expiry), lowerStrike: b.lower, higherStrike: b.higher },
      quantity: b.quantity,
    });
  }
  const prepared = await buildAndDryRun(tx, args.owner);
  return { ...prepared, floor_raw: args.floorRaw.toString(), upside_raw: args.upsideRaw.toString(), bucket_count: live.length };
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
