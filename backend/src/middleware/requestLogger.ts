import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const start = Date.now();

  // Attach request ID to response header
  res.setHeader('X-Request-Id', requestId);

  // Log request arrival immediately (debug)
  console.log(`[${requestId}] -> ${req.method} ${req.path}`);

  // Log on response finish
  res.on('finish', () => {
    const duration = Date.now() - start;
    const log = `[${requestId}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`;
    if (res.statusCode >= 400) {
      console.warn(log);
    } else {
      console.log(log);
    }
  });

  next();
}
