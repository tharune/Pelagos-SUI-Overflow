import { z, ZodSchema } from 'zod';
import { Request, Response, NextFunction } from 'express';

// === Schemas ===

export const createBundleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'name must be uppercase alphanumeric with hyphens'),
  risk_tier: z
    .number()
    .refine((v): v is 50 | 70 | 90 => [50, 70, 90].includes(v), {
      message: 'risk_tier must be 50, 70, or 90',
    }),
  resolution_date: z.string().datetime({ message: 'resolution_date must be ISO date format' }),
  description: z.string().max(500).optional(),
  theme: z.string().max(100).optional(),
  legs: z
    .array(
      z.object({
        market_id: z.string().min(1),
        question: z.string().min(1).max(500),
        weight: z.number().min(0).max(1).optional(),
        polymarket_url: z.string().url().optional(),
      })
    )
    .min(1)
    .max(20),
}).refine(
  (data) => {
    const specifiedCount = data.legs.filter((l) => l.weight !== undefined).length;
    // Require all-or-none: either every leg has a weight, or none do.
    return specifiedCount === 0 || specifiedCount === data.legs.length;
  },
  { message: 'Either specify weights for all legs or none (auto-assigned)' }
).refine(
  (data) => {
    const specifiedCount = data.legs.filter((l) => l.weight !== undefined).length;
    if (specifiedCount !== data.legs.length) return true; // auto-assign path is always valid
    const totalWeight = data.legs.reduce((sum, l) => sum + (l.weight ?? 0), 0);
    return totalWeight >= 0.99 && totalWeight <= 1.01; // must sum to ~1.0
  },
  { message: 'Leg weights must sum to approximately 1.0' }
);

// bundle_id is a product/basket tag (uuid in DB mode, or a slug like
// "PBU-HIGH-SHORT" when running against on-chain state without Supabase).
// wallet_address must accept a full 66-char Sui address (0x + 64 hex).
export const depositSchema = z.object({
  bundle_id: z.string().min(1).max(128),
  wallet_address: z.string().min(32).max(66),
  amount_usdc: z.number().positive().max(1_000_000),
});

export const redeemSchema = z.object({
  bundle_id: z.string().min(1).max(128),
  wallet_address: z.string().min(32).max(66),
  amount_tokens: z.number().positive().optional(),
});

// === Middleware factory ===

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}
