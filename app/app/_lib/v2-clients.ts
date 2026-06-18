"use client";

/**
 * Typed clients for the new dual-mode product engines (Basic/Advanced surfaces).
 * One module so every product page consumes a consistent, typed contract.
 * All endpoints are LIVE (real DeepBook Predict / Polymarket / DeFiLlama /
 * Coinbase data) — see each backend service for sourcing + honest fallbacks.
 */
import { BACKEND_URL } from "./tokens";

async function getJson<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store", ...opts });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}
async function postJson<T>(path: string, body: unknown): Promise<T> {
  return getJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ───────────────────────── Options chain (Distributed Options · Basic) ────────
export type OptionQuote = {
  // Per-contract premium in dUSDC (0..1); 1 contract pays $1 if in-the-money.
  // bid/ask/mid are REAL DeepBook Predict range prices (mint cost / redeem payout).
  mid: number; bid: number; ask: number; iv: number;
  delta: number; gamma: number; vega: number; theta: number; tradeable: boolean;
  lower_strike: string; higher_strike: string; // raw on-chain band for routing
};
export type OptionStrike = { strike: number; moneyness: number; call: OptionQuote; put: OptionQuote };
export type OptionExpiry = {
  oracle_id: string; expiry: number; tenor_label: string; days_to_expiry: number;
  forward: number; atm_iv: number; strikes: OptionStrike[];
};
export type OptionsChain = {
  underlying: string; spot: number; generated_at: string; source: string;
  contract_payout_usd: number; quote_basis: "per-contract"; expiries: OptionExpiry[];
};
export function fetchOptionsChain(underlying = "BTC"): Promise<OptionsChain> {
  return getJson<OptionsChain>(`/api/options/chain?underlying=${encodeURIComponent(underlying)}`);
}

// Liquidity-depth / risk cap for one strike band — the largest order the pool can
// safely back (≤15% market impact, ≤2% of available pool liquidity). The UI clamps
// the order size to `max_contracts` so nobody can hammer the book or pump a strike.
export type BandDepth = {
  oracle_id: string; lower: string; higher: string;
  marginal_price: number; max_contracts: number;
  binding: "slippage" | "mintable" | "pool" | "depth-floor" | "none";
  pool_capacity_contracts: number; slip_cap: number;
  ladder: { contracts: number; avg_price: number; slippage_pct: number; ok: boolean }[];
};
export function fetchBandDepth(p: { oracle_id: string; expiry: string | number; lower: string; higher: string }): Promise<BandDepth> {
  const q = `oracle_id=${encodeURIComponent(p.oracle_id)}&expiry=${encodeURIComponent(String(p.expiry))}&lower=${encodeURIComponent(p.lower)}&higher=${encodeURIComponent(p.higher)}`;
  return getJson<BandDepth>(`/api/options/depth?${q}`);
}

// ───────────────────────── Custom baskets (Baskets · Advanced) ────────────────
export type CustomTheme = { id: string; label: string; description: string; tier: 90 | 50; keywords: string[] };
export type CustomLeg = {
  market_id: string; conditionId: string; question: string; side: "YES" | "NO";
  probability: number; weight: number; volumeUsd: number; category: string;
  eventTitle?: string; tokenId: string; priceSource: "clob" | "bbo" | "gamma";
};
export type CustomBasket = {
  query: string | null; theme: string | null; nav: number; sigma: number; accepted: boolean;
  diversification: { avg_pair_corr: number; eff_leg_count: number; risk_ratio: number; accepted: boolean; reason: string | null };
  legs: CustomLeg[];
  tranches: { kind: string; attach: number; detach: number; pricePerToken: number; expectedYieldPct: number }[];
  mm: { entry_cost_per_token: number; protocol_bps: number; mm_spread_bps: number };
  sources: { universe: string; candidates_scanned: number; kept_after_filter: number; clob_priced_legs: number; price: string; correlation_model: string; at: number };
};
export function fetchCustomThemes(): Promise<{ count: number; themes: CustomTheme[] }> {
  return getJson(`/api/custom-baskets/themes`);
}
export function buildCustomBasket(body: { query?: string; theme?: string; target_legs?: number; tier?: 90 | 50; max_per_category?: number }): Promise<CustomBasket> {
  return postJson<CustomBasket>(`/api/custom-baskets/build`, body);
}

// ───────────────────────── DeepBook strategies (DeepBook · both modes) ────────
export type DeepBookStrategy = {
  id: string; name: string; thesis: string;
  tail_risk: "low" | "med" | "high"; convexity: "long" | "short" | "neutral";
  payoff_shape: "pin" | "plateau" | "wings" | "tail" | "ladder" | "capped";
};
export type DeepBookBucket = {
  lower: string; higher: string; weight: number; lower_usd: number; higher_usd: number;
  tradeable: boolean; unit_price: number; quantity: string; mint_cost_raw: string;
  redeem_value_raw: string; max_payout_raw: string; slippage_raw: string; spread_raw: string; avg_price: number;
};
export type DeepBookQuote = {
  strategy_id: string; name: string; thesis: string; tail_risk: string; convexity: string;
  payoff_shape: string; risk_note: string; oracle_id: string; expiry: string; tenor_label: string;
  notional_usd: number; forward_usd: number; sigma_usd: number; atm_iv: number; t_years: number;
  max_loss_usd: number;
  strip: { oracle_id: string; expiry: string; mu_usd: number; sigma_usd: number; n: number; budget_raw: string;
    buckets: DeepBookBucket[]; total_cost_raw: string; total_redeem_value_raw: string; total_max_payout_raw: string;
    realized_max_payout_raw: string; total_slippage_raw: string; round_trip_spread_raw: string; expected_value_raw: string };
  greeks: { delta_btc: number; gamma: number; vega_usd: number; theta_usd_day: number; position_value_usd: number };
  dusdc_decimals: number; source: string;
};
export function fetchDeepBookStrategies(): Promise<{ strategies: DeepBookStrategy[] }> {
  return getJson(`/api/deepbook/strategies`);
}
export function quoteDeepBookStrategy(body: { strategy_id: string; notional_usd: number; expiry_pref?: "near" | "mid" | "far"; sender?: string }): Promise<DeepBookQuote> {
  return postJson<DeepBookQuote>(`/api/deepbook/quote`, body);
}

// ───────────────────────── Protected Notes (DeepBook · PPN allocation) ────────
export type NotePreset = {
  id: string; name: string; tail_risk: "low" | "medium" | "high"; floor_pct: number; convexity_pct: number;
  strategy: string; default_tenor_days: number; blurb: string; live_apy: number; apy_source: string;
  sample: { principal_usd: number; tenor_days: number; upside_budget_usd: number; best_usd: number };
};
export type NoteQuote = {
  preset_id: string; preset_name: string; principal_usd: number; tenor_days: number;
  protected_floor_usd: number; blended_apy: number;
  yield_sleeve: { pool: string; apy: number; allocation_usd: number; source: string }[];
  upside_budget_usd: number;
  upside_strategy: { name: string; shape: string; expected_best_usd: number; expected_worst_usd: number };
  projected: { floor_usd: number; expected_usd: number; best_usd: number };
  sources: string[];
};
export function fetchNotePresets(): Promise<{ presets: NotePreset[]; apy_sources: string[] }> {
  return getJson(`/api/notes/strategies`);
}
export function quoteNote(body: { principal_usd: number; preset_id: string; tenor_days?: number }): Promise<NoteQuote> {
  return postJson<NoteQuote>(`/api/notes/quote`, body);
}

// ───────────────────────── Backtests (Portfolio) ─────────────────────────────
export type BacktestResult = {
  strategy_id: string; window_days: number; source: string; coverage_note: string;
  equity_curve: { t: number; equity: number }[];
  metrics: { total_return_pct: number; sharpe: number; max_drawdown_pct: number; win_rate: number; ann_vol_pct: number };
  series?: { t: number; close: number }[];
};
export function fetchBacktest(id: string, windowDays = 60): Promise<BacktestResult> {
  return getJson(`/api/backtest/strategy?id=${encodeURIComponent(id)}&window=${windowDays}`);
}
export function fetchBacktestStrategies(): Promise<{ strategies: { id: string; name: string; kind: string; product?: string; description: string }[] }> {
  return getJson(`/api/backtest/strategies`);
}
export function fetchPriceSeries(product = "BTC-USD", days = 60): Promise<{ product: string; days: number; source: string; coverage_note: string; series: { t: number; close: number }[] }> {
  return getJson(`/api/backtest/series?product=${encodeURIComponent(product)}&days=${days}`);
}
