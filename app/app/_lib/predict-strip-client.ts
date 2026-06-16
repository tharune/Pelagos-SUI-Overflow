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
