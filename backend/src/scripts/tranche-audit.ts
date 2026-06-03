/**
 * Two-sided tranche pricing audit.
 *
 * For every (tier, horizon) cell in the 3x3 grid, this script prints
 * the quotes from both perspectives:
 *
 *   MM side:
 *     - fair -> ask spread (bps)
 *     - MM spread component (bps of ask notional)
 *     - underwriting premium (bps of ask notional)
 *     - implied annualised return on capital if hedges run true
 *
 *   User side:
 *     - APY to face (headline)
 *     - expected APY (fair / ask - 1 annualised) - the HONEST number
 *     - probability of full pay, probability of any pay
 *     - order capacity cap
 *
 * The goal of this audit is to confirm the model is fair to both
 * counterparties: the MM always earns SOME spread, and the user
 * always sees SOME upside (yield floor binds on safe senior tranches).
 */
import { quoteTranches } from "../services/tranching";

type Cell = [string, number, number, number, 90 | 70 | 50];

const cases: Cell[] = [
  ["HIGH-SHORT", 0.95, 22, 5, 90],
  ["HIGH-MED", 0.95, 22, 60, 90],
  ["HIGH-LONG", 0.95, 22, 220, 90],
  ["MID-SHORT", 0.5, 22, 5, 70],
  ["MID-MED", 0.5, 22, 60, 70],
  ["MID-LONG", 0.5, 22, 220, 70],
  ["LOW-SHORT", 0.05, 22, 5, 50],
  ["LOW-MED", 0.05, 22, 60, 50],
  ["LOW-LONG", 0.05, 22, 220, 50],
];

function pctCap(x: number): string {
  if (!Number.isFinite(x)) return "-";
  if (x > 9999) return ">9999%";
  if (x < -999) return "<-999%";
  return `${x.toFixed(1)}%`;
}

console.log(
  [
    "basket".padEnd(11),
    "kind".padEnd(4),
    "fair".padStart(7),
    "ask".padStart(7),
    "spread".padStart(7),
    "mm_bp".padStart(6),
    "uw_bp".padStart(6),
    "ytm".padStart(9),
    "E[ret]".padStart(9),
    "P[any]".padStart(7),
    "P[full]".padStart(7),
    "cap$".padStart(10),
  ].join(" "),
);

for (const [name, nav, legs, days, tier] of cases) {
  const quotes = quoteTranches({
    bundleNav: nav,
    totalLegs: legs,
    horizonDays: days,
    tier,
  });
  for (const q of quotes) {
    const spreadBps = Math.round(((q.pricePerToken - q.fairPrice) / q.fairPrice) * 10_000);
    const horizonYears = days / 365;
    const periodReturn = q.fairPrice / q.pricePerToken - 1;
    const expectedApyPct = (periodReturn / horizonYears) * 100;
    console.log(
      [
        name.padEnd(11),
        q.kind.slice(0, 4).padEnd(4),
        q.fairPrice.toFixed(4).padStart(7),
        q.pricePerToken.toFixed(4).padStart(7),
        `${spreadBps}bp`.padStart(7),
        String(Math.round(q.mmSpreadBps)).padStart(6),
        String(Math.round(q.underwritingBps)).padStart(6),
        pctCap(q.expectedYieldPct).padStart(9),
        pctCap(expectedApyPct).padStart(9),
        `${(q.attachProbability * 100).toFixed(1)}%`.padStart(7),
        `${(q.fullPayProbability * 100).toFixed(1)}%`.padStart(7),
        `$${q.maxOrderUsdc.toLocaleString()}`.padStart(10),
      ].join(" "),
    );
  }
  console.log(
    "-".repeat(11) +
      " " +
      "(" +
      `\u03c3 \u2248 ${(
        100 *
        Math.sqrt((nav * (1 - nav)) / legs)
      ).toFixed(2)}%` +
      ")",
  );
}

// Quick invariants we expect to hold on every quote.
let fails = 0;
for (const [name, nav, legs, days, tier] of cases) {
  const quotes = quoteTranches({
    bundleNav: nav,
    totalLegs: legs,
    horizonDays: days,
    tier,
  });
  // 1. Tranches are ordered: senior.detach == mezz.attach, mezz.detach == junior.attach
  const [s, m, j] = quotes;
  if (Math.abs(s.detach - m.attach) > 1e-6) {
    console.log(`FAIL ${name}: senior.detach != mezz.attach`);
    fails++;
  }
  if (Math.abs(m.detach - j.attach) > 1e-6) {
    console.log(`FAIL ${name}: mezz.detach != junior.attach`);
    fails++;
  }
  // 2. Fair-anchored invariant: weighted ask should not exceed expected
  //    basket payout E[basket payoff] = μ, because each tranche ask is
  //    discounted from fair by target APY.
  const weightedAsk = quotes.reduce(
    (s, q) => s + q.pricePerToken * (q.detach - q.attach),
    0,
  );
  const fairAnchorTolerance = 0.005;
  if (weightedAsk > nav + fairAnchorTolerance) {
    console.log(
      `FAIL ${name}: weighted ask ${weightedAsk.toFixed(4)} > μ ${nav} + tol ${fairAnchorTolerance} — not fair-anchored`,
    );
    fails++;
  }
  // 3. Yield-to-maturity is non-negative.
  for (const q of quotes) {
    if (q.expectedYieldPct < -0.01) {
      console.log(
        `FAIL ${name} ${q.kind}: YTM negative = ${q.expectedYieldPct}%`,
      );
      fails++;
    }
  }
  // 4. AttachProb >= FullPayProb (any-pay is a superset of full-pay).
  for (const q of quotes) {
    if (q.attachProbability < q.fullPayProbability - 1e-6) {
      console.log(
        `FAIL ${name} ${q.kind}: attachP ${q.attachProbability} < fullP ${q.fullPayProbability}`,
      );
      fails++;
    }
  }
  // 5. Senior has highest fair, junior has lowest.
  if (!(s.fairPrice >= m.fairPrice - 1e-6 && m.fairPrice >= j.fairPrice - 1e-6)) {
    console.log(
      `FAIL ${name}: fair ordering senior(${s.fairPrice}) mezz(${m.fairPrice}) junior(${j.fairPrice})`,
    );
    fails++;
  }
  // 6. MM cap ordering: senior >= mezz >= junior for the same tier.
  if (!(s.maxOrderUsdc >= m.maxOrderUsdc && m.maxOrderUsdc >= j.maxOrderUsdc)) {
    console.log(`FAIL ${name}: order cap ordering broken`);
    fails++;
  }
  void tier;
  void days;
}
if (fails === 0) {
  console.log("\nINVARIANTS OK (all 9 baskets x 3 tranches)");
} else {
  console.log(`\nINVARIANTS FAILED: ${fails} violations`);
}
