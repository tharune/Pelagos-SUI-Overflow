/**
 * Pelagos backend entrypoint — an Express API (default port 13101) that mounts
 * the product route groups: live pricing off DeepBook Predict, non-custodial
 * on-chain transaction prepare/confirm (predict / vault / deposit / sim rails),
 * Polymarket + DeFiLlama data feeds, and health/metrics. Wallets sign every
 * mutation; the backend never custodies funds.
 */
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { proxiedFetch } from './services/proxy';
import { bundleRoutes } from './routes/bundles';
import { basketRoutes } from './routes/baskets';
import { depositRoutes } from './routes/deposit';
import { marketRoutes } from './routes/markets';
import { docsRoutes } from './routes/docs';
import { ppnRoutes } from './routes/ppn';
import { metricsRoutes } from './routes/metrics';
import { lendingRoutes } from './routes/lending';
import { warmLendingRate } from './services/lending';
import mmRoutes from './routes/mm';
import { devRoutes } from './routes/dev';
import { predictRoutes } from './routes/predict';
import { volRoutes } from './routes/vol';
import { distributionRoutes } from './routes/distribution';
// New dual-mode product engines
import { optionsRoutes } from './routes/options';
import { customBasketRoutes } from './routes/custom-basket';
import { deepbookRoutes } from './routes/deepbook';
import { simRoutes } from './routes/sim';
import { notesRoutes } from './routes/notes';
import { metricsMiddleware } from './services/metrics';
import { startMonitorServer } from './monitor/server';
import { startCronJobs } from './services/cron';
import { supabase } from './db/supabase';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler } from './middleware/errorHandler';
import { requireAdmin } from './middleware/requireAdmin';

const app = express();

// Behind Akash ingress (a single reverse proxy), req.ip must resolve from the
// first X-Forwarded-For hop — otherwise every user shares one IP bucket in the
// rate limiters and express-rate-limit v7 emits a ValidationError. One hop is
// correct for a single trusted proxy. Set before the limiters/routes mount.
app.set('trust proxy', 1);

// CORS
// FRONTEND_URL may be a single origin ("http://localhost:13100") or a
// comma-separated list ("http://localhost:13100,http://localhost:3003").
// An unset value falls back to "*" so standalone API testing still works.
// Treat localhost and 127.0.0.1 as the same dev host. Next serves the dev
// frontend on 127.0.0.1, but FRONTEND_URL is usually written as localhost (or
// vice versa); without this, the browser's Origin wouldn't match the allowlist
// and every cross-origin fetch fails with "Failed to fetch".
const expandLoopback = (origins: string[]): string[] => {
  const out = new Set<string>();
  for (const o of origins) {
    out.add(o);
    if (o.includes('//localhost')) out.add(o.replace('//localhost', '//127.0.0.1'));
    else if (o.includes('//127.0.0.1')) out.add(o.replace('//127.0.0.1', '//localhost'));
  }
  return [...out];
};
const frontendOrigins = expandLoopback(
  (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
// A single reflecting callback (never the literal '*', which is invalid with
// credentials:true). Allows: no-Origin (curl/server-to-server), any configured
// FRONTEND_URL, every Vercel deploy (*.vercel.app — covers preview + prod), and
// localhost/127.0.0.1 for dev. Reflecting the request origin keeps credentials
// working where '*' would be rejected by the browser.
const VERCEL_HOST = /(^|\.)vercel\.app$/;
const corsOrigin: cors.CorsOptions['origin'] = (origin, cb) => {
  if (!origin) return cb(null, true);
  if (frontendOrigins.includes(origin)) return cb(null, true);
  try {
    const host = new URL(origin).hostname;
    if (VERCEL_HOST.test(host) || host === 'localhost' || host === '127.0.0.1') {
      return cb(null, true);
    }
  } catch {
    /* malformed Origin header — fall through to reject */
  }
  return cb(new Error(`CORS: origin ${origin} not allowed`));
};
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// NOTE: app.options('*', cors()) removed  -  Express 4.22 path-to-regexp rejects the bare '*' pattern.
// cors() middleware above still handles preflight automatically.

app.use(express.json());

// Catch malformed JSON bodies  -  express.json() throws SyntaxError via next(err);
// surface as 400 Bad Request instead of falling through to the 500 handler.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'status' in err && (err as { status?: number }).status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body', detail: (err as Error).message });
  }
  return next(err);
});

// Request logging + metrics collection
app.use(requestLogger);
app.use(metricsMiddleware);

// Rate limiting: 300 req/min per IP (general). Raised from 100 so a busy page
// (orderbooks + vault prices + balance polling across product tabs) can't 429
// the wallet-balance fetch and make it read $0.
// express-rate-limit@^7.5.0 is fully compatible with Express 4 (v8 hangs on localhost).
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
if (process.env.DISABLE_RATE_LIMIT !== 'true') {
  app.use(generalLimiter);
}

// Stricter rate limit for Polymarket proxy: 30 req/min per IP
const marketLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many market requests, please try again later' },
});

// Health check
app.get('/api/health', async (_req, res) => {
  const services: {
    supabase: { status: 'ok' | 'error' | 'not_configured'; latency_ms: number; error?: string };
    polymarket: { status: 'ok' | 'error'; latency_ms: number; error?: string };
  } = {
    supabase: { status: 'ok', latency_ms: 0 },
    polymarket: { status: 'ok', latency_ms: 0 },
  };

  let overall: 'ok' | 'degraded' = 'ok';

  // Check Supabase (skip probe when placeholder  -  avoids 7s timeout)
  if (!config.supabaseConfigured) {
    services.supabase.status = 'not_configured';
    services.supabase.error = 'Placeholder credentials  -  set SUPABASE_URL and SUPABASE_ANON_KEY';
    // Local Sui mode intentionally runs without Supabase; execution state
    // comes from Sui testnet objects and the browser-local product ledger.
    if (!process.env.SUI_PACKAGE_ID) overall = 'degraded';
  } else {
    try {
      const start = Date.now();
      const { error } = await supabase.from('bundles').select('id').limit(1);
      services.supabase.latency_ms = Date.now() - start;
      if (error) {
        services.supabase.status = 'error';
        services.supabase.error = error.message;
        overall = 'degraded';
      }
    } catch (err: unknown) {
      services.supabase.status = 'error';
      services.supabase.error = err instanceof Error ? err.message : 'Unknown error';
      overall = 'degraded';
    }
  }

  // Check Polymarket API
  try {
    const start = Date.now();
    const resp = await proxiedFetch('https://gamma-api.polymarket.com/markets?limit=1');
    services.polymarket.latency_ms = Date.now() - start;
    if (!resp.ok) {
      services.polymarket.status = 'error';
      services.polymarket.error = `HTTP ${resp.status}`;
      overall = 'degraded';
    }
  } catch (err: unknown) {
    services.polymarket.status = 'error';
    services.polymarket.error = err instanceof Error ? err.message : 'Unknown error';
    overall = 'degraded';
  }

  res.json({
    status: overall,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
    services,
  });
});

// Routes
app.use('/api/bundles', bundleRoutes);
app.use('/api/baskets', basketRoutes);
app.use('/api/options', optionsRoutes);
app.use('/api/custom-baskets', customBasketRoutes);
app.use('/api/deepbook', deepbookRoutes);
app.use('/api/sim', simRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/deposit', depositRoutes);
app.use('/api/markets', marketLimiter, marketRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/ppn', ppnRoutes);
// Operational snapshot (operator address, balances, admin caps, request log) is
// admin-only — never expose it publicly. Internal monitor server (MONITOR_PORT)
// is unaffected.
app.use('/api/metrics', requireAdmin, metricsRoutes);
app.use('/api/lending', lendingRoutes);
app.use('/api/dev', devRoutes);
app.use('/api/predict', predictRoutes);
app.use('/api/vol', volRoutes);
app.use('/api/distribution', distributionRoutes);
app.use('/api/mm', mmRoutes);

// Root redirect to API docs
app.get('/', (_req, res) => res.redirect('/api/docs'));

// Global error handler (must be after all routes)
app.use(errorHandler);

// Last-resort safety net for the public surface: log, never crash silently, on an
// unhandled async error. Every fire-and-forget callsite is individually guarded;
// this is defense-in-depth. Pair with the platform restart policy + /api/health.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

app.listen(config.port, () => {
  console.log(`Pelagos backend running on port ${config.port}`);
  startCronJobs();
  startMonitorServer();
  // Warm the live Sui USDC lending rate so the first /api/lending is already live.
  void warmLendingRate().catch(() => {});
});

export default app;
