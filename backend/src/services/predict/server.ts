import { PREDICT } from './config';

/**
 * Thin client over the public DeepBook Predict indexer.
 *
 *   https://predict-server.testnet.mystenlabs.com
 *
 * This is the recommended render/query backend (see packages/predict/README.md).
 * Use it for lists, oracle state, manager summaries, and history; reserve direct
 * on-chain reads for confirmation-critical wallet flows.
 */

export type OracleStatus = 'pending' | 'active' | 'settled' | string;

export interface PredictOracle {
  predict_id: string;
  oracle_id: string;
  oracle_cap_id?: string;
  underlying_asset: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: OracleStatus;
  activated_at?: number | null;
  settlement_price?: number | null;
  settled_at?: number | null;
  created_checkpoint?: number;
}

export interface PredictManagerRef {
  manager_id: string;
  owner: string;
  digest?: string;
  checkpoint?: number;
  checkpoint_timestamp_ms?: number;
  package?: string;
}

async function get<T>(pathname: string): Promise<T> {
  const url = `${PREDICT.serverUrl}${pathname}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `predict-server GET ${pathname} failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

export const predictServer = {
  status: () => get<Record<string, unknown>>('/status'),
  config: () => get<Record<string, unknown>>('/config'),

  /** All oracles the indexer knows about (across statuses). */
  oracles: () => get<PredictOracle[]>('/oracles'),

  predictState: (predictId = PREDICT.predictObjectId) =>
    get<Record<string, unknown>>(`/predicts/${predictId}/state`),
  predictOracles: (predictId = PREDICT.predictObjectId) =>
    get<PredictOracle[]>(`/predicts/${predictId}/oracles`),
  vaultSummary: (predictId = PREDICT.predictObjectId) =>
    get<Record<string, unknown>>(`/predicts/${predictId}/vault/summary`),

  oracleState: (oracleId: string) =>
    get<Record<string, unknown>>(`/oracles/${oracleId}/state`),
  oracleSviLatest: (oracleId: string) =>
    get<Record<string, unknown>>(`/oracles/${oracleId}/svi/latest`),
  oraclePriceLatest: (oracleId: string) =>
    get<Record<string, unknown>>(`/oracles/${oracleId}/prices/latest`),
  oracleAskBounds: (oracleId: string) =>
    get<Record<string, unknown>>(`/oracles/${oracleId}/ask-bounds`),

  managers: () => get<PredictManagerRef[]>('/managers'),
  managerSummary: (managerId: string) =>
    get<Record<string, unknown>>(`/managers/${managerId}/summary`),
  managerPositions: (managerId: string) =>
    get<Record<string, unknown>>(`/managers/${managerId}/positions/summary`),
  managerPnl: (managerId: string, range = 'ALL') =>
    get<Record<string, unknown>>(`/managers/${managerId}/pnl?range=${range}`),
};

/** Managers owned by a specific address. */
export async function managersForOwner(owner: string): Promise<PredictManagerRef[]> {
  const want = owner.toLowerCase();
  const all = await predictServer.managers();
  return all.filter((m) => (m.owner ?? '').toLowerCase() === want);
}

/**
 * Pick the most useful currently-tradeable oracle: status `active`, soonest
 * expiry first, but skipping oracles that are about to expire. Within the last
 * few minutes the protocol's implied distribution collapses toward a point mass,
 * which pushes every priced band outside the [2%,98%] mintable window (central
 * band > 98% "too certain", wings < 2%) — so the auto-selected front oracle
 * would quote a strip with zero tradeable buckets. A short buffer guarantees the
 * selected oracle has a live, well-priced distribution. Falls back to the
 * soonest active oracle if every oracle is inside the buffer.
 */
export async function findActiveOracle(
  underlying?: string,
  minMsToExpiry = 6 * 60_000,
): Promise<PredictOracle | null> {
  const now = Date.now();
  const want = underlying?.toUpperCase();
  const oracles = await predictServer.predictOracles().catch(() => predictServer.oracles());
  const active = oracles
    .filter((o) => o.status === 'active' && o.expiry > now)
    .filter((o) => (want ? o.underlying_asset?.toUpperCase() === want : true))
    .sort((a, b) => a.expiry - b.expiry);
  return active.find((o) => o.expiry - now >= minMsToExpiry) ?? active[0] ?? null;
}

/**
 * Compute a valid on-grid strike for an oracle. Strikes live on
 * `min_strike + k * tick_size`; this snaps `target` to the nearest grid point.
 * When `target` is omitted, returns the grid point nearest the oracle spot/forward
 * if provided, else `min_strike`.
 */
export function snapStrikeToGrid(oracle: PredictOracle, target?: number): number {
  const { min_strike, tick_size } = oracle;
  if (!tick_size || tick_size <= 0) return min_strike;
  if (target === undefined) return min_strike;
  const k = Math.max(0, Math.round((target - min_strike) / tick_size));
  return min_strike + k * tick_size;
}
