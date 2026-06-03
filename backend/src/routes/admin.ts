import { Router, Request, Response } from 'express';
import {
  getAllBundles,
  getBundleById,
  updateBundleStatus,
  getAllPositions,
  getAllTransactions,
  getAllLegs,
  getTransactionStats,
} from '../db/queries';
import {
  adminWithdrawFees,
  getProductState,
  getYieldSleeveState,
  initializeYieldSleeve,
} from '../services/pelagos-chain';
import {
  finalizeBundleIfReady,
  initializeOnchainVaultForBundle,
  resolveLegOnchainMirror,
} from '../services/onchain-bridge';

const router = Router();

/**
 * GET /api/admin/stats
 * Platform-level statistics: bundle counts, position/transaction totals, USDC flows.
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [bundles, legs, positions, txStats] = await Promise.all([
      getAllBundles(),
      getAllLegs(),
      getAllPositions(),
      getTransactionStats(),
    ]);

    // Also need raw transactions for total count
    const transactions = await getAllTransactions();

    res.json({
      total_bundles: bundles.length,
      active_bundles: bundles.filter((b) => b.status === 'active').length,
      resolved_bundles: bundles.filter((b) => b.status === 'resolved').length,
      total_legs: legs.length,
      total_positions: positions.length,
      total_transactions: transactions.length,
      total_deposited_usdc: txStats.total_deposited,
      total_redeemed_usdc: txStats.total_redeemed,
      total_fees_collected: txStats.total_fees,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/admin/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch platform stats' });
  }
});

/**
 * POST /api/admin/bundles/:id/cancel
 * Cancel an active bundle. Sets status to 'cancelled'.
 */
router.post('/bundles/:id/cancel', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const bundle = await getBundleById(id);
    if (!bundle) {
      return res.status(404).json({ error: `Bundle not found: ${id}` });
    }
    if (bundle.status !== 'active') {
      return res.status(400).json({ error: `Bundle is not active (status: ${bundle.status})` });
    }

    const updated = await updateBundleStatus(id, 'cancelled');
    if (!updated) {
      return res.status(500).json({ error: 'Failed to cancel bundle' });
    }

    res.json(updated);
  } catch (err) {
    console.error('POST /api/admin/bundles/:id/cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel bundle' });
  }
});

/**
 * GET /api/admin/transactions
 * List all transactions with optional filters.
 * Query params: wallet, type (deposit|redemption), limit (default 50)
 */
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const { wallet, type, limit } = req.query;

    const parsedLimit = limit ? parseInt(limit as string, 10) : 50;
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    if (type && !['deposit', 'redemption', 'transfer'].includes(type as string)) {
      return res.status(400).json({ error: 'type must be deposit, redemption, or transfer' });
    }

    const transactions = await getAllTransactions({
      wallet: wallet as string | undefined,
      type: type as string | undefined,
      limit: parsedLimit,
    });

    res.json({
      count: transactions.length,
      transactions,
    });
  } catch (err) {
    console.error('GET /api/admin/transactions error:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ---------------------------------------------------------------------------
// Onchain administration
// ---------------------------------------------------------------------------

/**
 * POST /api/admin/bundles/:id/init-onchain
 * Initialize the onchain vault for an existing Supabase bundle.
 * Idempotent — if the vault already exists, returns the current addresses.
 */
router.post('/bundles/:id/init-onchain', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const bundle = await getBundleById(id);
    if (!bundle) return res.status(404).json({ error: `Bundle not found: ${id}` });

    const result = await initializeOnchainVaultForBundle(id);
    if (!result) return res.status(500).json({ error: 'Failed to initialize onchain vault' });

    res.json({ bundle_id: id, ...result });
  } catch (err) {
    console.error('POST /api/admin/bundles/:id/init-onchain error:', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/admin/bundles/:id/resolve-leg
 * Force-resolve a leg onchain (and mirror in DB). For demo / manual overrides
 * when the webhook or cron hasn't fired yet.
 * Body: { leg_id, outcome: "won" | "lost" }
 */
router.post('/bundles/:id/resolve-leg', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { leg_id, outcome } = req.body as { leg_id: string; outcome: 'won' | 'lost' };
    if (!leg_id || !outcome) {
      return res.status(400).json({ error: 'leg_id and outcome are required' });
    }
    const sig = await resolveLegOnchainMirror(id, leg_id, outcome);
    await finalizeBundleIfReady(id);
    res.json({ bundle_id: id, leg_id, outcome, tx_signature: sig });
  } catch (err) {
    console.error('POST /api/admin/bundles/:id/resolve-leg error:', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/admin/bundles/:id/finalize
 * Manually trigger finalize_vault if all legs are resolved but the auto-path
 * didn't fire (e.g. a historical cron miss).
 */
router.post('/bundles/:id/finalize', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sig = await finalizeBundleIfReady(id);
    if (!sig) {
      return res
        .status(400)
        .json({ error: 'Bundle is not ready to finalize (legs unresolved or already finalized)' });
    }
    res.json({ bundle_id: id, tx_signature: sig });
  } catch (err) {
    console.error('POST /api/admin/bundles/:id/finalize error:', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/admin/bundles/:id/withdraw-fees
 * Drain residual USDC from the vault to the fee recipient.
 */
router.post('/bundles/:id/withdraw-fees', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sig = await adminWithdrawFees(id);
    res.json({ bundle_id: id, tx_signature: sig });
  } catch (err) {
    console.error('POST /api/admin/bundles/:id/withdraw-fees error:', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/admin/bundles/:id/onchain
 * Read the on-chain vault state. Useful for judging / debugging.
 */
router.get('/bundles/:id/onchain', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const state = await getProductState(id);
    if (!state) return res.status(404).json({ error: 'Sui product not initialized' });
    res.json(state);
  } catch (err) {
    console.error('GET /api/admin/bundles/:id/onchain error:', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/admin/init-yield-sleeve
 * One-time bootstrap of the Sui yield sleeve used by protected notes.
 *
 * Body: { apy_bps?: number }  (default 800 = 8% APY)
 */
router.post('/init-yield-sleeve', async (req: Request, res: Response) => {
  try {
    const { apy_bps } = req.body as { apy_bps?: number };
    const apyBps = typeof apy_bps === 'number' && apy_bps > 0 ? apy_bps : 800;
    if (apyBps > 10_000) {
      return res
        .status(400)
        .json({ error: 'apy_bps too high (max 10000 = 100%)' });
    }
    const result = await initializeYieldSleeve(apyBps);
    res.json(result);
  } catch (err) {
    console.error('POST /api/admin/init-yield-sleeve error:', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/admin/yield-sleeve
 * Read the Sui yield sleeve state.
 */
router.get('/yield-sleeve', async (_req: Request, res: Response) => {
  try {
    const state = await getYieldSleeveState();
    res.json(state);
  } catch (err) {
    console.error('GET /api/admin/yield-sleeve error:', err);
    res.status(500).json({ error: String(err) });
  }
});

export const adminRoutes = router;
