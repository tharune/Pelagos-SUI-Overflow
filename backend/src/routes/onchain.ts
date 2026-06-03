import { Router, Request, Response } from 'express';
import { suiStatus } from '../services/sui';

const router = Router();

router.get('/status', async (_req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const status = await suiStatus();
    res.json({
      chain: 'sui',
      network: status.network,
      active_env: status.active_env,
      rpc_url: status.rpc_url,
      active_address: status.active_address,
      package_id: status.package_id,
      market_module: status.market_module,
      market_admin_cap_id: status.market_admin_cap_id,
      mock_usdc_type: status.mock_usdc_type,
      mock_usdc_metadata_id: status.mock_usdc_metadata_id,
      balances: status.balances,
      total_latency_ms: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      chain: 'sui',
      network: process.env.SUI_NETWORK ?? 'testnet',
      error: err instanceof Error ? err.message : String(err),
      total_latency_ms: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
  }
});

export const onchainRoutes = router;
