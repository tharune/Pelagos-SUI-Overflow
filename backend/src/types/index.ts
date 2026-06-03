// === Database types (mirrors Supabase schema) ===

export interface Bundle {
  id: string;
  name: string; // e.g. "PBU-HIGH-SHORT"
  risk_tier: 90 | 70 | 50;
  resolution_date: string; // ISO date
  issue_price: number; // e.g. 0.90
  status: 'active' | 'resolved' | 'cancelled';
  created_at: string;
  description?: string;
  theme?: string; // e.g. "Mixed Q2 2026"
}

export interface Leg {
  id: string;
  bundle_id: string;
  market_id: string; // Polymarket condition_id or token_id
  question: string; // e.g. "Will BTC hit $100k by April 30?"
  probability: number; // current probability 0-1
  weight: number; // weight in bundle (equal weight = 1/num_legs)
  status: 'active' | 'won' | 'lost';
  resolution_value?: number; // 1.0 if won, 0.0 if lost
  polymarket_url?: string;
  created_at: string;
}

export interface Position {
  id: string;
  bundle_id: string;
  wallet_address: string;
  tokens_held: number;
  entry_price: number; // price at time of purchase
  deposited_usdc: number;
  created_at: string;
}

export interface Transaction {
  id: string;
  bundle_id: string;
  wallet_address: string;
  type: 'deposit' | 'redemption' | 'divest' | 'transfer';
  amount_usdc: number;
  tokens: number;
  fee_usdc: number; // 0.5% structuring fee
  tx_signature?: string; // Sui transaction digest or adapter signature
  created_at: string;
}

// === API response types ===

export interface BundleWithLegs extends Bundle {
  legs: Leg[];
  nav: number; // current NAV
  num_legs: number;
  resolved_legs: number;
}

export interface NAVResult {
  bundle_id: string;
  nav: number;
  legs: LegNAVContribution[];
  timestamp: string;
}

export interface NAVSnapshot {
  id: string;
  bundle_id: string;
  nav: number;
  legs_data: LegNAVContribution[];
  created_at: string;
}

export interface LegNAVContribution {
  leg_id: string;
  question: string;
  status: 'active' | 'won' | 'lost';
  probability: number;
  weight: number;
  contribution: number; // weight * (probability or resolution_value)
}

export interface DepositRequest {
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
}

export interface DepositResponse {
  transaction_id: string;
  bundle_id: string;
  tokens_minted: number;
  issue_price: number;
  fee_usdc: number;
  net_usdc: number;
}

// === Polymarket types ===

export interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  end_date_iso: string;
  markets: PolymarketMarket[];
}

export interface PolymarketMarket {
  id: string;
  question: string;
  condition_id: string;
  tokens: PolymarketToken[];
  outcomePrices: string; // JSON string of prices ["0.9", "0.1"]
  volume: string;
  active: boolean;
  closed: boolean;
  end_date_iso?: string;
  // URL slugs — used by the frontend to build working polymarket.com links.
  slug?: string;
  event_id?: string;
  event_slug?: string;
  event_title?: string;
  // Price / change telemetry mirrored from Gamma. Optional because not every
  // Gamma row populates every field (new markets won't have 1wk/1mo yet).
  last_trade_price?: number;
  one_day_price_change?: number;  // absolute delta in YES price over ~24h
  one_week_price_change?: number; // absolute delta in YES price over ~7d
  one_month_price_change?: number;
  clob_token_ids?: string[];
  liquidity_usd?: number;
  spread?: number;
  best_bid?: number;
  best_ask?: number;
}

export interface PolymarketToken {
  token_id: string;
  outcome: string;
  price: number;
}

// === Config ===

export interface AppConfig {
  port: number;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseConfigured: boolean; // false when URL/key are placeholders; DB calls short-circuit
  polymarketApiUrl: string;
  structuringFee: number; // 0.005 = 0.5%
}

// === PPN (Principal Protected Notes) types ===

export interface PPNVault {
  id: string;
  bundle_id: string;
  wallet_address: string;
  principal_usdc: number;        // Original protected-note deposit
  yield_deployed_usdc: number;   // Accumulated yield deployed into bundles
  estimated_apy: number;         // Current estimated APY from the Sui yield sleeve
  vault_address: string;         // Sui product object identifier for this note.
  status: 'active' | 'matured' | 'withdrawn';
  created_at: string;
  maturity_date: string;
  // On-chain integration columns (see db/schema_ppn_onchain.sql). All nullable
  // so local rows continue to round-trip unchanged.
  note_seed_hex?: string | null;
  onchain_tx_signature?: string | null;
  redemption_tx_signature?: string | null;
  maturity_ts?: number | null;
  // Tranche overlay (see db/schema_tranche.sql). NULL columns = vanilla PPN.
  tranche_kind?: 'senior' | 'mezzanine' | 'junior' | null;
  tranche_attach?: number | null;
  tranche_detach?: number | null;
  price_per_token?: number | null;
}

export interface PPNDepositRequest {
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
  maturity_days?: number; // default 30
  // Tranche overlay — protected notes are reused for senior/mezz/junior tranches
  // (see db/schema_tranche.sql). When any of these are set the backend persists
  // them alongside the note so the frontend can render the tranche-specific
  // UI for this vault. Vanilla PPNs leave all four NULL.
  tranche_kind?: 'senior' | 'mezzanine' | 'junior';
  tranche_attach?: number;
  tranche_detach?: number;
  price_per_token?: number;
}

export interface PPNDepositResponse {
  vault_id: string;
  bundle_id: string;
  principal_usdc: number;
  estimated_apy: number;
  estimated_yield_at_maturity: number;
  maturity_date: string;
  message: string;
}

// === Alert types ===

export interface PriceAlert {
  id: string;
  bundle_id: string;
  wallet_address: string;
  alert_type: 'above' | 'below' | 'change_percent';
  threshold: number;          // For above/below: NAV threshold. For change_percent: % change
  triggered: boolean;
  triggered_at?: string;
  triggered_nav?: number;
  created_at: string;
}
