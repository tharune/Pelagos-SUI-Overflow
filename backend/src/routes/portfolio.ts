import { Router, Request, Response } from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { constructPortfolio, type PortfolioRequest } from "../services/portfolio";

const router = Router();

const RequestSchema = z.object({
  risk_pct: z.number().finite().min(0).max(100),
  capital_usd: z.number().finite().positive().max(100_000),
  objective: z
    .enum(["income", "speculation", "balanced"])
    .optional()
    .default("balanced"),
  horizon: z
    .enum(["short", "medium", "long"])
    .optional()
    .default("medium"),
  // Optional client-picked reference basket. When the frontend passes this,
  // the backend skips its Supabase lookup and uses these values directly so
  // recommendations link to a basket the frontend can actually resolve.
  basket: z
    .object({
      id: z.string().min(1).max(128),
      name: z.string().min(1).max(128),
      risk_tier: z.number().finite().min(0).max(100),
      nav: z.number().finite().min(0).max(1),
      // Days / legs are positive numbers (not strictly integers) so live
      // baskets with fractional days-to-resolution don't 400 the request.
      days: z.number().finite().min(0.5).max(365),
      legs: z.number().finite().min(1).max(500),
    })
    .optional(),
});

/**
 * POST /api/portfolio/construct
 * Body: { risk_pct: 0-100, capital_usd: number, objective?: "income"|"speculation"|"balanced" }
 * Returns a Claude-generated allocation across tranches, USDC lending, and
 * curated Polymarket markets. Off-chain only - no on-chain side effects.
 */
router.post("/construct", async (req: Request, res: Response) => {
  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "validation",
      details: parsed.error.flatten(),
    });
  }

  try {
    const result = await constructPortfolio(parsed.data as PortfolioRequest);
    return res.json(result);
  } catch (err: unknown) {
    // Timeout / abort from the 30s Anthropic deadline.
    if (
      err instanceof Error &&
      (err.name === "AbortError" ||
        err.name === "APIConnectionTimeoutError" ||
        /timeout|timed out/i.test(err.message))
    ) {
      console.warn("portfolio/construct timeout:", err.message);
      return res
        .status(504)
        .json({ error: "timeout", message: "Claude API took too long" });
    }

    // Anthropic-typed errors (auth, rate limit, bad request, server error).
    if (err instanceof Anthropic.APIError) {
      console.error(
        `portfolio/construct Anthropic error ${err.status}:`,
        err.message,
      );
      if (err instanceof Anthropic.AuthenticationError) {
        return res.status(500).json({
          error: "auth",
          message: "Anthropic API key missing or invalid",
        });
      }
      if (err instanceof Anthropic.RateLimitError) {
        return res
          .status(429)
          .json({ error: "upstream_rate_limit", message: err.message });
      }
      return res
        .status(502)
        .json({ error: "upstream", message: err.message });
    }

    // Validation failures from the service layer (weights don't sum, missing
    // tool call, capital cap, etc.).
    const msg = err instanceof Error ? err.message : String(err);
    console.error("portfolio/construct error:", msg);
    return res
      .status(502)
      .json({ error: "composer", message: msg });
  }
});

export default router;
