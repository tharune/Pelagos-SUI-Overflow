"use client";

/**
 * Client for the mUSDC simulation-settlement rail (/api/sim) — an INDEPENDENT
 * settlement venue from dUSDC/Predict. mUSDC is our freely-mintable currency; a
 * position deposits its premium into our `Vault<MOCK_USDC>` (real on-chain receipt)
 * and settles by minting the computed payoff. No swap, no peg to dUSDC.
 */
import { BACKEND_URL } from "./tokens";

export type SimProduct = "strip" | "option" | "vol" | "dist";

export interface SimBand {
  lower_usd: number;
  higher_usd: number;
  payout_usd: number;
}

export interface SimPosition {
  sim_id: string;
  owner: string;
  product: SimProduct;
  name: string;
  premium_usd: number;
  max_payout_usd: number;
  oracle_id: string | null;
  forward_usd: number;
  expiry_ms: number | null;
  bands: SimBand[];
  status: "pending" | "open" | "settled";
  open_digest: string | null;
  settle_digest: string | null;
  payoff_usd: number | null;
  opened_at: number;
}

export interface SimOpenBody {
  owner: string;
  product: SimProduct;
  name: string;
  premium_usd: number;
  max_payout_usd: number;
  oracle_id?: string | null;
  forward_usd: number;
  expiry_ms?: number | null;
  bands: SimBand[];
}

export interface SimPreparedTx {
  tx_bytes: string;
  sender: string;
  dry_run?: unknown;
  sim_id: string;
  label: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error((msg as { error?: string }).error ?? `${path} -> HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Build the user-signed mUSDC premium deposit for a simulated position. */
export function simOpen(body: SimOpenBody): Promise<SimPreparedTx> {
  return post<SimPreparedTx>("/api/sim/open/prepare", body);
}

/** Mark a sim position opened once the deposit confirms. */
export function simConfirm(sim_id: string, digest: string): Promise<SimPosition> {
  return post<SimPosition>("/api/sim/confirm", { sim_id, digest });
}

/** Compute the realized payoff and mint it in mUSDC. */
export function simSettle(sim_id: string): Promise<{
  sim_id: string;
  settlement_forward_usd: number;
  payoff_usd: number;
  premium_usd: number;
  pnl_usd: number;
  mint_digest: string | null;
  explorer_url: string | null;
}> {
  return post("/api/sim/settle", { sim_id });
}

export async function fetchSimPositions(owner: string): Promise<SimPosition[]> {
  const res = await fetch(`${BACKEND_URL}/api/sim/positions/${owner}`, { cache: "no-store" });
  if (!res.ok) return [];
  const d = (await res.json()) as { positions?: SimPosition[] };
  return d.positions ?? [];
}
