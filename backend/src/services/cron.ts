/**
 * Scheduled background refresh jobs. Exports startCronJobs, which warms the
 * vault-price cache on boot and schedules a 2-minute task to refresh all active
 * bundles: pulls live NAV + Polymarket data, persists NAV snapshots, detects
 * newly resolved legs, fires price alerts, and records each run into metrics.
 */
import cron from 'node-cron';
import { getAllBundles, createNAVSnapshot, getActiveAlertsByBundle, triggerAlert } from '../db/queries';
import { getLiveNAV, checkAndUpdateResolutions, getVaultPrice, warmVaultPriceCache } from './pricing';
import { getPolymarketBasketNAVs } from './polymarket';
import { metrics } from './metrics';

// Per-bundle refresh lines are high-volume; gate them behind LOG_LEVEL=debug so
// production (Akash) logs stay clean. The cycle summary + startup lines below
// are always emitted.
const DEBUG_LOGS = process.env.LOG_LEVEL === 'debug';

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

    // Refresh each bundle independently. `polyNAVs` is fetched ONCE per cycle
    // above and reused here (no per-bundle re-hit of the Polymarket gamma API).
    // Promise.allSettled isolates failures so one bad bundle can't abort the
    // whole cycle, and the per-bundle work is returned (not mutated in place)
    // so the cycle totals are summed once at the end. Concurrency is bounded to
    // CONCURRENCY bundles at a time (processed in batches) so ~91 active bundles
    // can't fan out hundreds of simultaneous Sui+Gamma requests every 2 min.
    const CONCURRENCY = 6;
    const refreshBundle = async (
      bundle: typeof activeBundles[number],
    ): Promise<{ legsUpdated: number; newlyResolved: number }> => {
        let legsUpdated = 0;
        let newlyResolved = 0;
        try {
          // Vault price is the authoritative mint price — consistent with UI.
          const vaultPrice = await getVaultPrice(bundle.id);
          // Live Polymarket NAV — the weighted probability shown as 51.9% etc.
          const polyData = polyNAVs.get(bundle.name);

          // Still fetch live Polymarket probabilities so leg data stays fresh
          // for resolution detection and per-leg breakdown.
          const navResult = await getLiveNAV(bundle.id);
          if (navResult) {
            legsUpdated += navResult.legs.filter((l) => l.status === 'active').length;

            // Record the real leg-weighted NAV so history charts match every
            // other NAV surface (was persisting the flat vault par price 1.0).
            const snapshotNav = navResult.nav;
            await createNAVSnapshot(bundle.id, snapshotNav, navResult.legs);
            void vaultPrice;
            if (polyData && DEBUG_LOGS) {
              console.log(`[cron] ${bundle.name}: nav=${(snapshotNav * 100).toFixed(1)}% polymarket=${(polyData.nav * 100).toFixed(1)}% (${polyData.leg_count} legs)`);
            }
          }

          // Check for newly resolved legs
          const resolved = await checkAndUpdateResolutions(bundle.id);
          newlyResolved += resolved.length;

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
        return { legsUpdated, newlyResolved };
    };

    for (let i = 0; i < activeBundles.length; i += CONCURRENCY) {
      const batch = activeBundles.slice(i, i + CONCURRENCY);
      const perBundle = await Promise.allSettled(batch.map(refreshBundle));
      for (const r of perBundle) {
        if (r.status === 'fulfilled') {
          totalLegsUpdated += r.value.legsUpdated;
          totalNewlyResolved += r.value.newlyResolved;
        }
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
