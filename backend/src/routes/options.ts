import { Router, Request, Response } from 'express';
import { getOptionsChain } from '../services/options-chain';

const router = Router();

/**
 * GET /api/options/chain?underlying=BTC
 *
 * Live European options CHAIN synthesized off the DeepBook Predict SVI vol
 * surface. For each active expiry we price a CALL + PUT at every strike on a
 * 0.8..1.2 moneyness grid using Black-76 on the oracle's live on-chain forward
 * and the SVI smile IV at that strike, with full analytic greeks. Each strike is
 * marked `tradeable` when it snaps onto the oracle's on-chain strike grid, so the
 * UI can route a real binary/range order to Predict there. The `source` field
 * documents that premia are Black-76 *derived* from the live surface (real IVs,
 * on-chain forward) — not exchange-quoted option prices.
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

export const optionsRoutes = router;
