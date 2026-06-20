/**
 * Volatility desk routes (/api/vol).
 *
 *   GET  /surface       — BTC IV term structure (SVI) + realized vol + VRP.
 *   POST /quote         — long/short vol strip + Greeks + the BTC delta-hedge.
 *   GET  /hedge         — live BTC mark/funding + hedge for a given net delta.
 *   POST /open/prepare  — non-custodial PTB to mint the vol strip (wallet signs).
 *
 * The vol leg is a real DeepBook Predict strip; the hedge uses real Bluefin/
 * Coinbase market data with simulated order routing.
 */
import { Router, Request, Response } from 'express';
import * as structured from '../services/predict/structured';
import { impliedSigmaAndIv } from '../services/predict/products';
import { buildVolSurface } from '../services/predict/vol';
import { findActiveOracle, predictServer } from '../services/predict/server';
import { computeVolGreeks, strategyProfile, customVolProfile, type VolSide, type VolStrategy } from '../services/predict/volatility';
import { fetchBtcMark, fetchBtcMarkCached, fetchRealizedVol, quoteHedge } from '../services/bluefin';

const STRATEGIES: VolStrategy[] = ['straddle', 'strangle', 'butterfly', 'condor'];
function parseStrategy(v: unknown, side: VolSide): VolStrategy {
  if (typeof v === 'string' && STRATEGIES.includes(v as VolStrategy)) return v as VolStrategy;
  return side === 'short' ? 'butterfly' : 'straddle'; // side fallback
}

/**
 * A bespoke (Advanced builder) structure: a sculpted per-band weight vector +
 * strip half-width. Returns null if the body carries no valid custom weights, so
 * the named-preset path runs instead. Bounded to keep the strip tradeable.
 */
function parseCustom(body: Record<string, unknown>): { weights: number[]; spanSigma: number } | null {
  const w = body.weights;
  if (!Array.isArray(w) || w.length < 4 || w.length > 16) return null;
  const weights = w.map((x) => Number(x));
  if (weights.some((x) => !Number.isFinite(x) || x < 0)) return null;
  if (!(weights.reduce((a, b) => a + b, 0) > 0)) return null;
  const spanSigma = Math.min(5, Math.max(0.6, Number(body.span_sigma ?? 2.4)));
  return { weights, spanSigma };
}

const router = Router();
const PRICE_SCALE = 1_000_000_000;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
// A real vol trade wants a multi-day horizon: long enough that per-day Greeks
// (esp. theta) are meaningful — a 1h tenor annualizes decay into nonsense — and
// the SVI smile is well-behaved at every active BTC tenor out here.
const VOL_TARGET_MS = 3 * 24 * 60 * 60 * 1000; // ~3 days

type ResolvedOracle = structured.GridOracle & { forward_raw: number };

/** Compact human tenor label from a millisecond horizon. */
function tenorLabel(ms: number): string {
  const m = ms / 60_000;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  const d = h / 24;
  return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}

/** Live forward (1e9 raw) from a price tick. On a feed gap, fall back to the LIVE
 *  BTC mark (a real proxy) scaled to raw — NEVER the grid-floor min_strike, which
 *  would mis-center the entire strip + hedge off a price far below the real spot. */
async function resolveForwardRaw(
  price: { forward?: number; spot?: number } | null | undefined,
  minStrikeRaw: number,
): Promise<number> {
  const f = Number(price?.forward ?? price?.spot);
  if (Number.isFinite(f) && f > 0) return f;
  const m = await fetchBtcMarkCached(minStrikeRaw / PRICE_SCALE);
  return Math.round(m.mark * PRICE_SCALE);
}

/** Resolve a BTC vol oracle (+live forward) by id, else the soonest buffered active oracle. */
async function resolveVolOracle(oracleId?: string): Promise<ResolvedOracle> {
  if (oracleId) {
    const st = (await predictServer.oracleState(oracleId).catch(() => null)) as {
      oracle?: { oracle_id: string; expiry: number; min_strike: number; tick_size: number };
      latest_price?: { forward?: number; spot?: number };
    } | null;
    // Use the explicit oracle ONLY if it's found AND still live. BTC oracles roll
    // often, so a cached oracle_id from the client goes stale within minutes — when
    // that happens, don't error the whole quote, just fall through to the soonest
    // active oracle below so the desk keeps working seamlessly.
    if (st?.oracle && st.oracle.expiry > Date.now() + 6 * 60_000) {
      return { ...st.oracle, forward_raw: await resolveForwardRaw(st.latest_price, st.oracle.min_strike) };
    }
  }
  // Vol trading wants a meaningful horizon — minute-tenors make "per-day" Greeks
  // explode. Default to the active BTC oracle nearest a multi-day target.
  const now = Date.now();
  const oracles = await predictServer.predictOracles().catch(() => predictServer.oracles());
  const active = oracles
    .filter((o) => o.status === 'active' && o.expiry > now + 6 * 60_000 && o.underlying_asset?.toUpperCase() === 'BTC')
    .sort((a, b) => a.expiry - b.expiry);
  if (active.length === 0) {
    const f = await findActiveOracle('BTC');
    if (!f) throw new Error('no active BTC oracle');
    const fp = (await predictServer.oraclePriceLatest(f.oracle_id)) as { forward?: number; spot?: number };
    return { oracle_id: f.oracle_id, expiry: f.expiry, min_strike: f.min_strike, tick_size: f.tick_size, forward_raw: await resolveForwardRaw(fp, f.min_strike) };
  }
  // ~3 days: a genuine vol horizon where vega/theta are meaningful and sane (a 1h
  // tenor annualizes decay into a nonsense per-day theta), while staying inside the
  // band of tenors whose SVI smile prices every strip band tradeable.
  const targetMs = now + VOL_TARGET_MS;
  const o = active.reduce((best, cur) => (Math.abs(cur.expiry - targetMs) < Math.abs(best.expiry - targetMs) ? cur : best), active[0]);
  const p = (await predictServer.oraclePriceLatest(o.oracle_id)) as { forward?: number; spot?: number };
  return { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size, forward_raw: await resolveForwardRaw(p, o.min_strike) };
}

// ---- /surface cache (stale-while-revalidate) -----------------------------
// The SVI surface changes slowly (indexer SVI ticks). Building it is ~16 indexer
// round-trips even parallelized, which blocked first paint. Serve a warm cache
// and refresh in the background so /surface is near-instant after the first hit.
type SurfacePayload = Record<string, unknown>;
let surfaceCache: { at: number; data: SurfacePayload } | null = null;
let surfaceInflight: Promise<SurfacePayload> | null = null;
const SURFACE_TTL_MS = 20_000;

async function buildSurfacePayload(): Promise<SurfacePayload> {
  const [surface, rv] = await Promise.all([buildVolSurface('BTC'), fetchRealizedVol(168)]);
  // VRP must difference LIKE-FOR-LIKE horizons. Pick the ATM IV from the tenor
  // nearest the realized-vol window (~7d), NOT the front (sub-hour) slice whose
  // IV is microstructure-dominated and floats with whatever oracle is soonest.
  const targetYears = rv.window_hours / 24 / 365.25;
  const ts = surface.term_structure;
  const base = ts.length
    ? ts.reduce((b, s) => (Math.abs(s.t_years - targetYears) < Math.abs(b.t_years - targetYears) ? s : b), ts[0])
    : null;
  const atm = base?.atm_iv ?? surface.slices[0]?.atm_iv ?? 0;
  return {
    ...surface,
    realized_vol: rv.realized_vol,
    rv_window_hours: rv.window_hours,
    rv_source: rv.source,
    vol_risk_premium: atm - rv.realized_vol,
    vrp_iv_tenor: base?.tenor_label ?? null, // the IV tenor differenced against RV
  };
}
function refreshSurface(): Promise<SurfacePayload> {
  if (surfaceInflight) return surfaceInflight;
  surfaceInflight = buildSurfacePayload()
    .then((data) => { surfaceCache = { at: Date.now(), data }; return data; })
    .finally(() => { surfaceInflight = null; });
  return surfaceInflight;
}
// Pre-warm on boot so the first user request hits a ready cache.
void refreshSurface().catch(() => { /* indexer may be cold; route will retry */ });

/** BTC vol surface (IV term structure) + realized vol + vol-risk-premium. */
router.get('/surface', async (_req: Request, res: Response) => {
  try {
    if (surfaceCache) {
      // serve the warm cache instantly; kick a background refresh if it's stale
      if (Date.now() - surfaceCache.at > SURFACE_TTL_MS) void refreshSurface().catch(() => { /* keep serving stale */ });
      return res.json(surfaceCache.data);
    }
    return res.json(await refreshSurface()); // cold start: build + await once
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Quote a long/short vol position: strip + Greeks + the BTC delta-hedge. */
router.post('/quote', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sideHint: VolSide = body.side === 'short' ? 'short' : 'long';
    const custom = parseCustom(body);
    const profile = custom
      ? customVolProfile(custom.weights, custom.spanSigma)
      : strategyProfile(parseStrategy(body.strategy, sideHint), 8);
    const n = profile.weights.length;
    const side = profile.side;
    const o = await resolveVolOracle(typeof body.oracle_id === 'string' ? body.oracle_id : undefined);
    const notionalUsd = Math.max(1, Number(body.notional_usd ?? body.budget_usd ?? 100));
    const budgetRaw = BigInt(Math.round(notionalUsd * 1e6));
    const { sigmaRaw, atmIv: sviAtmIv } = await impliedSigmaAndIv(
      { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
      o.forward_raw,
      Math.max(o.tick_size, Math.round(o.forward_raw * 0.005)),
    );
    const strip = await structured.previewStrip({
      oracle: { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
      muRaw: o.forward_raw,
      sigmaRaw,
      n,
      budgetRaw,
      spanSigma: profile.spanSigma,
      weights: profile.weights,
      // Real-time desk quote: size off the cached marginals, skip the on-chain
      // SIZED re-price (default). total_cost stays on-budget and greeks/payout
      // are sized identically; the actual mint (/open/prepare) re-prices on-chain
      // and absorbs real slippage via the deposit headroom. A client can request
      // `fast:false` for a final slippage-exact quote before opening.
      fast: body.fast !== false,
      sender: typeof body.sender === 'string' ? body.sender : undefined,
    });
    const forwardUsd = o.forward_raw / PRICE_SCALE;
    const sigmaUsd = sigmaRaw / PRICE_SCALE;
    const tYears = (Number(o.expiry) - Date.now()) / YEAR_MS;
    // Headline IV = the TRUE SVI ATM IV (matches /surface); only fall back to the
    // back-implied value (inflated when the σ floor binds) if SVI is unavailable.
    const atmIv = sviAtmIv ?? sigmaUsd / (forwardUsd * Math.sqrt(Math.max(tYears, 1e-9)));
    const greeks = computeVolGreeks(strip, forwardUsd, sigmaUsd, tYears);
    const mark = await fetchBtcMarkCached(forwardUsd); // cached (3s) — was an uncached multi-venue fetch per quote
    const hedge = quoteHedge(greeks.delta_btc, mark);
    // The vol leg is a bought strip — max risk is the premium paid, full stop.
    const maxLossUsd = Number(strip.total_cost_raw) / 1e6;
    res.json({
      side,
      strategy: profile.strategy,
      strategy_label: profile.label,
      thesis: profile.thesis,
      oracle_id: o.oracle_id,
      expiry: String(o.expiry),
      forward_usd: forwardUsd,
      sigma_usd: sigmaUsd,
      atm_iv: atmIv,
      t_years: tYears,
      tenor_label: tenorLabel(Number(o.expiry) - Date.now()),
      max_loss_usd: maxLossUsd,
      strip,
      greeks,
      mark,
      hedge,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Lightweight live BTC mark for the real-time ticker/hedge poll (cached ~1.5s). */
router.get('/mark', async (_req: Request, res: Response) => {
  try {
    const mark = await fetchBtcMarkCached();
    res.json({ mark, ts: Date.now() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Live BTC mark/funding + the hedge order for a given net delta (re-hedge). */
router.get('/hedge', async (req: Request, res: Response) => {
  try {
    const o = await resolveVolOracle(typeof req.query.oracle_id === 'string' ? req.query.oracle_id : undefined);
    const mark = await fetchBtcMark(o.forward_raw / PRICE_SCALE);
    const deltaBtc = Number(req.query.delta_btc ?? 0);
    res.json({ mark, hedge: quoteHedge(deltaBtc, mark) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Mint the vol strip (non-custodial; wallet signs). */
router.post('/open/prepare', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(
      await structured.prepareMintStrip({
        owner: body.owner as string,
        managerId: body.manager_id as string,
        oracleId: body.oracle_id as string,
        expiry: String(body.expiry),
        buckets: body.buckets as Array<{ lower: string; higher: string; quantity: string }>,
        depositRaw: body.deposit_amount_raw ? BigInt(String(body.deposit_amount_raw)) : undefined,
      }),
    );
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export const volRoutes = router;
