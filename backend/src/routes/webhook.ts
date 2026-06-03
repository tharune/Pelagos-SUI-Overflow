import { Router, Request, Response } from 'express';
import { getAllLegs, updateLegResolution } from '../db/queries';

const router = Router();

router.post('/polymarket', async (req: Request, res: Response) => {
  try {
    const { market_id, outcome } = req.body as {
      market_id?: string;
      outcome?: 'won' | 'lost';
    };
    if (!market_id || !outcome) {
      return res.status(400).json({ error: 'market_id and outcome are required' });
    }
    const legs = await getAllLegs();
    const matches = legs.filter((leg) => leg.market_id === market_id);
    await Promise.all(
      matches.map((leg) =>
        updateLegResolution(leg.id, outcome, outcome === 'won' ? 1 : 0),
      ),
    );
    res.json({ status: 'ok', updated_legs: matches.length });
  } catch (err) {
    console.error('POST /api/webhook/polymarket error:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'pelagos-webhook' });
});

export const webhookRoutes = router;
