import { Router, Request, Response } from 'express';
import { buildSnapshot } from '../monitor/server';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const t0 = Date.now();
  const snapshot = await buildSnapshot();
  res.json({
    ...snapshot,
    meta: {
      ...snapshot.meta,
      generation_ms: Date.now() - t0,
    },
  });
});

export const metricsRoutes = router;
