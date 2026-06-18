/**
 * DeepBook Strategy Engine routes (/api/deepbook).
 *
 *   GET  /strategies — the prebuilt structured-strategy catalogue, tagged by
 *                      tail-risk / convexity / payoff shape.
 *   POST /quote      — price a chosen strategy as a real range strip on a live
 *                      DeepBook Predict BTC oracle (get_range_trade_amounts
 *                      devInspect), with Greeks and the on-chain routing handles.
 *
 * Every quote is the protocol's REAL strip pricing — buckets, total cost, and
 * realized max payout come straight from the on-chain MM. The frontend uses
 * `oracle_id` + `expiry` + `strip.buckets` to deploy via the existing
 * /api/predict/strip/open/prepare (wallet-signed) path.
 */
import { Router, Request, Response } from 'express';
import {
  listStrategies,
  quoteStrategy,
  type ExpiryPref,
} from '../services/deepbook-strategies';

const router = Router();

function parseExpiryPref(v: unknown): ExpiryPref | undefined {
  if (v === 'near' || v === 'mid' || v === 'far') return v;
  return undefined;
}

/** GET /api/deepbook/strategies — the prebuilt strategy catalogue. */
router.get('/strategies', (_req: Request, res: Response) => {
  try {
    res.json({ strategies: listStrategies() });
  } catch (err) {
    console.error('GET /api/deepbook/strategies error:', err);
    res.status(500).json({ error: 'Failed to list strategies' });
  }
});

/**
 * POST /api/deepbook/quote
 * body: { strategy_id, notional_usd, expiry_pref?: "near"|"mid"|"far" }
 * Prices the strategy's strip on a live BTC oracle (real on-chain devInspect).
 */
router.post('/quote', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const strategyId = typeof body.strategy_id === 'string' ? body.strategy_id : '';
    if (!strategyId) {
      return res.status(400).json({ error: 'strategy_id is required' });
    }
    const notionalUsd = Math.max(1, Number(body.notional_usd ?? body.notional ?? 100));
    const out = await quoteStrategy({
      strategyId,
      notionalUsd,
      expiryPref: parseExpiryPref(body.expiry_pref),
      sender: typeof body.sender === 'string' ? body.sender : undefined,
    });
    res.json({
      strategy_id: out.strategy_id,
      name: out.name,
      thesis: out.thesis,
      tail_risk: out.tail_risk,
      convexity: out.convexity,
      payoff_shape: out.payoff_shape,
      risk_note: out.risk_note,
      oracle_id: out.oracle_id,
      expiry: out.expiry,
      tenor_label: out.tenor_label,
      notional_usd: out.notional_usd,
      forward_usd: out.forward_usd,
      sigma_usd: out.sigma_usd,
      atm_iv: out.atm_iv,
      t_years: out.t_years,
      max_loss_usd: out.max_loss_usd,
      strip: out.strip,
      greeks: out.greeks,
      dusdc_decimals: out.dusdc_decimals,
      source: out.source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unknown strategy/i.test(message)) {
      return res.status(400).json({ error: message });
    }
    if (/no active BTC oracle/i.test(message)) {
      return res.status(404).json({ error: message });
    }
    console.error('POST /api/deepbook/quote error:', err);
    res.status(500).json({ error: message });
  }
});

export const deepbookRoutes = router;
