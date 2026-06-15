"use client";

/**
 * Market-maker secondary-market client (Pelagos / Sui) — SIMULATED.
 *
 * The protocol market-maker quotes a per-product bid below par for a
 * pre-settlement position (the "simulated pricing"). On Pelagos there is no
 * on-chain MM rail, so:
 *   1) POST /api/mm/quote   → a simulated MM bid (price below par, per product),
 *   2) accepting it records a simulated exit via POST /api/mm/confirm so the
 *      fill shows in History — no wallet signature, no on-chain transaction.
 *
 * The position itself is reflected by the caller (e.g. the basket page clears
 * its virtual position, exactly as a redeem does).
 */

import { BACKEND_URL } from "./tokens";

export type MmProductType = "basket" | "tranche" | "note";
export type MmTrancheKind = "senior" | "junior" | "mezzanine";

/** The simulated MM bid, mirroring the backend quote. */
export interface MmQuote {
  productType: MmProductType;
  trancheKind: MmTrancheKind | null;
  /** Position size being sold, display USDC (== units; par is 1 USDC/unit). */
  size_usdc: number;
  /** MM payout, display USDC. */
  payout_usdc: number;
  /** Per-unit par mark (1) and the per-unit bid the MM pays. */
  mark_per_unit: number;
  bid_per_unit: number;
  /** Discount below par, in bps. */
  spread_bps: number;
  simulated: true;
}

export class MmError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "MmError";
    this.status = status;
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j?.error) return j.error;
  } catch {
    /* keep fallback */
  }
  return fallback;
}

/** Fetch a simulated MM bid for a position size. */
export async function fetchMmQuote(args: {
  productType: MmProductType;
  sizeUsdc: number;
  trancheKind?: MmTrancheKind;
  signal?: AbortSignal;
}): Promise<MmQuote> {
  const res = await fetch(`${BACKEND_URL}/api/mm/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_type: args.productType,
      size_usdc: args.sizeUsdc,
      tranche_kind: args.trancheKind,
    }),
    signal: args.signal,
  });
  if (!res.ok) throw new MmError(await readError(res, `MM quote failed (HTTP ${res.status})`), res.status);
  return (await res.json()) as MmQuote;
}

/**
 * Accept a simulated MM bid: records the exit to History at the quoted payout.
 * Returns the recorded fill. No on-chain transaction — the bid is paid from the
 * (simulated) MM desk and the sale is a ledger event.
 */
export async function sellToMM(args: {
  bundleId: string;
  walletAddress: string;
  productType: MmProductType;
  sizeUsdc: number;
  trancheKind?: MmTrancheKind;
  /** A pre-fetched quote to reuse; re-fetched if absent. */
  quote?: MmQuote | null;
}): Promise<{ quote: MmQuote; payoutUsdc: number; signature: string }> {
  const quote =
    args.quote ??
    (await fetchMmQuote({
      productType: args.productType,
      sizeUsdc: args.sizeUsdc,
      trancheKind: args.trancheKind,
    }));
  const res = await fetch(`${BACKEND_URL}/api/mm/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bundle_id: args.bundleId,
      wallet_address: args.walletAddress,
      payout_usdc: quote.payout_usdc,
    }),
  });
  if (!res.ok) throw new MmError(await readError(res, `MM sell failed (HTTP ${res.status})`), res.status);
  const j = (await res.json()) as { tx_signature?: string; payout_usdc?: number };
  return { quote, payoutUsdc: j.payout_usdc ?? quote.payout_usdc, signature: j.tx_signature ?? "" };
}
