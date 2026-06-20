/**
 * Sui admin + faucet calls, signed by the protocol signer (the Pelagos deployer
 * that owns the mock-USDC TreasuryCap and the market AdminCap) via the TS SDK.
 *
 * Previously these shelled out to the `sui` CLI and signed with whatever key was
 * active in the local CLI keystore — which only worked on the deployer's own
 * machine. Signing through the committed SUI_PRIVATE_KEY (the same signer the
 * predict + dev-faucet paths already use) makes mint/admin work on any clone,
 * with no `sui` CLI install or keystore required.
 */
import { Transaction } from '@mysten/sui/transactions';
import { getSuiClient, getSigner, signerAddress } from './predict/sui';

const SUI_NETWORK = process.env.SUI_NETWORK ?? 'testnet';
const PACKAGE_ID = process.env.SUI_PACKAGE_ID ?? '';
const MARKET_MODULE = process.env.SUI_MARKET_MODULE ?? 'prediction_market';
const MARKET_ADMIN_CAP_ID = process.env.SUI_MARKET_ADMIN_CAP_ID ?? '';
const MOCK_USDC_TYPE = process.env.MOCK_USDC_TYPE ?? '';
const MOCK_USDC_TREASURY_CAP_ID = process.env.MOCK_USDC_TREASURY_CAP_ID ?? '';
const SUI_COIN_TYPE = '0x2::sui::SUI';

export type SuiJson = Record<string, unknown> | unknown[];

type SuiObjectChange = {
  type?: string;
  objectId?: string;
  objectType?: string;
};

/** Normalized result of an executed admin/faucet transaction. */
type TxResult = { digest: string; objectChanges: SuiObjectChange[] };

function requireEnv(name: string, value: string): string {
  if (!value) throw new Error(`Missing required Sui env var: ${name}`);
  return value;
}

/**
 * Sign + execute an admin/faucet PTB with the protocol signer (deployer).
 * Returns the digest + objectChanges in the same shape the CLI path used, so
 * findCreatedObject()/digest() and downstream callers are unchanged.
 */
async function runTx(tx: Transaction): Promise<TxResult> {
  const client = getSuiClient();
  const signer = getSigner();
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (res.effects?.status.status !== 'success') {
    throw new Error(
      `Sui tx failed (${res.digest}): ${res.effects?.status.error ?? 'unknown error'}`,
    );
  }
  // Best-effort: wait until the fullnode has indexed this tx so a follow-up admin
  // call (e.g. the basket mint -> create -> buy chain, or rapid faucet hits) sees
  // the updated gas-coin / object versions instead of racing on a stale one. The
  // tx already succeeded above, so a wait hiccup must not surface as an error.
  try {
    await client.waitForTransaction({ digest: res.digest });
  } catch {
    /* indexing lag only — the transaction is already final */
  }
  return {
    digest: res.digest,
    objectChanges: (res.objectChanges ?? []) as unknown as SuiObjectChange[],
  };
}

function objectChanges(json: SuiJson): SuiObjectChange[] {
  if (!json || Array.isArray(json)) return [];
  const changes = (json as { objectChanges?: unknown }).objectChanges;
  return Array.isArray(changes) ? (changes as SuiObjectChange[]) : [];
}

function findCreatedObject(json: SuiJson, predicate: (objectType: string) => boolean): string {
  const found = objectChanges(json).find((change) => {
    if (change.type !== 'created' || !change.objectId || !change.objectType) return false;
    return predicate(change.objectType);
  });
  if (!found?.objectId) {
    throw new Error(`Expected Sui object was not created. Object changes: ${JSON.stringify(objectChanges(json))}`);
  }
  return found.objectId;
}

function digest(json: SuiJson): string | null {
  if (!json || Array.isArray(json)) return null;
  const raw = (json as { digest?: unknown }).digest;
  return typeof raw === 'string' ? raw : null;
}

function suiConfig() {
  return {
    network: SUI_NETWORK,
    rpc_url: process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
    active_address: signerAddress() ?? process.env.SUI_ACTIVE_ADDRESS ?? null,
    package_id: PACKAGE_ID,
    market_module: MARKET_MODULE,
    market_admin_cap_id: MARKET_ADMIN_CAP_ID,
    mock_usdc_type: MOCK_USDC_TYPE,
    mock_usdc_treasury_cap_id: MOCK_USDC_TREASURY_CAP_ID,
    mock_usdc_metadata_id: process.env.MOCK_USDC_METADATA_ID ?? null,
    mock_usdc_decimals: Number(process.env.MOCK_USDC_DECIMALS ?? 6),
  };
}

function summarizeBalance(
  bal: { totalBalance?: string; coinObjectCount?: number; lockedBalance?: unknown } | null,
  coinType: string,
) {
  return {
    coin_type: coinType,
    balance: bal?.totalBalance ?? '0',
    coin_count: bal?.coinObjectCount ?? 0,
    locked_balance: bal?.lockedBalance ?? {},
  };
}

export async function suiStatus() {
  // active_address is the protocol signer (the key that actually owns the caps
  // and signs admin/faucet txns), resolved from SUI_PRIVATE_KEY — not a local
  // `sui` CLI keystore. Falls back to SUI_ACTIVE_ADDRESS for display only.
  const address = signerAddress() ?? process.env.SUI_ACTIVE_ADDRESS ?? null;
  const client = getSuiClient();
  const [suiBal, usdcBal] = await Promise.all([
    address ? client.getBalance({ owner: address }).catch(() => null) : Promise.resolve(null),
    address && MOCK_USDC_TYPE
      ? client.getBalance({ owner: address, coinType: MOCK_USDC_TYPE }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    ...suiConfig(),
    active_env: SUI_NETWORK,
    active_address: address,
    balances: {
      sui: summarizeBalance(suiBal, SUI_COIN_TYPE),
      mock_usdc: MOCK_USDC_TYPE ? summarizeBalance(usdcBal, MOCK_USDC_TYPE) : null,
    },
  };
}

export async function mintMockUsdc(recipient: string, amountRaw: string): Promise<TxResult> {
  const usdcType = requireEnv('MOCK_USDC_TYPE', MOCK_USDC_TYPE);
  const tx = new Transaction();
  tx.moveCall({
    target: `${usdcType.split('::')[0]}::mock_usdc::mint`,
    arguments: [
      tx.object(requireEnv('MOCK_USDC_TREASURY_CAP_ID', MOCK_USDC_TREASURY_CAP_ID)),
      tx.pure.u64(BigInt(amountRaw)),
      tx.pure.address(recipient),
    ],
  });
  return runTx(tx);
}

export async function openSuiLocalBasketPosition(args: {
  bundleId: string;
  amountRaw: string;
  recipient?: string;
}) {
  const status = await suiStatus();
  const recipient = args.recipient || status.active_address;
  if (!recipient) throw new Error('No Sui recipient provided and no active address available');

  const mint = await mintMockUsdc(recipient, args.amountRaw);
  const mintedCoinId = findCreatedObject(mint, (objectType) =>
    MOCK_USDC_TYPE
      ? objectType === `0x2::coin::Coin<${MOCK_USDC_TYPE}>`
      : objectType.includes('::mock_usdc::MOCK_USDC>'),
  );

  const question = `Pelagos ${args.bundleId} local Sui position`;
  const market = await createSuiMarket(question, '0');
  const marketId = findCreatedObject(market, (objectType) =>
    objectType.endsWith(`::${MARKET_MODULE}::Market`),
  );

  const buy = await buySuiMarketSide(marketId, mintedCoinId, args.amountRaw, 'yes');
  const positionId = findCreatedObject(buy, (objectType) =>
    objectType.endsWith(`::${MARKET_MODULE}::Position`),
  );

  return {
    chain: 'sui',
    network: SUI_NETWORK,
    bundle_id: args.bundleId,
    owner: recipient,
    amount_raw: args.amountRaw,
    market_id: marketId,
    position_id: positionId,
    digests: {
      mint: digest(mint),
      create_market: digest(market),
      buy: digest(buy),
    },
    raw: { mint, market, buy },
  };
}

export async function createSuiMarket(question: string, closeMs: string): Promise<TxResult> {
  const bytes = Array.from(Buffer.from(question, 'utf8'));
  const tx = new Transaction();
  tx.moveCall({
    target: `${requireEnv('SUI_PACKAGE_ID', PACKAGE_ID)}::${MARKET_MODULE}::create_market`,
    arguments: [
      tx.object(requireEnv('SUI_MARKET_ADMIN_CAP_ID', MARKET_ADMIN_CAP_ID)),
      tx.pure.vector('u8', bytes),
      tx.pure.u64(BigInt(closeMs || '0')),
    ],
  });
  return runTx(tx);
}

export async function buySuiMarketSide(
  marketId: string,
  coinId: string,
  amountRaw: string,
  side: 'yes' | 'no',
): Promise<TxResult> {
  const tx = new Transaction();
  const [payment] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(BigInt(amountRaw))]);
  tx.moveCall({
    target: `${requireEnv('SUI_PACKAGE_ID', PACKAGE_ID)}::${MARKET_MODULE}::buy_${side}`,
    arguments: [tx.object(marketId), payment],
  });
  return runTx(tx);
}

export async function resolveSuiMarket(marketId: string, side: 'yes' | 'no'): Promise<TxResult> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${requireEnv('SUI_PACKAGE_ID', PACKAGE_ID)}::${MARKET_MODULE}::resolve_${side}`,
    arguments: [
      tx.object(requireEnv('SUI_MARKET_ADMIN_CAP_ID', MARKET_ADMIN_CAP_ID)),
      tx.object(marketId),
    ],
  });
  return runTx(tx);
}

export async function claimSuiMarket(marketId: string, positionId: string): Promise<TxResult> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${requireEnv('SUI_PACKAGE_ID', PACKAGE_ID)}::${MARKET_MODULE}::claim`,
    arguments: [tx.object(marketId), tx.object(positionId)],
  });
  return runTx(tx);
}

export async function redeemSuiLocalBasketPosition(args: {
  marketId: string;
  positionId: string;
}) {
  const resolved = await resolveSuiMarket(args.marketId, 'yes');
  const claimed = await claimSuiMarket(args.marketId, args.positionId);
  return {
    chain: 'sui',
    network: SUI_NETWORK,
    market_id: args.marketId,
    position_id: args.positionId,
    digests: {
      resolve: digest(resolved),
      claim: digest(claimed),
    },
    raw: { resolved, claimed },
  };
}
