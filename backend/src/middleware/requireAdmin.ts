import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * Gate routes that sign with the OPERATOR key (SUI_PRIVATE_KEY) behind a shared
 * admin secret. These routes can move the operator float (e.g. PLP supply/
 * withdraw, operator-signed mint/redeem), so they must never be reachable by the
 * public. CORS is NOT a control here — a no-Origin request (curl, server-to-
 * server) bypasses the browser-origin check entirely.
 *
 * Behaviour:
 *  - ADMIN_API_KEY unset            -> 503, route hard-disabled (fail CLOSED).
 *  - key missing / wrong            -> 401.
 *  - key matches (constant-time)    -> next().
 *
 * Callers pass the key as `x-admin-key: <key>` or `Authorization: Bearer <key>`.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; guard first (length is not secret).
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    res.status(503).json({
      error: 'Admin route disabled. Set ADMIN_API_KEY in the backend env to enable operator-signed routes.',
    });
    return;
  }
  const provided =
    (req.header('x-admin-key') ?? '').trim() ||
    (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!provided || !constantTimeEqual(provided, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
