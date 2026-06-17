import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router, Request, Response } from 'express';
import * as predict from '../services/predict';
import * as structured from '../services/predict/structured';
import * as products from '../services/predict/products';
import { PREDICT } from '../services/predict/config';

const router = Router();

function sendError(res: Response, err: unknown, code = 500) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(code).json({ error: message });
}

/**
 * HTTP status for a write-path failure. Input/validation problems and
 * client-actionable states (bad params, insufficient dUSDC, nothing to withdraw)
 * are 4xx; a missing server signer is 503 (the endpoint is wired correctly — the
 * backend just isn't provisioned to sign); anything else (RPC / on-chain failure)
 * is 500. Keeps status codes consistent across every write route.
 */
function writeStatus(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  if (/No Predict signer configured/i.test(message)) return 503;
  if (/Insufficient dUSDC|holds no PLP/i.test(message)) return 400;
  if (/required|must |invalid|expected/i.test(message)) return 400;
  return 500;
}

const isObjectId = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v);

/** Resolve a raw u64 amount from either `amount_raw` or human `amount_ui`. */
function rawAmount(
  body: Record<string, unknown>,
  rawKey: string,
  uiKey: string,
  decimals = PREDICT.dusdcDecimals,
): bigint | null {
  const raw = body[rawKey];
  if (raw !== undefined && raw !== null) {
    const s = String(raw);
    if (!/^\d+$/.test(s) || BigInt(s) <= 0n) return null;
    return BigInt(s);
  }
  const ui = body[uiKey];
  if (ui !== undefined && ui !== null) {
    const n = Number(ui);
    if (!Number.isFinite(n) || n <= 0) return null;
    return BigInt(Math.round(n * 10 ** decimals));
  }
  return null;
}

function marketKey(body: Record<string, unknown>) {
  const { oracle_id, expiry, strike, is_up } = body;
  if (!isObjectId(oracle_id)) throw new Error('oracle_id (0x...) is required');
  if (expiry === undefined) throw new Error('expiry (ms) is required');
  if (strike === undefined) throw new Error('strike is required');
  return {
    oracleId: oracle_id,
    expiry: String(expiry),
    strike: String(strike),
    isUp: is_up !== false, // default UP unless explicitly false
  };
}

function rangeKey(body: Record<string, unknown>) {
  const { oracle_id, expiry, lower_strike, higher_strike } = body;
  if (!isObjectId(oracle_id)) throw new Error('oracle_id (0x...) is required');
  if (expiry === undefined) throw new Error('expiry (ms) is required');
  if (lower_strike === undefined || higher_strike === undefined) {
    throw new Error('lower_strike and higher_strike are required');
  }
  return {
    oracleId: oracle_id,
    expiry: String(expiry),
    lowerStrike: String(lower_strike),
    higherStrike: String(higher_strike),
  };
}

function quantity(body: Record<string, unknown>): bigint {
  const q = body.quantity;
  if (q === undefined || !/^\d+$/.test(String(q)) || BigInt(String(q)) <= 0n) {
    throw new Error('quantity (positive integer) is required');
  }
  return BigInt(String(q));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Config + signer + live indexer status in one call. */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const server = await predict.predictServer.status().catch((e) => ({ error: String(e) }));
    res.json({
      config: predict.predictConfig(),
      signer_address: predict.signerAddress(),
      signer_configured: predict.signerAddress() !== null,
      server_status: server,
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/config', (_req: Request, res: Response) => {
  res.json(predict.predictConfig());
});

router.get('/oracles', async (req: Request, res: Response) => {
  try {
    const all = await predict.predictServer.predictOracles();
    const activeOnly = req.query.active === 'true';
    const underlying = (req.query.underlying as string | undefined)?.toUpperCase();
    const now = Date.now();
    const filtered = all.filter(
      (o) =>
        (activeOnly ? o.status === 'active' && o.expiry > now : true) &&
        (underlying ? o.underlying_asset?.toUpperCase() === underlying : true),
    );
    res.json(filtered);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/oracles/active', async (req: Request, res: Response) => {
  try {
    const oracle = await predict.findActiveOracle(req.query.underlying as string | undefined);
    if (!oracle) return res.status(404).json({ error: 'No active oracle found' });
    res.json(oracle);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Live forward tick — the soonest active oracle's latest forward/spot from the
 * indexer, in USD. The frontend polls this every few seconds to drive the live
 * mark-to-market chart (the genuine on-chain price tick). 1e9-scaled → USD.
 */
router.get('/forward', async (req: Request, res: Response) => {
  try {
    const oracle = await predict.findActiveOracle((req.query.underlying as string | undefined) ?? 'BTC');
    if (!oracle) return res.status(404).json({ error: 'No active oracle found' });
    const latest = (await predict.predictServer.oraclePriceLatest(oracle.oracle_id)) as Record<string, number>;
    const forward = Number(latest.forward ?? latest.spot ?? 0) / 1e9;
    const spot = Number(latest.spot ?? latest.forward ?? 0) / 1e9;
    res.json({ oracle_id: oracle.oracle_id, expiry: oracle.expiry, forward, spot });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/oracles/:id/state', async (req: Request, res: Response) => {
  try {
    res.json(await predict.predictServer.oracleState(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Live SVI implied-vol SURFACE (BTC-only on testnet). Decodes each active
 * oracle's published SVI params + live forward into an annualized IV smile per
 * expiry; the protocol prices every market off this surface.
 *   GET /api/predict/vol-surface?underlying=BTC&strikes=0.15
 */
router.get('/vol-surface', async (req: Request, res: Response) => {
  try {
    const underlying = String(req.query.underlying ?? 'BTC').toUpperCase();
    const strikesPct =
      req.query.strikes !== undefined ? Number(req.query.strikes) : 0.15;
    if (!Number.isFinite(strikesPct) || strikesPct <= 0 || strikesPct >= 1) {
      throw new Error('strikes must be in (0, 1)');
    }
    const surface = await predict.buildVolSurface(underlying, strikesPct);
    res.json(surface);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no active oracles/i.test(message)) {
      return res.status(404).json({ error: 'no active oracles' });
    }
    sendError(res, err);
  }
});

/**
 * Real SVI-implied DENSITY (BTC-only on testnet). The risk-neutral settlement
 * distribution reconstructed from the oracle's live SVI smile — skewed/fat-tailed,
 * NOT a single-σ Normal. CDF = N(-d2) per strike; pdf = dCDF/dK, normalized.
 *   GET /api/predict/density?oracle_id=0x..&steps=121&span=0.18
 */
router.get('/density', async (req: Request, res: Response) => {
  try {
    const oracleId =
      typeof req.query.oracle_id === 'string' && req.query.oracle_id ? req.query.oracle_id : undefined;
    const steps = req.query.steps !== undefined ? Number(req.query.steps) : undefined;
    const span = req.query.span !== undefined ? Number(req.query.span) : undefined;
    if (span !== undefined && (!Number.isFinite(span) || span <= 0 || span >= 1)) {
      throw new Error('span must be in (0, 1)');
    }
    const density = await predict.buildImpliedDensity(oracleId, steps, span);
    res.json(density);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no oracle|oracle expired/i.test(message)) {
      return res.status(404).json({ error: 'no oracle' });
    }
    sendError(res, err);
  }
});

/**
 * Markets-depth snapshot (BTC-only on testnet). One resilient row per active
 * oracle — live forward, ATM IV, SVI skew, ATM binary-up, grid params — plus a
 * vault block (TVL / share price / utilization / max payout). All indexer-derived.
 *   GET /api/predict/markets?underlying=BTC
 */
router.get('/markets', async (req: Request, res: Response) => {
  try {
    const underlying = String(req.query.underlying ?? 'BTC').toUpperCase();
    res.json(await predict.buildMarketsDepth(underlying));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Indexer-replay BACKTEST results (the "simulation results for a vault strategy").
 * Reads backend/.backtest-strip.json produced by `npm run backtest`. The headline
 * series is house{} — the PLP / vault counterparty that earns the strip spread.
 */
router.get('/backtest', (_req: Request, res: Response) => {
  try {
    const path = resolve(__dirname, '../../.backtest-strip.json');
    res.json(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return res.status(404).json({ error: 'backtest not generated yet; run npm run backtest' });
    }
    sendError(res, err);
  }
});

router.get('/vault/summary', async (_req: Request, res: Response) => {
  try {
    res.json(await predict.predictServer.vaultSummary());
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/managers', async (req: Request, res: Response) => {
  try {
    const owner = req.query.owner as string | undefined;
    res.json(
      owner
        ? await predict.managersForOwner(owner)
        : await predict.predictServer.managers(),
    );
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/managers/:id/summary', async (req: Request, res: Response) => {
  try {
    res.json(await predict.predictServer.managerSummary(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/managers/:id/positions', async (req: Request, res: Response) => {
  try {
    res.json(await predict.predictServer.managerPositions(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

/** Live pricing preview via devInspect — no funds, no signer required. */
router.post('/preview', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const key = marketKey(body);
    const out = await predict.previewTrade({
      key,
      quantity: quantity(body),
      sender: typeof body.sender === 'string' ? body.sender : undefined,
    });
    res.json(out);
  } catch (err) {
    sendError(res, err, 400);
  }
});

/**
 * GET /api/predict/quote?asset=BTC&quantity=1000000&is_up=true
 *
 * One-call live SIMULATION: finds the active oracle, snaps the strike to the grid
 * near the live forward price, and prices the trade on-chain via devInspect (no
 * funds, no signer). Returns the resolved market + mint_cost / redeem_payout —
 * the canonical "proper simulation result" the UI renders. Strike selection is the
 * fiddly part (off-grid / off-band strikes abort in pricing_config), so the server
 * does it here instead of trusting the client to pick a valid strike.
 */
router.get('/quote', async (req: Request, res: Response) => {
  try {
    const asset = String(req.query.asset ?? 'BTC').toUpperCase();
    const qtyStr = String(req.query.quantity ?? '1000000');
    if (!/^\d+$/.test(qtyStr) || BigInt(qtyStr) <= 0n) {
      throw new Error('quantity (positive u64 raw, 6dp) is required');
    }
    const quantity = BigInt(qtyStr);
    const isUp = req.query.is_up !== 'false';

    const oracle = await predict.findActiveOracle(asset);
    if (!oracle) return res.status(404).json({ error: `no active ${asset} oracle from the indexer` });

    // Snap the strike to the grid near the live forward price (else pricing aborts).
    let target: number | undefined;
    try {
      const price = await predict.predictServer.oraclePriceLatest(oracle.oracle_id);
      for (const k of ['price', 'forward', 'spot', 'mark', 'underlying_price']) {
        const n = Number((price as Record<string, unknown>)[k]);
        if (Number.isFinite(n) && n > 0) {
          target = n;
          break;
        }
      }
    } catch {
      /* fall back to grid base inside snapStrikeToGrid */
    }
    const strike = predict.snapStrikeToGrid(oracle, target);
    const key = { oracleId: oracle.oracle_id, expiry: oracle.expiry, strike, isUp };
    const preview = await predict.previewTrade({ key, quantity });

    res.json({
      asset,
      oracle_id: oracle.oracle_id,
      expiry: oracle.expiry,
      strike: String(strike),
      is_up: isUp,
      quantity: quantity.toString(),
      mint_cost: preview.mint_cost,
      redeem_payout: preview.redeem_payout,
      dusdc_decimals: PREDICT.dusdcDecimals,
    });
  } catch (err) {
    sendError(res, err, 400);
  }
});

// ---------------------------------------------------------------------------
// Simulations (devInspect, no signer required)
// ---------------------------------------------------------------------------

router.post('/simulate/manager', async (req: Request, res: Response) => {
  try {
    const sender = (req.body as Record<string, unknown>).sender;
    res.json(await predict.simulateCreateManager(typeof sender === 'string' ? sender : undefined));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/simulate/mint', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    res.json(
      await predict.simulateMint({
        managerId: body.manager_id as string,
        key: marketKey(body),
        quantity: quantity(body),
        depositAmountRaw: rawAmount(body, 'deposit_amount_raw', 'deposit_amount_ui') ?? undefined,
        sender: typeof body.sender === 'string' ? body.sender : undefined,
      }),
    );
  } catch (err) {
    sendError(res, err, 400);
  }
});

// ---------------------------------------------------------------------------
// Writes (require a configured signer)
// ---------------------------------------------------------------------------

router.post('/manager', async (_req: Request, res: Response) => {
  try {
    res.json(await predict.createManager());
  } catch (err) {
    sendError(res, err, writeStatus(err));
  }
});

router.post('/deposit', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    const amountRaw = rawAmount(body, 'amount_raw', 'amount_ui');
    if (!amountRaw) throw new Error('amount_raw or amount_ui (positive) is required');
    res.json(await predict.deposit({ managerId: body.manager_id as string, amountRaw }));
  } catch (err) {
    sendError(res, err, writeStatus(err));
  }
});

router.post('/mint', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    res.json(
      await predict.mint({
        managerId: body.manager_id as string,
        key: marketKey(body),
        quantity: quantity(body),
        depositAmountRaw: rawAmount(body, 'deposit_amount_raw', 'deposit_amount_ui') ?? undefined,
      }),
    );
  } catch (err) {
    sendError(res, err, writeStatus(err));
  }
});

router.post('/redeem', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    res.json(
      await predict.redeem({
        managerId: body.manager_id as string,
        key: marketKey(body),
        quantity: quantity(body),
        permissionless: body.permissionless === true,
      }),
    );
  } catch (err) {
    sendError(res, err, writeStatus(err));
  }
});

router.post('/range/mint', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    res.json(
      await predict.mintRange({
        managerId: body.manager_id as string,
        key: rangeKey(body),
        quantity: quantity(body),
        depositAmountRaw: rawAmount(body, 'deposit_amount_raw', 'deposit_amount_ui') ?? undefined,
      }),
    );
  } catch (err) {
    sendError(res, err, writeStatus(err));
  }
});

router.post('/range/redeem', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    res.json(
      await predict.redeemRange({
        managerId: body.manager_id as string,
        key: rangeKey(body),
        quantity: quantity(body),
      }),
    );
  } catch (err) {
    sendError(res, err, writeStatus(err));
  }
});

router.post('/supply', async (req: Request, res: Response) => {
  try {
    const amountRaw = rawAmount(req.body as Record<string, unknown>, 'amount_raw', 'amount_ui');
    if (!amountRaw) throw new Error('amount_raw or amount_ui (positive) is required');
    res.json(await predict.supply({ amountRaw }));
  } catch (err) {
    sendError(res, err, writeStatus(err));
  }
});

router.post('/withdraw', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const sharesRaw = body.shares_raw !== undefined ? BigInt(String(body.shares_raw)) : undefined;
    res.json(
      await predict.withdraw({
        plpCoinId: isObjectId(body.plp_coin_id) ? (body.plp_coin_id as string) : undefined,
        sharesRaw,
      }),
    );
  } catch (err) {
    sendError(res, err, writeStatus(err));
  }
});

// ---------------------------------------------------------------------------
// Structured products — NON-CUSTODIAL (returns unsigned tx_bytes for the wallet)
// Shared engine for Distribution Markets, Tranches, PPN, and DeepBook baskets.
// ---------------------------------------------------------------------------

const PRICE_SCALE = 1_000_000_000; // 1e9 strike/forward scale

/** Resolve a tradeable grid oracle (+ live forward) by oracle_id or by asset. */
async function resolveGridOracle(
  body: Record<string, unknown>,
): Promise<structured.GridOracle & { forward_raw: number }> {
  const oracleId = typeof body.oracle_id === 'string' ? body.oracle_id : undefined;
  if (oracleId) {
    if (!isObjectId(oracleId)) throw new Error('oracle_id must be 0x...');
    const st = (await predict.predictServer.oracleState(oracleId)) as {
      oracle?: { oracle_id: string; expiry: number; min_strike: number; tick_size: number };
      latest_price?: { forward?: number; spot?: number };
    };
    if (!st.oracle) throw new Error(`oracle ${oracleId} not found`);
    const fwd = Number(st.latest_price?.forward ?? st.latest_price?.spot ?? st.oracle.min_strike);
    return { ...st.oracle, forward_raw: fwd };
  }
  const asset = String(body.asset ?? 'BTC').toUpperCase();
  const o = await predict.findActiveOracle(asset);
  if (!o) throw new Error(`no active ${asset} oracle`);
  const p = (await predict.predictServer.oraclePriceLatest(o.oracle_id)) as {
    forward?: number; spot?: number;
  };
  const fwd = Number(p.forward ?? p.spot ?? o.min_strike);
  return {
    oracle_id: o.oracle_id,
    expiry: o.expiry,
    min_strike: o.min_strike,
    tick_size: o.tick_size,
    forward_raw: fwd,
  };
}

/** Strip pricing: a μ/σ view -> N on-grid Predict range buckets, priced live (devInspect). */
router.post('/strip/preview', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const o = await resolveGridOracle(body);
    const muRaw =
      body.mu_usd !== undefined ? Math.round(Number(body.mu_usd) * PRICE_SCALE)
      : body.mu_raw !== undefined ? Number(body.mu_raw)
      : o.forward_raw;
    // Default σ tracks the oracle's live implied move (tenor-aware, floored to
    // the grid) so the bands sit inside the mintable window — same calibration as
    // the tranches. Falls back to a flat 1% if the SVI feed is unavailable.
    const sigmaRaw =
      body.sigma_usd !== undefined ? Math.round(Number(body.sigma_usd) * PRICE_SCALE)
      : body.sigma_raw !== undefined ? Number(body.sigma_raw)
      : await products.impliedSigmaRaw(
          { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
          o.forward_raw,
          Math.max(o.tick_size, Math.round(o.forward_raw * 0.01)),
        );
    if (!(sigmaRaw > 0)) throw new Error('sigma must be positive');
    const n = Math.min(24, Math.max(1, Number(body.n ?? 6)));
    const budgetRaw =
      body.budget_raw !== undefined ? BigInt(String(body.budget_raw))
      : body.budget_usd !== undefined
        ? BigInt(Math.round(Number(body.budget_usd) * 10 ** PREDICT.dusdcDecimals))
        : 0n;
    if (budgetRaw <= 0n) throw new Error('budget_usd or budget_raw (positive) is required');
    const spanSigma = body.span_sigma !== undefined ? Number(body.span_sigma) : 2;
    const quote = await structured.previewStrip({
      oracle: { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
      muRaw,
      sigmaRaw,
      n,
      budgetRaw,
      spanSigma,
      sender: typeof body.sender === 'string' ? body.sender : undefined,
    });
    res.json({ ...quote, forward_usd: o.forward_raw / PRICE_SCALE, dusdc_decimals: PREDICT.dusdcDecimals });
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** First-open: create the user's PredictManager (wallet-signed). */
router.post('/manager/prepare', async (req: Request, res: Response) => {
  try {
    const owner = (req.body as Record<string, unknown>).owner;
    if (!isObjectId(owner)) throw new Error('owner (0x...) is required');
    res.json(await structured.prepareCreateManager(owner));
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** Open a range strip into the user's manager (wallet-signed; optional in-PTB deposit). */
router.post('/strip/open/prepare', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.owner)) throw new Error('owner (0x...) is required');
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    if (!isObjectId(body.oracle_id)) throw new Error('oracle_id (0x...) is required');
    if (body.expiry === undefined) throw new Error('expiry is required');
    if (!Array.isArray(body.buckets) || body.buckets.length === 0) {
      throw new Error('buckets[] is required');
    }
    const depositRaw = rawAmount(body, 'deposit_amount_raw', 'deposit_amount_ui') ?? undefined;
    res.json(
      await structured.prepareMintStrip({
        owner: body.owner as string,
        managerId: body.manager_id as string,
        oracleId: body.oracle_id as string,
        expiry: String(body.expiry),
        buckets: body.buckets as Array<{ lower: string; higher: string; quantity: string }>,
        depositRaw,
      }),
    );
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** SELL a whole strip: redeem every band of a tranche/strip in one wallet-signed PTB. */
router.post('/strip/redeem/prepare', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.owner)) throw new Error('owner (0x...) is required');
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    if (!isObjectId(body.oracle_id)) throw new Error('oracle_id (0x...) is required');
    if (body.expiry === undefined) throw new Error('expiry is required');
    if (!Array.isArray(body.buckets) || body.buckets.length === 0) throw new Error('buckets[] is required');
    res.json(
      await structured.prepareRedeemStrip({
        owner: body.owner as string,
        managerId: body.manager_id as string,
        oracleId: body.oracle_id as string,
        expiry: String(body.expiry),
        buckets: body.buckets as Array<{ lower: string; higher: string; quantity: string }>,
      }),
    );
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** Redeem one range bucket (live, or permissionless after settlement) — wallet-signed. */
router.post('/range/redeem/prepare', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.owner)) throw new Error('owner (0x...) is required');
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    if (!isObjectId(body.oracle_id)) throw new Error('oracle_id (0x...) is required');
    for (const k of ['expiry', 'lower', 'higher', 'quantity']) {
      if (body[k] === undefined) throw new Error(`${k} is required`);
    }
    res.json(
      await structured.prepareRedeemRange({
        owner: body.owner as string,
        managerId: body.manager_id as string,
        oracleId: body.oracle_id as string,
        expiry: String(body.expiry),
        lower: String(body.lower),
        higher: String(body.higher),
        quantity: String(body.quantity),
      }),
    );
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** PPN floor / "be the house": supply dUSDC to the PLP vault — wallet-signed. */
router.post('/lp/supply/prepare', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.owner)) throw new Error('owner (0x...) is required');
    const amountRaw = rawAmount(body, 'amount_raw', 'amount_ui');
    if (!amountRaw) throw new Error('amount_raw or amount_ui (positive) is required');
    res.json(await structured.preparePlpSupply({ owner: body.owner as string, amountRaw }));
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** Withdraw from the PLP vault (burn PLP for dUSDC) — wallet-signed. */
router.post('/lp/withdraw/prepare', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.owner)) throw new Error('owner (0x...) is required');
    const sharesRaw = body.shares_raw !== undefined ? BigInt(String(body.shares_raw)) : undefined;
    res.json(
      await structured.preparePlpWithdraw({
        owner: body.owner as string,
        plpCoinId: isObjectId(body.plp_coin_id) ? (body.plp_coin_id as string) : undefined,
        sharesRaw,
      }),
    );
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** Confirm a wallet-executed Predict digest (manager / strip / redeem / LP). */
router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const digest = (req.body as Record<string, unknown>).digest;
    if (typeof digest !== 'string' || !digest) throw new Error('digest is required');
    res.json(await structured.confirmPredictDigest(digest));
  } catch (err) {
    sendError(res, err, 400);
  }
});

// ---------------------------------------------------------------------------
// Products: PPN (PLP floor + range upside), Tranches, DeepBook baskets.
// ---------------------------------------------------------------------------

function sigmaFromBody(body: Record<string, unknown>, o: { tick_size: number; forward_raw: number }): number {
  if (body.sigma_usd !== undefined) return Math.round(Number(body.sigma_usd) * PRICE_SCALE);
  if (body.sigma_raw !== undefined) return Number(body.sigma_raw);
  return Math.max(o.tick_size, Math.round(o.forward_raw * 0.005)); // default σ = 0.5% of forward
}
function budgetFromBody(body: Record<string, unknown>): bigint {
  if (body.budget_raw !== undefined) return BigInt(String(body.budget_raw));
  if (body.budget_usd !== undefined) return BigInt(Math.round(Number(body.budget_usd) * 10 ** PREDICT.dusdcDecimals));
  throw new Error('budget_usd or budget_raw (positive) is required');
}

/** PPN quote: PLP floor + range-strip upside. */
router.post('/ppn/quote', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const o = await resolveGridOracle(body);
    const budgetRaw = budgetFromBody(body);
    if (budgetRaw <= 0n) throw new Error('budget must be positive');
    const out = await products.quotePpn({
      oracle: { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
      forwardRaw: o.forward_raw,
      budgetRaw,
      floorPct: body.floor_pct !== undefined ? Number(body.floor_pct) : 0.8,
      sigmaRaw: sigmaFromBody(body, o),
      n: Math.min(12, Math.max(1, Number(body.n ?? 6))),
      sender: typeof body.sender === 'string' ? body.sender : undefined,
    });
    res.json({ ...out, oracle_id: o.oracle_id, expiry: String(o.expiry), forward_usd: o.forward_raw / PRICE_SCALE });
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** PPN open: PLP supply + range strip in one wallet-signed PTB. */
router.post('/ppn/open/prepare', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!isObjectId(body.owner)) throw new Error('owner (0x...) is required');
    if (!isObjectId(body.manager_id)) throw new Error('manager_id (0x...) is required');
    if (!isObjectId(body.oracle_id)) throw new Error('oracle_id (0x...) is required');
    if (body.expiry === undefined) throw new Error('expiry is required');
    if (!Array.isArray(body.buckets) || body.buckets.length === 0) throw new Error('buckets[] is required');
    const floorRaw = rawAmount(body, 'floor_amount_raw', 'floor_amount_ui');
    const upsideRaw = rawAmount(body, 'upside_amount_raw', 'upside_amount_ui');
    if (!floorRaw || !upsideRaw) throw new Error('floor_amount_* and upside_amount_* are required');
    res.json(
      await structured.preparePpnOpen({
        owner: body.owner as string,
        managerId: body.manager_id as string,
        oracleId: body.oracle_id as string,
        expiry: String(body.expiry),
        buckets: body.buckets as Array<{ lower: string; higher: string; quantity: string }>,
        floorRaw,
        upsideRaw,
      }),
    );
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** Tranche quote: senior/mezz/junior = the strip at 0.5σ / 1σ / 2σ width. */
router.post('/tranche/quote', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const o = await resolveGridOracle(body);
    const out = await products.quoteTranches({
      oracle: { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
      forwardRaw: o.forward_raw,
      budgetRaw: budgetFromBody(body),
      sigmaRaw: sigmaFromBody(body, o),
      n: Math.min(12, Math.max(1, Number(body.n ?? 6))),
      sender: typeof body.sender === 'string' ? body.sender : undefined,
    });
    res.json({ ...out, oracle_id: o.oracle_id, expiry: String(o.expiry), forward_usd: o.forward_raw / PRICE_SCALE });
  } catch (err) {
    sendError(res, err, 400);
  }
});

/** List the DeepBook structured baskets (replace the old 50% Polymarket basket). */
router.get('/baskets', (_req: Request, res: Response) => {
  res.json(products.DEEPBOOK_BASKETS);
});

/** Quote a named DeepBook basket. */
router.post('/basket/quote', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (typeof body.basket_id !== 'string') throw new Error('basket_id is required');
    const o = await resolveGridOracle(body);
    const out = await products.quoteBasket({
      oracle: { oracle_id: o.oracle_id, expiry: o.expiry, min_strike: o.min_strike, tick_size: o.tick_size },
      forwardRaw: o.forward_raw,
      basketId: body.basket_id,
      budgetRaw: budgetFromBody(body),
      sender: typeof body.sender === 'string' ? body.sender : undefined,
    });
    res.json({ ...out, oracle_id: o.oracle_id, expiry: String(o.expiry), forward_usd: o.forward_raw / PRICE_SCALE });
  } catch (err) {
    sendError(res, err, 400);
  }
});

export const predictRoutes = router;
