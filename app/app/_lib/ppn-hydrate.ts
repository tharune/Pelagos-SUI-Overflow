/**
 * Shared PPN + tranche hydrate helpers.
 *
 * Both the Portfolio page and the standalone PPN page need to turn a raw
 * `/api/ppn/portfolio/:wallet` response into the reducer-friendly shapes that
 * `ppn/hydrate` + `tranche/hydrate` expect. The merge policy here collapses
 * duplicate rows so the UI reflects positions-per-contract rather than
 * rows-per-deposit:
 *
 *   - PPN vaults are grouped by `bundle_id` (user-facing: "buy $1 then buy
 *     another $1 of the same note should be one card").
 *   - Tranche positions are grouped by `(bundle_id, tranche_kind)` so buying
 *     the same tranche twice collapses into one card.
 *
 * Kept in `_lib/` so both pages import from the same source of truth —
 * previously this logic lived inline in `portfolio/page.tsx` and the PPN page
 * just rendered whatever happened to be in the reducer, which meant a
 * standalone visit to `/app/ppn` saw the raw un-merged rows.
 */
import type { PpnVault, TranchePosition } from "./demo-state";
import type { PpnPortfolio, PpnPortfolioEntry } from "./ppn-client";

/**
 * A vault row is a tranche if ANY of the tranche-specific columns are set.
 * The backend's retry path can strip columns on older schemas, so we don't
 * require all of them — any single signal flips the row into the tranche
 * bucket. Without this, tranche rows leak into the PPN card list.
 */
export function looksLikeTranche(v: PpnPortfolioEntry): boolean {
  return (
    v.tranche_kind != null ||
    v.price_per_token != null ||
    v.tranche_attach != null ||
    v.tranche_detach != null
  );
}

/**
 * Backend sends `estimated_apy` as a 0..1 fraction (e.g. 0.08 for 8%). UI
 * layers want a percentage (8). Values already > 1 are left alone so a
 * future backend switch to percent won't double-up.
 */
export function apyPct(apy: number): number {
  return apy <= 1 ? apy * 100 : apy;
}

/**
 * Collapse multiple `ppn_vaults` rows with the same `bundle_id` into a
 * single `PpnVault`:
 *
 * - principal + basketAmount sum
 * - APY is principal-weighted so the blended headline rate matches the
 *   user's actual exposure
 * - createdAt = earliest deposit (accrual anchors on the oldest slice)
 * - maturity = latest (createdAt + maturityDays * ms/day), so the Redeem
 *   button only enables once every underlying note has matured
 * - allVaultIds carries every underlying id so Redeem can walk each note
 */
export function mergePpnVaults(portfolio: PpnPortfolio): PpnVault[] {
  const ppnMap = new Map<string, PpnVault>();
  for (const v of portfolio.vaults.filter((x) => !looksLikeTranche(x))) {
    const createdAt = new Date(v.created_at).getTime();
    const maturityDays = v.days_elapsed + v.days_remaining;
    const existing = ppnMap.get(v.bundle_id);
    if (existing) {
      const existingMaturityMs =
        existing.createdAt + existing.maturityDays * 86_400_000;
      const incomingMaturityMs = createdAt + maturityDays * 86_400_000;
      const nextCreatedAt = Math.min(existing.createdAt, createdAt);
      const nextMaturityMs = Math.max(existingMaturityMs, incomingMaturityMs);
      const nextMaturityDays = Math.max(
        0,
        (nextMaturityMs - nextCreatedAt) / 86_400_000,
      );
      const totalPrincipal = existing.principal + v.principal_usdc;
      const blendedApy =
        totalPrincipal > 0
          ? (existing.apy * existing.principal +
              apyPct(v.estimated_apy) * v.principal_usdc) /
            totalPrincipal
          : existing.apy;
      ppnMap.set(v.bundle_id, {
        id: existing.id,
        bundleId: existing.bundleId,
        principal: totalPrincipal,
        basketAmount: existing.basketAmount + v.yield_deployed_usdc,
        apy: blendedApy,
        createdAt: nextCreatedAt,
        maturityDays: nextMaturityDays,
        allVaultIds: [...(existing.allVaultIds ?? [existing.id]), v.vault_id],
      });
    } else {
      ppnMap.set(v.bundle_id, {
        id: v.vault_id,
        bundleId: v.bundle_id,
        principal: v.principal_usdc,
        basketAmount: v.yield_deployed_usdc,
        apy: apyPct(v.estimated_apy),
        createdAt,
        maturityDays,
        allVaultIds: [v.vault_id],
      });
    }
  }
  return Array.from(ppnMap.values());
}

/**
 * Collapse multiple tranche rows with the same `(bundle_id, tranche_kind)`
 * into a single `TranchePosition`. Qty-weighted `avgCost` so the blended
 * issue price matches what the user paid across deposits.
 */
export function mergeTranches(portfolio: PpnPortfolio): TranchePosition[] {
  type Kind = NonNullable<TranchePosition["kind"]>;
  type Hydrated = TranchePosition & {
    vaultId: string;
    maturityAt: number;
    apy: number;
    createdAt: number;
    maturityDays: number;
    allVaultIds: string[];
  };
  const trancheMap = new Map<string, Hydrated>();
  for (const v of portfolio.vaults.filter(looksLikeTranche)) {
    // price_per_token missing / zero falls back to $1 issue price so the row
    // still shows up rather than vanishing. qty * avgCost still equals the
    // correct notional in that fallback path.
    const pricePerToken =
      v.price_per_token && v.price_per_token > 0 ? v.price_per_token : 1;
    const kind = (v.tranche_kind ?? "senior") as Kind;
    const createdAt = new Date(v.created_at).getTime();
    const maturityDays = v.days_elapsed + v.days_remaining;
    const maturityMs = createdAt + maturityDays * 86_400_000;
    const qty = v.principal_usdc / pricePerToken;
    const key = `${v.bundle_id}::${kind}`;
    const existing = trancheMap.get(key);
    if (existing) {
      const totalQty = existing.qty + qty;
      const blendedCost =
        totalQty > 0
          ? (existing.qty * existing.avgCost + qty * pricePerToken) / totalQty
          : pricePerToken;
      const existingMaturityMs = existing.maturityAt;
      const nextMaturityAt = Math.max(existingMaturityMs, maturityMs);
      const nextCreatedAt = Math.min(existing.createdAt, createdAt);
      const nextMaturityDays = Math.max(
        0,
        (nextMaturityAt - nextCreatedAt) / 86_400_000,
      );
      const blendedApy =
        totalQty > 0
          ? (existing.apy * existing.qty + apyPct(v.estimated_apy) * qty) /
            totalQty
          : existing.apy;
      trancheMap.set(key, {
        ...existing,
        qty: totalQty,
        avgCost: blendedCost,
        maturityAt: nextMaturityAt,
        createdAt: nextCreatedAt,
        maturityDays: nextMaturityDays,
        apy: blendedApy,
        allVaultIds: [...existing.allVaultIds, v.vault_id],
      });
    } else {
      trancheMap.set(key, {
        bundleId: v.bundle_id,
        bundleName: v.bundle_name,
        kind,
        qty,
        avgCost: pricePerToken,
        vaultId: v.vault_id,
        maturityAt: maturityMs,
        apy: apyPct(v.estimated_apy),
        createdAt,
        maturityDays,
        allVaultIds: [v.vault_id],
      });
    }
  }
  return Array.from(trancheMap.values());
}
