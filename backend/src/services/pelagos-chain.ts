import { createHash } from 'crypto';
import { getBundleById } from '../db/queries';

export type PelagosProductState = {
  issuePriceBps: number;
  feeBps: number;
  state: 'active' | 'finalized' | 'closed';
  suiMarketId: string;
  suiPoolId: string;
  packageId: string;
};

export type SuiBundleObjects = {
  suiMarketId: string;
  suiPoolId: string;
  suiReceiptType: string;
};

function digest(input: string, bytes = 32): string {
  return createHash('sha256').update(input).digest('hex').slice(0, bytes * 2);
}

function objectId(prefix: string, seed: string): string {
  return `0x${digest(`${prefix}:${seed}`)}`;
}

export function derivedObjectsForBundle(bundleId: string): SuiBundleObjects {
  return {
    suiMarketId: objectId('market', bundleId),
    suiPoolId: objectId('pool', bundleId),
    suiReceiptType: `${process.env.SUI_PACKAGE_ID ?? 'local'}::pelagos::PBU`,
  };
}

export async function getProductState(bundleId: string): Promise<PelagosProductState | null> {
  const bundle = await getBundleById(bundleId);
  if (!bundle) return null;
  const objects = derivedObjectsForBundle(bundleId);
  return {
    issuePriceBps: Math.round(bundle.issue_price * 10_000),
    feeBps: 50,
    state:
      bundle.status === 'resolved'
        ? 'finalized'
        : bundle.status === 'cancelled'
          ? 'closed'
          : 'active',
    packageId: process.env.SUI_PACKAGE_ID ?? '',
    ...objects,
  };
}

export async function confirmSuiDigest(digestValue: string): Promise<boolean> {
  return digestValue.trim().length > 0;
}

export function estimateDeposit(amountUsdc: number, issuePrice: number) {
  const feeUsdc = amountUsdc * 0.005;
  const netUsdc = amountUsdc - feeUsdc;
  const expectedTokens = issuePrice > 0 ? netUsdc / issuePrice : 0;
  return { feeUsdc, netUsdc, expectedTokens };
}

export function estimateRedeem(tokens: number, issuePrice: number, active: boolean) {
  const grossUsdc = tokens * issuePrice;
  const exitFeeUsdc = active ? grossUsdc * 0.003 : 0;
  return {
    expectedUsdc: grossUsdc - exitFeeUsdc,
    exitFeeUsdc,
    redeemKind: active ? 'active_early' as const : 'finalized' as const,
  };
}

export async function getUserUsdcDeltaFromDigest(): Promise<number | null> {
  return null;
}

export async function adminWithdrawFees(bundleId: string): Promise<string> {
  return `sui-admin-${digest(bundleId, 12)}`;
}

export async function initializeYieldSleeve(apyBps: number): Promise<{
  initialized: boolean;
  signature: string;
  sleeve: { apy_bps: number; object_id: string };
}> {
  return {
    initialized: true,
    signature: `sui-yield-${digest(String(apyBps), 12)}`,
    sleeve: {
      apy_bps: apyBps,
      object_id: objectId('yield-sleeve', String(apyBps)),
    },
  };
}

export async function getYieldSleeveState(): Promise<{ apy_bps: number; object_id: string }> {
  return {
    apy_bps: 800,
    object_id: objectId('yield-sleeve', 'default'),
  };
}
