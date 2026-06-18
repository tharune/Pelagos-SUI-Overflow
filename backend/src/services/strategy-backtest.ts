/**
 * Strategy backtests on REAL price history — backend.
 *
 * Backtests a small library of named strategy classes against genuine market
 * history pulled over HTTP (no bulk data movement, nothing written to disk):
 *
 *   - Vol / BTC strategies (long-vol-straddle, short-vol-condor, btc-momentum)
 *     replay REAL Coinbase daily candles for the product over the window and
 *     compute a daily P&L proxy, then roll it into an equity curve + metrics.
 *   - Event baskets (event-basket) replay a representative Polymarket token's
 *     REAL CLOB prices-history (the same CLOB the live baskets price against).
 *
 * Coinbase candles: GET /products/<PRODUCT>/candles?granularity=86400 returns
 *   [time, low, high, open, close, volume] rows, NEWEST FIRST.
 * Polymarket CLOB: GET /prices-history?market=<tokenId>&... returns
 *   { history: [{ t, p }] } — real per-token executed-price history.
 *
 * Every series is real or honestly flagged: the `source` field names the
 * upstream, and `coverage_note` describes the actual window covered. If a
 * window can't be backed by real data we say so in `coverage_note` rather than
 * fabricating points.
 */
import { proxiedFetch } from './proxy';
import { getLiveBaskets } from './baskets';

const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const CLOB_API = 'https://clob.polymarket.com';

// ---------------------------------------------------------------------------
// Public shapes (the /api/backtest contract)
// ---------------------------------------------------------------------------

export interface EquityPoint {
  t: number;     // unix seconds
  equity: number; // index, starts at 1.0
}

export interface SeriesPoint {
  t: number;     // unix seconds
  close: number;
}

export interface BacktestMetrics {
  total_return_pct: number;
  sharpe: number;          // annualized, daily returns
  max_drawdown_pct: number; // negative
  win_rate: number;        // 0..1 of up days
  ann_vol_pct: number;     // annualized stdev of daily returns
}

export interface StrategyBacktestResult {
  strategy_id: string;
  window_days: number;
  source: string;        // honest upstream tag, e.g. "coinbase-candles" | "polymarket-clob" | "unavailable"
  coverage_note: string; // describes the REAL data window actually used
  equity_curve: EquityPoint[];
  metrics: BacktestMetrics;
  series?: SeriesPoint[]; // raw underlying close series (price strategies only)
}

export interface PriceSeriesResult {
  product: string;
  days: number;
  source: 'coinbase-candles' | 'unavailable';
  coverage_note: string;
  series: SeriesPoint[];
}

// Strategy library — each id is a named, demoable class.
export const STRATEGIES: Array<{ id: string; name: string; kind: 'price' | 'event'; product?: string; description: string }> = [
  { id: 'long-vol-straddle', name: 'Long Vol (ATM straddle)', kind: 'price', product: 'BTC-USD', description: 'Long gamma: daily P&L ≈ |return| minus a theta-decay drag. Wins on large moves either way.' },
  { id: 'short-vol-condor', name: 'Short Vol (iron condor)', kind: 'price', product: 'BTC-USD', description: 'Short gamma: collects theta daily, pays |return| when realized exceeds the short strikes.' },
  { id: 'btc-momentum', name: 'BTC Momentum (trend-follow)', kind: 'price', product: 'BTC-USD', description: 'Sign of the trailing N-day return sets next-day exposure; captures persistent trends.' },
  { id: 'event-basket', name: 'Event Basket (Polymarket leg)', kind: 'event', description: 'Replays a representative live-basket leg on its real CLOB price history.' },
];

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** GET + parse JSON, tolerating gateway/HTML/geo error bodies. `null` on any failure. */
async function getJson(url: string, viaProxy: boolean, ms = 8000): Promise<unknown | null> {
  try {
    const r = viaProxy ? await proxiedFetch(url) : await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const text = await r.text();
    if (!text || text.startsWith('no healthy') || text.includes('restricted location') || text.trimStart().startsWith('<')) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** REAL Coinbase daily closes (oldest→newest) for the window. Coinbase caps a
 *  candles page at 300 rows, which covers ~300 days — enough for our windows. */
async function fetchDailyCloses(product: string, days: number): Promise<SeriesPoint[]> {
  const c = (await getJson(`${COINBASE_BASE}/products/${product}/candles?granularity=86400`, false)) as number[][] | null;
  if (!Array.isArray(c) || c.length < 3) return [];
  // candle = [time, low, high, open, close, volume], newest first.
  const rows = c
    .slice(0, Math.max(2, days + 1)) // +1 so we get `days` returns
    .map((x) => ({ t: Number(x[0]), close: Number(x[4]) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.close) && p.close > 0)
    .reverse();
  return rows;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const ANNUALIZE = Math.sqrt(365);

/** Roll a daily-return stream into an equity curve + standard metrics. */
function metricsFromDailyReturns(times: number[], rets: number[]): { equity: EquityPoint[]; metrics: BacktestMetrics } {
  const equity: EquityPoint[] = [];
  let eq = 1;
  // First point anchors the curve at 1.0 (start of window).
  if (times.length > 0) equity.push({ t: times[0], equity: 1 });
  for (let i = 0; i < rets.length; i++) {
    eq *= 1 + rets[i];
    equity.push({ t: times[i + 1] ?? times[i], equity: Number(eq.toFixed(6)) });
  }

  const n = rets.length;
  const mean = n > 0 ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const dailyVol = Math.sqrt(variance);
  const sharpe = dailyVol > 0 ? (mean / dailyVol) * ANNUALIZE : 0;
  const wins = rets.filter((r) => r > 0).length;
  const winRate = n > 0 ? wins / n : 0;

  // Max drawdown over the equity curve.
  let peak = equity.length > 0 ? equity[0].equity : 1;
  let maxDd = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? p.equity / peak - 1 : 0;
    if (dd < maxDd) maxDd = dd;
  }

  const totalReturn = eq - 1;
  return {
    equity,
    metrics: {
      total_return_pct: Number((totalReturn * 100).toFixed(2)),
      sharpe: Number(sharpe.toFixed(2)),
      max_drawdown_pct: Number((maxDd * 100).toFixed(2)),
      win_rate: Number(winRate.toFixed(4)),
      ann_vol_pct: Number((dailyVol * ANNUALIZE * 100).toFixed(2)),
    },
  };
}

// ---------------------------------------------------------------------------
// Strategy P&L proxies (over REAL daily closes)
// ---------------------------------------------------------------------------

/**
 * Map a real daily-close series to a strategy's daily P&L return stream.
 *
 * long-vol-straddle : long gamma. Daily P&L ≈ |r| − theta, where theta is a
 *   daily decay drag scaled to the window's realized vol (so the straddle is
 *   roughly priced at fair vol). Profits on big moves, bleeds in calm tape.
 * short-vol-condor  : the mirror — collects theta, pays |r| beyond a small
 *   deadband (the short strikes). Steady carry punctuated by tail losses.
 * btc-momentum      : sign of the trailing 5-day return sets next-day exposure
 *   (+1 long / −1 short); return = exposure · r. Trend-following.
 */
function strategyReturns(strategyId: string, closes: SeriesPoint[]): number[] {
  const px = closes.map((c) => c.close);
  const r: number[] = [];
  for (let i = 1; i < px.length; i++) r.push(Math.log(px[i] / px[i - 1]));
  if (r.length === 0) return [];

  // Realized daily vol over the window — used to price theta fairly.
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.length > 1 ? r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1) : 0;
  const rvDaily = Math.sqrt(variance);

  switch (strategyId) {
    case 'long-vol-straddle': {
      // Fair theta for an ATM straddle ≈ E[|r|] = rvDaily·sqrt(2/π). Long vol
      // earns |r| and pays that theta each day; net is mean-zero at fair vol and
      // positive when realized > implied.
      const theta = rvDaily * Math.sqrt(2 / Math.PI);
      // Notional scaling: a straddle's gamma P&L ~ 0.5·(move²); approximate the
      // daily mark as |r| (linear, demoable) so the curve reads in return space.
      return r.map((x) => Math.abs(x) - theta);
    }
    case 'short-vol-condor': {
      // Short the wings with a small deadband (the condor's short strikes at
      // ~0.5σ). Inside the band → keep full theta; outside → pay the excess move.
      const theta = rvDaily * Math.sqrt(2 / Math.PI);
      const band = 0.5 * rvDaily;
      return r.map((x) => {
        const excess = Math.max(0, Math.abs(x) - band);
        return theta - excess; // collect carry, pay the tail
      });
    }
    case 'btc-momentum': {
      const look = 5;
      const out: number[] = [];
      for (let i = 0; i < r.length; i++) {
        // Exposure = sign of trailing `look`-day cumulative return (no lookahead).
        let trail = 0;
        for (let j = Math.max(0, i - look); j < i; j++) trail += r[j];
        const exposure = trail > 0 ? 1 : trail < 0 ? -1 : 0;
        out.push(exposure * r[i]);
      }
      return out;
    }
    default:
      // Unknown price strategy → buy-and-hold the underlying (still real).
      return r;
  }
}

// ---------------------------------------------------------------------------
// Event-basket backtest (real Polymarket CLOB history)
// ---------------------------------------------------------------------------

interface ClobHistory { history?: Array<{ t: number; p: number }> }

/** Pick a representative, liquid token from the live baskets to backtest. */
async function pickRepresentativeToken(): Promise<{ tokenId: string; label: string } | null> {
  try {
    const { baskets } = await getLiveBaskets();
    let best: { tokenId: string; label: string; vol: number } | null = null;
    for (const b of baskets) {
      for (const leg of b.legs) {
        if (!leg.tokenId) continue;
        if (!best || leg.volumeUsd > best.vol) {
          best = { tokenId: leg.tokenId, label: `${b.id} · ${leg.question}`, vol: leg.volumeUsd };
        }
      }
    }
    return best ? { tokenId: best.tokenId, label: best.label } : null;
  } catch {
    return null;
  }
}

/** Coarse-grain a dense CLOB history down to ~daily probability points. */
function dailyFromHistory(history: Array<{ t: number; p: number }>, days: number): SeriesPoint[] {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
  const inWindow = history.filter((h) => h.t >= cutoff && Number.isFinite(h.p) && h.p > 0);
  const src = inWindow.length >= 3 ? inWindow : history; // fall back to full history if window is sparse
  const byDay = new Map<number, { t: number; p: number }>();
  for (const h of src) {
    const day = Math.floor(h.t / 86_400);
    byDay.set(day, h); // last point of each day wins
  }
  return Array.from(byDay.values())
    .sort((a, b) => a.t - b.t)
    .map((h) => ({ t: h.t, close: h.p }));
}

async function backtestEventBasket(windowDays: number): Promise<StrategyBacktestResult> {
  const pick = await pickRepresentativeToken();
  const empty = emptyResult('event-basket', windowDays);
  if (!pick) {
    return { ...empty, coverage_note: 'No live-basket token available to backtest (Polymarket universe unreachable).' };
  }
  const url = `${CLOB_API}/prices-history?market=${encodeURIComponent(pick.tokenId)}&interval=max&fidelity=60`;
  const data = (await getJson(url, true)) as ClobHistory | null;
  const history = data?.history ?? [];
  if (history.length < 3) {
    return { ...empty, coverage_note: `Polymarket CLOB returned no usable history for the representative leg (${pick.label}).` };
  }
  const daily = dailyFromHistory(history, windowDays);
  if (daily.length < 2) {
    return { ...empty, coverage_note: `Representative leg (${pick.label}) has fewer than 2 daily points in the last ${windowDays}d; window not covered by real data.` };
  }
  // Hold the YES leg: equity tracks the probability path (price return space).
  const times = daily.map((d) => d.t);
  const rets: number[] = [];
  for (let i = 1; i < daily.length; i++) rets.push(daily[i].close / daily[i - 1].close - 1);
  const { equity, metrics } = metricsFromDailyReturns(times, rets);
  const startIso = new Date(daily[0].t * 1000).toISOString().slice(0, 10);
  const endIso = new Date(daily[daily.length - 1].t * 1000).toISOString().slice(0, 10);
  return {
    strategy_id: 'event-basket',
    window_days: windowDays,
    source: 'polymarket-clob',
    coverage_note: `Real Polymarket CLOB price history for ${pick.label}: ${daily.length} daily points, ${startIso}→${endIso}.`,
    equity_curve: equity,
    metrics,
    series: daily,
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function emptyResult(strategyId: string, windowDays: number): StrategyBacktestResult {
  return {
    strategy_id: strategyId,
    window_days: windowDays,
    source: 'unavailable',
    coverage_note: 'No real data available for this window.',
    equity_curve: [],
    metrics: { total_return_pct: 0, sharpe: 0, max_drawdown_pct: 0, win_rate: 0, ann_vol_pct: 0 },
  };
}

// Short cache — the same strategy/window gets polled by the chart UI; Coinbase
// daily candles barely change intraday so a 5-min TTL is plenty.
const _cache = new Map<string, { at: number; result: StrategyBacktestResult }>();
const CACHE_TTL_MS = 300_000;

/** Backtest a named strategy over `windowDays` of REAL history. */
export async function backtestStrategy(strategyId: string, windowDays: number): Promise<StrategyBacktestResult> {
  const days = clampDays(windowDays);
  const key = `${strategyId}:${days}`;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  const spec = STRATEGIES.find((s) => s.id === strategyId);
  let result: StrategyBacktestResult;

  if (spec?.kind === 'event' || strategyId === 'event-basket') {
    result = await backtestEventBasket(days);
  } else {
    const product = spec?.product ?? 'BTC-USD';
    const closes = await fetchDailyCloses(product, days);
    if (closes.length < 3) {
      result = {
        ...emptyResult(strategyId, days),
        coverage_note: `Coinbase ${product} candles unavailable; cannot back the requested ${days}d window with real data.`,
      };
    } else {
      const rets = strategyReturns(strategyId, closes);
      // Returns align to closes[1..]; the equity timestamps use the close times.
      const times = closes.map((c) => c.t);
      const { equity, metrics } = metricsFromDailyReturns(times, rets);
      const startIso = new Date(closes[0].t * 1000).toISOString().slice(0, 10);
      const endIso = new Date(closes[closes.length - 1].t * 1000).toISOString().slice(0, 10);
      result = {
        strategy_id: strategyId,
        window_days: days,
        source: 'coinbase-candles',
        coverage_note: `Real Coinbase ${product} daily candles: ${closes.length} days, ${startIso}→${endIso}. P&L is a transparent strategy proxy on real returns.`,
        equity_curve: equity,
        metrics,
        series: closes,
      };
    }
  }

  _cache.set(key, { at: Date.now(), result });
  return result;
}

/** Raw REAL price series for charting. */
export async function priceSeries(product: string, days: number): Promise<PriceSeriesResult> {
  const d = clampDays(days);
  const closes = await fetchDailyCloses(product, d);
  if (closes.length < 2) {
    return {
      product,
      days: d,
      source: 'unavailable',
      coverage_note: `Coinbase ${product} candles unavailable or empty for the requested window.`,
    series: [],
    };
  }
  const startIso = new Date(closes[0].t * 1000).toISOString().slice(0, 10);
  const endIso = new Date(closes[closes.length - 1].t * 1000).toISOString().slice(0, 10);
  return {
    product,
    days: d,
    source: 'coinbase-candles',
    coverage_note: `Real Coinbase ${product} daily candles: ${closes.length} days, ${startIso}→${endIso}.`,
    series: closes,
  };
}

function clampDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 90;
  // Coinbase daily candles page caps at ~300 rows.
  return Math.min(300, Math.max(5, Math.round(days)));
}
