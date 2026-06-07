"use client";
/**
 * Client for the continuous distribution market. Quotes are computed server-side
 * (Normal mu/sigma, constant-L2 AMM, g(x)-f(x)); opening a position escrows the
 * collateral on-chain via the user's wallet (prepare -> sign -> confirm).
 */
import { BACKEND_URL } from "./tokens";
import type { WalletSigner } from "./wallet-bridge";

export interface ContinuousMarket {
  id: string;
  underlying: string;
  question: string;
  unit: string;
  expiry_ts: number;
  mu: number;
  sigma: number;
  mu_min: number;
  mu_max: number;
  sigma_min: number;
  sigma_max: number;
  step: number;
  source: "polymarket" | "spot" | "reference";
  volume_usd: number;
  category: string;
  polymarket_url: string | null;
  pool_liquidity_usdc: number;
  backing_usdc: number;
  l2_norm_k: number;
}

export interface ContinuousQuote {
  market_id: string;
  question: string;
  unit: string;
  market_mu: number;
  market_sigma: number;
  target_mu: number;
  target_sigma: number;
  collateral_usdc: number;
  maker_fee_usdc: number;
  net_usdc: number;
  x: number[];
  market_pdf: number[];
  target_pdf: number[];
  market_curve: number[];
  target_curve: number[];
  trade_curve: number[];
  collateral_required_usdc: number;
  max_profit_usdc: number;
  max_loss_usdc: number;
  expected_value_usdc: number;
  l2_distance: number;
  pool_liquidity_usdc: number;
  price_impact_bps: number;
  sigma_min: number;
  quote_model: string;
}

export interface ContinuousPosition {
  id: string;
  market_id: string;
  question: string;
  market_mu: number;
  market_sigma: number;
  target_mu: number;
  target_sigma: number;
  collateral_usdc: number;
  max_profit_usdc: number;
  open_digest: string;
  opened_at: number;
  realized_x: number;
  settled: boolean;
  settle_digest?: string;
  payoff_usdc?: number;
  net_usdc?: number;
  settled_at?: number;
}

export interface SettleResult {
  position_id: string;
  realized_x: number;
  payoff_usdc: number;
  net_usdc: number;
  pnl_usdc: number;
  settle_digest: string | null;
  explorer_url: string | null;
}

async function jsonGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function jsonPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return payload as T;
}

export function fetchContinuousMarkets(): Promise<{ markets: ContinuousMarket[] }> {
  return jsonGet("/api/distribution/continuous/markets");
}

/** Seed simulated AMM liquidity into a market's pool. */
export function seedLiquidity(
  marketId: string,
  amountUsdc: number,
): Promise<{ market_id: string; pool_liquidity_usdc: number; seeded_usdc: number }> {
  return jsonPost("/api/distribution/continuous/seed-liquidity", {
    market_id: marketId,
    amount_usdc: amountUsdc,
  });
}

/** Seed a random 5–6 figure position into EVERY market pool at once. */
export function seedAllPools(): Promise<{
  count: number;
  seeded: Array<{ market_id: string; amount_usdc: number; pool_liquidity_usdc: number }>;
}> {
  return jsonPost("/api/distribution/continuous/seed-all", {});
}

export function quoteContinuous(args: {
  marketId: string;
  targetMu: number;
  targetSigma: number;
  collateralUsdc: number;
}): Promise<ContinuousQuote> {
  return jsonPost("/api/distribution/continuous/quote", {
    market_id: args.marketId,
    target_mu: args.targetMu,
    target_sigma: args.targetSigma,
    collateral_usdc: args.collateralUsdc,
  });
}

export function fetchContinuousPositions(owner: string): Promise<{ positions: ContinuousPosition[] }> {
  return jsonGet(`/api/distribution/continuous/positions/${encodeURIComponent(owner)}`);
}

/**
 * Open a continuous distribution position: the backend builds the collateral
 * deposit PTB, the wallet signs + submits it, then the backend verifies.
 */
export async function openContinuousPosition(args: {
  wallet: WalletSigner;
  marketId: string;
  targetMu: number;
  targetSigma: number;
  collateralUsdc: number;
}): Promise<{ digest: string; position: ContinuousPosition }> {
  const owner = args.wallet.address;
  if (!args.wallet.connected || !owner) throw new Error("Connect a Sui wallet to open a position.");

  const prep = await jsonPost<{ tx_bytes?: string }>("/api/distribution/continuous/open/prepare", {
    wallet_address: owner,
    market_id: args.marketId,
    target_mu: args.targetMu,
    target_sigma: args.targetSigma,
    collateral_usdc: args.collateralUsdc,
  });
  if (!prep.tx_bytes) throw new Error("Backend did not return a signable transaction.");

  const digest = await args.wallet.signAndExecute(prep.tx_bytes);

  const conf = await jsonPost<{ confirmed: boolean; position: ContinuousPosition }>(
    "/api/distribution/continuous/open/confirm",
    {
      wallet_address: owner,
      market_id: args.marketId,
      target_mu: args.targetMu,
      target_sigma: args.targetSigma,
      collateral_usdc: args.collateralUsdc,
      signature: digest,
    },
  );
  return { digest, position: conf.position };
}

/** Settle a position: the protocol pays the realized net on-chain. */
export function settleContinuousPosition(args: {
  owner: string;
  positionId: string;
}): Promise<SettleResult> {
  return jsonPost("/api/distribution/continuous/settle", {
    wallet_address: args.owner,
    position_id: args.positionId,
  });
}

export interface CloseResult {
  position_id: string;
  mark_usdc: number;
  slippage_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  pnl_usdc: number;
  price_impact_bps: number;
  close_digest: string | null;
  explorer_url: string | null;
}

/** Sell/close a position before settlement — unwind through the AMM (mark
 * minus maker fee + price-impact slippage), protocol pays the net on-chain. */
export function closeContinuousPosition(args: {
  owner: string;
  positionId: string;
}): Promise<CloseResult> {
  return jsonPost("/api/distribution/continuous/close", {
    wallet_address: args.owner,
    position_id: args.positionId,
  });
}
