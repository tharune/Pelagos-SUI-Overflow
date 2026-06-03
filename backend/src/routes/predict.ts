import { Router, Request, Response } from 'express';
import * as predict from '../services/predict';
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

router.get('/oracles/:id/state', async (req: Request, res: Response) => {
  try {
    res.json(await predict.predictServer.oracleState(req.params.id));
  } catch (err) {
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

export const predictRoutes = router;
