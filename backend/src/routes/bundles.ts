import { Router, Request, Response } from 'express';
import {
  getAllBundles,
  getBundleById,
  getBundleByName,
  getBundleWithLegs,
  createBundle,
  createLeg,
  getLegsByBundleId,
} from '../db/queries';
import { getLiveNAV, getVaultPrice } from '../services/pricing';
import { getPolymarketBasketNAVs } from '../services/polymarket';
import { calculateNAV, calculateIssuePrice } from '../services/nav';
import { getMarketProbability, fetchMarketByConditionId } from '../services/polymarket';
import { analyzeDiversification } from '../services/analytics';
import {
  assessBasketRisk,
  optimizeWeights,
  LegMetadata,
} from '../services/correlation';
import {
  gateCheckLeg,
  FilterStage,
} from '../services/market-filter';
import { metrics } from '../services/metrics';
import { Bundle, BundleWithLegs, PolymarketMarket } from '../types';
import { validate, createBundleSchema } from '../utils/validation';

const router = Router();

/**
 * GET /api/bundles
 * List all bundles with current NAV.
 * Query params: risk_tier (90|70|50), status (active|resolved|cancelled)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { risk_tier, status } = req.query;

    let bundles = await getAllBundles();

    // Filter by risk_tier
    if (risk_tier) {
      const tier = parseInt(risk_tier as string, 10);
      if (![90, 70, 50].includes(tier)) {
        return res.status(400).json({ error: 'risk_tier must be 90, 70, or 50' });
      }
      bundles = bundles.filter((b) => b.risk_tier === tier);
    }

    // Filter by status. Default to `active` so retired/cancelled rows stop
    // surfacing on the bundles landing page. Pass `?status=all` explicitly if
    // you need the unfiltered set (e.g. admin views, portfolio reconciliation).
    const s = (status as string | undefined) ?? 'active';
    if (s !== 'all') {
      if (!['active', 'resolved', 'cancelled'].includes(s)) {
        return res.status(400).json({ error: 'status must be active, resolved, cancelled, or all' });
      }
      bundles = bundles.filter((b) => b.status === s);
    }

    // Live Polymarket basket NAVs are an OPTIONAL informational overlay
    // (polymarket_nav). The real NAV comes from the DB legs via calculateNAV,
    // so a slow/timed-out geo-bypass relay must NOT take down the whole list —
    // degrade gracefully to DB-only NAV instead of 500ing the bundles page.
    // Cap how long the page waits on the live overlay: if the relay can't answer
    // the heavy basket-NAV query within a few seconds, return DB NAV immediately
    // rather than blocking the whole bundles response for the full relay timeout.
    type BasketNAVMap = Awaited<ReturnType<typeof getPolymarketBasketNAVs>>;
    const polyPromise: Promise<BasketNAVMap> = getPolymarketBasketNAVs().catch((err) => {
      console.warn('GET /api/bundles: live Polymarket NAVs unavailable, serving DB NAV only:', (err as Error)?.message);
      return new Map() as BasketNAVMap;
    });
    const polyNAVs = await Promise.race([
      polyPromise,
      new Promise<BasketNAVMap>((resolve) => setTimeout(() => resolve(new Map() as BasketNAVMap), 4000)),
    ]);

    const enriched = await Promise.all(
      bundles.map(async (bundle) => {
        const legs = await getLegsByBundleId(bundle.id);
        // On-chain vault read is optional too — don't let a slow Sui RPC 500 the list.
        const vaultPrice = await getVaultPrice(bundle.id).catch(() => null);
        const polyData = polyNAVs.get(bundle.name);
        // nav = real leg-weighted NAV (consistent across every endpoint).
        // polymarket_nav / vault_price are separate informational fields.
        const nav = calculateNAV(legs, bundle.id).nav;
        return {
          ...bundle,
          legs,
          nav,
          vault_price: vaultPrice?.issue_price ?? null,           // on-chain mint price
          polymarket_nav: polyData?.nav ?? null,
          polymarket_leg_count: polyData?.leg_count ?? null,
          polymarket_daily_change: polyData?.daily_change ?? null,
          num_legs: legs.length,                                  // actual DB legs
          resolved_legs: legs.filter((l) => l.status !== 'active').length,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error('GET /api/bundles error:', err);
    res.status(500).json({ error: 'Failed to fetch bundles' });
  }
});

/**
 * GET /api/bundles/name/:name
 * Get bundle by name (e.g. "PBU-HIGH-SHORT").
 * Must be defined BEFORE /:id to avoid route conflict.
 */
router.get('/name/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const bundle = await getBundleByName(name);
    if (!bundle) {
      return res.status(404).json({ error: `Bundle not found: ${name}` });
    }

    const legs = await getLegsByBundleId(bundle.id);
    const nav = calculateNAV(legs, bundle.id).nav; // real leg-weighted NAV (consistent)

    const result: BundleWithLegs = {
      ...bundle,
      legs,
      nav,
      num_legs: legs.length,
      resolved_legs: legs.filter((l) => l.status !== 'active').length,
    };

    res.json(result);
  } catch (err) {
    console.error('GET /api/bundles/name/:name error:', err);
    res.status(500).json({ error: 'Failed to fetch bundle by name' });
  }
});

/**
 * GET /api/bundles/compare
 * Compare multiple bundles side-by-side.
 * Query param: ?ids=uuid1,uuid2,uuid3 (comma-separated, max 5)
 * Must be defined BEFORE /:id to avoid route conflict.
 */
router.get('/compare', async (req: Request, res: Response) => {
  try {
    const idsParam = req.query.ids as string | undefined;
    if (!idsParam) {
      return res.status(400).json({ error: 'ids query parameter is required (comma-separated UUIDs)' });
    }

    const ids = idsParam.split(',').map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'At least one bundle ID is required' });
    }
    if (ids.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 bundles can be compared at once' });
    }

    const results = await Promise.all(
      ids.map(async (id) => {
        const bundleWithLegs = await getBundleWithLegs(id);
        if (!bundleWithLegs) return null;

        // leg-weighted NAV — same basis as /performance and the list (not the
        // on-chain vault mint price, which previously made P&L contradict).
        const currentNav = bundleWithLegs.nav;

        const activeLegs = bundleWithLegs.legs.filter((l) => l.status === 'active');
        const avgProbability = activeLegs.length > 0
          ? activeLegs.reduce((sum, l) => sum + l.probability, 0) / activeLegs.length
          : 0;

        const resDate = new Date(bundleWithLegs.resolution_date);
        const now = new Date();
        const daysToResolution = Math.max(0, Math.ceil((resDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

        const navChangePercent = bundleWithLegs.issue_price > 0
          ? ((currentNav - bundleWithLegs.issue_price) / bundleWithLegs.issue_price) * 100
          : 0;

        return {
          id: bundleWithLegs.id,
          name: bundleWithLegs.name,
          risk_tier: bundleWithLegs.risk_tier,
          status: bundleWithLegs.status,
          issue_price: bundleWithLegs.issue_price,
          current_nav: Math.round(currentNav * 10000) / 10000,
          nav_change_percent: Math.round(navChangePercent * 100) / 100,
          num_legs: bundleWithLegs.num_legs,
          resolved_legs: bundleWithLegs.resolved_legs,
          avg_probability: Math.round(avgProbability * 10000) / 10000,
          days_to_resolution: daysToResolution,
          resolution_date: bundleWithLegs.resolution_date,
        };
      })
    );

    const bundles = results.filter((b) => b !== null);
    if (bundles.length === 0) {
      return res.status(404).json({ error: 'No bundles found for the provided IDs' });
    }

    // Build comparison summary
    const comparison = {
      highest_nav: bundles.reduce((best, b) => (b.current_nav > best.current_nav ? b : best), bundles[0]).name,
      lowest_risk: bundles.reduce((best, b) => (b.risk_tier < best.risk_tier ? b : best), bundles[0]).name,
      most_resolved: bundles.reduce((best, b) => (b.resolved_legs > best.resolved_legs ? b : best), bundles[0]).name,
      best_performance: bundles.reduce((best, b) => (b.nav_change_percent > best.nav_change_percent ? b : best), bundles[0]).name,
    };

    res.json({ bundles, comparison });
  } catch (err) {
    console.error('GET /api/bundles/compare error:', err);
    res.status(500).json({ error: 'Failed to compare bundles' });
  }
});

/**
 * GET /api/bundles/:id/performance
 * Rich performance metrics for a bundle including risk analysis.
 */
router.get('/:id/performance', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const bundle = await getBundleById(id);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const legs = await getLegsByBundleId(id);
    if (legs.length === 0) return res.status(404).json({ error: 'No legs found' });

    const navResult = await getLiveNAV(id);
    const currentNav = navResult?.nav ?? 0;

    // Calculate metrics
    const activeLegs = legs.filter(l => l.status === 'active');
    const wonLegs = legs.filter(l => l.status === 'won');
    const lostLegs = legs.filter(l => l.status === 'lost');

    // Probability distribution stats for active legs
    const activeProbs = activeLegs.map(l => l.probability);
    const avgProb = activeProbs.length > 0 ? activeProbs.reduce((s, p) => s + p, 0) / activeProbs.length : 0;
    const minProb = activeProbs.length > 0 ? Math.min(...activeProbs) : 0;
    const maxProb = activeProbs.length > 0 ? Math.max(...activeProbs) : 0;

    // Spread (max - min probability) - lower = more correlated
    const spread = maxProb - minProb;

    // Standard deviation of probabilities
    const variance = activeProbs.length > 0
      ? activeProbs.reduce((s, p) => s + Math.pow(p - avgProb, 2), 0) / activeProbs.length
      : 0;
    const stdDev = Math.sqrt(variance);

    // NAV vs issue price change
    const navChange = currentNav - bundle.issue_price;
    const navChangePercent = bundle.issue_price > 0 ? (navChange / bundle.issue_price) * 100 : 0;

    // Resolution progress
    const resolvedCount = wonLegs.length + lostLegs.length;
    const resolutionProgress = legs.length > 0 ? resolvedCount / legs.length : 0;

    // Weighted win rate (of resolved legs only)
    const resolvedWeight = [...wonLegs, ...lostLegs].reduce((s, l) => s + l.weight, 0);
    const wonWeight = wonLegs.reduce((s, l) => s + l.weight, 0);
    const weightedWinRate = resolvedWeight > 0 ? wonWeight / resolvedWeight : null;

    // Days to resolution
    const resDate = new Date(bundle.resolution_date);
    const now = new Date();
    const daysToResolution = Math.max(0, Math.ceil((resDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    // Risk score: simple heuristic based on tier and NAV vs issue
    const riskMultiplier = bundle.risk_tier === 90 ? 0.5 : bundle.risk_tier === 70 ? 1.0 : 1.5;
    const riskScore = Math.min(10, Math.max(1, Math.round(riskMultiplier * (1 + stdDev * 10) * 10) / 10));

    res.json({
      bundle_id: id,
      bundle_name: bundle.name,
      risk_tier: bundle.risk_tier,
      status: bundle.status,
      current_nav: currentNav,
      issue_price: bundle.issue_price,
      nav_change: Math.round(navChange * 10000) / 10000,
      nav_change_percent: Math.round(navChangePercent * 100) / 100,
      legs_summary: {
        total: legs.length,
        active: activeLegs.length,
        won: wonLegs.length,
        lost: lostLegs.length,
        resolution_progress: Math.round(resolutionProgress * 100) / 100,
        weighted_win_rate: weightedWinRate !== null ? Math.round(weightedWinRate * 100) / 100 : null,
      },
      probability_stats: {
        average: Math.round(avgProb * 10000) / 10000,
        min: Math.round(minProb * 10000) / 10000,
        max: Math.round(maxProb * 10000) / 10000,
        spread: Math.round(spread * 10000) / 10000,
        std_dev: Math.round(stdDev * 10000) / 10000,
      },
      risk_score: riskScore,
      days_to_resolution: daysToResolution,
      resolution_date: bundle.resolution_date,
      created_at: bundle.created_at,
    });
  } catch (err) {
    console.error('GET /api/bundles/:id/performance error:', err);
    res.status(500).json({ error: 'Failed to calculate performance metrics' });
  }
});

/**
 * GET /api/bundles/:id/analysis
 * Diversification and risk analysis for a bundle's legs.
 */
router.get('/:id/analysis', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const bundle = await getBundleById(id);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const legs = await getLegsByBundleId(id);
    if (legs.length === 0) return res.status(404).json({ error: 'No legs found' });

    // Refresh probabilities first
    const navResult = await getLiveNAV(id);

    const analysis = analyzeDiversification(legs);

    res.json({
      bundle_id: id,
      bundle_name: bundle.name,
      risk_tier: bundle.risk_tier,
      current_nav: navResult?.nav ?? 0,
      analysis,
    });
  } catch (err) {
    console.error('GET /api/bundles/:id/analysis error:', err);
    res.status(500).json({ error: 'Failed to analyze bundle' });
  }
});

/**
 * GET /api/bundles/:id
 * Get single bundle with all legs and current NAV.
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const bundleWithLegs = await getBundleWithLegs(id);
    if (!bundleWithLegs) {
      return res.status(404).json({ error: `Bundle not found: ${id}` });
    }

    const vaultPrice = await getVaultPrice(id);
    // nav = leg-weighted NAV (consistent everywhere); vault_price kept separate.
    res.json({ ...bundleWithLegs, nav: bundleWithLegs.nav, vault_price: vaultPrice?.issue_price ?? null });
  } catch (err) {
    console.error('GET /api/bundles/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch bundle' });
  }
});

/**
 * POST /api/bundles
 * Create a new bundle with legs. Admin endpoint (no auth for hackathon).
 *
 * Body: {
 *   name: string,
 *   risk_tier: 90 | 70 | 50,
 *   resolution_date: string (ISO date),
 *   description?: string,
 *   theme?: string,
 *   legs: [{
 *     market_id: string,
 *     question: string,
 *     weight?: number,
 *     polymarket_url?: string,
 *   }]
 * }
 */
router.post('/', validate(createBundleSchema), async (req: Request, res: Response) => {
  try {
    const { name, risk_tier, resolution_date, description, theme, legs } = req.body;

    // 1. Enrich legs with live Polymarket metadata (probability, tags, end_date)
    //    in parallel. Everything feeds into the correlation service.
    const enriched = await Promise.all(
      legs.map(async (leg: any) => {
        const [prob, market] = await Promise.all([
          getMarketProbability(leg.market_id),
          fetchMarketByConditionId(leg.market_id).catch(() => null),
        ]);
        return {
          market_id: leg.market_id,
          question: leg.question,
          polymarket_url: leg.polymarket_url,
          user_weight: typeof leg.weight === 'number' ? leg.weight : undefined,
          probability: prob ?? 0.5,
          end_date_iso: market?.end_date_iso ?? undefined,
          tags: [] as string[],
          market: market as PolymarketMarket | null,
        };
      }),
    );

    // 1b. Market-filter gate: run every leg through the bundle-gate
    //     check. All three gate stages (activity/quality_nlp/time_window)
    //     run independently so a failure in one doesn't hide failures in
    //     the others, and the funnel counters see every check. Liquidity
    //     volume, category, and dedupe are advisory at this level.
    const GATE_STAGES: FilterStage[] = ['liquidity_floor', 'quality_nlp', 'time_window'];
    const gateFailures: Array<{ market_id: string; stage: FilterStage; reasons: string[] }> = [];
    for (const e of enriched) {
      if (!e.market) {
        gateFailures.push({
          market_id: e.market_id,
          stage: 'liquidity_floor',
          reasons: ['market not found on Polymarket'],
        });
        continue;
      }

      const question = e.question || e.market.question;
      const { record } = gateCheckLeg(e.market, question);

      // Record every stage as "entered" since gateCheckLeg does not short-circuit.
      const stageCount = (stage: FilterStage): number => {
        const s = record.stages.find((x) => x.stage === stage);
        return s && !s.passed ? 1 : 0;
      };
      metrics.recordFilterRun({
        timestamp: Date.now(),
        source: 'bundle_gate' as const,
        input_count: 1,
        kept_count: record.droppedAt === null ? 1 : 0,
        rejected_count: record.droppedAt === null ? 0 : 1,
        per_stage: {
          liquidity_floor: { entered: 1, rejected: stageCount('liquidity_floor') },
          quality_nlp: { entered: 1, rejected: stageCount('quality_nlp') },
          time_window: { entered: 1, rejected: stageCount('time_window') },
          category_classify: { entered: 0, rejected: 0 },
          diversity_prefilter: { entered: 0, rejected: 0 },
        },
      });

      // Collect every failing gate stage (may be more than one)
      for (const s of record.stages) {
        if (!s.passed && GATE_STAGES.includes(s.stage)) {
          gateFailures.push({
            market_id: e.market_id,
            stage: s.stage,
            reasons: s.reasons,
          });
        }
      }
    }
    if (gateFailures.length > 0) {
      return res.status(422).json({
        error: 'One or more legs rejected by market-filter gate',
        failures: gateFailures,
        gate_stages: GATE_STAGES,
      });
    }

    // 2. Build LegMetadata[] for the correlation service.
    const legMetadata: LegMetadata[] = enriched.map((e) => ({
      id: e.market_id,
      question: e.question,
      end_date_iso: e.end_date_iso,
      probability: e.probability,
      tags: e.tags,
    }));

    // 3. Run the correlation engine. If the caller supplied weights we
    //    respect them but still assess risk; otherwise the model picks.
    const userSupplied = enriched.every((e) => e.user_weight !== undefined);
    const modelResult = optimizeWeights(legMetadata);
    const finalWeights = userSupplied
      ? enriched.map((e) => e.user_weight as number)
      : modelResult.weights;

    // 4. VaR guardrail: reject baskets whose projected tail risk exceeds the
    //    audited envelope. Record the attempt on the metrics ring buffer
    //    either way so the monitor shows rejection attempts.
    const risk = assessBasketRisk(legMetadata, finalWeights);
    metrics.recordModelUsage({
      timestamp: Date.now(),
      bundle_name: name,
      leg_count: legs.length,
      internal_corr: risk.internal_corr_mean,
      cvar_99_projected: risk.cvar_99_projected,
      accepted: risk.accepted,
      reason: risk.reason,
      model_version: modelResult.model_version,
    });

    if (!risk.accepted) {
      return res.status(422).json({
        error: 'Bundle rejected by correlation model risk gate',
        detail: risk.reason,
        projected: {
          var_95: risk.var_95_projected,
          var_99: risk.var_99_projected,
          cvar_99: risk.cvar_99_projected,
          internal_corr_mean: risk.internal_corr_mean,
        },
        audited_envelope: {
          cvar_99: risk.audited_cvar_99,
          tolerance_pct: 15,
        },
        model_version: modelResult.model_version,
      });
    }

    // 5. Calculate issue price using the model weights + live probabilities.
    const issuePrice = calculateIssuePrice(
      enriched.map((e, i) => ({
        id: '',
        bundle_id: '',
        market_id: e.market_id,
        question: e.question,
        probability: e.probability,
        weight: finalWeights[i],
        status: 'active' as const,
        created_at: '',
      })),
    );

    // 6. Persist the bundle + legs.
    const bundle = await createBundle({
      name,
      risk_tier,
      resolution_date,
      issue_price: issuePrice,
      description: description || undefined,
      theme: theme || undefined,
    });
    if (!bundle) return res.status(500).json({ error: 'Failed to create bundle' });

    const createdLegs = await Promise.all(
      enriched.map(async (e, i) => {
        return createLeg({
          bundle_id: bundle.id,
          market_id: e.market_id,
          question: e.question,
          probability: e.probability,
          weight: finalWeights[i],
          polymarket_url: e.polymarket_url || undefined,
          resolution_value: undefined,
        });
      }),
    );
    const validLegs = createdLegs.filter((l): l is NonNullable<typeof l> => l !== null);
    const navResult = calculateNAV(validLegs, bundle.id);

    const result: BundleWithLegs & {
      model: {
        version: string;
        strategy: string;
        internal_corr_mean: number;
        used_model_weights: boolean;
        risk: {
          var_95_projected: number;
          var_99_projected: number;
          cvar_99_projected: number;
          audited_cvar_99: number;
        };
      };
    } = {
      ...bundle,
      legs: validLegs,
      nav: navResult.nav,
      num_legs: validLegs.length,
      resolved_legs: 0,
      model: {
        version: modelResult.model_version,
        strategy: modelResult.strategy,
        internal_corr_mean: risk.internal_corr_mean,
        used_model_weights: !userSupplied,
        risk: {
          var_95_projected: risk.var_95_projected,
          var_99_projected: risk.var_99_projected,
          cvar_99_projected: risk.cvar_99_projected,
          audited_cvar_99: risk.audited_cvar_99,
        },
      },
    };

    res.status(201).json(result);
  } catch (err) {
    console.error('POST /api/bundles error:', err);
    res.status(500).json({ error: 'Failed to create bundle' });
  }
});

export const bundleRoutes = router;
