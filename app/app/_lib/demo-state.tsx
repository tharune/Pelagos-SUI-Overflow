"use client";
/**
 * Portfolio state container for the Pelagos authenticated app shell.
 *
 * Every product primitive (Native Basket, Tranched Pool Tokens, PPN, Lending)
 * deposits and withdraws through the actions here, so the Portfolio page can
 * always produce a single consolidated view. State lives in-memory per browser
 * session; real balances will be sourced from the active Sui account once that
 * integration lands.
 *
 * Design:
 * - One reducer, one typed action union. No useEffect chains.
 * - Positions are never merged across primitives: each product owns its own
 *   list, and the portfolio view is the one place that fans them in.
 * - No backend calls live in here. Pages that need to hit the backend
 *   (markets, hedge analysis, etc.) do so directly and then dispatch a local
 *   action to persist the result.
 */

import React, {
  createContext,
  useContext,
  useMemo,
  useReducer,
} from "react";
import { INITIAL_USDC } from "./tokens";
import { BUNDLES, bundleById } from "./bundles";
import { IS_SUI } from "./chain";
import type { EvidenceItem } from "./receipts-client";

/**
 * Context key for a position's attached evidence. Keeps the receipt map keyed
 * consistently across the send flow (attach) and the Portfolio (read), without
 * threading a receipts array through every position type.
 */
export function evidenceKey(
  contextType: "basket" | "tranche" | "ppn" | "distribution",
  ...parts: string[]
): string {
  return [contextType, ...parts].join(":");
}

// ---------- Position types ----------

export type BasketPosition = {
  bundleId: string;
  qty: number; // PBU units held
  avgCost: number; // avg NAV at entry
  // Optional self-describing fields populated by the DB hydrate. Let
  // the reducer + portfolio render a position whose `bundleId` is a
  // Supabase UUID (i.e. has no match in the frontend basket catalog).
  tier?: 90 | 70 | 50;
  navHint?: number;
  displayName?: string;
  /** Epoch ms — resolution date parsed from the backend bundle name. */
  maturityAt?: number;
  /** Backend bundle status: "active" | "resolved" | "cancelled". */
  status?: string;
};

export type TrancheKind = "senior" | "mezzanine" | "junior";
export type TranchePosition = {
  bundleId: string;
  kind: TrancheKind;
  qty: number;
  avgCost: number;
  /**
   * Optional Supabase vault_id (ppn_vaults.id). Risk Slices ride the PPN rail
   * so the redeem flow takes either a vault_id or a (wallet, bundle) pair.
   * Present after a hydrate from /api/ppn/portfolio; absent on freshly-
   * dispatched `tranche/deposit` actions until the next portfolio refresh.
   */
  vaultId?: string;
  /** Epoch ms — maturity date parsed from the backend vault row. */
  maturityAt?: number;
  /**
   * APY in percent (e.g. 8 for 8%). Present after a hydrate from
   * /api/ppn/portfolio so the portfolio page can accrue straight-line yield
   * on top of notional. Absent on freshly-dispatched `tranche/deposit`.
   */
  apy?: number;
  /** Epoch ms — vault creation time, anchor for yield accrual. */
  createdAt?: number;
  /** Lifetime in days (days_elapsed + days_remaining at hydrate). */
  maturityDays?: number;
  /**
   * Every on-chain vault_id merged into this row. When the hydrate step
   * collapses multiple backend rows with the same (bundle_id, kind) into a
   * single card, we keep every underlying vault_id here so the portfolio
   * Redeem button can iterate each note. Always includes `vaultId`.
   */
  allVaultIds?: string[];
  /**
   * Human-readable bundle name (e.g. "PBU-HIGH-SHORT"). Used by the
   * portfolio → tranche deep-link: the tranche detail page resolves its
   * `[id]` param against `bundleById()` (seed names) and the live-basket
   * cache (both use seed names), so navigating by Supabase UUID lands on
   * "Basket not found". Populated from PpnPortfolioEntry.bundle_name.
   */
  bundleName?: string;
};

export type PpnVault = {
  id: string;
  bundleId: string;
  principal: number; // USDC locked in protection sleeve
  basketAmount: number; // USDC deployed to basket
  apy: number;
  createdAt: number;
  maturityDays: number;
  /**
   * Every on-chain vault_id merged into this card. The hydrate step groups
   * backend rows that share a bundle_id so the UI shows one position per
   * bundle — this array preserves each underlying id so "Redeem" can walk
   * through every note. Always includes `id`.
   */
  allVaultIds?: string[];
};

export type LendingLoan = {
  id: string;
  collateralKind: "basket" | "tranche";
  bundleId: string;
  trancheKind?: TrancheKind; // only set when collateralKind === 'tranche'
  collateralQty: number; // tokens posted
  borrowedUsdc: number;
  rateApy: number; // nominal, simple interest for sandbox
  openedAt: number;
};

export type LendingDeposit = {
  amount: number;
  startApy: number;
  startedAt: number;
};

export type SandboxState = {
  usdc: number;
  basketPositions: BasketPosition[];
  tranchePositions: TranchePosition[];
  ppnVaults: PpnVault[];
  loans: LendingLoan[];
  lend: LendingDeposit | null;
  /**
   * Receipts / invoices attached to transactions, keyed by `evidenceKey(...)`.
   * This is the audit trail the Portfolio renders per position. Files live in
   * the backend receipt store; here we keep the metadata for fast lookup.
   */
  evidence: Record<string, EvidenceItem[]>;
};

// ---------- Actions ----------

type Action =
  | { type: "reset" }
  | {
      type: "basket/deposit";
      bundleId: string;
      usdcAmount: number;
      /**
       * Live NAV the UI priced the ticket against. Optional so legacy
       * call sites keep working — when omitted we fall back to the seed
       * bundle's NAV via `bundleById`, matching the pre-live behaviour.
       */
      nav?: number;
      /**
       * Exact tokens-out the UI quoted (post-fee). When present we
       * credit this directly so the portfolio matches the panel's
       * "You receive X PBU" line to the penny. Absent → reducer falls
       * back to a flat 50 bp fee estimate from `usdcAmount / nav`.
       */
      tokensOut?: number;
    }
  | { type: "basket/redeem"; bundleId: string; qty: number; payoutUsdc: number }
  | { type: "basket/hydrate"; positions: BasketPosition[] }
  | { type: "ppn/hydrate"; vaults: PpnVault[] }
  | { type: "tranche/hydrate"; positions: TranchePosition[] }
  | {
      type: "tranche/deposit";
      bundleId: string;
      kind: TrancheKind;
      usdcAmount: number;
      pricePerToken: number;
      vaultId?: string;
      maturityDays?: number;
      apy?: number;
      createdAt?: number;
      bundleName?: string;
    }
  | {
      type: "tranche/redeem";
      bundleId: string;
      kind: TrancheKind;
      payoutUsdc: number;
    }
  | { type: "ppn/open"; id?: string; bundleId: string; usdcAmount: number; apy: number; maturityDays: number; createdAt?: number }
  | { type: "ppn/close"; vaultId: string; payoutUsdc: number }
  | {
      type: "lending/borrow";
      collateralKind: "basket" | "tranche";
      bundleId: string;
      trancheKind?: TrancheKind;
      collateralQty: number;
      borrowedUsdc: number;
      rateApy: number;
    }
  | { type: "lending/repay"; loanId: string; repaidUsdc: number }
  | { type: "lending/deposit"; amount: number; apy: number }
  | { type: "lending/withdraw"; amount: number }
  | { type: "evidence/attach"; key: string; items: EvidenceItem[] }
  | { type: "evidence/remove"; key: string; id: string };

// ---------- Reducer ----------

export const initialSandboxState: SandboxState = {
  usdc: INITIAL_USDC,
  basketPositions: [],
  tranchePositions: [],
  ppnVaults: [],
  loans: [],
  lend: null,
  evidence: {},
};

function reducer(state: SandboxState, action: Action): SandboxState {
  switch (action.type) {
    case "reset":
      return initialSandboxState;

    case "basket/deposit": {
      if (action.usdcAmount <= 0 || action.usdcAmount > state.usdc) return state;
      // Prefer the NAV the UI actually priced against; only fall back
      // to the seed bundle's NAV if the caller didn't supply one (e.g.
      // a legacy unit test). The seed NAV can lag the live feed, so
      // trusting the UI-provided number keeps the reducer consistent
      // with what the user saw when they submitted.
      const seedNav = bundleById(action.bundleId)?.nav;
      const nav =
        action.nav && action.nav > 0
          ? action.nav
          : seedNav && seedNav > 0
            ? seedNav
            : 0;
      if (nav <= 0) return state;
      // Use the UI-quoted tokensOut when provided so the portfolio
      // reflects the "You receive X PBU" line exactly. Without this
      // the reducer applied a flat 50 bp fee (0.995) which only agreed
      // with the UI when slippage+fees summed to exactly 50 bp — a
      // coincidence for any real order. Fall back preserved for legacy
      // call sites that don't pass `tokensOut`.
      const tokensReceived =
        action.tokensOut && action.tokensOut > 0
          ? action.tokensOut
          : (action.usdcAmount * 0.995) / nav;
      if (tokensReceived <= 0) return state;
      // Effective cost per token: total USDC paid divided by tokens
      // actually credited. When the UI passes `tokensOut`, this equals
      // the fee-inclusive fill price, so avgCost tracks the real entry
      // rather than the fee-less NAV mid.
      const effectivePrice = action.usdcAmount / tokensReceived;
      const existing = state.basketPositions.find((p) => p.bundleId === action.bundleId);
      const nextPositions = existing
        ? state.basketPositions.map((p) =>
            p.bundleId === action.bundleId
              ? {
                  bundleId: p.bundleId,
                  qty: p.qty + tokensReceived,
                  avgCost:
                    (p.qty * p.avgCost + tokensReceived * effectivePrice) /
                    (p.qty + tokensReceived),
                }
              : p,
          )
        : [
            ...state.basketPositions,
            {
              bundleId: action.bundleId,
              qty: tokensReceived,
              avgCost: effectivePrice,
            },
          ];
      return {
        ...state,
        usdc: state.usdc - action.usdcAmount,
        basketPositions: nextPositions,
      };
    }

    case "basket/hydrate": {
      return { ...state, basketPositions: action.positions };
    }

    case "ppn/hydrate": {
      return { ...state, ppnVaults: action.vaults };
    }

    case "tranche/hydrate": {
      return { ...state, tranchePositions: action.positions };
    }

    case "basket/redeem": {
      const pos = state.basketPositions.find((p) => p.bundleId === action.bundleId);
      if (!pos) return state;
      // Defensive guards: the UI already blocks over-sells and negative
      // qty, but we repeat the checks here so the reducer stays
      // authoritative. Redeeming > held would silently mint USDC; a
      // negative payout would drain the wallet. Neither is reachable
      // from the current UI but better to hard-fail than half-trust.
      if (action.qty <= 0 || action.payoutUsdc < 0) return state;
      if (action.qty > pos.qty + 1e-9) return state;
      const nextQty = Math.max(0, pos.qty - action.qty);
      const nextPositions = nextQty === 0
        ? state.basketPositions.filter((p) => p.bundleId !== action.bundleId)
        : state.basketPositions.map((p) => (p.bundleId === action.bundleId ? { ...p, qty: nextQty } : p));
      return {
        ...state,
        usdc: state.usdc + action.payoutUsdc,
        basketPositions: nextPositions,
      };
    }

    case "tranche/deposit": {
      if (action.usdcAmount <= 0 || (!IS_SUI && action.usdcAmount > state.usdc)) return state;
      const tokensReceived = action.usdcAmount / action.pricePerToken;
      const key = (p: TranchePosition) =>
        p.bundleId === action.bundleId && p.kind === action.kind;
      const existing = state.tranchePositions.find(key);
      const nextPositions = existing
        ? state.tranchePositions.map((p) =>
            key(p)
              ? {
                  ...p,
                  vaultId: p.vaultId ?? action.vaultId,
                  allVaultIds: [
                    ...(p.allVaultIds ?? (p.vaultId ? [p.vaultId] : [])),
                    ...(action.vaultId ? [action.vaultId] : []),
                  ].filter((v, i, a) => a.indexOf(v) === i),
                  apy: action.apy ?? p.apy,
                  maturityDays: action.maturityDays ?? p.maturityDays,
                  createdAt: p.createdAt ?? action.createdAt,
                  bundleName: p.bundleName ?? action.bundleName,
                  qty: p.qty + tokensReceived,
                  avgCost:
                    (p.qty * p.avgCost + tokensReceived * action.pricePerToken) /
                    (p.qty + tokensReceived),
                }
              : p,
          )
        : [
            ...state.tranchePositions,
            {
              bundleId: action.bundleId,
              kind: action.kind,
              qty: tokensReceived,
              avgCost: action.pricePerToken,
              vaultId: action.vaultId,
              allVaultIds: action.vaultId ? [action.vaultId] : undefined,
              apy: action.apy,
              maturityDays: action.maturityDays,
              createdAt: action.createdAt,
              bundleName: action.bundleName,
            },
          ];
      return {
        ...state,
        usdc: IS_SUI ? state.usdc : state.usdc - action.usdcAmount,
        tranchePositions: nextPositions,
      };
    }

    case "tranche/redeem": {
      const idx = state.tranchePositions.findIndex(
        (p) => p.bundleId === action.bundleId && p.kind === action.kind,
      );
      if (idx < 0) return state;
      if (action.payoutUsdc < 0) return state;
      return {
        ...state,
        usdc: state.usdc + action.payoutUsdc,
        tranchePositions: state.tranchePositions.filter((_, i) => i !== idx),
      };
    }

    case "ppn/open": {
      if (action.usdcAmount <= 0 || (!IS_SUI && action.usdcAmount > state.usdc)) return state;
      const principal = action.usdcAmount; // the whole deposit is principal-protected
      const basketAmount = action.usdcAmount * 0.07;
      const id = action.id ?? `PPN-${action.bundleId}-${Date.now().toString(36)}`;
      return {
        ...state,
        usdc: IS_SUI ? state.usdc : state.usdc - action.usdcAmount,
        ppnVaults: [
          ...state.ppnVaults,
          {
            id,
            bundleId: action.bundleId,
            principal,
            basketAmount,
            apy: action.apy,
            createdAt: action.createdAt ?? Date.now(),
            maturityDays: action.maturityDays,
            allVaultIds: [id],
          },
        ],
      };
    }

    case "ppn/close": {
      const vault = state.ppnVaults.find((v) => v.id === action.vaultId);
      if (!vault) return state;
      return {
        ...state,
        usdc: state.usdc + action.payoutUsdc,
        ppnVaults: state.ppnVaults.filter((v) => v.id !== action.vaultId),
      };
    }

    case "lending/borrow": {
      return {
        ...state,
        usdc: state.usdc + action.borrowedUsdc,
        loans: [
          ...state.loans,
          {
            id: `LOAN-${Date.now().toString(36)}`,
            collateralKind: action.collateralKind,
            bundleId: action.bundleId,
            trancheKind: action.trancheKind,
            collateralQty: action.collateralQty,
            borrowedUsdc: action.borrowedUsdc,
            rateApy: action.rateApy,
            openedAt: Date.now(),
          },
        ],
      };
    }

    case "lending/repay": {
      if (action.repaidUsdc > state.usdc) return state;
      return {
        ...state,
        usdc: state.usdc - action.repaidUsdc,
        loans: state.loans.filter((l) => l.id !== action.loanId),
      };
    }

    case "lending/deposit": {
      if (action.amount <= 0 || action.amount > state.usdc) return state;
      const currentPrincipal = state.lend?.amount ?? 0;
      return {
        ...state,
        usdc: state.usdc - action.amount,
        lend: {
          amount: currentPrincipal + action.amount,
          startApy: action.apy,
          startedAt: state.lend?.startedAt ?? Date.now(),
        },
      };
    }

    case "lending/withdraw": {
      if (!state.lend || action.amount <= 0 || action.amount > state.lend.amount) return state;
      const remainingPrincipal = state.lend.amount - action.amount;
      return {
        ...state,
        usdc: state.usdc + action.amount,
        lend: remainingPrincipal > 0 ? { ...state.lend, amount: remainingPrincipal } : null,
      };
    }

    case "evidence/attach": {
      if (action.items.length === 0) return state;
      const existing = state.evidence[action.key] ?? [];
      // De-dupe by receipt id so re-hydrates don't double-list.
      const seen = new Set(existing.map((e) => e.id));
      const merged = [...existing, ...action.items.filter((e) => !seen.has(e.id))];
      return { ...state, evidence: { ...state.evidence, [action.key]: merged } };
    }

    case "evidence/remove": {
      const existing = state.evidence[action.key];
      if (!existing) return state;
      const next = existing.filter((e) => e.id !== action.id);
      const evidence = { ...state.evidence };
      if (next.length === 0) delete evidence[action.key];
      else evidence[action.key] = next;
      return { ...state, evidence };
    }

    default:
      return state;
  }
}

// ---------- Context ----------

type SandboxCtx = {
  state: SandboxState;
  dispatch: React.Dispatch<Action>;
  // Convenience selectors used by several pages
  totals: {
    totalValue: number;
    basketValue: number;
    trancheValue: number;
    ppnValue: number;
    loanDebt: number;
    lendValue: number;
    unrealizedPnl: number;
  };
};

const SandboxContext = createContext<SandboxCtx | null>(null);

export function SandboxProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialSandboxState);

  const totals = useMemo(() => {
    const basketValue = state.basketPositions.reduce((s, p) => {
      const b = bundleById(p.bundleId);
      const nav = b?.nav ?? p.navHint ?? 0;
      return s + p.qty * nav;
    }, 0);
    const trancheValue = state.tranchePositions.reduce((s, p) => s + p.qty * p.avgCost, 0);
    const ppnValue = state.ppnVaults.reduce((s, v) => s + v.principal, 0);
    const loanDebt = state.loans.reduce((s, l) => s + l.borrowedUsdc, 0);
    const lendValue = state.lend?.amount ?? 0;
    const unrealizedPnl = state.basketPositions.reduce((s, p) => {
      const b = bundleById(p.bundleId);
      const nav = b?.nav ?? p.navHint;
      if (nav == null) return s;
      return s + p.qty * (nav - p.avgCost);
    }, 0);
    const totalValue =
      state.usdc + basketValue + trancheValue + ppnValue + lendValue - loanDebt;
    return {
      totalValue,
      basketValue,
      trancheValue,
      ppnValue,
      loanDebt,
      lendValue,
      unrealizedPnl,
    };
  }, [state]);

  const ctx = useMemo<SandboxCtx>(() => ({ state, dispatch, totals }), [state, totals]);
  return <SandboxContext.Provider value={ctx}>{children}</SandboxContext.Provider>;
}

export function useSandbox(): SandboxCtx {
  const ctx = useContext(SandboxContext);
  if (!ctx) throw new Error("useSandbox must be used inside <SandboxProvider>");
  return ctx;
}

export { BUNDLES };
