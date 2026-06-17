import { Router, Request, Response } from 'express';
import { quoteSellToMM, MM_BID_BPS, type ProductKind, type TrancheKind, type MarkSource } from '../services/mm-quote';
import { createTransaction, getTransactionBySignature, getBundleById, getLegsByBundleId } from '../db/queries';
import { getLiveNAV } from '../services/pricing';
import { quoteTranches, basketSigmaFromLegs } from '../services/tranching';

/**
 * Market-maker secondary-market routes (Pelagos / Sui).
 *
 * The protocol market-maker QUOTES a bid for a pre-settlement position. On
 * Pelagos there is no on-chain MM rail, so the bid is priced off-chain and an
 * accepted bid settles as a SIMULATED exit recorded to the ledger (History):
 *   POST /api/mm/quote    → price a per-product MM bid (off-chain pricing)
 *   GET  /api/mm/spreads  → the per-product bid table (UI/debug)
 *   POST /api/mm/confirm  → record an accepted (simulated) sell to History
 */

const router = Router();

const PRODUCT_KINDS: ProductKind[] = ['basket', 'tranche', 'note'];

function trancheFrom(v: unknown): TrancheKind | undefined {
  return v === 'junior' ? 'junior' : v === 'mezzanine' ? 'mezzanine' : v === 'senior' ? 'senior' : undefined;
}

/**
 * Resolve the LIVE per-unit mark for a position so the MM bid is anchored to
 * real value, not par:
 *   basket  → live NAV (getLiveNAV, refreshed from Polymarket)
 *   tranche → the tranche's model fair value (quoteTranches at the live NAV)
 *   note    → par (1) — principal-protected, trades at/above par pre-maturity
 * Falls back to par when no bundle_id is given or the live data is unavailable.
 */
async function resolveMark(
  productType: ProductKind,
  bundleId: string | undefined,
  trancheKind: TrancheKind | undefined,
): Promise<{ mark: number; source: MarkSource }> {
  if (!bundleId || productType === 'note') return { mark: 1, source: 'par' };

  const navRes = await getLiveNAV(bundleId).catch(() => null);
  const bundle = await getBundleById(bundleId).catch(() => null);
  const nav = navRes?.nav ?? bundle?.issue_price ?? null;
  if (nav === null || !Number.isFinite(nav)) return { mark: 1, source: 'par' };

  if (productType === 'basket') return { mark: nav, source: 'live_nav' };

  // tranche → price the slice off the live NAV with the real leg count + horizon.
  const legs = await getLegsByBundleId(bundleId).catch(() => []);
  const horizonDays = bundle?.resolution_date
    ? Math.max(1, Math.ceil((new Date(bundle.resolution_date).getTime() - Date.now()) / 86_400_000))
    : 30;
  const tqs = quoteTranches({
    bundleNav: nav,
    totalLegs: Math.max(1, legs.length),
    horizonDays,
    tier: bundle?.risk_tier,
    sigma: basketSigmaFromLegs(legs) ?? undefined,
  });
  const t = tqs.find((x) => x.kind === (trancheKind ?? 'senior'));
  return t ? { mark: t.fairPrice, source: 'tranche_model' } : { mark: nav, source: 'live_nav' };
}

/**
 * POST /api/mm/quote
 * body: { product_type, size_usdc, tranche_kind?, bundle_id? }
 * → MM bid anchored to the position's LIVE mark, spread simulated.
 */
router.post('/quote', async (req: Request, res: Response) => {
  try {
    const { product_type, size_usdc, tranche_kind, bundle_id } = (req.body ?? {}) as {
      product_type?: string;
      size_usdc?: number;
      tranche_kind?: string;
      bundle_id?: string;
    };
    const productType = product_type as ProductKind;
    if (!PRODUCT_KINDS.includes(productType)) {
      return res.status(400).json({ error: 'product_type must be basket | tranche | note' });
    }
    const size = Number(size_usdc);
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: 'size_usdc must be a positive number' });
    }
    const trancheKind = trancheFrom(tranche_kind);
    const { mark, source } = await resolveMark(productType, bundle_id, trancheKind);
    const quote = quoteSellToMM({ productType, sizeUsdc: size, trancheKind, markPerUnit: mark, markSource: source });
    return res.json(quote);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/** GET /api/mm/spreads → the per-product MM bid table (bps of par). */
router.get('/spreads', (_req: Request, res: Response) => {
  res.json({ bid_bps: MM_BID_BPS });
});

/**
 * POST /api/mm/confirm — record an accepted (simulated) MM sell so it appears in
 * History as a pre-settlement exit. The fill is off-chain on Pelagos; the
 * signature is a synthetic simulated-fill id (idempotent by signature).
 */
router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const { bundle_id, wallet_address, signature, payout_usdc } = (req.body ?? {}) as {
      bundle_id?: string;
      wallet_address?: string;
      signature?: string;
      payout_usdc?: number;
    };
    if (!bundle_id || !wallet_address) {
      return res.status(400).json({ error: 'bundle_id and wallet_address required' });
    }
    const payout = Number(payout_usdc);
    if (!Number.isFinite(payout) || payout < 0) {
      return res.status(400).json({ error: 'payout_usdc must be a number >= 0' });
    }
    const sig = String(signature || `mm-sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    const existing = await getTransactionBySignature(sig).catch(() => null);
    if (existing) {
      return res.json({
        confirmed: true,
        idempotent: true,
        tx_signature: sig,
        transaction_id: existing.id,
        bundle_id,
        payout_usdc: payout,
      });
    }

    let transactionId: string | null = null;
    try {
      const tx = await createTransaction({
        bundle_id,
        wallet_address,
        type: 'redemption', // an MM sell is a pre-settlement exit
        amount_usdc: payout,
        tokens: 0,
        fee_usdc: 0,
        tx_signature: sig,
      });
      transactionId = tx?.id ?? null;
    } catch {
      /* ledger indexing is optional */
    }

    return res.status(201).json({
      confirmed: true,
      tx_signature: sig,
      transaction_id: transactionId,
      bundle_id,
      payout_usdc: payout,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
