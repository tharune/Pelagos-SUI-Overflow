"use client";
/**
 * Virtual position ledger (localStorage)
 *
 * Real on-chain vaults are initialized one-per-tier on the backend, so every
 * synthetic (tier, window) click the user makes for a given tier routes to
 * the same on-chain bundle. That collapses SHORT / MED / LONG buys into one
 * blended position from the chain's perspective.
 *
 * The portfolio page needs to present those as separate cards — matching
 * what the user actually clicked — and needs a cost basis anchored at the
 * NAV observed at deposit time so PnL starts at zero and only drifts with
 * real market movement. This module keeps a per-deposit ledger in
 * localStorage that carries the UI bundle id, tokens minted, deposit size,
 * and NAV snapshot. Grouping by UI bundle id gives the portfolio the
 * separation it wants; `navAtDeposit` gives it a stable cost basis.
 */

export interface VirtualPosition {
  wallet: string;
  uuid: string;
  uiBundleId: string;
  tokens: number;
  depositedUsdc: number;
  navAtDeposit: number;
  signature: string;
  createdAt: number;
  chain?: "sui";
  marketId?: string;
  positionId?: string;
}

const STORAGE_KEY = "pelagos:virtualPositions:v1";

function loadAll(): VirtualPosition[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VirtualPosition[]) : [];
  } catch {
    return [];
  }
}

function saveAll(rows: VirtualPosition[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Quota exceeded / disabled localStorage — silently ignore.
  }
}

export function recordVirtualPosition(pos: VirtualPosition): void {
  const rows = loadAll();
  rows.push(pos);
  saveAll(rows);
}

export function getVirtualPositions(wallet: string): VirtualPosition[] {
  return loadAll().filter((p) => p.wallet === wallet);
}

/**
 * Remove every virtual position for a (wallet, uuid) pair. Called after a
 * full redemption of the on-chain vault.
 */
export function clearVirtualPositionsForUuid(
  wallet: string,
  uuid: string,
): void {
  const rows = loadAll().filter((p) => !(p.wallet === wallet && p.uuid === uuid));
  saveAll(rows);
}

/**
 * Remove only the virtual positions for a specific (wallet, uuid, uiBundleId)
 * triple. Used for per-position partial redemptions so sibling positions
 * remain visible in the portfolio.
 */
export function clearVirtualPositionsByUiBundleId(
  wallet: string,
  uuid: string,
  uiBundleId: string,
): void {
  const rows = loadAll().filter(
    (p) => !(p.wallet === wallet && p.uuid === uuid && p.uiBundleId === uiBundleId),
  );
  saveAll(rows);
}

export function clearVirtualPositionBySuiIds(
  wallet: string,
  marketId: string,
  positionId: string,
): void {
  const rows = loadAll().filter(
    (p) => !(p.wallet === wallet && p.marketId === marketId && p.positionId === positionId),
  );
  saveAll(rows);
}

export interface GroupedVirtualPosition {
  uiBundleId: string;
  uuid: string;
  tokens: number;
  depositedUsdc: number;
  /** Token-weighted mean of navAtDeposit across deposits in this group. */
  avgNavAtDeposit: number;
  deposits: VirtualPosition[];
}

/**
 * Group virtual positions by UI bundle id (e.g. one group per
 * PBU-HIGH-SHORT, another per PBU-HIGH-MED) so the portfolio can render
 * each as its own card. Groups that share a `uuid` collide on-chain, which
 * the UI surfaces via the redeem-all-at-once flow.
 */
export function groupVirtualByUiBundle(wallet: string): GroupedVirtualPosition[] {
  const rows = getVirtualPositions(wallet);
  const groups = new Map<string, GroupedVirtualPosition>();
  for (const row of rows) {
    const key = `${row.uuid}::${row.uiBundleId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.tokens += row.tokens;
      existing.depositedUsdc += row.depositedUsdc;
      existing.deposits.push(row);
      const totalTokens = existing.deposits.reduce((s, d) => s + d.tokens, 0);
      existing.avgNavAtDeposit =
        totalTokens > 0
          ? existing.deposits.reduce((s, d) => s + d.tokens * d.navAtDeposit, 0) /
            totalTokens
          : row.navAtDeposit;
    } else {
      groups.set(key, {
        uiBundleId: row.uiBundleId,
        uuid: row.uuid,
        tokens: row.tokens,
        depositedUsdc: row.depositedUsdc,
        avgNavAtDeposit: row.navAtDeposit,
        deposits: [row],
      });
    }
  }
  return Array.from(groups.values());
}

/**
 * Sibling groups share a uuid with the given group — they'll be wiped out
 * together on redeem. The portfolio uses this to warn the user before
 * redeeming.
 */
export function siblingsForUuid(
  wallet: string,
  uuid: string,
  excludeUiBundleId: string,
): GroupedVirtualPosition[] {
  return groupVirtualByUiBundle(wallet).filter(
    (g) => g.uuid === uuid && g.uiBundleId !== excludeUiBundleId,
  );
}
