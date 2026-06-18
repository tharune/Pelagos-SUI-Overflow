import { Router, Request, Response } from 'express';
import {
  listStrategies,
  quoteNote,
  NoteQuoteError,
} from '../services/notes-allocation';

const router = Router();

/**
 * GET /api/notes/strategies
 *
 * The Principal-Protected Note presets along the tail-risk / convexity ladder
 * (Capital Guard → Balanced Convexity → Long Tail). Each card carries the live
 * blended Sui USDC yield APY that mints its protection budget plus an indicative
 * $10k / default-tenor sample so the UI can rank them. The yield APY is real and
 * tagged with its DeFiLlama source (or the lending-anchor / fallback provenance).
 */
router.get('/strategies', (_req: Request, res: Response) => {
  try {
    res.json(listStrategies());
  } catch (err) {
    console.error('GET /api/notes/strategies error:', err);
    res.status(500).json({ error: 'Failed to build note strategies' });
  }
});

/**
 * POST /api/notes/quote
 * body: { principal_usd: number, preset_id: string, tenor_days?: number }
 *
 * Prices a single principal-protected note: the protected floor, the live DeFi
 * yield sleeve that funds the protection/upside budget over the tenor, and how
 * that budget deploys into a DeepBook upside strip (best/worst payoff).
 */
router.post('/quote', (req: Request, res: Response) => {
  try {
    const { principal_usd, preset_id, tenor_days } = req.body as {
      principal_usd?: number;
      preset_id?: string;
      tenor_days?: number;
    };
    const quote = quoteNote({
      principalUsd: Number(principal_usd),
      presetId: String(preset_id ?? ''),
      tenorDays: tenor_days === undefined ? undefined : Number(tenor_days),
    });
    res.json(quote);
  } catch (err) {
    if (err instanceof NoteQuoteError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('POST /api/notes/quote error:', err);
    res.status(500).json({ error: 'Failed to quote note' });
  }
});

export const notesRoutes = router;
