"use client";

/**
 * Polymarket CLOB orderbook client + impact math.
 *
 * The buy-panel feeds in the top-N weighted legs of a basket and asks
 * for per-leg slippage from the live orderbook. We call the backend's
 * /api/markets/orderbooks passthrough (which caches + batches) with the
 * leg token_ids, walk the asks for a YES buy or the bids for a NO buy,
 * and return the weighted-average fill price in basis-points of impact
 * versus the mid.
 *
 * The backend caps fan-out at 25 token_ids per request and caches
 * responses for 3 seconds, so calling this on every keystroke is safe —
 * the browser also debounces via the caller.
 */

import { BACKEND_URL } from "./tokens";

export type BookLevel = { price: number; size: number };
export type Orderbook = { bids: BookLevel[]; asks: BookLevel[] };

/** Fetch orderbook snapshots for the given CLOB token ids. */
export async function fetchOrderbooks(
  tokenIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, Orderbook>> {
  const out = new Map<string, Orderbook>();
  const clean = tokenIds.filter((id) => id && id.length > 0);
  if (clean.length === 0) return out;

  const url = `${BACKEND_URL}/api/markets/orderbooks?token_ids=${encodeURIComponent(clean.join(","))}`;
  const res = await fetch(url, { cache: "no-store", signal });
  if (!res.ok) return out;

  const body = (await res.json()) as {
    books?: Array<{ token_id: string; bids?: BookLevel[]; asks?: BookLevel[] }>;
  };
  for (const b of body.books ?? []) {
    if (!b.token_id) continue;
    out.set(b.token_id, {
      bids: (b.bids ?? []).filter((lvl) => lvl.price > 0 && lvl.size > 0),
      asks: (b.asks ?? []).filter((lvl) => lvl.price > 0 && lvl.size > 0),
    });
  }
  return out;
}

/**
 * Hard ceiling on any single slippage report. 100% (10_000 bp) is the
 * mathematical maximum that makes sense — if impact climbs past this,
 * the order is structurally unfillable and the quote is meaningless.
 * We prefer surfacing a huge number over a silent cap because under-
 * reporting slippage is what creates arb vulnerability.
 */
export const SLIPPAGE_BPS_CEILING = 10_000;

/**
 * Compute the slippage (in basis points) of buying `usdcNotional` into
 * the ask side of a market’s CLOB book. The walk is honest: we cross
 * levels in ascending price order until we’ve spent the notional, then
 * compare the weighted-average fill price to the top-of-book mid.
 *
 * If the depth visible in the snapshot runs out before we fill the
 * notional, we add a scarcity penalty proportional to the unfilled
 * fraction, floored by the quoted book’s worst level (so the reported
 * impact reflects how bad it would be to keep walking into thinner
 * air). This was previously capped at 2000 bp (20%), which under-
 * reported on very large orders and was the main arb surface:
 * someone could buy at a ≤ 20% quote and hedge legs at real 40%+ cost.
 */
export function quoteSideImpact(
  usdcNotional: number,
  book: Orderbook,
): { slippageBps: number; filledUsdc: number; avgPrice: number; midPrice: number } {
  if (!book || book.asks.length === 0 || usdcNotional <= 0) {
    return { slippageBps: 0, filledUsdc: 0, avgPrice: 0, midPrice: 0 };
  }
  const topAsk = book.asks[0]?.price ?? 0;
  const topBid = book.bids[0]?.price ?? topAsk;
  const midPrice = topBid > 0 && topAsk > 0 ? (topBid + topAsk) / 2 : topAsk;
  if (midPrice <= 0) {
    return { slippageBps: 0, filledUsdc: 0, avgPrice: 0, midPrice: 0 };
  }

  let remaining = usdcNotional;
  let totalCostUsd = 0;
  let totalTokens = 0;
  let worstPrice = topAsk;
  for (const level of book.asks) {
    if (remaining <= 0) break;
    const levelUsd = level.price * level.size;
    worstPrice = level.price;
    if (levelUsd >= remaining) {
      const tokens = remaining / level.price;
      totalCostUsd += remaining;
      totalTokens += tokens;
      remaining = 0;
    } else {
      totalCostUsd += levelUsd;
      totalTokens += level.size;
      remaining -= levelUsd;
    }
  }

  const filledUsdc = usdcNotional - remaining;
  if (totalTokens <= 0) {
    return {
      slippageBps: SLIPPAGE_BPS_CEILING,
      filledUsdc: 0,
      avgPrice: 0,
      midPrice,
    };
  }

  const avgPrice = totalCostUsd / totalTokens;
  const baseBps = ((avgPrice - midPrice) / midPrice) * 10_000;

  // Scarcity penalty for the unfilled slice. Assume the next shares
  // would come at a price at least as bad as the worst level we just
  // walked, and that price would keep climbing sqrt-style as we go
  // deeper. Calibrated so: unfilled 20% ≈ +500 bp, unfilled 50% ≈
  // +2500 bp, unfilled 100% (book completely empty) → ceiling.
  const unfilledFrac = Math.max(0, Math.min(1, remaining / usdcNotional));
  let unfilledBps = 0;
  if (unfilledFrac > 0) {
    const worstBps = ((worstPrice - midPrice) / midPrice) * 10_000;
    unfilledBps =
      Math.max(worstBps, 0) * (1 + unfilledFrac * 3) + unfilledFrac * 5_000;
  }

  const rawBps = Math.max(0, baseBps) + unfilledBps;
  const slippageBps = Math.min(SLIPPAGE_BPS_CEILING, rawBps);

  return { slippageBps, filledUsdc, avgPrice, midPrice };
}

/**
 * Compute the slippage (in basis points) of SELLING a position worth
 * `usdcNotional` (mid-valued) into the bid side of a market's CLOB book.
 *
 * Mirror of `quoteSideImpact` but in the opposite direction: the user is
 * unwinding a long, the MM is bidding. We walk the bids in descending
 * price order until we've delivered the mid-valued token quantity, then
 * compare the weighted-average fill price to the top-of-book mid. A
 * positive slippage number means the user received LESS than mid per
 * token — which is exactly what happens on any real redemption.
 *
 * Same scarcity-penalty logic as the ask-side walk, so very large
 * redemptions on thin books report honest (huge) numbers rather than
 * silently capping.
 */
export function quoteBidSideImpact(
  usdcNotional: number,
  book: Orderbook,
): { slippageBps: number; filledUsdc: number; avgPrice: number; midPrice: number } {
  if (!book || book.bids.length === 0 || usdcNotional <= 0) {
    return { slippageBps: 0, filledUsdc: 0, avgPrice: 0, midPrice: 0 };
  }
  const topAsk = book.asks[0]?.price ?? 0;
  const topBid = book.bids[0]?.price ?? 0;
  const midPrice =
    topBid > 0 && topAsk > 0 ? (topBid + topAsk) / 2 : topBid;
  if (midPrice <= 0) {
    return { slippageBps: 0, filledUsdc: 0, avgPrice: 0, midPrice: 0 };
  }

  // Mid-valued token quantity the user is trying to deliver into the
  // market. We translate USDC notional → token count at mid so the
  // semantics mirror the ask-side function (which takes USDC in).
  const targetTokens = usdcNotional / midPrice;
  let remainingTokens = targetTokens;
  let receivedUsd = 0;
  let totalTokens = 0;
  let worstPrice = topBid;
  for (const level of book.bids) {
    if (remainingTokens <= 0) break;
    worstPrice = level.price;
    const take = Math.min(level.size, remainingTokens);
    receivedUsd += take * level.price;
    totalTokens += take;
    remainingTokens -= take;
  }

  if (totalTokens <= 0) {
    return {
      slippageBps: SLIPPAGE_BPS_CEILING,
      filledUsdc: 0,
      avgPrice: 0,
      midPrice,
    };
  }

  const avgPrice = receivedUsd / totalTokens;
  // Sell-side slippage: positive when avgPrice < mid (user gets less).
  const baseBps = ((midPrice - avgPrice) / midPrice) * 10_000;

  const unfilledFrac = Math.max(
    0,
    Math.min(1, remainingTokens / targetTokens),
  );
  let unfilledBps = 0;
  if (unfilledFrac > 0) {
    const worstBps = Math.max(
      0,
      ((midPrice - worstPrice) / midPrice) * 10_000,
    );
    unfilledBps =
      worstBps * (1 + unfilledFrac * 3) + unfilledFrac * 5_000;
  }

  const rawBps = Math.max(0, baseBps) + unfilledBps;
  const slippageBps = Math.min(SLIPPAGE_BPS_CEILING, rawBps);

  return { slippageBps, filledUsdc: receivedUsd, avgPrice, midPrice };
}
