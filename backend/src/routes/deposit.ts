import { Router, Request, Response } from 'express';
import {
  getBundleById,
  createPosition,
  createTransaction,
  getPositionsByWallet,
  getPositionsByWalletAndBundle,
  getTransactionsByWallet,
  updatePositionHoldings,
} from '../db/queries';
import { getIssuePriceForBundle, getLiveNAV, getVaultPrice } from '../services/pricing';
import { getPolymarketBasketNAVs } from '../services/polymarket';
import { supabase } from '../db/supabase';
import {
  confirmSuiDigest,
  derivedObjectsForBundle,
  estimateDeposit,
  estimateRedeem,
  getProductState,
  getUserUsdcDeltaFromDigest,
} from '../services/pelagos-chain';
import { DepositRequest, DepositResponse } from '../types';
import { validate, depositSchema, redeemSchema } from '../utils/validation';

const router = Router();

async function issuePriceFor(bundleId: string): Promise<number> {
  const bundle = await getBundleById(bundleId);
  const polyNAVs = await getPolymarketBasketNAVs();
  const polyData = bundle?.name ? polyNAVs.get(bundle.name) : undefined;
  return polyData?.nav ?? await getIssuePriceForBundle(bundleId) ?? bundle?.issue_price ?? 0;
}

async function prepareDepositHandler(req: Request, res: Response) {
  try {
    const { bundle_id, wallet_address, amount_usdc } = req.body as DepositRequest;
    const bundle = await getBundleById(bundle_id);
    if (!bundle) return res.status(404).json({ error: `Bundle not found: ${bundle_id}` });
    if (bundle.status !== 'active') {
      return res.status(400).json({ error: `Bundle is not active (status: ${bundle.status})` });
    }

    const issuePrice = await issuePriceFor(bundle_id);
    if (!issuePrice || issuePrice <= 0) {
      return res.status(500).json({ error: 'Unable to determine issue price' });
    }

    const estimate = estimateDeposit(amount_usdc, issuePrice);
    const objects = derivedObjectsForBundle(bundle_id);
    res.status(200).json({
      kind: 'prepared',
      bundle_id,
      wallet_address,
      amount_usdc,
      fee_usdc: estimate.feeUsdc,
      net_usdc: estimate.netUsdc,
      issue_price: issuePrice,
      tokens_minted: estimate.expectedTokens,
      expected_tokens: estimate.expectedTokens,
      sui_market_id: objects.suiMarketId,
      sui_pool_id: objects.suiPoolId,
      sui_receipt_type: objects.suiReceiptType,
    });
  } catch (err) {
    console.error('POST /api/deposit/prepare error:', err);
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to prepare deposit: ${detail}` });
  }
}

router.post('/prepare', validate(depositSchema), prepareDepositHandler);
router.post('/', validate(depositSchema), prepareDepositHandler);

router.get('/vault-price/:bundleId', async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;
    const product = await getProductState(bundleId);
    if (!product) {
      return res.status(404).json({ error: 'Product state not found for this bundle.' });
    }
    res.json({
      bundle_id: bundleId,
      issue_price: product.issuePriceBps / 10_000,
      fee_bps: product.feeBps,
      vault_state: product.state,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to fetch product price: ${detail}` });
  }
});

router.get('/vault-prices', async (_req: Request, res: Response) => {
  try {
    const { getAllBundles } = await import('../db/queries');
    const bundles = await getAllBundles();
    const results = await Promise.allSettled(
      bundles.map(async (b) => {
        const product = await getProductState(b.id);
        return {
          bundle_id: b.id,
          bundle_name: b.name,
          issue_price: product ? product.issuePriceBps / 10_000 : null,
          fee_bps: product ? product.feeBps : null,
        };
      }),
    );
    const prices = results
      .map((r) => r.status === 'fulfilled' ? r.value : null)
      .filter(Boolean);
    res.json({ count: prices.length, prices });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to fetch product prices: ${detail}` });
  }
});

router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const {
      bundle_id,
      wallet_address,
      amount_usdc,
      signature,
      tokens_minted,
      issue_price,
      fee_usdc,
    } = req.body as {
      bundle_id: string;
      wallet_address: string;
      amount_usdc: number;
      signature: string;
      tokens_minted: number;
      issue_price: number;
      fee_usdc: number;
    };

    if (!signature) return res.status(400).json({ error: 'signature required' });
    const confirmed = await confirmSuiDigest(signature);
    if (!confirmed) return res.status(400).json({ error: 'Sui transaction has not confirmed yet' });

    const position = await createPosition({
      bundle_id,
      wallet_address,
      tokens_held: tokens_minted,
      entry_price: issue_price,
      deposited_usdc: amount_usdc,
    });
    if (!position) return res.status(500).json({ error: 'Failed to create position' });

    const transaction = await createTransaction({
      bundle_id,
      wallet_address,
      type: 'deposit',
      amount_usdc,
      tokens: tokens_minted,
      fee_usdc,
      tx_signature: signature,
    });
    if (!transaction) return res.status(500).json({ error: 'Failed to create transaction' });

    await supabase
      .from('transactions')
      .update({ onchain_tx_signature: signature })
      .eq('id', transaction.id);

    const result: DepositResponse = {
      transaction_id: transaction.id,
      bundle_id,
      tokens_minted,
      issue_price,
      fee_usdc,
      net_usdc: amount_usdc - fee_usdc,
    };
    res.status(201).json(result);
  } catch (err) {
    console.error('POST /api/deposit/confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm deposit' });
  }
});

router.post('/redeem/prepare', validate(redeemSchema), async (req: Request, res: Response) => {
  try {
    const { bundle_id, wallet_address, amount_tokens: amountTokensOverride } = req.body as {
      bundle_id: string;
      wallet_address: string;
      amount_tokens?: number;
    };
    const bundle = await getBundleById(bundle_id);
    if (!bundle) return res.status(404).json({ error: `Bundle not found: ${bundle_id}` });

    const product = await getProductState(bundle_id);
    if (!product || product.state === 'closed') {
      return res.status(400).json({ error: 'Sui product is not redeemable.' });
    }

    const positions = await getPositionsByWalletAndBundle(wallet_address, bundle_id);
    const totalTokens = positions.reduce((s, p) => s + p.tokens_held, 0);
    if (totalTokens <= 0) return res.status(400).json({ error: 'No tokens to redeem' });

    const redeemTokens =
      amountTokensOverride != null && amountTokensOverride > 0 && amountTokensOverride <= totalTokens
        ? amountTokensOverride
        : totalTokens;
    const estimate = estimateRedeem(redeemTokens, product.issuePriceBps / 10_000, product.state === 'active');
    const objects = derivedObjectsForBundle(bundle_id);

    res.status(200).json({
      kind: 'prepared',
      bundle_id,
      wallet_address,
      total_tokens: redeemTokens,
      expected_usdc: estimate.expectedUsdc,
      redeem_kind: estimate.redeemKind,
      exit_fee_usdc: estimate.exitFeeUsdc,
      sui_market_id: objects.suiMarketId,
      sui_pool_id: objects.suiPoolId,
    });
  } catch (err) {
    console.error('POST /api/deposit/redeem/prepare error:', err);
    res.status(500).json({ error: 'Failed to prepare redeem' });
  }
});

router.post('/redeem/confirm', async (req: Request, res: Response) => {
  try {
    const { bundle_id, wallet_address, signature, expected_usdc, tokens_redeemed } = req.body as {
      bundle_id: string;
      wallet_address: string;
      signature: string;
      expected_usdc: number;
      tokens_redeemed?: number;
    };

    const confirmed = await confirmSuiDigest(signature);
    if (!confirmed) return res.status(400).json({ error: 'Sui transaction has not confirmed yet' });

    const positions = await getPositionsByWalletAndBundle(wallet_address, bundle_id);
    const totalTokens = positions.reduce((s, p) => s + p.tokens_held, 0);
    const toDeduct =
      tokens_redeemed != null && tokens_redeemed > 0 && tokens_redeemed <= totalTokens
        ? tokens_redeemed
        : totalTokens;

    let remaining = toDeduct;
    for (const p of positions) {
      if (remaining <= 0) break;
      const deduct = Math.min(p.tokens_held, remaining);
      const frac = p.tokens_held > 0 ? deduct / p.tokens_held : 0;
      await updatePositionHoldings(p.id, {
        tokens_held: p.tokens_held - deduct,
        deposited_usdc: Math.max(0, p.deposited_usdc - p.deposited_usdc * frac),
      });
      remaining -= deduct;
    }

    const ownerDelta = await getUserUsdcDeltaFromDigest();
    const netReceived = ownerDelta != null && ownerDelta > 0 ? ownerDelta : expected_usdc;
    const tx = await createTransaction({
      bundle_id,
      wallet_address,
      type: 'redemption',
      amount_usdc: netReceived,
      tokens: toDeduct,
      fee_usdc: Math.max(0, expected_usdc - netReceived),
      tx_signature: signature,
    });

    if (tx) {
      await supabase
        .from('transactions')
        .update({ onchain_tx_signature: signature })
        .eq('id', tx.id);
    }

    res.status(200).json({
      wallet_address,
      bundle_id,
      total_tokens: toDeduct,
      payout_usdc: expected_usdc,
      transaction_id: tx?.id,
    });
  } catch (err) {
    console.error('POST /api/deposit/redeem/confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm redeem' });
  }
});

router.post('/redeem', validate(redeemSchema), (req: Request, res: Response) => {
  req.url = '/redeem/prepare';
  (router as any).handle(req, res);
});

router.get('/portfolio/:walletAddress', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    const positions = await getPositionsByWallet(walletAddress);

    if (positions.length === 0) {
      return res.json({ wallet_address: walletAddress, positions: [], total_value: 0, total_pnl: 0 });
    }

    const enriched = await Promise.all(
      positions.map(async (pos) => {
        const bundle = await getBundleById(pos.bundle_id);
        let currentNav: number;
        if (bundle?.status === 'active') {
          const navResult = await getLiveNAV(pos.bundle_id);
          const polyNAVs = await getPolymarketBasketNAVs();
          const polyData = bundle ? polyNAVs.get(bundle.name) : undefined;
          currentNav = polyData?.nav ?? navResult?.nav ?? pos.entry_price;
        } else {
          currentNav = pos.entry_price;
        }
        const currentValue = pos.tokens_held * currentNav;
        const costBasis = pos.deposited_usdc;
        const unrealizedPnl = currentValue - costBasis;

        return {
          position_id: pos.id,
          bundle_id: pos.bundle_id,
          bundle_name: bundle?.name ?? 'Unknown',
          bundle_status: bundle?.status ?? 'unknown',
          risk_tier: bundle?.risk_tier ?? 0,
          resolution_date: bundle?.resolution_date ?? null,
          tokens_held: pos.tokens_held,
          entry_price: pos.entry_price,
          deposited_usdc: pos.deposited_usdc,
          current_nav: currentNav,
          current_value: currentValue,
          unrealized_pnl: unrealizedPnl,
          pnl_percent: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
          created_at: pos.created_at,
        };
      }),
    );

    const totalValue = enriched.reduce((s, p) => s + p.current_value, 0);
    const totalPnl = enriched.reduce((s, p) => s + p.unrealized_pnl, 0);
    const totalDeposited = enriched.reduce((s, p) => s + p.deposited_usdc, 0);

    res.json({
      wallet_address: walletAddress,
      positions: enriched,
      total_value: totalValue,
      total_deposited: totalDeposited,
      total_pnl: totalPnl,
      total_pnl_percent: totalDeposited > 0 ? (totalPnl / totalDeposited) * 100 : 0,
    });
  } catch (err) {
    console.error('GET /api/deposit/portfolio/:walletAddress error:', err);
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
});

router.get('/transactions/:walletAddress', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    const transactions = await getTransactionsByWallet(walletAddress);
    const { data: vaultRows } = await supabase
      .from('ppn_vaults')
      .select('id, bundle_id, principal_usdc, created_at, tranche_kind, price_per_token')
      .eq('wallet_address', walletAddress);

    function findVaultForTx(tx: { bundle_id: string; created_at: string }) {
      if (!vaultRows || vaultRows.length === 0) return null;
      const txTs = new Date(tx.created_at).getTime();
      let best: (typeof vaultRows)[number] | null = null;
      let bestDelta = Infinity;
      for (const v of vaultRows) {
        if (v.bundle_id !== tx.bundle_id) continue;
        const d = Math.abs(new Date(v.created_at).getTime() - txTs);
        if (d < bestDelta && d < 120_000) {
          bestDelta = d;
          best = v;
        }
      }
      return best;
    }

    const enriched = await Promise.all(
      transactions.map(async (tx) => {
        const bundle = await getBundleById(tx.bundle_id);
        const vaultMatch = findVaultForTx(tx);
        const notionalTokens =
          vaultMatch?.price_per_token && vaultMatch.price_per_token > 0
            ? (vaultMatch.principal_usdc ?? tx.amount_usdc) / vaultMatch.price_per_token
            : null;
        return {
          id: tx.id,
          bundle_id: tx.bundle_id,
          bundle_name: bundle?.name ?? 'Unknown',
          type: tx.type,
          amount_usdc: tx.amount_usdc,
          tokens: tx.tokens,
          fee_usdc: tx.fee_usdc,
          tx_signature: tx.tx_signature,
          created_at: tx.created_at,
          tranche_kind: vaultMatch?.tranche_kind ?? null,
          price_per_token: vaultMatch?.price_per_token ?? null,
          notional_tokens: notionalTokens,
          principal_usdc: vaultMatch?.principal_usdc ?? null,
        };
      }),
    );

    res.json({
      wallet_address: walletAddress,
      count: enriched.length,
      transactions: enriched,
    });
  } catch (err) {
    console.error('GET /api/deposit/transactions/:walletAddress error:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

export const depositRoutes = router;
