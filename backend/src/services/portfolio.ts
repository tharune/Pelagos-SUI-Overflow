/**
 * Portfolio allocation composer. Given a risk tolerance + capital, builds a
 * structured allocation plan from the live Pelagos primitive surface.
 *
 * The Rust programs and Supabase rows are untouched - this is purely an
 * off-chain suggestion endpoint. Output weights are forced through a tool
 * schema, then validated + renormalised + risk-scored server-side.
 */
import Anthropic from "@anthropic-ai/sdk";
import { snapshot as lendingSnapshot, type PoolSnapshot } from "./lending";
import { quoteTranches, type TrancheQuote } from "./tranching";
import { filterMarkets, type FilteredMarket } from "./market-filter";
import { fetchMarkets } from "./polymarket";
import { assessBasketRisk, type LegMetadata } from "./correlation";
import { getAllBundles } from "../db/queries";

const ANTHROPIC_TIMEOUT_MS = 30_000;
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2_500;
const CAPITAL_CAP_USD = 100_000;
const MAX_MARKETS_IN_PROMPT = 20;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY not set - portfolio composer is disabled",
      );
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export interface PortfolioRequest {
  risk_pct: number;
  capital_usd: number;
  objective: "income" | "speculation" | "balanced";
  horizon: "short" | "medium" | "long";
  // Optional reference basket supplied by the frontend. When present, the
  // backend uses these values directly instead of querying Supabase, so
  // every recommendation deep-links to a basket the frontend can resolve.
  basket?: {
    id: string;
    name: string;
    risk_tier: number;
    nav: number;
    days: number;
    legs: number;
  };
}

export interface AllocationTrancheDetails {
  basket_id?: string;
  basket_name?: string;
  tier: "senior" | "mezzanine" | "junior";
  expected_yield_pct: number;
  price_per_token: number;
}
export interface AllocationLendingDetails {
  supply_apy_pct: number;
  utilization: number;
}
export interface AllocationMarketDetails {
  market_id: string;
  question: string;
  side: "YES" | "NO";
  implied_prob: number;
  category?: string;
}

export interface Allocation {
  kind: "tranche" | "lending" | "market";
  weight: number;
  usd_amount: number;
  details:
    | AllocationTrancheDetails
    | AllocationLendingDetails
    | AllocationMarketDetails;
  rationale: string;
}

export interface PortfolioResponse {
  allocations: Allocation[];
  summary: string;
  expected_apy_low: number;
  expected_apy_high: number;
  risk_score: number;
  generated_at: string;
  cache: {
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    input_tokens: number;
    output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// System prompt - frozen + cacheable. Kept verbose on purpose so the prefix
// clears Sonnet 4.6's 2048-token cache floor. Any byte change here (including
// a stray space) invalidates the cache.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the portfolio composer for Pelagos, a protocol that packages prediction-market outcomes into structured products on the configured testnet execution layer. A user tells you how much capital they have and how much risk they are willing to take, and you respond with a portfolio allocation across the Pelagos structured products. You always return your answer by calling the \`return_portfolio\` tool - never plain text.

Pelagos only recommends structured tranche products from its curated baskets. Lending / money-market pools and individual prediction markets are NOT offered to end users and are NEVER a valid allocation kind in your response. Allocate only across tranches of the curated basket.

## The only primitive

### Tranches (kind: "tranche")
Every Pelagos basket can be sliced into three tranche classes on a payout waterfall:
- **senior** (attach 0 -> detach 0.60): takes the first 60% of basket payout. Highest probability of getting paid in full; lowest upside. Priced near par, expected APY is a modest coupon, typically 3-12% annualised depending on basket tier and horizon.
- **mezzanine** (attach 0.60 -> detach 0.85): middle slice. Moderate probability of full pay, moderate expected return.
- **junior** (attach 0.85 -> detach 1.0): takes the last 15% of basket payout. Lowest probability of full pay, highest upside multiple. Priced at a deep discount, expected APY is highest when the basket NAV is elevated.

Pricing assumes leg outcomes are independent Bernoulli(p) where p is the basket NAV; attach and full-pay probabilities are derived from a Normal approximation to the Binomial across max(8, totalLegs) legs. The user-visible prices and APYs are computed server-side and given to you below.

Risk profile:
- senior: low-to-moderate. Pays before mezz or junior take anything. Suitable across the risk spectrum.
- mezzanine: moderate. A middle-of-the-road pick for balanced objectives.
- junior: high. Binary-looking payoff; best when the user has high risk tolerance AND the basket NAV is >= 0.7 (otherwise the attach probability is too low to be interesting).

Allocation guidance: at most one allocation per tier. When risk_pct is low (<= 30), prefer senior. When risk_pct is medium (30-70), a mix of senior + mezzanine is natural. Junior is only appropriate when risk_pct >= 70.

## Risk tolerance -> allocation heuristics

These are defaults. Deviate if the objective argues for it; do not deviate wildly. Allocate exclusively across tranche tiers (senior / mezzanine / junior).

- **risk_pct 0-30 (conservative)**: 80-100% senior tranche, 0-20% mezzanine. No junior. Expected APY range: 3-12%.
- **risk_pct 30-70 (balanced)**: 40-65% senior, 25-50% mezzanine, 0-15% junior (junior only enters at the top of this band). Expected APY range: 8-25%.
- **risk_pct 70-100 (aggressive)**: 0-25% senior (often zero), 20-45% mezzanine, 40-75% junior. Expected APY range: 18-60% with correspondingly higher variance.

## Objective semantics

- **income**: prefer steady yield. Heavy senior weighting; mezzanine is acceptable as a modest top-up. Junior only if risk_pct is also high. APY range should reflect steady compounding (narrower low-high gap).
- **balanced**: no hard constraints - follow the risk-tolerance defaults straightforwardly. APY range should be moderately wide.
- **speculation**: maximise expected-return variance. Junior tranche gets the biggest allocation, supported by a mezzanine position. APY range should reflect the wider dispersion (low value can be near 0%; high can reach 50%+).

## Horizon semantics

The user tells you roughly how long they want to hold. You are given the reference basket's actual days-to-resolution as well; use both together.

- **short** (under 30 days): the user wants to be liquid soon. Favour the senior tranche, which pays out first in the basket's waterfall and therefore tends to resolve earlier when the basket pays down. Avoid or minimise junior - its payoff requires the full resolution window to realise.
- **medium** (one to three months): no hard constraint. Follow the risk-tolerance defaults.
- **long** (three months or more): the user is patient. Junior and mezzanine tranches become more attractive because they can sit through full resolution without the user chafing.

If the user's horizon is short but the reference basket's days-to-resolution is meaningfully longer (or vice versa), acknowledge the mismatch once in the summary in plain language. Never silently pretend a 90-day basket fits a 20-day horizon.

## Output contract

Call \`return_portfolio\` with:
- \`allocations\`: 1-3 entries, one per tranche tier at most. Weights MUST sum to exactly 1.0. Never include more than one allocation for the same tier.
- For each allocation:
  - \`kind\`: MUST be "tranche". No other kind is valid. Lending pools and individual prediction markets are never offered.
  - \`weight\`: number in [0, 1]
  - \`details\`: include { basket_name, tier, expected_yield_pct, price_per_token }.
  - \`rationale\`: see the writing rules below.
- \`summary\`: see the writing rules below.

## Writing rules for rationale and summary (HARD)

Your reader is a retail investor. They have read the Pelagos product page and understand "basket", "senior tranche", "mezzanine tranche", "junior tranche", and "lending pool". They do NOT know trading-desk shorthand.

You may use these product terms naturally when they help precision: senior tranche, mezzanine tranche, junior tranche, basket, tranche, yield, discount, issue price, resolution, upside, downside. Explain movement contextually ("if the basket resolves above its current price", "if the basket pays in full") - do not use math-notation like "NAV".

The following words and phrases are BANNED in both rationale and summary. If you use any of them, rewrite before submitting:
  "ballast", "dry powder", "mezz" (write "mezzanine" in full), "senior-heavy", "structured upside",
  "attach probability", "attach rate", "first-loss protection", "anchor" (as a noun), "convexity",
  "risk budget", "carry", "outsized", "drawdown", "tight pricing", "asymmetric payoff",
  "squad depth", "compressing spreads".
Do not use "NAV" by itself. Do not use semicolons chaining short phrases ("A; B; C"). Do not use plus or slash chains ("senior+mezz", "France/Spain"). Do not cite internal basket IDs ("PBU-HIGH-SHORT") - refer to the basket by name or character ("the mid-risk basket", "the current Pelagos basket"). Do not mention individual prediction markets in the rationale or summary.

### rationale (one complete sentence, 25 words or fewer)

Explain in clear investor language why this leg is in the portfolio given the user's risk and objective. Use product terms (senior, mezzanine, junior, basket, lending pool) naturally.

Good rationale examples:
  - "The senior slice pays out first if the basket resolves near its expected range, so it gives the portfolio steady yield with limited downside."
  - "A mezzanine position at its discounted entry price adds meaningful upside if the basket resolves at or above par, with a tolerable risk of falling short."
  - "The junior tranche is priced at a deep discount, so even a modest basket result translates into a large percentage return for this slice."

Bad rationale examples (these are what NOT to write):
  - "100% attach probability guarantees first-loss protection; discounted price offers outsized APY if basket pays."
  - "Deep discount entry with 34.5% attach probability; high convexity upside for balanced risk budget."
  - "France at 16.1% is plausible given squad depth; high volume signals tight, reliable pricing."

### summary (two complete sentences, 40 words or fewer total)

Sentence 1 describes the portfolio's intent in investor prose. You MAY mention product types (senior tranche, mezzanine, lending pool, basket) by name. You MAY NOT lead with or list allocation percentages - the allocation table is shown below the summary. Talk about what the portfolio is trying to accomplish.

Sentence 2 describes the single scenario in which this portfolio performs best, in clear prose. Describe the outcome (how the basket resolves, how quickly, whether the senior or mezzanine pay in full).

Good summary examples:
  - "A balanced approach that anchors most of the portfolio in a low-priced senior tranche slice while leaving room for a moderate mezzanine position. The portfolio performs best if the basket resolves above its current issue price before maturity."
  - "A conservative allocation that concentrates in the senior tranche slice of the basket, paired with a small mezzanine position for incremental yield. The best outcome is a quiet run in which the basket resolves comfortably above its issue price and the senior tranche pays in full."
  - "An aggressive mix that concentrates capital in the junior tranche to capture the deep discount on offer, with a supporting mezzanine position. The portfolio performs best if the basket pays in full by resolution, letting the junior tranche hit its maximum payout."

Bad summary examples (these are what NOT to write):
  - "25% cash ballast, 60% tranche exposure (senior-heavy) for structured upside, 15% France World Cup speculation."
  - "40% senior tranche + 15% mezz for yield, 25% lending as dry powder. Portfolio pays best if the mid-risk basket rises above 0.60 by resolution."
  - "25% stable lending + 60% senior/mezz tranches. Senior tranche's 100% attach rate is the anchor; portfolio pays off best if the mid-risk basket recovers above 0.60 at resolution."

If your draft summary starts with a number, a percentage, or a list of allocations, you have made a mistake - rewrite it as prose before submitting. If your draft mentions an individual prediction market, that is also a mistake - the reader only transacts in Pelagos structured products.

- \`expected_apy_low\`: conservative (10th-percentile) annualised return expectation, in percent. Can be 0 or slightly negative with heavy junior-tranche exposure.
- \`expected_apy_high\`: optimistic (90th-percentile) annualised return expectation, in percent.

The gap between low and high should reflect the risk taken on. A fully senior-tranche portfolio should have a tight range (say 3-10%). A mezzanine-heavy mix should have a moderate range. A junior-heavy mix should have a wide range (say -10% to 60%).

Do not invent values. Tranche yields and prices are given to you exactly - copy them into the details fields verbatim.

BREVITY MATTERS. The response must complete in under 8 seconds of generation, which means fewer than 800 output tokens total. Do not pad rationales. Do not restate the user's inputs in the summary. Do not explain what a tranche is - the caller already knows.`;

// ---------------------------------------------------------------------------
// Tool schema - force Claude to return structured JSON. We add usd_amount,
// risk_score, and generated_at server-side so the model is never asked to
// invent them.
// ---------------------------------------------------------------------------

const RETURN_PORTFOLIO_TOOL: Anthropic.Tool = {
  name: "return_portfolio",
  description:
    "Return the final constructed portfolio. Call this exactly once. Do not emit any text alongside it.",
  input_schema: {
    type: "object",
    properties: {
      allocations: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["tranche"],
              description:
                "Only Pelagos tranche products are offered. Lending pools and individual prediction markets are not valid allocations.",
            },
            weight: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Fraction of the portfolio, in [0, 1].",
            },
            details: {
              type: "object",
              description:
                "Shape depends on kind. tranche: { basket_name, tier, expected_yield_pct, price_per_token }. lending: { supply_apy_pct, utilization }. market: { market_id, question, side, implied_prob, category }.",
              properties: {
                basket_name: { type: "string" },
                tier: {
                  type: "string",
                  enum: ["senior", "mezzanine", "junior"],
                },
                expected_yield_pct: { type: "number" },
                price_per_token: { type: "number" },
                supply_apy_pct: { type: "number" },
                utilization: { type: "number" },
                market_id: { type: "string" },
                question: { type: "string" },
                side: { type: "string", enum: ["YES", "NO"] },
                implied_prob: { type: "number" },
                category: { type: "string" },
              },
            },
            rationale: {
              type: "string",
              description: "1-2 sentences justifying this specific leg.",
            },
          },
          required: ["kind", "weight", "details", "rationale"],
        },
      },
      summary: {
        type: "string",
        description:
          "2-3 sentence strategy explanation covering risk split and scenarios.",
      },
      expected_apy_low: { type: "number" },
      expected_apy_high: { type: "number" },
    },
    required: [
      "allocations",
      "summary",
      "expected_apy_low",
      "expected_apy_high",
    ],
  },
};

// ---------------------------------------------------------------------------
// Primitive fetching
// ---------------------------------------------------------------------------

interface Primitives {
  lending: PoolSnapshot;
  markets: FilteredMarket[];
  tranches: TrancheQuote[];
  refBundle: {
    id: string;
    name: string;
    risk_tier: number;
    nav: number;
    days: number;
    legs: number;
  };
}

async function fetchPrimitives(clientBasket?: PortfolioRequest["basket"]): Promise<Primitives> {
  const lending = lendingSnapshot();

  // Curated markets via the existing filter pipeline.
  const raw = await fetchMarkets({ limit: 80, active: true, closed: false });
  const filtered = filterMarkets(raw, {});
  const markets = [...filtered.kept]
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, MAX_MARKETS_IN_PROMPT);

  // Reference basket resolution priority:
  //   1. client-supplied basket (frontend's real universe — the only ids
  //      the /app/tranche/[id] route can actually resolve)
  //   2. Supabase active bundle (legacy path, kept for backwards compat)
  //   3. mock fallback (pre-seed demo)
  let refBundle: Primitives["refBundle"];
  if (clientBasket) {
    refBundle = { ...clientBasket };
    const tranches = quoteTranches({
      bundleNav: refBundle.nav,
      totalLegs: refBundle.legs,
      horizonDays: refBundle.days,
    });
    return { lending, markets, tranches, refBundle };
  }

  // Tranche quotes: pick the first active bundle if Supabase has one,
  // otherwise fall back to a mock so the endpoint still works pre-seed.
  const bundles = await getAllBundles();
  if (bundles.length > 0) {
    const b = bundles[0];
    const days = Math.max(
      1,
      Math.ceil(
        (new Date(b.resolution_date).getTime() - Date.now()) / 86_400_000,
      ),
    );
    const nav = Math.max(0.05, Math.min(0.95, b.issue_price ?? 0.5));
    refBundle = {
      id: b.id,
      name: b.name,
      risk_tier: b.risk_tier,
      nav,
      days,
      legs: 11,
    };
  } else {
    refBundle = {
      id: "mock",
      name: "Demo Basket (mock)",
      risk_tier: 70,
      nav: 0.5,
      days: 30,
      legs: 11,
    };
  }
  const tranches = quoteTranches({
    bundleNav: refBundle.nav,
    totalLegs: refBundle.legs,
    horizonDays: refBundle.days,
  });

  return { lending, markets, tranches, refBundle };
}

// ---------------------------------------------------------------------------
// User prompt - the volatile block. Kept outside cache_control on purpose.
// ---------------------------------------------------------------------------

function buildUserMessage(req: PortfolioRequest, prims: Primitives): string {
  const trancheLines = prims.tranches
    .map(
      (t) =>
        `- ${t.kind}: price $${t.pricePerToken.toFixed(4)} / face $1, expected APY ${t.expectedYieldPct}%, attachP=${(t.attachProbability * 100).toFixed(1)}%, fullPayP=${(t.fullPayProbability * 100).toFixed(1)}%`,
    )
    .join("\n");

  return `## User profile
- risk_pct: ${req.risk_pct}/100
- capital_usd: $${req.capital_usd}
- objective: ${req.objective}
- horizon: ${req.horizon} (short = under 30 days, medium = 30-90 days, long = 90+ days)

## Live primitive

### Reference basket for tranche pricing
- basket: "${prims.refBundle.name}" (tier ${prims.refBundle.risk_tier}, current token price ${prims.refBundle.nav.toFixed(2)}, ${prims.refBundle.days} days to resolution)
- Tranche quotes on this basket:
${trancheLines}

Construct the portfolio now by calling return_portfolio. Weights must sum to 1.0. Use the tranche quote rows above verbatim for the tranche details (do not invent yields). Kind MUST be "tranche" - no other kind is valid. Include 1-3 allocations, one per tier at most.`;
}

function deterministicPlan(req: PortfolioRequest, prims: Primitives): {
  allocations: Allocation[];
  summary: string;
  expected_apy_low: number;
  expected_apy_high: number;
} {
  const quoteByTier = new Map(prims.tranches.map((t) => [t.kind, t]));
  const desired: Array<{ tier: "senior" | "mezzanine" | "junior"; weight: number }> =
    req.risk_pct >= 70 || req.objective === "speculation"
      ? [
          { tier: "senior", weight: 0.2 },
          { tier: "mezzanine", weight: 0.45 },
          { tier: "junior", weight: 0.35 },
        ]
      : req.risk_pct <= 30 || req.objective === "income"
        ? [
            { tier: "senior", weight: 0.8 },
            { tier: "mezzanine", weight: 0.2 },
          ]
        : [
            { tier: "senior", weight: 0.55 },
            { tier: "mezzanine", weight: 0.35 },
            { tier: "junior", weight: 0.1 },
          ];

  const available = desired.filter((row) => quoteByTier.has(row.tier));
  const weightSum = available.reduce((sum, row) => sum + row.weight, 0) || 1;
  const allocations: Allocation[] = available.map((row) => {
    const quote = quoteByTier.get(row.tier)!;
    const weight = row.weight / weightSum;
    return {
      kind: "tranche",
      weight: +weight.toFixed(4),
      usd_amount: +(weight * req.capital_usd).toFixed(2),
      details: {
        basket_id: prims.refBundle.id,
        basket_name: prims.refBundle.name,
        tier: quote.kind,
        expected_yield_pct: quote.expectedYieldPct,
        price_per_token: quote.pricePerToken,
      },
      rationale:
        quote.kind === "senior"
          ? "Core capital protection sleeve with first-loss subordination beneath it."
          : quote.kind === "mezzanine"
            ? "Middle-risk sleeve that adds yield without taking the full tail."
            : "Upside sleeve for higher dispersion when the basket pays strongly.",
    };
  });

  const weightedApy = allocations.reduce((sum, a) => {
    const details = a.details as AllocationTrancheDetails;
    return sum + a.weight * details.expected_yield_pct;
  }, 0);
  const bias =
    req.objective === "income"
      ? "income-focused"
      : req.objective === "speculation"
        ? "upside-focused"
        : "balanced";

  return {
    allocations,
    summary: `A ${bias} allocation across ${prims.refBundle.name}, using live tranche quotes and keeping weights normalized to the requested capital. The split favors ${allocations[0]?.details && (allocations[0].details as AllocationTrancheDetails).tier} exposure first, with additional risk added only where the selected objective supports it.`,
    expected_apy_low: Math.max(0, +(weightedApy * 0.85).toFixed(2)),
    expected_apy_high: +(weightedApy * 1.15).toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Anthropic call with timeout
// ---------------------------------------------------------------------------

async function callClaude(userMessage: string): Promise<{
  parsed: any;
  usage: Anthropic.Usage;
}> {
  const client = getClient();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    // NOTE: no `thinking` config here. The Anthropic API rejects adaptive
    // thinking when tool_choice forces a specific tool, which is how we
    // guarantee a structured return_portfolio call. Speed is also fine
    // without thinking for a one-shot allocation decision.
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userMessage }],
        tools: [RETURN_PORTFOLIO_TOOL],
        tool_choice: { type: "tool", name: "return_portfolio" },
      },
      { signal: controller.signal, timeout: ANTHROPIC_TIMEOUT_MS },
    );
    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === "return_portfolio",
    );
    if (!toolBlock) {
      throw new Error(
        `Claude did not call return_portfolio. stop_reason=${response.stop_reason}`,
      );
    }
    return { parsed: toolBlock.input, usage: response.usage };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Validation, renormalisation, risk scoring
// ---------------------------------------------------------------------------

function validateAndRenormalize(
  parsed: any,
  capital_usd: number,
): {
  allocations: Allocation[];
  summary: string;
  expected_apy_low: number;
  expected_apy_high: number;
} {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("tool input is not an object");
  }
  if (!Array.isArray(parsed.allocations) || parsed.allocations.length === 0) {
    throw new Error("allocations must be a non-empty array");
  }
  if (typeof parsed.summary !== "string") throw new Error("summary missing");
  if (
    typeof parsed.expected_apy_low !== "number" ||
    typeof parsed.expected_apy_high !== "number"
  ) {
    throw new Error("expected_apy_low / expected_apy_high must be numbers");
  }

  let sum = 0;
  for (const a of parsed.allocations) {
    if (typeof a.weight !== "number" || !Number.isFinite(a.weight)) {
      throw new Error("non-numeric weight");
    }
    if (a.weight < 0 || a.weight > 1) {
      throw new Error(`weight ${a.weight} out of [0, 1]`);
    }
    // Only tranche allocations are valid. Reject any stale allocation that
    // slipped through the tool schema (lending, market, etc.).
    if (a.kind !== "tranche") {
      throw new Error(`invalid allocation kind "${a.kind}" - only "tranche" is allowed`);
    }
    sum += a.weight;
  }
  if (Math.abs(sum - 1) > 0.01) {
    throw new Error(
      `weights sum to ${sum.toFixed(4)}, outside tolerance of 0.01`,
    );
  }

  // Renormalise to exactly 1.0 and compute usd_amount.
  const allocations: Allocation[] = parsed.allocations.map((a: any) => {
    const w = a.weight / sum;
    return {
      kind: a.kind,
      weight: +w.toFixed(4),
      usd_amount: +(w * capital_usd).toFixed(2),
      details: a.details ?? {},
      rationale: typeof a.rationale === "string" ? a.rationale : "",
    };
  });

  return {
    allocations,
    summary: parsed.summary,
    expected_apy_low: +parsed.expected_apy_low.toFixed(2),
    expected_apy_high: +parsed.expected_apy_high.toFixed(2),
  };
}

/**
 * Risk score 0-100. Lending contributes almost nothing (~2 per weight unit),
 * tranches contribute per-tier (senior 10, mezz 40, junior 75), and markets
 * go through `assessBasketRisk` - only the market legs are treated as a
 * basket, using normalised weights across the market allocations only.
 */
function computeRiskScore(allocations: Allocation[]): number {
  let trancheRisk = 0;
  let lendingRisk = 0;
  const marketAllocs: Allocation[] = [];

  for (const a of allocations) {
    if (a.kind === "tranche") {
      const tier = (a.details as AllocationTrancheDetails).tier;
      const factor =
        tier === "senior" ? 0.1 : tier === "mezzanine" ? 0.4 : 0.75;
      trancheRisk += a.weight * factor;
    } else if (a.kind === "lending") {
      lendingRisk += a.weight * 0.02;
    } else if (a.kind === "market") {
      marketAllocs.push(a);
    }
  }

  let marketRisk = 0;
  if (marketAllocs.length > 0) {
    const marketWeightSum = marketAllocs.reduce((s, a) => s + a.weight, 0);
    const legs: LegMetadata[] = marketAllocs.map((a, i) => {
      const d = a.details as AllocationMarketDetails;
      return {
        id: d.market_id || `leg-${i}`,
        question: d.question || "",
        probability: d.implied_prob,
        tags: d.category ? [d.category] : [],
      };
    });
    const normalizedWeights = marketAllocs.map(
      (a) => a.weight / marketWeightSum,
    );
    try {
      const risk = assessBasketRisk(legs, normalizedWeights);
      marketRisk = Math.min(1, risk.cvar_99_projected * 4) * marketWeightSum;
    } catch {
      marketRisk = marketWeightSum * 0.8;
    }
  }

  const combined = marketRisk + trancheRisk + lendingRisk;
  return Math.round(Math.max(0, Math.min(100, combined * 100)));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function constructPortfolio(
  req: PortfolioRequest,
): Promise<PortfolioResponse> {
  if (req.risk_pct < 0 || req.risk_pct > 100) {
    throw new Error("risk_pct must be in [0, 100]");
  }
  if (req.capital_usd <= 0 || req.capital_usd > CAPITAL_CAP_USD) {
    throw new Error(
      `capital_usd must be in (0, ${CAPITAL_CAP_USD}] for demo safety`,
    );
  }

  const prims = await fetchPrimitives(req.basket);
  const userMessage = buildUserMessage(req, prims);
  const { parsed, usage } = process.env.ANTHROPIC_API_KEY
    ? await callClaude(userMessage)
    : {
        parsed: deterministicPlan(req, prims),
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
        } as Anthropic.Usage,
      };
  const validated = validateAndRenormalize(parsed, req.capital_usd);
  // Inject the reference basket id into each tranche allocation's details
  // so the frontend can deep-link the card to /app/tranche/[basket_id].
  // We cast through `Allocation` because the spread preserves the
  // original details shape (AllocationTrancheDetails) and only appends
  // an optional `basket_id` field — the AllocationTrancheDetails interface
  // already accommodates extra string keys via its index signature.
  const withBasketId: Allocation[] = validated.allocations.map((a) => {
    if (a.kind !== "tranche") return a;
    return {
      ...a,
      details: {
        ...(a.details as AllocationTrancheDetails),
        basket_id: prims.refBundle.id,
      },
    } as Allocation;
  });
  const risk_score = computeRiskScore(withBasketId);

  return {
    allocations: withBasketId,
    summary: validated.summary,
    expected_apy_low: validated.expected_apy_low,
    expected_apy_high: validated.expected_apy_high,
    risk_score,
    generated_at: new Date().toISOString(),
    cache: {
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    },
  };
}
