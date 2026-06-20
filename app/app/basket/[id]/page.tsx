"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Header, PageFrame } from "../../_components/Header";
import { MetricTile } from "../../_components/charts";
import { C, FS, FD, FM, EASE, tc } from "../../_lib/tokens";
import { bundleById, type Bundle } from "../../_lib/bundles";
import type { LiveBasket, LiveMarket, WindowKey } from "../../_lib/live-baskets";
import { useLiveBaskets } from "../../_lib/use-live-baskets";
import { useSandbox } from "../../_lib/demo-state";
import {
  fetchOrderbooks,
  quoteBidSideImpact,
  quoteSideImpact,
  SLIPPAGE_BPS_CEILING,
  type Orderbook,
} from "../../_lib/orderbook";
import {
  useActiveWalletAddress,
  useWalletSigner,
  useUsdcBalance,
  explorerTxUrl,
} from "../../_lib/wallet-bridge";
import { IS_SUI, friendlyWalletError } from "../../_lib/chain";
import { ConnectModal } from "@mysten/dapp-kit";
import {
  depositIntoBundle,
  redeemFromBundle,
  resolveBundleUuid,
  DepositError,
} from "../../_lib/deposit-client";
import { usePbuBalances } from "../../_lib/portfolio-client";
import { groupVirtualByUiBundle, clearVirtualPositionsByUiBundleId } from "../../_lib/virtual-positions";
import { MmDeskBid } from "../../_components/MmDeskBid";
import { fetchVaultPrice } from "../../../lib/api";

type ResolvedBasket =
  | { kind: "live"; basket: LiveBasket }
  | { kind: "seed"; basket: Bundle }
  | { kind: "missing" };

const WINDOW_LABEL: Record<WindowKey, string> = {
  week: "Short term",
  month: "Medium term",
  long: "Long term",
};

export default function BasketDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const basketState = useLiveBaskets();

  // Fetch vault price at the top level so both the ISSUE PRICE tile and
  // the buy panel use the same authoritative on-chain price from first render.
  const [detailVaultPrice, setDetailVaultPrice] = useState<number | null>(null);
  useEffect(() => {
    if (!id) return;
    // Resolve slug → UUID via the bundles API, then fetch vault price.
    fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:13101"}/api/bundles`)
      .then((r) => r.json())
      .then((bundles: Array<{ id: string; name: string }>) => {
        const match = bundles.find((b) => b.name === id);
        if (!match) return;
        return fetch(
          `${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:13101"}/api/deposit/vault-price/${match.id}`
        ).then((r) => r.json());
      })
      .then((vp) => { if (vp?.issue_price) setDetailVaultPrice(vp.issue_price); })
      .catch(() => {});
  }, [id]);

  // Resolve the basket for this id. **Live data wins when available** —
  // the seed bundle exists only as a fallback for offline / degraded
  // mode. Since the seed ids now mirror the live-grid ids (PBU-HIGH-
  // SHORT, etc.) a naive "seed first" lookup would permanently shadow
  // the live basket's real leg count, constituents list and resolution
  // span. Priority order:
  //   1. live cache has this id       → kind: "live"
  //   2. live still loading            → "loading" (seed would be a lie
  //                                      if live is about to show up)
  //   3. live errored / id not in grid → seed if we have one, else missing
  const resolved: ResolvedBasket | "loading" = useMemo(() => {
    if (basketState.status === "ok") {
      const live = basketState.baskets.find((b) => b.id === id);
      if (live) return { kind: "live", basket: live };
      const seed = bundleById(id);
      return seed ? { kind: "seed", basket: seed } : { kind: "missing" };
    }
    if (basketState.status === "loading") return "loading";
    // error state
    const seed = bundleById(id);
    return seed ? { kind: "seed", basket: seed } : { kind: "missing" };
  }, [id, basketState]);

  if (resolved === "loading") {
    return (
      <>
        <Header />
        <PageFrame>
          <LoadingSkeleton />
        </PageFrame>
      </>
    );
  }

  if (resolved.kind === "missing") {
    return (
      <>
        <Header />
        <PageFrame>
          <div
            style={{
              padding: 48,
              textAlign: "center",
              color: C.textMuted,
              fontFamily: FS,
            }}
          >
            Basket not found.{" "}
            <Link href="/app/basket" style={{ color: C.teal }}>
              Back to all baskets
            </Link>
          </div>
        </PageFrame>
      </>
    );
  }

  const bundle = resolved.basket;
  const color = tc(bundle.tier);
  const tierLabel = bundle.tier === 90 ? "High" : "Low";
  const liveMarkets: LiveMarket[] =
    resolved.kind === "live" ? resolved.basket.markets : [];
  const windowLabel: string | null =
    resolved.kind === "live" ? WINDOW_LABEL[resolved.basket.window] : null;

  return (
    <>
      <Header />
      <PageFrame>
        <Link
          href="/app/basket"
          style={{
            fontSize: 13,
            color: C.textSecondary,
            textDecoration: "none",
            fontFamily: FS,
            display: "inline-flex",
            gap: 8,
            marginBottom: 20,
          }}
        >
          <span>←</span> Back to Baskets
        </Link>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 24,
            gap: 24,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: color,
                  boxShadow: `0 0 10px ${color}80`,
                }}
              />
              <span
                style={{
                  fontFamily: FM,
                  fontSize: 11,
                  letterSpacing: "0.14em",
                  color,
                  textTransform: "uppercase",
                }}
              >
                {tierLabel}
                {windowLabel ? ` · ${windowLabel}` : ""}
              </span>
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 700,
                color: C.textPrimary,
                fontFamily: FD,
                letterSpacing: "-0.01em",
                marginBottom: 6,
              }}
            >
              {bundle.id}
            </div>
            <div style={{ fontSize: 13, color: C.textSecondary, fontFamily: FS }}>
              {renderHeaderMeta(bundle, liveMarkets)}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontSize: 44,
                fontWeight: 700,
                color,
                fontFamily: FD,
                lineHeight: 1,
                letterSpacing: "-0.02em",
              }}
            >
              {(bundle.nav * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: 13, fontFamily: FS, marginTop: 4 }}>
              <span style={{ color: C.textSecondary }}>${bundle.nav.toFixed(3)} · </span>
              <span style={{ color: bundle.change >= 0 ? C.green : C.red }}>
                {bundle.change >= 0 ? "+" : ""}
                {bundle.change.toFixed(1)}% today
              </span>
            </div>
          </div>
        </div>

        <div
          className="basket-detail-grid"
          style={{
            display: "grid",
            // minmax(0, 1fr) on the left lets long questions wrap instead
            // of blowing out the grid; the right column collapses to full
            // width below 900px via the media query below. The right
            // column is NOT pinned to the top anymore — the BasketBuyPanel
            // stretches to match the combined height of chart + metrics
            // + constituents so its bottom edge aligns with the bottom of
            // the left column. No more dark void under the deposit card.
            gridTemplateColumns: "minmax(0, 1fr) 360px",
            alignItems: "stretch",
            gap: 20,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <div
              style={{
                background: C.card,
                border: `0.5px solid ${C.border}`,
                borderRadius: 14,
                padding: "18px 20px 14px",
              }}
            >
              <DetailChart
                history={bundle.history}
                dayHistory={bundle.dayHistory}
                hourHistory={bundle.hourHistory}
                color={color}
                currentNav={bundle.nav}
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
              }}
            >
              <MetricTile
                label="ISSUE PRICE"
                value={`$${(detailVaultPrice ?? bundle.issue ?? bundle.nav).toFixed(3)}`}
                sub="per PBU unit"
              />
              <MetricTile
                label="MAX PAYOUT"
                value="$1.00"
                color={C.green}
                sub="if all legs resolve YES"
              />
              {/* BREAKEVEN used to sit here but just repeated the NAV%.
                  Replaced with TOTAL VOLUME — live Polymarket volume
                  summed across every leg. When the live feed is
                  unavailable we show a dash instead of faking a number. */}
              <MetricTile
                label="TOTAL VOLUME"
                value={formatTotalVolume(liveMarkets)}
                sub={
                  liveMarkets.length > 0
                    ? `across ${liveMarkets.length} live legs`
                    : "live feed unavailable"
                }
              />
            </div>

            {liveMarkets.length > 0 && (
              <div style={{ display: "flex" }}>
                <ConstituentTable markets={liveMarkets} tierColor={color} />
              </div>
            )}
          </div>

          <BasketBuyPanel
            bundle={bundle}
            accent={color}
            markets={liveMarkets}
          />
        </div>
        <style>{BASKET_DETAIL_CSS}</style>
      </PageFrame>
    </>
  );
}

// Media-query overrides for the detail grid. Stacks the buy panel below
// the main column once the viewport drops under 900px (which matches
// what happens at high browser zoom on a standard 14" laptop).
const BASKET_DETAIL_CSS = `
  @media (max-width: 900px) {
    .basket-detail-grid {
      grid-template-columns: minmax(0, 1fr) !important;
      align-items: start !important;
    }
  }
`;

/* ---------- Buy panel ----------
 *
 * Full-height right-column action card. Top half is the wallet-aware
 * buy flow (connect → quote → submit). Bottom half is a three-step
 * "how it works" explainer that reads as product copy, not a placeholder.
 *
 * The panel is rendered inside a grid cell with `align-items: stretch`,
 * so `height: 100%` on the outer div makes the card span the combined
 * height of the chart + metrics + constituents table on the left. The
 * two inner sections are laid out with `justify-content: space-between`
 * so the buy section pins to the top and the explainer pins to the
 * bottom — empty space (if any) goes between them, not under the card.
 */

// Tight, non-sloppy product copy. No em dashes, no filler, no
// "exposure in one entry" AI-speak.
const HOW_IT_WORKS: Array<{ num: string; title: string; body: string }> = [
  {
    num: "01",
    title: "Quote assembly",
    body:
      "Your quote is the basket NAV (weighted sum of each leg’s Polymarket price) plus the protocol fee, market-maker fees, and live slippage pulled from the CLOB book. Sells also pay an adverse-selection premium because the desk has to dynamically hedge redemptions in the underlying legs.",
  },
  {
    num: "02",
    title: "Settlement",
    body:
      IS_SUI
        ? `Buy creates a Sui testnet market through the Pelagos Move package, mints mock USDC, and stores the resulting Sui position object against this local basket.`
        : "Buy signs a wallet transaction, transfers USDC into the basket vault, takes the protocol fee, and mints PBU units back to your wallet atomically.",
  },
  {
    num: "03",
    title: "Exit on your terms",
    body:
      "Redeem PBU at live NAV any time, or use it as collateral in Risk Slices, Protected Notes, or lending to build structured positions.",
  },
];

// Hard per-order ceiling. Beyond $250k the slippage on a basket-buy is
// large enough that the UI quote is no longer trustworthy as a retail
// estimate, and the CLOB books at that size need treasury-side handling.
// Enforced at the button disable gate so the label reads “Over limit”.
const MAX_ORDER_USDC = 250_000;

// Fee structure (in basis points). Protocol + MM fees are flat at 25
// bps each (= 0.25% each). Slippage is computed live off the Polymarket
// CLOB — see `quoteFeesBps`.
const PROTOCOL_FEE_BPS = 25;
const MM_SPREAD_BPS = 25;

/** Sell tab only — lower protocol fee + merged desk/flow row (see quoteSellFeesBpsFromBooks). */
const SELL_PROTOCOL_FEE_BPS = 15;
const SELL_DESK_BASE_BPS = 12;
const SELL_ADVERSE_BPS_BASE = 8;
const SELL_ADVERSE_SQRT_K = 220;

// -------- Sell-side adverse-selection premium ----------------------------
//
// When a user redeems a basket, the MM can't just pocket the NAV. They
// bought the underlying Polymarket legs when the user originally
// deposited, and to buy those legs back they cross the bid/ask on each
// leg plus carry the inventory while they unwind. The slippage row
// already captures the CLOB walk, but the slippage alone under-prices
// the flow cost because it assumes an instant fill — real dynamic
// hedging forces the desk to re-hedge as legs drift, and informed
// redemption flow tends to arrive right when NAVs are moving most.
//
// The adverse premium is calibrated so:
//   • a $1k sell pays ~ADVERSE_BPS_BASE (15 bps, the minimum round-trip cost)
//   • a $25k sell on a typical basket (~$5M aggregate leg volume) pays ~40 bps
//   • a $250k sell pays ~105 bps
//
// k = 350 gives that curve when the volume proxy is floored at $100k,
// which keeps thin baskets from reporting microscopic adverse fees
// that would be pure arb for bigger tickets.
const ADVERSE_VOLUME_FLOOR = 100_000;

/**
 * Per-leg slippage estimate from a live CLOB snapshot.
 *
 * For each weighted leg we take `usdcAmount * leg.weight` as that leg’s
 * notional, walk the ask side of its book, and compute the weighted
 * fill price relative to mid. The basket-level slippage is the
 * weight-average across every leg that has a book.
 *
 * If the orderbook map is empty (e.g. the CLOB request is still in
 * flight or Gamma didn’t expose token ids for the market), we fall
 * back to a volume-proxy model so the quote never just reads zero.
 */
function quoteFeesBpsFromBooks(
  usdcAmount: number,
  markets: Array<{ weight?: number; volumeUsd: number; tokenId: string }>,
  books: Map<string, Orderbook>,
): {
  protocolBps: number;
  mmSpreadBps: number;
  slippageBps: number;
  totalBps: number;
  hasLiveBooks: boolean;
} {
  const size = Math.max(0, usdcAmount);
  let slippageBps = 0;
  let coveredWeight = 0;
  let hasLiveBooks = false;

  if (markets.length > 0 && size > 0) {
    for (const m of markets) {
      const w = m.weight && m.weight > 0 ? m.weight : 1 / markets.length;
      const legSize = size * w;
      const book = m.tokenId ? books.get(m.tokenId) : undefined;
      if (book && book.asks.length > 0) {
        hasLiveBooks = true;
        const impact = quoteSideImpact(legSize, book);
        slippageBps += impact.slippageBps * w;
        coveredWeight += w;
      }
    }
  }

  if (!hasLiveBooks) {
    slippageBps = volumeProxySlippageBps(size, markets);
  } else if (coveredWeight > 0 && coveredWeight < 1) {
    // Fill the uncovered weight with a volume-proxy estimate so the
    // reported slippage represents the WHOLE basket, not just the
    // legs whose books we could pull.
    const proxy = volumeProxySlippageBps(
      size * (1 - coveredWeight),
      markets,
    );
    slippageBps = slippageBps + proxy * (1 - coveredWeight);
  }

  // Only enforce the structural ceiling (100%). No artificial 20%
  // clamp: under-reporting is an arb surface. If a $250k order really
  // eats 18% of the basket's book, that's what the user needs to see.
  slippageBps = Math.max(1, Math.min(SLIPPAGE_BPS_CEILING, slippageBps));
  return {
    protocolBps: PROTOCOL_FEE_BPS,
    mmSpreadBps: MM_SPREAD_BPS,
    slippageBps,
    totalBps: PROTOCOL_FEE_BPS + MM_SPREAD_BPS + slippageBps,
    hasLiveBooks,
  };
}

/**
 * Sell-side quote. Mirrors the buy-side helper but walks the BID of
 * each leg's book and adds an adverse-selection premium on top of the
 * protocol + MM fees + slippage stack.
 *
 * The bid walk produces honest redemption impact: each leg's visible
 * bid ladder tells us how much USDC the desk can actually recover by
 * unwinding the hedge, and the shortfall vs. mid is slippage we pass
 * through to the user. The adverse premium then captures the residual
 * flow cost (dynamic re-hedging of the basket's leg-level greeks over
 * the unwind window, plus the informed-flow tilt baked into redemption
 * timing).
 *
 * Calibration: a $1k sell pays ~15 bps adverse; a $25k sell on a
 * $5M-volume basket pays ~40 bps; a $250k sell pays ~105 bps. The
 * `ADVERSE_VOLUME_FLOOR` keeps ultra-thin baskets from under-pricing
 * the premium (which would otherwise tend toward infinity at 0 volume).
 */
function quoteSellFeesBpsFromBooks(
  usdcNotional: number,
  markets: Array<{ weight?: number; volumeUsd: number; tokenId: string }>,
  books: Map<string, Orderbook>,
): {
  protocolBps: number;
  mmSpreadBps: number;
  slippageBps: number;
  adverseBps: number;
  totalBps: number;
  hasLiveBooks: boolean;
} {
  const size = Math.max(0, usdcNotional);
  let slippageBps = 0;
  let coveredWeight = 0;
  let hasLiveBooks = false;

  if (markets.length > 0 && size > 0) {
    for (const m of markets) {
      const w = m.weight && m.weight > 0 ? m.weight : 1 / markets.length;
      const legSize = size * w;
      const book = m.tokenId ? books.get(m.tokenId) : undefined;
      if (book && book.bids.length > 0) {
        hasLiveBooks = true;
        const impact = quoteBidSideImpact(legSize, book);
        slippageBps += impact.slippageBps * w;
        coveredWeight += w;
      }
    }
  }

  // Fallback / residual coverage uses the same volume-proxy model as
  // the buy path. The model is size-driven and signs the impact as a
  // non-negative slippage — direction of flow doesn't change the
  // scaling, only the sign of the spread component (which we strip by
  // taking the absolute value inside the volume proxy).
  if (!hasLiveBooks) {
    slippageBps = volumeProxySlippageBps(size, markets);
  } else if (coveredWeight > 0 && coveredWeight < 1) {
    const proxy = volumeProxySlippageBps(
      size * (1 - coveredWeight),
      markets,
    );
    slippageBps = slippageBps + proxy * (1 - coveredWeight);
  }
  slippageBps = Math.max(1, Math.min(SLIPPAGE_BPS_CEILING, slippageBps));

  // Flow tilt (adverse selection) is folded into the desk line — lower
  // base + gentler sqrt curve than the old standalone adverse row.
  const totalVolume = markets.reduce(
    (s, m) => s + (m.volumeUsd ?? 0),
    0,
  );
  const volumeProxy = Math.max(ADVERSE_VOLUME_FLOOR, totalVolume);
  const flowTiltBps =
    SELL_ADVERSE_BPS_BASE +
    SELL_ADVERSE_SQRT_K * Math.sqrt(Math.max(0, size) / volumeProxy);
  const deskFlowBps = SELL_DESK_BASE_BPS + flowTiltBps;

  return {
    protocolBps: SELL_PROTOCOL_FEE_BPS,
    mmSpreadBps: deskFlowBps,
    slippageBps,
    adverseBps: 0,
    totalBps: SELL_PROTOCOL_FEE_BPS + deskFlowBps + slippageBps,
    hasLiveBooks,
  };
}

/**
 * Fallback slippage model when we don’t have (or can’t get) a live CLOB
 * snapshot. Three regimes:
 *
 *   1. Per-leg volume data available — use it. Depth proxy is 0.5% of
 *      lifetime Polymarket volume (conservative vs. the old 1% number;
 *      a market with $10M lifetime volume doesn’t actually have
 *      $100k resting at any given instant). Impact on each leg is
 *      linear + quadratic in (legSize / depth), weighted across legs.
 *
 *   2. Markets list provided but every leg has zero volume — collapse
 *      to regime 3.
 *
 *   3. Nothing at all (seed fallback) — size-only convex curve, tuned
 *      to match typical basket impact on Polymarket books. No 1.5%
 *      cap; the old cap meant that any order above ~$40k reported the
 *      same slippage, which is exactly the arb surface the user
 *      called out.
 *
 * All three regimes cap at SLIPPAGE_BPS_CEILING (100%) — a structural
 * maximum, not a business one.
 */
function volumeProxySlippageBps(
  size: number,
  markets: Array<{ weight?: number; volumeUsd: number }>,
): number {
  if (size <= 0) return 0;
  if (markets.length === 0) return sizeOnlySlippageBps(size);

  let weightTotal = 0;
  let weightedBps = 0;
  let anyVolume = false;
  for (const m of markets) {
    const w = m.weight && m.weight > 0 ? m.weight : 1 / markets.length;
    const vol = m.volumeUsd ?? 0;
    if (vol > 0) anyVolume = true;
    const legSize = size * w;
    if (legSize <= 0) continue;
    // Conservative depth proxy: 0.5% of lifetime volume, floor $250.
    // A leg with $10M lifetime volume gets a ~$50k depth proxy; that
    // matches what top-of-book liquidity typically looks like.
    const depth = Math.max(250, vol * 0.005);
    const ratio = legSize / depth;
    // Two-term impact curve:
    //   - Linear (1500 bp/unit) dominates while you’re inside top-of-
    //     book: crossing a 1-cent spread on a 50-cent market is ~100bp.
    //   - Quadratic (3500 bp/unit²) takes over once you’re eating
    //     multiple levels: price impact grows super-linearly because
    //     each new level is thinner than the last.
    // No per-leg cap — we want the basket-level ceiling, not a silent
    // flattener that under-reports oversized orders.
    const impactBps = ratio * 1500 + ratio * ratio * 3500;
    // Per-leg floor of 20 bp for any non-zero order: captures the half-
    // spread you pay just to cross from mid to the ask side. Without
    // this, a $100 order on a $100M basket reports ~0 slippage, which
    // is pure fiction — Polymarket books always cost *something* to
    // cross, and under-reporting it is the arb surface we’re closing.
    const legBps = Math.max(20, impactBps);
    weightedBps += legBps * w;
    weightTotal += w;
  }
  if (!anyVolume) return sizeOnlySlippageBps(size);
  return weightTotal > 0
    ? Math.min(SLIPPAGE_BPS_CEILING, weightedBps / weightTotal)
    : 0;
}

/**
 * Size-only convex slippage for the no-metadata path. Convexity matters
 * here for the same reason as the per-leg model: impact accelerates as
 * you force through thinner parts of the book. Calibration reference
 * points (with $1 = 1 unit of x):
 *
 *   $100     x=1      ≈ 23 bp  (0.23%)
 *   $1 000   x=10     ≈ 45 bp  (0.45%)
 *   $10 000  x=100    ≈ 270 bp (2.7%)
 *   $100 000 x=1000   ≈ 2520 bp (25%)
 *   $250 000 x=2500   ≈ 5520 bp (55%)
 *
 * Shape: base + linear + quadratic. No 1.5% cap — anything we report
 * should match or exceed what an external fill would cost, else the
 * protocol is systematically subsidising takers.
 */
function sizeOnlySlippageBps(size: number): number {
  const x = Math.max(0, size) / 100;
  const bps = 20 + x * 2 + x * x * 0.00085;
  return Math.min(SLIPPAGE_BPS_CEILING, bps);
}

type TradeMode = "buy" | "sell";

function BasketBuyPanel({
  bundle,
  accent,
  markets,
}: {
  bundle: Bundle;
  accent: string;
  markets: LiveMarket[];
}) {
  const { state, dispatch } = useSandbox();
  const wallet = useWalletSigner();
  const activeAddress = useActiveWalletAddress();
  const appConnected = wallet.connected;
  const usdc = useUsdcBalance();
  const [mode, setMode] = useState<TradeMode>("buy");
  const [amount, setAmount] = useState<string>("100");
  const [sellQtyInput, setSellQtyInput] = useState<string>("");
  const [books, setBooks] = useState<Map<string, Orderbook>>(new Map());
  const [bookStatus, setBookStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  // On-chain submission state — mirrors the prepare/sign/confirm lifecycle of
  // `depositIntoBundle`. `txError` is user-facing copy; `txSignature` drives
  // the Explorer link shown beneath the button on success.
  const [txStage, setTxStage] = useState<
    "idle" | "preparing" | "signing" | "confirming" | "persisting" | "done"
  >("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  // Actual tokens from the vault's issue_price_bps, set once prepare resolves.
  // Replaces the pre-estimate (tokensOut) which uses the stale DB NAV.
  const [confirmedTokensOut, setConfirmedTokensOut] = useState<number | null>(null);

  // Vault's on-chain issue price, fee, and state — declared here; effect
  // runs after resolvedBundleUuid is declared below.
  const [vaultIssuePrice, setVaultIssuePrice] = useState<number | null>(null);
  const [vaultFeeBps, setVaultFeeBps] = useState<number | null>(null);
  // "active" | "finalized" | "closed" | null — active uses early-exit,
  // finalized uses redeem payout.
  const [vaultState, setVaultState] = useState<
    "active" | "finalized" | "closed" | null
  >(null);

  // Top 10 weighted legs with a non-empty token id drive the live CLOB
  // snapshot. We skip legs without token ids (seed fallback, mostly).
  // 10 is a balance: enough to cover the majority of the basket’s NAV
  // weight, small enough that the fan-out to Polymarket's CLOB is
  // negligible + fits in one batch request.
  const topLegs = useMemo(() => {
    const withTokens = markets.filter((m) => m.tokenId);
    return [...withTokens]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, 10);
  }, [markets]);
  const topTokenIds = useMemo(
    () => topLegs.map((m) => m.tokenId),
    [topLegs],
  );

  // Fetch the live orderbooks on mount / whenever the top-leg set
  // changes. The backend caches 3s so this is cheap on tier / window
  // switches. AbortController guards against a resolved promise
  // stomping state after the component unmounts.
  useEffect(() => {
    if (topTokenIds.length === 0) {
      let cancelled = false;
      const id = window.setTimeout(() => {
        if (cancelled) return;
        setBooks(new Map());
        setBookStatus("idle");
      }, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(id);
      };
    }
    const ac = new AbortController();
    let cancelled = false;
    const id = window.setTimeout(() => {
      if (!cancelled) setBookStatus("loading");
    }, 0);
    fetchOrderbooks(topTokenIds, ac.signal)
      .then((map) => {
        if (cancelled) return;
        setBooks(map);
        setBookStatus(map.size > 0 ? "ok" : "error");
      })
      .catch(() => {
        if (cancelled) return;
        setBookStatus("error");
      });
    return () => {
      cancelled = true;
      window.clearTimeout(id);
      ac.abort();
    };
  }, [topTokenIds]);

  // Live NAV anchor: used for sell quotes and display. Sell side uses market
  // price; buy side uses vaultIssuePrice so the quote matches what the program mints.
  const navPrice = bundle.nav > 0 ? bundle.nav : 1;

  // ---- Buy quote ----------------------------------------------------
  const usdcAmount = Math.max(0, Number.parseFloat(amount) || 0);
  const fees = useMemo(
    () => quoteFeesBpsFromBooks(usdcAmount, topLegs, books),
    [usdcAmount, topLegs, books],
  );
  // `fees.totalBps` rolls protocol + MM + slippage estimates for the
  // breakdown UI, but only the vault's on-chain fee is actually taken
  // by `deposit` — MM / slippage fees are display-only liquidity
  // proxies. Use the real on-chain fee to compute `tokensOut` so the
  // "You receive" line matches what the chain mints down to the token.
  const chainFeeBps =
    vaultFeeBps !== null && vaultFeeBps >= 0
      ? vaultFeeBps
      : fees.totalBps;
  const netUsdc = usdcAmount * (1 - chainFeeBps / 10_000);
  // Token quote uses the product's **on-chain issue price** so the number
  // matches what the Sui write returns. Falls
  // back to live NAV until `vaultIssuePrice` resolves; tightens once
  // the useEffect below pulls it. Historically this used `navPrice`,
  // which systematically under-reported tokens whenever live NAV >
  // issue price -- the chain returned more units than the modal promised
  // and the surplus surfaced as stale "unrealized P&L" on the
  // portfolio.
  const tokensOut =
    netUsdc / (vaultIssuePrice && vaultIssuePrice > 0 ? vaultIssuePrice : navPrice);

  const hasAmount = usdcAmount > 0;
  const overCap = hasAmount && usdcAmount > MAX_ORDER_USDC;
  // `usdc.uiAmount` is the LIVE wallet balance polled from the chain.
  // We gate "Insufficient USDC" on the real balance so the CTA tells the
  // user the truth about their wallet, not a sandbox counter.
  const liveUsdc = usdc.uiAmount;
  const insufficient = appConnected && hasAmount && usdcAmount > liveUsdc;
  const txBusy =
    txStage === "preparing" ||
    txStage === "signing" ||
    txStage === "confirming" ||
    txStage === "persisting";

  // ---- Sell quote ---------------------------------------------------
  //
  // Sell semantics: user inputs a token quantity (PBU). The MM buys
  // the tokens back, marks-to-market at `qty × navPrice`, and charges
  // protocol + MM fees + bid-side slippage + adverse-selection premium
  // against that notional. `payoutUsdc` is what the user actually
  // receives after fees. The Sui redeem path closes the local position;
  // `sellQty` is still
  // used for the UI quote and the sandbox reducer's optimistic update.
  //
  // `heldQty` used to read from `state.basketPositions` (the in-memory
  // sandbox reducer), which is empty for any fresh wallet that has
  // deposited only via the real Sui flow. That made the Sell tab
  // always show "HELD 0.00 PBU" and the button say "No position to
  // sell" even when the user genuinely held tokens. Now we resolve the
  // UI basket id (which can be a synthetic "PBU-HIGH-SHORT" that
  // routes to a backend bundle at buy time) to the same backend UUID the
  // deposit flow uses, then look up the Sui PBU balance for that
  // bundle via `usePbuBalances()`. `state.basketPositions` is still
  // consulted for `avgCost` because that's the only place entry price
  // is tracked in-session.
  const pbuBalances = usePbuBalances();
  const [resolvedBundleUuid, setResolvedBundleUuid] = useState<string | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    resolveBundleUuid(bundle.id)
      .then((uuid) => {
        if (!cancelled) setResolvedBundleUuid(uuid);
      })
      .catch(() => {
        if (!cancelled) setResolvedBundleUuid(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bundle.id]);

  // Fetch vault's on-chain issue price, fee, and state once the UUID is known.
  useEffect(() => {
    if (!resolvedBundleUuid) return;
    fetchVaultPrice(resolvedBundleUuid).then((r) => {
      if (r) {
        setVaultIssuePrice(r.issue_price);
        setVaultFeeBps(r.fee_bps);
        const vs = r.vault_state;
        setVaultState(
          vs === "active" || vs === "finalized" || vs === "closed" ? vs : null,
        );
      }
    });
  }, [resolvedBundleUuid]);

  const onchainHeldQty =
    resolvedBundleUuid
      ? pbuBalances.balances.find((b) => b.bundleId === resolvedBundleUuid)
          ?.uiAmount ?? 0
      : 0;
  const suiHeldQty = groupVirtualByUiBundle(activeAddress)
    .filter((g) => g.uiBundleId === bundle.id)
    .reduce((sum, g) => sum + g.tokens, 0);
  const existingPosition = state.basketPositions.find(
    (p) => p.bundleId === bundle.id,
  );
  const heldQty = suiHeldQty || onchainHeldQty;
  const sellQty = Math.max(0, Number.parseFloat(sellQtyInput) || 0);
  // Use cost-basis per token for sell quotes so the displayed "You
  // receive" matches what `exit_active` actually pays out (pro-rata
  // share of the USDC pool, which ≈ issue_price per token for a vault
  // with uniform deposits). Previously this used `navPrice`, which
  // over-quoted the payout by the NAV-vs-issue-price spread and left
  // the user confused when they got ~$5 less than the modal promised.
  // Falls back to navPrice only if we haven't hydrated a cost basis yet.
  const costPerToken =
    existingPosition && existingPosition.avgCost > 0
      ? existingPosition.avgCost
      : vaultIssuePrice && vaultIssuePrice > 0
        ? vaultIssuePrice
        : navPrice;
  const sellUsdcNotional = sellQty * costPerToken;
  const sellFees = useMemo(
    () => quoteSellFeesBpsFromBooks(sellUsdcNotional, topLegs, books),
    [sellUsdcNotional, topLegs, books],
  );
  // `sellFees.totalBps` is the display-only MM/slippage/protocol mix;
  // Sui settlement only applies the flat early-exit fee (`EARLY_EXIT_FEE_BPS`,
  // 30 bps) is actually deducted. Use that for the realistic net payout
  // the user will see in their wallet.
  const EARLY_EXIT_FEE_BPS = 30;
  const sellPayoutUsdc = sellUsdcNotional * (1 - EARLY_EXIT_FEE_BPS / 10_000);
  const hasSellQty = sellQty > 0;
  const sellOverPosition = hasSellQty && sellQty > heldQty + 1e-6;
  const sellOverCap = hasSellQty && sellUsdcNotional > MAX_ORDER_USDC;

  const canBuy =
    appConnected && hasAmount && !insufficient && !overCap && !txBusy;
  // Active vaults use on-chain `exit_active` (pool pro-rata); finalized uses `redeem`.
  const canSell =
    appConnected &&
    hasSellQty &&
    !sellOverPosition &&
    !sellOverCap &&
    heldQty > 0 &&
    !txBusy &&
    vaultState !== "closed";

  // ---- Submit -------------------------------------------------------
  //
  // Both Buy and Sell run through the Sui deposit-client helpers. The
  // sandbox dispatch fires only after the Sui write confirms, so the portfolio card
  // mirrors authoritative state (not a simulation).
  async function handlePrimary() {
    if (mode === "buy") {
      if (!canBuy) return;
      setTxError(null);
      setTxSignature(null);
      setConfirmedTokensOut(null);
      setTxStage("preparing");
      try {
        const result = await depositIntoBundle({
          wallet,
          bundleId: bundle.id,
          amountUsdc: usdcAmount,
          // Use vault issue price as cost basis so portfolio PnL starts at 0.
          navAtDeposit: navPrice,   // cost basis = live Polymarket NAV shown in UI
          onStage: (s) => setTxStage(s),
        });
        // Use the vault-authoritative token count, not the pre-estimate.
        const actualTokens = result.prepare.tokens_minted;
        setConfirmedTokensOut(actualTokens);
        setTxStage("done");
        setTxSignature(result.signature);
        dispatch({
          type: "basket/deposit",
          bundleId: bundle.id,
          usdcAmount,
          nav: navPrice,
          tokensOut: actualTokens,
        });
        void usdc.refresh();
        void pbuBalances.refresh();
      } catch (err) {
        setTxStage("idle");
        setTxError(err instanceof DepositError ? err.message : friendlyWalletError(err));
      }
    } else {
      if (!canSell) return;
      setTxError(null);
      setTxSignature(null);
      setTxStage("preparing");
      try {
        const result = await redeemFromBundle({
          wallet,
          bundleId: bundle.id,
          // Pass quantity so partial redeems work correctly on-chain.
          amountTokens: sellQty > 0 ? sellQty : undefined,
          onStage: (s) => setTxStage(s),
        });
        setTxStage("done");
        setTxSignature(result.signature);
        dispatch({
          type: "basket/redeem",
          bundleId: bundle.id,
          qty: sellQty,
          payoutUsdc: result.prepare.expected_usdc,
        });
        setSellQtyInput("");
        void usdc.refresh();
        void pbuBalances.refresh();
      } catch (err) {
        setTxStage("idle");
        setTxError(err instanceof DepositError ? err.message : friendlyWalletError(err));
      }
    }
  }

  const buttonLabel =
    mode === "buy"
      ? !hasAmount
        ? "Enter an amount"
        : overCap
          ? `Max $${MAX_ORDER_USDC.toLocaleString()} per order`
          : insufficient
            ? "Insufficient USDC"
            : txStage === "preparing"
              ? "Preparing transaction…"
              : txStage === "signing"
                  ? "Awaiting wallet signature…"
                : txStage === "confirming"
                  ? "Confirming on Sui…"
                  : txStage === "persisting"
                    ? "Finalising…"
                    : txStage === "done"
                      ? "✓ Position opened"
                      : "Buy position"
      : txStage === "done"
        ? "✓ Position redeemed"
        : !hasSellQty
        ? "Enter a quantity"
        : sellOverCap
          ? `Max $${MAX_ORDER_USDC.toLocaleString()} per redemption`
          : appConnected && heldQty <= 0
            ? "No position to sell"
            : appConnected && sellOverPosition
              ? "Exceeds held position"
              : txStage === "preparing"
                ? "Preparing redeem…"
                : txStage === "signing"
                  ? "Awaiting wallet signature…"
                : txStage === "confirming"
                  ? "Confirming on Sui…"
                    : txStage === "persisting"
                      ? "Finalising…"
                      : "Sell position";

  // Sell button follows the same simulate-first pattern as Buy: users
  // without a wallet can still click it to open the wallet picker
  // (`handlePrimary` handles the `!connected` branch). Position +
  // balance checks only block the click once the wallet is connected.
  const buttonActive =
    mode === "buy"
      ? hasAmount &&
        !insufficient &&
        !overCap &&
        !txBusy &&
        txStage !== "done"
      : hasSellQty &&
        !sellOverCap &&
        !txBusy &&
        txStage !== "done" &&
        (!appConnected || (heldQty > 0 && !sellOverPosition));

  return (
    <div
      className="basket-buy-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: 24,
        height: "100%",
        minHeight: 520,
        background: C.card,
        border: `0.5px solid ${C.border}`,
        borderRadius: 14,
        padding: "22px 22px 24px",
      }}
    >
      {/* ---- Trade section (Buy / Sell tabs) ---- */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          style={{
            fontFamily: FD,
            fontSize: 17,
            fontWeight: 500,
            color: C.textPrimary,
            letterSpacing: "-0.005em",
            textAlign: "center",
          }}
        >
          {mode === "buy" ? `Buy ${bundle.id}` : `Sell ${bundle.id}`}
        </div>
        <div
          style={{
            fontFamily: FS,
            fontSize: 12,
            color: C.textSecondary,
            lineHeight: 1.5,
            textAlign: "center",
            fontWeight: 300,
          }}
        >
          {bundle.totalLegs}-leg basket at ${navPrice.toFixed(3)}
        </div>

        {/* Buy / Sell segmented control */}
        <div
          role="tablist"
          aria-label="Trade direction"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 4,
            padding: 3,
            background: C.surface,
            border: `0.5px solid ${C.border}`,
            borderRadius: 10,
          }}
        >
          {(["buy", "sell"] as const).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (m === mode) return;
                  setMode(m);
                  // Clear per-transaction state when switching tabs so a
                  // freshly-successful Buy doesn't leave Sell stuck on
                  // "Position redeemed" (and vice-versa). The underlying
                  // position stays in reducer state / on-chain, so this
                  // is purely cosmetic UI reset. In-flight transactions
                  // are rare at this moment (the buttons are disabled
                  // during them) but safe to clear either way — the
                  // on-chain tx keeps running and portfolio hydration
                  // will catch it on the next poll.
                  setTxStage("idle");
                  setTxError(null);
                  setTxSignature(null);
                  setConfirmedTokensOut(null);
                }}
                style={{
                  padding: "8px 0",
                  borderRadius: 7,
                  border: "none",
                  background: active ? `${accent}22` : "transparent",
                  color: active ? accent : C.textSecondary,
                  fontFamily: FD,
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  letterSpacing: "0.04em",
                  textTransform: "capitalize",
                  cursor: "pointer",
                  transition: `color 0.15s ${EASE}, background 0.15s ${EASE}`,
                }}
              >
                {m}
              </button>
            );
          })}
        </div>

        {mode === "buy" ? (
          <BuySection
            connected={appConnected}
            amount={amount}
            setAmount={(v) => { setAmount(v); setConfirmedTokensOut(null); }}
            usdcAmount={usdcAmount}
            // Pass the LIVE on-chain USDC balance to the "Available" label.
            // We used to pass `state.usdc` (the in-memory sandbox counter),
            // which read $0.00 for every fresh tester and made the panel
            // look broken. `liveUsdc` is polled every 12 s from chain.
            stateUsdc={liveUsdc}
            fees={fees}
            tokensOut={tokensOut}
            confirmedTokensOut={confirmedTokensOut}
            vaultIssuePrice={vaultIssuePrice}
            vaultFeeBps={vaultFeeBps}
            accent={accent}
            bookStatus={bookStatus}
            topLegCount={topLegs.length}
            hasAmount={hasAmount}
            unitLabel={bundle.id}
          />
        ) : (
          <SellSection
            connected={appConnected}
            heldQty={heldQty}
            avgCost={existingPosition?.avgCost ?? 0}
            navPrice={navPrice}
            vaultState={vaultState}
            sellQtyInput={sellQtyInput}
            setSellQtyInput={setSellQtyInput}
            sellQty={sellQty}
            sellUsdcNotional={sellUsdcNotional}
            sellFees={sellFees}
            sellPayoutUsdc={sellPayoutUsdc}
            sellOverPosition={sellOverPosition}
            accent={accent}
            bookStatus={bookStatus}
            topLegCount={topLegs.length}
            unitLabel={bundle.id}
          />
        )}

        {/* Secondary-market exit: the protocol market-maker quotes a simulated
            bid (per-product spread below par) for the held position; accepting
            it records the exit to History. No on-chain MM rail on Sui. */}
        {mode === "sell" && (
          <MmDeskBid
            productType="basket"
            bundleId={bundle.id}
            walletAddress={activeAddress || null}
            sizeUsdc={heldQty}
            disabled={!appConnected}
            onSold={() => {
              if (activeAddress && resolvedBundleUuid) {
                clearVirtualPositionsByUiBundleId(activeAddress, resolvedBundleUuid, bundle.id);
              }
              setSellQtyInput("");
              void usdc.refresh();
            }}
          />
        )}

        {/* Single primary action. Wallet connection is implicit: the
            button triggers the picker only when the user actually tries
            to submit. No "Connect Wallet" label in sight until needed. */}
        {!appConnected ? (
          // Disconnected: open the wallet picker on click (instead of a silent
          // no-op). Once connected, the real Buy/Sell button renders.
          <ConnectModal
            trigger={
              <button
                type="button"
                style={{
                  width: "100%",
                  height: 44,
                  padding: "0 16px",
                  borderRadius: 10,
                  border: "none",
                  background: `linear-gradient(135deg, ${accent} 0%, ${accent}dd 100%)`,
                  color: "#001814",
                  fontFamily: FD,
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  cursor: "pointer",
                  boxShadow: `0 10px 24px ${accent}33, inset 0 0 0 1px ${accent}55`,
                }}
              >
                Connect a wallet to {mode === "buy" ? "buy" : "sell"}
              </button>
            }
          />
        ) : (
          <button
            type="button"
            onClick={handlePrimary}
            disabled={!buttonActive}
            style={{
              width: "100%",
              height: 44,
              padding: "0 16px",
              borderRadius: 10,
              border: "none",
              background: buttonActive
                ? `linear-gradient(135deg, ${accent} 0%, ${accent}dd 100%)`
                : `${accent}22`,
              color: buttonActive ? "#001814" : C.textMuted,
              fontFamily: FD,
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: "0.04em",
              cursor: buttonActive ? "pointer" : "not-allowed",
              transition: `transform 0.15s ${EASE}, box-shadow 0.15s ${EASE}`,
              boxShadow: buttonActive
                ? `0 10px 24px ${accent}33, inset 0 0 0 1px ${accent}55`
                : "none",
            }}
            onMouseEnter={(e) => {
              if (!buttonActive) return;
              (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
            }}
          >
            {buttonLabel}
          </button>
        )}

        {/* Tx result strip: error toast on failure / rejection, or a
            network-aware explorer link on success. We surface the signature
            inline so on-chain movement is verifiable without losing basket
            context. */}
        {txError && (
          <div
            style={{
              fontFamily: FM,
              fontSize: 11,
              lineHeight: 1.45,
              color: "#ff8570",
              background: "rgba(255, 90, 70, 0.08)",
              border: "0.5px solid rgba(255, 90, 70, 0.35)",
              borderRadius: 8,
              padding: "8px 12px",
              letterSpacing: "0.02em",
              fontWeight: 400,
            }}
          >
            {txError}
          </div>
        )}
        {txSignature && (
          <a
            href={explorerTxUrl(txSignature)}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: FM,
              fontSize: 11,
              color: accent,
              background: `${accent}14`,
              border: `0.5px solid ${accent}55`,
              borderRadius: 8,
              padding: "8px 12px",
              letterSpacing: "0.02em",
              fontWeight: 500,
              textAlign: "center",
              textDecoration: "none",
            }}
          >
            View on Sui Explorer ↗
          </a>
        )}
      </div>

      {/* ---- How it works ---- */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontFamily: FM,
              fontSize: 10,
              letterSpacing: "0.18em",
              color: C.textMuted,
              fontWeight: 500,
              textTransform: "uppercase",
            }}
          >
            How it works
          </span>
          <span style={{ flex: 1, height: 1, background: C.border }} />
        </div>
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {HOW_IT_WORKS.map((step) => (
            <li
              key={step.num}
              style={{
                display: "grid",
                gridTemplateColumns: "24px 1fr",
                columnGap: 12,
                rowGap: 3,
                alignItems: "baseline",
              }}
            >
              <div
                style={{
                  fontFamily: FM,
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: "0.1em",
                  color: accent,
                  paddingTop: 2,
                  opacity: 0.85,
                }}
              >
                {step.num}
              </div>
              <div
                style={{
                  fontFamily: FD,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: C.textPrimary,
                  letterSpacing: "-0.002em",
                }}
              >
                {step.title}
              </div>
              <div />
              <div
                style={{
                  fontFamily: FS,
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  color: C.textMuted,
                  fontWeight: 300,
                }}
              >
                {step.body}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * BUY side of the trade panel. Amount in USDC, tokens-out at the live
 * NAV after protocol + MM fees + slippage. Pure presentational: the
 * parent panel owns all state and dispatch, we just render the inputs
 * and fee breakdown.
 */
function BuySection({
  connected,
  unitLabel,
  amount,
  setAmount,
  usdcAmount,
  stateUsdc,
  fees,
  tokensOut,
  confirmedTokensOut,
  vaultIssuePrice,
  vaultFeeBps,
  accent,
  bookStatus,
  topLegCount,
  hasAmount,
}: {
  connected: boolean;
  unitLabel: string;
  amount: string;
  setAmount: (v: string) => void;
  usdcAmount: number;
  stateUsdc: number;
  fees: {
    protocolBps: number;
    mmSpreadBps: number;
    slippageBps: number;
    hasLiveBooks: boolean;
  };
  tokensOut: number;
  confirmedTokensOut: number | null;
  vaultIssuePrice: number | null;
  vaultFeeBps: number | null;
  accent: string;
  bookStatus: "idle" | "loading" | "ok" | "error";
  topLegCount: number;
  hasAmount: boolean;
}) {
  return (
    <>
      <div
        style={{
          background: C.surface,
          border: `0.5px solid ${C.border}`,
          borderRadius: 12,
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            fontFamily: FM,
            fontSize: 10,
            letterSpacing: "0.14em",
            color: C.textMuted,
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          <span>Amount</span>
          {connected && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span>
                Balance{" "}
                <span style={{ color: C.textSecondary }}>
                  {stateUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
                </span>
              </span>
              {stateUsdc > 0 && (
                <button
                  type="button"
                  onClick={() => setAmount(String(Math.floor(Math.min(stateUsdc, MAX_ORDER_USDC) * 100) / 100))}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    border: `0.5px solid ${C.border}`,
                    background: C.tealBg,
                    color: C.tealLight,
                    fontFamily: FM,
                    fontSize: 9.5,
                    letterSpacing: "0.08em",
                    cursor: "pointer",
                  }}
                >
                  MAX
                </button>
              )}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: C.textPrimary,
              fontFamily: FD,
              fontSize: 22,
              fontWeight: 400,
              letterSpacing: "-0.01em",
              padding: 0,
            }}
          />
          <span
            style={{
              fontFamily: FM,
              fontSize: 11,
              color: C.textSecondary,
              letterSpacing: "0.06em",
              fontWeight: 400,
            }}
          >
            USDC
          </span>
        </div>
      </div>

      {hasAmount && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "10px 14px",
            background: C.surface,
            borderRadius: 10,
            border: `0.5px solid ${C.border}`,
          }}
        >
          <FeeRow
            label="Protocol fee"
            bps={fees.protocolBps}
            usd={(usdcAmount * fees.protocolBps) / 10_000}
          />
          <FeeRow
            label="Market-maker fees"
            bps={fees.mmSpreadBps}
            usd={(usdcAmount * fees.mmSpreadBps) / 10_000}
          />
          <FeeRow
            label="Slippage"
            bps={fees.slippageBps}
            usd={(usdcAmount * fees.slippageBps) / 10_000}
            hint="scales with order size"
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: FM,
              fontSize: 11,
              color: C.textSecondary,
              fontWeight: 500,
              borderTop: `0.5px solid ${C.border}`,
              paddingTop: 8,
              marginTop: 2,
              letterSpacing: "0.02em",
            }}
          >
            <span>You receive</span>
            <span style={{ color: accent, fontWeight: 600 }}>
              {tokensOut.toFixed(2)} {unitLabel}
            </span>
          </div>
          <div
            style={{
              fontFamily: FS,
              fontSize: 10,
              color: C.textMuted,
              letterSpacing: "0.02em",
              fontWeight: 300,
              marginTop: 2,
            }}
          >
            {bookStatus === "loading"
              ? "Quoting slippage from live Polymarket books…"
              : fees.hasLiveBooks
                ? `Slippage quoted live from Polymarket CLOB (${topLegCount} legs sampled).`
                : bookStatus === "error"
                  ? "CLOB feed unavailable. Slippage estimated from leg volume."
                  : "Slippage estimated from leg volume. Live book kicks in once a wallet connects."}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * SELL side of the trade panel. Quantity in PBU (with a Max fill from
 * the held position), USDC-out at the live NAV minus protocol + MM fees
 * + bid-side slippage + adverse-selection premium.
 *
 * The section is ALWAYS simulatable — matching the Buy tab's behaviour.
 * Users without a wallet or without a position still see the quote UI
 * and live fee breakdown; the primary button (owned by the parent
 * panel) is what routes them to either the wallet modal or a disabled
 * "No position to sell" state. Keeping the inputs visible lets users
 * explore redemption pricing before they ever connect.
 */
function SellSection({
  connected,
  unitLabel,
  heldQty,
  avgCost,
  navPrice,
  vaultState,
  sellQtyInput,
  setSellQtyInput,
  sellQty,
  sellUsdcNotional,
  sellFees,
  sellPayoutUsdc,
  sellOverPosition,
  accent,
  bookStatus,
  topLegCount,
}: {
  connected: boolean;
  unitLabel: string;
  heldQty: number;
  avgCost: number;
  navPrice: number;
  vaultState: "active" | "finalized" | "closed" | null;
  sellQtyInput: string;
  setSellQtyInput: (v: string) => void;
  sellQty: number;
  sellUsdcNotional: number;
  sellFees: {
    protocolBps: number;
    mmSpreadBps: number;
    slippageBps: number;
    adverseBps: number;
    hasLiveBooks: boolean;
  };
  sellPayoutUsdc: number;
  sellOverPosition: boolean;
  accent: string;
  bookStatus: "idle" | "loading" | "ok" | "error";
  topLegCount: number;
}) {
  const hasPosition = heldQty > 0;
  // Only show unrealized PnL when we actually have a cost basis. A real on-chain
  // deposit has no in-session avgCost (avgCost === 0), and `heldQty * navPrice`
  // would then render the WHOLE position value as a bogus gain.
  const hasCostBasis = hasPosition && avgCost > 0;
  const unrealized = hasCostBasis ? heldQty * (navPrice - avgCost) : 0;
  return (
    <>
      <div
        style={{
          background: C.surface,
          border: `0.5px solid ${C.border}`,
          borderRadius: 12,
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            flexWrap: "wrap",
            gap: "4px 16px",
            fontFamily: FM,
            fontSize: 10,
            letterSpacing: "0.14em",
            color: C.textMuted,
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          <span style={{ whiteSpace: "nowrap" }}>Quantity</span>
          {connected && (
            <span
              style={{
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "baseline",
                gap: 8,
              }}
            >
              <span>Held</span>
              <span style={{ color: C.textSecondary }}>
                {heldQty.toFixed(2)} {unitLabel}
              </span>
              {hasCostBasis && (
                <span style={{ color: unrealized >= 0 ? accent : C.red }}>
                  {unrealized >= 0 ? "+" : ""}${unrealized.toFixed(2)}
                </span>
              )}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <input
            inputMode="decimal"
            value={sellQtyInput}
            onChange={(e) =>
              setSellQtyInput(e.target.value.replace(/[^0-9.]/g, ""))
            }
            placeholder="0.00"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: sellOverPosition ? C.red : C.textPrimary,
              fontFamily: FD,
              fontSize: 22,
              fontWeight: 400,
              letterSpacing: "-0.01em",
              padding: 0,
            }}
          />
          <button
            type="button"
            disabled={!hasPosition}
            onClick={() =>
              hasPosition &&
              setSellQtyInput((Math.floor(heldQty * 1_000_000) / 1_000_000).toFixed(6))
            }
            style={{
              background: hasPosition
                ? `${accent}22`
                : "rgba(255,255,255,0.04)",
              border: `1px solid ${
                hasPosition ? `${accent}55` : "rgba(255,255,255,0.08)"
              }`,
              color: hasPosition ? accent : C.textMuted,
              borderRadius: 6,
              padding: "4px 10px",
              fontFamily: FM,
              fontSize: 10,
              letterSpacing: "0.1em",
              fontWeight: 600,
              cursor: hasPosition ? "pointer" : "not-allowed",
            }}
          >
            MAX
          </button>
          <span
            style={{
              fontFamily: FM,
              fontSize: 11,
              color: C.textSecondary,
              letterSpacing: "0.06em",
              fontWeight: 400,
              marginLeft: 4,
            }}
          >
            {unitLabel}
          </span>
        </div>
      </div>

      {sellQty > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "10px 14px",
            background: C.surface,
            borderRadius: 10,
            border: `0.5px solid ${C.border}`,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: FM,
              fontSize: 11,
              color: C.textSecondary,
              letterSpacing: "0.02em",
              fontWeight: 400,
              marginBottom: 2,
            }}
          >
            <span>Mid notional</span>
            <span style={{ color: C.textPrimary, fontFamily: FM }}>
              ${sellUsdcNotional.toFixed(2)}
            </span>
          </div>
          <FeeRow
            label="Protocol fee"
            bps={sellFees.protocolBps}
            usd={(sellUsdcNotional * sellFees.protocolBps) / 10_000}
          />
          <FeeRow
            label="Desk & flow (incl. adverse)"
            bps={sellFees.mmSpreadBps}
            usd={(sellUsdcNotional * sellFees.mmSpreadBps) / 10_000}
            hint="MM + informed-flow tilt (combined)"
          />
          <FeeRow
            label="Slippage (bid side)"
            bps={sellFees.slippageBps}
            usd={(sellUsdcNotional * sellFees.slippageBps) / 10_000}
            hint="live CLOB walk"
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: FM,
              fontSize: 11,
              color: C.textSecondary,
              fontWeight: 500,
              borderTop: `0.5px solid ${C.border}`,
              paddingTop: 8,
              marginTop: 2,
              letterSpacing: "0.02em",
            }}
          >
            <span>You receive</span>
            <span style={{ color: accent, fontWeight: 600 }}>
              ${sellPayoutUsdc.toFixed(2)}
            </span>
          </div>
          <div
            style={{
              fontFamily: FS,
              fontSize: 10,
              color: C.textMuted,
              letterSpacing: "0.02em",
              fontWeight: 300,
              marginTop: 2,
            }}
          >
            {vaultState === "active"
              ? "Early exit settles on-chain as your pro-rata share of the vault USDC pool (plus a 0.30% combined exit fee). The “You receive” line is a NAV-based retail estimate; the signed transaction uses the pool ratio."
              : bookStatus === "loading"
                ? "Quoting redemption impact from live Polymarket books…"
                : sellFees.hasLiveBooks
                  ? `Redemption slippage quoted live from ${topLegCount} CLOB legs. Desk & flow scales with size vs. basket volume.`
                  : "CLOB feed unavailable. Slippage estimated from leg volume."}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Single line in the cost breakdown. `bps` is shown as a percentage with
 * adaptive precision; `usd` is the dollar equivalent for the current
 * order size. `hint` is an optional subtitle (used to flag the slippage
 * row as size-dependent).
 */
function FeeRow({
  label,
  bps,
  usd,
  hint,
}: {
  label: string;
  bps: number;
  usd: number;
  hint?: string;
}) {
  const pctText = bps >= 100 ? `${(bps / 100).toFixed(2)}%` : `${(bps / 100).toFixed(3)}%`;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
      <span
        style={{
          fontFamily: FS,
          fontSize: 11.5,
          color: C.textSecondary,
          fontWeight: 300,
          letterSpacing: "0.01em",
        }}
      >
        {label}
        {hint && (
          <span
            style={{
              fontFamily: FS,
              fontSize: 10,
              color: C.textMuted,
              marginLeft: 6,
              fontWeight: 300,
            }}
          >
            {hint}
          </span>
        )}
      </span>
      <span
        style={{
          fontFamily: FM,
          fontSize: 11,
          color: C.textSecondary,
          letterSpacing: "0.02em",
          fontWeight: 400,
        }}
      >
        {pctText}
        <span style={{ color: C.textMuted, marginLeft: 6 }}>
          ${usd.toFixed(2)}
        </span>
      </span>
    </div>
  );
}

/* ---------- Constituents ---------- */

// Constituents shown on the detail page. We sort by weight desc and only
// surface the top slice — baskets can be 100+ legs, and the top few are
// what dominate the weighted NAV anyway.
const TOP_CONSTITUENTS = 5;

function ConstituentTable({
  markets,
  tierColor,
}: {
  markets: LiveMarket[];
  tierColor: string;
}) {
  // Sort by weight descending — mirrors an index fund where the largest
  // positions surface first. Break ties by volume so the most liquid
  // markets win within a weight tier.
  const sorted = useMemo(
    () =>
      [...markets].sort(
        (a, b) =>
          (b.weight ?? 0) - (a.weight ?? 0) ||
          b.volumeUsd - a.volumeUsd,
      ),
    [markets],
  );
  // Show the top legs by weight (liquidity-weighted) — the basket holds the full
  // de-correlated roster, but the table surfaces only the most material positions.
  const rows = sorted.slice(0, TOP_CONSTITUENTS);
  const weightCovered = rows.reduce((s, m) => s + (m.weight ?? 0), 0);

  return (
    <div
      style={{
        background: C.card,
        border: `0.5px solid ${C.border}`,
        borderRadius: 14,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "14px 20px",
          borderBottom: `0.5px solid ${C.border}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: C.textMuted,
            fontFamily: FM,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          Top {rows.length} of {sorted.length} ·{" "}
          {(weightCovered * 100).toFixed(0)}% of basket
        </div>
        <div
          style={{
            fontFamily: FM,
            fontSize: 11,
            color: C.textSecondary,
            letterSpacing: "0.06em",
          }}
        >
          live from polymarket
        </div>
      </div>
      {/* Horizontally-scrollable container so the header row and the data
          rows scroll together and stay aligned on narrow viewports — the
          fixed-min grid would otherwise clip the right columns (Resolves,
          arrow) with no way to reach them. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflowX: "auto",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "28px 80px minmax(200px, 1fr) 70px 74px 90px 80px 32px",
            minWidth: 738,
            alignItems: "center",
            padding: "10px 20px",
            borderBottom: `0.5px solid ${C.border}`,
            fontFamily: FM,
            fontSize: 10,
            letterSpacing: "0.12em",
            color: C.textMuted,
            textTransform: "uppercase",
            columnGap: 12,
          }}
        >
          <div>#</div>
          <div>Category</div>
          <div>Question</div>
          <div style={{ textAlign: "right" }}>Weight</div>
          <div style={{ textAlign: "right" }}>Prob</div>
          <div style={{ textAlign: "right" }}>Volume</div>
          <div style={{ textAlign: "right" }}>Resolves</div>
          <div />
        </div>
        {/* Top-5 body at natural height — no internal scroll/fill needed. */}
        <div style={{ minWidth: 738 }}>
          {rows.map((m, i) => (
            <ConstituentRow
              key={m.id}
              index={i + 1}
              market={m}
              tierColor={tierColor}
              isLast={i === rows.length - 1}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Responsive detail chart ----------
 *
 * The chart is driven by a single `history` array (365 most-recent daily
 * NAV points ending at `currentNav`). The range picker above the chart
 * slices the tail of this array — we never re-synthesize data — so
 * switching ranges is instant, deterministic, and can't introduce
 * jitter between renders.
 *
 * Why the data pipeline looks the way it does:
 *   • Catmull-Rom → cubic Bezier produces a genuinely smooth line even
 *     on 7D (few points); the old quadratic-midpoint path would kink on
 *     sharp direction changes.
 *   • The y-axis auto-scales per slice with a small visual pad so tight
 *     series (e.g. +–0.3% over 7 days) still have breathing room and
 *     don't render as a hairline at the plot baseline.
 *   • `niceTicks` rounds the tick values to 1–2/5 of the nearest
 *     power-of-ten so the axis labels read as "94%, 95%, 96%" rather
 *     than "93.74%, 95.11%, 96.48%".
 *   • X-axis labels collapse to 3 points (range start / midpoint /
 *     "Now") — this is enough orientation without crowding on narrow
 *     viewports.
 */

type ChartRange = "1H" | "1D" | "7D" | "30D" | "6M" | "1Y";
type ChartSource = "hour" | "day" | "year";

const CHART_RANGES: Array<{
  key: ChartRange;
  label: string;        // compact pill label ("1H", "1D", ...)
  longLabel: string;    // prose form for the header ("1 hour", "24 hour", ...)
  totalMinutes: number; // total timespan rendered, used for x-axis labels
  source: ChartSource;  // which of the three history arrays to slice from
  points: number;       // desired slice length from `source` (tail-most)
}> = [
  { key: "1H",  label: "1H",  longLabel: "1 hour",   totalMinutes: 60,             source: "hour", points: 60 },
  { key: "1D",  label: "1D",  longLabel: "24 hour",  totalMinutes: 60 * 24,        source: "day",  points: 288 },
  { key: "7D",  label: "7D",  longLabel: "7 day",    totalMinutes: 60 * 24 * 7,    source: "year", points: 7 },
  { key: "30D", label: "30D", longLabel: "30 day",   totalMinutes: 60 * 24 * 30,   source: "year", points: 30 },
  { key: "6M",  label: "6M",  longLabel: "6 month",  totalMinutes: 60 * 24 * 180,  source: "year", points: 180 },
  { key: "1Y",  label: "1Y",  longLabel: "1 year",   totalMinutes: 60 * 24 * 365,  source: "year", points: 365 },
];

function DetailChart({
  history,
  dayHistory,
  hourHistory,
  color,
  currentNav,
}: {
  history: number[];
  dayHistory: number[];
  hourHistory: number[];
  color: string;
  currentNav: number;
}) {
  const [range, setRange] = useState<ChartRange>("1D");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 700, h: 180 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.max(160, Math.floor(e.contentRect.width));
        setSize((prev) => (prev.w === w ? prev : { ...prev, w }));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activeRange = CHART_RANGES.find((r) => r.key === range) ?? CHART_RANGES[1];

  // Pick the right source array per range so 1H doesn't try to slice 60
  // minutes out of a daily-resolution array (which would give one point).
  // Guard against any source that came in empty by falling back to the
  // year-resolution series.
  const data = useMemo(() => {
    const pickSource = (): number[] => {
      if (activeRange.source === "hour" && hourHistory.length > 0) return hourHistory;
      if (activeRange.source === "day" && dayHistory.length > 0) return dayHistory;
      return history;
    };
    const source = pickSource();
    if (source.length === 0) return [] as number[];
    const want = Math.min(source.length, activeRange.points + 1);
    return source.slice(-want);
  }, [activeRange, history, dayHistory, hourHistory]);

  // The x-axis is labelled in wall-clock terms, not "days ago", so the
  // label formatter needs to know the full span — not the number of
  // rendered points (which for 1D is 288 but represents 24 hours).
  const totalMinutes = activeRange.totalMinutes;

  const W = size.w;
  const H = size.h;
  const padL = 6;
  const padR = 58; // room for y-axis label gutter
  const padT = 14;
  const padB = 26; // room for x-axis labels
  const plotW = Math.max(1, W - padL - padR);
  const plotH = Math.max(1, H - padT - padB);

  const headerLabel = `NAV · ${activeRange.longLabel}`;

  // Render the framing chrome even when we have <2 data points so the
  // range picker doesn't disappear on first paint.
  if (data.length < 2) {
    return (
      <>
        <ChartHeader
          label={headerLabel}
          currentNav={currentNav}
          range={range}
          onRangeChange={setRange}
        />
        <div ref={wrapRef} style={{ width: "100%", height: H }} />
      </>
    );
  }

  const rawMin = Math.min(...data);
  const rawMax = Math.max(...data);
  // Visual padding so a near-flat series still has breathing room. Use a
  // floor of 0.2% of NAV or the raw variance × 0.18, whichever is larger.
  const variance = Math.max(0, rawMax - rawMin);
  const pad = Math.max(currentNav * 0.002, variance * 0.18, 0.0005);
  const yMin = Math.max(0, rawMin - pad);
  const yMax = Math.min(1, rawMax + pad);
  const yRange = yMax - yMin || 0.0001;

  const pts = data.map((v, i) => ({
    x: padL + (i / (data.length - 1)) * plotW,
    y: padT + (1 - (v - yMin) / yRange) * plotH,
  }));

  const linePath = catmullRomPath(pts);
  const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${padT + plotH} L ${pts[0].x} ${padT + plotH} Z`;

  // Y-axis ticks: 4 “nice” values spread across [yMin, yMax]
  const yTicks = niceTicks(yMin, yMax, 4);
  // X-axis: 3 labels at start / mid / now. Formatting scales with the
  // range — time-of-day for 1H/1D, dates for everything >=7D.
  const xLabels = computeXLabels(totalMinutes);

  const last = pts[pts.length - 1];
  const lastVal = data[data.length - 1];
  const gradId = `detail-fill-${color.replace("#", "")}`;
  // The live-value callout sits in the SAME right-hand gutter as the y-axis
  // tick labels (both at x ≈ W - padR + 8), so when the current NAV lands on a
  // gridline value the two numbers stack ("93.9%" over "94.0%"). Compute the
  // callout's y up front so we can drop any tick label that would collide.
  const calloutY = Math.max(padT + 10, last.y - 8);

  return (
    <>
      <ChartHeader
        label={headerLabel}
        currentNav={currentNav}
        range={range}
        onRangeChange={setRange}
      />
      <div ref={wrapRef} style={{ width: "100%" }}>
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          style={{ display: "block" }}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* y-axis gridlines at nice-tick values */}
          {yTicks.map((t, i) => {
            const y = padT + (1 - (t - yMin) / yRange) * plotH;
            return (
              <line
                key={`g-${i}`}
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="rgba(255,255,255,0.045)"
                strokeWidth={1}
              />
            );
          })}

          {/* y-axis labels — skip any that would collide with the live-value
              callout (same gutter), so "93.9%" and "94.0%" never stack. */}
          {yTicks.map((t, i) => {
            const y = padT + (1 - (t - yMin) / yRange) * plotH;
            if (Math.abs(y + 3 - (calloutY + 3)) < 12) return null;
            return (
              <text
                key={`yl-${i}`}
                x={W - padR + 8}
                y={y + 3}
                fill={C.textMuted}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fontSize={10}
                letterSpacing="0.04em"
              >
                {formatPct(t)}
              </text>
            );
          })}

          {/* area fill */}
          <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
          {/* line */}
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* x-axis labels */}
          {xLabels.map((lab, i) => {
            const x = padL + (i / (xLabels.length - 1)) * plotW;
            const anchor =
              i === 0 ? "start" : i === xLabels.length - 1 ? "end" : "middle";
            return (
              <text
                key={`xl-${i}`}
                x={x}
                y={H - 8}
                fill={C.textMuted}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fontSize={10}
                letterSpacing="0.04em"
                textAnchor={anchor}
              >
                {lab}
              </text>
            );
          })}

          {/* current-value marker + callout */}
          <circle cx={last.x} cy={last.y} r={4} fill={color} />
          <circle cx={last.x} cy={last.y} r={8} fill={color} opacity={0.18} />
          <text
            x={last.x + 8}
            y={calloutY}
            fill={color}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fontSize={11}
            fontWeight={500}
          >
            {(lastVal * 100).toFixed(1)}%
          </text>
        </svg>
      </div>
    </>
  );
}

function ChartHeader({
  label,
  currentNav,
  range,
  onRangeChange,
}: {
  label: string;
  currentNav: number;
  range: ChartRange;
  onRangeChange: (r: ChartRange) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span
          style={{
            fontSize: 11,
            color: C.textMuted,
            fontFamily: FM,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: FM,
            fontSize: 11,
            color: C.textSecondary,
            letterSpacing: "0.04em",
          }}
        >
          ${currentNav.toFixed(3)}
        </span>
      </div>
      <div
        role="tablist"
        aria-label="Chart time range"
        style={{
          display: "inline-flex",
          padding: 2,
          borderRadius: 999,
          background: C.surface,
          border: `0.5px solid ${C.border}`,
        }}
      >
        {CHART_RANGES.map((r) => {
          const active = r.key === range;
          return (
            <button
              key={r.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onRangeChange(r.key)}
              style={{
                padding: "4px 11px",
                fontFamily: FM,
                fontSize: 11,
                fontWeight: active ? 600 : 500,
                letterSpacing: "0.04em",
                color: active ? C.tealLight : C.textSecondary,
                background: active ? `${C.tealLight}14` : "transparent",
                border: "none",
                borderRadius: 999,
                cursor: "pointer",
                transition: `color 0.15s ${EASE}, background 0.15s ${EASE}`,
              }}
              onMouseEnter={(e) => {
                if (!active) (e.currentTarget as HTMLElement).style.color = C.textPrimary;
              }}
              onMouseLeave={(e) => {
                if (!active) (e.currentTarget as HTMLElement).style.color = C.textSecondary;
              }}
            >
              {r.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Catmull-Rom-to-Bezier path. Produces a visually smooth curve through
 * every data point without the angularity of a midpoint-quadratic path.
 * Tension=0.5 keeps overshoot minimal on choppy data.
 */
function catmullRomPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let path = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 >= pts.length ? pts.length - 1 : i + 2];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return path;
}

/**
 * Pick `target` tick values between `min` and `max` rounded to a nice
 * step (1 / 2 / 5 × 10^n). The returned array is always inside the
 * [min, max] interval.
 */
function niceTicks(min: number, max: number, target: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return [min];
  }
  const span = max - min;
  const rawStep = span / Math.max(1, target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    if (v >= min - step * 0.001) ticks.push(Number(v.toFixed(10)));
  }
  // Guarantee at least 2 ticks so the axis isn't empty on very tight slices.
  if (ticks.length < 2) return [min, max];
  return ticks;
}

/** Format a 0..1 probability value to a percentage with adaptive precision. */
function formatPct(v: number): string {
  const pct = v * 100;
  // Use more precision when the value is small so low-tier baskets don't
  // collapse to "0%" on the y-axis.
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(2)}%`;
}

/**
 * Produce 3 x-axis labels (start / midpoint / "Now") formatted for the
 * active range. The formatter switches shape based on span:
 *   • ≤ 3 hours  → "HH:MM"   (1H range)
 *   • ≤ 48 hours → "H\u202fAM/PM" (1D range)
 *   • ≤ 90 days  → "MMM D"   (7D / 30D)
 *   • >  90 days  → "MMM 'YY" (6M / 1Y)
 */
function computeXLabels(totalMinutes: number): string[] {
  if (totalMinutes <= 0) return ["Now"];
  const now = new Date();
  const start = new Date(now.getTime() - totalMinutes * 60_000);
  const mid = new Date(now.getTime() - (totalMinutes / 2) * 60_000);

  if (totalMinutes <= 60 * 3) {
    const fmt: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
    return [start.toLocaleTimeString([], fmt), mid.toLocaleTimeString([], fmt), "Now"];
  }
  if (totalMinutes <= 60 * 48) {
    const fmt: Intl.DateTimeFormatOptions = { hour: "numeric" };
    return [start.toLocaleTimeString([], fmt), mid.toLocaleTimeString([], fmt), "Now"];
  }
  const totalDays = totalMinutes / 1440;
  const useLong = totalDays > 90;
  const fmt: Intl.DateTimeFormatOptions = useLong
    ? { month: "short", year: "2-digit" }
    : { month: "short", day: "numeric" };
  const toStr = (d: Date) => d.toLocaleDateString("en-US", fmt);
  return [toStr(start), toStr(mid), "Now"];
}

/**
 * Build the meta line under the basket id. Live baskets show the
 * leg count and first / last resolution days (pulled from per-leg
 * `daysToResolution`), which is far more informative than the old
 * "0/N resolved · Xd remaining · resolves DATE" string where the
 * first fragment was structurally always "0/N" (live pipeline filters
 * out closed markets upstream). Seed fallbacks keep the short
 * resolution line since they don't carry per-leg data.
 */
function renderHeaderMeta(
  bundle: Bundle,
  liveMarkets: LiveMarket[],
): React.ReactNode {
  if (liveMarkets.length > 0) {
    const daysList = liveMarkets
      .map((m) => m.daysToResolution)
      .filter((d) => Number.isFinite(d));
    if (daysList.length === 0) {
      return `${bundle.totalLegs} legs · resolution dates pending`;
    }
    const first = Math.max(0, Math.round(Math.min(...daysList)));
    const last = Math.max(0, Math.round(Math.max(...daysList)));
    if (first === last) {
      return `${bundle.totalLegs} legs · all resolve in ${first}d`;
    }
    return `${bundle.totalLegs} legs · first resolves in ${first}d · last in ${last}d`;
  }
  // Seed fallback — no per-leg data to draw on.
  const daysPart = Number.isFinite(bundle.daysLeft)
    ? `${bundle.daysLeft}d to resolution`
    : "resolution TBD";
  const datePart =
    bundle.date && bundle.date !== "Invalid Date" ? ` · ${bundle.date}` : "";
  return `${bundle.totalLegs} legs · ${daysPart}${datePart}`;
}

/**
 * Format total lifetime Polymarket volume across a basket's legs. Used
 * by the MetricTile so the value is always live rather than a stubbed
 * BREAKEVEN% that duplicated the NAV.
 */
function formatTotalVolume(markets: LiveMarket[]): string {
  if (markets.length === 0) return "—";
  const total = markets.reduce((s, m) => s + (Number.isFinite(m.volumeUsd) ? m.volumeUsd : 0), 0);
  if (total >= 1_000_000_000) return `$${(total / 1_000_000_000).toFixed(1)}B`;
  if (total >= 1_000_000) return `$${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `$${(total / 1_000).toFixed(0)}K`;
  return `$${total.toFixed(0)}`;
}

// Build a Polymarket URL that actually resolves. Gamma exposes two slugs:
//   - market.slug   → polymarket.com/market/<market-slug>
//   - event.slug    → polymarket.com/event/<event-slug>[/<market-slug>]
// The old code linked to a 0x… conditionId, which just 404s on Polymarket.
function polymarketHref(market: LiveMarket): string {
  if (market.eventSlug && market.marketSlug) {
    return `https://polymarket.com/event/${market.eventSlug}/${market.marketSlug}`;
  }
  if (market.marketSlug) {
    return `https://polymarket.com/market/${market.marketSlug}`;
  }
  if (market.eventSlug) {
    return `https://polymarket.com/event/${market.eventSlug}`;
  }
  // Last-resort fallback — Polymarket's site search handles free text.
  return `https://polymarket.com/search?q=${encodeURIComponent(market.question)}`;
}

function ConstituentRow({
  index,
  market,
  tierColor,
  isLast,
}: {
  index: number;
  market: LiveMarket;
  tierColor: string;
  isLast: boolean;
}) {
  const [hov, setHov] = useState(false);
  const href = polymarketHref(market);
  const days = Math.max(0, Math.round(market.daysToResolution));
  const weightPct = (market.weight ?? 0) * 100;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "grid",
        gridTemplateColumns:
          "28px 80px minmax(200px, 1fr) 70px 74px 90px 80px 32px",
        alignItems: "center",
        padding: "12px 20px",
        borderBottom: isLast ? "none" : `0.5px solid ${C.border}`,
        background: hov ? `${tierColor || C.teal}0a` : "transparent",
        textDecoration: "none",
        transition: `background 0.15s ${EASE}`,
        columnGap: 12,
      }}
    >
      <div
        style={{
          fontFamily: FM,
          fontSize: 11,
          color: C.textMuted,
          letterSpacing: "0.04em",
        }}
      >
        {String(index).padStart(2, "0")}
      </div>
      <div
        style={{
          fontFamily: FM,
          fontSize: 10,
          color: C.textSecondary,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {market.category}
      </div>
      <div
        title={market.question}
        style={{
          fontFamily: FD,
          fontSize: 13,
          color: C.textPrimary,
          lineHeight: 1.35,
          // Single-line with ellipsis: every row is exactly one line
          // tall, so the 5-row table has a deterministic height across
          // every basket (no more “some rows wrap, some don’t” wobble).
          // Full question remains readable via the tooltip.
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {market.question}
      </div>
      <div
        style={{
          textAlign: "right",
          fontFamily: FM,
          fontSize: 13,
          fontWeight: 600,
          color: C.textPrimary,
          letterSpacing: "0.01em",
        }}
      >
        {weightPct.toFixed(1)}%
      </div>
      <div
        style={{
          textAlign: "right",
          fontFamily: FM,
          fontSize: 13,
          fontWeight: 500,
          color: tierColor,
          letterSpacing: "0.01em",
        }}
      >
        {(market.probability * 100).toFixed(1)}%
      </div>
      <div
        style={{
          textAlign: "right",
          fontFamily: FM,
          fontSize: 12,
          color: C.textSecondary,
        }}
      >
        {formatUsd(market.volumeUsd)}
      </div>
      <div
        style={{
          textAlign: "right",
          fontFamily: FM,
          fontSize: 12,
          color: C.textSecondary,
        }}
      >
        {days}d
      </div>
      <div
        style={{
          textAlign: "right",
          fontFamily: FM,
          fontSize: 12,
          color: hov ? tierColor : C.textMuted,
          transition: `color 0.15s ${EASE}`,
        }}
      >
        ↗
      </div>
    </a>
  );
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function LoadingSkeleton() {
  return (
    <div>
      <div
        style={{
          height: 13,
          width: 140,
          background: C.border,
          borderRadius: 4,
          marginBottom: 24,
          opacity: 0.5,
        }}
      />
      <div
        style={{
          height: 72,
          width: "70%",
          background: C.border,
          borderRadius: 8,
          marginBottom: 18,
          opacity: 0.3,
        }}
      />
      <div
        style={{
          height: 200,
          background: C.card,
          border: `0.5px solid ${C.border}`,
          borderRadius: 14,
        }}
      />
    </div>
  );
}
