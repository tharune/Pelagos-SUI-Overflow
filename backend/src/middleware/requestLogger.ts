import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// Per-request logging is high-volume. Gate the success/arrival lines behind
// LOG_LEVEL=debug so production (Akash) logs stay clean. Warnings for 4xx/5xx
// responses are always emitted — those are signal, not noise.
const DEBUG_LOGS = process.env.LOG_LEVEL === 'debug';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const start = Date.now();

  // Attach request ID to response header
  res.setHeader('X-Request-Id', requestId);

  // Log request arrival immediately (debug)
  if (DEBUG_LOGS) console.log(`[${requestId}] -> ${req.method} ${req.path}`);

  // Log on response finish
  res.on('finish', () => {
    const duration = Date.now() - start;
    const log = `[${requestId}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`;
    if (res.statusCode >= 400) {
      console.warn(log);
    } else if (DEBUG_LOGS) {
      console.log(log);
    }
  });

  next();
}
