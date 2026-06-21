/**
 * mUSDC simulation-settlement routes (/api/sim).
 *
 * An INDEPENDENT settlement rail from dUSDC/Predict: structured positions settle
 * against our own freely-mintable mUSDC (`mock_usdc`) + generic `Vault<MOCK_USDC>`.
 * No swap, no peg to dUSDC. See services/sim-settlement.ts.
 *
 *   POST /open/prepare  — build the user-signed mUSDC premium deposit (labelled).
 *   POST /confirm       — mark the position open once the deposit confirms.
 *   POST /settle        — compute the realized payoff and mint it in mUSDC.
 *   GET  /positions/:owner — list a wallet's sim positions.
 */
import { Router, Request, Response } from 'express';
import {
  prepareSimOpen,
  confirmSimOpen,
  settleSim,
  listSimPositions,
  type SimProduct,
  type SimBand,
} from '../services/sim-settlement';

const router = Router();

const PRODUCTS: SimProduct[] = ['strip', 'option', 'vol', 'dist'];

function parseBands(v: unknown): SimBand[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      return {
        lower_usd: Number(o.lower_usd),
        higher_usd: Number(o.higher_usd),
        payout_usd: Number(o.payout_usd),
      };
    })
    .filter(
      (b) => Number.isFinite(b.lower_usd) && Number.isFinite(b.higher_usd) && Number.isFinite(b.payout_usd),
    );
}

router.post('/open/prepare', async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const owner = String(b.owner ?? b.wallet_address ?? '');
    if (!/^0x[0-9a-fA-F]+$/.test(owner)) throw new Error('owner (0x...) is required');
    const product = (PRODUCTS.includes(b.product as SimProduct) ? b.product : 'strip') as SimProduct;
    const premiumUsd = Number(b.premium_usd ?? b.notional_usd ?? 0);
    if (!(premiumUsd > 0) || !Number.isFinite(premiumUsd)) throw new Error('premium_usd must be a positive number');
    const maxPayoutUsd = Number(b.max_payout_usd ?? premiumUsd);
    if (!Number.isFinite(maxPayoutUsd) || maxPayoutUsd <= 0) throw new Error('max_payout_usd must be a positive number');
    const forwardUsd = Number(b.forward_usd ?? 0);
    if (!Number.isFinite(forwardUsd) || forwardUsd < 0) throw new Error('forward_usd must be a non-negative number');
    const out = await prepareSimOpen({
      owner,
      product,
      name: typeof b.name === 'string' ? b.name : product,
      premium_usd: premiumUsd,
      max_payout_usd: maxPayoutUsd,
      oracle_id: typeof b.oracle_id === 'string' ? b.oracle_id : null,
      forward_usd: forwardUsd,
      expiry_ms: b.expiry_ms != null ? Number(b.expiry_ms) : null,
      bands: parseBands(b.bands),
    });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const simId = String(b.sim_id ?? '');
    const digest = String(b.digest ?? '');
    if (!simId || !digest) throw new Error('sim_id and digest are required');
    res.json(await confirmSimOpen(simId, digest));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/settle', async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const simId = String(b.sim_id ?? '');
    if (!simId) throw new Error('sim_id is required');
    res.json(await settleSim(simId));
  } catch (err) {
    // Client-actionable errors (bad/stale id, validation) → 4xx; reserve 500 for
    // genuine on-chain/RPC failures.
    const msg = (err as Error).message;
    if (/unknown sim position/i.test(msg)) return res.status(404).json({ error: msg });
    if (/required|invalid|non-finite|must be/i.test(msg)) return res.status(400).json({ error: msg });
    res.status(500).json({ error: msg });
  }
});

router.get('/positions/:owner', async (req: Request, res: Response) => {
  try {
    res.json({ positions: await listSimPositions(req.params.owner) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export const simRoutes = router;
