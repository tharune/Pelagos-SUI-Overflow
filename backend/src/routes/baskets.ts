import { Router, Request, Response } from 'express';
import { getLiveBaskets } from '../services/baskets';

const router = Router();

/**
 * GET /api/baskets
 * The live Event-Baskets grid (PBU-HIGH-* / PBU-LOW-*), each with its full
 * constituent legs priced off the Polymarket CLOB order book. This is the
 * source of truth for the frontend's Event Baskets + Risk Slices surfaces.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await getLiveBaskets();
    res.json({
      count: result.baskets.length,
      source: result.source,
      universe: result.universe,
      total_legs: result.total_legs,
      clob_priced_legs: result.clob_priced_legs,
      at: result.at,
      baskets: result.baskets,
    });
  } catch (err) {
    console.error('GET /api/baskets error:', err);
    res.status(500).json({ error: 'Failed to build live baskets' });
  }
});

/**
 * GET /api/baskets/:id
 * A single basket (e.g. PBU-HIGH-SHORT) with its CLOB-priced legs.
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await getLiveBaskets();
    const basket = result.baskets.find((b) => b.id === id);
    if (!basket) {
      return res.status(404).json({ error: `Basket not found: ${id}` });
    }
    res.json({ basket, at: result.at });
  } catch (err) {
    console.error('GET /api/baskets/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch basket' });
  }
});

export const basketRoutes = router;
