import cron from 'node-cron';
import { getAllBundles, createNAVSnapshot, getActiveAlertsByBundle, triggerAlert } from '../db/queries';
import { getLiveNAV, checkAndUpdateResolutions, getVaultPrice, warmVaultPriceCache } from './pricing';
import { getPolymarketBasketNAVs } from './polymarket';
import { metrics } from './metrics';

/**
 * Refresh probabilities for all active bundles.
 * Fetches live Polymarket data, updates DB, and checks for resolutions.
 */
async function refreshAllBundles(): Promise<void> {
  const startTime = Date.now();
  let cronOk = true;
  let cronError: string | undefined;
  let activeBundlesCount = 0;
  let totalLegsUpdated = 0;
  let totalNewlyResolved = 0;

  try {
    const [bundles, polyNAVs] = await Promise.all([
      getAllBundles(),
      getPolymarketBasketNAVs(),
    ]);
    const activeBundles = bundles.filter((b) => b.status === 'active');
    activeBundlesCount = activeBundles.length;

    for (const bundle of activeBundles) {
      try {
        // Vault price is the authoritative mint price — consistent with UI.
        const vaultPrice = await getVaultPrice(bundle.id);
        // Live Polymarket NAV — the weighted probability shown as 51.9% etc.
        const polyData = polyNAVs.get(bundle.name);

        // Still fetch live Polymarket probabilities so leg data stays fresh
        // for resolution detection and per-leg breakdown.
        const navResult = await getLiveNAV(bundle.id);
        if (navResult) {
          totalLegsUpdated += navResult.legs.filter((l) => l.status === 'active').length;

          // Record NAV snapshot using vault price so history charts reflect
          // the same mint price shown in the UI. The polymarket_nav is
          // logged for observability but not persisted (UI computes it live).
          const snapshotNav = vaultPrice?.issue_price ?? navResult.nav;
          await createNAVSnapshot(bundle.id, snapshotNav, navResult.legs);
          if (polyData) {
            console.log(`[cron] ${bundle.name}: vault=$${snapshotNav.toFixed(3)} polymarket=${(polyData.nav * 100).toFixed(1)}% (${polyData.leg_count} legs)`);
          }
        }

        // Check for newly resolved legs
        const resolved = await checkAndUpdateResolutions(bundle.id);
        totalNewlyResolved += resolved.length;

        // Check price alerts for this bundle
        if (navResult) {
          try {
            const alerts = await getActiveAlertsByBundle(bundle.id);
            const navChangePercent = bundle.issue_price > 0
              ? ((navResult.nav - bundle.issue_price) / bundle.issue_price) * 100
              : 0;

            for (const alert of alerts) {
              let shouldTrigger = false;
              if (alert.alert_type === 'above' && navResult.nav >= alert.threshold) shouldTrigger = true;
              if (alert.alert_type === 'below' && navResult.nav <= alert.threshold) shouldTrigger = true;
              if (alert.alert_type === 'change_percent' && Math.abs(navChangePercent) >= alert.threshold) shouldTrigger = true;

              if (shouldTrigger) {
                await triggerAlert(alert.id, navResult.nav);
              }
            }
          } catch (alertErr) {
            // Alert checking is non-critical, don't fail the cron
          }
        }
      } catch (err) {
        console.error(`Cron: failed to refresh bundle ${bundle.id} (${bundle.name}):`, err);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[cron] Refreshed ${activeBundlesCount} bundles, ${totalLegsUpdated} legs updated, ${totalNewlyResolved} newly resolved (${elapsed}ms)`
    );
  } catch (err) {
    cronOk = false;
    cronError = err instanceof Error ? err.message : String(err);
    console.error('[cron] refreshAllBundles failed:', err);
  } finally {
    metrics.recordCron({
      timestamp: Date.now(),
      duration_ms: Date.now() - startTime,
      bundles_refreshed: activeBundlesCount,
      legs_updated: totalLegsUpdated,
      newly_resolved: totalNewlyResolved,
      ok: cronOk,
      error: cronError,
    });
  }
}

/**
 * Start all cron jobs. Call once after server starts.
 */
export function startCronJobs(): void {
  // Warm vault-price cache on startup so first requests get instant prices.
  warmVaultPriceCache().then((prices) => {
    console.log(`[cron] Vault price cache warmed — ${prices.size} vaults loaded`);
  }).catch(() => {});

  // Every 2 minutes: refresh all active bundle probabilities
  cron.schedule('*/2 * * * *', async () => {
    console.log('[cron] Starting bundle refresh...');
    await refreshAllBundles();
  });

  console.log('[cron] Price refresh cron scheduled (every 2 minutes)');
}
