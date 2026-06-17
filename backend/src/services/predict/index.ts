import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import type { SuiObjectChange } from '@mysten/sui/jsonRpc';
import { PREDICT, predictConfig } from './config';
import { getSuiClient, getSigner, signerAddress } from './sui';
import {
  addCreateManager,
  addDeposit,
  addGetRangeTradeAmounts,
  addGetTradeAmounts,
  addMint,
  addMintRange,
  addRedeem,
  addRedeemRange,
  addSupply,
  addWithdraw,
  type MarketKeyParams,
  type RangeKeyParams,
} from './ptb';

export { predictConfig, signerAddress };
export * from './server';
export { buildVolSurface, type VolSurface, type VolSlice } from './vol';
export { buildImpliedDensity, type ImpliedDensity } from './density';
export { buildMarketsDepth, type MarketsDepth, type MarketRow } from './markets';

// devInspect needs a sender but never requires it to own anything. Falls back to
// a known testnet address so read-only previews work with no key configured.
const FALLBACK_SENDER =
  process.env.SUI_ACTIVE_ADDRESS ??
  '0x78f0be0d03f277c11d696436a3dd2f02c02f9cce118f6c0286fbc701a29ec411';

export interface ExecResult {
  digest: string;
  status: string;
  object_changes: SuiObjectChange[];
  events: { type: string; parsedJson?: unknown }[];
  explorer_url: string;
}

function explorerTx(digest: string): string {
  return `https://suiscan.xyz/${PREDICT.network}/tx/${digest}`;
}

async function execute(tx: Transaction): Promise<ExecResult> {
  const client = getSuiClient();
  const signer = getSigner();
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  const status = res.effects?.status.status ?? 'unknown';
  if (status !== 'success') {
    throw new Error(
      `Predict tx failed (${res.digest}): ${res.effects?.status.error ?? 'unknown error'}`,
    );
  }
  return {
    digest: res.digest,
    status,
    object_changes: res.objectChanges ?? [],
    events: (res.events ?? []).map((e) => ({ type: e.type, parsedJson: e.parsedJson })),
    explorer_url: explorerTx(res.digest),
  };
}

function createdObjectId(changes: SuiObjectChange[], typeSuffix: string): string | null {
  const found = changes.find(
    (c) => c.type === 'created' && 'objectType' in c && c.objectType.includes(typeSuffix),
  );
  return found && 'objectId' in found ? found.objectId : null;
}

/**
 * Select dUSDC coins owned by `owner` summing to >= `amountRaw`, merge them, and
 * split off an exact-amount coin. Returns the split coin argument for downstream
 * commands (deposit / supply) in the same PTB.
 */
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
      `Insufficient dUSDC: signer ${owner} holds ${total} raw, needs ${amountRaw}. ` +
        `dUSDC is faucet-gated (not testnet USDC) — request it via the DeepBook Predict ` +
        `form at https://tally.so/r/Xx102L, then retry.`,
    );
  }
  const [primary, ...rest] = data.map((c) => c.coinObjectId);
  if (rest.length > 0) {
    tx.mergeCoins(
      tx.object(primary),
      rest.map((id) => tx.object(id)),
    );
  }
  const [coin] = tx.splitCoins(tx.object(primary), [tx.pure.u64(amountRaw)]);
  return coin;
}

// ---------------------------------------------------------------------------
// Writes (require a configured signer)
// ---------------------------------------------------------------------------

/** Create the caller's single reusable PredictManager. */
export async function createManager(): Promise<ExecResult & { manager_id: string | null }> {
  const tx = new Transaction();
  addCreateManager(tx);
  const result = await execute(tx);
  return {
    ...result,
    manager_id: createdObjectId(result.object_changes, '::predict_manager::PredictManager'),
  };
}

/** Deposit dUSDC from the signer's wallet into their PredictManager. */
export async function deposit(args: {
  managerId: string;
  amountRaw: bigint;
}): Promise<ExecResult> {
  const owner = requireSignerAddress();
  const tx = new Transaction();
  const coin = await prepareDusdc(tx, owner, args.amountRaw);
  addDeposit(tx, args.managerId, coin);
  return execute(tx);
}

/**
 * Mint a directional binary position. Optionally funds the manager in the same
 * PTB by depositing `depositAmountRaw` of dUSDC first (one atomic block).
 */
export async function mint(args: {
  managerId: string;
  key: MarketKeyParams;
  quantity: bigint;
  depositAmountRaw?: bigint;
}): Promise<ExecResult> {
  const tx = new Transaction();
  if (args.depositAmountRaw && args.depositAmountRaw > 0n) {
    const owner = requireSignerAddress();
    const coin = await prepareDusdc(tx, owner, args.depositAmountRaw);
    addDeposit(tx, args.managerId, coin);
  }
  addMint(tx, { managerId: args.managerId, key: args.key, quantity: args.quantity });
  return execute(tx);
}

/** Redeem a directional binary position (live, or permissionless when settled). */
export async function redeem(args: {
  managerId: string;
  key: MarketKeyParams;
  quantity: bigint;
  permissionless?: boolean;
}): Promise<ExecResult> {
  const tx = new Transaction();
  addRedeem(tx, args);
  return execute(tx);
}

/** Mint a vertical range position. */
export async function mintRange(args: {
  managerId: string;
  key: RangeKeyParams;
  quantity: bigint;
  depositAmountRaw?: bigint;
}): Promise<ExecResult> {
  const tx = new Transaction();
  if (args.depositAmountRaw && args.depositAmountRaw > 0n) {
    const owner = requireSignerAddress();
    const coin = await prepareDusdc(tx, owner, args.depositAmountRaw);
    addDeposit(tx, args.managerId, coin);
  }
  addMintRange(tx, { managerId: args.managerId, key: args.key, quantity: args.quantity });
  return execute(tx);
}

/** Redeem a vertical range position. */
export async function redeemRange(args: {
  managerId: string;
  key: RangeKeyParams;
  quantity: bigint;
}): Promise<ExecResult> {
  const tx = new Transaction();
  addRedeemRange(tx, args);
  return execute(tx);
}

/** Supply dUSDC into the PLP vault; PLP shares are sent to the signer. */
export async function supply(args: { amountRaw: bigint }): Promise<ExecResult> {
  const owner = requireSignerAddress();
  const tx = new Transaction();
  const coin = await prepareDusdc(tx, owner, args.amountRaw);
  const plp = addSupply(tx, coin);
  tx.transferObjects([plp], tx.pure.address(owner));
  return execute(tx);
}

/** Burn PLP shares and withdraw dUSDC back to the signer. */
export async function withdraw(args: {
  plpCoinId?: string;
  sharesRaw?: bigint;
}): Promise<ExecResult> {
  const owner = requireSignerAddress();
  const client = getSuiClient();
  const tx = new Transaction();
  const plpType = `0x2::coin::Coin<${PREDICT.packageId}::plp::PLP>`;

  let lpCoin: TransactionObjectArgument;
  if (args.plpCoinId) {
    lpCoin = args.sharesRaw
      ? tx.splitCoins(tx.object(args.plpCoinId), [tx.pure.u64(args.sharesRaw)])[0]
      : tx.object(args.plpCoinId);
  } else {
    const plpCoinType = `${PREDICT.packageId}::plp::PLP`;
    const { data } = await client.getCoins({ owner, coinType: plpCoinType });
    if (data.length === 0) throw new Error(`Signer ${owner} holds no PLP (${plpType}).`);
    const [primary, ...rest] = data.map((c) => c.coinObjectId);
    if (rest.length > 0) tx.mergeCoins(tx.object(primary), rest.map((id) => tx.object(id)));
    lpCoin = args.sharesRaw
      ? tx.splitCoins(tx.object(primary), [tx.pure.u64(args.sharesRaw)])[0]
      : tx.object(primary);
  }
  const quote = addWithdraw(tx, lpCoin);
  tx.transferObjects([quote], tx.pure.address(owner));
  return execute(tx);
}

// ---------------------------------------------------------------------------
// Reads / simulations (no signer required)
// ---------------------------------------------------------------------------

function lastReturnValues(results: unknown): number[][] {
  const arr = (results as { returnValues?: [number[], string][] }[]) ?? [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const rv = arr[i]?.returnValues;
    if (rv && rv.length > 0) return rv.map((x) => x[0]);
  }
  return [];
}

/**
 * Preview a trade via `get_trade_amounts` using devInspect. Reads live oracle
 * pricing with no funds and no signer — the cleanest proof the wiring resolves
 * against the real on-chain package.
 */
export async function previewTrade(args: {
  key: MarketKeyParams;
  quantity: bigint;
  sender?: string;
}): Promise<{ mint_cost: string; redeem_payout: string; sender: string }> {
  const client = getSuiClient();
  const sender = args.sender ?? signerAddress() ?? FALLBACK_SENDER;
  const tx = new Transaction();
  addGetTradeAmounts(tx, { key: args.key, quantity: args.quantity });
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
  if (res.effects.status.status !== 'success') {
    throw new Error(`previewTrade devInspect failed: ${res.effects.status.error}`);
  }
  const values = lastReturnValues(res.results);
  if (values.length < 2) throw new Error('previewTrade: expected two u64 return values');
  return {
    mint_cost: bcs.u64().parse(Uint8Array.from(values[0])),
    redeem_payout: bcs.u64().parse(Uint8Array.from(values[1])),
    sender,
  };
}

/**
 * Preview a vertical RANGE trade via `get_range_trade_amounts` using devInspect.
 * Same fund-free, signer-free live read as previewTrade, for a (lower, higher] band.
 */
// ---------------------------------------------------------------------------
// Resilience for the hot devInspect read path.
//
// A single strip quote fires DOZENS of concurrent get_range_trade_amounts reads
// (n buckets × marginal + sized, × 3 tranches). Unbounded against a public RPC
// that throttles, a burst makes calls fail — and a failed price marks a
// perfectly tradeable band "untradeable", so the whole strip can flicker to
// 0/N. Three layers keep the live book stable WITHOUT faking anything:
//   1. short-TTL cache — identical (band, quantity) reads inside the window are
//      served from the last real on-chain result instead of re-hitting RPC;
//   2. concurrency gate — caps simultaneous devInspect calls so we never
//      self-throttle the burst;
//   3. retry — transient (thrown) RPC failures back off and retry; a clean
//      status!=success is a DETERMINISTIC out-of-band band, surfaced at once.
// Pricing is sender-independent (devInspect is fund-free), so the cache key omits
// the sender. Out-of-band rejections are cached negatively to avoid re-querying.
// ---------------------------------------------------------------------------
type RangePrice = { mint_cost: string; redeem_payout: string; sender: string };
const RANGE_TTL_MS = 4000;
// Cache POSITIVES only. Caching a failure risks poisoning: a throttle that
// surfaces as status!=success would mark a genuinely tradeable band dead for the
// whole TTL and cascade the strip to 0/N. Failures simply re-resolve next call.
const RANGE_CACHE = new Map<string, { ok: true; v: RangePrice; exp: number }>();
const RANGE_MAX_CONCURRENT = 8;
let rangeInflight = 0;
const rangeQueue: Array<() => void> = [];
async function rangeGate<T>(fn: () => Promise<T>): Promise<T> {
  if (rangeInflight >= RANGE_MAX_CONCURRENT) await new Promise<void>((r) => rangeQueue.push(r));
  rangeInflight++;
  try {
    return await fn();
  } finally {
    rangeInflight--;
    rangeQueue.shift()?.();
  }
}

export async function previewRange(args: {
  key: RangeKeyParams;
  quantity: bigint;
  sender?: string;
}): Promise<RangePrice> {
  const client = getSuiClient();
  const sender = args.sender ?? signerAddress() ?? FALLBACK_SENDER;
  const cacheKey = `${args.key.oracleId}|${args.key.expiry}|${args.key.lowerStrike}|${args.key.higherStrike}|${args.quantity}`;
  const hit = RANGE_CACHE.get(cacheKey);
  if (hit && hit.exp > Date.now()) return { ...hit.v, sender };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await rangeGate(() => {
        const tx = new Transaction();
        addGetRangeTradeAmounts(tx, { key: args.key, quantity: args.quantity });
        return client.devInspectTransactionBlock({ sender, transactionBlock: tx });
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
      continue;
    }
    if (res.effects.status.status !== 'success') {
      throw new Error(`previewRange devInspect failed: ${res.effects.status.error}`);
    }
    const values = lastReturnValues(res.results);
    if (values.length < 2) throw new Error('previewRange: expected two u64 return values');
    const v: RangePrice = {
      mint_cost: bcs.u64().parse(Uint8Array.from(values[0])),
      redeem_payout: bcs.u64().parse(Uint8Array.from(values[1])),
      sender,
    };
    RANGE_CACHE.set(cacheKey, { ok: true, v, exp: Date.now() + RANGE_TTL_MS });
    return v;
  }
  throw lastErr ?? new Error('previewRange: RPC unavailable');
}

/**
 * Price an ENTIRE range strip in ONE devInspect.
 *
 * A strip quote previously fired one devInspect per band (× marginal + sized ×
 * tranches = dozens of concurrent reads) which throttles the public RPC and
 * flickers bands to "untradeable". `get_range_trade_amounts` PRICES out-of-band
 * bands (it doesn't abort — only `mint` does), so every band of a strip can be
 * batched into a single transaction block and read back from the per-command
 * return values. This collapses ~17 RPC calls per strip to 1.
 *
 * `addGetRangeTradeAmounts` emits two commands per band — `range_key::new` then
 * `get_range_trade_amounts` (the (u64,u64) ask/bid) — so the priced amounts sit
 * at the odd command indices. Returns one entry per input band, in order;
 * `ok:false` marks a band whose amounts were missing.
 */
export async function previewRangeBatch(args: {
  oracleId: string;
  expiry: number | string;
  bands: Array<{ lower: string; higher: string; quantity: bigint }>;
  sender?: string;
}): Promise<Array<{ mint_cost: bigint; redeem_payout: bigint; ok: boolean }>> {
  const out = args.bands.map(() => ({ mint_cost: 0n, redeem_payout: 0n, ok: false }));
  if (args.bands.length === 0) return out;
  const client = getSuiClient();
  const sender = args.sender ?? signerAddress() ?? FALLBACK_SENDER;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await rangeGate(() => {
        const tx = new Transaction();
        for (const b of args.bands) {
          addGetRangeTradeAmounts(tx, {
            key: { oracleId: args.oracleId, expiry: args.expiry, lowerStrike: b.lower, higherStrike: b.higher },
            quantity: b.quantity,
          });
        }
        return client.devInspectTransactionBlock({ sender, transactionBlock: tx });
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      continue;
    }
    if (res.effects.status.status !== 'success') {
      throw new Error(`previewRangeBatch devInspect failed: ${res.effects.status.error}`);
    }
    const results = (res.results as { returnValues?: [number[], string][] }[]) ?? [];
    for (let i = 0; i < args.bands.length; i++) {
      const rv = results[2 * i + 1]?.returnValues;
      if (rv && rv.length >= 2) {
        out[i] = {
          mint_cost: BigInt(bcs.u64().parse(Uint8Array.from(rv[0][0]))),
          redeem_payout: BigInt(bcs.u64().parse(Uint8Array.from(rv[1][0]))),
          ok: true,
        };
      }
    }
    return out;
  }
  throw lastErr ?? new Error('previewRangeBatch: RPC unavailable');
}

/** Dry-run `create_manager` via devInspect (proves the entry resolves; no write). */
export async function simulateCreateManager(
  sender?: string,
): Promise<{ ok: boolean; status: string; sender: string; error?: string }> {
  const client = getSuiClient();
  const from = sender ?? signerAddress() ?? FALLBACK_SENDER;
  const tx = new Transaction();
  addCreateManager(tx);
  const res = await client.devInspectTransactionBlock({ sender: from, transactionBlock: tx });
  return {
    ok: res.effects.status.status === 'success',
    status: res.effects.status.status,
    sender: from,
    error: res.effects.status.error,
  };
}

/**
 * Dry-run a real `mint` (optionally with an in-PTB deposit) via devInspect. Useful
 * to validate the full mint path reaches the protocol logic before spending funds.
 */
export async function simulateMint(args: {
  managerId: string;
  key: MarketKeyParams;
  quantity: bigint;
  depositAmountRaw?: bigint;
  sender?: string;
}): Promise<{ ok: boolean; status: string; sender: string; error?: string }> {
  const client = getSuiClient();
  const from = args.sender ?? signerAddress() ?? FALLBACK_SENDER;
  const tx = new Transaction();
  if (args.depositAmountRaw && args.depositAmountRaw > 0n) {
    const coin = await prepareDusdc(tx, from, args.depositAmountRaw);
    addDeposit(tx, args.managerId, coin);
  }
  addMint(tx, { managerId: args.managerId, key: args.key, quantity: args.quantity });
  const res = await client.devInspectTransactionBlock({ sender: from, transactionBlock: tx });
  return {
    ok: res.effects.status.status === 'success',
    status: res.effects.status.status,
    sender: from,
    error: res.effects.status.error,
  };
}

function requireSignerAddress(): string {
  const addr = signerAddress();
  if (!addr) {
    throw new Error(
      'No Predict signer configured. Set PREDICT_SIGNER_PRIVATE_KEY or SUI_KEYSTORE_PATH.',
    );
  }
  return addr;
}
