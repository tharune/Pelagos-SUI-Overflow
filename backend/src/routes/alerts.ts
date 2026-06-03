import { Router, Request, Response } from 'express';
import {
  createPriceAlert,
  getAlertsByWallet,
  getActiveAlertsByBundle,
  triggerAlert,
  deleteAlert,
  getBundleById,
} from '../db/queries';
import { getLiveNAV } from '../services/pricing';

const router = Router();

/**
 * POST /api/alerts
 * Create a new price alert.
 * Body: { bundle_id, wallet_address, alert_type, threshold }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { bundle_id, wallet_address, alert_type, threshold } = req.body;

    if (!bundle_id || !wallet_address || !alert_type || threshold === undefined) {
      return res.status(400).json({ error: 'bundle_id, wallet_address, alert_type, and threshold are required' });
    }

    if (!['above', 'below', 'change_percent'].includes(alert_type)) {
      return res.status(400).json({ error: 'alert_type must be above, below, or change_percent' });
    }

    if (typeof threshold !== 'number' || threshold < 0) {
      return res.status(400).json({ error: 'threshold must be a non-negative number' });
    }

    const bundle = await getBundleById(bundle_id);
    if (!bundle) {
      return res.status(404).json({ error: `Bundle not found: ${bundle_id}` });
    }

    const alert = await createPriceAlert({
      bundle_id,
      wallet_address,
      alert_type,
      threshold,
    });

    if (!alert) {
      return res.status(500).json({ error: 'Failed to create alert' });
    }

    res.status(201).json(alert);
  } catch (err) {
    console.error('POST /api/alerts error:', err);
    res.status(500).json({ error: 'Failed to create alert' });
  }
});

/**
 * GET /api/alerts/:walletAddress
 * Get all alerts for a wallet.
 */
router.get('/:walletAddress', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    const alerts = await getAlertsByWallet(walletAddress);

    res.json({
      wallet_address: walletAddress,
      count: alerts.length,
      active: alerts.filter(a => !a.triggered).length,
      triggered: alerts.filter(a => a.triggered).length,
      alerts,
    });
  } catch (err) {
    console.error('GET /api/alerts/:walletAddress error:', err);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

/**
 * POST /api/alerts/check/:bundleId
 * Check if any alerts should be triggered for a bundle based on current NAV.
 * Called by cron or manually.
 */
router.post('/check/:bundleId', async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;

    const bundle = await getBundleById(bundleId);
    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    const navResult = await getLiveNAV(bundleId);
    if (!navResult) {
      return res.status(404).json({ error: 'NAV not available' });
    }

    const currentNav = navResult.nav;
    const navChangePercent = bundle.issue_price > 0
      ? ((currentNav - bundle.issue_price) / bundle.issue_price) * 100
      : 0;

    const activeAlerts = await getActiveAlertsByBundle(bundleId);
    const triggeredAlerts: any[] = [];

    for (const alert of activeAlerts) {
      let shouldTrigger = false;

      switch (alert.alert_type) {
        case 'above':
          shouldTrigger = currentNav >= alert.threshold;
          break;
        case 'below':
          shouldTrigger = currentNav <= alert.threshold;
          break;
        case 'change_percent':
          shouldTrigger = Math.abs(navChangePercent) >= alert.threshold;
          break;
      }

      if (shouldTrigger) {
        const triggered = await triggerAlert(alert.id, currentNav);
        if (triggered) {
          triggeredAlerts.push({
            alert_id: triggered.id,
            wallet_address: triggered.wallet_address,
            alert_type: triggered.alert_type,
            threshold: triggered.threshold,
            current_nav: currentNav,
          });
        }
      }
    }

    res.json({
      bundle_id: bundleId,
      current_nav: currentNav,
      nav_change_percent: Math.round(navChangePercent * 100) / 100,
      alerts_checked: activeAlerts.length,
      alerts_triggered: triggeredAlerts.length,
      triggered: triggeredAlerts,
    });
  } catch (err) {
    console.error('POST /api/alerts/check/:bundleId error:', err);
    res.status(500).json({ error: 'Failed to check alerts' });
  }
});

/**
 * DELETE /api/alerts/:alertId
 * Delete a price alert.
 */
router.delete('/:alertId', async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const deleted = await deleteAlert(alertId);

    if (!deleted) {
      return res.status(404).json({ error: 'Alert not found or failed to delete' });
    }

    res.json({ deleted: true, alert_id: alertId });
  } catch (err) {
    console.error('DELETE /api/alerts/:alertId error:', err);
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

export const alertRoutes = router;
