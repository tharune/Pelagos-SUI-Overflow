import { Router, Request, Response } from 'express';
import { supabase } from '../db/supabase';
import { Position } from '../types';

const router = Router();

/**
 * GET /api/leaderboard
 * Top wallets by total deposited value.
 * Query params: limit (default 10)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10, 1), 100);

    // Fetch all positions
    const { data: positions, error } = await supabase
      .from('positions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      // Table may not exist yet - return empty rather than 500
      console.error('Leaderboard query error:', error.message);
      return res.json({ count: 0, wallets: [] });
    }

    if (!positions || positions.length === 0) {
      return res.json({ count: 0, wallets: [] });
    }

    // Group by wallet_address
    const walletMap = new Map<string, {
      total_deposited: number;
      position_count: number;
      approximate_value: number;
    }>();

    for (const pos of positions as Position[]) {
      const existing = walletMap.get(pos.wallet_address);
      const approxValue = pos.tokens_held * pos.entry_price;

      if (existing) {
        existing.total_deposited += pos.deposited_usdc;
        existing.position_count += 1;
        existing.approximate_value += approxValue;
      } else {
        walletMap.set(pos.wallet_address, {
          total_deposited: pos.deposited_usdc,
          position_count: 1,
          approximate_value: approxValue,
        });
      }
    }

    // Sort by total_deposited desc and apply limit
    const wallets = Array.from(walletMap.entries())
      .map(([wallet_address, stats]) => ({
        wallet_address,
        total_deposited: Math.round(stats.total_deposited * 100) / 100,
        position_count: stats.position_count,
        approximate_value: Math.round(stats.approximate_value * 100) / 100,
      }))
      .sort((a, b) => b.total_deposited - a.total_deposited)
      .slice(0, limit);

    res.json({ count: wallets.length, wallets });
  } catch (err) {
    console.error('GET /api/leaderboard error:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

export const leaderboardRoutes = router;
