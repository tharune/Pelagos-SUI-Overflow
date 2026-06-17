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
import { impliedSigmaRaw } from '../services/predict/products';
import { buildVolSurface } from '../services/predict/vol';
import { findActiveOracle, predictServer } from '../services/predict/server';
import { volWeights, computeVolGreeks, type VolSide } from '../services/predict/volatility';
import { fetchBtcMark, fetchRealizedVol, quoteHedge } from '../services/bluefin';

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

/** Resolve a BTC vol oracle (+live forward) by id, else the soonest buffered active oracle. */
async function resolveVolOracle(oracleId?: string): Promise<ResolvedOracle> {
  if (oracleId) {
    const st = (await predictServer.oracleState(oracleId)) as {
      oracle?: { oracle_id: string; expiry: number; min_strike: number; tick_size: number };
      latest_price?: { forward?: number; spot?: number };
    };
    if (!st.oracle) throw new Error(`oracle ${oracleId} not found`);
    const fwd = Number(st.latest_price?.forward ?? st.latest_price?.spot ?? st.oracle.min_strike);
    return { ...st.oracle, forward_raw: fwd };
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
    return { oracle_id: f.oracle_id, expiry: f.expiry, min_strike: f.min_strike, tick_size: f.tick_size, forward_raw: Number(fp.forward ?? fp.spot ?? f.min_strike) };
  }
  // ~3 days: a genuine vol horizon where vega/theta are meaningful and sane (a 1h
  // tenor annualizes decay into a nonsense per-day theta), while staying inside the
  // band of tenors whose SVI smile prices every strip band tradeable.
  const targetMs = now + VOL_TARGET_MS;
  const o = active.reduce((best, cur) => (Math.abs(cur.expiry - targetMs) < Math.abs(best.expiry - targetMs) ? cur : best), active[0]);
  const p = (await predictServer.oraclePriceLatest(o.oracle_id)) as { forward?: number; spot?: number };
  return { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size, forward_raw: Number(p.forward ?? p.spot ?? o.min_strike) };
}

/** BTC vol surface (IV term structure) + realized vol + vol-risk-premium. */
router.get('/surface', async (_req: Request, res: Response) => {
  try {
    const [surface, rv] = await Promise.all([buildVolSurface('BTC'), fetchRealizedVol(168)]);
    const atm = surface.term_structure[0]?.atm_iv ?? surface.slices[0]?.atm_iv ?? 0;
    res.json({
      ...surface,
      realized_vol: rv.realized_vol,
      rv_window_hours: rv.window_hours,
      rv_source: rv.source,
      vol_risk_premium: atm - rv.realized_vol,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Quote a long/short vol position: strip + Greeks + the BTC delta-hedge. */
router.post('/quote', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const side: VolSide = body.side === 'short' ? 'short' : 'long';
    const o = await resolveVolOracle(typeof body.oracle_id === 'string' ? body.oracle_id : undefined);
    const notionalUsd = Math.max(1, Number(body.notional_usd ?? body.budget_usd ?? 100));
    const budgetRaw = BigInt(Math.round(notionalUsd * 1e6));
    const sigmaRaw = await impliedSigmaRaw(
      { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
      o.forward_raw,
      Math.max(o.tick_size, Math.round(o.forward_raw * 0.005)),
    );
    const n = 8;
    const spanSigma = side === 'long' ? 2.6 : 2.0;
    const strip = await structured.previewStrip({
      oracle: { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
      muRaw: o.forward_raw,
      sigmaRaw,
      n,
      budgetRaw,
      spanSigma,
      weights: volWeights(n, side),
      sender: typeof body.sender === 'string' ? body.sender : undefined,
    });
    const forwardUsd = o.forward_raw / PRICE_SCALE;
    const sigmaUsd = sigmaRaw / PRICE_SCALE;
    const tYears = (Number(o.expiry) - Date.now()) / YEAR_MS;
    const atmIv = sigmaUsd / (forwardUsd * Math.sqrt(Math.max(tYears, 1e-9)));
    const greeks = computeVolGreeks(strip, forwardUsd, sigmaUsd, atmIv, tYears);
    const mark = await fetchBtcMark(forwardUsd);
    const hedge = quoteHedge(greeks.delta_btc, mark.mark, mark.funding_rate);
    // The vol leg is a bought strip — max risk is the premium paid, full stop.
    const maxLossUsd = Number(strip.total_cost_raw) / 1e6;
    res.json({
      side,
      oracle_id: o.oracle_id,
      expiry: String(o.expiry),
      forward_usd: forwardUsd,
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

/** Live BTC mark/funding + the hedge order for a given net delta (re-hedge). */
router.get('/hedge', async (req: Request, res: Response) => {
  try {
    const o = await resolveVolOracle(typeof req.query.oracle_id === 'string' ? req.query.oracle_id : undefined);
    const mark = await fetchBtcMark(o.forward_raw / PRICE_SCALE);
    const deltaBtc = Number(req.query.delta_btc ?? 0);
    res.json({ mark, hedge: quoteHedge(deltaBtc, mark.mark, mark.funding_rate) });
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
