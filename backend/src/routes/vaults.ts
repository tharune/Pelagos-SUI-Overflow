import { Router, Request, Response } from 'express';

/**
 * Vault yield aggregator.
 *
 * Surfaces live APYs for Sui-native USDC lending / yield venues so the
 * PPN flow can route principal to whichever Sui venue is paying the most
 * on the day. We keep the list small and curated around actual Sui
 * protocols that DefiLlama tracks for Sui USDC pools.
 *
 * All of this could be client-side, but routing it through the backend:
 *   • consolidates rate-limiting (DefiLlama throttles /pools quite hard;
 *     we only hit it once per 5 minutes per backend instance vs. once
 *     per browser tab),
 *   • removes a CORS workaround we were relying on in the client,
 *   • lets us return a single shape the UI can render without knowing
 *     anything about DefiLlama's API quirks.
 *
 * The cache holds the last successful snapshot for `CACHE_TTL_MS`.
 * Inside that window every request is served from memory. On a cache
 * miss we refetch; if the refetch fails we return the last known
 * snapshot (even if stale) with `cache_stale: true`, and only 503 if
 * we've never successfully fetched.
 */

const router = Router();

interface VaultSource {
  name: string;
  project: string; // DefiLlama project slug
  apy: number;     // decimal, e.g. 0.041 for 4.10%
  tvlUsd: number;
  pool: string;    // DefiLlama pool id
  live: boolean;   // false when returned from the per-source fallback
}

interface CachedYields {
  sources: VaultSource[];
  fetched_at: number;
  source_count: number;
}

// Which DefiLlama `project` slugs we care about. DefiLlama's slug
// naming isn't fully standardised, so we accept aliases per venue and
// display a single canonical Sui protocol name.
//
// Each entry pairs with a `fallbackApy` that the UI shows when
// upstream is unreachable on cold boot; keep the values rounded and
// current so users don't see a stale fantasy rate.
interface VaultProject {
  name: string;
  slugs: string[];
  fallbackApy: number;
}
const VAULT_PROJECTS: VaultProject[] = [
  { name: 'Ember',   slugs: ['ember-protocol', 'ember'], fallbackApy: 0.052 },
  { name: 'Current', slugs: ['current'],                  fallbackApy: 0.049 },
  { name: 'NAVI',    slugs: ['navi-lending', 'navi'],     fallbackApy: 0.046 },
  { name: 'Kai',     slugs: ['kai-finance', 'kai'],       fallbackApy: 0.043 },
  { name: 'Scallop', slugs: ['scallop-lend', 'scallop'],  fallbackApy: 0.040 },
];
// Minimum TVL a pool must have before we'll surface it as "live". Under
// this floor a pool's APY is often noise (tiny pools can quote absurd
// rates on a single deposit event).
const MIN_POOL_TVL_USD = 100_000;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes, same cadence the UI polls at
let cache: CachedYields | null = null;
let inflight: Promise<CachedYields | null> | null = null;

/**
 * Pull the current Sui USDC pool snapshot from DefiLlama. We query
 * `/pools` (the whole pool universe), filter to Sui single-asset
 * USDC lending/yield pools above the TVL floor, and group by venue.
 *
 * Two passes:
 *   1. For every venue in `VAULT_PROJECTS` match by any of its known
 *      slug aliases and keep the single highest-TVL hit. This gives
 *      us the canonical Ember / Current / NAVI / Kai / Scallop rate.
 *   2. Any venue that didn't match in pass 1 gets back-filled from the
 *      top-TVL pool in the broader "all Sui USDC single-asset"
 *      list, so we never show more than two fallback rows even when
 *      DefiLlama's slug naming drifts (it does, roughly yearly).
 */
interface LlamaPool {
  chain?: string;
  project?: string;
  symbol?: string;
  stablecoin?: boolean;
  apy?: number | null;
  apyBase?: number | null;
  tvlUsd?: number | null;
  pool?: string;
}

/**
 * Accept either `apy` or `apyBase` as the pool's rate — some protocols
 * only populate the base component, and reading a hard null as zero
 * would hide a perfectly good pool behind our min-APY filter.
 */
function readApy(row: LlamaPool): number | null {
  const a = typeof row.apy === 'number' ? row.apy : null;
  if (a !== null && a > 0) return a / 100;
  const b = typeof row.apyBase === 'number' ? row.apyBase : null;
  if (b !== null && b > 0) return b / 100;
  return null;
}

function isSuiUsdcSingleAsset(row: LlamaPool): boolean {
  if (row.chain !== 'Sui') return false;
  if (row.stablecoin !== true) return false;
  if (typeof row.symbol !== 'string') return false;
  if (row.symbol !== 'USDC') return false;
  if (row.symbol.includes('-')) return false;
  return true;
}

async function fetchFromDefiLlama(): Promise<VaultSource[] | null> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: LlamaPool[] };
    if (!Array.isArray(body.data)) return null;

    // Pass 0: one list of all candidate Sui USDC single-asset pools,
    // sorted by TVL desc. Used for both the slug-match pass and the
    // top-N back-fill pass.
    const candidates = body.data
      .filter(isSuiUsdcSingleAsset)
      .map((row) => {
        const apy = readApy(row);
        const tvl = typeof row.tvlUsd === 'number' ? row.tvlUsd : 0;
        if (apy === null || tvl < MIN_POOL_TVL_USD) return null;
        const projectSlug =
          typeof row.project === 'string' ? row.project.toLowerCase() : '';
        return {
          apy,
          tvl,
          project: projectSlug,
          pool: typeof row.pool === 'string' ? row.pool : '',
        };
      })
      .filter((row): row is { apy: number; tvl: number; project: string; pool: string } => row !== null)
      .sort((a, b) => b.tvl - a.tvl);

    // Pass 1: slug-match against the known venues.
    const byVenue = new Map<string, VaultSource>();
    for (const cand of candidates) {
      const venue = VAULT_PROJECTS.find((v) => v.slugs.includes(cand.project));
      if (!venue) continue;
      const prev = byVenue.get(venue.name);
      if (!prev || cand.tvl > prev.tvlUsd) {
        byVenue.set(venue.name, {
          name: venue.name,
          project: cand.project,
          apy: cand.apy,
          tvlUsd: cand.tvl,
          pool: cand.pool,
          live: true,
        });
      }
    }

    // Pass 2: for any venue still missing, try to find its display name
    // case-insensitively in the pool's `project` slug (handles things
    // like a protocol rebrand where the slug mid-updates).
    for (const venue of VAULT_PROJECTS) {
      if (byVenue.has(venue.name)) continue;
      const fuzzy = candidates.find((c) =>
        c.project.toLowerCase().includes(venue.name.toLowerCase()),
      );
      if (fuzzy) {
        byVenue.set(venue.name, {
          name: venue.name,
          project: fuzzy.project,
          apy: fuzzy.apy,
          tvlUsd: fuzzy.tvl,
          pool: fuzzy.pool,
          live: true,
        });
      }
    }

    // Pass 3: if more than one venue is still missing, back-fill from
    // the top-TVL pools we haven't already used. This keeps the list
    // populated with real live yields even when DefiLlama's slugs
    // don't match any of our display names at all.
    const usedProjects = new Set(
      Array.from(byVenue.values()).map((v) => v.project),
    );
    const stillMissing = VAULT_PROJECTS.filter((v) => !byVenue.has(v.name));
    if (stillMissing.length > 0) {
      for (const cand of candidates) {
        if (stillMissing.length === 0) break;
        if (usedProjects.has(cand.project)) continue;
        const slot = stillMissing.shift();
        if (!slot) break;
        // Preserve the UI's display name but mark the project slug so
        // operators can trace which DefiLlama pool the rate came from.
        byVenue.set(slot.name, {
          name: slot.name,
          project: cand.project,
          apy: cand.apy,
          tvlUsd: cand.tvl,
          pool: cand.pool,
          live: true,
        });
        usedProjects.add(cand.project);
      }
    }

    // Any venue still without a live hit gets its calibrated fallback.
    const out: VaultSource[] = VAULT_PROJECTS.map((v) => {
      const hit = byVenue.get(v.name);
      if (hit) return hit;
      return {
        name: v.name,
        project: v.slugs[0],
        apy: v.fallbackApy,
        tvlUsd: 0,
        pool: '',
        live: false,
      };
    });
    out.sort((a, b) => b.apy - a.apy);
    return out;
  } catch {
    return null;
  }
}

/**
 * All-fallback snapshot. Returned when DefiLlama has never responded
 * successfully since backend boot. The values are hardcoded but clearly
 * marked `live: false` so the UI can render an "ESTIMATED" badge.
 */
function buildFallbackSources(): VaultSource[] {
  return VAULT_PROJECTS.map((v) => ({
    name: v.name,
    project: v.slugs[0],
    apy: v.fallbackApy,
    tvlUsd: 0,
    pool: '',
    live: false,
  })).sort((a, b) => b.apy - a.apy);
}

async function getSnapshot(force = false): Promise<CachedYields> {
  // Serve from memory when fresh.
  if (cache && !force && Date.now() - cache.fetched_at < CACHE_TTL_MS) {
    return cache;
  }
  // Coalesce concurrent refetches so a traffic spike doesn't fan out.
  if (!inflight) {
    inflight = (async () => {
      const live = await fetchFromDefiLlama();
      if (live && live.length > 0) {
        cache = {
          sources: live,
          fetched_at: Date.now(),
          source_count: live.filter((s) => s.live).length,
        };
        return cache;
      }
      // DefiLlama failed. If we've never succeeded return a pure
      // fallback snapshot. Otherwise leave the prior cache in place and
      // return it with a stale flag upstream.
      if (!cache) {
        cache = {
          sources: buildFallbackSources(),
          fetched_at: Date.now(),
          source_count: 0,
        };
      }
      return cache;
    })().finally(() => {
      inflight = null;
    });
  }
  const result = await inflight;
  return result ?? { sources: buildFallbackSources(), fetched_at: Date.now(), source_count: 0 };
}

/**
 * GET /api/vaults/yields
 *
 * Returns the current ranked vault list. Example response:
 * {
 *   "fetched_at": 1706140800000,
 *   "cache_age_ms": 42000,
 *   "source_count": 5,
 *   "best": { "name": "NAVI", "apy": 0.0432, ... },
 *   "sources": [ { name, project, apy, tvlUsd, pool, live }, ... ]
 * }
 */
/**
 * GET /api/vaults
 *
 * Live summary of the on-chain Pelagos vault (assets, shares, share price,
 * fees) plus the best external yield venue. Previously unmounted (only
 * `/yields` existed), so any consumer hitting `/api/vaults` 404'd.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { readVaultState, vaultConfigured, VAULT } = await import('../services/vault');
    let vault: Record<string, unknown> | null = null;
    if (vaultConfigured()) {
      const s = await readVaultState();
      vault = {
        vault_id: VAULT.vaultObjectId,
        package_id: VAULT.packageId,
        coin_type: VAULT.usdcType,
        share_price: s.share_price,
        total_assets_usdc: Number(s.total_assets_raw) / 10 ** VAULT.usdcDecimals,
        total_shares: Number(s.total_shares) / 10 ** VAULT.usdcDecimals,
        accrued_fees_usdc: Number(s.accrued_fees_raw) / 10 ** VAULT.usdcDecimals,
        deposit_fee_bps: s.deposit_fee_bps,
        redeem_fee_bps: s.redeem_fee_bps,
      };
    }
    const snap = await getSnapshot();
    res.json({ vault, best_yield: snap.sources[0] ?? null, yield_sources: snap.source_count });
  } catch (err) {
    console.error('GET /api/vaults error:', err);
    res.status(500).json({ error: `Failed to fetch vault summary: ${(err as Error).message}` });
  }
});

router.get('/yields', async (_req: Request, res: Response) => {
  try {
    const snap = await getSnapshot();
    const best = snap.sources[0] ?? null;
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.json({
      fetched_at: snap.fetched_at,
      cache_age_ms: Date.now() - snap.fetched_at,
      source_count: snap.source_count,
      cache_stale: Date.now() - snap.fetched_at > CACHE_TTL_MS,
      best,
      sources: snap.sources,
    });
  } catch (err) {
    console.error('GET /api/vaults/yields error:', err);
    res.status(500).json({ error: 'Failed to fetch vault yields' });
  }
});

export default router;
