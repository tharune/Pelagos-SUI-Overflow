/**
 * Bridge between Supabase rows and Pelagos Sui product state.
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
): Promise<{ suiMarketId: string; suiPoolId: string; suiReceiptType: string; signature: string } | null> {
  const bundle = await getBundleById(bundleId);
  if (!bundle) return null;

  const legs = await getLegsByBundleId(bundleId);
  const sortedLegs = [...legs].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  await Promise.all(
    sortedLegs.map((leg, idx) =>
      supabase.from('legs').update({ leg_index: idx }).eq('id', leg.id),
    ),
  );

  const objects = derivedObjectsForBundle(bundleId);
  const signature = `sui-init-${bundleId}`;
  await supabase
    .from('bundles')
    .update({ onchain_tx_signature: signature })
    .eq('id', bundleId);

  return { ...objects, signature };
}

export async function resolveLegOnchainMirror(
  bundleId: string,
  legId: string,
  outcome: 'won' | 'lost',
): Promise<string | null> {
  const signature = `sui-resolve-${bundleId}-${legId}-${outcome}`;
  await supabase
    .from('legs')
    .update({
      onchain_resolved_at: new Date().toISOString(),
      onchain_resolve_tx: signature,
    })
    .eq('id', legId);
  return signature;
}

export async function finalizeBundleIfReady(bundleId: string): Promise<string | null> {
  const legs = await getLegsByBundleId(bundleId);
  if (legs.length === 0) return null;
  if (legs.some((l) => l.status !== 'won' && l.status !== 'lost')) return null;

  const signature = `sui-finalize-${bundleId}`;
  await supabase
    .from('bundles')
    .update({
      onchain_finalized_at: new Date().toISOString(),
      onchain_finalize_tx: signature,
      status: 'resolved',
    })
    .eq('id', bundleId);
  await updateBundleStatus(bundleId, 'resolved');
  return signature;
}

export { derivedObjectsForBundle };
