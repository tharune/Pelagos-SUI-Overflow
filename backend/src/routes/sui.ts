import { Router, Request, Response } from 'express';
import {
  buySuiMarketSide,
  claimSuiMarket,
  createSuiMarket,
  mintMockUsdc,
  openSuiLocalBasketPosition,
  redeemSuiLocalBasketPosition,
  resolveSuiMarket,
  suiStatus,
} from '../services/sui';

const router = Router();

function sendError(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}

router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json(await suiStatus());
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/mock-usdc/mint', async (req: Request, res: Response) => {
  try {
    const { recipient, amount_raw, amount_ui } = req.body as {
      recipient?: string;
      amount_raw?: string | number;
      amount_ui?: string | number;
    };
    if (!recipient) return res.status(400).json({ error: 'recipient is required' });

    const amountRaw =
      amount_raw !== undefined
        ? String(amount_raw)
        : String(Math.round(Number(amount_ui ?? 0) * 1_000_000));
    if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
      return res.status(400).json({ error: 'amount_raw or amount_ui must be positive' });
    }

    res.json(await mintMockUsdc(recipient, amountRaw));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/local/basket/deposit', async (req: Request, res: Response) => {
  try {
    const { bundle_id, recipient, amount_raw, amount_usdc } = req.body as {
      bundle_id?: string;
      recipient?: string;
      amount_raw?: string | number;
      amount_usdc?: string | number;
    };
    if (!bundle_id) return res.status(400).json({ error: 'bundle_id is required' });
    const amountRaw =
      amount_raw !== undefined
        ? String(amount_raw)
        : String(Math.round(Number(amount_usdc ?? 0) * 1_000_000));
    if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
      return res.status(400).json({ error: 'amount_raw or amount_usdc must be positive' });
    }

    res.json(await openSuiLocalBasketPosition({ bundleId: bundle_id, amountRaw, recipient }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/local/basket/redeem', async (req: Request, res: Response) => {
  try {
    const { market_id, position_id } = req.body as {
      market_id?: string;
      position_id?: string;
    };
    if (!market_id) return res.status(400).json({ error: 'market_id is required' });
    if (!position_id) return res.status(400).json({ error: 'position_id is required' });

    res.json(await redeemSuiLocalBasketPosition({ marketId: market_id, positionId: position_id }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/markets', async (req: Request, res: Response) => {
  try {
    const { question, close_ms } = req.body as { question?: string; close_ms?: string | number };
    if (!question) return res.status(400).json({ error: 'question is required' });
    res.json(await createSuiMarket(question, String(close_ms ?? 0)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/markets/:marketId/buy', async (req: Request, res: Response) => {
  try {
    const { marketId } = req.params;
    const { side, coin_id, amount_raw } = req.body as {
      side?: 'yes' | 'no';
      coin_id?: string;
      amount_raw?: string | number;
    };
    if (side !== 'yes' && side !== 'no') {
      return res.status(400).json({ error: 'side must be yes or no' });
    }
    if (!coin_id) return res.status(400).json({ error: 'coin_id is required' });
    if (amount_raw === undefined) return res.status(400).json({ error: 'amount_raw is required' });
    res.json(await buySuiMarketSide(marketId, coin_id, String(amount_raw), side));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/markets/:marketId/resolve', async (req: Request, res: Response) => {
  try {
    const { marketId } = req.params;
    const { side } = req.body as { side?: 'yes' | 'no' };
    if (side !== 'yes' && side !== 'no') {
      return res.status(400).json({ error: 'side must be yes or no' });
    }
    res.json(await resolveSuiMarket(marketId, side));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/markets/:marketId/claim', async (req: Request, res: Response) => {
  try {
    const { marketId } = req.params;
    const { position_id } = req.body as { position_id?: string };
    if (!position_id) return res.status(400).json({ error: 'position_id is required' });
    res.json(await claimSuiMarket(marketId, position_id));
  } catch (err) {
    sendError(res, err);
  }
});

export const suiRoutes = router;
