"use client";

/**
 * DeepBook Predict client (Pelagos / Sui testnet).
 *
 * DeepBook Predict is Sui's native on-chain prediction-market protocol. This
 * client talks to our backend `/api/predict/*` routes, which are pinned to the
 * `predict-testnet-4-16` deployment and the canonical predict-server indexer.
 *
 * Reads + the live SIMULATION (`/quote`) need no funds (on-chain devInspect).
 * Writes (mint/redeem) are server-signed by the protocol desk and require the
 * signer to hold dUSDC (Predict's faucet-gated quote asset, not testnet USDC).
 */

import { BACKEND_URL } from "./tokens";

export interface PredictConfig {
  network: string;
  rpc_url: string;
  server_url: string;
  package_id: string;
  predict_object_id: string;
  dusdc_type: string;
  dusdc_decimals: number;
}

export interface PredictStatus {
  config: PredictConfig;
  signer_address?: string | null;
  signer_configured?: boolean;
  [k: string]: unknown;
}

export interface PredictOracle {
  oracle_id: string;
  underlying_asset: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: string;
}

/** Live on-chain simulation for a trade (mint cost / redeem payout, 6dp raw). */
export interface PredictQuote {
  asset: string;
  oracle_id: string;
  expiry: number;
  strike: string;
  is_up: boolean;
  quantity: string;
  mint_cost: string;
  redeem_payout: string;
  dusdc_decimals: number;
}

export interface PredictWriteResult {
  digest: string;
  status: string;
  explorer_url?: string;
  manager_id?: string | null;
}

async function readErr(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j?.error) return j.error;
  } catch {
    /* ignore */
  }
  return `HTTP ${res.status}`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, { signal });
  if (!res.ok) throw new Error(await readErr(res));
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readErr(res));
  return (await res.json()) as T;
}

export const fetchPredictConfig = () => getJson<PredictConfig>("/api/predict/config");
export const fetchPredictStatus = () => getJson<PredictStatus>("/api/predict/status");

export async function fetchActiveOracles(): Promise<PredictOracle[]> {
  const r = await getJson<PredictOracle[] | PredictOracle>("/api/predict/oracles/active");
  return Array.isArray(r) ? r : r ? [r] : [];
}

/** One-call live simulation: server picks the active oracle + valid grid strike. */
export const fetchPredictQuote = (args: {
  asset: string;
  quantity: string;
  isUp: boolean;
  signal?: AbortSignal;
}) =>
  getJson<PredictQuote>(
    `/api/predict/quote?asset=${encodeURIComponent(args.asset)}&quantity=${args.quantity}&is_up=${args.isUp}`,
    args.signal,
  );

export const fetchPredictManagers = (owner: string) =>
  getJson<Array<{ manager_id: string }>>(`/api/predict/managers?owner=${owner}`);

export const createPredictManager = () => postJson<PredictWriteResult>("/api/predict/manager", {});

export const predictMint = (body: {
  manager_id: string;
  oracle_id: string;
  expiry: number;
  strike: string;
  is_up: boolean;
  quantity: string;
  deposit_amount_raw: string;
}) => postJson<PredictWriteResult>("/api/predict/mint", body);

export const predictRedeem = (body: {
  manager_id: string;
  oracle_id: string;
  expiry: number;
  strike: string;
  is_up: boolean;
  quantity: string;
}) => postJson<PredictWriteResult>("/api/predict/redeem", body);

/** Format a 6dp raw dUSDC amount for display. */
export function fmtDusdc(raw: string | number, decimals = 6): string {
  const n = Number(raw) / 10 ** decimals;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}
