import { createBundle, createLeg, getBundleByName } from '../db/queries';
import { getMarketProbability } from '../services/polymarket';
import { calculateIssuePrice } from '../services/nav';
import { supabase } from '../db/supabase';
import { Leg } from '../types';
import * as fs from 'fs';
import * as path from 'path';

// ── Fallback leg data (replaced once market-picks.json has real picks) ──

interface LegInput {
  conditionId: string;
  question: string;
  fallbackProb: number;
  polymarketUrl?: string;
}

const FALLBACK_LEGS_90: LegInput[] = [
  { conditionId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', question: 'Will the S&P 500 close above 5000 on April 30, 2026?', fallbackProb: 0.92, polymarketUrl: 'https://polymarket.com/event/sp500-5000-apr26' },
  { conditionId: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7', question: 'Will Bitcoin remain above $60,000 through April 2026?', fallbackProb: 0.88, polymarketUrl: 'https://polymarket.com/event/btc-60k-apr26' },
  { conditionId: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8', question: 'Will the Fed hold rates steady at May 2026 FOMC?', fallbackProb: 0.91, polymarketUrl: 'https://polymarket.com/event/fed-rates-may26' },
  { conditionId: 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9', question: 'Will Ethereum stay above $3,000 through April 2026?', fallbackProb: 0.85, polymarketUrl: 'https://polymarket.com/event/eth-3k-apr26' },
  { conditionId: 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', question: 'Will US GDP growth be positive in Q1 2026?', fallbackProb: 0.94, polymarketUrl: 'https://polymarket.com/event/us-gdp-q1-26' },
  { conditionId: 'f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1', question: 'Will unemployment remain below 5% in April 2026?', fallbackProb: 0.90, polymarketUrl: 'https://polymarket.com/event/unemployment-apr26' },
  { conditionId: 'a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2', question: 'Will Apple market cap stay above $3T through April 2026?', fallbackProb: 0.87, polymarketUrl: 'https://polymarket.com/event/aapl-3t-apr26' },
  { conditionId: 'b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3', question: 'Will no US bank with >$50B assets fail by April 30, 2026?', fallbackProb: 0.96, polymarketUrl: 'https://polymarket.com/event/bank-failure-apr26' },
  { conditionId: 'c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4', question: 'Will gold price remain above $2,000/oz through April 2026?', fallbackProb: 0.93, polymarketUrl: 'https://polymarket.com/event/gold-2k-apr26' },
  { conditionId: 'd0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5', question: 'Will US CPI stay below 4% YoY in April 2026?', fallbackProb: 0.89, polymarketUrl: 'https://polymarket.com/event/cpi-4pct-apr26' },
];

const FALLBACK_LEGS_70: LegInput[] = [
  { conditionId: 'e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', question: 'Will the Fed cut rates by May 15, 2026?', fallbackProb: 0.65, polymarketUrl: 'https://polymarket.com/event/fed-cut-may26' },
  { conditionId: 'f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7', question: 'Will Bitcoin reach $120,000 by May 15, 2026?', fallbackProb: 0.55, polymarketUrl: 'https://polymarket.com/event/btc-120k-may26' },
  { conditionId: 'a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8', question: 'Will a major AI regulation bill pass the US Senate by May 2026?', fallbackProb: 0.40, polymarketUrl: 'https://polymarket.com/event/ai-regulation-may26' },
  { conditionId: 'b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9', question: 'Will Tesla stock trade above $300 on May 15, 2026?', fallbackProb: 0.60, polymarketUrl: 'https://polymarket.com/event/tsla-300-may26' },
  { conditionId: 'c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0', question: 'Will Ethereum ETF see >$5B cumulative inflows by May 2026?', fallbackProb: 0.72, polymarketUrl: 'https://polymarket.com/event/eth-etf-inflows-may26' },
  { conditionId: 'd6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1', question: 'Will US-China tariffs be reduced before May 15, 2026?', fallbackProb: 0.35, polymarketUrl: 'https://polymarket.com/event/tariffs-may26' },
  { conditionId: 'e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2', question: 'Will Nvidia market cap exceed $4T by May 15, 2026?', fallbackProb: 0.68, polymarketUrl: 'https://polymarket.com/event/nvda-4t-may26' },
  { conditionId: 'f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3', question: 'Will oil price stay above $70/barrel through May 2026?', fallbackProb: 0.75, polymarketUrl: 'https://polymarket.com/event/oil-70-may26' },
  { conditionId: 'a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4', question: 'Will Sui DeFi TVL exceed $5B by May 15, 2026?', fallbackProb: 0.45, polymarketUrl: 'https://polymarket.com/event/sui-defi-tvl-may26' },
  { conditionId: 'b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5', question: 'Will the 10Y Treasury yield drop below 4% by May 15, 2026?', fallbackProb: 0.58, polymarketUrl: 'https://polymarket.com/event/10y-yield-may26' },
];

// Long-shot fallback legs for the 50 tier. Probabilities target the ~5% band
// so calculateIssuePrice lands near the "PBU-LOW-*" NAV range the UI expects.
const FALLBACK_LEGS_50: LegInput[] = [
  { conditionId: 'c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5', question: 'Will a major new crypto regulatory framework pass the US House by resolution?', fallbackProb: 0.08, polymarketUrl: 'https://polymarket.com/event/crypto-framework-2026' },
  { conditionId: 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6', question: 'Will Bitcoin hit a new all-time high above $150k by resolution?', fallbackProb: 0.12, polymarketUrl: 'https://polymarket.com/event/btc-150k-2026' },
  { conditionId: 'e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7', question: 'Will Tesla announce a stock split before resolution?', fallbackProb: 0.06, polymarketUrl: 'https://polymarket.com/event/tsla-split-2026' },
  { conditionId: 'f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8', question: 'Will SpaceX IPO before resolution?', fallbackProb: 0.04, polymarketUrl: 'https://polymarket.com/event/spacex-ipo-2026' },
  { conditionId: 'a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9', question: 'Will any mammal be cloned and featured publicly by resolution?', fallbackProb: 0.03, polymarketUrl: 'https://polymarket.com/event/mammal-clone-2026' },
  { conditionId: 'b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0', question: 'Will an ETH L2 surpass Ethereum mainnet TVL before resolution?', fallbackProb: 0.09, polymarketUrl: 'https://polymarket.com/event/l2-flip-eth-2026' },
  { conditionId: 'c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1', question: 'Will gold settle above $3,500/oz by resolution?', fallbackProb: 0.07, polymarketUrl: 'https://polymarket.com/event/gold-3500-2026' },
  { conditionId: 'd7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2', question: 'Will a US-listed company announce a $1T acquisition by resolution?', fallbackProb: 0.05, polymarketUrl: 'https://polymarket.com/event/1t-acquisition-2026' },
  { conditionId: 'e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3', question: 'Will the Fed cut rates by 100bps in a single FOMC decision?', fallbackProb: 0.06, polymarketUrl: 'https://polymarket.com/event/fed-100bps-2026' },
  { conditionId: 'f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4', question: 'Will a major publicly-traded airline declare bankruptcy by resolution?', fallbackProb: 0.04, polymarketUrl: 'https://polymarket.com/event/airline-bk-2026' },
];

// ── Bundle definitions ──

interface BundleDef {
  name: string;
  risk_tier: 90 | 70 | 50;
  resolution_date: string;
  description: string;
  theme: string;
  fallbackLegs: LegInput[];
}

// Resolution-date offsets for each window. Frontend `live-baskets` derives
// the window from the leg `daysToResolution` (week <30d, month 30-90d, long
// 180d+ in stretched mode), so a SHORT bundle resolving in ~5 days, MED in
// ~60 days, and LONG in ~220 days lands cleanly in each window. The exact
// dates only matter for the portfolio "MATURES …" line and for the catalog
// row; they do not affect the live grid (which is computed from Polymarket
// candidates, not these seeds).
function resolutionDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

const BUNDLES: BundleDef[] = [
  // ── HIGH tier ── (~95% probability target)
  {
    name: 'PBU-HIGH-SHORT',
    risk_tier: 90,
    resolution_date: resolutionDate(5),
    description: 'High-conviction basket on a one-week horizon. ~95% probability target across 10+ near-certain events.',
    theme: 'High conviction · short horizon',
    fallbackLegs: FALLBACK_LEGS_90,
  },
  {
    name: 'PBU-HIGH-MED',
    risk_tier: 90,
    resolution_date: resolutionDate(60),
    description: 'High-conviction basket on a one-to-three-month horizon. ~95% probability target across 10+ near-certain events.',
    theme: 'High conviction · medium horizon',
    fallbackLegs: FALLBACK_LEGS_90,
  },
  {
    name: 'PBU-HIGH-LONG',
    risk_tier: 90,
    resolution_date: resolutionDate(220),
    description: 'High-conviction basket on a 6-month+ horizon. ~95% probability target across 10+ near-certain events.',
    theme: 'High conviction · long horizon',
    fallbackLegs: FALLBACK_LEGS_90,
  },

  // ── MID tier ── (~50% probability target)
  {
    name: 'PBU-MID-SHORT',
    risk_tier: 70,
    resolution_date: resolutionDate(6),
    description: 'Mid-conviction basket on a one-week horizon. ~50% probability target across 10+ mixed events.',
    theme: 'Mid conviction · short horizon',
    fallbackLegs: FALLBACK_LEGS_70,
  },
  {
    name: 'PBU-MID-MED',
    risk_tier: 70,
    resolution_date: resolutionDate(55),
    description: 'Mid-conviction basket on a one-to-three-month horizon. ~50% probability target across 10+ mixed events.',
    theme: 'Mid conviction · medium horizon',
    fallbackLegs: FALLBACK_LEGS_70,
  },
  {
    name: 'PBU-MID-LONG',
    risk_tier: 70,
    resolution_date: resolutionDate(205),
    description: 'Mid-conviction basket on a 6-month+ horizon. ~50% probability target across 10+ mixed events.',
    theme: 'Mid conviction · long horizon',
    fallbackLegs: FALLBACK_LEGS_70,
  },

  // ── LOW tier ── (~5% probability target — long-shot)
  {
    name: 'PBU-LOW-SHORT',
    risk_tier: 50,
    resolution_date: resolutionDate(5),
    description: 'Long-shot basket on a one-week horizon. ~5% probability target across 10+ low-probability events.',
    theme: 'Long shot · short horizon',
    fallbackLegs: FALLBACK_LEGS_50,
  },
  {
    name: 'PBU-LOW-MED',
    risk_tier: 50,
    resolution_date: resolutionDate(60),
    description: 'Long-shot basket on a one-to-three-month horizon. ~5% probability target across 10+ low-probability events.',
    theme: 'Long shot · medium horizon',
    fallbackLegs: FALLBACK_LEGS_50,
  },
  {
    name: 'PBU-LOW-LONG',
    risk_tier: 50,
    resolution_date: resolutionDate(220),
    description: 'Long-shot basket on a 6-month+ horizon. ~5% probability target across 10+ low-probability events.',
    theme: 'Long shot · long horizon',
    fallbackLegs: FALLBACK_LEGS_50,
  },
];

// ── Helpers ──

interface MarketPicksFile {
  [bundleName: string]: {
    description: string;
    theme: string;
    legs: Array<{
      market_id?: string;
      conditionId?: string;
      question: string;
      probability?: number;
      polymarket_url?: string;
      polymarketUrl?: string;
    }>;
  };
}

function loadMarketPicks(): MarketPicksFile | null {
  const picksPath = path.join(__dirname, 'market-picks.json');
  try {
    if (!fs.existsSync(picksPath)) return null;
    const raw = fs.readFileSync(picksPath, 'utf-8');
    const data = JSON.parse(raw) as MarketPicksFile;
    // Only use if legs are actually populated
    for (const key of Object.keys(data)) {
      if (data[key].legs && data[key].legs.length > 0) return data;
    }
    return null;
  } catch {
    return null;
  }
}

function log(msg: string) {
  console.log(`[seed] ${msg}`);
}

function logError(msg: string) {
  console.error(`[seed] ERROR: ${msg}`);
}

// ── Main seed logic ──

async function seedBundle(def: BundleDef, picksOverride?: MarketPicksFile) {
  // Idempotency check
  const existing = await getBundleByName(def.name);
  if (existing) {
    log(`Bundle ${def.name} already exists (id: ${existing.id}), skipping.`);
    return;
  }

  // Determine legs source
  let legsInput: LegInput[];
  if (picksOverride && picksOverride[def.name] && picksOverride[def.name].legs.length > 0) {
    log(`Using market-picks.json data for ${def.name}`);
    legsInput = picksOverride[def.name].legs.map((l) => ({
      conditionId: l.market_id ?? l.conditionId ?? '',
      question: l.question,
      fallbackProb: l.probability ?? 0.5,
      polymarketUrl: l.polymarket_url ?? l.polymarketUrl,
    }));
  } else {
    log(`Using fallback leg data for ${def.name}`);
    legsInput = def.fallbackLegs;
  }

  // Fetch live probabilities
  log(`Fetching live probabilities for ${legsInput.length} legs...`);
  const probabilities: number[] = [];
  for (const leg of legsInput) {
    try {
      const liveProb = await getMarketProbability(leg.conditionId);
      if (liveProb !== null) {
        probabilities.push(liveProb);
        log(`  ${leg.question.slice(0, 60)}... -> ${(liveProb * 100).toFixed(1)}%`);
      } else {
        probabilities.push(leg.fallbackProb);
        log(`  ${leg.question.slice(0, 60)}... -> ${(leg.fallbackProb * 100).toFixed(1)}% (fallback)`);
      }
    } catch (err) {
      probabilities.push(leg.fallbackProb);
      log(`  ${leg.question.slice(0, 60)}... -> ${(leg.fallbackProb * 100).toFixed(1)}% (fallback, error)`);
    }
  }

  // Build temp legs for price calculation
  const weight = 1 / legsInput.length;
  const tempLegs: Leg[] = legsInput.map((leg, i) => ({
    id: '',
    bundle_id: '',
    market_id: leg.conditionId,
    question: leg.question,
    probability: probabilities[i],
    weight,
    status: 'active' as const,
    polymarket_url: leg.polymarketUrl,
    created_at: '',
  }));

  const issuePrice = calculateIssuePrice(tempLegs);
  log(`Calculated issue price for ${def.name}: $${issuePrice.toFixed(2)}`);

  // Create bundle
  const bundle = await createBundle({
    name: def.name,
    risk_tier: def.risk_tier,
    resolution_date: def.resolution_date,
    issue_price: issuePrice,
    description: def.description,
    theme: def.theme,
  });

  if (!bundle) {
    logError(`Failed to create bundle ${def.name}`);
    return;
  }
  log(`Created bundle ${def.name} (id: ${bundle.id})`);

  // Create legs
  let createdCount = 0;
  for (let i = 0; i < legsInput.length; i++) {
    const leg = legsInput[i];
    const created = await createLeg({
      bundle_id: bundle.id,
      market_id: leg.conditionId,
      question: leg.question,
      probability: probabilities[i],
      weight,
      polymarket_url: leg.polymarketUrl,
    });
    if (created) {
      createdCount++;
    } else {
      logError(`Failed to create leg: ${leg.question.slice(0, 50)}`);
    }
  }
  log(`Created ${createdCount}/${legsInput.length} legs for ${def.name}`);
}

async function main() {
  log('Starting seed...');

  const picks = loadMarketPicks();
  if (picks) {
    log('Loaded market-picks.json');
  } else {
    log('No valid market-picks.json found, using fallback data');
  }

  for (const def of BUNDLES) {
    await seedBundle(def, picks ?? undefined);
  }

  log('Seed complete.');
}

main().catch((err) => {
  logError(`Seed failed: ${err}`);
  process.exit(1);
});
