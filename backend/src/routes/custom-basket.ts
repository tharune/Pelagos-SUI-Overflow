import { Router, Request, Response } from 'express';
import { THEMES, buildCustomBasket } from '../services/custom-basket';

const router = Router();

/**
 * GET /api/custom-baskets/themes
 * Curated theme presets (Macro 2026, Crypto, Geopolitics, AI & Tech, Sports)
 * the frontend offers as one-click starting points for a custom basket build.
 */
router.get('/themes', (_req: Request, res: Response) => {
  try {
    res.json({
      count: THEMES.length,
      themes: THEMES.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        tier: t.tier,
        keywords: t.keywords,
      })),
    });
  } catch (err) {
    console.error('GET /api/custom-baskets/themes error:', err);
    res.status(500).json({ error: 'Failed to list custom-basket themes' });
  }
});

/**
 * POST /api/custom-baskets/build
 * Build a bespoke diversified, low-correlation basket from a free-text query OR
 * a curated theme. Same Cumulant-Arc pipeline as the standing Event Baskets:
 * 5-stage filter -> greedy decorrelated selection -> inverse-variance weights ->
 * VaR/CVaR risk gate -> tranche + MM entry quotes, all priced off live CLOB
 * midpoints where available.
 *
 * Body: { query?, theme?, target_legs?=12, tier?=90|50, max_per_category? }
 */
router.post('/build', async (req: Request, res: Response) => {
  try {
    const { query, theme, target_legs, tier, max_per_category } = req.body ?? {};
    if (!query && !theme) {
      return res.status(400).json({ error: 'Provide a `query` or a `theme`.' });
    }
    const result = await buildCustomBasket({
      query: typeof query === 'string' ? query : undefined,
      theme: typeof theme === 'string' ? theme : undefined,
      target_legs: typeof target_legs === 'number' ? target_legs : undefined,
      tier: tier === 50 || tier === 90 ? tier : undefined,
      max_per_category: typeof max_per_category === 'number' ? max_per_category : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error('POST /api/custom-baskets/build error:', err);
    res.status(500).json({ error: 'Failed to build custom basket' });
  }
});

export const customBasketRoutes = router;
