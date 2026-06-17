import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { proxiedFetch } from './services/proxy';
import { bundleRoutes } from './routes/bundles';
import { navRoutes } from './routes/nav';
import { depositRoutes } from './routes/deposit';
import { marketRoutes } from './routes/markets';
import { sseRoutes } from './routes/sse';
import { docsRoutes } from './routes/docs';
import { adminRoutes } from './routes/admin';
import { leaderboardRoutes } from './routes/leaderboard';
import { demoRoutes } from './routes/demo';
import { webhookRoutes } from './routes/webhook';
import { batchRoutes } from './routes/batch';
import { ppnRoutes } from './routes/ppn';
import { alertRoutes } from './routes/alerts';
import { mlRoutes } from './routes/ml';
import { onchainRoutes } from './routes/onchain';
import { metricsRoutes } from './routes/metrics';
import { lendingRoutes } from './routes/lending';
import { warmLendingRate } from './services/lending';
import { hedgeRoutes } from './routes/hedge';
import portfolioRoutes from './routes/portfolio';
import vaultRoutes from './routes/vaults';
import mmRoutes from './routes/mm';
import { devRoutes } from './routes/dev';
import { suiRoutes } from './routes/sui';
import { predictRoutes } from './routes/predict';
import { volRoutes } from './routes/vol';
import { distributionRoutes } from './routes/distribution';
import { metricsMiddleware } from './services/metrics';
import { startMonitorServer } from './monitor/server';
import { startCronJobs } from './services/cron';
import { supabase } from './db/supabase';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler } from './middleware/errorHandler';

const app = express();

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
const corsOrigin: cors.CorsOptions['origin'] =
  frontendOrigins.length === 0
    ? '*'
    : frontendOrigins.length === 1
      ? frontendOrigins[0]
      : (origin, cb) => {
          // Allow same-origin / curl / server-to-server (no Origin header).
          if (!origin) return cb(null, true);
          if (frontendOrigins.includes(origin)) return cb(null, true);
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

// AI portfolio composer: 10 req/min per IP (Anthropic API calls are expensive)
const portfolioLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many portfolio requests, please try again later' },
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
app.use('/api/nav', navRoutes);
app.use('/api/deposit', depositRoutes);
app.use('/api/markets', marketLimiter, marketRoutes);
app.use('/api/sse', sseRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/demo', demoRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/batch', batchRoutes);
app.use('/api/ppn', ppnRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/ml', mlRoutes);
app.use('/api/onchain', onchainRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/lending', lendingRoutes);
app.use('/api/hedge', hedgeRoutes);
app.use('/api/vaults', vaultRoutes);
app.use('/api/portfolio', portfolioLimiter, portfolioRoutes);
app.use('/api/dev', devRoutes);
app.use('/api/sui', suiRoutes);
app.use('/api/predict', predictRoutes);
app.use('/api/vol', volRoutes);
app.use('/api/distribution', distributionRoutes);
app.use('/api/mm', mmRoutes);

// Root redirect to API docs
app.get('/', (_req, res) => res.redirect('/api/docs'));

// Global error handler (must be after all routes)
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Pelagos backend running on port ${config.port}`);
  startCronJobs();
  startMonitorServer();
  // Warm the live Sui USDC lending rate so the first /api/lending is already live.
  void warmLendingRate().catch(() => {});
});

export default app;
