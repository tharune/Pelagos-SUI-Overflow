"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Header, PageFrame } from "../_components/Header";
import { C, FS, FD, FM, EASE, tc, trancheColor, fmtUsd } from "../_lib/tokens";
import { useMode } from "../_lib/mode";
import { useLiveBaskets } from "../_lib/use-live-baskets";
import { bundleById } from "../_lib/bundles";
import { useSandbox, type BasketPosition } from "../_lib/demo-state";
import { useActiveWalletAddress, useUsdcBalance, useDusdcBalance, useWalletSigner } from "../_lib/wallet-bridge";
import { fetchBasketPortfolio, usePbuBalances } from "../_lib/portfolio-client";
import { fetchPpnPortfolio, ppnRedeem, PpnError } from "../_lib/ppn-client";
import { mergePpnVaults, mergeTranches } from "../_lib/ppn-hydrate";
import { redeemFromBundle, DepositError } from "../_lib/deposit-client";
import {
  groupVirtualByUiBundle,
  clearVirtualPositionsByUiBundleId,
  type GroupedVirtualPosition,
} from "../_lib/virtual-positions";
import { StrategyBacktestPanel, type PortfolioMix } from "../_components/strategy-backtest-panel";
import { History } from "./_history";
import {
  fetchContinuousPositions,
  type ContinuousPosition,
} from "../_lib/distribution-continuous-client";
import { useLendingSnapshot } from "../_lib/lending-client";
import { fetchSimPositions, simSettle, type SimPosition } from "../_lib/sim-client";

type View = "positions" | "backtest" | "history";

export default function PortfolioPage() {
  const { mode } = useMode();
  const { state, totals, dispatch } = useSandbox();
  const appWalletAddress = useActiveWalletAddress();
  const usdc = useUsdcBalance();   // mUSDC (Pelagos USDC)
  const dusdc = useDusdcBalance(); // dUSDC (DeepBook Predict quote asset)
  const walletSigner = useWalletSigner();
  const [redeemBusy, setRedeemBusy] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<Record<string, string>>({});
  const [simBusy, setSimBusy] = useState<string | null>(null);
  const basketState = useLiveBaskets();

  // Live Sui USDC lending market (DeFiLlama-sourced supply APY + utilization).
  // The position $-value stays the user's actual lent amount (0 until they
  // deposit); this just surfaces the real external yield in the allocation row.
  const { snapshot: lendingSnapshot, loading: lendingLoading } = useLendingSnapshot();

  // Authoritative on-chain PBU unit balances per bundle. The ONLY source we
  // trust for "how many basket tokens does this wallet actually own"; cancelled
  // deposits never mint PBU so they contribute $0 here regardless of stale UI.
  const pbuBalances = usePbuBalances();
  const pbuTokensByUuid = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const entry of pbuBalances.balances) {
      if (entry.uiAmount > 0) out[entry.bundleId] = entry.uiAmount;
    }
    return out;
  }, [pbuBalances.balances]);

  // Single source of truth for "is there a wallet we can attribute balances to".
  const walletReady = Boolean(appWalletAddress);
  const virtualGroupsForWallet: GroupedVirtualPosition[] =
    walletReady && appWalletAddress
      ? groupVirtualByUiBundle(appWalletAddress)
      : [];
  const suiTokensByUuid = virtualGroupsForWallet.reduce<Record<string, number>>(
    (acc, g) => {
      acc[g.uuid] = (acc[g.uuid] ?? 0) + g.tokens;
      return acc;
    },
    {},
  );
  const onchainTokensByUuid =
    Object.keys(suiTokensByUuid).length > 0 ? suiTokensByUuid : pbuTokensByUuid;
  // Cash = mUSDC + dUSDC, both $1 (1:1 USD). They're two settlement currencies on
  // the same platform, so the portfolio sums them as one USD cash balance.
  const liveMusdc = walletReady ? usdc.uiAmount : 0;
  const liveDusdc = walletReady ? dusdc.uiAmount : 0;
  const liveUsdc = liveMusdc + liveDusdc;

  const [renderNow, setRenderNow] = useState<number>(() => Date.now());
  const [view, setView] = useState<View>("positions");
  const [distPositions, setDistPositions] = useState<ContinuousPosition[]>([]);
  const [simPositions, setSimPositions] = useState<SimPosition[]>([]);
  useEffect(() => {
    const t = setInterval(() => setRenderNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const effectiveTranches = walletReady ? state.tranchePositions : [];
  const effectivePpnVaults = walletReady ? state.ppnVaults : [];

  // PPN accrued yield (ticks with renderNow). principal * apy% / 365 capped at
  // maturity. Every field guarded against an indexer race producing NaN.
  const ppnAccruedYield = effectivePpnVaults.reduce((sum, v) => {
    const principal = Number.isFinite(v.principal) ? v.principal : 0;
    const apy = Number.isFinite(v.apy) ? v.apy : 0;
    const maturityDays = Number.isFinite(v.maturityDays) ? v.maturityDays : 0;
    const createdAt = Number.isFinite(v.createdAt) ? v.createdAt : renderNow;
    const elapsedDays = Math.max(0, (renderNow - createdAt) / 86_400_000);
    return sum + principal * (apy / 100 / 365) * Math.min(elapsedDays, maturityDays);
  }, 0);
  // Tranche accrued yield. Same straight-line approximation, capped at maturity.
  const trancheAccruedYield = effectiveTranches.reduce((sum, p) => {
    if (p.apy == null || p.createdAt == null || p.maturityDays == null) return sum;
    const principal = p.qty * p.avgCost;
    const elapsedDays = Math.max(0, (renderNow - p.createdAt) / 86_400_000);
    return sum + principal * (p.apy / 100 / 365) * Math.min(elapsedDays, p.maturityDays);
  }, 0);

  const effectiveTrancheValue = effectiveTranches.reduce((sum, p) => {
    const v = p.qty * p.avgCost;
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
  const effectivePpnValue = effectivePpnVaults.reduce(
    (sum, v) => sum + (Number.isFinite(v.principal) ? v.principal : 0),
    0,
  );

  // Open continuous distribution positions: collateral escrowed at open.
  const effectiveDistPositions = walletReady
    ? distPositions.filter((p) => !p.settled)
    : [];
  const distValue = effectiveDistPositions.reduce(
    (sum, p) => sum + (Number.isFinite(p.collateral_usdc) ? p.collateral_usdc : 0),
    0,
  );

  // Open mUSDC structured positions (DeepBook strips / options / vol / notes settled
  // in Pelagos USDC): the premium is escrowed in the vault until settle.
  const openSimPositions = walletReady ? simPositions.filter((p) => p.status !== "settled") : [];
  const simValue = openSimPositions.reduce(
    (sum, p) => sum + (Number.isFinite(p.premium_usd) ? p.premium_usd : 0),
    0,
  );

  // Basket value at the wallet's cost basis (issue price ≈ deposited USDC). We
  // intentionally don't mark baskets to NAV pre-resolution (exit_active pays the
  // pool ratio, not qty×NAV), so basket unrealized P&L stays 0 until redeem.
  const onchainBasketValue = walletReady
    ? virtualGroupsForWallet.reduce((sum, g) => sum + g.depositedUsdc, 0)
    : 0;
  const onchainBasketPnl = 0;

  // Map live holdings onto backtestable strategy classes (value-weighted) so the
  // Backtests tab can replay "your portfolio" on real history.
  const portfolioMix: PortfolioMix = React.useMemo(() => {
    const simLongVol = openSimPositions.filter((p) => p.product !== "option").reduce((s, p) => s + p.premium_usd, 0);
    const simDirectional = openSimPositions.filter((p) => p.product === "option").reduce((s, p) => s + p.premium_usd, 0);
    return [
      // Convex / long-gamma sleeve: vol strips, principal-protected notes, μ/σ distributions.
      { id: "long-vol-straddle", weight: simLongVol + effectivePpnValue + distValue, label: "vol strips, notes & distributions" },
      // Carry / range sleeve: risk slices earn a spread and are mostly range-bound.
      { id: "short-vol-condor", weight: effectiveTrancheValue, label: "risk slices · carry" },
      { id: "btc-momentum", weight: simDirectional, label: "directional options" },
      { id: "event-basket", weight: onchainBasketValue, label: "event baskets" },
    ].filter((m) => m.weight > 0);
  }, [openSimPositions, effectivePpnValue, effectiveTrancheValue, distValue, onchainBasketValue]);

  // Top-line value + P&L. Every term is already 0 when disconnected (walletReady
  // gating), so the headline collapses to 0 without a separate guard.
  const displayTotal = walletReady
    ? liveUsdc +
      onchainBasketValue +
      effectiveTrancheValue +
      effectivePpnValue +
      ppnAccruedYield +
      trancheAccruedYield +
      distValue +
      simValue +
      totals.lendValue -
      totals.loanDebt
    : 0;
  const displayPnl = walletReady
    ? onchainBasketPnl + ppnAccruedYield + trancheAccruedYield
    : 0;

  // Hydrate basket / note / distribution positions whenever the wallet changes.
  const hydratePortfolio = React.useCallback(async () => {
    if (!appWalletAddress) return;
    const wallet = appWalletAddress;
    await Promise.allSettled([
      fetchBasketPortfolio(wallet).then((positions) =>
        dispatch({ type: "basket/hydrate", positions }),
      ),
      fetchPpnPortfolio(wallet).then((portfolio) => {
        dispatch({ type: "ppn/hydrate", vaults: mergePpnVaults(portfolio) });
        dispatch({ type: "tranche/hydrate", positions: mergeTranches(portfolio) });
      }),
      fetchContinuousPositions(wallet).then((r) =>
        setDistPositions(Array.isArray(r?.positions) ? r.positions : []),
      ),
      fetchSimPositions(wallet).then((ps) => setSimPositions(Array.isArray(ps) ? ps : [])),
    ]);
  }, [appWalletAddress, dispatch]);

  // Settle an open mUSDC position: the protocol computes the payoff and mints it.
  const settleSimPosition = React.useCallback(async (simId: string) => {
    setSimBusy(simId);
    try {
      await simSettle(simId);
      await hydratePortfolio();
      void usdc.refresh(); void dusdc.refresh();
    } catch {
      /* surfaced on next hydrate */
    } finally {
      setSimBusy(null);
    }
  }, [hydratePortfolio, usdc, dusdc]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await hydratePortfolio();
    })();
    return () => {
      cancelled = true;
    };
  }, [hydratePortfolio]);

  async function handleRedeem(bundleId: string, uiBundleId: string, tokens: number) {
    if (!walletReady || !appWalletAddress) return;
    setRedeemError((prev) => {
      const next = { ...prev };
      delete next[bundleId];
      return next;
    });
    setRedeemBusy(bundleId);
    try {
      await redeemFromBundle({ wallet: walletSigner, bundleId, amountTokens: tokens });
      clearVirtualPositionsByUiBundleId(appWalletAddress, bundleId, uiBundleId);
      await hydratePortfolio();
      void usdc.refresh(); void dusdc.refresh();
    } catch (err) {
      const msg =
        err instanceof DepositError
          ? err.message
          : err instanceof Error
            ? /user rejected/i.test(err.message)
              ? "Transaction was rejected in your wallet."
              : err.message
            : String(err);
      if (/no vault position/i.test(msg) && appWalletAddress) {
        clearVirtualPositionsByUiBundleId(appWalletAddress, bundleId, uiBundleId);
        await hydratePortfolio();
        void usdc.refresh(); void dusdc.refresh();
      } else {
        setRedeemError((prev) => ({ ...prev, [bundleId]: msg }));
      }
    } finally {
      setRedeemBusy(null);
    }
  }

  async function handleRedeemPpn(rowKey: string, opts: { vaultIds?: string[]; bundleId?: string }) {
    setRedeemError((prev) => {
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
    setRedeemBusy(rowKey);
    try {
      const ids = opts.vaultIds?.filter(Boolean) ?? [];
      if (ids.length > 0) {
        for (const vaultId of ids) {
          await ppnRedeem({ wallet: walletSigner, vaultId, bundleId: opts.bundleId });
        }
      } else {
        await ppnRedeem({ wallet: walletSigner, bundleId: opts.bundleId });
      }
      await hydratePortfolio();
      void usdc.refresh(); void dusdc.refresh();
    } catch (err) {
      const msg =
        err instanceof PpnError
          ? err.message
          : err instanceof Error
            ? /user rejected/i.test(err.message)
              ? "Transaction was rejected in your wallet."
              : err.message
            : String(err);
      setRedeemError((prev) => ({ ...prev, [rowKey]: msg }));
    } finally {
      setRedeemBusy(null);
    }
  }

  const resolveBasket = (id: string) => {
    if (basketState.status === "ok") {
      const live = basketState.baskets.find((b) => b.id === id);
      if (live) return { id: live.id, tier: live.tier, nav: live.nav };
    }
    const seed = bundleById(id);
    return seed ? { id: seed.id, tier: seed.tier, nav: seed.nav } : null;
  };

  // Allocation rows — same sources as displayTotal so headline + rows reconcile.
  // Live lending market APY for the allocation row's right cell. While the
  // snapshot loads we show "…"; once live we surface the real supply APY (and
  // utilization when present) rather than the position's allocation share.
  const lendingApyLabel = lendingSnapshot
    ? `${lendingSnapshot.market_supply_apy.toFixed(2)}% APY${
        Number.isFinite(lendingSnapshot.utilization)
          ? ` · ${(lendingSnapshot.utilization * 100).toFixed(0)}% util`
          : ""
      }`
    : lendingLoading
      ? "…"
      : "—";

  const productRows: Array<{
    id: string;
    label: string;
    description: string;
    value: number;
    color: string;
    href?: string;
    /** When set, the row's right-hand percentage cell shows this instead of the allocation share. */
    metaOverride?: string;
  }> = [
    { id: "cash", label: "Cash", description: `${fmtUsd(liveMusdc, 0)} mUSDC + ${fmtUsd(liveDusdc, 0)} dUSDC · 1:1 USD`, value: liveUsdc, color: C.textMuted },
    { id: "baskets", label: "Market Baskets", description: "Basket units held directly", value: onchainBasketValue, color: C.tealLight, href: "/app/basket" },
    { id: "tranches", label: "Risk Slices", description: "Senior / mezzanine / junior", value: effectiveTrancheValue + trancheAccruedYield, color: C.amber, href: "/app/tranche" },
    { id: "ppn", label: "Protected Notes", description: "Principal-protected notes", value: effectivePpnValue + ppnAccruedYield, color: C.violet, href: "/app/ppn" },
    { id: "distribution", label: "Distribution Markets", description: "Continuous μ/σ · collateral at risk", value: distValue, color: C.coral, href: "/app/distribution" },
    ...(simValue > 0
      ? [{ id: "structured", label: "Structured Positions", description: "Strips, options & vol · Pelagos USDC", value: simValue, color: C.green }]
      : []),
    { id: "lending", label: "Lending", description: "Sui USDC market rate", value: walletReady ? totals.lendValue : 0, color: C.blue, metaOverride: lendingApyLabel },
  ];
  const productTotal = productRows.reduce((sum, row) => sum + row.value, 0);

  const deployedValue = Math.max(0, displayTotal - liveUsdc);
  const deployedPct = displayTotal > 0 ? (deployedValue / displayTotal) * 100 : 0;
  const positionCount =
    Object.keys(onchainTokensByUuid).length +
    effectiveTranches.length +
    effectivePpnVaults.length +
    effectiveDistPositions.length;

  return (
    <>
      <style>{`
        .pf-tabs {
          display: flex; gap: 2px; padding: 3px; background: ${C.surface};
          border: 0.5px solid ${C.border}; border-radius: 8px;
        }
        .pf-tab {
          border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer;
          font-family: ${FD}; font-size: 12px; letter-spacing: 0.01em;
          background: transparent; color: ${C.textSecondary};
          transition: color 0.15s ${EASE}, background 0.15s ${EASE};
        }
        .pf-tab:hover { color: ${C.textPrimary}; }
        .pf-tab.active { background: ${C.card}; color: ${C.tealLight}; font-weight: 600; }
        .pf-overview {
          display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
          gap: 14px; margin-bottom: 22px; align-items: stretch;
        }
        .pf-panel {
          background: ${C.card}; border: 0.5px solid ${C.border}; border-radius: 12px; padding: 20px;
        }
        .pf-card {
          background: ${C.card}; border: 0.5px solid ${C.border}; border-radius: 12px; padding: 18px;
        }
        .pf-summary-metrics {
          display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px;
          margin-top: 20px; padding-top: 18px; border-top: 0.5px solid ${C.border};
        }
        .pf-alloc-row {
          display: grid; grid-template-columns: minmax(0, 1fr) 96px 78px;
          gap: 16px; align-items: center; padding: 13px 0;
          border-top: 0.5px solid ${C.border}; text-decoration: none;
          transition: opacity 0.15s ${EASE};
        }
        .pf-alloc-row:first-child { border-top: 0; }
        .pf-alloc-row:hover { opacity: 0.84; }
        .pf-spark { height: 5px; border-radius: 999px; background: ${C.surface}; overflow: hidden; }
        .pf-spark span { display: block; height: 100%; border-radius: inherit; }
        .pf-positions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
        @media (max-width: 1180px) {
          .pf-overview { grid-template-columns: 1fr; }
        }
        @media (max-width: 900px) {
          .pf-positions { grid-template-columns: 1fr; }
        }
        @media (max-width: 760px) {
          .pf-head { align-items: flex-start !important; flex-direction: column; }
          .pf-tabs { width: 100%; overflow-x: auto; }
          .pf-summary-metrics { grid-template-columns: 1fr; gap: 12px; }
          .pf-alloc-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
        }
      `}</style>
      <Header />
      <PageFrame wide>
        <div className="pf-head" style={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: 20, marginBottom: 22, paddingBottom: 16, borderBottom: `0.5px solid ${C.border}` }}>
          <div>
            <div style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.14em", color: C.tealLight, fontWeight: 700, marginBottom: 8, textTransform: "uppercase" }}>
              {view === "positions" ? "Account" : view === "backtest" ? "Strategy lab" : "Ledger"}
            </div>
            <h1 style={{ margin: 0, color: C.textPrimary, fontFamily: FD, fontSize: 30, lineHeight: 1.05, letterSpacing: "-0.02em", fontWeight: 600, display: "flex", alignItems: "center", gap: 12 }}>
              {view === "positions" ? "Portfolio" : view === "backtest" ? "Backtests" : "Activity"}
            </h1>
            <div style={{ fontSize: 13, color: C.textSecondary, fontFamily: FS, marginTop: 8, maxWidth: 680, lineHeight: 1.55 }}>
              {view === "positions"
                ? "Your holdings, live mark-to-market value, and a clean P&L summary."
                : view === "backtest"
                  ? "Replay each strategy class against real Coinbase / Polymarket history — a transparent proxy, not a forecast."
                  : "A chronological ledger of buys, exits, and note actions."}
            </div>
          </div>
          <div className="pf-tabs">
            {([
              { id: "positions", label: "Holdings" },
              { id: "backtest", label: "Backtests" },
              { id: "history", label: "History" },
            ] as const).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setView(t.id)}
                className={`pf-tab${view === t.id ? " active" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {view === "backtest" ? (
          <StrategyBacktestPanel portfolioMix={portfolioMix} />
        ) : view === "history" ? (
          <History walletAddress={appWalletAddress} connected={walletReady} />
        ) : (
          <>
            {/* ── Calm account summary: total value + P&L, and a simple allocation list ── */}
            <section className="pf-overview" aria-label="Portfolio account overview">
              <div className="pf-panel" style={{ display: "grid", alignContent: "space-between" }}>
                <div>
                  <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 12 }}>
                    Net account value
                  </div>
                  <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 42, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                    {fmtUsd(displayTotal, 2)}
                  </div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 12 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: displayPnl >= 0 ? C.green : C.red }} />
                    <span style={{ color: displayPnl >= 0 ? C.green : C.red, fontFamily: FM, fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                      {displayPnl >= 0 ? "+" : ""}{fmtUsd(displayPnl, 2)}
                    </span>
                    <span style={{ color: C.textMuted, fontFamily: FM, fontSize: 11, letterSpacing: "0.04em" }}>
                      unrealized P&amp;L · accrued yield
                    </span>
                  </div>
                </div>

                <div className="pf-summary-metrics">
                  <div>
                    <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase" }}>Cash</div>
                    <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 18, fontWeight: 600, marginTop: 7, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(liveUsdc, 2)}</div>
                  </div>
                  <div>
                    <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase" }}>Deployed</div>
                    <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 18, fontWeight: 600, marginTop: 7, fontVariantNumeric: "tabular-nums" }}>{deployedPct.toFixed(0)}%</div>
                  </div>
                  <div>
                    <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase" }}>Positions</div>
                    <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 18, fontWeight: 600, marginTop: 7, fontVariantNumeric: "tabular-nums" }}>{positionCount}</div>
                  </div>
                </div>
              </div>

              <div className="pf-panel">
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 18, marginBottom: 4 }}>
                  <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                    Allocation
                  </div>
                  <div style={{ color: C.textSecondary, fontFamily: FM, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(productTotal, 2)}</div>
                </div>

                <div style={{ display: "grid" }}>
                  {productRows.map((row) => {
                    const share = productTotal > 0 ? (row.value / productTotal) * 100 : 0;
                    const content = (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "10px minmax(0, 1fr)", gap: 12, alignItems: "center" }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: row.color, opacity: row.value > 0 ? 1 : 0.4 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.label}</div>
                            <div style={{ color: C.textMuted, fontFamily: FS, fontSize: 11, lineHeight: 1.35, marginTop: 2 }}>{row.description}</div>
                          </div>
                        </div>
                        <div className="pf-spark">
                          <span style={{ width: `${Math.max(1, Math.min(100, share))}%`, background: row.color, opacity: row.value > 0 ? 0.95 : 0.16 }} />
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 13.5, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(row.value, 2)}</div>
                          <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, marginTop: 3 }}>{row.metaOverride ?? `${share.toFixed(1)}%`}</div>
                        </div>
                      </>
                    );
                    return row.href ? (
                      <Link key={row.id} href={row.href} className="pf-alloc-row">{content}</Link>
                    ) : (
                      <div key={row.id} className="pf-alloc-row">{content}</div>
                    );
                  })}
                </div>
              </div>
            </section>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, margin: "0 0 12px" }}>
              <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                Open positions
              </div>
              {walletReady && positionCount > 0 && (
                <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10.5, fontVariantNumeric: "tabular-nums" }}>
                  {positionCount} held · sorted by value
                </div>
              )}
            </div>

            {/* Positions — sorted by value descending, USDC included */}
            <div className="pf-positions">
            {(() => {
              if (!walletReady) {
                return (
                  <div className="pf-card" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "34px 20px" }}>
                    <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 17, fontWeight: 600, marginBottom: 6 }}>
                      Connect a wallet to view balances
                    </div>
                    <div style={{ color: C.textSecondary, fontFamily: FS, fontSize: 13 }}>
                      Portfolio data is pulled from the connected account and the Sui-backed backend indexer.
                    </div>
                  </div>
                );
              }

              const rows: { value: number; el: React.ReactNode; key: string }[] = [];
              const virtualGroups: GroupedVirtualPosition[] = virtualGroupsForWallet;
              const virtualTokensByUuid = virtualGroups.reduce<Record<string, number>>(
                (acc, g) => {
                  acc[g.uuid] = (acc[g.uuid] ?? 0) + g.tokens;
                  return acc;
                },
                {},
              );
              const uiBundleIdByUuid = virtualGroups.reduce<Record<string, { id: string; tokens: number }>>(
                (acc, g) => {
                  const prev = acc[g.uuid];
                  if (!prev || g.tokens > prev.tokens) acc[g.uuid] = { id: g.uiBundleId, tokens: g.tokens };
                  return acc;
                },
                {},
              );

              const deriveResidualLabel = (p: BasketPosition): { labelId: string; tier: 90 | 70 | 50; nav: number } | null => {
                if (p.displayName && /^PBU-(HIGH|MID|LOW)-(SHORT|MED|LONG)$/.test(p.displayName)) {
                  const live = basketState.status === "ok" ? basketState.baskets.find((b) => b.id === p.displayName) : null;
                  const tier = live?.tier ?? p.tier;
                  const nav = live?.nav ?? p.navHint;
                  if (tier != null && nav != null) return { labelId: p.displayName, tier, nav };
                }
                const borrowed = uiBundleIdByUuid[p.bundleId];
                if (borrowed) {
                  const live = basketState.status === "ok" ? basketState.baskets.find((b) => b.id === borrowed.id) : null;
                  const tier = live?.tier ?? p.tier;
                  const nav = live?.nav ?? p.navHint;
                  if (tier != null && nav != null) return { labelId: borrowed.id, tier, nav };
                }
                const tierGuess = p.tier;
                if (tierGuess == null) return null;
                if (basketState.status === "ok") {
                  const candidates = basketState.baskets.filter((b) => b.tier === tierGuess);
                  if (candidates.length) {
                    const target = p.maturityAt;
                    const pick = target == null
                      ? candidates[0]
                      : candidates
                          .map((b) => {
                            const bMaturity = b.daysLeft != null ? Date.now() + b.daysLeft * 86_400_000 : null;
                            const diff = bMaturity == null ? Number.POSITIVE_INFINITY : Math.abs(bMaturity - target);
                            return { b, diff };
                          })
                          .sort((a, z) => a.diff - z.diff)[0].b;
                    return { labelId: pick.id, tier: pick.tier, nav: pick.nav };
                  }
                }
                const seed = bundleById(`PBU-${tierGuess === 90 ? "HIGH" : tierGuess === 70 ? "MID" : "LOW"}-SHORT`);
                if (seed) return { labelId: seed.id, tier: seed.tier, nav: p.navHint ?? seed.nav };
                return null;
              };

              const renderBasketCard = (opts: {
                cardKey: string;
                uuid: string;
                labelId: string;
                qty: number;
                avgCost: number;
                nav: number;
                tier: 90 | 70 | 50;
                maturityAt?: number | null;
                status?: string;
              }) => {
                const { cardKey, uuid, labelId, qty, avgCost, nav, tier, maturityAt, status } = opts;
                const value = qty * avgCost;
                const pnl = 0;
                void nav;
                const liveMatchById = basketState.status === "ok" ? basketState.baskets.find((b) => b.id === labelId) : null;
                const liveMaturityMs = liveMatchById?.daysLeft != null ? Date.now() + liveMatchById.daysLeft * 86_400_000 : null;
                const effectiveMaturityMs = liveMaturityMs ?? maturityAt ?? null;
                const matured = status === "resolved" || (effectiveMaturityMs != null && effectiveMaturityMs <= renderNow);
                const maturityDate = liveMatchById?.date
                  ? liveMatchById.date
                  : maturityAt
                    ? (() => {
                        const d = new Date(maturityAt);
                        return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
                      })()
                    : null;
                const maturityLabel =
                  typeof maturityDate === "string"
                    ? maturityDate
                    : maturityDate
                      ? maturityDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                      : null;
                const isBusy = redeemBusy === uuid;
                const errMsg = redeemError[uuid];
                const tierLabel = tier === 90 ? "High" : tier === 70 ? "Mid" : "Low";
                const daysLeftMs =
                  liveMatchById?.daysLeft != null
                    ? liveMatchById.daysLeft * 86_400_000
                    : maturityAt != null
                      ? Math.max(0, maturityAt - renderNow)
                      : null;
                const closesInLabel =
                  daysLeftMs == null
                    ? null
                    : daysLeftMs <= 0
                      ? "Resolving now"
                      : (() => {
                          const d = Math.round(daysLeftMs / 86_400_000);
                          if (d === 0) return "Closes today";
                          if (d === 1) return "Closes in 1 day";
                          return `Closes in ${d} days`;
                        })();
                const contextLine = closesInLabel ? `${tierLabel}-conviction · ${closesInLabel}` : `${tierLabel}-conviction basket`;
                rows.push({
                  key: cardKey,
                  value,
                  el: (
                    <div key={cardKey} style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                        <div style={{ fontSize: 9.5, color: C.tealLight, fontFamily: FM, letterSpacing: "0.12em" }}>MARKET BASKET</div>
                        <Link href="/app/basket" style={{ fontSize: 11, color: C.teal, fontFamily: FS, textDecoration: "none" }}>View all →</Link>
                      </div>
                      <Link href={`/app/basket/${labelId}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", textDecoration: "none" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                          <div style={{ width: 4, height: 24, borderRadius: 2, background: tc(tier), flexShrink: 0 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD }}>{labelId}</div>
                            <div style={{ fontSize: 11, color: C.textSecondary, fontFamily: FS, marginTop: 2 }}>{contextLine}</div>
                            {mode === "advanced" && (
                              <div style={{ fontSize: 10.5, color: C.textMuted, fontFamily: FM, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{(qty ?? 0).toFixed(2)} units · avg ${(avgCost ?? 0).toFixed(3)}</div>
                            )}
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 14, color: C.textPrimary, fontFamily: FD, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(value, 2)}</div>
                          <div style={{ fontSize: 11, color: pnl >= 0 ? C.green : C.red, fontFamily: FM, marginTop: 2 }}>{pnl >= 0 ? "+" : ""}{fmtUsd(pnl, 2)}</div>
                        </div>
                      </Link>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, paddingTop: 12, borderTop: `0.5px solid ${C.border}` }}>
                        <div style={{ fontSize: 10, color: matured ? C.green : C.textMuted, fontFamily: FM, letterSpacing: "0.06em" }}>
                          {matured ? "MATURED" : maturityLabel ? `MATURES ${maturityLabel.toUpperCase()}` : "MATURITY UNKNOWN"}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRedeem(uuid, labelId, qty)}
                          disabled={isBusy || !walletReady}
                          title={matured ? "Redeem at maturity" : "Exit this position early — pro-rata payout, small exit fee"}
                          style={redeemBtn(C.teal, C.tealLight, isBusy, walletReady)}
                        >
                          {isBusy ? "Redeeming…" : "Redeem"}
                        </button>
                      </div>
                      {errMsg && <div style={{ marginTop: 10, fontSize: 11, fontFamily: FS, color: C.red }}>{errMsg}</div>}
                    </div>
                  ),
                });
              };

              virtualGroups.forEach((g) => {
                const liveMatch = basketState.status === "ok" ? basketState.baskets.find((b) => b.id === g.uiBundleId) : null;
                const dbMatch = state.basketPositions.find((p) => p.bundleId === g.uuid);
                const tier = liveMatch?.tier ?? dbMatch?.tier;
                const nav = liveMatch?.nav ?? dbMatch?.navHint;
                if (tier == null || nav == null) return;
                const onchainForUuid = onchainTokensByUuid[g.uuid] ?? 0;
                if (onchainForUuid <= 0.000001) return;
                const totalVirtualForUuid = virtualTokensByUuid[g.uuid] ?? 0;
                const share = totalVirtualForUuid > 0 ? g.tokens / totalVirtualForUuid : 1;
                const effectiveQty = Math.min(g.tokens, onchainForUuid * share);
                if (effectiveQty <= 0.000001) return;
                renderBasketCard({
                  cardKey: `${g.uuid}::${g.uiBundleId}`,
                  uuid: g.uuid,
                  labelId: g.uiBundleId,
                  qty: effectiveQty,
                  avgCost: g.tokens > 1e-9 && g.depositedUsdc > 0 ? g.depositedUsdc / g.tokens : g.avgNavAtDeposit,
                  nav,
                  tier,
                  maturityAt: dbMatch?.maturityAt,
                  status: dbMatch?.status,
                });
              });

              const residualByBundle = new Map<string, BasketPosition>();
              state.basketPositions.forEach((p) => {
                const existing = residualByBundle.get(p.bundleId);
                if (existing) residualByBundle.set(p.bundleId, { ...existing, qty: existing.qty + p.qty });
                else residualByBundle.set(p.bundleId, p);
              });
              residualByBundle.forEach((p) => {
                const onchainForUuid = onchainTokensByUuid[p.bundleId] ?? 0;
                if (onchainForUuid <= 0.000001) return;
                const virtualQty = virtualTokensByUuid[p.bundleId] ?? 0;
                const coveredByVirtual = Math.min(virtualQty, onchainForUuid);
                const residual = onchainForUuid - coveredByVirtual;
                if (residual <= 0.001) return;
                const catalogMatch = resolveBasket(p.bundleId);
                let tier: 90 | 70 | 50 | undefined;
                let nav: number | undefined;
                let labelId: string;
                if (catalogMatch) {
                  tier = catalogMatch.tier;
                  nav = catalogMatch.nav;
                  labelId = catalogMatch.id;
                } else {
                  const derived = deriveResidualLabel(p);
                  if (!derived) return;
                  tier = derived.tier;
                  nav = derived.nav;
                  labelId = derived.labelId;
                }
                if (tier == null || nav == null) return;
                renderBasketCard({
                  cardKey: `${p.bundleId}::residual`,
                  uuid: p.bundleId,
                  labelId,
                  qty: residual,
                  avgCost: p.avgCost && p.avgCost > 0 ? p.avgCost : nav,
                  nav,
                  tier,
                  maturityAt: p.maturityAt,
                  status: p.status,
                });
              });

              effectiveTranches.forEach((p, i) => {
                const principal = p.qty * p.avgCost;
                const trancheAccrued =
                  p.apy != null && p.createdAt != null && p.maturityDays != null
                    ? principal * (p.apy / 100 / 365) * Math.min(Math.max(0, (renderNow - p.createdAt) / 86_400_000), p.maturityDays)
                    : 0;
                const value = principal + trancheAccrued;
                const rowKey = `tranche-${p.vaultId ?? `${p.bundleId}-${p.kind}-${i}`}`;
                const matured = p.maturityAt != null ? p.maturityAt <= renderNow : false;
                const isBusy = redeemBusy === rowKey;
                const errMsg = redeemError[rowKey];
                const maturityLabel = p.maturityAt
                  ? new Date(p.maturityAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                  : null;
                rows.push({
                  key: rowKey,
                  value,
                  el: (
                    <div key={rowKey} style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                        <div style={{ fontSize: 9.5, color: C.amber, fontFamily: FM, letterSpacing: "0.12em" }}>RISK SLICE</div>
                        <Link href="/app/tranche" style={{ fontSize: 11, color: C.teal, fontFamily: FS, textDecoration: "none" }}>View all →</Link>
                      </div>
                      <Link href={`/app/tranche/${p.bundleName ?? p.bundleId}?tier=${p.kind}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", textDecoration: "none" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                          <div style={{ width: 4, height: 24, borderRadius: 2, background: trancheColor(p.kind), flexShrink: 0 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD, textTransform: "capitalize" }}>{p.bundleName ?? p.bundleId} · {p.kind}</div>
                            {mode === "advanced" && (
                              <div style={{ fontSize: 10.5, color: C.textMuted, fontFamily: FM, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{(p.qty ?? 0).toFixed(2)} units · issued ${(p.avgCost ?? 0).toFixed(2)}</div>
                            )}
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 14, color: C.textPrimary, fontFamily: FD, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(value, 2)}</div>
                          {trancheAccrued > 0 && <div style={{ fontSize: 11, color: C.green, fontFamily: FM, marginTop: 2 }}>+{fmtUsd(trancheAccrued, 2)}</div>}
                        </div>
                      </Link>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, paddingTop: 12, borderTop: `0.5px solid ${C.border}` }}>
                        <div style={{ fontSize: 10, color: matured ? C.green : C.textMuted, fontFamily: FM, letterSpacing: "0.06em" }}>
                          {matured ? "MATURED" : maturityLabel ? `MATURES ${maturityLabel.toUpperCase()}` : "MATURITY UNKNOWN"}
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            handleRedeemPpn(rowKey, {
                              vaultIds: p.allVaultIds?.length ? p.allVaultIds : p.vaultId ? [p.vaultId] : undefined,
                              bundleId: p.bundleId,
                            })
                          }
                          disabled={isBusy || !walletReady}
                          title={matured ? "Redeem at maturity" : "Exit this tranche early — pro-rata payout"}
                          style={redeemBtn(C.amber, C.amber, isBusy, walletReady)}
                        >
                          {isBusy ? "Redeeming…" : "Redeem"}
                        </button>
                      </div>
                      {errMsg && <div style={{ marginTop: 10, fontSize: 11, fontFamily: FS, color: C.red }}>{errMsg}</div>}
                    </div>
                  ),
                });
              });

              effectivePpnVaults.forEach((v) => {
                const principal = Number.isFinite(v.principal) ? v.principal : 0;
                const apy = Number.isFinite(v.apy) ? v.apy : 0;
                const hasTerm = Number.isFinite(v.createdAt) && Number.isFinite(v.maturityDays);
                const elapsed = hasTerm ? Math.max(0, (renderNow - v.createdAt) / 86_400_000) : 0;
                const accrued = hasTerm ? principal * (apy / 100 / 365) * Math.min(elapsed, v.maturityDays) : 0;
                const value = principal + accrued;
                const rowKey = `ppn-${v.id}`;
                const maturityMs = hasTerm ? v.createdAt + v.maturityDays * 86_400_000 : null;
                const matured = maturityMs != null ? maturityMs <= renderNow : false;
                const isBusy = redeemBusy === rowKey;
                const errMsg = redeemError[rowKey];
                const maturityLabel = maturityMs != null
                  ? new Date(maturityMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                  : null;
                rows.push({
                  key: rowKey,
                  value,
                  el: (
                    <div key={rowKey} style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                        <div style={{ fontSize: 9.5, color: C.violet, fontFamily: FM, letterSpacing: "0.12em" }}>PROTECTED NOTE</div>
                        <Link href="/app/ppn" style={{ fontSize: 11, color: C.violet, fontFamily: FS, textDecoration: "none" }}>View all →</Link>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                          <div style={{ width: 4, height: 24, borderRadius: 2, background: C.violet, flexShrink: 0 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD }}>{v.bundleId}</div>
                            <div style={{ fontSize: 10.5, color: C.textMuted, fontFamily: FM, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{hasTerm ? `${apy.toFixed(2)}% APY · ${Math.round(v.maturityDays)}d maturity` : "Principal-protected note"}</div>
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 14, color: C.textPrimary, fontFamily: FD, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(value, 2)}</div>
                          {accrued > 0 && <div style={{ fontSize: 11, color: C.green, fontFamily: FM, marginTop: 2 }}>+{fmtUsd(accrued, 2)}</div>}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, paddingTop: 12, borderTop: `0.5px solid ${C.border}` }}>
                        <div style={{ fontSize: 10, color: matured ? C.green : C.textMuted, fontFamily: FM, letterSpacing: "0.06em" }}>
                          {matured ? "MATURED" : maturityLabel ? `MATURES ${maturityLabel.toUpperCase()}` : "MATURITY UNKNOWN"}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRedeemPpn(rowKey, { vaultIds: v.allVaultIds ?? [v.id], bundleId: v.bundleId })}
                          disabled={isBusy || !walletReady}
                          title={matured ? "Redeem at maturity" : "Redeem this note early — principal-protected payout"}
                          style={redeemBtn(C.violet, C.violet, isBusy, walletReady)}
                        >
                          {isBusy ? "Redeeming…" : "Redeem"}
                        </button>
                      </div>
                      {errMsg && <div style={{ marginTop: 10, fontSize: 11, fontFamily: FS, color: C.red }}>{errMsg}</div>}
                    </div>
                  ),
                });
              });

              effectiveDistPositions.forEach((p) => {
                const collateral = Number.isFinite(p.collateral_usdc) ? p.collateral_usdc : 0;
                const maxProfit = Number.isFinite(p.max_profit_usdc) ? p.max_profit_usdc : 0;
                const rowKey = `dist-${p.id}`;
                rows.push({
                  key: rowKey,
                  value: collateral,
                  el: (
                    <div key={rowKey} style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                        <div style={{ fontSize: 9.5, color: C.coral, fontFamily: FM, letterSpacing: "0.12em" }}>DISTRIBUTION MARKET</div>
                        <Link href="/app/distribution" style={{ fontSize: 11, color: C.coral, fontFamily: FS, textDecoration: "none" }}>View all →</Link>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                          <div style={{ width: 4, height: 24, borderRadius: 2, background: C.coral, flexShrink: 0 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.question}</div>
                            <div style={{ fontSize: 10.5, color: C.textMuted, fontFamily: FM, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>μ {Math.round(p.target_mu)} · σ {Math.round(p.target_sigma)} · max {fmtUsd(maxProfit, 2)}</div>
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 14, color: C.textPrimary, fontFamily: FD, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(collateral, 2)}</div>
                          <div style={{ fontSize: 10, color: C.textMuted, fontFamily: FM, marginTop: 2 }}>at risk</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, paddingTop: 12, borderTop: `0.5px solid ${C.border}` }}>
                        <div style={{ fontSize: 10, color: C.textMuted, fontFamily: FM, letterSpacing: "0.06em" }}>OPEN · CONTINUOUS</div>
                        <Link href="/app/distribution" style={{ padding: "7px 16px", fontSize: 12, fontFamily: FD, fontWeight: 500, letterSpacing: "0.02em", borderRadius: 8, border: `0.5px solid ${C.coral}`, background: `${C.coral}24`, color: C.coral, textDecoration: "none" }}>Settle →</Link>
                      </div>
                    </div>
                  ),
                });
              });

              openSimPositions.forEach((p) => {
                const rowKey = `sim-${p.sim_id}`;
                const prodLabel = ({ strip: "DEEPBOOK STRIP", option: "OPTION", vol: "VOLATILITY", dist: "DISTRIBUTION" } as Record<string, string>)[p.product] ?? "POSITION";
                rows.push({
                  key: rowKey,
                  value: p.premium_usd,
                  el: (
                    <div key={rowKey} style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
                      <div style={{ fontSize: 9.5, color: C.blue, fontFamily: FM, letterSpacing: "0.12em", marginBottom: 12 }}>{prodLabel} · mUSDC</div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                          <div style={{ width: 4, height: 24, borderRadius: 2, background: C.blue, flexShrink: 0 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                            <div style={{ fontSize: 10.5, color: C.textMuted, fontFamily: FM, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>premium {fmtUsd(p.premium_usd, 2)} · max {fmtUsd(p.max_payout_usd, 2)} mUSDC</div>
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 14, color: C.textPrimary, fontFamily: FD, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(p.premium_usd, 2)}</div>
                          <div style={{ fontSize: 10, color: C.textMuted, fontFamily: FM, marginTop: 2 }}>at risk</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, paddingTop: 12, borderTop: `0.5px solid ${C.border}` }}>
                        <div style={{ fontSize: 10, color: C.textMuted, fontFamily: FM, letterSpacing: "0.06em" }}>OPEN · PELAGOS USDC</div>
                        <button onClick={() => settleSimPosition(p.sim_id)} disabled={simBusy === p.sim_id} style={{ padding: "7px 16px", fontSize: 12, fontFamily: FD, fontWeight: 500, letterSpacing: "0.02em", borderRadius: 8, border: `0.5px solid ${C.blue}`, background: `${C.blue}24`, color: C.blue, cursor: simBusy === p.sim_id ? "default" : "pointer", opacity: simBusy === p.sim_id ? 0.6 : 1 }}>{simBusy === p.sim_id ? "Settling…" : "Settle →"}</button>
                      </div>
                    </div>
                  ),
                });
              });

              if (liveUsdc > 0) {
                rows.push({
                  key: "usdc",
                  value: liveUsdc,
                  el: (
                    <div key="usdc" style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
                      <div style={{ fontSize: 9.5, color: C.textMuted, fontFamily: FM, letterSpacing: "0.12em", marginBottom: 12 }}>CASH</div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div style={{ width: 4, height: 24, borderRadius: 2, background: "#4a5a6a" }} />
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD }}>USDC</div>
                            <div style={{ fontSize: 10.5, color: C.textMuted, fontFamily: FM, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(liveMusdc, 2)} mUSDC + {fmtUsd(liveDusdc, 2)} dUSDC · 1:1 USD</div>
                          </div>
                        </div>
                        <div style={{ fontSize: 14, color: C.textPrimary, fontFamily: FD, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(liveUsdc, 2)}</div>
                      </div>
                    </div>
                  ),
                });
              }

              rows.sort((a, b) => b.value - a.value);
              if (rows.length === 0) {
                return (
                  <div className="pf-card" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "34px 20px" }}>
                    <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 17, fontWeight: 600, marginBottom: 6 }}>
                      No open positions yet
                    </div>
                    <div style={{ color: C.textSecondary, fontFamily: FS, fontSize: 13 }}>
                      New market baskets, risk slices, and protected notes will appear here after execution.
                    </div>
                  </div>
                );
              }
              return rows.map((r) => r.el);
            })()}
            </div>
          </>
        )}
      </PageFrame>
    </>
  );
}

// Shared redeem-button style. Accent border + tinted fill when actionable.
function redeemBtn(border: string, text: string, isBusy: boolean, walletReady: boolean): React.CSSProperties {
  const live = !isBusy && walletReady;
  return {
    padding: "7px 16px",
    fontSize: 12,
    fontFamily: FD,
    fontWeight: 500,
    letterSpacing: "0.02em",
    borderRadius: 8,
    cursor: live ? "pointer" : "not-allowed",
    border: `0.5px solid ${live ? border : "rgba(255,255,255,0.08)"}`,
    background: live ? `${border}1f` : "transparent",
    color: live ? text : C.textMuted,
    opacity: isBusy ? 0.6 : 1,
    transition: `all 0.15s ${EASE}`,
  };
}
