import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import type { SuiObjectChange } from '@mysten/sui/jsonRpc';
import { PREDICT, predictConfig } from './config';
import { getSuiClient, getSigner, signerAddress } from './sui';
import {
  addCreateManager,
  addDeposit,
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

// devInspect needs a sender but never requires it to own anything. Falls back to
// a known testnet address so read-only previews work with no key configured.
const FALLBACK_SENDER =
  process.env.SUI_ACTIVE_ADDRESS ??
  '0xee770af6c184b101aa91fab0fffdee62c1fecc86fd3e681d978336bf70eead79';

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
