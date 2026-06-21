/**
 * Live pricing service — bridges Polymarket probabilities to bundle valuation.
 * Maintains a 60s vault-price cache (getVaultPrice/warmVaultPriceCache),
 * recomputes live NAV and issue price by refreshing leg probabilities
 * (getLiveNAV, getIssuePriceForBundle), and detects leg resolutions, mirroring
 * them to the DB and on-chain (checkAndUpdateResolutions).
 */
import { Leg, NAVResult } from '../types';
import { calculateNAV, calculateIssuePrice } from './nav';
import { getMarketProbability, fetchMarketByConditionId } from './polymarket';
import {
  getLegsByBundleId,
  updateLegProbability,
  updateLegResolution,
  getAllBundles,
} from '../db/queries';
import { finalizeBundleIfReady, resolveLegOnchainMirror } from './onchain-bridge';
import { getProductState } from './pelagos-chain';

// ---------------------------------------------------------------------------
// Vault-price cache — refreshed every 60 s so routes don't hammer the RPC
// on every request, but prices stay dynamic.
// ---------------------------------------------------------------------------
interface VaultPriceEntry { issue_price: number; fee_bps: number; fetched_at: number; }
const _vaultPriceCache = new Map<string, VaultPriceEntry>();
const VAULT_PRICE_TTL_MS = 60_000;

export async function getVaultPrice(
  bundleId: string,
): Promise<{ issue_price: number; fee_bps: number } | null> {
  const cached = _vaultPriceCache.get(bundleId);
  if (cached && Date.now() - cached.fetched_at < VAULT_PRICE_TTL_MS) {
    return { issue_price: cached.issue_price, fee_bps: cached.fee_bps };
  }
  try {
    const vault = await getProductState(bundleId);
    if (!vault) return null;
    const entry: VaultPriceEntry = {
      issue_price: vault.issuePriceBps / 10_000,
      fee_bps: vault.feeBps,
      fetched_at: Date.now(),
    };
    _vaultPriceCache.set(bundleId, entry);
    return { issue_price: entry.issue_price, fee_bps: entry.fee_bps };
  } catch {
    return null;
  }
}

/**
 * Warm the vault-price cache for all active bundles in one parallel pass.
 * Called at startup and by the cron so routes get instant cache hits.
 */
export async function warmVaultPriceCache(): Promise<Map<string, number>> {
  const bundles = await getAllBundles();
  const priceMap = new Map<string, number>();
  await Promise.allSettled(
    bundles.filter((b) => b.status === 'active').map(async (b) => {
      const vp = await getVaultPrice(b.id);
      if (vp) priceMap.set(b.id, vp.issue_price);
    }),
  );
  return priceMap;
}

export async function getLiveNAV(bundleId: string): Promise<NAVResult | null> {
  const legs = await getLegsByBundleId(bundleId);
  if (legs.length === 0) return null;

  const activeLegs = legs.filter((l) => l.status === 'active');

  const updates = await Promise.allSettled(
    activeLegs.map(async (leg) => {
      const prob = await getMarketProbability(leg.market_id);
      if (prob !== null) {
        leg.probability = prob;
        await updateLegProbability(leg.id, prob);
      }
    })
  );

  for (const result of updates) {
    if (result.status === 'rejected') {
      console.error('Failed to update leg probability:', result.reason);
    }
  }

  return calculateNAV(legs, bundleId);
}

export async function getIssuePriceForBundle(bundleId: string): Promise<number | null> {
  const legs = await getLegsByBundleId(bundleId);
  if (legs.length === 0) return null;

  const activeLegs = legs.filter((l) => l.status === 'active');

  await Promise.allSettled(
    activeLegs.map(async (leg) => {
      const prob = await getMarketProbability(leg.market_id);
      if (prob !== null) {
        leg.probability = prob;
      }
    })
  );

  return calculateIssuePrice(legs);
}

export async function checkAndUpdateResolutions(bundleId: string): Promise<Leg[]> {
  const legs = await getLegsByBundleId(bundleId);
  const activeLegs = legs.filter((l) => l.status === 'active');
  const newlyResolved: Leg[] = [];

  await Promise.allSettled(
    activeLegs.map(async (leg) => {
      const market = await fetchMarketByConditionId(leg.market_id);
      if (!market) return;

      const prob = await getMarketProbability(leg.market_id);
      if (prob === null) return;

      let resolved = false;
      let status: 'won' | 'lost' = 'won';
      let resolutionValue = 1.0;

      if (market.closed) {
        resolved = true;
        if (prob >= 0.5) {
          status = 'won';
          resolutionValue = 1.0;
        } else {
          status = 'lost';
          resolutionValue = 0.0;
        }
      } else if (prob >= 0.99) {
        resolved = true;
        status = 'won';
        resolutionValue = 1.0;
      } else if (prob <= 0.01) {
        resolved = true;
        status = 'lost';
        resolutionValue = 0.0;
      }

      if (resolved) {
        await updateLegResolution(leg.id, status, resolutionValue);
        // Mirror the resolution on-chain. Failures are logged but do not
        // block the DB-side resolution (UI stays accurate regardless).
        resolveLegOnchainMirror(bundleId, leg.id, status).catch((e) =>
          console.error('[pricing] onchain resolve mirror failed:', e)
        );
        leg.status = status;
        leg.resolution_value = resolutionValue;
        leg.probability = prob;
        newlyResolved.push(leg);
      } else {
        leg.probability = prob;
        await updateLegProbability(leg.id, prob);
      }
    })
  );

  // If this resolution round completed the bundle, call finalize_vault on-chain.
  if (newlyResolved.length > 0) {
    finalizeBundleIfReady(bundleId).catch((e) =>
      console.error('[pricing] onchain finalize failed:', e)
    );
  }

  return newlyResolved;
}
