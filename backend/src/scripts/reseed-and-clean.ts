/**
 * One-shot maintenance script:
 *   1. Clear off-chain test pollution (positions / transactions / ppn_vaults /
 *      nav_snapshots / price_alerts) via the app's own Supabase layer.
 *   2. Reseed every bundle's legs with LIVE Polymarket markets, bucketed by
 *      real YES probability into the bundle's tier (HIGH≈0.7+, MID≈0.25–0.7,
 *      LOW<0.25). market_id = real condition_id so getMarketProbability /
 *      getLiveNAV return live values.
 *
 * Run: npx tsx --tsconfig ./tsconfig.dev.json src/scripts/reseed-and-clean.ts
 */
import 'dotenv/config';
import { fetchMarkets } from '../services/polymarket';
import { getAllBundles } from '../db/queries';
import { supabase } from '../db/supabase';

const LEGS_PER_BUNDLE = 10;
const ALL = '1900-01-01T00:00:00Z';

function yesPrice(outcomePrices: string | undefined): number {
  try {
    const arr = JSON.parse(outcomePrices ?? '[]') as string[];
    return arr.length ? Number(arr[0]) : NaN;
  } catch {
    return NaN;
  }
}

function tierOf(price: number): 90 | 70 | 50 {
  if (price >= 0.7) return 90;
  if (price >= 0.25) return 70;
  return 50;
}

async function main() {
  // ---- 1. Clear test pollution (keep bundles; legs are rewritten below) ----
  for (const table of ['positions', 'transactions', 'ppn_vaults', 'nav_snapshots', 'price_alerts']) {
    const { error } = await supabase.from(table).delete().gte('created_at', ALL);
    console.log(`[clean] ${table}: ${error ? 'ERR ' + error.message : 'cleared'}`);
  }

  // ---- 2. Pull live markets, build tier buckets ----
  const markets = await fetchMarkets({ limit: 500, active: true, closed: false });
  const seen = new Set<string>();
  const pool = markets
    .map((m) => ({ cond: m.condition_id, q: m.question, price: yesPrice(m.outcomePrices), vol: Number(m.volume) || 0 }))
    .filter((c) => c.cond && c.cond.startsWith('0x') && c.q && c.price > 0.02 && c.price < 0.98)
    .filter((c) => (seen.has(c.cond) ? false : (seen.add(c.cond), true)))
    .sort((a, b) => b.vol - a.vol);

  const buckets: Record<90 | 70 | 50, typeof pool> = { 90: [], 70: [], 50: [] };
  for (const c of pool) buckets[tierOf(c.price)].push(c);
  console.log(`[markets] pool=${pool.length} | HIGH=${buckets[90].length} MID=${buckets[70].length} LOW=${buckets[50].length}`);

  const cursor: Record<90 | 70 | 50, number> = { 90: 0, 70: 0, 50: 0 };

  // ---- 3. Reseed legs per bundle ----
  const bundles = await getAllBundles();
  for (const b of bundles) {
    const tier = (b.risk_tier as 90 | 70 | 50) ?? 70;
    const bucket = buckets[tier].length >= LEGS_PER_BUNDLE ? buckets[tier] : pool;
    const picks: typeof pool = [];
    for (let i = 0; i < LEGS_PER_BUNDLE && bucket.length > 0; i++) {
      picks.push(bucket[(cursor[tier] + i) % bucket.length]);
    }
    cursor[tier] += LEGS_PER_BUNDLE;

    await supabase.from('legs').delete().eq('bundle_id', b.id);
    const rows = picks.map((c) => ({
      bundle_id: b.id,
      market_id: c.cond,
      question: c.q,
      probability: c.price,
      weight: 1 / picks.length,
      status: 'active',
      polymarket_url: `https://polymarket.com/markets?condition=${c.cond}`,
    }));
    const { error } = await supabase.from('legs').insert(rows);
    const avg = picks.reduce((s, c) => s + c.price, 0) / Math.max(1, picks.length);
    console.log(`[reseed] ${b.name} (t${tier}): ${rows.length} legs, avg YES ${avg.toFixed(3)} ${error ? 'ERR ' + error.message : 'ok'}`);
  }

  console.log('[done] clean + reseed complete');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('reseed-and-clean failed:', e);
    process.exit(1);
  });
