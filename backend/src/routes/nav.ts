import { Router, Request, Response } from 'express';
import { getLiveNAV, checkAndUpdateResolutions, getVaultPrice } from '../services/pricing';
import { getPolymarketBasketNAVs } from '../services/polymarket';
import { getBundleById } from '../db/queries';
import { isFullyResolved } from '../services/nav';
import {
  getLegsByBundleId,
  updateBundleStatus,
  updateLegResolution,
  getNAVHistory,
  getNAVHistorySince,
} from '../db/queries';

const router = Router();

/**
 * GET /api/nav/:bundleId
 * Get live NAV for a bundle. Fetches latest Polymarket prices,
 * updates DB, returns full NAV breakdown with per-leg contributions.
 */
router.get('/:bundleId', async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;

    const [vaultPrice, polyNAVs, bundle] = await Promise.all([
      getVaultPrice(bundleId),
      getPolymarketBasketNAVs(),
      getBundleById(bundleId),
    ]);

    // Get per-leg probability data for the breakdown table.
    const navResult = await getLiveNAV(bundleId);
    if (!navResult) {
      return res.status(404).json({ error: `Bundle not found or has no legs: ${bundleId}` });
    }

    const polyData = bundle ? polyNAVs.get(bundle.name) : undefined;

    res.json({
      ...navResult,
      nav: navResult.nav,                           // real leg-weighted NAV (consistent everywhere)
      vault_price: vaultPrice?.issue_price ?? null, // on-chain mint price
      polymarket_nav: polyData?.nav ?? null,        // informational only
      polymarket_leg_count: polyData?.leg_count ?? null,
      polymarket_daily_change: polyData?.daily_change ?? null,
    });
  } catch (err) {
    console.error('GET /api/nav/:bundleId error:', err);
    res.status(500).json({ error: 'Failed to calculate NAV' });
  }
});

/**
 * GET /api/nav/:bundleId/history
 * Returns historical NAV snapshots for rendering price charts.
 * Query params:
 *   ?since=<ISO datetime> - return all snapshots since this time
 *   ?limit=<number>       - max snapshots to return (default 100, ignored if since is provided)
 * Snapshots are recorded every 2 minutes by cron.
 */
router.get('/:bundleId/history', async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;
    const { since, limit } = req.query;

    let history;
    if (since && typeof since === 'string') {
      history = await getNAVHistorySince(bundleId, since);
    } else {
      const parsedLimit = limit ? parseInt(limit as string, 10) : 100;
      history = await getNAVHistory(bundleId, parsedLimit);
    }

    res.json({
      bundle_id: bundleId,
      count: history.length,
      history,
    });
  } catch (err) {
    console.error('GET /api/nav/:bundleId/history error:', err);
    res.status(500).json({ error: 'Failed to fetch NAV history' });
  }
});

/**
 * POST /api/nav/:bundleId/check-resolutions
 * Manually trigger resolution check for a bundle.
 * If all legs resolve, auto-updates bundle status to 'resolved'.
 */
router.post('/:bundleId/check-resolutions', async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;

    const newlyResolved = await checkAndUpdateResolutions(bundleId);

    // Check if all legs are now resolved
    const allLegs = await getLegsByBundleId(bundleId);
    if (allLegs.length === 0) {
      return res.status(404).json({ error: `No legs found for bundle: ${bundleId}` });
    }

    let bundleFullyResolved = false;
    if (isFullyResolved(allLegs)) {
      await updateBundleStatus(bundleId, 'resolved');
      bundleFullyResolved = true;
    }

    res.json({
      bundle_id: bundleId,
      newly_resolved: newlyResolved.map((leg) => ({
        leg_id: leg.id,
        question: leg.question,
        status: leg.status,
        resolution_value: leg.resolution_value,
      })),
      newly_resolved_count: newlyResolved.length,
      total_legs: allLegs.length,
      resolved_legs: allLegs.filter((l) => l.status !== 'active').length,
      bundle_fully_resolved: bundleFullyResolved,
    });
  } catch (err) {
    console.error('POST /api/nav/:bundleId/check-resolutions error:', err);
    res.status(500).json({ error: 'Failed to check resolutions' });
  }
});

/**
 * POST /api/nav/:bundleId/simulate-resolution
 * FOR DEMO ONLY: manually force-resolve a leg.
 * Body: { leg_id, outcome: 'won' | 'lost' }
 */
router.post('/:bundleId/simulate-resolution', async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;
    const { leg_id, outcome } = req.body;

    if (!leg_id || !outcome) {
      return res.status(400).json({
        error: 'Missing required fields: leg_id, outcome',
      });
    }

    if (outcome !== 'won' && outcome !== 'lost') {
      return res.status(400).json({
        error: 'outcome must be "won" or "lost"',
      });
    }

    const resolutionValue = outcome === 'won' ? 1.0 : 0.0;

    const updatedLeg = await updateLegResolution(leg_id, outcome, resolutionValue);
    if (!updatedLeg) {
      return res.status(404).json({ error: `Leg not found: ${leg_id}` });
    }

    // Check if all legs are now resolved; if so, update bundle status
    const allLegs = await getLegsByBundleId(bundleId);
    let bundleFullyResolved = false;
    if (isFullyResolved(allLegs)) {
      await updateBundleStatus(bundleId, 'resolved');
      bundleFullyResolved = true;
    }

    res.json({
      bundle_id: bundleId,
      leg: {
        leg_id: updatedLeg.id,
        question: updatedLeg.question,
        status: updatedLeg.status,
        resolution_value: updatedLeg.resolution_value,
      },
      total_legs: allLegs.length,
      resolved_legs: allLegs.filter((l) => l.status !== 'active').length,
      bundle_fully_resolved: bundleFullyResolved,
    });
  } catch (err) {
    console.error('POST /api/nav/:bundleId/simulate-resolution error:', err);
    res.status(500).json({ error: 'Failed to simulate resolution' });
  }
});

export const navRoutes = router;
