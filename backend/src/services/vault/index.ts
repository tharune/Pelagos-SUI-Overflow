/**
 * Pelagos on-chain vault service — builds REAL Sui PTBs against
 * `pelagos_vault::vault` and reads REAL on-chain state. This replaces the
 * fabricated sha256-ID / fake-signature layer.
 *
 * - `/prepare`-style flows return base64 `txBytes` for the user's wallet to
 *   sign (the user custodies their own mUSDC and pays gas).
 * - reads (share price, user positions) come from devInspect / getOwnedObjects.
 * - confirmation verifies the digest on-chain via getTransactionBlock.
 * - admin fee withdrawal is signed by the protocol signer (holds VaultAdminCap).
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { getSuiClient, getSigner, signerAddress } from '../predict/sui';
import {
  VAULT,
  vaultConfigured,
  vaultTarget,
  shareType,
  shareTypeFor,
  explorerTx,
  resolveVault,
  type VaultCurrency,
} from './config';

const FALLBACK_SENDER =
  process.env.SUI_ACTIVE_ADDRESS ??
  '0x0000000000000000000000000000000000000000000000000000000000000000';

const BPS_DENOM = 10_000n;

export interface VaultState {
  total_assets_raw: string;
  total_shares: string;
  accrued_fees_raw: string;
  deposit_fee_bps: number;
  redeem_fee_bps: number;
  /** assets / shares, in display units (1.0 when empty). */
  share_price: number;
}

function toRaw(displayAmount: number, decimals: number = VAULT.usdcDecimals): bigint {
  // amount is in display USDC; scale by decimals with rounding.
  const scaled = Math.round(displayAmount * 10 ** decimals);
  return BigInt(scaled);
}

function fromRaw(raw: bigint | string | number, decimals: number = VAULT.usdcDecimals): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

function ensureConfigured(currency?: VaultCurrency): void {
  if (!vaultConfigured(currency)) {
    throw new Error(
      currency === 'dUSDC'
        ? 'dUSDC vault not configured. Set VAULT_DUSDC_OBJECT_ID in the backend env.'
        : 'Vault not configured. Set VAULT_PACKAGE_ID + VAULT_OBJECT_ID in the backend env.',
    );
  }
}

// Short TTL cache: vault accounting (assets/shares/fees) moves slowly, so a few
// seconds of staleness is fine for a prepare's economics preview — and it spares
// a devInspect round-trip on every prepare, keeping the Approve button instant.
const vaultStateCache = new Map<string, { state: VaultState; at: number }>();
const VAULT_STATE_TTL_MS = 10_000;

/** Read live vault accounting via devInspect of the view functions. Defaults to
 *  the mUSDC vault; pass a resolved descriptor to read the dUSDC vault. */
export async function readVaultState(vault?: { vaultObjectId: string; usdcType: string; usdcDecimals?: number }): Promise<VaultState> {
  const vaultObjectId = vault?.vaultObjectId ?? VAULT.vaultObjectId;
  const usdcType = vault?.usdcType ?? VAULT.usdcType;
  const decimals = vault?.usdcDecimals ?? VAULT.usdcDecimals;
  if (!VAULT.packageId || !vaultObjectId) {
    throw new Error('Vault not configured. Set VAULT_PACKAGE_ID + VAULT_OBJECT_ID in the backend env.');
  }
  const cached = vaultStateCache.get(vaultObjectId);
  if (cached && Date.now() - cached.at < VAULT_STATE_TTL_MS) return cached.state;
  const client = getSuiClient();
  const tx = new Transaction();
  const v = () => tx.object(vaultObjectId);
  const ta = [usdcType];
  tx.moveCall({ target: vaultTarget('total_assets'), typeArguments: ta, arguments: [v()] });
  tx.moveCall({ target: vaultTarget('total_shares'), typeArguments: ta, arguments: [v()] });
  tx.moveCall({ target: vaultTarget('accrued_fees'), typeArguments: ta, arguments: [v()] });
  tx.moveCall({ target: vaultTarget('deposit_fee_bps'), typeArguments: ta, arguments: [v()] });
  tx.moveCall({ target: vaultTarget('redeem_fee_bps'), typeArguments: ta, arguments: [v()] });

  const sender = signerAddress() ?? FALLBACK_SENDER;
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
  if (res.effects?.status.status !== 'success') {
    throw new Error(`readVaultState devInspect failed: ${res.effects?.status.error}`);
  }
  const u64At = (i: number): bigint => {
    const rv = res.results?.[i]?.returnValues?.[0]?.[0];
    if (!rv) throw new Error(`readVaultState: missing return value ${i}`);
    return BigInt(bcs.u64().parse(Uint8Array.from(rv)));
  };
  const totalAssets = u64At(0);
  const totalShares = u64At(1);
  const accruedFees = u64At(2);
  const depositFeeBps = Number(u64At(3));
  const redeemFeeBps = Number(u64At(4));
  const sharePrice = totalShares === 0n ? 1 : fromRaw(totalAssets, decimals) / (Number(totalShares) / 10 ** decimals);

  const state: VaultState = {
    total_assets_raw: totalAssets.toString(),
    total_shares: totalShares.toString(),
    accrued_fees_raw: accruedFees.toString(),
    deposit_fee_bps: depositFeeBps,
    redeem_fee_bps: redeemFeeBps,
    share_price: sharePrice,
  };
  // Populate the short-TTL cache so back-to-back prepares (quote → deposit) skip
  // the 5-call devInspect round-trip. Fees/share-price drift on the order of a
  // block, so a 10s window is safe and keeps the Approve button near-instant.
  vaultStateCache.set(vaultObjectId, { state, at: Date.now() });
  return state;
}

export interface DepositEconomics {
  gross_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  expected_shares: number;
  share_price: number;
  deposit_fee_bps: number;
}

function computeDeposit(
  grossRaw: bigint,
  state: VaultState,
  decimals: number = VAULT.usdcDecimals,
): DepositEconomics {
  const feeRaw = (grossRaw * BigInt(state.deposit_fee_bps)) / BPS_DENOM;
  const netRaw = grossRaw - feeRaw;
  const totalShares = BigInt(state.total_shares);
  const assets = BigInt(state.total_assets_raw);
  const sharesRaw =
    totalShares === 0n || assets === 0n ? netRaw : (netRaw * totalShares) / assets;
  return {
    gross_usdc: fromRaw(grossRaw, decimals),
    fee_usdc: fromRaw(feeRaw, decimals),
    net_usdc: fromRaw(netRaw, decimals),
    expected_shares: Number(sharesRaw) / 10 ** decimals,
    share_price: state.share_price,
    deposit_fee_bps: state.deposit_fee_bps,
  };
}

export interface PreparedTx {
  tx_bytes: string;
  sender: string;
  // `ok` is null for the 'skipped' (no server-side dry-run) case so the FE never
  // reads a skipped prepare as a passing dry-run; boolean only when actually run.
  dry_run: { ok: boolean | null; status: string; gas_used?: string; error?: string };
}

async function buildAndDryRun(tx: Transaction, sender: string): Promise<PreparedTx> {
  tx.setSender(sender);
  // Return the UNBUILT transaction (serialized JSON, no gas resolved) so the
  // connected wallet builds it with its OWN gas coin + fresh object versions,
  // then signs & executes via the standard wallet flow. This is broadly
  // compatible with EVERY wallet type — seed-phrase, hardware, and zkLogin /
  // social-login (Slush-with-Google).
  //
  // We deliberately DO NOT dry-run here. The previous server-side dry-run cost
  // two extra RPC round-trips (build + dryRunTransactionBlock) on every prepare
  // — the dominant latency that made the Approve button take ~1s+ to appear —
  // for a gas/validity preview the wallet re-computes itself at sign time. The
  // prepare is now near-instant (just local serialization).
  const serialized = await tx.toJSON();
  return { tx_bytes: serialized, sender, dry_run: { ok: null, status: 'skipped' } };
}

/**
 * Build an unsigned deposit transaction: merges the user's mUSDC, splits the
 * exact amount, and calls `vault::deposit`. Returns tx bytes for the wallet to
 * sign plus the computed economics.
 */
export async function prepareDeposit(args: {
  owner: string;
  amount_usdc: number;
  label?: string;
  /** Which settlement vault to deposit into. Defaults to the mUSDC vault. */
  currency?: VaultCurrency;
}): Promise<PreparedTx & { economics: DepositEconomics; vault_id: string; share_type: string }> {
  ensureConfigured(args.currency);
  const vault = resolveVault(args.currency);
  const client = getSuiClient();
  const grossRaw = toRaw(args.amount_usdc, vault.usdcDecimals);
  if (grossRaw <= 0n) throw new Error('amount_usdc must be positive');

  const { data: coins } = await client.getCoins({ owner: args.owner, coinType: vault.usdcType });
  const total = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (total < grossRaw) {
    throw new Error(
      `Insufficient ${vault.label} for ${args.owner}: holds ${fromRaw(total, vault.usdcDecimals)}, needs ${fromRaw(grossRaw, vault.usdcDecimals)}.`,
    );
  }

  const state = await readVaultState(vault);
  const economics = computeDeposit(grossRaw, state, vault.usdcDecimals);

  const tx = new Transaction();
  const ids = coins.map((c) => c.coinObjectId);
  const [primary, ...rest] = ids;
  if (rest.length > 0) {
    tx.mergeCoins(tx.object(primary), rest.map((id) => tx.object(id)));
  }
  const [payment] = tx.splitCoins(tx.object(primary), [tx.pure.u64(grossRaw)]);
  const labelBytes = Array.from(new TextEncoder().encode(args.label ?? ''));
  tx.moveCall({
    target: vaultTarget('deposit'),
    typeArguments: [vault.usdcType],
    arguments: [tx.object(vault.vaultObjectId), payment, tx.pure.vector('u8', labelBytes)],
  });

  const prepared = await buildAndDryRun(tx, args.owner);
  return { ...prepared, economics, vault_id: vault.vaultObjectId, share_type: shareTypeFor(vault.usdcType) };
}

export interface VaultShareInfo {
  share_id: string;
  shares: number;
  principal_usdc: number;
  label: string;
  /** Settlement rail that issued this share (which vault to redeem against). */
  currency: VaultCurrency;
  vault_id: string;
}

/**
 * List a wallet's vault share receipts. By default returns BOTH rails (mUSDC and
 * dUSDC), each tagged with its settlement currency + issuing vault so a redeem can
 * target the correct vault; pass `currency` to scope to one rail. An unconfigured
 * rail is skipped rather than throwing.
 */
export async function listShares(owner: string, currency?: VaultCurrency): Promise<VaultShareInfo[]> {
  const rails: VaultCurrency[] = currency ? [currency] : ['mUSDC', 'dUSDC'];
  const client = getSuiClient();
  const out: VaultShareInfo[] = [];
  for (const rail of rails) {
    if (!vaultConfigured(rail)) continue;
    const vault = resolveVault(rail);
    let cursor: string | null | undefined = undefined;
    do {
      const page = await client.getOwnedObjects({
        owner,
        filter: { StructType: shareTypeFor(vault.usdcType) },
        options: { showContent: true },
        cursor: cursor ?? undefined,
      });
      for (const o of page.data) {
        const content = o.data?.content;
        if (!content || content.dataType !== 'moveObject') continue;
        const f = content.fields as Record<string, unknown>;
        const labelRaw = f.label;
        let label = '';
        if (Array.isArray(labelRaw)) {
          label = new TextDecoder().decode(Uint8Array.from(labelRaw as number[]));
        } else if (typeof labelRaw === 'string') {
          label = labelRaw;
        }
        out.push({
          share_id: o.data?.objectId ?? '',
          shares: Number(BigInt((f.shares as string) ?? '0')) / 10 ** vault.usdcDecimals,
          principal_usdc: Number(BigInt((f.principal as string) ?? '0')) / 10 ** vault.usdcDecimals,
          label,
          currency: rail,
          vault_id: vault.vaultObjectId,
        });
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
  }
  return out;
}

export interface RedeemEconomics {
  shares: number;
  gross_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  redeem_fee_bps: number;
}

/**
 * Build an unsigned redeem transaction for a specific share receipt (or the
 * caller's largest receipt if `share_id` is omitted).
 */
export async function prepareRedeem(args: {
  owner: string;
  share_id?: string;
  label?: string;
  currency?: VaultCurrency;
}): Promise<
  PreparedTx & { economics: RedeemEconomics; vault_id: string; share_id: string; label: string; currency: VaultCurrency }
> {
  // Scope to the requested rail if given; otherwise search both so a share_id /
  // label resolves regardless of settlement coin.
  const shares = await listShares(args.owner, args.currency);
  if (shares.length === 0) throw new Error(`No vault positions for ${args.owner}`);

  let target = args.share_id
    ? shares.find((s) => s.share_id === args.share_id)
    : args.label
      ? shares.find((s) => s.label === args.label)
      : undefined;
  if (!target) {
    // default: the largest position
    target = [...shares].sort((a, b) => b.shares - a.shares)[0];
  }

  // Authoritative: redeem against the vault that ACTUALLY issued this share (its
  // own tagged currency), so a dUSDC position never hits the mUSDC vault.
  const currency = target.currency;
  ensureConfigured(currency);
  const vault = resolveVault(currency);
  const dec = vault.usdcDecimals;
  const toUsd = (raw: bigint) => Number(raw) / 10 ** dec;

  const state = await readVaultState(vault);
  const totalShares = BigInt(state.total_shares);
  const assets = BigInt(state.total_assets_raw);
  const shareRaw = BigInt(Math.round(target.shares * 10 ** dec));
  const grossOutRaw = totalShares === 0n ? 0n : (shareRaw * assets) / totalShares;
  const feeRaw = (grossOutRaw * BigInt(state.redeem_fee_bps)) / BPS_DENOM;
  const netOutRaw = grossOutRaw - feeRaw;

  const tx = new Transaction();
  tx.moveCall({
    target: vaultTarget('redeem'),
    typeArguments: [vault.usdcType],
    arguments: [tx.object(vault.vaultObjectId), tx.object(target.share_id)],
  });

  const prepared = await buildAndDryRun(tx, args.owner);
  return {
    ...prepared,
    economics: {
      shares: target.shares,
      gross_usdc: toUsd(grossOutRaw),
      fee_usdc: toUsd(feeRaw),
      net_usdc: toUsd(netOutRaw),
      redeem_fee_bps: state.redeem_fee_bps,
    },
    vault_id: vault.vaultObjectId,
    share_id: target.share_id,
    label: target.label,
    currency,
  };
}

export interface DigestConfirmation {
  ok: boolean;
  status: string;
  digest: string;
  explorer_url: string;
  event?: Record<string, unknown>;
  usdc_delta?: number;
}

/**
 * Verify a digest on-chain and surface the vault event + the owner's USDC delta.
 *
 * The payout delta is computed against the settlement coin of the redeemed
 * rail. When `currency` is omitted we default to mUSDC (identical to the prior
 * behavior). If a currency isn't passed, we additionally try to infer the rail
 * from the redeemed `VaultShare<T>` type tag in the tx events, so a dUSDC redeem
 * still reports the correct payout instead of a null/wrong mUSDC delta.
 */
export async function confirmDigest(
  digest: string,
  owner?: string,
  currency?: VaultCurrency,
): Promise<DigestConfirmation> {
  const client = getSuiClient();
  try {
    // Wait for the fullnode to index the tx (avoids false "not_found" when the
    // client calls /confirm immediately after the wallet executes).
    const tx = await client.waitForTransaction({
      digest,
      timeout: 12_000,
      options: { showEffects: true, showEvents: true, showBalanceChanges: true },
    });
    const status = tx.effects?.status.status ?? 'unknown';
    const events = tx.events ?? [];
    const ev = events.find((e) => e.type.includes('::vault::'));
    // Resolve the rail: explicit `currency` wins; otherwise infer the settlement
    // coin from the redeemed VaultShare<T> type tag in the event types, falling
    // back to mUSDC. This keeps the owner-delta + decimals matched to the rail.
    let resolved = currency ? resolveVault(currency) : null;
    if (!resolved) {
      const shareEvent = events.find((e) => /::vault::VaultShare<[^>]+>/.test(e.type));
      const inner = shareEvent?.type.match(/::vault::VaultShare<([^>]+)>/)?.[1];
      if (inner) {
        const dusdc = resolveVault('dUSDC');
        resolved = inner === dusdc.usdcType ? dusdc : resolveVault('mUSDC');
      }
    }
    const coinType = resolved?.usdcType ?? VAULT.usdcType;
    const coinDecimals = resolved?.usdcDecimals ?? VAULT.usdcDecimals;
    let delta: number | undefined;
    if (owner) {
      const bc = (tx.balanceChanges ?? []).find(
        (c) =>
          c.coinType === coinType &&
          typeof c.owner === 'object' &&
          c.owner !== null &&
          'AddressOwner' in c.owner &&
          (c.owner as { AddressOwner: string }).AddressOwner === owner,
      );
      if (bc) delta = Number(BigInt(bc.amount)) / 10 ** coinDecimals;
    }
    return {
      ok: status === 'success',
      status,
      digest,
      explorer_url: explorerTx(digest),
      event: ev?.parsedJson as Record<string, unknown> | undefined,
      usdc_delta: delta,
    };
  } catch (e) {
    return { ok: false, status: 'not_found', digest, explorer_url: explorerTx(digest), event: undefined };
  }
}

/** Admin: withdraw accrued protocol fees (signed by the protocol signer). */
export async function adminWithdrawFees(): Promise<{
  ok: boolean;
  digest: string;
  amount_usdc: number | null;
  explorer_url: string;
}> {
  ensureConfigured();
  if (!VAULT.adminCapId) throw new Error('VAULT_ADMIN_CAP_ID not configured');
  const client = getSuiClient();
  const signer = getSigner();
  const tx = new Transaction();
  tx.moveCall({
    target: vaultTarget('withdraw_fees'),
    typeArguments: [VAULT.usdcType],
    arguments: [tx.object(VAULT.adminCapId), tx.object(VAULT.vaultObjectId)],
  });
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true, showEvents: true },
  });
  const status = res.effects?.status.status ?? 'unknown';
  if (status !== 'success') {
    throw new Error(`withdraw_fees failed (${res.digest}): ${res.effects?.status.error}`);
  }
  const ev = (res.events ?? []).find((e) => e.type.includes('FeesWithdrawn'));
  const amount = ev?.parsedJson
    ? fromRaw(BigInt((ev.parsedJson as { amount: string }).amount))
    : null;
  return { ok: true, digest: res.digest, amount_usdc: amount, explorer_url: explorerTx(res.digest) };
}

export { vaultConfigured, VAULT, shareType };
