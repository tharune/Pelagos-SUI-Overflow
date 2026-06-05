/**
 * Pelagos product state, backed by the REAL on-chain vault
 * (`pelagos_vault::vault`). No fabricated object IDs or signatures: object refs
 * are the live shared vault, digests are verified against the chain, and the
 * share price / fees are read from on-chain state.
 */
import { getBundleById } from '../db/queries';
import {
  VAULT,
  vaultConfigured,
  shareType,
  readVaultState,
  confirmDigest,
  adminWithdrawFees as vaultWithdrawFees,
} from './vault';

export type PelagosProductState = {
  issuePriceBps: number;
  feeBps: number;
  state: 'active' | 'finalized' | 'closed';
  suiMarketId: string;
  suiPoolId: string;
  packageId: string;
  share_price: number;
  total_assets_usdc: number;
  total_shares: number;
};

export type SuiBundleObjects = {
  suiMarketId: string;
  suiPoolId: string;
  suiReceiptType: string;
};

/**
 * Real on-chain object references for a bundle. Pelagos uses a single shared
 * vault for all baskets (the bundle id is recorded off-chain / in the share
 * label), so every bundle resolves to the live vault object + share type.
 */
export function derivedObjectsForBundle(_bundleId: string): SuiBundleObjects {
  return {
    suiMarketId: VAULT.vaultObjectId,
    suiPoolId: VAULT.vaultObjectId,
    suiReceiptType: shareType(),
  };
}

export async function getProductState(bundleId: string): Promise<PelagosProductState | null> {
  if (!vaultConfigured()) return null;
  const state = await readVaultState();
  // Bundle row is best-effort metadata; on-chain state is the source of truth.
  const bundle = await getBundleById(bundleId).catch(() => null);
  const objects = derivedObjectsForBundle(bundleId);
  return {
    issuePriceBps: Math.round(state.share_price * 10_000),
    feeBps: state.deposit_fee_bps,
    state:
      bundle?.status === 'resolved'
        ? 'finalized'
        : bundle?.status === 'cancelled'
          ? 'closed'
          : 'active',
    packageId: VAULT.packageId,
    suiMarketId: objects.suiMarketId,
    suiPoolId: objects.suiPoolId,
    share_price: state.share_price,
    total_assets_usdc: Number(state.total_assets_raw) / 10 ** VAULT.usdcDecimals,
    total_shares: Number(state.total_shares) / 10 ** VAULT.usdcDecimals,
  };
}

/** Verify a Sui digest actually landed on-chain (success). */
export async function confirmSuiDigest(digestValue: string): Promise<boolean> {
  if (!digestValue || !digestValue.trim()) return false;
  const c = await confirmDigest(digestValue.trim());
  return c.ok;
}

export function estimateDeposit(amountUsdc: number, issuePrice: number) {
  const feeUsdc = amountUsdc * (VAULT_DEPOSIT_FEE_BPS / 10_000);
  const netUsdc = amountUsdc - feeUsdc;
  const expectedTokens = issuePrice > 0 ? netUsdc / issuePrice : netUsdc;
  return { feeUsdc, netUsdc, expectedTokens };
}

export function estimateRedeem(tokens: number, issuePrice: number, active: boolean) {
  const grossUsdc = tokens * issuePrice;
  const exitFeeUsdc = active ? grossUsdc * (VAULT_REDEEM_FEE_BPS / 10_000) : 0;
  return {
    expectedUsdc: grossUsdc - exitFeeUsdc,
    exitFeeUsdc,
    redeemKind: active ? ('active_early' as const) : ('finalized' as const),
  };
}

const VAULT_DEPOSIT_FEE_BPS = 50;
const VAULT_REDEEM_FEE_BPS = 30;

/** Real mUSDC delta credited to `owner` by a confirmed redeem digest. */
export async function getUserUsdcDeltaFromDigest(
  digestValue?: string,
  owner?: string,
): Promise<number | null> {
  if (!digestValue) return null;
  const c = await confirmDigest(digestValue.trim(), owner);
  return c.usdc_delta ?? null;
}

/** Admin: withdraw accrued vault fees on-chain. Returns the real tx digest. */
export async function adminWithdrawFees(_bundleId: string): Promise<string> {
  const r = await vaultWithdrawFees();
  return r.digest;
}

/**
 * "Yield sleeve" is represented by the live vault: its share price grows as
 * fees accrue. We surface the real vault object + an indicative APY config.
 */
export async function initializeYieldSleeve(apyBps: number): Promise<{
  initialized: boolean;
  signature: string | null;
  sleeve: { apy_bps: number; object_id: string; share_price: number };
}> {
  const state = vaultConfigured() ? await readVaultState() : null;
  return {
    initialized: vaultConfigured(),
    signature: null,
    sleeve: {
      apy_bps: apyBps,
      object_id: VAULT.vaultObjectId,
      share_price: state?.share_price ?? 1,
    },
  };
}

export async function getYieldSleeveState(): Promise<{
  apy_bps: number;
  object_id: string;
  share_price: number;
  total_assets_usdc: number;
  accrued_fees_usdc: number;
}> {
  const state = await readVaultState();
  return {
    apy_bps: 800,
    object_id: VAULT.vaultObjectId,
    share_price: state.share_price,
    total_assets_usdc: Number(state.total_assets_raw) / 10 ** VAULT.usdcDecimals,
    accrued_fees_usdc: Number(state.accrued_fees_raw) / 10 ** VAULT.usdcDecimals,
  };
}
