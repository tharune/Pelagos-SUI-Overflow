import { supabase } from './supabase';
import { Bundle, Leg, Position, Transaction, BundleWithLegs, NAVSnapshot, LegNAVContribution, PPNVault, PriceAlert } from '../types';

// --- Bundles ---

export async function getAllBundles(): Promise<Bundle[]> {
  const { data, error } = await supabase
    .from('bundles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getAllBundles error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getBundleById(id: string): Promise<Bundle | null> {
  const { data, error } = await supabase
    .from('bundles')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    console.error('getBundleById error:', error.message);
    return null;
  }
  return data;
}

export async function getBundleByName(name: string): Promise<Bundle | null> {
  const { data, error } = await supabase
    .from('bundles')
    .select('*')
    .eq('name', name)
    .single();

  if (error) {
    console.error('getBundleByName error:', error.message);
    return null;
  }
  return data;
}

export async function createBundle(
  bundle: Omit<Bundle, 'id' | 'created_at' | 'status'>
): Promise<Bundle | null> {
  const { data, error } = await supabase
    .from('bundles')
    .insert(bundle)
    .select()
    .single();

  if (error) {
    console.error('createBundle error:', error.message);
    return null;
  }
  return data;
}

export async function updateBundleStatus(
  bundleId: string,
  status: Bundle['status']
): Promise<Bundle | null> {
  const { data, error } = await supabase
    .from('bundles')
    .update({ status })
    .eq('id', bundleId)
    .select()
    .single();

  if (error) {
    console.error('updateBundleStatus error:', error.message);
    return null;
  }
  return data;
}

// --- Legs ---

export async function getLegsByBundleId(bundleId: string): Promise<Leg[]> {
  const { data, error } = await supabase
    .from('legs')
    .select('*')
    .eq('bundle_id', bundleId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('getLegsByBundleId error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getBundleWithLegs(id: string): Promise<BundleWithLegs | null> {
  const bundle = await getBundleById(id);
  if (!bundle) return null;

  const legs = await getLegsByBundleId(id);

  const nav = legs.reduce((sum, leg) => {
    const value = leg.status === 'active'
      ? leg.probability
      : (leg.resolution_value ?? 0);
    return sum + leg.weight * value;
  }, 0);

  return {
    ...bundle,
    legs,
    nav,
    num_legs: legs.length,
    resolved_legs: legs.filter(l => l.status !== 'active').length,
  };
}

export async function createLeg(
  leg: Omit<Leg, 'id' | 'created_at' | 'status'>
): Promise<Leg | null> {
  const { data, error } = await supabase
    .from('legs')
    .insert(leg)
    .select()
    .single();

  if (error) {
    console.error('createLeg error:', error.message);
    return null;
  }
  return data;
}

export async function updateLegProbability(
  legId: string,
  probability: number
): Promise<Leg | null> {
  const { data, error } = await supabase
    .from('legs')
    .update({ probability })
    .eq('id', legId)
    .select()
    .single();

  if (error) {
    console.error('updateLegProbability error:', error.message);
    return null;
  }
  return data;
}

export async function updateLegResolution(
  legId: string,
  status: 'won' | 'lost',
  resolutionValue: number
): Promise<Leg | null> {
  const { data, error } = await supabase
    .from('legs')
    .update({ status, resolution_value: resolutionValue })
    .eq('id', legId)
    .select()
    .single();

  if (error) {
    console.error('updateLegResolution error:', error.message);
    return null;
  }
  return data;
}

// --- Positions ---

export async function createPosition(
  position: Omit<Position, 'id' | 'created_at'>
): Promise<Position | null> {
  const { data, error } = await supabase
    .from('positions')
    .insert(position)
    .select()
    .single();

  if (error) {
    console.error('createPosition error:', error.message);
    return null;
  }
  return data;
}

export async function getPositionsByWallet(walletAddress: string): Promise<Position[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('wallet_address', walletAddress)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getPositionsByWallet error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getPositionsByBundle(bundleId: string): Promise<Position[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('bundle_id', bundleId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getPositionsByBundle error:', error.message);
    return [];
  }
  return data ?? [];
}

// --- Transactions ---

export async function createTransaction(
  transaction: Omit<Transaction, 'id' | 'created_at'>
): Promise<Transaction | null> {
  const { data, error } = await supabase
    .from('transactions')
    .insert(transaction)
    .select()
    .single();

  if (error) {
    console.error('createTransaction error:', error.message);
    return null;
  }
  return data;
}

export async function getTransactionsByWallet(walletAddress: string): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('wallet_address', walletAddress)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getTransactionsByWallet error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getPositionsByWalletAndBundle(
  walletAddress: string,
  bundleId: string
): Promise<Position[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('wallet_address', walletAddress)
    .eq('bundle_id', bundleId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getPositionsByWalletAndBundle error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function updatePositionTokens(
  positionId: string,
  tokensHeld: number
): Promise<Position | null> {
  const { data, error } = await supabase
    .from('positions')
    .update({ tokens_held: tokensHeld })
    .eq('id', positionId)
    .select()
    .single();

  if (error) {
    console.error('updatePositionTokens error:', error.message);
    return null;
  }
  return data;
}

export async function updatePositionHoldings(
  positionId: string,
  holdings: { tokens_held: number; deposited_usdc: number },
): Promise<Position | null> {
  const { data, error } = await supabase
    .from('positions')
    .update({
      tokens_held: holdings.tokens_held,
      deposited_usdc: holdings.deposited_usdc,
    })
    .eq('id', positionId)
    .select()
    .single();

  if (error) {
    console.error('updatePositionHoldings error:', error.message);
    return null;
  }
  return data;
}

// --- NAV Snapshots ---

export async function createNAVSnapshot(
  bundleId: string,
  nav: number,
  legsData: LegNAVContribution[]
): Promise<NAVSnapshot | null> {
  const { data, error } = await supabase
    .from('nav_snapshots')
    .insert({ bundle_id: bundleId, nav, legs_data: legsData })
    .select()
    .single();

  if (error) {
    console.error('createNAVSnapshot error:', error.message);
    return null;
  }
  return data;
}

export async function getNAVHistory(
  bundleId: string,
  limit: number = 100
): Promise<NAVSnapshot[]> {
  const { data, error } = await supabase
    .from('nav_snapshots')
    .select('*')
    .eq('bundle_id', bundleId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('getNAVHistory error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getNAVHistorySince(
  bundleId: string,
  since: string
): Promise<NAVSnapshot[]> {
  const { data, error } = await supabase
    .from('nav_snapshots')
    .select('*')
    .eq('bundle_id', bundleId)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getNAVHistorySince error:', error.message);
    return [];
  }
  return data ?? [];
}

// --- Admin / Stats ---

export async function getAllPositions(): Promise<Position[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getAllPositions error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getAllTransactions(params?: {
  wallet?: string;
  type?: string;
  limit?: number;
}): Promise<Transaction[]> {
  let query = supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: false });

  if (params?.wallet) {
    query = query.eq('wallet_address', params.wallet);
  }
  if (params?.type) {
    query = query.eq('type', params.type);
  }
  if (params?.limit) {
    query = query.limit(params.limit);
  }

  const { data, error } = await query;

  if (error) {
    console.error('getAllTransactions error:', error.message);
    return [];
  }
  return data ?? [];
}

// --- PPN Vaults ---

export async function createPPNVault(
  vault: Omit<PPNVault, 'id' | 'created_at'>
): Promise<PPNVault | null> {
  // All columns that may be absent on older Supabase schemas. We strip these
  // proactively and add any extra ones reported by the API on each attempt.
  const knownOptional = new Set([
    'note_seed_hex',
    'onchain_tx_signature',
    'redemption_tx_signature',
    'maturity_ts',
    'tranche_kind',
    'tranche_attach',
    'tranche_detach',
    'price_per_token',
    'vault_address',
  ]);

  let payload: Record<string, unknown> = { ...vault };

  for (let attempt = 0; attempt < 10; attempt++) {
    const { data, error } = await supabase
      .from('ppn_vaults')
      .insert(payload)
      .select()
      .single();

    if (!error) return data;

    const missing = Array.from(
      error.message.matchAll(/Could not find the '([^']*)' column/g),
    ).map((m: RegExpMatchArray) => m[1]);

    if (missing.length === 0) {
      console.error('createPPNVault error:', error.message);
      throw new Error(`createPPNVault: ${error.message}`);
    }

    for (const col of missing) knownOptional.add(col);
    payload = Object.fromEntries(
      Object.entries(payload).filter(([k]) => !knownOptional.has(k)),
    );
    console.warn('createPPNVault: retrying without columns', Array.from(knownOptional));
  }

  throw new Error('createPPNVault: gave up after 10 retries');
}

export async function getPPNVaultsByWallet(walletAddress: string): Promise<PPNVault[]> {
  // Only return rows the user actually completed on-chain AND hasn't already
  // redeemed:
  //   - `onchain_tx_signature IS NOT NULL` — the `/prepare` endpoint writes a
  //     vault row before confirmation, so a cancelled deposit leaves a row
  //     with a null signature. `/confirm` only stamps the signature after the
  //     Sui write confirms, so this filter is the dividing line between
  //     "real principal on-chain" and "abandoned row".
  //   - `status != 'withdrawn'` — `/onchain/redeem/confirm` flips status to
  //     `withdrawn` but leaves the original deposit signature in place, so
  //     without this gate a redeemed vault would keep showing up on the
  //     portfolio at full principal even though the user already has the
  //     USDC back in their wallet.
  const { data, error } = await supabase
    .from('ppn_vaults')
    .select('*')
    .eq('wallet_address', walletAddress)
    .not('onchain_tx_signature', 'is', null)
    .neq('status', 'withdrawn')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getPPNVaultsByWallet error:', error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Tranche-only positions for a wallet. Excludes vanilla PPN notes where
 * `tranche_kind` is null, AND excludes rows with no on-chain signature
 * (rows from cancelled transactions). Used by the
 * tranche portfolio UI.
 */
export async function getTranchesByWallet(walletAddress: string): Promise<PPNVault[]> {
  const { data, error } = await supabase
    .from('ppn_vaults')
    .select('*')
    .eq('wallet_address', walletAddress)
    .not('tranche_kind', 'is', null)
    .not('onchain_tx_signature', 'is', null)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getTranchesByWallet error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getPPNVaultById(id: string): Promise<PPNVault | null> {
  const { data, error } = await supabase
    .from('ppn_vaults')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    console.error('getPPNVaultById error:', error.message);
    return null;
  }
  return data;
}

export async function updatePPNVaultYield(
  id: string,
  yieldDeployed: number
): Promise<PPNVault | null> {
  const { data, error } = await supabase
    .from('ppn_vaults')
    .update({ yield_deployed_usdc: yieldDeployed })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('updatePPNVaultYield error:', error.message);
    return null;
  }
  return data;
}

export async function updatePPNVaultStatus(
  id: string,
  status: PPNVault['status']
): Promise<PPNVault | null> {
  const { data, error } = await supabase
    .from('ppn_vaults')
    .update({ status })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('updatePPNVaultStatus error:', error.message);
    return null;
  }
  return data;
}

/**
 * Update the on-chain artifacts for a PPN vault after a Sui write confirms.
 */
export async function updatePPNVaultOnchain(
  id: string,
  updates: Partial<
    Pick<
      PPNVault,
      'note_seed_hex'
      | 'onchain_tx_signature'
      | 'redemption_tx_signature'
      | 'maturity_ts'
      | 'vault_address'
      | 'status'
      | 'tranche_kind'
      | 'tranche_attach'
      | 'tranche_detach'
      | 'price_per_token'
    >
  >
): Promise<PPNVault | null> {
  let payload: Record<string, unknown> = { ...updates };

  for (let attempt = 0; attempt < 10; attempt++) {
    if (Object.keys(payload).length === 0) {
      // Nothing left to update — fetch and return the existing row.
      const { data } = await supabase.from('ppn_vaults').select('*').eq('id', id).single();
      return data ?? null;
    }

    const { data, error } = await supabase
      .from('ppn_vaults')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (!error) return data;

    const missing = Array.from(
      error.message.matchAll(/Could not find the '([^']*)' column/g),
    ).map((m: RegExpMatchArray) => m[1]);

    if (missing.length === 0) {
      console.error('updatePPNVaultOnchain error:', error.message);
      return null;
    }

    for (const col of missing) delete payload[col];
    console.warn('updatePPNVaultOnchain: retrying without columns', missing);
  }

  return null;
}

/**
 * Look up a PPN vault by wallet + bundle. The frontend doesn't know the vault
 * UUID during the redeem flow (it only has wallet + bundle), so this lets us
 * find the one active note. Returns the most recent active vault if multiple
 * exist.
 */
export async function getActivePPNVault(
  walletAddress: string,
  bundleId: string
): Promise<PPNVault | null> {
  const { data, error } = await supabase
    .from('ppn_vaults')
    .select('*')
    .eq('wallet_address', walletAddress)
    .eq('bundle_id', bundleId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('getActivePPNVault error:', error.message);
    return null;
  }
  return (data ?? [])[0] ?? null;
}

export async function getAllLegs(): Promise<Leg[]> {
  const { data, error } = await supabase
    .from('legs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getAllLegs error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getTransactionStats(): Promise<{
  total_deposited: number;
  total_redeemed: number;
  total_fees: number;
}> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*');

  if (error) {
    console.error('getTransactionStats error:', error.message);
    return { total_deposited: 0, total_redeemed: 0, total_fees: 0 };
  }

  const transactions = data ?? [];

  const total_deposited = transactions
    .filter((t) => t.type === 'deposit')
    .reduce((sum, t) => sum + t.amount_usdc, 0);

  const total_redeemed = transactions
    .filter((t) => t.type === 'redemption')
    .reduce((sum, t) => sum + t.amount_usdc, 0);

  const total_fees = transactions.reduce((sum, t) => sum + t.fee_usdc, 0);

  return { total_deposited, total_redeemed, total_fees };
}

// --- Price Alerts ---

export async function createPriceAlert(
  alert: Omit<PriceAlert, 'id' | 'created_at' | 'triggered' | 'triggered_at' | 'triggered_nav'>
): Promise<PriceAlert | null> {
  const { data, error } = await supabase
    .from('price_alerts')
    .insert(alert)
    .select()
    .single();

  if (error) {
    console.error('createPriceAlert error:', error.message);
    return null;
  }
  return data;
}

export async function getAlertsByWallet(walletAddress: string): Promise<PriceAlert[]> {
  const { data, error } = await supabase
    .from('price_alerts')
    .select('*')
    .eq('wallet_address', walletAddress)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getAlertsByWallet error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function getActiveAlertsByBundle(bundleId: string): Promise<PriceAlert[]> {
  const { data, error } = await supabase
    .from('price_alerts')
    .select('*')
    .eq('bundle_id', bundleId)
    .eq('triggered', false);

  if (error) {
    console.error('getActiveAlertsByBundle error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function triggerAlert(
  alertId: string,
  nav: number
): Promise<PriceAlert | null> {
  const { data, error } = await supabase
    .from('price_alerts')
    .update({
      triggered: true,
      triggered_at: new Date().toISOString(),
      triggered_nav: nav,
    })
    .eq('id', alertId)
    .select()
    .single();

  if (error) {
    console.error('triggerAlert error:', error.message);
    return null;
  }
  return data;
}

export async function deleteAlert(alertId: string): Promise<boolean> {
  const { error } = await supabase
    .from('price_alerts')
    .delete()
    .eq('id', alertId);

  if (error) {
    console.error('deleteAlert error:', error.message);
    return false;
  }
  return true;
}
