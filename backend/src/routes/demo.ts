import { Router, Request, Response } from 'express';
import {
  getAllBundles,
  getBundleWithLegs,
  createPosition,
  createTransaction,
  getPositionsByWalletAndBundle,
} from '../db/queries';
import { getLiveNAV, getIssuePriceForBundle } from '../services/pricing';
import { config } from '../config';

const router = Router();

const DEFAULT_DEMO_WALLET = 'demo-wallet-001';
const DEFAULT_AMOUNT = 100;

/**
 * POST /api/demo/simulate-lifecycle
 * Runs a full product lifecycle simulation in one call for hackathon demos.
 */
router.post('/simulate-lifecycle', async (req: Request, res: Response) => {
  try {
    const {
      bundle_id,
      wallet_address = DEFAULT_DEMO_WALLET,
      amount_usdc = DEFAULT_AMOUNT,
    } = req.body || {};

    // Step 1: Pick a bundle
    let targetBundleId = bundle_id;

    if (!targetBundleId) {
      const allBundles = await getAllBundles();
      const activeBundles = allBundles.filter((b) => b.status === 'active');

      if (activeBundles.length === 0) {
        return res.status(404).json({
          error: 'No active bundles found. Create a bundle first via POST /api/bundles',
        });
      }

      // Pick a random active bundle
      const randomIndex = Math.floor(Math.random() * activeBundles.length);
      targetBundleId = activeBundles[randomIndex].id;
    }

    const bundleWithLegs = await getBundleWithLegs(targetBundleId);
    if (!bundleWithLegs) {
      return res.status(404).json({ error: `Bundle not found: ${targetBundleId}` });
    }

    if (bundleWithLegs.status !== 'active') {
      return res.status(400).json({
        error: `Bundle is not active (status: ${bundleWithLegs.status})`,
      });
    }

    // Step 2: Simulate deposit (same logic as deposit route)
    const issuePrice = await getIssuePriceForBundle(targetBundleId);
    if (!issuePrice || issuePrice <= 0) {
      return res.status(500).json({ error: 'Unable to determine issue price' });
    }

    const feeUsdc = amount_usdc * config.structuringFee;
    const netUsdc = amount_usdc - feeUsdc;
    const tokensMinted = netUsdc / issuePrice;

    const position = await createPosition({
      bundle_id: targetBundleId,
      wallet_address: wallet_address,
      tokens_held: tokensMinted,
      entry_price: issuePrice,
      deposited_usdc: amount_usdc,
    });

    if (!position) {
      return res.status(500).json({ error: 'Failed to create demo position' });
    }

    const transaction = await createTransaction({
      bundle_id: targetBundleId,
      wallet_address: wallet_address,
      type: 'deposit',
      amount_usdc,
      tokens: tokensMinted,
      fee_usdc: feeUsdc,
    });

    if (!transaction) {
      return res.status(500).json({ error: 'Failed to create demo transaction' });
    }

    // Step 3: Get current NAV
    const navResult = await getLiveNAV(targetBundleId);

    // Step 4: Portfolio snapshot
    const positions = await getPositionsByWalletAndBundle(wallet_address, targetBundleId);
    const currentNav = navResult?.nav ?? issuePrice;
    const totalTokens = positions.reduce((sum, p) => sum + p.tokens_held, 0);
    const totalDeposited = positions.reduce((sum, p) => sum + p.deposited_usdc, 0);
    const currentValue = totalTokens * currentNav;
    const unrealizedPnl = currentValue - totalDeposited;

    res.status(201).json({
      demo: true,
      lifecycle: {
        step_1_bundle: bundleWithLegs,
        step_2_deposit: {
          transaction_id: transaction.id,
          bundle_id: targetBundleId,
          wallet_address,
          amount_usdc,
          fee_usdc: feeUsdc,
          net_usdc: netUsdc,
          tokens_minted: tokensMinted,
          issue_price: issuePrice,
        },
        step_3_nav: navResult,
        step_4_portfolio: {
          wallet_address,
          bundle_id: targetBundleId,
          total_tokens: totalTokens,
          total_deposited: totalDeposited,
          current_nav: currentNav,
          current_value: currentValue,
          unrealized_pnl: unrealizedPnl,
          pnl_percent: totalDeposited > 0
            ? (unrealizedPnl / totalDeposited) * 100
            : 0,
          position_count: positions.length,
        },
      },
      message:
        'Demo lifecycle complete. In production: tokens mint on Sui, NAV updates in real-time via SSE, redemption happens when all legs resolve.',
    });
  } catch (err) {
    console.error('POST /api/demo/simulate-lifecycle error:', err);
    res.status(500).json({ error: 'Failed to simulate lifecycle' });
  }
});

/**
 * GET /api/demo/status
 * Returns what demo data exists and how to use the demo endpoints.
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const allBundles = await getAllBundles();
    const activeBundles = allBundles.filter((b) => b.status === 'active');

    res.json({
      demo_wallet: DEFAULT_DEMO_WALLET,
      note: 'Use POST /api/demo/simulate-lifecycle to run a full demo',
      active_bundles: activeBundles.length,
      total_bundles: allBundles.length,
    });
  } catch (err) {
    console.error('GET /api/demo/status error:', err);
    res.status(500).json({ error: 'Failed to fetch demo status' });
  }
});

export const demoRoutes = router;
