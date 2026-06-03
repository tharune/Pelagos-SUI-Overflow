"use client";

import { BACKEND_URL } from "./tokens";

export type DistributionDepthSource = "clob_orderbook" | "gamma_liquidity" | "none";

export type DistributionBand = {
  id: string;
  label: string;
  question: string;
  market_id: string;
  token_id: string | null;
  probability: number;
  normalized_probability: number;
  volume_usd: number;
  depth_usd: number;
  depth_source: DistributionDepthSource;
  clob_depth_usd: number;
  gamma_liquidity_usd: number;
  orderbook_bid_depth_usd: number;
  orderbook_ask_depth_usd: number;
  orderbook_fetched_at: string | null;
  spread: number | null;
  best_bid: number | null;
  best_ask: number | null;
  polymarket_url: string | null;
};

export type DistributionCandidate = {
  id: string;
  title: string;
  category: string;
  category_confidence: number;
  distribution_fit: "high" | "medium" | "low";
  outcome_type: "numeric_range" | "count" | "winner_set" | "price_level" | "other";
  event_slug: string | null;
  end_date_iso: string | null;
  days_to_resolution: number | null;
  aggregate_volume_usd: number;
  aggregate_depth_usd: number;
  avg_spread: number | null;
  band_count: number;
  launch_score: number;
  launch_quality: "excellent" | "strong" | "watchlist";
  reasons: string[];
  pricing_source: "polymarket_gamma_clob";
  clob_book_count: number;
  gamma_liquidity_count: number;
  bands: DistributionBand[];
  reference_curve: number[];
  liquidity_curve: number[];
  fetched_at: string;
};

export type DiscoveryFunnel = {
  input_events: number;
  input_markets: number;
  kept_candidates: number;
  rejected: Record<string, number>;
  filters: {
    min_volume_usd: number;
    min_depth_usd: number;
    min_days: number;
    max_days: number;
    min_bands: number;
  };
};

export type DistributionQuote = {
  candidate_id: string;
  candidate_title: string;
  collateral_usdc: number;
  weights: number[];
  target_curve: number[];
  reference_curve: number[];
  trade_curve: number[];
  reference_dollar_curve: number[];
  target_dollar_curve: number[];
  trade_dollar_curve: number[];
  pool_l2_norm: number;
  max_profit_usdc: number;
  max_loss_usdc: number;
  collateral_required_usdc: number;
  l2_distance: number;
  l2_norm: number;
  max_band_exposure_usdc: number;
  maker_fee_usdc: number;
  net_collateral_usdc: number;
  quote_model: "net_usdc_discrete_l2_distribution_amm";
  pricing_source: "polymarket_gamma_clob";
  liquidity_depth_usd: number;
  depth_coverage_ratio: number;
  bands_with_orderbook: number;
  bands_with_depth: number;
  expected_band: DistributionBand;
  pnl_curve: Array<{
    band_id: string;
    label: string;
    reference_probability: number;
    target_probability: number;
    position_usdc: number;
    liquidity_depth_usd: number;
  }>;
};

export type DistributionLaunchPlan = {
  candidate_id: string;
  title: string;
  status: "ready_to_launch" | "needs_more_liquidity";
  launch_score: number;
  required_depth_usd: number;
  current_depth_usd: number;
  bands: Array<{
    label: string;
    market_id: string;
    token_id: string | null;
    initial_weight: number;
    depth_usd: number;
  }>;
};

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<T>(res);
}

export async function fetchDistributionCandidates(args: {
  limit?: number;
  refresh?: boolean;
} = {}): Promise<{
  candidates: DistributionCandidate[];
  funnel: DiscoveryFunnel;
  fetched_at: string;
}> {
  const qs = new URLSearchParams();
  qs.set("limit", String(args.limit ?? 12));
  if (args.refresh) qs.set("refresh", "true");
  const res = await fetch(`${BACKEND_URL}/api/distribution/candidates?${qs.toString()}`, {
    cache: "no-store",
  });
  return readJson(res);
}

export async function quoteDistribution(args: {
  candidateId: string;
  weights: number[];
  collateralUsdc: number;
}): Promise<DistributionQuote> {
  const body = await postJson<{ quote: DistributionQuote }>("/api/distribution/quote", {
    candidate_id: args.candidateId,
    weights: args.weights,
    collateral_usdc: args.collateralUsdc,
  });
  return body.quote;
}

export async function buildLaunchPlan(candidateId: string): Promise<DistributionLaunchPlan> {
  const body = await postJson<{ plan: DistributionLaunchPlan }>("/api/distribution/launch-plan", {
    candidate_id: candidateId,
  });
  return body.plan;
}
