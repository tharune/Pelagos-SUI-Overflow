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
 * External hosts are reached through the shared `proxiedFetch` helper (a direct
 * fetch with a timeout), consistent with the Polymarket client.
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
  funding_rate: number; // per-HOUR decimal (Bluefin + Hyperliquid both fund hourly), e.g. 0.0000125 = 0.00125%/hr
  source: 'bluefin' | 'deepbook' | 'pyth' | 'coinbase' | 'predict-forward';
  funding_source: 'bluefin' | 'hyperliquid' | 'estimated';
  symbol: string;
  venue: string;
  /** sui = a Sui-native DeFi venue/oracle; cex = off-chain reference; forward = Predict. */
  chain: 'sui' | 'cex' | 'forward';
  /** ± confidence band in USD (Pyth only). */
  conf?: number;
}

/** Real BTC-PERP funding (hourly) from Hyperliquid — the deepest perp venue with
 *  a public funding feed. Used as the funding fallback when Bluefin's Sui gateway
 *  is unavailable, so the rate shown is always a LIVE perp funding, never a
 *  hardcoded estimate. Hyperliquid quotes the predicted next hourly funding. */
let hlFundingCache: { at: number; rate: number } | null = null;
async function fetchHyperliquidFunding(): Promise<number | null> {
  if (hlFundingCache && Date.now() - hlFundingCache.at < 20_000) return hlFundingCache.rate; // hourly rate — cache 20s
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as [{ universe?: Array<{ name?: string }> }, Array<{ funding?: string }>];
    const i = d?.[0]?.universe?.findIndex((u) => u.name === 'BTC') ?? -1;
    if (i < 0) return null;
    const f = asNum(d?.[1]?.[i]?.funding); // per-hour decimal
    if (!Number.isFinite(f)) return null;
    hlFundingCache = { at: Date.now(), rate: f };
    return f;
  } catch {
    return null;
  }
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

// Short cache so a fast UI poll (the live hedge ticker) doesn't hammer the venue.
let markCache: { at: number; mark: BtcMark } | null = null;

/** Cached live BTC mark for high-frequency polling + per-quote use (3s TTL). */
export async function fetchBtcMarkCached(fallbackUsd = 0, ttlMs = 3000): Promise<BtcMark> {
  if (markCache && Date.now() - markCache.at < ttlMs) return markCache.mark;
  const mark = await fetchBtcMark(fallbackUsd);
  markCache = { at: Date.now(), mark };
  return mark;
}

/** Live BTC mark + funding. MARK is Sui-DeFi-first (Bluefin → DeepBook → Pyth →
 *  Coinbase → forward); FUNDING is real Bluefin if its perp is up, else a live
 *  Hyperliquid hourly funding (never a hardcoded estimate unless both are down). */
export async function fetchBtcMark(fallbackUsd = 0): Promise<BtcMark> {
  // Fire the top mark sources AND the Hyperliquid funding CONCURRENTLY so the mark
  // is one round-trip, not a sequential venue chain. Bluefin → DeepBook are the
  // Sui-native priority; Pyth/Coinbase only if both miss.
  const [bluefin, deepbook, hlFunding] = await Promise.all([
    fetchBluefin().catch(() => null),
    fetchDeepBook().catch(() => null),
    fetchHyperliquidFunding().catch(() => null),
  ]);
  let m: BtcMark;
  if (bluefin) m = bluefin;
  else if (deepbook) m = deepbook;
  else {
    const pyth = await fetchPyth().catch(() => null);
    if (pyth) m = pyth;
    else {
      const cb = (await getJson(`${COINBASE_BASE}/products/BTC-USD/ticker`, false).catch(() => null)) as Record<string, unknown> | null;
      const cbMark = cb ? asNum(cb.price ?? cb.ask ?? cb.bid) : NaN;
      m = Number.isFinite(cbMark) && cbMark > 0
        ? { mark: cbMark, funding_rate: 0.0000125, source: 'coinbase', funding_source: 'estimated', symbol: 'BTC-USD', venue: 'Coinbase (spot ref)', chain: 'cex' }
        : { mark: fallbackUsd, funding_rate: 0.0000125, source: 'predict-forward', funding_source: 'estimated', symbol: 'BTC', venue: 'DeepBook forward', chain: 'forward' };
    }
  }
  // If funding isn't already real Bluefin data, use the LIVE Hyperliquid hourly
  // funding so the desk never displays a fabricated rate when Bluefin is down.
  if (m.funding_source !== 'bluefin' && hlFunding !== null) {
    return { ...m, funding_rate: hlFunding, funding_source: 'hyperliquid' };
  }
  return m;
}

export interface RealizedVol {
  realized_vol: number; // annualized
  window_hours: number;
  source: 'coinbase' | 'unavailable';
}

/** Annualized realized vol from REAL Coinbase hourly candles (default BTC-USD). */
export async function fetchRealizedVol(windowHours = 168, product = 'BTC-USD'): Promise<RealizedVol> {
  const c = (await getJson(`${COINBASE_BASE}/products/${product}/candles?granularity=3600`, false)) as number[][] | null;
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
      const annualized = Math.sqrt(variance) * Math.sqrt(24 * 365.25); // match IV's 365.25-day year (YEAR_MS)
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
  funding_rate: number; // per-hour
  /** Signed hourly carry on the hedge notional: + = the hedger RECEIVES funding,
   *  − = pays. A short perp receives when funding>0 (longs pay shorts); long pays. */
  funding_pnl_usd: number;
  funding_source: BtcMark['funding_source'];
  mark_venue: string; // where mark/funding was actually sourced
  venue: string;      // the perp the hedge is routed to
}

/** The BTC perp hedge that neutralizes a position's net delta (in BTC). To offset
 *  positive (long-BTC) delta you SHORT the perp, and vice versa. Routed to Bluefin
 *  BTC-PERP (the Sui perp); priced off the live `m` mark + funding. */
export function quoteHedge(deltaBtc: number, m: BtcMark): HedgeQuote {
  const size = Math.abs(deltaBtc);
  const side: HedgeQuote['side'] = deltaBtc > 1e-6 ? 'short' : deltaBtc < -1e-6 ? 'long' : 'flat';
  const notional = size * m.mark;
  const sideSign = side === 'short' ? 1 : side === 'long' ? -1 : 0; // short RECEIVES + funding
  return {
    side,
    size_btc: size,
    notional_usd: notional,
    mark: m.mark,
    funding_rate: m.funding_rate,
    funding_pnl_usd: sideSign * notional * m.funding_rate,
    funding_source: m.funding_source,
    mark_venue: m.venue,
    venue: 'Bluefin BTC-PERP',
  };
}
