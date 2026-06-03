/**
 * Pelagos Sui deposit client.
 *
 * The frontend writes through the backend's Sui local endpoints and records a
 * small browser-local ledger so the UI can display the exact basket the user
 * clicked while Sui object indexing catches up.
 */

import { BACKEND_URL } from "./tokens";
import { SUI_ACTIVE_ADDRESS } from "./chain";
import { openSuiBasketPosition, redeemSuiBasketPosition } from "./sui-client";

function normalizeName(name: string): string {
  return name;
}

type BundleSummary = {
  id: string;
  name: string;
};

let _bundleMap: Promise<Map<string, BundleSummary>> | null = null;

function loadBundleMap(force: boolean = false): Promise<Map<string, BundleSummary>> {
  if (force) _bundleMap = null;
  if (_bundleMap) return _bundleMap;
  _bundleMap = (async () => {
    const res = await fetch(`${BACKEND_URL}/api/bundles`);
    if (!res.ok) {
      _bundleMap = null;
      throw new DepositError(`Failed to load /api/bundles (HTTP ${res.status})`, res.status);
    }
    const rows = (await res.json()) as BundleSummary[];
    const map = new Map<string, BundleSummary>();
    for (const row of rows) map.set(row.name, row);
    return map;
  })();
  return _bundleMap;
}

function tierFromName(name: string): 90 | 70 | 50 | null {
  const upper = name.toUpperCase();
  if (/\b(HIGH|-90-)/.test(upper)) return 90;
  if (/\b(MID|-70-)/.test(upper)) return 70;
  if (/\b(LOW|-50-)/.test(upper)) return 50;
  return null;
}

function pickFallbackBundle(
  map: Map<string, BundleSummary>,
  uiBundleId: string,
): BundleSummary | null {
  const bundles = Array.from(map.values());
  if (bundles.length === 0) return null;
  const tier = tierFromName(uiBundleId);
  if (tier !== null) {
    const tierMatch = bundles.find((b) => tierFromName(b.name) === tier);
    if (tierMatch) return tierMatch;
  }
  return bundles[0];
}

export async function resolveBundleUuid(uiBundleId: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uiBundleId)) {
    return uiBundleId;
  }
  const dbName = normalizeName(uiBundleId);
  const map = await loadBundleMap();
  const exact = map.get(dbName);
  if (exact) return exact.id;

  const fallback = pickFallbackBundle(map, uiBundleId);
  if (fallback) {
    if (typeof window !== "undefined") {
      console.warn(
        `[deposit-client] Basket "${uiBundleId}" not in backend; routing to "${fallback.name}" (${fallback.id}).`,
      );
    }
    return fallback.id;
  }

  throw new DepositError(
    `Bundle "${dbName}" not found. Known bundles: ${Array.from(map.keys()).join(", ") || "(none)"}`,
    404,
  );
}

export interface DepositPrepareResponse {
  kind: "prepared";
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  issue_price: number;
  tokens_minted: number;
  expected_tokens: number;
  sui_market_id?: string;
  sui_position_id?: string;
  transaction_digest?: string;
}

export interface DepositConfirmResponse {
  transaction_id: string;
  bundle_id: string;
  tokens_minted: number;
  issue_price: number;
  fee_usdc: number;
  net_usdc: number;
}

export interface RedeemPrepareResponse {
  kind: "prepared";
  bundle_id: string;
  wallet_address: string;
  total_tokens: number;
  expected_usdc: number;
  redeem_kind?: "finalized" | "active_early";
  exit_fee_usdc?: number;
  sui_market_id?: string;
  sui_position_id?: string;
  transaction_digest?: string;
}

export interface RedeemConfirmResponse {
  wallet_address: string;
  bundle_id: string;
  total_tokens: number;
  payout_usdc: number;
  transaction_id?: string;
}

export class DepositError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: unknown = undefined;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    const msg =
      (payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : null) ?? `HTTP ${res.status}`;
    throw new DepositError(msg, res.status, payload);
  }
  return payload as T;
}

export async function prepareDeposit(args: {
  bundleId: string;
  walletAddress: string;
  amountUsdc: number;
}): Promise<DepositPrepareResponse> {
  const uuid = await resolveBundleUuid(args.bundleId);
  return postJson<DepositPrepareResponse>("/api/deposit/prepare", {
    bundle_id: uuid,
    wallet_address: args.walletAddress,
    amount_usdc: args.amountUsdc,
  });
}

export async function confirmDeposit(args: {
  bundleId: string;
  walletAddress: string;
  amountUsdc: number;
  signature: string;
  tokensMinted: number;
  issuePrice: number;
  feeUsdc: number;
}): Promise<DepositConfirmResponse> {
  const uuid = await resolveBundleUuid(args.bundleId);
  return postJson<DepositConfirmResponse>("/api/deposit/confirm", {
    bundle_id: uuid,
    wallet_address: args.walletAddress,
    amount_usdc: args.amountUsdc,
    signature: args.signature,
    tokens_minted: args.tokensMinted,
    issue_price: args.issuePrice,
    fee_usdc: args.feeUsdc,
  });
}

export async function prepareRedeem(args: {
  bundleId: string;
  walletAddress: string;
  amountTokens?: number;
}): Promise<RedeemPrepareResponse> {
  const uuid = await resolveBundleUuid(args.bundleId);
  return postJson<RedeemPrepareResponse>("/api/deposit/redeem/prepare", {
    bundle_id: uuid,
    wallet_address: args.walletAddress,
    ...(args.amountTokens != null ? { amount_tokens: args.amountTokens } : {}),
  });
}

export async function confirmRedeem(args: {
  bundleId: string;
  walletAddress: string;
  signature: string;
  expectedUsdc: number;
  tokensRedeemed?: number;
}): Promise<RedeemConfirmResponse> {
  const uuid = await resolveBundleUuid(args.bundleId);
  return postJson<RedeemConfirmResponse>("/api/deposit/redeem/confirm", {
    bundle_id: uuid,
    wallet_address: args.walletAddress,
    signature: args.signature,
    expected_usdc: args.expectedUsdc,
    ...(args.tokensRedeemed != null ? { tokens_redeemed: args.tokensRedeemed } : {}),
  });
}

export interface WalletSigner {
  address: string | null;
}

function activeSuiAddress(wallet: WalletSigner): string {
  const address = wallet.address || SUI_ACTIVE_ADDRESS;
  if (!address) throw new DepositError("No Sui address configured.", 0);
  return address;
}

export async function depositIntoBundle(args: {
  wallet: WalletSigner;
  bundleId: string;
  amountUsdc: number;
  navAtDeposit?: number;
  confirmationTimeoutMs?: number;
  onStage?: (stage: "preparing" | "signing" | "confirming" | "persisting") => void;
}): Promise<{
  signature: string;
  prepare: DepositPrepareResponse;
  confirm: DepositConfirmResponse;
}> {
  const { wallet, bundleId, amountUsdc } = args;
  args.onStage?.("preparing");
  const owner = activeSuiAddress(wallet);
  const tokensMinted = amountUsdc / Math.max(args.navAtDeposit ?? 1, 0.000001);
  const opened = await openSuiBasketPosition({
    bundleId,
    amountUsdc,
    recipient: owner,
  });
  const signature =
    opened.digests.buy ?? opened.digests.create_market ?? opened.digests.mint ?? opened.market_id;

  try {
    const { recordVirtualPosition } = await import("./virtual-positions");
    recordVirtualPosition({
      wallet: owner,
      uuid: opened.market_id,
      uiBundleId: bundleId,
      tokens: tokensMinted,
      depositedUsdc: amountUsdc,
      navAtDeposit: args.navAtDeposit ?? 1,
      signature,
      createdAt: Date.now(),
      chain: "sui",
      marketId: opened.market_id,
      positionId: opened.position_id,
    });
  } catch {
    // Browser-local position recording is only for UI continuity.
  }

  args.onStage?.("confirming");
  args.onStage?.("persisting");
  return {
    signature,
    prepare: {
      kind: "prepared",
      bundle_id: opened.market_id,
      wallet_address: owner,
      amount_usdc: amountUsdc,
      fee_usdc: 0,
      net_usdc: amountUsdc,
      issue_price: args.navAtDeposit ?? 1,
      tokens_minted: tokensMinted,
      expected_tokens: tokensMinted,
      sui_market_id: opened.market_id,
      sui_position_id: opened.position_id,
      transaction_digest: signature,
    },
    confirm: {
      transaction_id: signature,
      bundle_id: opened.market_id,
      tokens_minted: tokensMinted,
      issue_price: args.navAtDeposit ?? 1,
      fee_usdc: 0,
      net_usdc: amountUsdc,
    },
  };
}

export async function redeemFromBundle(args: {
  wallet: WalletSigner;
  bundleId: string;
  amountTokens?: number;
  confirmationTimeoutMs?: number;
  onStage?: (stage: "preparing" | "signing" | "confirming" | "persisting") => void;
}): Promise<{
  signature: string;
  prepare: RedeemPrepareResponse;
  confirm: RedeemConfirmResponse;
}> {
  const { wallet, bundleId } = args;
  const owner = activeSuiAddress(wallet);
  args.onStage?.("preparing");
  const { getVirtualPositions, clearVirtualPositionBySuiIds } = await import("./virtual-positions");
  const candidate = getVirtualPositions(owner).find(
    (p) => p.chain === "sui" && p.uiBundleId === bundleId && p.marketId && p.positionId,
  );
  if (!candidate?.marketId || !candidate.positionId) {
    throw new DepositError("No local Sui position found for this basket.", 404);
  }
  const redeemed = await redeemSuiBasketPosition({
    marketId: candidate.marketId,
    positionId: candidate.positionId,
  });
  const signature = redeemed.digests.claim ?? redeemed.digests.resolve ?? candidate.marketId;
  clearVirtualPositionBySuiIds(owner, candidate.marketId, candidate.positionId);

  args.onStage?.("confirming");
  args.onStage?.("persisting");
  return {
    signature,
    prepare: {
      kind: "prepared",
      bundle_id: candidate.marketId,
      wallet_address: owner,
      total_tokens: candidate.tokens,
      expected_usdc: candidate.depositedUsdc,
      redeem_kind: "finalized",
      exit_fee_usdc: 0,
      sui_market_id: candidate.marketId,
      sui_position_id: candidate.positionId,
      transaction_digest: signature,
    },
    confirm: {
      wallet_address: owner,
      bundle_id: candidate.marketId,
      total_tokens: candidate.tokens,
      payout_usdc: candidate.depositedUsdc,
      transaction_id: signature,
    },
  };
}
