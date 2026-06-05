/**
 * Bridge between Supabase bundle rows and the live on-chain vault.
 *
 * Pelagos uses a single shared on-chain vault for all baskets, so per-bundle
 * "init / resolve / finalize" no longer fabricate a market or a signature. We
 * return the REAL vault object references and mirror resolution status in the
 * DB (best-effort) — never an invented `sui-init-...` string.
 */
import { supabase } from '../db/supabase';
import {
  getBundleById,
  getLegsByBundleId,
  updateBundleStatus,
} from '../db/queries';
import { derivedObjectsForBundle } from './pelagos-chain';

export async function initializeOnchainVaultForBundle(
  bundleId: string,
): Promise<{ suiMarketId: string; suiPoolId: string; suiReceiptType: string; note: string } | null> {
  const bundle = await getBundleById(bundleId);
  if (!bundle) return null;

  // Best-effort: assign deterministic leg ordering for display.
  try {
    const legs = await getLegsByBundleId(bundleId);
    const sortedLegs = [...legs].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    await Promise.all(
      sortedLegs.map((leg, idx) =>
        supabase.from('legs').update({ leg_index: idx }).eq('id', leg.id),
      ),
    );
  } catch {
    /* DB optional */
  }

  const objects = derivedObjectsForBundle(bundleId);
  return {
    ...objects,
    note: 'Bundle is backed by the shared on-chain Pelagos vault; deposits mint real VaultShare receipts.',
  };
}

/**
 * Mirror a leg's resolution in the DB. There is no per-bundle on-chain market
 * to settle, so this returns null (no on-chain tx) rather than a fake digest.
 */
export async function resolveLegOnchainMirror(
  _bundleId: string,
  legId: string,
  outcome: 'won' | 'lost',
): Promise<string | null> {
  try {
    await supabase
      .from('legs')
      .update({ onchain_resolved_at: new Date().toISOString() })
      .eq('id', legId);
  } catch {
    /* DB optional */
  }
  void outcome;
  return null;
}

export async function finalizeBundleIfReady(bundleId: string): Promise<string | null> {
  const legs = await getLegsByBundleId(bundleId);
  if (legs.length === 0) return null;
  if (legs.some((l) => l.status !== 'won' && l.status !== 'lost')) return null;

  try {
    await supabase
      .from('bundles')
      .update({ onchain_finalized_at: new Date().toISOString(), status: 'resolved' })
      .eq('id', bundleId);
    await updateBundleStatus(bundleId, 'resolved');
  } catch {
    /* DB optional */
  }
  // No on-chain finalize tx in the single-vault model.
  return null;
}

export { derivedObjectsForBundle };
