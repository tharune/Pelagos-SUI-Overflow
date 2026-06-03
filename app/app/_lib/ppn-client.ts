/**
 * Pelagos Sui protected-note and tranche client.
 *
 * The UI keeps the same product experience while writes go through the Sui
 * local basket endpoints. Backend portfolio/RFQ reads are still used for
 * durable rows and market-maker style quote previews.
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

function loadBundleMap(force = false): Promise<Map<string, BundleSummary>> {
  if (force) _bundleMap = null;
  if (_bundleMap) return _bundleMap;
  _bundleMap = (async () => {
    const res = await fetch(`${BACKEND_URL}/api/bundles`);
    if (!res.ok) {
      _bundleMap = null;
      throw new PpnError(`Failed to load /api/bundles (HTTP ${res.status})`, res.status);
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

async function resolveBundleUuidForPpn(uiBundleId: string): Promise<string> {
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
        `[ppn-client] Basket "${uiBundleId}" not in backend; routing to "${fallback.name}" (${fallback.id}).`,
      );
    }
    return fallback.id;
  }

  throw new PpnError(
    `Bundle "${dbName}" not found. Known bundles: ${Array.from(map.keys()).join(", ") || "(none)"}`,
    404,
  );
}

export class PpnError extends Error {
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
    throw new PpnError(msg, res.status, payload);
  }
  return payload as T;
}

export interface PpnPrepareResponse {
  kind: "prepared";
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
  management_fee_bps: number;
  management_fee_usdc: number;
  strategy_fee_bps: number;
  strategy_fee_usdc: number;
  total_open_fee_usdc: number;
  net_deposit_usdc: number;
  estimated_apy: number;
  maturity_date: string;
  maturity_ts: number;
  sui_market_id: string;
  sui_position_id: string;
  transaction_digest: string;
}

export interface PpnConfirmResponse {
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  principal_usdc: number;
  signature: string;
  transaction_id: string | null;
}

export interface PpnRedeemPrepareResponse {
  kind: "prepared";
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  principal_usdc: number;
  strategy_fee_bps: number;
  strategy_fee_usdc: number;
  expected_proceeds_usdc: number;
  sui_market_id: string;
  sui_position_id: string;
  transaction_digest: string;
}

export interface PpnRedeemConfirmResponse {
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  principal_returned: number;
  signature: string;
  transaction_id: string | null;
}

export interface PpnDivestPrepareResponse {
  kind: "prepared";
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  strategy_fee_bps: number;
  estimated_strategy_fee_usdc: number;
  sui_market_id: string;
  sui_position_id: string;
  transaction_digest: string;
}

export interface PpnDivestConfirmResponse {
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  signature: string;
  status: "active";
}

export interface PpnClosePrepareResponse {
  kind: "prepared";
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  principal_usdc: number;
  strategy_fee_bps: number;
  estimated_strategy_fee_usdc: number;
  estimated_net_usdc: number;
  sui_market_id: string;
  sui_position_id: string;
  transaction_digest: string;
}

export interface PpnCloseConfirmResponse {
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  principal_returned: number;
  signature: string;
  transaction_id: string | null;
  status: "withdrawn";
}

export interface TrancheSellRfqQuote {
  vault_id: string;
  bundle_id?: string;
  tranche_kind?: "senior" | "mezzanine" | "junior" | null;
  status: "can_execute_onchain" | "rfq_only" | "missing";
  matured?: boolean;
  maturity_ts?: number;
  seconds_remaining?: number;
  entry_price_per_token?: number;
  indicative_price_per_token?: number;
  indicative_price_pct?: number;
  indicative_usdc?: number;
  mm_spread_bps?: number;
  slippage_bps?: number;
  underwriting_bps?: number;
  total_haircut_bps?: number;
  onchain_expected_usdc?: number;
  onchain_gross_usdc?: number;
  onchain_basket_exit_fee_bps?: number;
  onchain_strategy_fee_bps?: number;
  error?: string;
}

export interface TrancheSellRfqResponse {
  kind: "rfq";
  quotes: TrancheSellRfqQuote[];
  executable_count: number;
}

export interface TrancheOverlay {
  kind: "senior" | "mezzanine" | "junior";
  attach: number;
  detach: number;
  pricePerToken: number;
}

export async function fetchTrancheSellRfq(args: {
  vaultIds: string[];
  walletAddress: string;
}): Promise<TrancheSellRfqResponse> {
  return postJson<TrancheSellRfqResponse>("/api/ppn/tranche/sell/rfq", {
    vault_ids: args.vaultIds,
    wallet_address: args.walletAddress,
  });
}

export interface PpnPortfolioEntry {
  vault_id: string;
  bundle_id: string;
  bundle_name: string;
  bundle_status: string;
  principal_usdc: number;
  yield_deployed_usdc: number;
  accrued_yield: number;
  projected_total_yield: number;
  estimated_apy: number;
  status: "active" | "matured" | "withdrawn";
  days_elapsed: number;
  days_remaining: number;
  maturity_date: string;
  created_at: string;
  total_value: number;
  tranche_kind: "senior" | "mezzanine" | "junior" | null;
  tranche_attach: number | null;
  tranche_detach: number | null;
  price_per_token: number | null;
}

export interface PpnPortfolio {
  wallet_address: string;
  vaults: PpnPortfolioEntry[];
  summary: {
    total_vaults: number;
    total_principal: number;
    total_accrued_yield: number;
    total_value: number;
    principal_protected: boolean;
  };
}

export async function fetchPpnPortfolio(walletAddress: string): Promise<PpnPortfolio> {
  const res = await fetch(
    `${BACKEND_URL}/api/ppn/portfolio/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) {
    throw new PpnError(`Failed to load PPN portfolio (HTTP ${res.status})`, res.status);
  }
  return (await res.json()) as PpnPortfolio;
}

export interface WalletSigner {
  address: string | null;
}

function activeSuiAddress(wallet: WalletSigner): string {
  const address = wallet.address || SUI_ACTIVE_ADDRESS;
  if (!address) throw new PpnError("No Sui address configured.", 0);
  return address;
}

function splitVaultId(vaultId: string | undefined): { marketId: string; positionId: string } {
  const [marketId, positionId] = String(vaultId ?? "").split("::");
  if (!marketId || !positionId) throw new PpnError("Missing local Sui product position ids.", 404);
  return { marketId, positionId };
}

export async function ppnDeposit(args: {
  wallet: WalletSigner;
  bundleId: string;
  amountUsdc: number;
  maturityDays?: number;
  confirmationTimeoutMs?: number;
  tranche?: TrancheOverlay;
}): Promise<{
  signature: string;
  prepare: PpnPrepareResponse;
  confirm: PpnConfirmResponse;
}> {
  const { wallet, bundleId, amountUsdc } = args;
  const owner = activeSuiAddress(wallet);
  const product = args.tranche ? `TRANCHE-${args.tranche.kind}` : "PPN";
  const opened = await openSuiBasketPosition({
    bundleId: `${product}-${bundleId}`,
    amountUsdc,
    recipient: owner,
  });
  const vaultId = `${opened.market_id}::${opened.position_id}`;
  const signature =
    opened.digests.buy ?? opened.digests.create_market ?? opened.digests.mint ?? opened.market_id;
  const now = Date.now();
  const maturityDays = args.maturityDays ?? 30;
  const prepare: PpnPrepareResponse = {
    kind: "prepared",
    vault_id: vaultId,
    bundle_id: await resolveBundleUuidForPpn(bundleId).catch(() => bundleId),
    wallet_address: owner,
    amount_usdc: amountUsdc,
    management_fee_bps: 10,
    management_fee_usdc: amountUsdc * 0.001,
    strategy_fee_bps: 5,
    strategy_fee_usdc: amountUsdc * 0.0005,
    total_open_fee_usdc: amountUsdc * 0.0015,
    net_deposit_usdc: amountUsdc * 0.9985,
    estimated_apy: 8,
    maturity_date: new Date(now + maturityDays * 86_400_000).toISOString(),
    maturity_ts: Math.floor((now + maturityDays * 86_400_000) / 1000),
    sui_market_id: opened.market_id,
    sui_position_id: opened.position_id,
    transaction_digest: signature,
  };
  const confirm: PpnConfirmResponse = {
    vault_id: vaultId,
    bundle_id: prepare.bundle_id,
    wallet_address: owner,
    principal_usdc: amountUsdc,
    signature,
    transaction_id: signature,
  };
  return { signature, prepare, confirm };
}

export async function ppnRedeem(args: {
  wallet: WalletSigner;
  vaultId?: string;
  bundleId?: string;
  confirmationTimeoutMs?: number;
}): Promise<{
  signature: string;
  prepare: PpnRedeemPrepareResponse;
  confirm: PpnRedeemConfirmResponse;
}> {
  const owner = activeSuiAddress(args.wallet);
  const { marketId, positionId } = splitVaultId(args.vaultId);
  const redeemed = await redeemSuiBasketPosition({ marketId, positionId });
  const signature = redeemed.digests.claim ?? redeemed.digests.resolve ?? marketId;
  const prepare: PpnRedeemPrepareResponse = {
    kind: "prepared",
    vault_id: args.vaultId!,
    bundle_id: args.bundleId ?? marketId,
    wallet_address: owner,
    principal_usdc: 0,
    strategy_fee_bps: 5,
    strategy_fee_usdc: 0,
    expected_proceeds_usdc: 0,
    sui_market_id: marketId,
    sui_position_id: positionId,
    transaction_digest: signature,
  };
  const confirm: PpnRedeemConfirmResponse = {
    vault_id: args.vaultId!,
    bundle_id: prepare.bundle_id,
    wallet_address: owner,
    principal_returned: 0,
    signature,
    transaction_id: signature,
  };
  return { signature, prepare, confirm };
}

export async function ppnDivest(args: {
  wallet: WalletSigner;
  vaultId: string;
  confirmationTimeoutMs?: number;
}): Promise<{
  signature: string;
  prepare: PpnDivestPrepareResponse;
  confirm: PpnDivestConfirmResponse;
}> {
  const redeemed = await ppnRedeem({ wallet: args.wallet, vaultId: args.vaultId });
  return {
    signature: redeemed.signature,
    prepare: {
      kind: "prepared",
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id,
      wallet_address: redeemed.prepare.wallet_address,
      strategy_fee_bps: 5,
      estimated_strategy_fee_usdc: 0,
      sui_market_id: redeemed.prepare.sui_market_id,
      sui_position_id: redeemed.prepare.sui_position_id,
      transaction_digest: redeemed.signature,
    },
    confirm: {
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id,
      wallet_address: redeemed.prepare.wallet_address,
      signature: redeemed.signature,
      status: "active",
    },
  };
}

export async function ppnCloseEarly(args: {
  wallet: WalletSigner;
  vaultId: string;
  minProceedsUsdc?: number;
  confirmationTimeoutMs?: number;
}): Promise<{
  signature: string;
  prepare: PpnClosePrepareResponse;
  confirm: PpnCloseConfirmResponse;
}> {
  const redeemed = await ppnRedeem({ wallet: args.wallet, vaultId: args.vaultId });
  return {
    signature: redeemed.signature,
    prepare: {
      kind: "prepared",
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id,
      wallet_address: redeemed.prepare.wallet_address,
      principal_usdc: 0,
      strategy_fee_bps: 5,
      estimated_strategy_fee_usdc: 0,
      estimated_net_usdc: 0,
      sui_market_id: redeemed.prepare.sui_market_id,
      sui_position_id: redeemed.prepare.sui_position_id,
      transaction_digest: redeemed.signature,
    },
    confirm: {
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id,
      wallet_address: redeemed.prepare.wallet_address,
      principal_returned: 0,
      signature: redeemed.signature,
      transaction_id: redeemed.signature,
      status: "withdrawn",
    },
  };
}
