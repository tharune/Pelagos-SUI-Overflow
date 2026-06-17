"use client";

/**
 * DeepBook Predict structured-product client (Pelagos).
 *
 * Talks to the NON-CUSTODIAL backend routes (/api/predict/*) that return UNBUILT
 * tx bytes; the connected wallet signs via wallet-bridge. Pricing is the real
 * on-chain MM (get_range_trade_amounts) — every cost/slippage/spread below is the
 * protocol's number, not a model. dUSDC scale = 1e6, strikes/prob = 1e9.
 */
import { BACKEND_URL } from "./tokens";

export interface StripBucket {
  lower: string;
  higher: string;
  lower_usd: number;
  higher_usd: number;
  weight: number;
  tradeable: boolean;
  unit_price: number; // marginal per-contract ask prob (0..1)
  quantity: string;
  mint_cost_raw: string; // ASK (incl. slippage)
  redeem_value_raw: string; // BID (redeem-now)
  max_payout_raw: string;
  slippage_raw: string;
  spread_raw: string;
  avg_price: number;
}

export interface StripQuote {
  oracle_id: string;
  expiry: string;
  mu_usd: number;
  sigma_usd: number;
  n: number;
  budget_raw: string;
  buckets: StripBucket[];
  total_cost_raw: string;
  total_redeem_value_raw: string;
  total_max_payout_raw: string;
  realized_max_payout_raw: string;
  total_slippage_raw: string;
  round_trip_spread_raw: string;
  expected_value_raw: string;
  forward_usd: number;
  dusdc_decimals: number;
}

export interface PreparedTx {
  tx_bytes: string;
  sender: string;
  dry_run: { ok: boolean; status: string; error?: string };
}

export interface PpnQuote {
  budget_raw: string;
  floor_raw: string;
  upside_raw: string;
  protection_pct: number;
  strip: StripQuote;
  protected_principal_raw: string;
  total_max_payout_raw: string;
  oracle_id: string;
  expiry: string;
  forward_usd: number;
}

export interface TrancheProfile {
  tranche: "senior" | "mezz" | "junior";
  sigma_mult: number;
  label: string;
  strip: StripQuote;
}

export interface BasketRecipe {
  id: string;
  name: string;
  description: string;
  sigma_pct: number;
  n: number;
}

/** Indexer-replay backtest — the simulation results for the vault strategy.
 *  house{} is the headline winning side (PLP counterparty earning the spread). */
export interface BacktestReport {
  generated_at: string;
  method: string;
  server: string;
  params: { sample_requested: number; n_buckets: number; sigma_source: string; sigma_frac_of_forward: number | null; span_sigma: number; price_limit_per_oracle: number };
  universe: { settled_btc_with_settlement_price: number };
  epochs: number;
  skipped_no_history: number;
  buyer: {
    hit_rate: number;
    mean_epoch_return: number;
    stdev_epoch_return: number;
    sharpe_per_epoch: number;
    final_rolled_return: number;
    max_drawdown: number;
    equity_curve: number[];
    cum_return_curve: number[]; // fixed-stake cumulative P&L, starts at 0
  };
  house: {
    mean_epoch_return: number;
    stdev_epoch_return: number;
    sharpe_per_epoch: number;
    final_rolled_return: number;
    max_drawdown: number;
    equity_curve: number[];
    cum_return_curve: number[]; // fixed-stake cumulative P&L, starts at 0
    cum_final_return: number;
    avg_spread_captured_usd: number;
  };
  spread: { avg_round_trip_usd: number; avg_frac_of_cost: number; avg_entry_cost_usd: number };
  // implied (SVI ATM near activation) vs realized vol; vol_risk_premium > 0 => house edge.
  vol: {
    avg_implied_iv: number;
    avg_realized_iv: number;
    vol_risk_premium: number;
    scatter: Array<{ implied_iv: number; realized_iv: number }>;
  };
  calibration: { bins: Array<{ p_mid: number; p_predicted_avg: number; freq_realized: number; n: number }>; brier: number };
  sample_epochs: Array<{ forward_usd: number; settlement_usd: number; cost_usd: number; payout_usd: number; hit: boolean }>;
}

/** Live SVI implied-vol surface (BTC-only on testnet) — exact backend shape. */
export interface VolSlice {
  oracle_id: string;
  expiry: number;
  tenor_label: string;
  t_years: number;
  forward_usd: number;
  atm_iv: number;
  points: Array<{ strike_usd: number; log_moneyness: number; iv: number }>;
}
export interface VolSurface {
  underlying: string;
  generated_at: string;
  forward_usd: number;
  slices: VolSlice[];
  term_structure: Array<{ tenor_label: string; t_years: number; atm_iv: number; expiry: number }>;
  strikes_pct: number;
}

/** Real SVI-implied risk-neutral DENSITY — skewed/fat-tailed, not a single-σ Normal. */
export interface ImpliedDensity {
  oracle_id: string;
  expiry: number;
  forward_usd: number;
  t_years: number;
  atm_iv: number;
  x: number[];
  pdf: number[];
  cdf: number[];
}

/** Markets-depth snapshot: vault block + one row per active oracle (all indexer-derived). */
export interface MarketRow {
  oracle_id: string;
  expiry: number;
  tenor_label: string;
  forward_usd: number;
  atm_iv: number;
  skew: number; // iv@-10% − iv@+10% off the SVI smile, in vol pts
  binary_up_atm: number; // N(d2) at K=forward
  min_strike_usd: number;
  tick_size_usd: number;
}
export interface MarketsDepth {
  vault: { tvl_usd: number; share_price: number; utilization: number; total_max_payout_usd: number };
  markets: MarketRow[];
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ---- quotes (read-only, no wallet) ----
export const stripPreview = (b: {
  asset?: string; oracle_id?: string; mu_usd?: number; sigma_usd?: number; n: number; budget_usd: number; span_sigma?: number; sender?: string;
}, signal?: AbortSignal) =>
  fetch(`${BACKEND_URL}/api/predict/strip/preview`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal,
  }).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return r.json() as Promise<StripQuote>; });

export const ppnQuote = (b: { asset?: string; oracle_id?: string; budget_usd: number; floor_pct?: number; sigma_usd?: number; n?: number; sender?: string }) =>
  post<PpnQuote>("/api/predict/ppn/quote", b);
export const trancheQuote = (b: { asset?: string; oracle_id?: string; budget_usd: number; sigma_usd?: number; n?: number; sender?: string }) =>
  post<{ tranches: TrancheProfile[]; oracle_id: string; expiry: string; forward_usd: number }>("/api/predict/tranche/quote", b);
export const listBaskets = () => get<BasketRecipe[]>("/api/predict/baskets");
export const fetchBacktest = () => get<BacktestReport>("/api/predict/backtest");
export const fetchVolSurface = (underlying = "BTC") =>
  get<VolSurface>(`/api/predict/vol-surface?underlying=${underlying}`);
export const fetchDensity = (oracleId?: string) =>
  get<ImpliedDensity>(`/api/predict/density${oracleId ? `?oracle_id=${oracleId}` : ""}`);
export const fetchMarkets = (underlying = "BTC") =>
  get<MarketsDepth>(`/api/predict/markets?underlying=${underlying}`);

/** Live forward tick (USD) — the soonest active oracle's latest forward/spot. */
export interface ForwardTick { oracle_id: string; expiry: number; forward: number; spot: number; }
export const fetchForward = (underlying = "BTC", signal?: AbortSignal) =>
  get<ForwardTick>(`/api/predict/forward?underlying=${underlying}`, signal);

export const basketQuote = (b: { basket_id: string; asset?: string; budget_usd: number; sender?: string }) =>
  post<{ basket: BasketRecipe; strip: StripQuote; oracle_id: string; expiry: string; forward_usd: number }>("/api/predict/basket/quote", b);

// ---- account ----
export const fetchManagers = (owner: string) => get<Array<{ manager_id: string }>>(`/api/predict/managers?owner=${owner}`);

// ---- prepares (return unbuilt tx for the wallet) ----
export const prepareManager = (owner: string) => post<PreparedTx>("/api/predict/manager/prepare", { owner });
export const prepareOpenStrip = (b: {
  owner: string; manager_id: string; oracle_id: string; expiry: string; buckets: Array<{ lower: string; higher: string; quantity: string }>; deposit_amount_raw?: string;
}) => post<PreparedTx & { bucket_count: number }>("/api/predict/strip/open/prepare", b);
export const prepareRedeemRange = (b: {
  owner: string; manager_id: string; oracle_id: string; expiry: string; lower: string; higher: string; quantity: string;
}) => post<PreparedTx>("/api/predict/range/redeem/prepare", b);
export const prepareRedeemStrip = (b: {
  owner: string; manager_id: string; oracle_id: string; expiry: string; buckets: Array<{ lower: string; higher: string; quantity: string }>;
}) => post<PreparedTx & { bucket_count: number }>("/api/predict/strip/redeem/prepare", b);
export const prepareLpSupply = (b: { owner: string; amount_ui: number }) => post<PreparedTx>("/api/predict/lp/supply/prepare", b);
export const prepareLpWithdraw = (b: { owner: string; plp_coin_id?: string; shares_raw?: string }) => post<PreparedTx>("/api/predict/lp/withdraw/prepare", b);
export const preparePpnOpen = (b: {
  owner: string; manager_id: string; oracle_id: string; expiry: string; buckets: Array<{ lower: string; higher: string; quantity: string }>; floor_amount_raw: string; upside_amount_raw: string;
}) => post<PreparedTx & { floor_raw: string; upside_raw: string; bucket_count: number }>("/api/predict/ppn/open/prepare", b);
export const confirmPredict = (digest: string) =>
  post<{ ok: boolean; status: string; digest: string; explorer_url: string; created_manager_id?: string | null }>("/api/predict/confirm", { digest });

// ---- the wallet-signed flow helper ----
export interface SignFn { (txJson: string): Promise<string> }

/** Ensure the wallet has a PredictManager; create+confirm one if not. Returns its id. */
export async function ensureManager(owner: string, sign: SignFn): Promise<string> {
  const existing = await fetchManagers(owner).catch(() => []);
  if (existing.length > 0) return existing[0].manager_id;
  const prep = await prepareManager(owner);
  const digest = await sign(prep.tx_bytes);
  const c = await confirmPredict(digest);
  if (c.created_manager_id) return c.created_manager_id;
  // fall back to a re-lookup (indexer lag)
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const m = await fetchManagers(owner).catch(() => []);
    if (m.length > 0) return m[0].manager_id;
  }
  throw new Error("manager created but not yet indexed — retry in a moment");
}

/** Re-quote the strip immediately before signing (post-trade pricing can drift). */
export function fmt(raw: string | number, decimals = 6): number {
  return Number(raw) / 10 ** decimals;
}
export function usd(raw: string | number, digits = 2): string {
  return `$${fmt(raw).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
