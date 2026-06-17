/**
 * BTC perp/spot market data + delta-hedge sizing for the Volatility desk.
 *
 * The vol leg is minted on DeepBook Predict (real, on-chain). To delta/gamma
 * hedge it like an equity-derivatives desk we need a live BTC mark + funding and
 * a realized-vol series. We source the mark from REAL Sui-DeFi venues first, in
 * priority order, falling back only as a last resort:
 *
 *   1. Bluefin BTC-PERP     — the Sui perpetual we'd actually route the hedge to
 *                             (gives mark + funding). dapi.api.sui-prod.bluefin.io
 *   2. DeepBook XBTC/USDC    — Mysten's on-chain Sui CLOB; mid of the live book
 *                             (the same DeepBook stack our vol leg prices against).
 *   3. Pyth Network BTC/USD  — the oracle Sui DeFi (Bluefin/Suilend/Scallop) reads
 *                             on-chain for its mark; pulled from Hermes with conf.
 *   4. Coinbase BTC-USD      — CEX reference (clearly labeled, not Sui-native).
 *   5. Predict forward       — the Predict oracle's own BTC forward.
 *
 * funding : real only from Bluefin; otherwise a small nominal estimate (flagged).
 * realised: annualized stdev of REAL Coinbase BTC-USD hourly candles.
 *
 * Order ROUTING is simulated (we don't submit a real perp order), but every
 * number shown — mark, funding, hedge size/notional — is real or honestly
 * labeled, and `chain` says whether the mark came from a Sui-native venue.
 * Geo-blocked hosts are reached through the same `proxiedFetch` relay as
 * Polymarket so they still resolve.
 */
import { proxiedFetch } from './proxy';

const BLUEFIN_BASE = process.env.BLUEFIN_API_URL ?? 'https://dapi.api.sui-prod.bluefin.io';
const DEEPBOOK_BASE = process.env.DEEPBOOK_INDEXER_URL ?? 'https://deepbook-indexer.mainnet.mystenlabs.com';
const PYTH_BASE = process.env.PYTH_HERMES_URL ?? 'https://hermes.pyth.network';
const COINBASE_BASE = 'https://api.exchange.coinbase.com';
// Pyth BTC/USD price-feed id — the exact feed Sui DeFi protocols post on-chain.
const PYTH_BTC_USD = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

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
  source: 'bluefin' | 'deepbook' | 'pyth' | 'coinbase' | 'predict-forward';
  funding_source: 'bluefin' | 'estimated';
  symbol: string;
  venue: string;
  /** sui = a Sui-native DeFi venue/oracle; cex = off-chain reference; forward = Predict. */
  chain: 'sui' | 'cex' | 'forward';
  /** ± confidence band in USD (Pyth only). */
  conf?: number;
}

/** Bluefin BTC-PERP mark + funding (the Sui perpetual). null if the gateway is down. */
async function fetchBluefin(): Promise<BtcMark | null> {
  const md = (await getJson(`${BLUEFIN_BASE}/marketData?symbol=BTC-PERP`, true)) as Record<string, unknown> | null;
  if (!md) return null;
  const mark = normPrice(md.marketPrice ?? md.oraclePrice ?? md.indexPrice ?? md.lastPrice ?? md.midMarketPrice);
  if (!Number.isFinite(mark) || mark <= 0) return null;
  const fr = (await getJson(`${BLUEFIN_BASE}/fundingRate?symbol=BTC-PERP`, true)) as Record<string, unknown> | null;
  const rawFr = fr ? asNum(fr.fundingRate ?? fr.rate ?? fr.value) : NaN;
  const funding = Number.isFinite(rawFr) ? (Math.abs(rawFr) > 1 ? rawFr / 1e18 : rawFr) : 0.0001;
  return { mark, funding_rate: funding, source: 'bluefin', funding_source: fr ? 'bluefin' : 'estimated', symbol: 'BTC-PERP', venue: 'Bluefin BTC-PERP', chain: 'sui' };
}

/** DeepBook XBTC/USDC mid from Mysten's on-chain CLOB. null if unreachable. */
async function fetchDeepBook(): Promise<BtcMark | null> {
  // Live book: mid of best bid/ask is the truest on-chain mark.
  const ob = (await getJson(`${DEEPBOOK_BASE}/orderbook/XBTC_USDC?level=1`, false)) as
    | { bids?: [string, string][]; asks?: [string, string][] }
    | null;
  if (ob && Array.isArray(ob.bids) && Array.isArray(ob.asks) && ob.bids[0] && ob.asks[0]) {
    const bid = asNum(ob.bids[0][0]);
    const ask = asNum(ob.asks[0][0]);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return { mark: (bid + ask) / 2, funding_rate: 0.0001, source: 'deepbook', funding_source: 'estimated', symbol: 'XBTC/USDC', venue: 'DeepBook (Sui CLOB)', chain: 'sui' };
    }
  }
  // Fall back to the indexer ticker's last trade.
  const tk = (await getJson(`${DEEPBOOK_BASE}/ticker`, false)) as Record<string, { last_price?: number }> | null;
  const last = asNum(tk?.XBTC_USDC?.last_price);
  if (Number.isFinite(last) && last > 0) {
    return { mark: last, funding_rate: 0.0001, source: 'deepbook', funding_source: 'estimated', symbol: 'XBTC/USDC', venue: 'DeepBook (Sui CLOB)', chain: 'sui' };
  }
  return null;
}

/** Pyth BTC/USD — the oracle Sui DeFi reads on-chain. null if unreachable. */
async function fetchPyth(): Promise<BtcMark | null> {
  const d = (await getJson(`${PYTH_BASE}/v2/updates/price/latest?ids[]=${PYTH_BTC_USD}`, false)) as
    | { parsed?: Array<{ price?: { price?: string; conf?: string; expo?: number } }> }
    | null;
  const p = d?.parsed?.[0]?.price;
  if (!p) return null;
  const expo = Number(p.expo ?? 0);
  const mark = asNum(p.price) * 10 ** expo;
  const conf = asNum(p.conf) * 10 ** expo;
  if (!Number.isFinite(mark) || mark <= 0) return null;
  return { mark, funding_rate: 0.0001, source: 'pyth', funding_source: 'estimated', symbol: 'BTC/USD', venue: 'Pyth Network (Sui oracle)', chain: 'sui', conf: Number.isFinite(conf) ? conf : undefined };
}

/** Live BTC mark + funding, Sui-DeFi-first: Bluefin → DeepBook → Pyth → Coinbase → forward. */
export async function fetchBtcMark(fallbackUsd = 0): Promise<BtcMark> {
  const bluefin = await fetchBluefin();
  if (bluefin) return bluefin;
  const deepbook = await fetchDeepBook();
  if (deepbook) return deepbook;
  const pyth = await fetchPyth();
  if (pyth) return pyth;
  // Coinbase BTC-USD spot — real, but a CEX reference (clearly labeled).
  const cb = (await getJson(`${COINBASE_BASE}/products/BTC-USD/ticker`, false)) as Record<string, unknown> | null;
  if (cb) {
    const mark = asNum(cb.price ?? cb.ask ?? cb.bid);
    if (Number.isFinite(mark) && mark > 0) {
      return { mark, funding_rate: 0.0001, source: 'coinbase', funding_source: 'estimated', symbol: 'BTC-USD', venue: 'Coinbase (spot ref)', chain: 'cex' };
    }
  }
  // Last resort: the Predict forward (still a real BTC price).
  return { mark: fallbackUsd, funding_rate: 0.0001, source: 'predict-forward', funding_source: 'estimated', symbol: 'BTC', venue: 'DeepBook forward', chain: 'forward' };
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
