import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getModelManifest } from '../services/correlation';
import { metrics } from '../services/metrics';

/**
 * Routes for exposing the Pelagos correlation ML model deliverables.
 *
 * These read JSON artifacts from the repo-root `correlation-deliverables/`
 * folder (populated from the `ml-model` branch). No external calls  -  pure file I/O.
 */

const router = Router();

// Deliverables live two directories above the compiled backend output, so try
// a few candidate locations to cover dev (tsx) vs prod (dist) runs.
const CANDIDATE_ROOTS = [
  path.resolve(__dirname, '..', '..', '..', 'correlation-deliverables'),
  path.resolve(__dirname, '..', '..', 'correlation-deliverables'),
  path.resolve(process.cwd(), '..', 'correlation-deliverables'),
  path.resolve(process.cwd(), 'correlation-deliverables'),
];

function resolveDeliverablesRoot(): string | null {
  for (const dir of CANDIDATE_ROOTS) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return null;
}

function readJson(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * GET /api/ml/health
 * Returns whether the deliverables folder is present and summarizes what's available.
 */
router.get('/health', (_req: Request, res: Response) => {
  const root = resolveDeliverablesRoot();
  if (!root) {
    return res.status(503).json({
      status: 'missing',
      error: 'correlation-deliverables/ not found on disk',
      searched: CANDIDATE_ROOTS,
    });
  }
  const files = fs
    .readdirSync(root)
    .filter((f) => !f.startsWith('.'))
    .sort();
  res.json({
    status: 'ok',
    root,
    file_count: files.length,
    files,
  });
});

/**
 * GET /api/ml/metrics
 * Returns a curated summary of the final audit + walk-forward + Monte Carlo metrics.
 */
router.get('/metrics', (_req: Request, res: Response) => {
  const root = resolveDeliverablesRoot();
  if (!root) {
    return res.status(503).json({ error: 'deliverables folder missing' });
  }
  try {
    const summary = readJson(path.join(root, 'final_summary_step19.json')) as any;
    let walkforward: any = null;
    let monteCarlo: any = null;
    let modelMetrics: any = null;
    try {
      walkforward = readJson(path.join(root, 'walkforward_step16_metrics.json'));
    } catch {
      /* optional */
    }
    try {
      monteCarlo = readJson(path.join(root, 'monte_carlo_step14.json'));
    } catch {
      /* optional */
    }
    try {
      modelMetrics = readJson(path.join(root, 'model_metrics_step12.json'));
    } catch {
      /* optional */
    }

    res.json({
      model: 'pelagos-correlation',
      execution_status: summary.execution_status ?? 'unknown',
      all_checks_passed: summary.all_checks_passed ?? false,
      metrics: {
        classifier_precision: summary.classifier_precision,
        walkforward_mean_improvement: summary.walkforward_mean_improvement,
        walkforward_p_value: summary.walkforward_p_value,
        var_95: summary.var_95,
        var_99: summary.var_99,
        cvar_95: summary.cvar_95,
        cvar_99: summary.cvar_99,
      },
      artifacts: {
        summary,
        walkforward_step16: walkforward,
        monte_carlo_step14: monteCarlo,
        model_metrics_step12: modelMetrics,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to read ML deliverables',
      detail: err?.message ?? String(err),
    });
  }
});

/**
 * GET /api/ml/artifact/:name
 * Serve a specific JSON artifact by filename (e.g. monte_carlo_step14.json).
 * Restricted to .json files within the deliverables folder to prevent path traversal.
 */
router.get('/artifact/:name', (req: Request, res: Response) => {
  const root = resolveDeliverablesRoot();
  if (!root) {
    return res.status(503).json({ error: 'deliverables folder missing' });
  }
  const name = req.params.name;
  // Only allow safe filenames ending in .json
  if (!/^[a-zA-Z0-9_\-]+\.json$/.test(name)) {
    return res.status(400).json({ error: 'Invalid artifact name' });
  }
  const full = path.join(root, name);
  if (!full.startsWith(root) || !fs.existsSync(full)) {
    return res.status(404).json({ error: `Artifact not found: ${name}` });
  }
  try {
    res.json(readJson(full));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read artifact', detail: err?.message ?? String(err) });
  }
});

/**
 * GET /api/ml/manifest
 * Returns the runtime manifest of the correlation model (version, audited
 * thresholds, active guardrail tolerance, counters). This is what basket
 * creation uses - anyone can introspect the model that shaped a bundle.
 */
router.get('/manifest', (_req: Request, res: Response) => {
  res.json({
    ...getModelManifest(),
    counters: {
      bundles_scored: metrics.modelBundlesScored,
      bundles_accepted: metrics.modelBundlesAccepted,
      bundles_rejected: metrics.modelBundlesRejected,
      last_version: metrics.modelLastVersion,
      last_internal_corr: metrics.modelLastInternalCorr,
    },
    recent_events: metrics.getRecentModelEvents(10),
  });
});

export const mlRoutes = router;
