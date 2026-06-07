/**
 * Pelagos Sui protected-note and tranche client.
 *
 * The UI keeps the same product experience while writes go through the Sui
 * local basket endpoints. Backend portfolio/RFQ reads are still used for
 * durable rows and market-maker style quote previews.
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

// ---- Capital deployment plan (floor sleeve + multi-product risk sleeve) ----

export interface NoteSleeveLeg {
  product: "basket" | "tranche" | "distribution";
  kind?: "senior" | "mezzanine" | "junior";
  pct: number;
  usdc: number;
  label: string;
}

export interface NoteAllocation {
  profile: string;
  deposit_usdc: number;
  apy: number;
  maturity_days: number;
  floor: { pct: number; usdc: number; at_maturity_usdc: number };
  risk_sleeve: { pct: number; usdc: number; legs: NoteSleeveLeg[] };
}

/** Ask the backend allocator how a note's capital deploys across products. */
export function fetchNoteAllocation(args: {
  profile: string;
  amountUsdc: number;
  apy: number;
  days: number;
  basketLabel?: string;
  distributionLabel?: string;
  baskets?: string[];
  distributions?: string[];
}): Promise<NoteAllocation> {
  return postJson<NoteAllocation>("/api/ppn/allocate", {
    profile: args.profile,
    amount_usdc: args.amountUsdc,
    apy: args.apy,
    days: args.days,
    basket_label: args.basketLabel,
    distribution_label: args.distributionLabel,
    baskets: args.baskets,
    distributions: args.distributions,
  });
}

export interface PpnPrepareResponse {
  kind: "prepared";
  vault_id: string | null;
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
  fee_usdc?: number;
  net_deposit_usdc?: number;
  deposit_fee_bps?: number;
  expected_shares?: number;
  share_price?: number;
  management_fee_bps?: number;
  management_fee_usdc?: number;
  strategy_fee_bps?: number;
  strategy_fee_usdc?: number;
  total_open_fee_usdc?: number;
  estimated_apy?: number;
  maturity_date: string;
  maturity_ts: number;
  sui_market_id: string;
  sui_position_id: string;
  transaction_digest?: string;
  tx_bytes?: string;
  sender?: string;
  dry_run?: { ok: boolean; status: string; gas_used?: string; error?: string };
}

export interface PpnConfirmResponse {
  confirmed?: boolean;
  vault_id?: string | null;
  bundle_id?: string;
  wallet_address?: string;
  principal_usdc?: number;
  signature?: string;
  digest?: string;
  explorer_url?: string;
  transaction_id?: string | null;
}

export interface PpnRedeemPrepareResponse {
  kind: "prepared";
  vault_id?: string | null;
  bundle_id?: string | null;
  wallet_address: string;
  principal_usdc: number;
  strategy_fee_bps?: number;
  strategy_fee_usdc?: number;
  expected_proceeds_usdc: number;
  sui_market_id?: string;
  sui_position_id?: string;
  share_id?: string;
  transaction_digest?: string;
  tx_bytes?: string;
  sender?: string;
  dry_run?: { ok: boolean; status: string; gas_used?: string; error?: string };
}

export interface PpnRedeemConfirmResponse {
  confirmed?: boolean;
  vault_id?: string | null;
  bundle_id?: string;
  wallet_address?: string;
  principal_returned?: number;
  signature?: string;
  digest?: string;
  explorer_url?: string;
  transaction_id?: string | null;
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

function requireWallet(wallet: WalletSigner): string {
  if (!wallet.connected || !wallet.address) {
    throw new PpnError("Connect a Sui wallet to continue.", 0);
  }
  return wallet.address;
}

/**
 * Non-custodial protected-note / tranche open: backend builds the vault deposit
 * PTB (tagged ppn:<kind>:<bundle>), the wallet signs it, then /confirm verifies.
 */
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
  const owner = requireWallet(args.wallet);
  const bundleUuid = await resolveBundleUuidForPpn(args.bundleId).catch(() => args.bundleId);

  const prepare = await postJson<PpnPrepareResponse>("/api/ppn/onchain/prepare", {
    bundle_id: bundleUuid,
    wallet_address: owner,
    amount_usdc: args.amountUsdc,
    maturity_days: args.maturityDays ?? 30,
    ...(args.tranche
      ? {
          tranche_kind: args.tranche.kind,
          tranche_attach: args.tranche.attach,
          tranche_detach: args.tranche.detach,
          price_per_token: args.tranche.pricePerToken,
        }
      : {}),
  });
  if (!prepare.tx_bytes) {
    throw new PpnError("Backend did not return a signable transaction.", 0);
  }

  const signature = await args.wallet.signAndExecute(prepare.tx_bytes);

  const confirm = await postJson<PpnConfirmResponse>("/api/ppn/onchain/confirm", {
    vault_id: prepare.vault_id,
    wallet_address: owner,
    signature,
    // Pass the bundle + amount so the ledger record never depends solely on
    // the Supabase vault lookup (lets the buy show in Portfolio → History).
    bundle_id: bundleUuid,
    amount_usdc: args.amountUsdc,
  });
  return { signature, prepare, confirm };
}

export async function ppnRedeem(args: {
  wallet: WalletSigner;
  vaultId?: string;
  bundleId?: string;
  trancheKind?: "senior" | "mezzanine" | "junior";
  confirmationTimeoutMs?: number;
}): Promise<{
  signature: string;
  prepare: PpnRedeemPrepareResponse;
  confirm: PpnRedeemConfirmResponse;
}> {
  const owner = requireWallet(args.wallet);

  const prepare = await postJson<PpnRedeemPrepareResponse>("/api/ppn/onchain/redeem/prepare", {
    wallet_address: owner,
    ...(args.bundleId ? { bundle_id: args.bundleId } : {}),
    ...(args.vaultId ? { vault_id: args.vaultId } : {}),
    ...(args.trancheKind ? { tranche_kind: args.trancheKind } : {}),
  });
  if (!prepare.tx_bytes) {
    throw new PpnError("No redeemable on-chain position for this wallet.", 404);
  }

  const signature = await args.wallet.signAndExecute(prepare.tx_bytes);

  const confirm = await postJson<PpnRedeemConfirmResponse>("/api/ppn/onchain/redeem/confirm", {
    vault_id: prepare.vault_id ?? args.vaultId,
    wallet_address: owner,
    signature,
    // Bundle fallback so the sell records even if the vault lookup misses.
    bundle_id: args.bundleId ?? prepare.bundle_id ?? undefined,
  });
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
      bundle_id: redeemed.prepare.bundle_id ?? "",
      wallet_address: redeemed.prepare.wallet_address ?? "",
      strategy_fee_bps: 5,
      estimated_strategy_fee_usdc: 0,
      sui_market_id: redeemed.prepare.sui_market_id ?? "",
      sui_position_id: redeemed.prepare.sui_position_id ?? "",
      transaction_digest: redeemed.signature,
    },
    confirm: {
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id ?? "",
      wallet_address: redeemed.prepare.wallet_address ?? "",
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
      bundle_id: redeemed.prepare.bundle_id ?? "",
      wallet_address: redeemed.prepare.wallet_address ?? "",
      principal_usdc: 0,
      strategy_fee_bps: 5,
      estimated_strategy_fee_usdc: 0,
      estimated_net_usdc: 0,
      sui_market_id: redeemed.prepare.sui_market_id ?? "",
      sui_position_id: redeemed.prepare.sui_position_id ?? "",
      transaction_digest: redeemed.signature,
    },
    confirm: {
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id ?? "",
      wallet_address: redeemed.prepare.wallet_address ?? "",
      principal_returned: 0,
      signature: redeemed.signature,
      transaction_id: redeemed.signature,
      status: "withdrawn",
    },
  };
}
