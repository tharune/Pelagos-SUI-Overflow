/**
 * Pelagos Sui deposit client.
 *
 * The frontend writes through the backend's Sui local endpoints and records a
 * small browser-local ledger so the UI can display the exact basket the user
 * clicked while Sui object indexing catches up.
 */

import { BACKEND_URL } from "./tokens";
import type { WalletSigner } from "./wallet-bridge";

export type { WalletSigner };

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
  sui_pool_id?: string;
  sui_position_id?: string;
  sui_receipt_type?: string;
  transaction_digest?: string;
  /** base64 transaction bytes for the wallet to sign (non-custodial flow). */
  tx_bytes?: string;
  sender?: string;
  dry_run?: { ok: boolean; status: string; gas_used?: string; error?: string };
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
  sui_pool_id?: string;
  sui_position_id?: string;
  share_id?: string;
  transaction_digest?: string;
  tx_bytes?: string;
  sender?: string;
  dry_run?: { ok: boolean; status: string; gas_used?: string; error?: string };
}

export interface RedeemConfirmResponse {
  wallet_address?: string;
  bundle_id?: string;
  total_tokens?: number;
  payout_usdc?: number | null;
  transaction_id?: string | null;
  confirmed?: boolean;
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

function requireWallet(wallet: WalletSigner): string {
  if (!wallet.connected || !wallet.address) {
    throw new DepositError("Connect a Sui wallet to continue.", 0);
  }
  return wallet.address;
}

/**
 * Non-custodial deposit: backend builds the PTB (/prepare), the user's wallet
 * signs + submits it, then we verify + persist (/confirm). The server never
 * signs or holds funds.
 */
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
  const owner = requireWallet(wallet);

  args.onStage?.("preparing");
  const prepare = await prepareDeposit({ bundleId, walletAddress: owner, amountUsdc });
  if (!prepare.tx_bytes) {
    throw new DepositError("Backend did not return a signable transaction.", 0, prepare);
  }

  args.onStage?.("signing");
  const signature = await wallet.signAndExecute(prepare.tx_bytes);

  args.onStage?.("confirming");
  const confirm = await confirmDeposit({
    bundleId,
    walletAddress: owner,
    amountUsdc,
    signature,
    tokensMinted: prepare.tokens_minted,
    issuePrice: prepare.issue_price,
    feeUsdc: prepare.fee_usdc,
  });

  args.onStage?.("persisting");
  try {
    const { recordVirtualPosition } = await import("./virtual-positions");
    recordVirtualPosition({
      wallet: owner,
      uuid: prepare.sui_market_id ?? signature,
      uiBundleId: bundleId,
      tokens: prepare.tokens_minted,
      depositedUsdc: amountUsdc,
      navAtDeposit: args.navAtDeposit ?? prepare.issue_price ?? 1,
      signature,
      createdAt: Date.now(),
      chain: "sui",
      marketId: prepare.sui_market_id ?? "",
      positionId: prepare.sui_position_id ?? "",
    });
  } catch {
    // Browser-local position recording is only for UI continuity.
  }

  return { signature, prepare, confirm };
}

/**
 * Non-custodial redeem: backend finds the wallet's on-chain VaultShare and
 * builds the redeem PTB; the wallet signs it; we verify + persist.
 */
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
  const owner = requireWallet(wallet);

  args.onStage?.("preparing");
  const prepare = await prepareRedeem({ bundleId, walletAddress: owner, amountTokens: args.amountTokens });
  if (!prepare.tx_bytes) {
    throw new DepositError("No redeemable on-chain position for this wallet.", 404, prepare);
  }

  args.onStage?.("signing");
  const signature = await wallet.signAndExecute(prepare.tx_bytes);

  args.onStage?.("confirming");
  const confirm = await confirmRedeem({
    bundleId,
    walletAddress: owner,
    signature,
    expectedUsdc: prepare.expected_usdc,
    tokensRedeemed: prepare.total_tokens,
  });

  args.onStage?.("persisting");
  try {
    const { clearVirtualPositionBySuiIds } = await import("./virtual-positions");
    if (prepare.sui_market_id) {
      clearVirtualPositionBySuiIds(
        owner,
        prepare.sui_market_id,
        prepare.share_id ?? prepare.sui_position_id ?? "",
      );
    }
  } catch {
    // Browser-local position recording is only for UI continuity.
  }

  return { signature, prepare, confirm };
}
