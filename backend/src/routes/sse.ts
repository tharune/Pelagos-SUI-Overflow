import { Router, Request, Response } from 'express';
import { getLiveNAV } from '../services/pricing';
import { getAllBundles, getPositionsByWallet, getLegsByBundleId } from '../db/queries';
import { calculateNAV } from '../services/nav';

const router = Router();

const NAV_INTERVAL_MS = 30_000; // 30 seconds
const BUNDLE_DASHBOARD_INTERVAL_MS = 60_000; // 60 seconds
const HEARTBEAT_INTERVAL_MS = 15_000; // 15 seconds

/**
 * GET /api/sse/nav/:bundleId
 * Server-Sent Events stream for live NAV updates.
 * Sends initial NAV immediately, then refreshes every 30 seconds.
 * Heartbeat every 15 seconds to keep connections alive through proxies.
 */
router.get('/nav/:bundleId', async (req: Request, res: Response) => {
  const { bundleId } = req.params;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Tell clients to auto-reconnect after 5 seconds
  res.write('retry: 5000\n\n');

  const sendNAV = async () => {
    try {
      const navResult = await getLiveNAV(bundleId);
      if (navResult) {
        const payload = {
          nav: navResult.nav,
          legs: navResult.legs,
          timestamp: navResult.timestamp,
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } else {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'NAV not available for this bundle' })}\n\n`);
      }
    } catch (err) {
      console.error(`SSE nav error for bundle ${bundleId}:`, err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Failed to fetch NAV' })}\n\n`);
    }
  };

  // Send initial NAV immediately
  await sendNAV();

  // Then refresh every 30 seconds
  const navInterval = setInterval(sendNAV, NAV_INTERVAL_MS);

  // Heartbeat to keep connection alive through proxies
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(navInterval);
    clearInterval(heartbeatInterval);
    res.end();
  });
});

/**
 * GET /api/sse/portfolio/:walletAddress
 * Server-Sent Events stream for portfolio value updates.
 * Recalculates all positions for the wallet every 30 seconds.
 * Heartbeat every 15 seconds to keep connections alive through proxies.
 */
router.get('/portfolio/:walletAddress', async (req: Request, res: Response) => {
  const { walletAddress } = req.params;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Tell clients to auto-reconnect after 5 seconds
  res.write('retry: 5000\n\n');

  const sendPortfolio = async () => {
    try {
      const positions = await getPositionsByWallet(walletAddress);

      // Calculate current value for each position
      const positionValues = await Promise.allSettled(
        positions.map(async (pos) => {
          const navResult = await getLiveNAV(pos.bundle_id);
          const currentNav = navResult?.nav ?? 0;
          const currentValue = pos.tokens_held * currentNav;
          const pnl = currentValue - pos.deposited_usdc;

          return {
            bundle_id: pos.bundle_id,
            tokens_held: pos.tokens_held,
            entry_price: pos.entry_price,
            deposited_usdc: pos.deposited_usdc,
            current_nav: currentNav,
            current_value: currentValue,
            pnl,
          };
        })
      );

      const resolved = positionValues
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .map((r) => r.value);

      const totalDeposited = resolved.reduce((sum, p) => sum + p.deposited_usdc, 0);
      const totalCurrentValue = resolved.reduce((sum, p) => sum + p.current_value, 0);
      const totalPnl = totalCurrentValue - totalDeposited;

      const payload = {
        wallet_address: walletAddress,
        positions: resolved,
        total_deposited: totalDeposited,
        total_current_value: totalCurrentValue,
        total_pnl: totalPnl,
        timestamp: new Date().toISOString(),
      };

      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      console.error(`SSE portfolio error for wallet ${walletAddress}:`, err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Failed to fetch portfolio' })}\n\n`);
    }
  };

  // Send initial portfolio immediately
  await sendPortfolio();

  // Then refresh every 30 seconds
  const portfolioInterval = setInterval(sendPortfolio, NAV_INTERVAL_MS);

  // Heartbeat to keep connection alive through proxies
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(portfolioInterval);
    clearInterval(heartbeatInterval);
    res.end();
  });
});

/**
 * GET /api/sse/bundles
 * Server-Sent Events stream for all active bundles with NAV updates.
 * Sends initial snapshot immediately, then refreshes every 60 seconds.
 * Heartbeat every 15 seconds to keep connections alive through proxies.
 */
router.get('/bundles', async (req: Request, res: Response) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Tell clients to auto-reconnect after 5 seconds
  res.write('retry: 5000\n\n');

  const sendBundles = async () => {
    try {
      const allBundles = await getAllBundles();
      const activeBundles = allBundles.filter((b) => b.status === 'active');

      const enriched = await Promise.all(
        activeBundles.map(async (bundle) => {
          const navResult = await getLiveNAV(bundle.id);
          const currentNav = navResult?.nav ?? 0;
          const legs = await getLegsByBundleId(bundle.id);
          const activeLegs = legs.filter((l) => l.status === 'active');
          const avgProbability = activeLegs.length > 0
            ? activeLegs.reduce((sum, l) => sum + l.probability, 0) / activeLegs.length
            : 0;

          const navChangePercent = bundle.issue_price > 0
            ? ((currentNav - bundle.issue_price) / bundle.issue_price) * 100
            : 0;

          return {
            id: bundle.id,
            name: bundle.name,
            risk_tier: bundle.risk_tier,
            status: bundle.status,
            issue_price: bundle.issue_price,
            current_nav: Math.round(currentNav * 10000) / 10000,
            nav_change_percent: Math.round(navChangePercent * 100) / 100,
            num_legs: legs.length,
            resolved_legs: legs.filter((l) => l.status !== 'active').length,
            avg_probability: Math.round(avgProbability * 10000) / 10000,
          };
        })
      );

      const payload = {
        count: enriched.length,
        bundles: enriched,
        timestamp: new Date().toISOString(),
      };

      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      console.error('SSE bundles error:', err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Failed to fetch bundles' })}\n\n`);
    }
  };

  // Send initial snapshot immediately
  await sendBundles();

  // Then refresh every 60 seconds
  const bundlesInterval = setInterval(sendBundles, BUNDLE_DASHBOARD_INTERVAL_MS);

  // Heartbeat to keep connection alive through proxies
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(bundlesInterval);
    clearInterval(heartbeatInterval);
    res.end();
  });
});

export const sseRoutes = router;
