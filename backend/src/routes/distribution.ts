import { Router, Request, Response } from 'express';
import {
  buildDistributionLaunchPlan,
  discoverDistributionCandidates,
  quoteDistributionCandidate,
} from '../services/distribution';
import {
  listContinuousMarkets,
  quoteContinuous,
  prepareContinuousOpen,
  confirmContinuousOpen,
  listContinuousPositions,
  settleContinuousPosition,
} from '../services/distribution-continuous';

const router = Router();

function numberQuery(req: Request, key: string): number | undefined {
  const value = req.query[key];
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function bodyNumber(req: Request, key: string): number {
  const n = Number(req.body?.[key]);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

function bodyWeights(req: Request): number[] {
  const raw = req.body?.weights;
  if (!Array.isArray(raw)) throw new Error('weights must be an array');
  return raw.map(Number);
}

function errorResponse(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : 'Unknown distribution market error';
  return res.status(400).json({ error: message });
}

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    product: 'distribution-markets',
    mode: 'dynamic-live-discovery',
    source: 'polymarket-gamma-and-clob',
  });
});

router.get('/candidates', async (req, res) => {
  try {
    const result = await discoverDistributionCandidates({
      limit: numberQuery(req, 'limit') ?? 12,
      minVolumeUsd: numberQuery(req, 'min_volume'),
      minDepthUsd: numberQuery(req, 'min_depth'),
      minDays: numberQuery(req, 'min_days'),
      maxDays: numberQuery(req, 'max_days'),
      forceRefresh: req.query.refresh === 'true',
    });
    res.json(result);
  } catch (err) {
    errorResponse(res, err);
  }
});

// Backward-compatible alias. This now returns live launch candidates, not
// hardcoded templates.
router.get('/templates', async (req, res) => {
  try {
    const result = await discoverDistributionCandidates({
      limit: numberQuery(req, 'limit') ?? 12,
      minVolumeUsd: numberQuery(req, 'min_volume'),
      minDepthUsd: numberQuery(req, 'min_depth'),
      minDays: numberQuery(req, 'min_days'),
      maxDays: numberQuery(req, 'max_days'),
      forceRefresh: req.query.refresh === 'true',
    });
    res.json({ ...result, templates: result.candidates });
  } catch (err) {
    errorResponse(res, err);
  }
});

router.post('/quote', async (req, res) => {
  try {
    const quote = await quoteDistributionCandidate({
      candidateId: String(req.body?.candidate_id ?? req.body?.market_id ?? ''),
      weights: bodyWeights(req),
      collateralUsdc: bodyNumber(req, 'collateral_usdc'),
    });
    res.json({ quote });
  } catch (err) {
    errorResponse(res, err);
  }
});

router.post('/launch-plan', async (req, res) => {
  try {
    const plan = await buildDistributionLaunchPlan(String(req.body?.candidate_id ?? ''));
    res.json({ plan });
  } catch (err) {
    errorResponse(res, err);
  }
});

// ---------------------------------------------------------------------------
// Continuous distribution markets (Normal mu/sigma, on-chain collateral)
// ---------------------------------------------------------------------------

router.get('/continuous/markets', (_req, res) => {
  res.json({ markets: listContinuousMarkets() });
});

router.post('/continuous/quote', (req, res) => {
  try {
    res.json(
      quoteContinuous({
        marketId: String(req.body?.market_id ?? ''),
        targetMu: bodyNumber(req, 'target_mu'),
        targetSigma: bodyNumber(req, 'target_sigma'),
        collateralUsdc: bodyNumber(req, 'collateral_usdc'),
      }),
    );
  } catch (err) {
    errorResponse(res, err);
  }
});

/** Build the real on-chain collateral deposit; the wallet signs `tx_bytes`. */
router.post('/continuous/open/prepare', async (req, res) => {
  try {
    const owner = String(req.body?.wallet_address ?? '');
    if (!/^0x[0-9a-fA-F]+$/.test(owner)) throw new Error('wallet_address (0x...) is required');
    res.json(
      await prepareContinuousOpen({
        owner,
        marketId: String(req.body?.market_id ?? ''),
        targetMu: bodyNumber(req, 'target_mu'),
        targetSigma: bodyNumber(req, 'target_sigma'),
        collateralUsdc: bodyNumber(req, 'collateral_usdc'),
      }),
    );
  } catch (err) {
    errorResponse(res, err);
  }
});

/** Record the position after the wallet executed the on-chain escrow. */
router.post('/continuous/open/confirm', async (req, res) => {
  try {
    const owner = String(req.body?.wallet_address ?? '');
    if (!/^0x[0-9a-fA-F]+$/.test(owner)) throw new Error('wallet_address (0x...) is required');
    const digest = String(req.body?.signature ?? req.body?.digest ?? '');
    if (!digest) throw new Error('signature (tx digest) is required');
    const position = await confirmContinuousOpen({
      owner,
      marketId: String(req.body?.market_id ?? ''),
      targetMu: bodyNumber(req, 'target_mu'),
      targetSigma: bodyNumber(req, 'target_sigma'),
      collateralUsdc: bodyNumber(req, 'collateral_usdc'),
      digest,
    });
    res.json({ confirmed: true, position });
  } catch (err) {
    errorResponse(res, err);
  }
});

/** Settle a position: the protocol pays the realized net (g(x*)-f(x*)) on-chain. */
router.post('/continuous/settle', async (req, res) => {
  try {
    const owner = String(req.body?.wallet_address ?? '');
    if (!/^0x[0-9a-fA-F]+$/.test(owner)) throw new Error('wallet_address (0x...) is required');
    const positionId = String(req.body?.position_id ?? '');
    if (!positionId) throw new Error('position_id is required');
    res.json(await settleContinuousPosition({ owner, positionId }));
  } catch (err) {
    errorResponse(res, err);
  }
});

router.get('/continuous/positions/:owner', (req, res) => {
  try {
    res.json({ positions: listContinuousPositions(req.params.owner) });
  } catch (err) {
    errorResponse(res, err);
  }
});

export const distributionRoutes = router;
