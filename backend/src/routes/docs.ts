import { Router, Request, Response } from 'express';

const router = Router();

const apiDocs = {
  name: 'Pelagos API',
  version: '1.0.0',
  description: 'Structured prediction-market products on Sui testnet',
  base_url: '/api',
  deployment: {
    chain: 'sui',
    network: process.env.SUI_NETWORK ?? 'testnet',
    package_id: process.env.SUI_PACKAGE_ID ?? null,
    mock_usdc_type: process.env.MOCK_USDC_TYPE ?? null,
    active_address: process.env.SUI_ACTIVE_ADDRESS ?? null,
  },
  notes: [
    'The current Sui mode is a local hackathon harness.',
    'Backend Sui routes sign with the configured local Sui dev key.',
    'Production should move user actions to wallet-signed Sui PTBs and indexed chain state.',
  ],
  endpoints: [
    {
      method: 'GET',
      path: '/api/health',
      description: 'Backend health check. Reports Supabase configuration state, Polymarket connectivity, uptime, and memory.',
      response: '{ status, timestamp, uptime_seconds, memory_mb, services }',
    },
    {
      method: 'GET',
      path: '/api/docs',
      description: 'This Sui-focused API documentation endpoint.',
      response: '{ name, version, description, deployment, endpoints[] }',
    },
    {
      method: 'GET',
      path: '/api/sui/status',
      description: 'Reports active Sui environment, active address, package IDs, mock-USDC type, and Sui/mock-USDC balances.',
      response: '{ network, active_env, active_address, package_id, mock_usdc_type, balances }',
    },
    {
      method: 'GET',
      path: '/api/distribution/candidates',
      description: 'Discovers live launchable distribution-market candidates from Polymarket event groups using outcome-fit classification, NLP quality/category scoring, volume, CLOB depth, spread, and time-to-resolution. The reference curve is the normalized CLOB-implied probability vector.',
      response: '{ candidates: DistributionCandidate[], funnel, fetched_at }',
    },
    {
      method: 'POST',
      path: '/api/distribution/quote',
      description: 'Normalizes a submitted target curve against the live reference curve and returns the L2 quote, target-reference payout curve, required collateral, fees, and per-band P/L.',
      body: {
        candidate_id: 'Live distribution candidate id',
        weights: 'number[] with one entry per live band',
        collateral_usdc: 'UI amount in USDC',
      },
      response: '{ quote: DistributionQuote }',
    },
    {
      method: 'POST',
      path: '/api/distribution/launch-plan',
      description: 'Builds a local launch plan for a candidate, including band market ids, token ids, initial weights, required depth, and readiness status.',
      body: {
        candidate_id: 'Live distribution candidate id',
      },
      response: '{ plan: DistributionLaunchPlan }',
    },
    {
      method: 'POST',
      path: '/api/sui/mock-usdc/mint',
      description: 'Mints testnet mock USDC to a recipient using the configured local TreasuryCap owner.',
      body: {
        recipient: 'Sui address',
        amount_raw: 'optional raw integer amount in 6-decimal units',
        amount_ui: 'optional UI amount, converted to 6-decimal raw units',
      },
      response: 'Raw Sui CLI JSON transaction response',
    },
    {
      method: 'POST',
      path: '/api/sui/markets',
      description: 'Creates a Sui prediction-market object through the deployed Pelagos Move package.',
      body: {
        question: 'Market question text',
        close_ms: 'optional close timestamp in milliseconds; current harness accepts 0',
      },
      response: 'Raw Sui CLI JSON transaction response',
    },
    {
      method: 'POST',
      path: '/api/sui/markets/:marketId/buy',
      description: 'Buys YES or NO in a Sui market with an existing mock-USDC coin object.',
      body: {
        side: '"yes" | "no"',
        coin_id: 'Sui Coin<MOCK_USDC> object ID',
        amount_raw: 'raw integer amount in 6-decimal units',
      },
      response: 'Raw Sui CLI JSON transaction response',
    },
    {
      method: 'POST',
      path: '/api/sui/markets/:marketId/resolve',
      description: 'Resolves a Sui market to YES or NO using the configured market AdminCap.',
      body: {
        side: '"yes" | "no"',
      },
      response: 'Raw Sui CLI JSON transaction response',
    },
    {
      method: 'POST',
      path: '/api/sui/markets/:marketId/claim',
      description: 'Claims a winning Sui prediction-market position.',
      body: {
        position_id: 'Sui Position object ID',
      },
      response: 'Raw Sui CLI JSON transaction response',
    },
    {
      method: 'POST',
      path: '/api/sui/local/basket/deposit',
      description: 'Local Pelagos bridge used by basket, tranche, and PPN opens. Mints mock USDC, creates a market, buys YES, and returns market/position IDs plus transaction digests.',
      body: {
        bundle_id: 'Pelagos UI bundle identifier, such as PBU-HIGH-SHORT',
        recipient: 'optional Sui recipient address; defaults to active address',
        amount_raw: 'optional raw integer amount in 6-decimal units',
        amount_usdc: 'optional UI amount, converted to raw units',
      },
      response: '{ chain, network, bundle_id, owner, amount_raw, market_id, position_id, digests }',
    },
    {
      method: 'POST',
      path: '/api/sui/local/basket/redeem',
      description: 'Local Pelagos bridge used by basket, tranche, and PPN exits. Resolves the backing market to YES and claims the position.',
      body: {
        market_id: 'Sui Market object ID',
        position_id: 'Sui Position object ID',
      },
      response: '{ chain, network, market_id, position_id, digests }',
    },
    {
      method: 'GET',
      path: '/api/bundles',
      description: 'Lists Pelagos basket metadata and NAV inputs used by the frontend. In local Sui mode, the frontend falls back to seeded local universe data if live DB rows are unavailable.',
      response: 'BundleWithLegs[]',
    },
    {
      method: 'GET',
      path: '/api/markets',
      description: 'Polymarket market data proxy used for basket/NAV context.',
      query_params: [
        'limit - max results',
        'active - filter active markets',
      ],
      response: '{ count, markets }',
    },
    {
      method: 'GET',
      path: '/api/vaults/yields',
      description: 'Yield-source snapshot used by the PPN UI. Current Sui local mode treats this as a routing/display input rather than a Sui-native lending integration.',
      response: '{ pools, selected, generated_at }',
    },
    {
      method: 'GET',
      path: '/api/ppn/portfolio/:walletAddress',
      description: 'PPN portfolio route retained for product UI compatibility. Sui local mode uses Sui-backed local position IDs until a Sui indexer replaces local metadata.',
      response: '{ wallet_address, vaults, summary }',
    },
  ],
};

router.get('/', (_req: Request, res: Response) => {
  res.json(apiDocs);
});

export const docsRoutes = router;
