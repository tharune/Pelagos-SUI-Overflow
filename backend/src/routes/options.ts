import { Router, Request, Response } from 'express';
import { getOptionsChain, getBandDepth } from '../services/options-chain';

const router = Router();

/**
 * GET /api/options/chain?underlying=BTC
 *
 * Live BTC options CHAIN priced on the REAL DeepBook Predict range liquidity (not
 * a model). For each active expiry we lay strikes on a ±3σ grid (scaled by the
 * implied move, snapped to the oracle's on-chain grid) and price a CALL [K, far]
 * and PUT [floor, K] range leg at 1 contract in ONE batched on-chain devInspect:
 * ask = mint_cost, bid = redeem_payout, mid = (bid+ask)/2. The IV column is the
 * oracle's live SVI smile (context only) and the greeks are the digital risk
 * sensitivities off that surface, bounded for display. Each strike is `tradeable`
 * when its live ask sits inside the protocol's mintable [2%,98%] window, so the UI
 * can route a real range order to Predict there. The `source` field
 * ('deepbook-predict-range-onchain') documents that premia are the protocol's own
 * range prices — NOT Black-76 and NOT exchange-quoted option prices.
 */
router.get('/chain', async (req: Request, res: Response) => {
  try {
    const underlying = String(req.query.underlying ?? 'BTC').toUpperCase();
    const chain = await getOptionsChain(underlying);
    res.json(chain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no active oracles/i.test(message)) {
      return res.status(404).json({ error: 'no active oracles' });
    }
    console.error('GET /api/options/chain error:', err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/options/depth?oracle_id=…&expiry=…&lower=…&higher=…
 *
 * Liquidity-depth / risk cap for ONE strike band. Probes DeepBook Predict at a
 * ladder of sizes and returns the largest order that stays inside the market-
 * impact cap (≤15% slippage, ≤98% mintable) AND the pool-capacity cap (≤2% of
 * available pool liquidity). The UI clamps the order size to `max_contracts` so
 * a single order can't hammer the book or pump a thin strike.
 */
router.get('/depth', async (req: Request, res: Response) => {
  try {
    const oracle_id = String(req.query.oracle_id ?? '');
    const expiry = String(req.query.expiry ?? '');
    const lower = String(req.query.lower ?? '');
    const higher = String(req.query.higher ?? '');
    if (!oracle_id || !expiry || !lower || !higher) {
      return res.status(400).json({ error: 'oracle_id, expiry, lower, higher are required' });
    }
    res.json(await getBandDepth(oracle_id, expiry, lower, higher));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/options/depth error:', err);
    res.status(500).json({ error: message });
  }
});

export const optionsRoutes = router;
