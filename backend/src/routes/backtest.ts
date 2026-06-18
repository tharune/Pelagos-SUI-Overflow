import { Router, Request, Response } from 'express';
import { backtestStrategy, priceSeries, STRATEGIES } from '../services/strategy-backtest';

const router = Router();

/**
 * GET /api/backtest/strategies
 * The strategy library the frontend can offer (id + name + kind + description).
 */
router.get('/strategies', (_req: Request, res: Response) => {
  res.json({ strategies: STRATEGIES });
});

/**
 * GET /api/backtest/strategy?id=<strategyId>&window=<days>
 *
 * Backtest a named strategy class on REAL history. BTC/vol strategies replay
 * live Coinbase daily candles; event-basket replays a representative live-basket
 * leg on its real Polymarket CLOB price history. Returns an equity curve +
 * metrics, an honest source tag, and a coverage note describing the real window
 * actually used (it never fabricates points for an uncovered window).
 */
router.get('/strategy', async (req: Request, res: Response) => {
  try {
    const id = String(req.query.id ?? 'long-vol-straddle');
    const window = req.query.window !== undefined ? Number(req.query.window) : 90;
    const result = await backtestStrategy(id, window);
    res.json(result);
  } catch (err) {
    console.error('GET /api/backtest/strategy error:', err);
    res.status(500).json({ error: 'Failed to backtest strategy' });
  }
});

/**
 * GET /api/backtest/series?product=BTC-USD&days=<n>
 * Raw REAL price series (Coinbase daily closes) for charting.
 */
router.get('/series', async (req: Request, res: Response) => {
  try {
    const product = String(req.query.product ?? 'BTC-USD').toUpperCase();
    const days = req.query.days !== undefined ? Number(req.query.days) : 90;
    const result = await priceSeries(product, days);
    res.json(result);
  } catch (err) {
    console.error('GET /api/backtest/series error:', err);
    res.status(500).json({ error: 'Failed to fetch price series' });
  }
});

export const backtestRoutes = router;
