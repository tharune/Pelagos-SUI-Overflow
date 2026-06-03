/**
 * Pelagos API Types
 * Copy this file to your frontend project for type-safe API calls.
 *
 * Generated from backend type definitions and route handlers.
 * Backend: Express + Supabase + Polymarket Gamma API
 */

// ============================================================================
// Core Domain Types (mirrors Supabase schema)
// ============================================================================

export interface Bundle {
  id: string;
  name: string; // e.g. "PBU-HIGH-SHORT"
  risk_tier: 90 | 70 | 50;
  resolution_date: string; // ISO date
  issue_price: number; // e.g. 0.90
  status: 'active' | 'resolved' | 'cancelled';
  description?: string;
  theme?: string; // e.g. "Mixed Q2 2026"
  created_at: string;
}

export interface Leg {
  id: string;
  bundle_id: string;
  market_id: string; // Polymarket condition_id
  question: string; // e.g. "Will BTC hit $100k by April 30?"
  probability: number; // 0-1
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
  entry_price: number;
  deposited_usdc: number;
  created_at: string;
}

export interface Transaction {
  id: string;
  bundle_id: string;
  wallet_address: string;
  type: 'deposit' | 'redemption' | 'transfer';
  amount_usdc: number;
  tokens: number;
  fee_usdc: number; // 0.5% structuring fee
  tx_signature?: string; // Sui transaction digest or adapter signature
  created_at: string;
}

// ============================================================================
// API Request Types
// ============================================================================

export interface CreateBundleRequest {
  name: string; // uppercase alphanumeric + hyphens, max 50 chars
  risk_tier: 90 | 70 | 50;
  resolution_date: string; // ISO datetime
  description?: string; // max 500 chars
  theme?: string; // max 100 chars
  legs: {
    market_id: string; // Polymarket condition ID
    question: string; // max 500 chars
    weight?: number; // 0-1, defaults to 1/num_legs
    polymarket_url?: string;
  }[];
}

export interface DepositRequest {
  bundle_id: string; // UUID
  wallet_address: string; // Sui address or compatible wallet address
  amount_usdc: number; // positive, max 1,000,000
}

export interface RedeemRequest {
  bundle_id: string; // UUID of a resolved bundle
  wallet_address: string; // Sui address or compatible wallet address
}

export interface SimulateResolutionRequest {
  leg_id: string;
  outcome: 'won' | 'lost';
}

// ============================================================================
// API Response Types
// ============================================================================

/** GET /api/health */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime_seconds: number;
  memory_mb: number;
  services: {
    supabase: { status: 'ok' | 'error'; latency_ms: number; error?: string };
    polymarket: { status: 'ok' | 'error'; latency_ms: number; error?: string };
  };
}

/** GET /api/bundles, GET /api/bundles/:id, GET /api/bundles/name/:name, POST /api/bundles */
export interface BundleResponse extends Bundle {
  legs: Leg[];
  nav: number;
  num_legs: number;
  resolved_legs: number;
}

/** Per-leg contribution to NAV calculation */
export interface LegNAVContribution {
  leg_id: string;
  question: string;
  status: 'active' | 'won' | 'lost';
  probability: number;
  weight: number;
  contribution: number; // weight * (probability or resolution_value)
}

/** GET /api/nav/:bundleId */
export interface NAVResponse {
  bundle_id: string;
  nav: number;
  legs: LegNAVContribution[];
  timestamp: string;
}

/** Single snapshot in NAV history */
export interface NAVSnapshot {
  id: string;
  bundle_id: string;
  nav: number;
  legs_data: LegNAVContribution[];
  created_at: string;
}

/** GET /api/nav/:bundleId/history */
export interface NAVHistoryResponse {
  bundle_id: string;
  count: number;
  history: NAVSnapshot[];
}

/** POST /api/deposit */
export interface DepositResponse {
  transaction_id: string;
  bundle_id: string;
  tokens_minted: number;
  issue_price: number;
  fee_usdc: number;
  net_usdc: number;
}

/** POST /api/deposit/redeem */
export interface RedeemResponse {
  wallet_address: string;
  bundle_id: string;
  bundle_name: string;
  total_tokens: number;
  final_nav: number;
  payout_usdc: number;
  transaction_id: string;
}

/** GET /api/deposit/portfolio/:walletAddress */
export interface PortfolioResponse {
  wallet_address: string;
  positions: {
    position_id: string;
    bundle_id: string;
    bundle_name: string;
    bundle_status: string;
    risk_tier: number;
    tokens_held: number;
    entry_price: number;
    deposited_usdc: number;
    current_nav: number;
    current_value: number;
    unrealized_pnl: number;
    pnl_percent: number;
    created_at: string;
  }[];
  total_value: number;
  total_deposited: number;
  total_pnl: number;
  total_pnl_percent: number;
}

/** GET /api/deposit/transactions/:walletAddress */
export interface TransactionHistoryResponse {
  wallet_address: string;
  count: number;
  transactions: {
    id: string;
    bundle_id: string;
    bundle_name: string;
    type: 'deposit' | 'redemption' | 'transfer';
    amount_usdc: number;
    tokens: number;
    fee_usdc: number;
    tx_signature?: string;
    created_at: string;
  }[];
}

/** GET /api/bundles/:id/performance */
export interface PerformanceResponse {
  bundle_id: string;
  bundle_name: string;
  risk_tier: number;
  status: string;
  current_nav: number;
  issue_price: number;
  nav_change: number;
  nav_change_percent: number;
  legs_summary: {
    total: number;
    active: number;
    won: number;
    lost: number;
    resolution_progress: number;
    weighted_win_rate: number | null;
  };
  probability_stats: {
    average: number;
    min: number;
    max: number;
    spread: number;
    std_dev: number;
  };
  risk_score: number;
  days_to_resolution: number;
  resolution_date: string;
  created_at: string;
}

/** POST /api/nav/:bundleId/check-resolutions */
export interface CheckResolutionsResponse {
  bundle_id: string;
  newly_resolved: {
    leg_id: string;
    question: string;
    status: 'won' | 'lost';
    resolution_value: number;
  }[];
  newly_resolved_count: number;
  total_legs: number;
  resolved_legs: number;
  bundle_fully_resolved: boolean;
}

/** POST /api/nav/:bundleId/simulate-resolution */
export interface SimulateResolutionResponse {
  bundle_id: string;
  leg: {
    leg_id: string;
    question: string;
    status: 'won' | 'lost';
    resolution_value: number;
  };
  total_legs: number;
  resolved_legs: number;
  bundle_fully_resolved: boolean;
}

/** GET /api/admin/stats */
export interface StatsResponse {
  total_bundles: number;
  active_bundles: number;
  resolved_bundles: number;
  total_legs: number;
  total_positions: number;
  total_transactions: number;
  total_deposited_usdc: number;
  total_redeemed_usdc: number;
  total_fees_collected: number;
  timestamp: string;
}

/** GET /api/leaderboard */
export interface LeaderboardResponse {
  count: number;
  wallets: {
    wallet_address: string;
    total_deposited: number;
    position_count: number;
    approximate_value: number;
  }[];
}

/** GET /api/admin/transactions */
export interface AdminTransactionsResponse {
  count: number;
  transactions: Transaction[];
}

/** GET /api/markets */
export interface MarketsListResponse {
  count: number;
  markets: PolymarketMarket[];
}

/** GET /api/markets/search/:query */
export interface MarketSearchResponse {
  query: string;
  count: number;
  markets: PolymarketMarket[];
}

/** Polymarket market shape returned by /api/markets endpoints */
export interface PolymarketMarket {
  id: string;
  question: string;
  condition_id: string;
  tokens: { token_id: string; outcome: string; price: number }[];
  outcomePrices: string; // JSON string e.g. '["0.9","0.1"]'
  volume: string;
  active: boolean;
  closed: boolean;
  end_date_iso?: string;
}

/** GET /api/demo/status */
export interface DemoStatusResponse {
  demo_wallet: string;
  note: string;
  active_bundles: number;
  total_bundles: number;
}

/** SSE data event for /api/sse/nav/:bundleId */
export interface SSENavEvent {
  nav: number;
  legs: LegNAVContribution[];
  timestamp: string;
}

/** SSE data event for /api/sse/portfolio/:walletAddress */
export interface SSEPortfolioEvent {
  wallet_address: string;
  positions: {
    bundle_id: string;
    tokens_held: number;
    entry_price: number;
    deposited_usdc: number;
    current_nav: number;
    current_value: number;
    pnl: number;
  }[];
  total_deposited: number;
  total_current_value: number;
  total_pnl: number;
  timestamp: string;
}

// ============================================================================
// PPN (Principal Protected Notes) Types
// ============================================================================

/** POST /api/ppn/deposit request body */
export interface PPNDepositRequest {
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
  maturity_days?: number; // 7-365, default 30
}

/** POST /api/ppn/deposit */
export interface PPNDepositResponse {
  vault_id: string;
  bundle_id: string;
  principal_usdc: number;
  estimated_apy: number;
  estimated_yield_at_maturity: number;
  maturity_date: string;
  message: string;
}

/** Enriched vault in portfolio response */
export interface PPNVaultEnriched {
  vault_id: string;
  bundle_id: string;
  bundle_name: string;
  bundle_status: string;
  principal_usdc: number;
  yield_deployed_usdc: number;
  accrued_yield: number;
  projected_total_yield: number;
  estimated_apy: number;
  status: 'active' | 'matured' | 'withdrawn';
  days_elapsed: number;
  days_remaining: number;
  maturity_date: string;
  created_at: string;
  total_value: number;
}

/** GET /api/ppn/portfolio/:walletAddress */
export interface PPNPortfolioResponse {
  wallet_address: string;
  vaults: PPNVaultEnriched[];
  summary: {
    total_vaults: number;
    total_principal: number;
    total_accrued_yield: number;
    total_value: number;
    principal_protected: true;
  };
}

/** POST /api/ppn/withdraw/:vaultId */
export interface PPNWithdrawResponse {
  vault_id: string;
  wallet_address: string;
  principal_returned: number;
  yield_earned: number;
  total_payout: number;
  days_held: number;
  effective_apy: number;
  message: string;
}

/** Standard error response shape */
export interface APIError {
  error: string;
  details?: { path: string; message: string }[];
}

// ============================================================================
// API Endpoint Paths (for use with fetch/axios)
// ============================================================================

export const API_ENDPOINTS = {
  health: '/api/health',
  docs: '/api/docs',

  bundles: {
    list: '/api/bundles',
    byId: (id: string) => `/api/bundles/${id}`,
    byName: (name: string) => `/api/bundles/name/${name}`,
    create: '/api/bundles',
    performance: (id: string) => `/api/bundles/${id}/performance`,
  },

  nav: {
    live: (bundleId: string) => `/api/nav/${bundleId}`,
    history: (bundleId: string) => `/api/nav/${bundleId}/history`,
    checkResolutions: (bundleId: string) => `/api/nav/${bundleId}/check-resolutions`,
    simulateResolution: (bundleId: string) => `/api/nav/${bundleId}/simulate-resolution`,
  },

  deposit: {
    create: '/api/deposit',
    redeem: '/api/deposit/redeem',
    portfolio: (wallet: string) => `/api/deposit/portfolio/${wallet}`,
    transactions: (wallet: string) => `/api/deposit/transactions/${wallet}`,
  },

  markets: {
    list: '/api/markets',
    search: (query: string) => `/api/markets/search/${query}`,
    byId: (id: string) => `/api/markets/${id}`,
  },

  sse: {
    nav: (bundleId: string) => `/api/sse/nav/${bundleId}`,
    portfolio: (wallet: string) => `/api/sse/portfolio/${wallet}`,
  },

  leaderboard: '/api/leaderboard',

  admin: {
    stats: '/api/admin/stats',
    cancelBundle: (id: string) => `/api/admin/bundles/${id}/cancel`,
    transactions: '/api/admin/transactions',
  },

  demo: {
    simulateLifecycle: '/api/demo/simulate-lifecycle',
    status: '/api/demo/status',
  },

  ppn: {
    deposit: '/api/ppn/deposit',
    portfolio: (wallet: string) => `/api/ppn/portfolio/${wallet}`,
    withdraw: (vaultId: string) => `/api/ppn/withdraw/${vaultId}`,
  },
} as const;
