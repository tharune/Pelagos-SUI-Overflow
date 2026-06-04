"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Header, PageFrame } from "../_components/Header";
import { C, FS, FD, FM, EASE, fmtUsd, BACKEND_URL } from "../_lib/tokens";
import { IS_SUI, SUI_ACTIVE_ADDRESS } from "../_lib/chain";
import { BUNDLES, bundleById } from "../_lib/bundles";
import { useSandbox } from "../_lib/demo-state";
import { useLiveBaskets } from "../_lib/use-live-baskets";
import type { LiveBasket } from "../_lib/live-baskets";
import {
  useWalletSigner,
  useUsdcBalance,
  explorerTxUrl,
} from "../_lib/wallet-bridge";
import {
  ppnDeposit,
  ppnRedeem,
  ppnDivest,
  ppnCloseEarly,
  fetchPpnPortfolio,
  PpnError,
} from "../_lib/ppn-client";
import { mergePpnVaults, mergeTranches } from "../_lib/ppn-hydrate";
import {
  DistributionCandidate,
  fetchDistributionCandidates,
} from "../_lib/distribution-client";

const MANAGEMENT_FEE_RATE = 0.001;
const STRATEGY_FEE_RATE = 0.0005;

type VaultSource = { name: string; apy: number; live: boolean; tvlUsd?: number };
type StrategyWindow = "short" | "medium" | "long";
type StrategyProfile = "Principal" | "Income" | "Convexity" | "Curve";
type StrategyFilter = "all" | StrategyProfile;

type StrategyBlueprint = {
  id: string;
  name: string;
  profile: StrategyProfile;
  tier: 90 | 70 | 50;
  window: StrategyWindow;
  description: string;
  distributionIndex: number;
  suggestedAmount: number;
};

type SuiStatus = {
  active_env?: string;
  package_id?: string;
  mock_usdc_type?: string | null;
};

type YieldsResponse = {
  sources?: Array<{ name: string; apy: number; live: boolean; tvlUsd?: number }>;
  best?: { name: string; apy: number; live: boolean; tvlUsd?: number } | null;
};

const STRATEGY_BLUEPRINTS: StrategyBlueprint[] = [
  {
    id: "protected-carry",
    name: "Protected Carry",
    profile: "Principal",
    tier: 90,
    window: "short",
    description: "High floor, short maturity.",
    distributionIndex: 0,
    suggestedAmount: 5_000,
  },
  {
    id: "treasury-roll",
    name: "Treasury Roll",
    profile: "Principal",
    tier: 90,
    window: "medium",
    description: "High-probability basket with a longer vault sleeve.",
    distributionIndex: 1,
    suggestedAmount: 10_000,
  },
  {
    id: "reserve-long",
    name: "Reserve Long",
    profile: "Principal",
    tier: 90,
    window: "long",
    description: "Maximum floor duration with modest residual exposure.",
    distributionIndex: 2,
    suggestedAmount: 25_000,
  },
  {
    id: "balanced-income",
    name: "Balanced Income",
    profile: "Income",
    tier: 70,
    window: "medium",
    description: "Balanced vault and basket exposure.",
    distributionIndex: 1,
    suggestedAmount: 10_000,
  },
  {
    id: "income-short",
    name: "Income Short",
    profile: "Income",
    tier: 70,
    window: "short",
    description: "Faster reset with mid-curve carry.",
    distributionIndex: 0,
    suggestedAmount: 7_500,
  },
  {
    id: "income-ladder",
    name: "Income Ladder",
    profile: "Income",
    tier: 70,
    window: "long",
    description: "Longer-dated basket sleeve with steady floor growth.",
    distributionIndex: 3,
    suggestedAmount: 15_000,
  },
  {
    id: "event-convexity",
    name: "Event Convexity",
    profile: "Convexity",
    tier: 50,
    window: "medium",
    description: "Lower floor, more residual upside.",
    distributionIndex: 2,
    suggestedAmount: 15_000,
  },
  {
    id: "tail-rebate",
    name: "Tail Rebate",
    profile: "Convexity",
    tier: 50,
    window: "short",
    description: "Short-dated long-shot basket with principal recovery.",
    distributionIndex: 4,
    suggestedAmount: 5_000,
  },
  {
    id: "long-vol-note",
    name: "Long Vol Note",
    profile: "Convexity",
    tier: 50,
    window: "long",
    description: "Long maturity with a wider upside sleeve.",
    distributionIndex: 5,
    suggestedAmount: 20_000,
  },
  {
    id: "curve-protected",
    name: "Curve Protected",
    profile: "Curve",
    tier: 90,
    window: "long",
    description: "Longer maturity with distribution signal.",
    distributionIndex: 0,
    suggestedAmount: 25_000,
  },
  {
    id: "curve-income",
    name: "Curve Income",
    profile: "Curve",
    tier: 70,
    window: "medium",
    description: "Mid-curve basket paired with a selected distribution.",
    distributionIndex: 1,
    suggestedAmount: 12_500,
  },
  {
    id: "curve-tail",
    name: "Curve Tail",
    profile: "Curve",
    tier: 50,
    window: "long",
    description: "Residual basket sleeve linked to the deepest curve.",
    distributionIndex: 2,
    suggestedAmount: 25_000,
  },
];

const STRATEGY_FILTERS: Array<{ value: StrategyFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "Principal", label: "Principal" },
  { value: "Income", label: "Income" },
  { value: "Convexity", label: "Convexity" },
  { value: "Curve", label: "Curve" },
];

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function shortUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return fmtUsd(value, 0);
}

function matchesWindow(daysLeft: number, filter: StrategyWindow): boolean {
  if (filter === "short") return daysLeft <= 30;
  if (filter === "medium") return daysLeft > 30 && daysLeft <= 180;
  return daysLeft > 180;
}

function windowLabel(value: StrategyWindow): string {
  if (value === "medium") return "MED";
  return value.toUpperCase();
}

function calcDynamicSplit(apyDecimal: number, days: number): { vaultPct: number; basketPct: number } {
  if (apyDecimal <= 0 || days <= 0) return { vaultPct: 0.99, basketPct: 0.01 };
  const vaultPct = 1 / Math.pow(1 + apyDecimal / 365, days);
  return { vaultPct, basketPct: 1 - vaultPct };
}

export default function PpnPage() {
  const { state, dispatch } = useSandbox();
  const basketState = useLiveBaskets();
  const wallet = useWalletSigner();
  const usdc = useUsdcBalance();
  const appConnected = true;

  const [selectedStrategyId, setSelectedStrategyId] = useState(STRATEGY_BLUEPRINTS[0].id);
  const [strategyFilter, setStrategyFilter] = useState<StrategyFilter>("all");
  const [amt, setAmt] = useState("");
  const [renderNow, setRenderNow] = useState(() => Date.now());
  const [txStage, setTxStage] = useState<"idle" | "preparing" | "signing" | "confirming" | "persisting" | "done">("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [redeemBusyId, setRedeemBusyId] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<Record<string, string>>({});
  const [vaultSources, setVaultSources] = useState<VaultSource[]>([]);
  const [apyLoading, setApyLoading] = useState(true);
  const [distributionCandidates, setDistributionCandidates] = useState<DistributionCandidate[]>([]);
  const [distributionLoading, setDistributionLoading] = useState(true);
  const [suiStatus, setSuiStatus] = useState<SuiStatus | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setRenderNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Index the wallet's open notes from the Sui-backed backend so the Positions
  // panel reflects real on-chain protected notes (and tranche legs), matching
  // the Portfolio page's hydrate. Falls back to empty when no signer is active.
  useEffect(() => {
    let cancelled = false;
    const address = SUI_ACTIVE_ADDRESS;
    if (!address) {
      dispatch({ type: "ppn/hydrate", vaults: [] });
      dispatch({ type: "tranche/hydrate", positions: [] });
      return;
    }
    fetchPpnPortfolio(address)
      .then((portfolio) => {
        if (cancelled) return;
        dispatch({ type: "ppn/hydrate", vaults: mergePpnVaults(portfolio) });
        dispatch({ type: "tranche/hydrate", positions: mergeTranches(portfolio) });
      })
      .catch(() => {
        // Keep whatever optimistic state we already have on a fetch miss.
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  useEffect(() => {
    let cancelled = false;
    async function fetchApys() {
      if (!cancelled) setApyLoading(true);
      try {
        const res = await fetch(`${BACKEND_URL}/api/vaults/yields`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as YieldsResponse;
        if (cancelled) return;
        const sources = (body.sources ?? [])
          .filter((source) => typeof source?.apy === "number" && source.apy > 0)
          .map((source) => ({
            name: source.name,
            apy: source.apy,
            live: source.live,
            tvlUsd: source.tvlUsd,
          }))
          .sort((a, b) => b.apy - a.apy);
        setVaultSources(sources);
      } catch {
        // Keep prior snapshot.
      } finally {
        if (!cancelled) setApyLoading(false);
      }
    }
    fetchApys();
    const interval = setInterval(fetchApys, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDistributionLoading(true);
    fetchDistributionCandidates({ limit: 6, refresh: true })
      .then((result) => {
        if (!cancelled) setDistributionCandidates(result.candidates);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDistributionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND_URL}/api/sui/status`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body) {
          setSuiStatus({
            active_env: body.active_env,
            package_id: body.package_id,
            mock_usdc_type: body.mock_usdc_type,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const liveBaskets: LiveBasket[] =
    basketState.status === "ok" && basketState.baskets.length > 0
      ? basketState.baskets
      : (BUNDLES as unknown as LiveBasket[]);

  const bestVault = vaultSources[0] ?? null;
  const apy = bestVault?.apy ?? 0.0716;

  const strategies = useMemo(() => {
    function findBasket(blueprint: StrategyBlueprint): LiveBasket {
      const preferred = liveBaskets.find(
        (basket) =>
          basket.tier === blueprint.tier &&
          (basket.id.toUpperCase().includes(windowLabel(blueprint.window)) || matchesWindow(basket.daysLeft, blueprint.window)),
      );
      return preferred ?? liveBaskets.find((basket) => basket.tier === blueprint.tier) ?? liveBaskets[0];
    }

    return STRATEGY_BLUEPRINTS.map((blueprint) => {
      const basket = findBasket(blueprint);
      const distribution = distributionCandidates[blueprint.distributionIndex] ?? distributionCandidates[0] ?? null;
      const split = calcDynamicSplit(apy, basket?.daysLeft ?? 30);
      return {
        ...blueprint,
        basket,
        distribution,
        split,
        maturityDays: basket?.daysLeft ?? 30,
      };
    });
  }, [apy, distributionCandidates, liveBaskets]);

  const selectedStrategy = strategies.find((strategy) => strategy.id === selectedStrategyId) ?? strategies[0];
  const visibleStrategies =
    strategyFilter === "all"
      ? strategies
      : strategies.filter((strategy) => strategy.profile === strategyFilter);
  const selectedBundle = selectedStrategy?.basket?.id ?? null;
  const selectedBundleObj = selectedStrategy?.basket ?? null;
  const maturityDays = selectedStrategy?.maturityDays ?? 30;
  const dep = Number.parseFloat(amt) || 0;
  const liveUsdc = usdc.uiAmount;
  const insufficient = appConnected && dep > liveUsdc;
  const txBusy = txStage === "preparing" || txStage === "signing" || txStage === "confirming" || txStage === "persisting";
  const managementFee = dep * MANAGEMENT_FEE_RATE;
  const strategyFee = dep * STRATEGY_FEE_RATE;
  const totalOpenFee = managementFee + strategyFee;
  const netDeposit = Math.max(0, dep - totalOpenFee);
  const { vaultPct, basketPct } = calcDynamicSplit(apy, maturityDays);
  const vaultAmt = netDeposit * vaultPct;
  const basketAmt = netDeposit * basketPct;
  const vaultAtMaturity = vaultAmt * Math.pow(1 + apy / 365, maturityDays);
  const estimatedYield = vaultAtMaturity - vaultAmt;

  async function refreshPortfolioAfterWrite() {
    void usdc.refresh();
  }

  async function handleDeposit() {
    if (dep <= 0 || insufficient || !selectedBundle || !selectedBundleObj || txBusy) return;
    setTxError(null);
    setTxSignature(null);
    setTxStage("preparing");
    try {
      const result = await ppnDeposit({
        wallet,
        bundleId: selectedBundle,
        amountUsdc: dep,
        maturityDays,
      });
      setTxStage("done");
      setTxSignature(result.signature);
      dispatch({
        type: "ppn/open",
        id: result.prepare.vault_id,
        bundleId: selectedBundle,
        usdcAmount: dep,
        apy: apy * 100,
        maturityDays,
        createdAt: Date.now(),
      });
      void refreshPortfolioAfterWrite().catch((error) => console.warn("post-deposit ppn hydrate failed:", error));
      setTimeout(() => {
        setAmt("");
        setTxStage("idle");
      }, 1800);
    } catch (err) {
      setTxStage("idle");
      if (err instanceof PpnError) setTxError(err.message);
      else if (err instanceof Error) setTxError(/user rejected/i.test(err.message) ? "Transaction was rejected in your wallet." : err.message);
      else setTxError(String(err));
    }
  }

  async function finishExitFlow(rowKey: string) {
    if (IS_SUI) {
      dispatch({ type: "ppn/close", vaultId: rowKey, payoutUsdc: 0 });
      void usdc.refresh();
    } else {
      await refreshPortfolioAfterWrite();
    }
    setRedeemError((prev) => {
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
  }

  function handleExitError(rowKey: string, err: unknown) {
    const message =
      err instanceof PpnError
        ? err.message
        : err instanceof Error
          ? /user rejected/i.test(err.message)
            ? "Transaction was rejected in your wallet."
            : err.message
          : String(err);
    setRedeemError((prev) => ({ ...prev, [rowKey]: message }));
  }

  async function runExit(rowKey: string, vaultIds: string[], action: "withdraw" | "divest" | "close") {
    if (!appConnected || redeemBusyId) return;
    setRedeemBusyId(rowKey);
    setRedeemError((prev) => {
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
    try {
      for (const id of vaultIds) {
        if (action === "withdraw") {
          // eslint-disable-next-line no-await-in-loop
          await ppnRedeem({ wallet, vaultId: id });
        } else if (action === "divest") {
          // eslint-disable-next-line no-await-in-loop
          await ppnDivest({ wallet, vaultId: id });
        } else {
          // eslint-disable-next-line no-await-in-loop
          await ppnCloseEarly({ wallet, vaultId: id });
        }
      }
      await finishExitFlow(rowKey);
    } catch (err) {
      handleExitError(rowKey, err);
    } finally {
      setRedeemBusyId(null);
    }
  }

  async function handleRedeemAll() {
    if (!appConnected || redeemBusyId) return;
    for (const note of state.ppnVaults) {
      const elapsed = Math.max(0, (renderNow - note.createdAt) / 86_400_000);
      const daysLeft = Math.max(0, note.maturityDays - Math.floor(elapsed));
      const vaultIds = note.allVaultIds ?? [note.id];
      // eslint-disable-next-line no-await-in-loop
      await runExit(note.id, vaultIds, daysLeft <= 0 ? "withdraw" : "close");
    }
  }

  const deployDisabled = (appConnected && (insufficient || dep <= 0 || !selectedBundle)) || txBusy || txStage === "done";
  const deployLabel = !appConnected
    ? "Connect wallet"
    : !selectedBundle
      ? "Strategy unavailable"
      : dep <= 0
        ? "Enter amount"
        : insufficient
          ? "Insufficient USDC"
          : txStage === "preparing"
            ? "Preparing transaction"
            : txStage === "signing"
              ? "Awaiting signature"
              : txStage === "confirming"
                ? "Confirming on Sui"
                : txStage === "persisting"
                  ? "Finalising"
                  : txStage === "done"
                    ? "Note deployed"
                    : "Deploy protected note";

  return (
    <>
      <Header />
      <PageFrame wide>
        <style>{PPN_CSS}</style>
        <div className="ppn-shell">
          <section className="ppn-hero">
            <div>
              <h1>Protected Notes</h1>
              <p>Prebuilt USDC notes with vault routing, PBU upside, and Sui testnet settlement.</p>
            </div>
          </section>

          <section className="ppn-panel ppn-strategy-panel" aria-label="Protected note strategies">
            <div className="ppn-panel-head">
              <div>
                <span>Strategies</span>
                <h2>Ready to deploy</h2>
              </div>
              <strong>{strategies.length} notes</strong>
            </div>
            <div className="ppn-filter-row" aria-label="Strategy profile">
              {STRATEGY_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={strategyFilter === filter.value ? "is-active" : ""}
                  onClick={() => setStrategyFilter(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="ppn-strategy-table">
              <div className="ppn-strategy-header">
                <span>Strategy</span>
                <span>Basket</span>
                <span>Floor split</span>
                <span>Maturity</span>
                <span>Signal</span>
                <span />
              </div>
              {visibleStrategies.map((strategy) => {
                const active = strategy.id === selectedStrategy.id;
                return (
                  <button
                    type="button"
                    key={strategy.id}
                    className={`ppn-strategy-row${active ? " is-active" : ""}`}
                    onClick={() => {
                      setSelectedStrategyId(strategy.id);
                      if (!amt) setAmt(String(strategy.suggestedAmount));
                      setTxError(null);
                      if (txStage === "done") setTxStage("idle");
                    }}
                  >
                    <span>
                      <strong>{strategy.name}</strong>
                      <em>{strategy.profile} · {strategy.description}</em>
                    </span>
                    <span>{strategy.basket?.id ?? "No basket"}</span>
                    <span>{pct(strategy.split.vaultPct, 1)} / {pct(strategy.split.basketPct, 1)}</span>
                    <span>{strategy.maturityDays}d</span>
                    <span>{strategy.distribution?.title ?? "Loading"}</span>
                    <span className="ppn-action-chip">{active ? "Selected" : "Select"}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="ppn-panel ppn-selected">
                <div className="ppn-panel-head">
                  <div>
                    <span>Selected strategy</span>
                    <h2>{selectedStrategy.name}</h2>
                  </div>
                  <strong>{selectedBundleObj?.id ?? "Unavailable"}</strong>
                </div>
                <div className="ppn-route-grid">
                  <div>
                    <span>Vault sleeve</span>
                    <strong>{pct(vaultPct, 2)}</strong>
                    <em>{fmtUsd(vaultAmt, 2)} routed to {bestVault?.name ?? "best vault"}</em>
                  </div>
                  <div>
                    <span>Basket sleeve</span>
                    <strong>{pct(basketPct, 2)}</strong>
                    <em>{fmtUsd(basketAmt, 2)} residual upside</em>
                  </div>
                  <div>
                    <span>Target maturity</span>
                    <strong>{maturityDays}d</strong>
                    <em>Selected basket schedule</em>
                  </div>
                  <div>
                    <span>Minimum return</span>
                    <strong>{dep > 0 ? fmtUsd(netDeposit, 2) : "100% target"}</strong>
                    <em>Subject to vault and protocol risk</em>
                  </div>
                </div>
                <div className="ppn-split-bar">
                  <i style={{ width: `${vaultPct * 100}%` }} />
                  <b style={{ width: `${basketPct * 100}%` }} />
                </div>
          </div>

          <section className="ppn-main-grid">
            <div className="ppn-left-stack">
              <div className="ppn-panel ppn-data-panel">
                <div className="ppn-panel-head">
                  <div>
                    <span>Inputs</span>
                    <h2>Vaults and distribution markets</h2>
                  </div>
                  <strong>{apyLoading || distributionLoading ? "Loading" : `${vaultSources.length} vaults · ${distributionCandidates.length} markets`}</strong>
                </div>
                <div className="ppn-data-grid">
                  <div className="ppn-table">
                    <div className="ppn-table-head">
                      <span>USDC vault</span>
                      <span>APY</span>
                      <span>TVL</span>
                    </div>
                    {(vaultSources.length ? vaultSources : [{ name: "Loading", apy: 0, live: false }]).slice(0, 5).map((source, index) => (
                      <div key={source.name} className={index === 0 ? "is-best" : ""}>
                        <span>{source.name}</span>
                        <strong>{source.apy ? pct(source.apy, 2) : "-"}</strong>
                        <em>{source.tvlUsd ? shortUsd(source.tvlUsd) : "-"}</em>
                      </div>
                    ))}
                  </div>
                  <div className="ppn-table">
                    <div className="ppn-table-head">
                      <span>Distribution market</span>
                      <span>Score</span>
                      <span>Depth</span>
                    </div>
                    {(distributionCandidates.length ? distributionCandidates : [null]).slice(0, 5).map((candidate, index) => (
                      <div key={candidate?.id ?? "loading"}>
                        <span>{candidate?.title ?? "Loading markets"}</span>
                        <strong>{candidate ? candidate.launch_score.toFixed(1) : "-"}</strong>
                        <em>{candidate ? shortUsd(candidate.aggregate_depth_usd) : "-"}</em>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="ppn-panel ppn-positions">
                <div className="ppn-panel-head">
                  <div>
                    <span>Open notes</span>
                    <h2>Positions</h2>
                  </div>
                  {state.ppnVaults.length > 0 && (
                    <button className="ppn-link-button" type="button" onClick={handleRedeemAll} disabled={!appConnected || !!redeemBusyId}>
                      Close all
                    </button>
                  )}
                </div>
                {state.ppnVaults.length === 0 ? (
                  <div className="ppn-empty">No protected notes open.</div>
                ) : (
                  <div className="ppn-position-list">
                    {state.ppnVaults.map((note) => {
                      const liveBasket = liveBaskets.find((basket) => basket.id === note.bundleId);
                      const basket = liveBasket ?? bundleById(note.bundleId);
                      const elapsed = Math.max(0, (renderNow - note.createdAt) / 86_400_000);
                      const daysLeft = Math.max(0, note.maturityDays - Math.floor(elapsed));
                      const accrued = note.principal * (note.apy / 100 / 365) * Math.min(elapsed, note.maturityDays);
                      const matured = daysLeft <= 0;
                      const vaultIds = note.allVaultIds ?? [note.id];
                      const busy = redeemBusyId === note.id;
                      return (
                        <div key={note.id} className="ppn-position">
                          <div>
                            <strong>{basket?.id ?? note.bundleId}</strong>
                            <span>{fmtUsd(note.principal, 2)} principal · +{fmtUsd(accrued, 2)} accrued · {daysLeft}d left</span>
                            {redeemError[note.id] && <em>{redeemError[note.id]}</em>}
                          </div>
                          <div className="ppn-position-actions">
                            <button type="button" disabled={!appConnected || busy || !matured} onClick={() => runExit(note.id, vaultIds, "withdraw")}>
                              Withdraw
                            </button>
                            <button type="button" disabled={!appConnected || busy} onClick={() => runExit(note.id, vaultIds, "divest")}>
                              Divest
                            </button>
                            <button type="button" disabled={!appConnected || busy} onClick={() => runExit(note.id, vaultIds, "close")}>
                              Close
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <aside className="ppn-ticket">
              <div className="ppn-ticket-head">
                <div>
                  <span>Deploy</span>
                  <strong>{selectedStrategy.name}</strong>
                </div>
                <em>{appConnected ? `Balance ${usdc.loading && liveUsdc === 0 ? "-" : fmtUsd(liveUsdc, 2)}` : "Connect wallet"}</em>
              </div>

              <label className="ppn-amount">
                <span>Deposit USDC</span>
                <div>
                  <b>$</b>
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="0"
                    value={amt}
                    onChange={(event) => {
                      setAmt(event.target.value);
                      if (txStage === "done") setTxStage("idle");
                      if (txError) setTxError(null);
                    }}
                  />
                </div>
              </label>
              <div className="ppn-presets">
                {[5_000, 10_000, 25_000].map((value) => (
                  <button key={value} type="button" onClick={() => setAmt(String(value))}>
                    {fmtUsd(value, 0)}
                  </button>
                ))}
              </div>
              {insufficient && <div className="ppn-error">Insufficient USDC balance.</div>}

              <div className="ppn-breakdown">
                {[
                  ["Gross collateral", dep > 0 ? fmtUsd(dep, 2) : "-"],
                  ["Open fees", dep > 0 ? fmtUsd(totalOpenFee, 2) : "15 bps"],
                  ["Net deployed", dep > 0 ? fmtUsd(netDeposit, 2) : "-"],
                  ["Vault principal", dep > 0 ? fmtUsd(vaultAmt, 2) : "-"],
                  ["Basket upside", dep > 0 ? fmtUsd(basketAmt, 2) : "-"],
                  ["Projected vault yield", dep > 0 ? `+${fmtUsd(estimatedYield, 2)}` : "-"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>

              <button className="ppn-deploy" type="button" onClick={handleDeposit} disabled={deployDisabled}>
                {deployLabel}
              </button>
              {txError && <div className="ppn-error">{txError}</div>}
              {txSignature && (
                <a className="ppn-success" href={explorerTxUrl(txSignature)} target="_blank" rel="noopener noreferrer">
                  View transaction
                </a>
              )}

              <div className="ppn-chain-box">
                <span>Settlement</span>
                <strong>Sui testnet USDC</strong>
                <em>{suiStatus?.package_id ? `${suiStatus.package_id.slice(0, 10)}...${suiStatus.package_id.slice(-6)}` : "package status pending"}</em>
              </div>
            </aside>
          </section>
        </div>
      </PageFrame>
    </>
  );
}

const PPN_CSS = `
  .ppn-shell { max-width: 1280px; margin: 0 auto; display: grid; gap: 12px; }
  .ppn-hero { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: end; padding: 0 0 8px; }
  .ppn-hero h1 { color: ${C.textPrimary}; font-family: ${FD}; font-size: 34px; line-height: 1.05; letter-spacing: -0.03em; font-weight: 600; margin: 0; }
  .ppn-hero p { color: ${C.textSecondary}; font-family: ${FS}; font-size: 13px; line-height: 1.55; margin: 8px 0 0; max-width: 560px; }
  .ppn-panel, .ppn-ticket { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 8px; }
  .ppn-panel-head span, .ppn-ticket-head span, .ppn-route-grid span, .ppn-amount span, .ppn-chain-box span { display: block; color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; }
  .ppn-panel { padding: 14px; }
  .ppn-panel-head { display: flex; justify-content: space-between; align-items: start; gap: 14px; margin-bottom: 12px; }
  .ppn-panel-head h2 { color: ${C.textPrimary}; font-family: ${FD}; font-size: 17px; font-weight: 580; letter-spacing: -0.02em; margin: 4px 0 0; }
  .ppn-panel-head > strong { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; font-weight: 520; text-align: right; }
  .ppn-strategy-panel { border: 0; background: transparent; padding: 0; }
  .ppn-filter-row { display: flex; flex-wrap: wrap; gap: 6px; margin: -2px 0 12px; }
  .ppn-filter-row button { height: 30px; border-radius: 999px; border: 0.5px solid ${C.border}; background: ${C.surface}; color: ${C.textSecondary}; padding: 0 13px; font-family: ${FD}; font-size: 12px; cursor: pointer; transition: background 0.14s ${EASE}, color 0.14s ${EASE}, border-color 0.14s ${EASE}; }
  .ppn-filter-row button:hover, .ppn-filter-row button.is-active { color: ${C.textPrimary}; border-color: ${C.borderHover}; background: ${C.cardHover}; }
  .ppn-strategy-table { display: grid; gap: 0; border: 0.5px solid ${C.border}; border-radius: 8px; background: ${C.surface}; }
  .ppn-strategy-header, .ppn-strategy-row { display: grid; grid-template-columns: minmax(230px, 1.25fr) 150px 110px 76px minmax(170px, 1fr) 86px; gap: 16px; align-items: center; }
  .ppn-strategy-header { padding: 9px 12px; border-bottom: 0.5px solid ${C.border}; color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; }
  .ppn-strategy-row { width: 100%; appearance: none; border: 0; border-bottom: 0.5px solid ${C.border}; background: transparent; padding: 11px 12px; text-align: left; cursor: pointer; color: ${C.textSecondary}; transition: background 0.14s ${EASE}; }
  .ppn-strategy-row:last-child { border-bottom: 0; }
  .ppn-strategy-row:hover, .ppn-strategy-row.is-active { background: ${C.card}; }
  .ppn-strategy-row.is-active { box-shadow: inset 2px 0 0 ${C.tealLight}; }
  .ppn-strategy-row span { min-width: 0; color: ${C.textSecondary}; font-family: ${FM}; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ppn-strategy-row span:first-child { font-family: ${FS}; }
  .ppn-strategy-row strong { display: block; color: ${C.textPrimary}; font-family: ${FD}; font-size: 13px; font-weight: 620; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ppn-strategy-row em { display: block; color: ${C.textMuted}; font-family: ${FS}; font-size: 11.5px; font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ppn-strategy-row .ppn-action-chip { justify-self: end; min-width: 76px; height: 30px; border-radius: 999px; border: 0.5px solid ${C.border}; display: inline-flex; align-items: center; justify-content: center; color: ${C.textPrimary}; font-family: ${FD}; font-size: 12px; background: ${C.surface}; }
  .ppn-strategy-row.is-active .ppn-action-chip { border-color: ${C.tealLight}; background: ${C.tealLight}; color: #06131f; font-weight: 680; }
  .ppn-main-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 12px; align-items: stretch; }
  .ppn-left-stack { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .ppn-positions { display: flex; flex-direction: column; flex: 1; }
  .ppn-positions .ppn-empty { flex: 1; display: grid; place-items: center; }
  .ppn-positions .ppn-position-list { flex: 1; align-content: start; }
  .ppn-route-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; overflow: hidden; }
  .ppn-route-grid > div { border-right: 0.5px solid ${C.border}; background: transparent; padding: 11px 12px; min-width: 0; }
  .ppn-route-grid > div:last-child { border-right: 0; }
  .ppn-route-grid strong { display: block; color: ${C.textPrimary}; font-family: ${FD}; font-size: 18px; font-weight: 620; margin-top: 8px; letter-spacing: -0.015em; }
  .ppn-route-grid em { display: block; color: ${C.textMuted}; font-family: ${FS}; font-size: 11px; line-height: 1.35; font-style: normal; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ppn-split-bar { height: 5px; border-radius: 999px; background: ${C.surface}; border: 0.5px solid ${C.border}; display: flex; overflow: hidden; margin-top: 10px; }
  .ppn-split-bar i { display: block; background: ${C.tealLight}; }
  .ppn-split-bar b { display: block; background: ${C.textMuted}; }
  .ppn-data-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ppn-table { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; overflow: hidden; }
  .ppn-table-head, .ppn-table > div:not(.ppn-table-head) { display: grid; grid-template-columns: minmax(0, 1fr) 72px 72px; gap: 10px; align-items: center; padding: 9px 11px; border-bottom: 0.5px solid ${C.border}; }
  .ppn-table > div:last-child { border-bottom: 0; }
  .ppn-table-head span { color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; letter-spacing: 0.13em; text-transform: uppercase; }
  .ppn-table div:not(.ppn-table-head) span { color: ${C.textPrimary}; font-family: ${FD}; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ppn-table strong { color: ${C.textPrimary}; font-family: ${FM}; font-size: 11px; text-align: right; }
  .ppn-table em { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10.5px; font-style: normal; text-align: right; }
  .ppn-table .is-best { background: ${C.tealLight}08; }
  .ppn-ticket { padding: 14px; position: sticky; top: 72px; }
  .ppn-ticket-head { display: flex; justify-content: space-between; align-items: start; gap: 12px; margin-bottom: 14px; }
  .ppn-ticket-head strong { display: block; color: ${C.textPrimary}; font-family: ${FD}; font-size: 16px; font-weight: 620; margin-top: 4px; }
  .ppn-ticket-head em { color: ${C.textMuted}; font-family: ${FM}; font-size: 9px; font-style: normal; text-align: right; white-space: nowrap; }
  .ppn-amount { display: grid; gap: 7px; }
  .ppn-amount div { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 12px; padding: 0 13px; }
  .ppn-amount b { color: ${C.textMuted}; font-family: ${FM}; font-size: 15px; }
  .ppn-amount input { width: 100%; height: 44px; border: 0; background: transparent; color: ${C.textPrimary}; font-family: ${FD}; font-size: 19px; outline: none; padding-left: 7px; }
  .ppn-presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 8px 0 11px; }
  .ppn-presets button, .ppn-link-button, .ppn-position-actions button { border: 0.5px solid ${C.border}; background: ${C.surface}; color: ${C.textSecondary}; border-radius: 999px; height: 32px; font-family: ${FD}; font-size: 11.5px; cursor: pointer; transition: border-color 0.14s ${EASE}, background 0.14s ${EASE}, color 0.14s ${EASE}; }
  .ppn-presets button:hover, .ppn-link-button:hover, .ppn-position-actions button:hover { border-color: ${C.borderHover}; background: ${C.card}; color: ${C.textPrimary}; }
  .ppn-breakdown { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; padding: 11px; display: grid; gap: 9px; }
  .ppn-breakdown div { display: flex; justify-content: space-between; gap: 12px; color: ${C.textMuted}; font-family: ${FS}; font-size: 11.5px; }
  .ppn-breakdown strong { color: ${C.textPrimary}; font-family: ${FD}; font-weight: 560; }
  .ppn-deploy { width: 100%; height: 42px; border-radius: 999px; border: 0.5px solid ${C.tealLight}; background: ${C.tealLight}; color: #06131f; font-family: ${FD}; font-size: 12.5px; font-weight: 680; cursor: pointer; margin-top: 11px; transition: transform 0.14s ${EASE}, filter 0.14s ${EASE}; }
  .ppn-deploy:not(:disabled):hover { transform: translateY(-1px); filter: brightness(1.04); }
  .ppn-deploy:disabled { border-color: ${C.border}; background: ${C.surface}; color: ${C.textMuted}; cursor: not-allowed; }
  .ppn-error, .ppn-success { display: block; margin-top: 9px; border-radius: 8px; padding: 8px 9px; font-family: ${FS}; font-size: 11.5px; line-height: 1.4; text-decoration: none; }
  .ppn-error { color: ${C.red}; background: ${C.red}10; border: 0.5px solid ${C.red}33; }
  .ppn-success { color: ${C.green}; background: ${C.green}10; border: 0.5px solid ${C.green}33; text-align: center; }
  .ppn-chain-box { border-top: 0.5px solid ${C.border}; margin-top: 13px; padding-top: 13px; }
  .ppn-chain-box strong { display: block; color: ${C.textPrimary}; font-family: ${FD}; font-size: 12.5px; margin-top: 7px; }
  .ppn-chain-box em { display: block; color: ${C.textMuted}; font-family: ${FM}; font-size: 9.5px; font-style: normal; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ppn-empty { border: 0.5px dashed ${C.border}; background: ${C.surface}; color: ${C.textMuted}; border-radius: 8px; padding: 18px; font-family: ${FS}; font-size: 12.5px; text-align: center; }
  .ppn-position-list { display: grid; gap: 8px; }
  .ppn-position { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; padding: 11px; }
  .ppn-position strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 12.5px; display: block; }
  .ppn-position span { color: ${C.textMuted}; font-family: ${FM}; font-size: 10.5px; display: block; margin-top: 4px; }
  .ppn-position em { color: ${C.red}; font-family: ${FS}; font-size: 10.5px; font-style: normal; display: block; margin-top: 5px; }
  .ppn-position-actions { display: flex; gap: 6px; }
  .ppn-position-actions button { padding: 0 10px; }
  .ppn-position-actions button:disabled, .ppn-link-button:disabled { opacity: 0.42; cursor: not-allowed; }
  @media (max-width: 1180px) {
    .ppn-hero, .ppn-main-grid { grid-template-columns: 1fr; }
    .ppn-ticket { position: static; }
    .ppn-route-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .ppn-strategy-header { display: none; }
    .ppn-strategy-row { grid-template-columns: 1fr 120px 90px; }
    .ppn-strategy-row span:nth-child(4), .ppn-strategy-row span:nth-child(5) { display: none; }
  }
  @media (max-width: 760px) {
    .ppn-route-grid, .ppn-data-grid { grid-template-columns: 1fr; }
    .ppn-strategy-row { grid-template-columns: 1fr; gap: 7px; }
    .ppn-strategy-row .ppn-action-chip { justify-self: start; }
    .ppn-position { grid-template-columns: 1fr; }
    .ppn-position-actions { flex-wrap: wrap; }
  }
`;
