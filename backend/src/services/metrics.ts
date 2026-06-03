import type { Request, Response, NextFunction } from 'express';

/**
 * In-memory protocol metrics collector for the /api/metrics endpoint.
 *
 * This powers the /monitor dashboard. No external deps, no persistence. Ring
 * buffers retain enough history for a minute-scale view of traffic and errors.
 */

export interface RequestSample {
  timestamp: number;     // ms since epoch when the response finished
  method: string;
  path: string;
  status: number;
  duration_ms: number;
}

export interface CronRun {
  timestamp: number;
  duration_ms: number;
  bundles_refreshed: number;
  legs_updated: number;
  newly_resolved: number;
  ok: boolean;
  error?: string;
}

const MAX_REQUEST_SAMPLES = 500;
const MAX_CRON_SAMPLES = 60;

export interface ModelUsageEvent {
  timestamp: number;
  bundle_name: string;
  leg_count: number;
  internal_corr: number;
  cvar_99_projected: number;
  accepted: boolean;
  reason?: string;
  model_version: string;
}

/**
 * A single market-filter run (e.g. one GET /api/markets/curated, one bundle
 * leg gate). Aggregated into the funnel counters below.
 */
export interface FilterRunEvent {
  timestamp: number;
  source: 'curated_list' | 'bundle_gate' | 'manual';
  input_count: number;
  kept_count: number;
  rejected_count: number;
  per_stage: {
    liquidity_floor: { entered: number; rejected: number };
    quality_nlp: { entered: number; rejected: number };
    time_window: { entered: number; rejected: number };
    category_classify: { entered: number; rejected: number };
    diversity_prefilter: { entered: number; rejected: number };
  };
}

class MetricsStore {
  readonly startTime = Date.now();

  // Request counters
  requestsTotal = 0;
  requests2xx = 0;
  requests3xx = 0;
  requests4xx = 0;
  requests5xx = 0;

  // Model-usage counters
  modelBundlesScored = 0;
  modelBundlesAccepted = 0;
  modelBundlesRejected = 0;
  modelLastVersion: string | null = null;
  modelLastInternalCorr: number | null = null;

  // Market-filter funnel counters (lifetime totals across all runs)
  filterRunsTotal = 0;
  filterMarketsSeen = 0;
  filterMarketsKept = 0;
  filterMarketsRejected = 0;
  filterStageRejected = {
    liquidity_floor: 0,
    quality_nlp: 0,
    time_window: 0,
    category_classify: 0,
    diversity_prefilter: 0,
  };

  // Ring buffers
  private requests: RequestSample[] = [];
  private crons: CronRun[] = [];
  private modelEvents: ModelUsageEvent[] = [];
  private filterRuns: FilterRunEvent[] = [];

  recordRequest(sample: RequestSample) {
    this.requestsTotal += 1;
    if (sample.status >= 500) this.requests5xx += 1;
    else if (sample.status >= 400) this.requests4xx += 1;
    else if (sample.status >= 300) this.requests3xx += 1;
    else if (sample.status >= 200) this.requests2xx += 1;

    this.requests.push(sample);
    if (this.requests.length > MAX_REQUEST_SAMPLES) {
      this.requests.splice(0, this.requests.length - MAX_REQUEST_SAMPLES);
    }
  }

  recordCron(run: CronRun) {
    this.crons.push(run);
    if (this.crons.length > MAX_CRON_SAMPLES) {
      this.crons.splice(0, this.crons.length - MAX_CRON_SAMPLES);
    }
  }

  recordModelUsage(event: ModelUsageEvent) {
    this.modelBundlesScored += 1;
    if (event.accepted) this.modelBundlesAccepted += 1;
    else this.modelBundlesRejected += 1;
    this.modelLastVersion = event.model_version;
    this.modelLastInternalCorr = event.internal_corr;
    this.modelEvents.push(event);
    if (this.modelEvents.length > 50) {
      this.modelEvents.splice(0, this.modelEvents.length - 50);
    }
  }

  getRecentModelEvents(limit = 10): ModelUsageEvent[] {
    return this.modelEvents.slice(-limit).reverse();
  }

  /**
   * Accumulate a filter run into the lifetime counters and the ring buffer.
   * Callers should pass the funnel object produced by `filterMarkets()`.
   */
  recordFilterRun(event: FilterRunEvent) {
    this.filterRunsTotal += 1;
    this.filterMarketsSeen += event.input_count;
    this.filterMarketsKept += event.kept_count;
    this.filterMarketsRejected += event.rejected_count;
    for (const k of Object.keys(this.filterStageRejected) as Array<keyof typeof this.filterStageRejected>) {
      this.filterStageRejected[k] += event.per_stage[k].rejected;
    }
    this.filterRuns.push(event);
    if (this.filterRuns.length > 50) {
      this.filterRuns.splice(0, this.filterRuns.length - 50);
    }
  }

  getRecentFilterRuns(limit = 10): FilterRunEvent[] {
    return this.filterRuns.slice(-limit).reverse();
  }

  getRecentRequests(limit = 50): RequestSample[] {
    return this.requests.slice(-limit).reverse();
  }

  getRecentCrons(limit = 20): CronRun[] {
    return this.crons.slice(-limit).reverse();
  }

  getAllRequests(): RequestSample[] {
    return this.requests;
  }

  /** p50/p95/p99 over the recent window. Returns null values if nothing recorded. */
  latencyPercentiles(windowMs = 60_000): { p50: number | null; p95: number | null; p99: number | null; count: number } {
    const cutoff = Date.now() - windowMs;
    const xs = this.requests
      .filter((r) => r.timestamp >= cutoff)
      .map((r) => r.duration_ms)
      .sort((a, b) => a - b);
    if (xs.length === 0) return { p50: null, p95: null, p99: null, count: 0 };
    const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))];
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), count: xs.length };
  }

  /** Requests-per-minute bucketed into N equally-sized buckets, oldest first. */
  rpmBuckets(buckets = 30, bucketMs = 10_000): number[] {
    const now = Date.now();
    const out = new Array(buckets).fill(0);
    for (const r of this.requests) {
      const age = now - r.timestamp;
      const idx = buckets - 1 - Math.floor(age / bucketMs);
      if (idx >= 0 && idx < buckets) out[idx] += 1;
    }
    return out;
  }

  /** Error rate over the recent window (5xx + 4xx). */
  errorRate(windowMs = 60_000): { total: number; errors: number; rate: number } {
    const cutoff = Date.now() - windowMs;
    let total = 0;
    let errors = 0;
    for (const r of this.requests) {
      if (r.timestamp < cutoff) continue;
      total += 1;
      if (r.status >= 400) errors += 1;
    }
    return { total, errors, rate: total === 0 ? 0 : errors / total };
  }

  /** Route breakdown (hot-path first) over the window. */
  routeBreakdown(windowMs = 60_000, top = 10) {
    const cutoff = Date.now() - windowMs;
    const byRoute = new Map<string, { count: number; errors: number; total_ms: number }>();
    for (const r of this.requests) {
      if (r.timestamp < cutoff) continue;
      const key = `${r.method} ${r.path}`;
      const cur = byRoute.get(key) ?? { count: 0, errors: 0, total_ms: 0 };
      cur.count += 1;
      cur.total_ms += r.duration_ms;
      if (r.status >= 400) cur.errors += 1;
      byRoute.set(key, cur);
    }
    return Array.from(byRoute.entries())
      .map(([route, v]) => ({ route, count: v.count, errors: v.errors, avg_ms: v.total_ms / v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top);
  }
}

export const metrics = new MetricsStore();

// ---------- Express middleware ----------

/**
 * Record a RequestSample when the response finishes. Install AFTER the
 * request logger so both observe each request.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    // Normalise params like /api/nav/<uuid> so the route breakdown isn't one entry per UUID.
    const path = normalisePath(req.originalUrl || req.path);
    metrics.recordRequest({
      timestamp: Date.now(),
      method: req.method,
      path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    });
  });
  next();
}

function normalisePath(p: string): string {
  // Strip query string
  const qIdx = p.indexOf('?');
  const noQuery = qIdx >= 0 ? p.slice(0, qIdx) : p;
  // Collapse UUIDs and hex blobs to :id
  return noQuery
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/0x[0-9a-f]{8,}/gi, ':hex')
    .replace(/\/(?:[0-9]+)(?=\/|$)/g, '/:n');
}
