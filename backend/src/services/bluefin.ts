/**
 * BTC perp/spot market data + delta-hedge sizing for the Volatility desk.
 *
 * The vol leg is minted on DeepBook Predict (real, on-chain). To delta/gamma
 * hedge it like an equity-derivatives desk, we need a live BTC mark + funding
 * and a realized-vol series. We source REAL data with graceful fallback:
 *
 *   mark    : Bluefin BTC-PERP (the Sui perps venue we'd route the hedge to) →
 *             Coinbase BTC-USD spot → the Predict forward. `source` is surfaced.
 *   funding : Bluefin fundingRate → a small nominal estimate (flagged).
 *   realised: annualized stdev of REAL Coinbase BTC-USD hourly candles.
 *
 * Order ROUTING is simulated (we don't submit a real perp order), but every
 * number shown — mark, funding, hedge size/notional — is real or honestly
 * labeled. Bluefin is reached through the same `proxiedFetch` relay as
 * Polymarket so a geo-blocked host still resolves.
 */
import { proxiedFetch } from './proxy';

const BLUEFIN_BASE = process.env.BLUEFIN_API_URL ?? 'https://dapi.api.sui-prod.bluefin.io';
const COINBASE_BASE = 'https://api.exchange.coinbase.com';

function asNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
/** Bluefin quotes prices as 1e18 fixed-point strings; spot APIs use plain USD. */
function normPrice(v: unknown): number {
  const n = asNum(v);
  if (!Number.isFinite(n)) return NaN;
  return n > 1e10 ? n / 1e18 : n;
}

/** GET + parse JSON, tolerating gateway/HTML/geo error bodies. `null` on any failure. */
async function getJson(url: string, viaProxy: boolean, ms = 6000): Promise<unknown | null> {
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

export interface BtcMark {
  mark: number;
  funding_rate: number; // per-interval (≈8h) decimal, e.g. 0.0001 = 1bp
  source: 'bluefin' | 'coinbase' | 'predict-forward';
  funding_source: 'bluefin' | 'estimated';
  symbol: string;
  venue: string;
}

/** Live BTC mark + funding: Bluefin BTC-PERP → Coinbase spot → Predict forward. */
export async function fetchBtcMark(fallbackUsd = 0): Promise<BtcMark> {
  // 1) Bluefin BTC-PERP — the real Sui perpetual mark (the hedge venue).
  const md = (await getJson(`${BLUEFIN_BASE}/marketData?symbol=BTC-PERP`, true)) as Record<string, unknown> | null;
  if (md) {
    const mark = normPrice(md.marketPrice ?? md.oraclePrice ?? md.indexPrice ?? md.lastPrice ?? md.midMarketPrice);
    if (Number.isFinite(mark) && mark > 0) {
      const fr = (await getJson(`${BLUEFIN_BASE}/fundingRate?symbol=BTC-PERP`, true)) as Record<string, unknown> | null;
      const rawFr = fr ? asNum(fr.fundingRate ?? fr.rate ?? fr.value) : NaN;
      const funding = Number.isFinite(rawFr) ? (Math.abs(rawFr) > 1 ? rawFr / 1e18 : rawFr) : 0.0001;
      return { mark, funding_rate: funding, source: 'bluefin', funding_source: fr ? 'bluefin' : 'estimated', symbol: 'BTC-PERP', venue: 'Bluefin' };
    }
  }
  // 2) Coinbase BTC-USD spot — real reference price.
  const cb = (await getJson(`${COINBASE_BASE}/products/BTC-USD/ticker`, false)) as Record<string, unknown> | null;
  if (cb) {
    const mark = asNum(cb.price ?? cb.ask ?? cb.bid);
    if (Number.isFinite(mark) && mark > 0) {
      return { mark, funding_rate: 0.0001, source: 'coinbase', funding_source: 'estimated', symbol: 'BTC-USD', venue: 'Coinbase (spot ref)' };
    }
  }
  // 3) Fall back to the Predict forward (still a real BTC price).
  return { mark: fallbackUsd, funding_rate: 0.0001, source: 'predict-forward', funding_source: 'estimated', symbol: 'BTC', venue: 'DeepBook forward' };
}

export interface RealizedVol {
  realized_vol: number; // annualized
  window_hours: number;
  source: 'coinbase' | 'unavailable';
}

/** Annualized realized vol from REAL Coinbase BTC-USD hourly candles. */
export async function fetchRealizedVol(windowHours = 168): Promise<RealizedVol> {
  const c = (await getJson(`${COINBASE_BASE}/products/BTC-USD/candles?granularity=3600`, false)) as number[][] | null;
  if (Array.isArray(c) && c.length > 3) {
    // candle = [time, low, high, open, close, volume], newest first.
    const closes = c
      .slice(0, windowHours)
      .map((x) => Number(x[4]))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reverse();
    if (closes.length > 3) {
      const rets: number[] = [];
      for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
      const annualized = Math.sqrt(variance) * Math.sqrt(24 * 365);
      return { realized_vol: annualized, window_hours: closes.length, source: 'coinbase' };
    }
  }
  return { realized_vol: 0, window_hours: 0, source: 'unavailable' };
}

export interface HedgeQuote {
  side: 'short' | 'long' | 'flat';
  size_btc: number;
  notional_usd: number;
  mark: number;
  funding_rate: number;
  funding_cost_usd: number; // per funding interval on the hedge notional
  venue: string;
}

/** The BTC perp hedge that neutralizes a position's net delta (in BTC). To
 *  offset positive (long-BTC) delta you SHORT the perp, and vice versa. */
export function quoteHedge(deltaBtc: number, mark: number, fundingRate: number): HedgeQuote {
  const size = Math.abs(deltaBtc);
  const side: HedgeQuote['side'] = deltaBtc > 1e-6 ? 'short' : deltaBtc < -1e-6 ? 'long' : 'flat';
  const notional = size * mark;
  return { side, size_btc: size, notional_usd: notional, mark, funding_rate: fundingRate, funding_cost_usd: notional * Math.abs(fundingRate), venue: 'Bluefin BTC-PERP' };
}
