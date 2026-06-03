import { Router, Request, Response } from 'express';
import { getBundleWithLegs } from '../db/queries';
import { getLiveNAV } from '../services/pricing';

const router = Router();

/**
 * POST /api/batch/nav
 * Get NAV for multiple bundles in one request.
 * Body: { bundle_ids: string[] }
 * Returns: { count, results: { [bundle_id]: NAVResult } }
 */
router.post('/nav', async (req: Request, res: Response) => {
  try {
    const { bundle_ids } = req.body;

    if (!Array.isArray(bundle_ids) || bundle_ids.length === 0) {
      return res.status(400).json({ error: 'bundle_ids must be a non-empty array' });
    }
    if (bundle_ids.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 bundles per batch request' });
    }

    const results: Record<string, any> = {};

    await Promise.allSettled(
      bundle_ids.map(async (bundleId: string) => {
        try {
          const navResult = await getLiveNAV(bundleId);
          if (navResult) {
            results[bundleId] = navResult;
          } else {
            results[bundleId] = { error: 'Not found' };
          }
        } catch (err) {
          results[bundleId] = { error: 'Failed to fetch' };
        }
      })
    );

    res.json({ count: Object.keys(results).length, results });
  } catch (err) {
    console.error('POST /api/batch/nav error:', err);
    res.status(500).json({ error: 'Batch NAV fetch failed' });
  }
});

/**
 * POST /api/batch/bundles
 * Get full bundle data for multiple bundles.
 * Body: { bundle_ids: string[] }
 * Returns: { count, results: { [bundle_id]: BundleWithLegs } }
 */
router.post('/bundles', async (req: Request, res: Response) => {
  try {
    const { bundle_ids } = req.body;

    if (!Array.isArray(bundle_ids) || bundle_ids.length === 0) {
      return res.status(400).json({ error: 'bundle_ids must be a non-empty array' });
    }
    if (bundle_ids.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 bundles per batch request' });
    }

    const results: Record<string, any> = {};

    await Promise.allSettled(
      bundle_ids.map(async (bundleId: string) => {
        try {
          const bundle = await getBundleWithLegs(bundleId);
          if (bundle) {
            results[bundleId] = bundle;
          } else {
            results[bundleId] = { error: 'Not found' };
          }
        } catch (err) {
          results[bundleId] = { error: 'Failed to fetch' };
        }
      })
    );

    res.json({ count: Object.keys(results).length, results });
  } catch (err) {
    console.error('POST /api/batch/bundles error:', err);
    res.status(500).json({ error: 'Batch bundles fetch failed' });
  }
});

export const batchRoutes = router;
