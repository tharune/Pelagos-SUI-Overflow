import { Router, Request, Response } from 'express';
import {
  buildDistributionLaunchPlan,
  discoverDistributionCandidates,
  quoteDistributionCandidate,
} from '../services/distribution';

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

export const distributionRoutes = router;
