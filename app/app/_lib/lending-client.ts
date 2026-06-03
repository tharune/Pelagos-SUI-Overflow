"use client";
/**
 * Lending client — typed wrappers around the backend `/api/lending/*` routes.
 *
 * The existing routes are backed by the in-memory service in
 * `backend/src/services/lending.ts`. A native Sui lending module can add
 * `prepareSupply / prepareBorrow` style calls later, matching the
 * `deposit-client` / `ppn-client` pattern.
 *
 * Until then, every function here hits the backend and returns immediately —
 * no wallet signing, no on-chain confirmation. The UI can call these from
 * buttons right now; the on-chain upgrade will be a drop-in extension.
 */

import { useEffect, useState } from "react";
import { BACKEND_URL } from "./tokens";

// ---------- Response shapes ----------

export type CollateralKind = "basket" | "tranche";
export type TrancheKind = "senior" | "mezzanine" | "junior";

export interface LendingPoolSnapshot {
  total_deposits: number;
  total_borrows: number;
  utilization: number;
  borrow_rate_apy: number;
  supply_rate_apy: number;
  ltv_table: {
    basket: Record<90 | 70 | 50, number>;
    tranche: Record<TrancheKind, number>;
  };
  reserve_factor: number;
}

export interface LendingQuote {
  ltv: number;
  maxBorrow: number;
  pool: LendingPoolSnapshot;
}

/** Mutations return the fresh `PoolSnapshot` directly. */
export type LendingMutationResult = LendingPoolSnapshot;

// ---------- Low-level helpers ----------

export class LendingError extends Error {
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
    throw new LendingError(msg, res.status, payload);
  }
  return payload as T;
}

// ---------- Public API ----------

export async function fetchLendingSnapshot(): Promise<LendingPoolSnapshot> {
  const res = await fetch(`${BACKEND_URL}/api/lending`);
  if (!res.ok) {
    throw new LendingError(`Failed to fetch lending snapshot (HTTP ${res.status})`, res.status);
  }
  return (await res.json()) as LendingPoolSnapshot;
}

export function quoteLoan(args: {
  kind: CollateralKind;
  tier?: 90 | 70 | 50;
  trancheKind?: TrancheKind;
  collateralValueUsd: number;
}): Promise<LendingQuote> {
  return postJson<LendingQuote>("/api/lending/quote", {
    kind: args.kind,
    tier: args.tier,
    trancheKind: args.trancheKind,
    collateralValueUsd: args.collateralValueUsd,
  });
}

export function lend(amountUsdc: number): Promise<LendingMutationResult> {
  return postJson<LendingMutationResult>("/api/lending/lend", { amount: amountUsdc });
}

export function withdrawLending(amountUsdc: number): Promise<LendingMutationResult> {
  return postJson<LendingMutationResult>("/api/lending/withdraw", { amount: amountUsdc });
}

export function borrow(amountUsdc: number): Promise<LendingMutationResult> {
  return postJson<LendingMutationResult>("/api/lending/borrow", { amount: amountUsdc });
}

export function repay(amountUsdc: number): Promise<LendingMutationResult> {
  return postJson<LendingMutationResult>("/api/lending/repay", { amount: amountUsdc });
}

// ---------- React hook ----------

const SNAPSHOT_POLL_MS = 10_000;

/**
 * Live pool snapshot hook. Polls `/api/lending` every 10s.
 * Call `refresh()` after a mutation to update immediately.
 */
export function useLendingSnapshot(): {
  snapshot: LendingPoolSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<LendingPoolSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await fetchLendingSnapshot();
      setSnapshot(snap);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const tick = () => void load().catch(() => {});
    tick();
    const id = setInterval(() => {
      if (!cancelled) tick();
    }, SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { snapshot, loading, error, refresh: load };
}
