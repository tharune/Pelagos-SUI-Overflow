/**
 * Seeded basket universe for the sandbox.
 *
 * This is the fallback surface shown when the live Polymarket feed cannot
 * be reached. It mirrors the live 3×3 grid produced by `buildLiveBaskets`:
 * three risk tiers (high / mid / low) × three resolution windows (short /
 * medium / long). The nine ids here are identical to what the live pipeline
 * would emit, so url deep links, portfolio positions and tranche pages
 * continue to resolve when the app is running in offline / fallback mode.
 *
 * NAVs land inside each tier's live band (see `TIER_RANGE` in
 * `./live-baskets.ts`):
 *   • HIGH tier: 0.85–0.99
 *   • MID  tier: 0.25–0.75
 *   • LOW  tier: 0.01–0.12 (long-shot, not 50% — the "50" label is a
 *                          historical tier tag, not an issue price)
 */

export type Bundle = {
  id: string;
  tier: 90 | 70 | 50;
  date: string; // human-readable resolution date
  daysLeft: number;
  nav: number;
  issue: number;
  change: number;
  hot: boolean;
  resolved: number;
  totalLegs: number;
  /** 365 daily NAV points (last point is the live NAV). Drives 7D / 30D / 6M / 1Y chart ranges. */
  history: number[];
  /** 60 one-minute NAV points for the last hour. Drives the 1H chart range. */
  hourHistory: number[];
  /** 288 five-minute NAV points for the last 24h. Drives the 1D chart range. */
  dayHistory: number[];
};

/**
 * FNV-1a + xorshift seeded RNG. Matches the one used in live-baskets.ts
 * so the seed fallback histories are deterministic across renders — no
 * more jitter between reloads when the live feed is unreachable.
 */
function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

function genHistory(finalNav: number, days: number, seedId: string): number[] {
  // Walk around the final NAV with mild mean-reversion so the series always
  // lands on `finalNav`. Deterministic per basket id via `seededRng`.
  const rng = seededRng(seedId);
  const base = finalNav;
  const pts: number[] = [];
  let v = base;
  const band = Math.max(0.02, Math.min(0.08, base * 0.12));
  for (let i = 0; i < days; i++) {
    const drift = (finalNav - base) * (i / days) * 0.6;
    const noise = (rng() - 0.48) * band * 0.3;
    const spike = rng() < 0.08 ? (rng() - 0.5) * band * 0.5 : 0;
    v = base + drift + noise + spike;
    v = Math.max(Math.max(0.005, base - band), Math.min(base + band, v));
    pts.push(parseFloat(v.toFixed(4)));
  }
  pts.push(parseFloat(finalNav.toFixed(4)));
  return pts;
}

/**
 * Intraday / intra-hour NAV synthesis. Produces `steps + 1` points where
 * the LAST point is the live NAV (so the chart's current-value marker
 * always lines up with the number above it). We walk *backwards* from the
 * live NAV with a small symmetric noise and then reverse the series —
 * this keeps the end-anchor exact while giving the curve a realistic
 * "small random walk into present" shape instead of the mean-reversion
 * convergence tail that `genHistory` produces.
 *
 * `stepVol` is the per-step noise band as a fraction of the current NAV
 * (e.g. 0.0008 ≈ 0.08% per tick). Calibrated so:
 *   - 1h (60 1-min ticks)  => ~0.3% peak-to-peak drift
 *   - 24h (288 5-min ticks) => ~1.2% peak-to-peak drift
 */
function genIntradayHistory(
  finalNav: number,
  steps: number,
  stepVol: number,
  seedId: string,
): number[] {
  const rng = seededRng(seedId);
  const band = Math.max(0.0003, finalNav * stepVol);
  const rev: number[] = [parseFloat(finalNav.toFixed(6))];
  let v = finalNav;
  for (let i = 0; i < steps; i++) {
    const noise = (rng() - 0.5) * band;
    v = Math.max(0.0005, Math.min(0.9995, v + noise));
    rev.push(parseFloat(v.toFixed(6)));
  }
  rev.reverse();
  return rev;
}

// Bundle histories come as a trio (hour / day / year). Helper keeps seed
// data from growing into 3× the row length of the BUNDLES array.
function genBundleHistories(nav: number, id: string): {
  history: number[];
  hourHistory: number[];
  dayHistory: number[];
} {
  return {
    history: genHistory(nav, 364, `${id}:year`),
    hourHistory: genIntradayHistory(nav, 59, 0.0008, `${id}:hour`),
    dayHistory: genIntradayHistory(nav, 287, 0.0018, `${id}:day`),
  };
}

function genFlatHistory(days: number, seedId: string): number[] {
  const rng = seededRng(seedId);
  const pts: number[] = [];
  for (let i = 0; i <= days; i++) {
    pts.push(parseFloat((1 + (rng() - 0.5) * 0.0004).toFixed(4)));
  }
  return pts;
}

function dateLabel(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 86400_000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const USDC_HISTORY = genFlatHistory(29, "usdc-flat");

// Nine fallbacks — one per (tier, window) combo, matching the live grid
// ids emitted by `buildLiveBaskets` in ./live-baskets.ts. Histories cover
// the last hour (1-min), last 24 hours (5-min) and last year (daily) so
// every chart range in the detail page works identically in offline
// mode; card sparklines slice the tail of `history`.
//
// `resolved` and `hot` are legacy fields kept only for shape-compat with
// the `Bundle` type; the UI no longer reads them because live baskets
// are built from markets filtered to `active` (so nothing is resolved)
// and the "hot" badge was dropped.
// Values below are the live Polymarket snapshot from Apr 22 2026 used as
// static fallbacks when the /api/markets feed is unavailable. Live baskets
// always override these — the page only renders these for the loading/error
// state so the layout stays stable and values are in the right ballpark.
export const BUNDLES: Bundle[] = [
  // HIGH tier (≈ 95% probability target)
  { id: "PBU-HIGH-SHORT", tier: 90, date: dateLabel(10),  daysLeft: 10,  nav: 0.960, issue: 0.95, change: +4.5, hot: false, resolved: 0, totalLegs: 192, ...genBundleHistories(0.960, "PBU-HIGH-SHORT") },
  { id: "PBU-HIGH-MED",   tier: 90, date: dateLabel(63),  daysLeft: 63,  nav: 0.951, issue: 0.95, change: +0.3, hot: false, resolved: 0, totalLegs: 351, ...genBundleHistories(0.951, "PBU-HIGH-MED") },
  { id: "PBU-HIGH-LONG",  tier: 90, date: dateLabel(310), daysLeft: 310, nav: 0.940, issue: 0.95, change: +0.6, hot: false, resolved: 0, totalLegs: 418, ...genBundleHistories(0.940, "PBU-HIGH-LONG") },

  // MID tier (≈ 50% probability target)
  { id: "PBU-MID-SHORT",  tier: 70, date: dateLabel(14),  daysLeft: 14,  nav: 0.487, issue: 0.50, change: +8.1, hot: false, resolved: 0, totalLegs: 83,  ...genBundleHistories(0.487, "PBU-MID-SHORT") },
  { id: "PBU-MID-MED",    tier: 70, date: dateLabel(62),  daysLeft: 62,  nav: 0.519, issue: 0.50, change:  0.0, hot: false, resolved: 0, totalLegs: 181, ...genBundleHistories(0.519, "PBU-MID-MED") },
  { id: "PBU-MID-LONG",   tier: 70, date: dateLabel(312), daysLeft: 312, nav: 0.512, issue: 0.50, change: +0.4, hot: false, resolved: 0, totalLegs: 274, ...genBundleHistories(0.512, "PBU-MID-LONG") },

  // LOW tier (≈ 5% probability target — long-shot)
  { id: "PBU-LOW-SHORT",  tier: 50, date: dateLabel(11),  daysLeft: 11,  nav: 0.054, issue: 0.05, change: -0.1, hot: false, resolved: 0, totalLegs: 42,  ...genBundleHistories(0.054, "PBU-LOW-SHORT") },
  { id: "PBU-LOW-MED",    tier: 50, date: dateLabel(63),  daysLeft: 63,  nav: 0.045, issue: 0.05, change: +1.4, hot: false, resolved: 0, totalLegs: 108, ...genBundleHistories(0.045, "PBU-LOW-MED") },
  { id: "PBU-LOW-LONG",   tier: 50, date: dateLabel(327), daysLeft: 327, nav: 0.051, issue: 0.05, change: -0.5, hot: false, resolved: 0, totalLegs: 132, ...genBundleHistories(0.051, "PBU-LOW-LONG") },
];

export function bundleById(id: string): Bundle | undefined {
  return BUNDLES.find((b) => b.id === id);
}
