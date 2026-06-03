import { Router, Request, Response } from "express";
import { fetchMarketByConditionId } from "../services/polymarket";
import {
  LegMetadata,
  optimizeWeights,
  assessBasketRisk,
  scoreLegPair,
} from "../services/correlation";

const router = Router();

type LegInput = {
  market_id: string;
  question?: string;
  side: "YES" | "NO";
};

/**
 * POST /api/hedge/analyze
 *
 * Body: { legs: [{ market_id, side: 'YES'|'NO', question? }, ...] }
 *
 * For each leg:
 *   - fetches the live Polymarket market
 *   - synthesises a `LegMetadata` whose `probability` is flipped to 1-p when
 *     side === 'NO' (that's the implicit price of the NO outcome)
 *
 * Returns:
 *   - pairwise correlation matrix (using `scoreLegPair`)
 *   - optimized greedy-decorrelation weights
 *   - basket-level risk-gate verdict
 *
 * This is the single backend entry point the hedge-builder UI uses while the
 * user assembles and tweaks a custom basket.
 */
router.post("/analyze", async (req: Request, res: Response) => {
  try {
    const legs = (req.body?.legs ?? []) as LegInput[];
    if (!Array.isArray(legs) || legs.length < 2) {
      return res.status(400).json({ error: "Need at least 2 legs" });
    }
    if (legs.length > 20) {
      return res.status(400).json({ error: "Max 20 legs per basket" });
    }

    // Enrich every leg from the live Polymarket Gamma API in parallel.
    const enriched = await Promise.all(
      legs.map(async (l) => {
        const market = await fetchMarketByConditionId(l.market_id).catch(() => null);
        let yesProb = 0.5;
        if (market?.outcomePrices) {
          try {
            const parsed = JSON.parse(market.outcomePrices);
            if (Array.isArray(parsed) && parsed.length > 0) {
              yesProb = parseFloat(parsed[0]) || 0.5;
            }
          } catch {
            /* ignore */
          }
        }
        const effectiveProbability = l.side === "NO" ? 1 - yesProb : yesProb;
        return {
          id: l.market_id,
          question: l.question || market?.question || `market ${l.market_id}`,
          end_date_iso: market?.end_date_iso,
          probability: effectiveProbability,
          side: l.side,
          raw_yes_probability: yesProb,
        };
      }),
    );

    const legMetadata: LegMetadata[] = enriched.map((e) => ({
      id: `${e.id}-${e.side}`,
      question: `${e.side} · ${e.question}`,
      end_date_iso: e.end_date_iso,
      probability: e.probability,
      tags: [],
    }));

    // Pairwise correlation matrix (lower triangular). Uses the same noisy-OR
    // primitive as the basket gate so the numbers line up across products.
    const n = legMetadata.length;
    const matrix: Array<{ a: number; b: number; corr: number }> = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        matrix.push({ a: i, b: j, corr: +scoreLegPair(legMetadata[i], legMetadata[j]).toFixed(4) });
      }
    }

    const weights = optimizeWeights(legMetadata);
    const risk = assessBasketRisk(legMetadata, weights.weights);

    // Delta approximation: weighted sum of side-adjusted probabilities minus
    // 0.5. Close to zero means the basket is ~delta-neutral against a naive
    // market move. Purely informational for the UI.
    const delta =
      enriched.reduce(
        (s, e, i) => s + weights.weights[i] * (e.probability - 0.5),
        0,
      );

    res.json({
      legs: enriched.map((e, i) => ({
        market_id: e.id,
        side: e.side,
        question: e.question,
        raw_yes_probability: +e.raw_yes_probability.toFixed(4),
        effective_probability: +e.probability.toFixed(4),
        weight: +weights.weights[i].toFixed(4),
      })),
      correlation: matrix,
      risk: {
        accepted: risk.accepted,
        reason: risk.reason,
        internal_corr_mean: +risk.internal_corr_mean.toFixed(4),
        var_95_projected: +risk.var_95_projected.toFixed(4),
        var_99_projected: +risk.var_99_projected.toFixed(4),
        cvar_99_projected: +risk.cvar_99_projected.toFixed(4),
        audited_cvar_99: +risk.audited_cvar_99.toFixed(4),
        model_version: risk.model_version,
      },
      delta_approx: +delta.toFixed(4),
      strategy: weights.strategy,
    });
  } catch (err) {
    console.error("POST /api/hedge/analyze error:", err);
    res.status(500).json({ error: "Failed to analyze basket" });
  }
});

export const hedgeRoutes = router;
