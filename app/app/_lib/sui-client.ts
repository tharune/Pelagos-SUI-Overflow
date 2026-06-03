"use client";

import { BACKEND_URL } from "./tokens";

export interface SuiLocalBasketDeposit {
  chain: "sui";
  network: string;
  bundle_id: string;
  owner: string;
  amount_raw: string;
  market_id: string;
  position_id: string;
  digests: {
    mint: string | null;
    create_market: string | null;
    buy: string | null;
  };
}

export interface SuiLocalBasketRedeem {
  chain: "sui";
  network: string;
  market_id: string;
  position_id: string;
  digests: {
    resolve: string | null;
    claim: string | null;
  };
}

export interface SuiStatus {
  network: string;
  active_address: string;
  package_id: string;
  mock_usdc_type: string;
  balances?: {
    mock_usdc?: unknown;
  };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
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

export async function fetchSuiStatus(): Promise<SuiStatus> {
  const res = await fetch(`${BACKEND_URL}/api/sui/status`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch Sui status (HTTP ${res.status})`);
  return (await res.json()) as SuiStatus;
}

export async function openSuiBasketPosition(args: {
  bundleId: string;
  amountUsdc: number;
  recipient?: string;
}): Promise<SuiLocalBasketDeposit> {
  return postJson<SuiLocalBasketDeposit>("/api/sui/local/basket/deposit", {
    bundle_id: args.bundleId,
    amount_usdc: args.amountUsdc,
    recipient: args.recipient,
  });
}

export async function redeemSuiBasketPosition(args: {
  marketId: string;
  positionId: string;
}): Promise<SuiLocalBasketRedeem> {
  return postJson<SuiLocalBasketRedeem>("/api/sui/local/basket/redeem", {
    market_id: args.marketId,
    position_id: args.positionId,
  });
}

export function sumSuiCoinBalance(raw: unknown): number {
  let total = 0n;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    const maybeBalance = (value as { balance?: unknown }).balance;
    if (typeof maybeBalance === "string" && /^\d+$/.test(maybeBalance)) {
      total += BigInt(maybeBalance);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(raw);
  return Number(total) / 1_000_000;
}
