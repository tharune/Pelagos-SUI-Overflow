"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Header, PageFrame } from "../_components/Header";
import { C, FS, FD, FM, EASE, tc, trancheColor, fmtUsd } from "../_lib/tokens";
import { useLiveBaskets } from "../_lib/use-live-baskets";
import { bundleById } from "../_lib/bundles";
import { useSandbox, type BasketPosition } from "../_lib/demo-state";
import { useActiveWalletAddress, useUsdcBalance, useWalletSigner } from "../_lib/wallet-bridge";
import { shortAddress } from "../_lib/chain";
import { fetchBasketPortfolio, usePbuBalances } from "../_lib/portfolio-client";
import { fetchPpnPortfolio, ppnRedeem, PpnError } from "../_lib/ppn-client";
import { mergePpnVaults, mergeTranches } from "../_lib/ppn-hydrate";
import { redeemFromBundle, DepositError } from "../_lib/deposit-client";
import {
  groupVirtualByUiBundle,
  clearVirtualPositionsByUiBundleId,
  type GroupedVirtualPosition,
} from "../_lib/virtual-positions";
import { Personalization } from "./_personalization";
import { History } from "./_history";
import {
  fetchContinuousPositions,
  type ContinuousPosition,
} from "../_lib/distribution-continuous-client";

type View = "positions" | "personalization" | "history";

// Catmull-Rom → cubic-bezier smoothing for a clean institutional curve.
function smoothLine(pts: Array<[number, number]>, tension = 0.18): string {
  if (pts.length < 2) return "";
  const d = [`M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) * tension;
    const c1y = p1[1] + (p2[1] - p0[1]) * tension;
    const c2x = p2[0] - (p3[0] - p1[0]) * tension;
    const c2y = p2[1] - (p3[1] - p1[1]) * tension;
    d.push(`C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`);
  }
  return d.join(" ");
}

function AccountValueChart({ value, pnl }: { value: number; pnl: number }) {
  const width = 520;
  const height = 128;
  const padX = 6;
  const padY = 18;
  // A funded account with movement gets a real curve; a flat / empty account
  // gets a calm baseline that reads as "no activity yet" — not a broken line.
  const hasMotion = value > 0.01 && Math.abs(pnl) >= 0.01;
  const base = Math.max(value - pnl, 1);
  const drift = Math.max(Math.abs(pnl), base * 0.012);
  const values = hasMotion
    ? [
        base - drift * 0.85,
        base - drift * 0.32,
        base - drift * 0.5,
        base + pnl * 0.22,
        base + pnl * 0.5,
        base + pnl * 0.82,
        value,
      ].map((v) => Math.max(0, v))
    : [value, value, value, value, value, value, value];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const isFlat = Math.abs(max - min) < 0.0001;
  const range = Math.max(1, max - min);
  const x = (index: number) => padX + (index / (values.length - 1)) * (width - padX * 2);
  // Flat → seat the baseline ~62% down so the gradient reads as a quiet floor.
  const y = (point: number) => (isFlat ? height * 0.62 : padY + (1 - (point - min) / range) * (height - padY * 2));
  const pts = values.map((point, index): [number, number] => [x(index), y(point)]);
  const line = smoothLine(pts);
  const area = `${line} L ${x(values.length - 1).toFixed(1)} ${height} L ${x(0).toFixed(1)} ${height} Z`;
  const stroke = pnl >= 0 ? C.tealLight : C.coral;
  const end = pts[pts.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="128" aria-label="Account value trend">
      <defs>
        <linearGradient id="portfolioValueFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={isFlat ? "0.12" : "0.22"} />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#portfolioValueFill)" />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeOpacity={isFlat ? 0.7 : 1}
        style={{ filter: `drop-shadow(0 1px 6px ${stroke}33)` }}
      />
      <circle cx={end[0]} cy={end[1]} r={4} fill={stroke} />
      <circle cx={end[0]} cy={end[1]} r={8} fill="none" stroke={stroke} strokeWidth="1" opacity="0.3" />
    </svg>
  );
}

export default function PortfolioPage() {
  const { state, totals, dispatch } = useSandbox();
  const appWalletAddress = useActiveWalletAddress();
  const usdc = useUsdcBalance();
  const walletSigner = useWalletSigner();
  const [redeemBusy, setRedeemBusy] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<Record<string, string>>({});
  const basketState = useLiveBaskets();
  // Authoritative on-chain PBU unit balances per bundle. Polls the active
  // chain every 15s and zeroes out to empty entries when the wallet is
  // disconnected. This is the ONLY source we trust for "how many basket
  // tokens does this wallet actually own" — any cancelled deposit never
  // mints PBU so it contributes $0 here regardless of what optimistic UI
  // state or stale Supabase rows claim.
  const pbuBalances = usePbuBalances();
  // Authoritative on-chain PBU qty per bundle UUID. Computed once here and
  // reused by every gating path below (tranches, PPNs, virtual groups,
  // residuals). Bundles without a positive balance are absent from the map.
  // Hoisted out of the render block so the headline / donut / breakdown
  // totals can share the same filter as the card list — previously the
  // totals used reducer state directly and leaked cancelled-tx rows into
  // the top-of-page numbers even though the cards below filtered them out.
  const pbuTokensByUuid = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const entry of pbuBalances.balances) {
      if (entry.uiAmount > 0) out[entry.bundleId] = entry.uiAmount;
    }
    return out;
  }, [pbuBalances.balances]);
  // Single source of truth for "is there a wallet we can attribute balances
  // to". Every aggregate downstream (donut, PnL, totals, position rows) is
  // gated on this so a disconnected session can never show a stale balance
  // leftover from a previous connection. Fixes portfolio reporting non-zero
  // numbers both on fresh load (before wallet connect) and after disconnect.
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
  // Cash line is the real on-chain USDC in the connected wallet. When
  // disconnected we fall back to 0 so the donut + positions list simply
  // omit the cash slice instead of flashing a stale sandbox counter.
  const liveUsdc = walletReady ? usdc.uiAmount : 0;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renderNow, setRenderNow] = useState<number>(() => Date.now());
  const [view, setView] = useState<View>("positions");
  const [distPositions, setDistPositions] = useState<ContinuousPosition[]>([]);
  useEffect(() => {
    const t = setInterval(() => setRenderNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Position buckets are independent on the three product rails:
  //   - Baskets are the user's PBU unit balance × live NAV. PBU only
  //     lands in the user's wallet via a basket deposit (PPN / tranche
  //     deposits swap USDC into a product-owned Sui position and hand back
  //     a product receipt, so on-chain PBU presence IS the
  //     source of truth for basket exposure.
  //   - Tranche / PPN rows come from the backend, which we've taught
  //     to filter by `onchain_tx_signature IS NOT NULL` — i.e. only
  //     rows where the user's note-initialize tx actually landed.
  //     Cancelled-in-wallet deposits therefore never reach the reducer,
  //     so we can trust reducer state directly here.
  // There is no double-counting between the buckets: a user's PBU
  // balance and a note vault's principal are different assets.
  const effectiveTranches = walletReady ? state.tranchePositions : [];
  const effectivePpnVaults = walletReady ? state.ppnVaults : [];
  // PPN accrued yield, ticking with renderNow so the top-of-page P&L moves
  // in real time. Matches the per-vault card math (`principal * apy% / 365`
  // capped at maturity). This is what makes PPN positions contribute to
  // unrealized P&L — the demo-state totals only know about basket drift.
  const ppnAccruedYield = effectivePpnVaults.reduce((sum, v) => {
    // Guard every field: a freshly-opened note can arrive before the indexer
    // has filled in created_at / days_* / estimated_apy, which would otherwise
    // make this term NaN and poison the headline, P&L, and allocation totals.
    const principal = Number.isFinite(v.principal) ? v.principal : 0;
    const apy = Number.isFinite(v.apy) ? v.apy : 0;
    const maturityDays = Number.isFinite(v.maturityDays) ? v.maturityDays : 0;
    const createdAt = Number.isFinite(v.createdAt) ? v.createdAt : renderNow;
    const elapsedDays = Math.max(0, (renderNow - createdAt) / 86_400_000);
    const accrued =
      principal * (apy / 100 / 365) * Math.min(elapsedDays, maturityDays);
    return sum + accrued;
  }, 0);
  // Tranche accrued yield. Principal is qty*avgCost (frozen at entry) because
  // the backend doesn't mark tranches to market — so without this term the
  // Risk Slices row and the headline P&L would never move, no matter how long
  // the position had been held. Straight-line accrual against `estimated_apy`
  // is the same approximation used for PPNs, capped at maturity.
  const trancheAccruedYield = effectiveTranches.reduce((sum, p) => {
    if (p.apy == null || p.createdAt == null || p.maturityDays == null) return sum;
    const principal = p.qty * p.avgCost;
    const elapsedDays = Math.max(0, (renderNow - p.createdAt) / 86_400_000);
    const accrued =
      principal * (p.apy / 100 / 365) * Math.min(elapsedDays, p.maturityDays);
    return sum + accrued;
  }, 0);
  // Principal sums for the filtered (on-chain-backed) rows. Replace
  // `totals.trancheValue` / `totals.ppnValue` everywhere below so the
  // headline, donut, and breakdown all agree with the card list.
  const effectiveTrancheValue = effectiveTranches.reduce((sum, p) => {
    const v = p.qty * p.avgCost;
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
  const effectivePpnValue = effectivePpnVaults.reduce(
    (sum, v) => sum + (Number.isFinite(v.principal) ? v.principal : 0),
    0,
  );
  // Open continuous distribution positions. Collateral is escrowed on-chain
  // at open; we surface it as value-at-risk in the headline + a product row.
  // Settled positions have already paid out to USDC (counted in liveUsdc), so
  // only unsettled positions contribute here — no double counting.
  const effectiveDistPositions = walletReady
    ? distPositions.filter((p) => !p.settled)
    : [];
  const distValue = effectiveDistPositions.reduce(
    (sum, p) => sum + (Number.isFinite(p.collateral_usdc) ? p.collateral_usdc : 0),
    0,
  );
  // On-chain NAV lookup for a backend bundle id (UUID). We key `pbuBalances`
  // off the same UUIDs the backend returns, and the live feed is keyed off
  // the PBU-TIER-WINDOW name, so we cross-reference via `bundleName`. The
  // live feed wins when available — falling through to the balance's own
  // cached NAV and then to the hydrated entry price means a single stale
  // cell never produces a $0 position.
  const navForOnchainBundle = React.useCallback(
    (entry: { bundleId: string; bundleName: string; nav: number }): number => {
      if (basketState.status === "ok") {
        const live =
          basketState.baskets.find((b) => b.id === entry.bundleName) ??
          basketState.baskets.find((b) => b.id === entry.bundleId);
        if (live) return live.nav;
      }
      const seed = bundleById(entry.bundleName) ?? bundleById(entry.bundleId);
      if (seed) return seed.nav;
      return entry.nav;
    },
    [basketState],
  );

  // On-chain basket value used in the top-line total. We value each
  // bundle at the wallet's **cost basis** (avgCost × qty) whenever the
  // reducer has a hydrated position for that bundleId, and only fall
  // back to live NAV when we don't know what the user paid. Reasoning:
  // the vault mints units at a fixed `issue_price_bps`, which is
  // typically below live NAV, so valuing at NAV right after a deposit
  // makes the orbit appear to grow by the issue-vs-NAV differential
  // (user-reported bug: spend $100, see total go up $4). The NAV delta
  // still shows up in the separate `displayPnl` line below.
  const onchainBasketValue = walletReady
    ? virtualGroupsForWallet.reduce((sum, g) => sum + g.depositedUsdc, 0)
    : 0;

  // Basket unrealized P&L is intentionally zero for active positions.
  //
  // The old computation (qty × (nav - avgCost)) is a NAV-based fantasy:
  //   - the Sui product issues PBU at a fixed `issue_price_bps` (set at
  //     bundle init), so depositing at a moment when live NAV > issue
  //     price immediately produces a "gain" that didn't exist,
  //   - early exit via `exit_active` pays the user's pro-rata share of
  //     the USDC pool (which ≈ what was deposited, net of fees), NOT
  //     qty × NAV — so any NAV drift doesn't actually materialize until
  //     the vault is finalized and redeemed at resolution.
  //
  // Showing a positive "Unrealized P&L" on a fresh deposit + then a small
  // loss on sell (because fees were real, the NAV gain wasn't) confused
  // every tester. We now return 0 for active baskets; real P&L surfaces
  // through (a) USDC credit after sell/redeem, and (b) PPN + tranche
  // yield accrual below, which are real Sui product accruals.
  const onchainBasketPnl = 0;

  // Top-line value: USDC + basket value (PBU × NAV) + tranche / PPN
  // principal + accrued yield + lend/loan. Tranche/PPN rows come from
  // the reducer, which is hydrated from the backend; the backend only
  // returns rows with `onchain_tx_signature IS NOT NULL`, so cancelled
  // rows never get here. lend/loan are pure reducer (no Sui object
  // token behind them) and unaffected by this pass.
  //
  // When disconnected every term is already zero (via walletReady gating
  // above), so the headline collapses to 0 without a separate guard.
  const displayTotal = walletReady
    ? liveUsdc +
      onchainBasketValue +
      effectiveTrancheValue +
      effectivePpnValue +
      ppnAccruedYield +
      trancheAccruedYield +
      distValue +
      totals.lendValue -
      totals.loanDebt
    : 0;
  const displayPnl = walletReady
    ? onchainBasketPnl + ppnAccruedYield + trancheAccruedYield
    : 0;

  // Hydrate basket positions from Supabase whenever the wallet connects
  // or changes. The reducer is in-memory only, so without this the portfolio
  // tab would look empty after any browser reload even when the user has
  // on-chain deposits in the DB.
  const hydratePortfolio = React.useCallback(async () => {
    if (!appWalletAddress) return;
    const wallet = appWalletAddress;
    await Promise.allSettled([
      fetchBasketPortfolio(wallet).then((positions) =>
        dispatch({ type: "basket/hydrate", positions }),
      ),
      fetchPpnPortfolio(wallet).then((portfolio) => {
        // Merge policy (dupe `bundle_id` → one card, dupe
        // `(bundle_id, tranche_kind)` → one card) lives in _lib/ppn-hydrate
        // so the PPN page sees the same merged shape on standalone visits.
        dispatch({ type: "ppn/hydrate", vaults: mergePpnVaults(portfolio) });
        dispatch({
          type: "tranche/hydrate",
          positions: mergeTranches(portfolio),
        });
      }),
      fetchContinuousPositions(wallet).then((r) =>
        setDistPositions(Array.isArray(r?.positions) ? r.positions : []),
      ),
    ]);
  }, [appWalletAddress, dispatch]);

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
      void usdc.refresh();
    } catch (err) {
      const msg =
        err instanceof DepositError
          ? err.message
          : err instanceof Error
            ? /user rejected/i.test(err.message)
              ? "Transaction was rejected in your wallet."
              : err.message
            : String(err);
      setRedeemError((prev) => ({ ...prev, [bundleId]: msg }));
    } finally {
      setRedeemBusy(null);
    }
  }

  /**
   * Redeem a PPN or tranche position. Both ride the `initialize_note` rail so
   * a single `ppnRedeem` call handles both. When `vaultIds` has more than
   * one id, the merged card stands for multiple on-chain notes (same
   * bundle_id, two deposits) and we redeem each in sequence. Falls back to
   * (bundleId, wallet) when no explicit vault ids are provided so the
   * backend can resolve via `getActivePPNVault`.
   */
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
        // Redeem every underlying vault sequentially. Sequential keeps the
        // wallet popup flow deterministic (one approval at a time) and lets
        // us bail on the first failure without leaving a partial state on
        // subsequent vaults.
        for (const vaultId of ids) {
          await ppnRedeem({ wallet: walletSigner, vaultId });
        }
      } else {
        await ppnRedeem({
          wallet: walletSigner,
          bundleId: opts.bundleId,
        });
      }
      await hydratePortfolio();
      void usdc.refresh();
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

  // Live-first basket metadata lookup: if the live pipeline has this
  // id we use the live NAV so open positions track the real feed, and
  // fall back to the seed Bundle only when the live feed doesn't have
  // coverage for that id (offline mode, missing live row, etc.).
  const resolveBasket = (id: string) => {
    if (basketState.status === "ok") {
      const live = basketState.baskets.find((b) => b.id === id);
      if (live) {
        return {
          id: live.id,
          tier: live.tier,
          nav: live.nav,
        };
      }
    }
    const seed = bundleById(id);
    return seed
      ? { id: seed.id, tier: seed.tier, nav: seed.nav }
      : null;
  };

  // Live row values — same sources as displayTotal so the headline, product
  // cards, and detailed position rows all reconcile.
  const productRows: Array<{
    id: string;
    label: string;
    description: string;
    value: number;
    color: string;
    href?: string;
  }> = [
    {
      id: "cash",
      label: "Cash",
      description: "Sui testnet mUSDC available",
      value: liveUsdc,
      color: C.textMuted,
    },
    {
      id: "baskets",
      label: "Market Baskets",
      description: "Basket units held directly",
      value: onchainBasketValue,
      color: C.tealLight,
      href: "/app/basket",
    },
    {
      id: "tranches",
      label: "Risk Slices",
      description: "Senior, mezzanine, and junior exposure",
      value: effectiveTrancheValue + trancheAccruedYield,
      color: C.amber,
      href: "/app/tranche",
    },
    {
      id: "ppn",
      label: "Protected Notes",
      description: "Principal-protected notes",
      value: effectivePpnValue + ppnAccruedYield,
      color: C.violet,
      href: "/app/ppn",
    },
    {
      id: "distribution",
      label: "Distribution Markets",
      description: "Continuous μ/σ positions · collateral at risk",
      value: distValue,
      color: C.coral,
      href: "/app/distribution",
    },
    {
      id: "lending",
      label: "Lending",
      description: "Sui DeFi routing",
      value: totals.lendValue,
      color: C.blue,
    },
  ];
  const productTotal = productRows.reduce((sum, row) => sum + row.value, 0);
  const fundedProductCount = productRows.filter((row) => row.value > 0.000001).length;
  const accountLabel = walletReady
    ? `Sui testnet · ${appWalletAddress ? shortAddress(appWalletAddress) : "local signer"}`
    : "Wallet not connected";

  return (
    <>
      <style>{`
        .portfolio-tabs {
          display: flex; gap: 2px; padding: 3px; background: ${C.surface};
          border: 0.5px solid ${C.border}; border-radius: 8px;
        }
        .portfolio-tab {
          border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer;
          font-family: ${FD}; font-size: 12px; letter-spacing: 0.01em;
          background: transparent; color: ${C.textSecondary};
          transition: color 0.15s ${EASE}, background 0.15s ${EASE};
        }
        .portfolio-tab:hover { color: ${C.textPrimary}; }
        .portfolio-tab.active { background: ${C.card}; color: ${C.tealLight}; font-weight: 600; }
        .portfolio-overview {
          display: grid; grid-template-columns: minmax(360px, 0.82fr) minmax(420px, 1.18fr);
          gap: 14px; margin-bottom: 18px;
        }
        .portfolio-panel {
          background: ${C.card}; border: 0.5px solid ${C.border}; border-radius: 10px; padding: 22px;
        }
        .portfolio-card {
          background: ${C.card}; border: 0.5px solid ${C.border}; border-radius: 10px; padding: 18px;
        }
        .portfolio-metric-row {
          display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px;
          margin-top: 28px; padding-top: 20px; border-top: 0.5px solid ${C.border};
        }
        .portfolio-allocation {
          display: grid; gap: 0;
        }
        .portfolio-allocation-row {
          display: grid; grid-template-columns: minmax(0, 1fr) 116px 74px;
          gap: 16px; align-items: center; padding: 15px 0;
          border-top: 0.5px solid ${C.border}; text-decoration: none;
          transition: opacity 0.15s ${EASE}, background 0.15s ${EASE};
        }
        .portfolio-allocation-row:first-child { border-top: 0; }
        .portfolio-allocation-row:hover { opacity: 0.86; }
        .portfolio-spark {
          height: 6px; border-radius: 999px; background: ${C.surface}; overflow: hidden;
        }
        .portfolio-spark span { display: block; height: 100%; border-radius: inherit; }
        .portfolio-section-head {
          display: flex; align-items: end; justify-content: space-between; gap: 16px;
          margin: 16px 0 10px;
        }
        .portfolio-value-chart {
          margin-top: 22px;
          border-top: 0.5px solid ${C.border};
          padding-top: 14px;
          opacity: 0.94;
        }
        @media (max-width: 1120px) {
          .portfolio-overview { grid-template-columns: 1fr; }
        }
        @media (max-width: 760px) {
          .portfolio-page-head { align-items: flex-start !important; flex-direction: column; }
          .portfolio-tabs { width: 100%; overflow-x: auto; }
          .portfolio-metric-row { grid-template-columns: 1fr; gap: 12px; }
          .portfolio-allocation-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
        }
      `}</style>
      <Header />
      <PageFrame>
        <div className="portfolio-page-head" style={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: 20, marginBottom: 18, paddingBottom: 14, borderBottom: `0.5px solid ${C.border}` }}>
          <div>
            <div style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.14em", color: C.tealLight, fontWeight: 700, marginBottom: 8, textTransform: "uppercase" }}>
              {view === "positions"
                ? "Portfolio"
                : view === "personalization"
                  ? "Allocation"
                  : "Portfolio ledger"}
            </div>
            <h1 style={{ margin: 0, color: C.textPrimary, fontFamily: FD, fontSize: "clamp(30px, 3.4vw, 46px)", lineHeight: 1.04, letterSpacing: "-0.03em", fontWeight: 500 }}>
              {view === "positions"
                ? "Portfolio"
                : view === "personalization"
                  ? "Portfolio builder"
                  : "Activity"}
            </h1>
            {view !== "positions" && (
              <div style={{ fontSize: 14, color: C.textSecondary, fontFamily: FS, marginTop: 8 }}>
                {view === "personalization"
                  ? "Build an allocation shaped by risk tolerance, capital, and objective."
                  : "A chronological ledger of buys, exits, and note actions."}
              </div>
            )}
          </div>
          <div className="portfolio-tabs">
            {([
              { id: "positions", label: "Overview" },
              { id: "personalization", label: "Allocation" },
              { id: "history", label: "History" },
            ] as const).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setView(t.id)}
                className={`portfolio-tab${view === t.id ? " active" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {view === "personalization" ? (
          <Personalization />
        ) : view === "history" ? (
          <History
            walletAddress={appWalletAddress}
            connected={walletReady}
          />
        ) : (
        <>
        <section className="portfolio-overview" aria-label="Portfolio account overview">
          <div className="portfolio-panel" style={{ display: "grid", alignContent: "space-between", minHeight: 256 }}>
            <div>
              <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 12 }}>
                Net account value
              </div>
              <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: "clamp(42px, 5vw, 66px)", lineHeight: 0.96, letterSpacing: "-0.045em", fontWeight: 600 }}>
                {fmtUsd(displayTotal, 2)}
              </div>
              <div style={{ color: C.textSecondary, fontFamily: FS, fontSize: 13, marginTop: 12 }}>
                {accountLabel}
              </div>
              <div className="portfolio-value-chart">
                <AccountValueChart value={displayTotal} pnl={displayPnl} />
              </div>
            </div>

            <div className="portfolio-metric-row">
              <div>
                <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase" }}>P&L</div>
                <div style={{ color: displayPnl >= 0 ? C.green : C.red, fontFamily: FD, fontSize: 20, fontWeight: 600, marginTop: 7 }}>
                  {displayPnl >= 0 ? "+" : ""}{fmtUsd(displayPnl, 2)}
                </div>
              </div>
              <div>
                <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase" }}>Funded</div>
                <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 20, fontWeight: 600, marginTop: 7 }}>{fundedProductCount}</div>
              </div>
              <div>
                <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase" }}>Network</div>
                <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 20, fontWeight: 600, marginTop: 7 }}>Sui</div>
              </div>
            </div>
          </div>

          <div className="portfolio-panel">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 18, marginBottom: 8 }}>
              <div>
                <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
                  Allocation
                </div>
                <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 20, fontWeight: 600 }}>
                  Product balances
                </div>
              </div>
              <div style={{ color: C.textSecondary, fontFamily: FS, fontSize: 13 }}>{fmtUsd(productTotal, 2)}</div>
            </div>

            <div className="portfolio-allocation">
              {productRows.map((row) => {
                const share = productTotal > 0 ? (row.value / productTotal) * 100 : 0;
                const active = activeId === row.id;
                const content = (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "10px minmax(0, 1fr)", gap: 12, alignItems: "center" }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: row.color, opacity: row.value > 0 ? 1 : 0.45 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {row.label}
                        </div>
                        <div style={{ color: C.textSecondary, fontFamily: FS, fontSize: 12, lineHeight: 1.35, marginTop: 2 }}>
                          {row.description}
                        </div>
                      </div>
                    </div>
                    <div>
                      <div className="portfolio-spark">
                        <span style={{ width: `${Math.max(1, Math.min(100, share))}%`, background: row.color, opacity: row.value > 0 ? 0.95 : 0.18 }} />
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 14, fontWeight: 600 }}>{fmtUsd(row.value, 2)}</div>
                      <div style={{ color: active ? row.color : C.textMuted, fontFamily: FM, fontSize: 10, marginTop: 3 }}>{(share ?? 0).toFixed(1)}%</div>
                    </div>
                  </>
                );
                const commonProps = {
                  className: "portfolio-allocation-row",
                  onMouseEnter: () => setActiveId(row.id),
                  onMouseLeave: () => setActiveId(null),
                };
                return row.href ? (
                  <Link key={row.id} href={row.href} {...commonProps}>
                    {content}
                  </Link>
                ) : (
                  <div key={row.id} {...commonProps}>
                    {content}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <div className="portfolio-section-head">
          <div>
            <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 5 }}>
              Positions
            </div>
          </div>
        </div>

        {/* Positions - sorted by value descending, USDC included */}
        {(() => {
          // No wallet → no position cards. The disconnect-sweep useEffect
          // above clears the reducer, but until React re-runs this pass
          // we could still iterate stale state.basketPositions for one
          // tick; hard-gating here closes that race so no card ever flashes
          // on a disconnected portfolio.
          if (!walletReady) {
            return (
              <div className="portfolio-card" style={{ textAlign: "center", padding: "34px 20px" }}>
                <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
                  Connect a wallet to view balances
                </div>
                <div style={{ color: C.textSecondary, fontFamily: FS, fontSize: 13 }}>
                  Portfolio data is pulled from the connected account and the Sui-backed backend indexer.
                </div>
              </div>
            );
          }
          // Build all position rows with value for sorting
          const rows: { value: number; el: React.ReactNode; key: string }[] = [];

          // Pull every virtual-position group the user has deposited. Each
          // group corresponds to a distinct synthetic id (e.g. PBU-HIGH-
          // SHORT) and becomes its own card, even when multiple synthetic
          // ids share a single on-chain UUID.
          const virtualGroups: GroupedVirtualPosition[] = virtualGroupsForWallet;
          // `onchainTokensByUuid` is hoisted to component scope (shared with
          // the headline/donut totals). Basket cards gate on positive
          // on-chain PBU balance so stale reducer rows can't
          // produce ghost cards that don't match the wallet.
          const virtualTokensByUuid = virtualGroups.reduce<Record<string, number>>(
            (acc, g) => {
              acc[g.uuid] = (acc[g.uuid] ?? 0) + g.tokens;
              return acc;
            },
            {},
          );
          // Map uuid → a representative uiBundleId from any virtual group.
          // When a residual position exists for a UUID the user has ALSO
          // deposited into via a synthetic id, borrowing that id gives us
          // the user's intent (they picked PBU-MID-SHORT, so the residual
          // card should label + route the same way). Picking the largest
          // group by token count stays stable under duplicate ids.
          const uiBundleIdByUuid = virtualGroups.reduce<Record<string, { id: string; tokens: number }>>(
            (acc, g) => {
              const prev = acc[g.uuid];
              if (!prev || g.tokens > prev.tokens) {
                acc[g.uuid] = { id: g.uiBundleId, tokens: g.tokens };
              }
              return acc;
            },
            {},
          );

          // Derive a frontend PBU- label for a residual on-chain position
          // whose bundleId is a backend UUID (so resolveBasket misses).
          // Preference order:
          //   1. Use p.displayName if the backend already stored a
          //      PBU-TIER-WINDOW name (new seed) — that's the authoritative
          //      basket identity and it routes directly to /app/basket/[id].
          //   2. Borrow the user's own uiBundleId if they have any virtual
          //      group for this UUID — that's their actual intent.
          //   3. Match the live grid by tier + closest daysLeft to the
          //      backend's maturityAt. Keeps (tier, window) semantics even
          //      for pre-ledger deposits.
          //   4. Match any seed bundle with the same tier (window unknown,
          //      but at least the tier + PBU- format is correct).
          // Returns null when even the tier is unknown — caller falls back
          // to whatever p.displayName was.
          const deriveResidualLabel = (p: BasketPosition): {
            labelId: string;
            tier: 90 | 70 | 50;
            nav: number;
          } | null => {
            if (p.displayName && /^PBU-(HIGH|MID|LOW)-(SHORT|MED|LONG)$/.test(p.displayName)) {
              const live = basketState.status === "ok"
                ? basketState.baskets.find((b) => b.id === p.displayName)
                : null;
              const tier = live?.tier ?? p.tier;
              const nav = live?.nav ?? p.navHint;
              if (tier != null && nav != null) {
                return { labelId: p.displayName, tier, nav };
              }
            }
            const borrowed = uiBundleIdByUuid[p.bundleId];
            if (borrowed) {
              const live = basketState.status === "ok"
                ? basketState.baskets.find((b) => b.id === borrowed.id)
                : null;
              const tier = live?.tier ?? p.tier;
              const nav = live?.nav ?? p.navHint;
              if (tier != null && nav != null) {
                return { labelId: borrowed.id, tier, nav };
              }
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
                        const bMaturity = b.daysLeft != null
                          ? Date.now() + b.daysLeft * 86_400_000
                          : null;
                        const diff = bMaturity == null
                          ? Number.POSITIVE_INFINITY
                          : Math.abs(bMaturity - target);
                        return { b, diff };
                      })
                      .sort((a, z) => a.diff - z.diff)[0].b;
                return { labelId: pick.id, tier: pick.tier, nav: pick.nav };
              }
            }
            const seed = bundleById(`PBU-${tierGuess === 90 ? "HIGH" : tierGuess === 70 ? "MID" : "LOW"}-SHORT`);
            if (seed) {
              return { labelId: seed.id, tier: seed.tier, nav: p.navHint ?? seed.nav };
            }
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
            // Cost basis for the card value — matches the top-line Total,
            // donut slice, and breakdown row. We intentionally do NOT
            // show a NAV-based unrealized P&L badge here: early-exit
            // uses `exit_active`'s pool-ratio payout (≈ cost), so the
            // NAV drift isn't realizable until the vault is finalized
            // at resolution. Keeping pnl=0 on the card (and in the
            // top-line onchainBasketPnl above) prevents the confusing
            // "appears +$4 right after buying → evaporates on sell"
            // sequence; real gains/losses still land on the USDC line
            // when the user actually transacts.
            const value = qty * avgCost;
            const pnl = 0;
            // Reference: `nav` is left unused on purpose. If we ever
            // resurface a NAV-vs-cost indicator it should be labelled
            // "Forward payout at resolution" (or similar) rather than
            // "Unrealized P&L", and plumbed through a separate field
            // so the top-line sums stay clean.
            void nav;
            const liveMatchById =
              basketState.status === "ok"
                ? basketState.baskets.find((b) => b.id === labelId)
                : null;
            const liveMaturityMs =
              liveMatchById?.daysLeft != null
                ? Date.now() + liveMatchById.daysLeft * 86_400_000
                : null;
            const effectiveMaturityMs = liveMaturityMs ?? maturityAt ?? null;
            const matured =
              status === "resolved" ||
              (effectiveMaturityMs != null && effectiveMaturityMs <= renderNow);
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
                  ? maturityDate.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  : null;
            const isBusy = redeemBusy === uuid;
            const errMsg = redeemError[uuid];
            // Human-readable conviction tag. Matches the wording on /basket
            // where each card shows "high/mid/low probability" under the id.
            const tierLabel = tier === 90 ? "High" : tier === 70 ? "Mid" : "Low";
            // Days-to-close: prefer the live feed, fall back to maturityAt
            // from the DB hydrate. Mirrors `formatDaysLeft` on /basket so the
            // wording is consistent between the index card and portfolio card.
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
            const contextLine = closesInLabel
              ? `${tierLabel}-conviction · ${closesInLabel}`
              : `${tierLabel}-conviction basket`;
            rows.push({
              key: cardKey,
              value,
              el: (
                <div key={cardKey} style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 20, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, letterSpacing: "0.08em" }}>MARKET BASKET</div>
                    <Link href="/app/basket" style={{ fontSize: 11, color: C.teal, fontFamily: FS, textDecoration: "none" }}>View all →</Link>
                  </div>
                  <Link href={`/app/basket/${labelId}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", textDecoration: "none" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <div style={{ width: 4, height: 24, borderRadius: 2, background: tc(tier) }} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD }}>{labelId}</div>
                        <div style={{ fontSize: 11, color: C.textSecondary, fontFamily: FS, marginTop: 2 }}>{contextLine}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, marginTop: 2 }}>{(qty ?? 0).toFixed(2)} units · avg ${(avgCost ?? 0).toFixed(3)}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, color: C.textPrimary, fontFamily: FD }}>{fmtUsd(value, 2)}</div>
                      <div style={{ fontSize: 11, color: pnl >= 0 ? C.green : C.red, fontFamily: FS, marginTop: 2 }}>{pnl >= 0 ? "+" : ""}{fmtUsd(pnl, 2)}</div>
                    </div>
                  </Link>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14, paddingTop: 14, borderTop: `0.5px solid ${C.border}` }}>
                    <div style={{ fontSize: 11, color: matured ? C.green : C.textMuted, fontFamily: FM, letterSpacing: "0.06em" }}>
                      {matured ? "MATURED" : maturityLabel ? `MATURES ${maturityLabel.toUpperCase()}` : "MATURITY UNKNOWN"}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        handleRedeem(uuid, labelId, qty);
                      }}
                      disabled={isBusy || !walletReady}
                      title={matured ? "Redeem at maturity" : "Exit this position early — pro-rata payout, small exit fee"}
                      style={{
                        padding: "7px 16px",
                        fontSize: 12,
                        fontFamily: FD,
                        fontWeight: 500,
                        letterSpacing: "0.02em",
                        borderRadius: 8,
                        cursor: !isBusy && walletReady ? "pointer" : "not-allowed",
                        border: `0.5px solid ${!isBusy && walletReady ? C.teal : "rgba(255,255,255,0.08)"}`,
                        background: !isBusy && walletReady ? "rgba(45, 212, 191, 0.12)" : "transparent",
                        color: !isBusy && walletReady ? C.tealLight : C.textMuted,
                        opacity: isBusy ? 0.6 : 1,
                        transition: `all 0.15s ${EASE}`,
                      }}
                    >
                      {isBusy ? "Redeeming…" : "Redeem"}
                    </button>
                  </div>
                  {errMsg && (
                    <div style={{ marginTop: 10, fontSize: 11, fontFamily: FS, color: C.red }}>
                      {errMsg}
                    </div>
                  )}
                </div>
              ),
            });
          };

          // Render one card per virtual group, using the NAV at deposit
          // time as the cost basis so PnL starts at zero. Crucially, we
          // cap qty at the wallet's on-chain PBU balance: if the user
          // redeemed / burned / transferred the tokens the virtual ledger
          // can't catch up on its own, so the chain is the final word.
          virtualGroups.forEach((g) => {
            const liveMatch =
              basketState.status === "ok"
                ? basketState.baskets.find((b) => b.id === g.uiBundleId)
                : null;
            const dbMatch = state.basketPositions.find((p) => p.bundleId === g.uuid);
            const tier = liveMatch?.tier ?? dbMatch?.tier;
            const nav = liveMatch?.nav ?? dbMatch?.navHint;
            if (tier == null || nav == null) return;
            // Gate every card on the authoritative on-chain balance. If
            // the wallet holds nothing for this bundle UUID, the card
            // disappears regardless of what the virtual ledger remembers.
            const onchainForUuid = onchainTokensByUuid[g.uuid] ?? 0;
            if (onchainForUuid <= 0.000001) return;
            const totalVirtualForUuid = virtualTokensByUuid[g.uuid] ?? 0;
            const share =
              totalVirtualForUuid > 0 ? g.tokens / totalVirtualForUuid : 1;
            const effectiveQty = Math.min(g.tokens, onchainForUuid * share);
            if (effectiveQty <= 0.000001) return;
            renderBasketCard({
              cardKey: `${g.uuid}::${g.uiBundleId}`,
              uuid: g.uuid,
              labelId: g.uiBundleId,
              qty: effectiveQty,
              // Actual USDC-per-token the user paid at deposit, not the
              // live Polymarket NAV snapshot (avgNavAtDeposit). The chain
              // mints at a fixed issue_price_bps, so NAV-at-deposit drifts
              // off the true cost basis whenever NAV != issue price.
              // Using the real cost keeps card PnL aligned with the
              // headline Unrealized P&L (which sums qty × (nav - avgCost)
              // against the hydrated position, also keyed on cost basis).
              avgCost:
                g.tokens > 1e-9 && g.depositedUsdc > 0
                  ? g.depositedUsdc / g.tokens
                  : g.avgNavAtDeposit,
              nav,
              tier,
              maturityAt: dbMatch?.maturityAt,
              status: dbMatch?.status,
            });
          });

          // For each on-chain position, render a residual card covering
          // any tokens the virtual ledger hasn't explained (pre-ledger
          // deposits, localStorage wipes, etc.).
          // Dedupe by bundleId before rendering residuals: the backend has
          // historically returned multiple rows for the same bundle (e.g. one
          // per on-chain deposit event), which would give us two cards with
          // identical `${bundleId}::residual` keys and the "Encountered two
          // children with the same key" React warning. Sum their qty so the
          // user sees one merged residual instead of duplicates.
          const residualByBundle = new Map<string, BasketPosition>();
          state.basketPositions.forEach((p) => {
            const existing = residualByBundle.get(p.bundleId);
            if (existing) {
              residualByBundle.set(p.bundleId, {
                ...existing,
                qty: existing.qty + p.qty,
              });
            } else {
              residualByBundle.set(p.bundleId, p);
            }
          });
          residualByBundle.forEach((p) => {
            // Residual = on-chain tokens the virtual ledger hasn't already
            // accounted for. Drive the subtraction off the on-chain balance
            // (not the backend qty) so a stale DB row with ghost tokens the
            // wallet no longer holds doesn't produce a stale card.
            const onchainForUuid = onchainTokensByUuid[p.bundleId] ?? 0;
            if (onchainForUuid <= 0.000001) return;
            const virtualQty = virtualTokensByUuid[p.bundleId] ?? 0;
            const coveredByVirtual = Math.min(virtualQty, onchainForUuid);
            const residual = onchainForUuid - coveredByVirtual;
            if (residual <= 0.001) return;
            // First try the catalog (works when bundleId is already a
            // PBU- id), then fall through to deriveResidualLabel which
            // maps a backend UUID → the best-guess PBU-TIER-WINDOW id.
            // Using p.displayName can leak an old bundle id into the
            // UI and breaks the basket-detail route.
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
              // Use the DB-hydrated entry price as the cost basis. Pegging
              // to current NAV forced card PnL = $0 regardless of drift,
              // which disagreed with the headline (basketDriftLive uses
              // p.avgCost). Falling back to nav only when the hydrate
              // produced no avgCost (pre-migration rows) keeps the card
              // honest without crashing on missing data.
              avgCost: p.avgCost && p.avgCost > 0 ? p.avgCost : nav,
              nav,
              tier,
              maturityAt: p.maturityAt,
              status: p.status,
            });
          });


          // `effectiveTranches` is the reducer's tranchePositions filtered to
          // rows backed by on-chain PBU. Rows from cancelled
          // transactions (backend creates the row before the wallet signs)
          // never appear here because the wallet holds no matching PBU.
          effectiveTranches.forEach((p, i) => {
            const principal = p.qty * p.avgCost;
            // Per-card accrued yield — same formula as trancheAccruedYield, so
            // summing cards matches the headline P&L contribution.
            const trancheAccrued =
              p.apy != null && p.createdAt != null && p.maturityDays != null
                ? principal *
                  (p.apy / 100 / 365) *
                  Math.min(
                    Math.max(0, (renderNow - p.createdAt) / 86_400_000),
                    p.maturityDays,
                  )
                : 0;
            const value = principal + trancheAccrued;
            const rowKey = `tranche-${p.vaultId ?? `${p.bundleId}-${p.kind}-${i}`}`;
            const matured = p.maturityAt != null ? p.maturityAt <= renderNow : false;
            const isBusy = redeemBusy === rowKey;
            const errMsg = redeemError[rowKey];
            const maturityLabel = p.maturityAt
              ? new Date(p.maturityAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              : null;
            rows.push({
              key: rowKey,
              value,
              el: (
                <div key={rowKey} style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 20, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, letterSpacing: "0.08em" }}>TRANCHE</div>
                    <Link href="/app/tranche" style={{ fontSize: 11, color: C.teal, fontFamily: FS, textDecoration: "none" }}>View all →</Link>
                  </div>
                  <Link href={`/app/tranche/${p.bundleName ?? p.bundleId}?tier=${p.kind}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", textDecoration: "none" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <div style={{ width: 4, height: 24, borderRadius: 2, background: trancheColor(p.kind) }} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD, textTransform: "capitalize" }}>{p.bundleName ?? p.bundleId} · {p.kind}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, marginTop: 2 }}>{(p.qty ?? 0).toFixed(2)} units · issued ${(p.avgCost ?? 0).toFixed(2)}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, color: C.textPrimary, fontFamily: FD }}>{fmtUsd(value, 2)}</div>
                      {trancheAccrued > 0 && (
                        <div style={{ fontSize: 11, color: C.green, fontFamily: FS, marginTop: 2 }}>+{fmtUsd(trancheAccrued, 2)}</div>
                      )}
                    </div>
                  </Link>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14, paddingTop: 14, borderTop: `0.5px solid ${C.border}` }}>
                    <div style={{ fontSize: 11, color: matured ? C.green : C.textMuted, fontFamily: FM, letterSpacing: "0.06em" }}>
                      {matured ? "MATURED" : maturityLabel ? `MATURES ${maturityLabel.toUpperCase()}` : "MATURITY UNKNOWN"}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        handleRedeemPpn(rowKey, {
                          vaultIds: p.allVaultIds?.length
                            ? p.allVaultIds
                            : p.vaultId
                              ? [p.vaultId]
                              : undefined,
                          bundleId:
                            p.allVaultIds?.length || p.vaultId ? undefined : p.bundleId,
                        })
                      }
                      disabled={isBusy || !walletReady}
                      title={matured ? "Redeem at maturity" : "Exit this tranche early — pro-rata payout"}
                      style={{
                        padding: "7px 16px",
                        fontSize: 12,
                        fontFamily: FD,
                        fontWeight: 500,
                        letterSpacing: "0.02em",
                        borderRadius: 8,
                        cursor: !isBusy && walletReady ? "pointer" : "not-allowed",
                        border: `0.5px solid ${!isBusy && walletReady ? C.amber : "rgba(255,255,255,0.08)"}`,
                        background: !isBusy && walletReady ? "rgba(217, 119, 6, 0.14)" : "transparent",
                        color: !isBusy && walletReady ? C.amber : C.textMuted,
                        opacity: isBusy ? 0.6 : 1,
                        transition: `all 0.15s ${EASE}`,
                      }}
                    >
                      {isBusy ? "Redeeming…" : "Redeem"}
                    </button>
                  </div>
                  {errMsg && (
                    <div style={{ marginTop: 10, fontSize: 11, fontFamily: FS, color: C.red }}>
                      {errMsg}
                    </div>
                  )}
                </div>
              ),
            });
          });

          // Same on-chain gate as the tranche loop above — cancelled-tx rows
          // never reach this list, so the card count matches the wallet.
          effectivePpnVaults.forEach((v) => {
            // On-chain `ppn:` shares carry principal but not the note's term or
            // created-at, so those hydrate to NaN. Mirror the tranche card's
            // graceful "MATURITY UNKNOWN" path: when the term is unknown, show
            // principal as the value with no fabricated accrual or maturity date.
            const principal = Number.isFinite(v.principal) ? v.principal : 0;
            const apy = Number.isFinite(v.apy) ? v.apy : 0;
            const hasTerm = Number.isFinite(v.createdAt) && Number.isFinite(v.maturityDays);
            const elapsed = hasTerm ? Math.max(0, (renderNow - v.createdAt) / 86_400_000) : 0;
            const accrued = hasTerm
              ? principal * (apy / 100 / 365) * Math.min(elapsed, v.maturityDays)
              : 0;
            const value = principal + accrued;
            const rowKey = `ppn-${v.id}`;
            const maturityMs = hasTerm ? v.createdAt + v.maturityDays * 86_400_000 : null;
            const matured = maturityMs != null ? maturityMs <= renderNow : false;
            const isBusy = redeemBusy === rowKey;
            const errMsg = redeemError[rowKey];
            const maturityLabel =
              maturityMs != null
                ? new Date(maturityMs).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : null;
            rows.push({
              key: rowKey,
              value,
              el: (
                <div key={rowKey} style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 20, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, letterSpacing: "0.08em" }}>PPN VAULT</div>
                    <Link href="/app/ppn" style={{ fontSize: 11, color: C.violet, fontFamily: FS, textDecoration: "none" }}>View all →</Link>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <div style={{ width: 4, height: 24, borderRadius: 2, background: C.violet }} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD }}>{v.bundleId}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, marginTop: 2 }}>{hasTerm ? `${apy.toFixed(2)}% APY · ${Math.round(v.maturityDays)}d maturity` : "Principal-protected note"}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {/* Card big-number matches the tranche card convention
                          (value = principal + accrued yield) and the top-line
                          roll-up (effectivePpnValue + ppnAccruedYield). Using
                          v.principal here made the PPN card appear frozen at
                          the deposit amount while every other surface on the
                          page moved with accrual. */}
                      <div style={{ fontSize: 13, color: C.textPrimary, fontFamily: FD }}>{fmtUsd(value, 2)}</div>
                      {accrued > 0 && (
                        <div style={{ fontSize: 11, color: C.green, fontFamily: FS, marginTop: 2 }}>+{fmtUsd(accrued, 2)}</div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14, paddingTop: 14, borderTop: `0.5px solid ${C.border}` }}>
                    <div style={{ fontSize: 11, color: matured ? C.green : C.textMuted, fontFamily: FM, letterSpacing: "0.06em" }}>
                      {matured ? "MATURED" : maturityLabel ? `MATURES ${maturityLabel.toUpperCase()}` : "MATURITY UNKNOWN"}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRedeemPpn(rowKey, { vaultIds: v.allVaultIds ?? [v.id] })}
                      disabled={isBusy || !walletReady}
                      title={matured ? "Redeem at maturity" : "Redeem this note early — principal-protected payout"}
                      style={{
                        padding: "7px 16px",
                        fontSize: 12,
                        fontFamily: FD,
                        fontWeight: 500,
                        letterSpacing: "0.02em",
                        borderRadius: 8,
                        cursor: !isBusy && walletReady ? "pointer" : "not-allowed",
                        border: `0.5px solid ${!isBusy && walletReady ? C.violet : "rgba(255,255,255,0.08)"}`,
                        background: !isBusy && walletReady ? "rgba(139, 92, 246, 0.14)" : "transparent",
                        color: !isBusy && walletReady ? C.violet : C.textMuted,
                        opacity: isBusy ? 0.6 : 1,
                        transition: `all 0.15s ${EASE}`,
                      }}
                    >
                      {isBusy ? "Redeeming…" : "Redeem"}
                    </button>
                  </div>
                  {errMsg && (
                    <div style={{ marginTop: 10, fontSize: 11, fontFamily: FS, color: C.red }}>
                      {errMsg}
                    </div>
                  )}
                </div>
              ),
            });
          });

          // Distribution Markets — open continuous μ/σ positions. Collateral
          // is escrowed on-chain at open; the card shows it as value at risk
          // and links to /app/distribution where the position is settled.
          effectiveDistPositions.forEach((p) => {
            const collateral = Number.isFinite(p.collateral_usdc) ? p.collateral_usdc : 0;
            const maxProfit = Number.isFinite(p.max_profit_usdc) ? p.max_profit_usdc : 0;
            const rowKey = `dist-${p.id}`;
            rows.push({
              key: rowKey,
              value: collateral,
              el: (
                <div key={rowKey} style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 20, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, letterSpacing: "0.08em" }}>DISTRIBUTION MARKET</div>
                    <Link href="/app/distribution" style={{ fontSize: 11, color: C.coral, fontFamily: FS, textDecoration: "none" }}>View all →</Link>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <div style={{ width: 4, height: 24, borderRadius: 2, background: C.coral }} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD }}>{p.question}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, marginTop: 2 }}>target μ {Math.round(p.target_mu)} · σ {Math.round(p.target_sigma)} · max profit {fmtUsd(maxProfit, 2)}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, color: C.textPrimary, fontFamily: FD }}>{fmtUsd(collateral, 2)}</div>
                      <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, marginTop: 2 }}>collateral at risk</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14, paddingTop: 14, borderTop: `0.5px solid ${C.border}` }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FM, letterSpacing: "0.06em" }}>OPEN · CONTINUOUS</div>
                    <Link href="/app/distribution" style={{ padding: "7px 16px", fontSize: 12, fontFamily: FD, fontWeight: 500, letterSpacing: "0.02em", borderRadius: 8, border: `0.5px solid ${C.coral}`, background: `${C.coral}24`, color: C.coral, textDecoration: "none" }}>Settle →</Link>
                  </div>
                </div>
              ),
            });
          });

          // USDC cash position. Pulls straight from the Sui balance poll.
          if (liveUsdc > 0) {
            rows.push({
              key: "usdc",
              value: liveUsdc,
              el: (
                <div key="usdc" style={{ background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 20, marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, letterSpacing: "0.08em", marginBottom: 14 }}>CASH</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <div style={{ width: 4, height: 24, borderRadius: 2, background: "#4a5a6a" }} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD }}>USDC</div>
                        <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, marginTop: 2 }}>Sui testnet mUSDC</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: C.textPrimary, fontFamily: FD }}>{fmtUsd(liveUsdc, 2)}</div>
                  </div>
                </div>
              ),
            });
          }

          // Sort by value descending
          rows.sort((a, b) => b.value - a.value);
          if (rows.length === 0) {
            return (
              <div className="portfolio-card" style={{ textAlign: "center", padding: "34px 20px" }}>
                <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
                  No open positions yet
                </div>
                <div style={{ color: C.textSecondary, fontFamily: FS, fontSize: 13 }}>
                  New market baskets, risk slices, and protected notes will appear here after execution.
                </div>
              </div>
            );
          }
          return rows.map(r => r.el);
        })()}
        </>
        )}
      </PageFrame>
    </>
  );
}
