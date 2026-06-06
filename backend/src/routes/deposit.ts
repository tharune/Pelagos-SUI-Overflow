import { Router, Request, Response } from 'express';
import {
  getBundleById,
  createPosition,
  createTransaction,
  getTransactionBySignature,
  getTransactionsByWallet,
  getPPNVaultsForLedger,
} from '../db/queries';

/** Classify a prepare/build error into the right HTTP status. */
function statusForError(message: string): number {
  if (/insufficient/i.test(message)) return 400;
  if (/no vault positions|not found/i.test(message)) return 404;
  return 500;
}

/** The on-chain event's owner must match the wallet claiming the deposit/redeem. */
function ownerMismatch(event: Record<string, unknown> | undefined, wallet: string): boolean {
  const owner = (event?.owner as string | undefined)?.toLowerCase();
  return Boolean(owner && wallet && owner !== wallet.toLowerCase());
}

/** Decode the on-chain VaultShare label (vector<u8>) the deposit was tagged with. */
function eventLabel(event: Record<string, unknown> | undefined): string | null {
  const raw = event?.label;
  if (Array.isArray(raw)) return Buffer.from(raw as number[]).toString("utf8");
  if (typeof raw === "string") return raw;
  return null;
}
import { supabase } from '../db/supabase';
import {
  prepareDeposit,
  prepareRedeem,
  confirmDigest,
  readVaultState,
  listShares,
  vaultConfigured,
  VAULT,
} from '../services/vault';
import { validate, depositSchema, redeemSchema } from '../utils/validation';

const router = Router();

function notConfigured(res: Response) {
  return res
    .status(503)
    .json({ error: 'On-chain vault not configured (set VAULT_PACKAGE_ID + VAULT_OBJECT_ID).' });
}

/**
 * Build a REAL, signable deposit transaction against the on-chain vault. The
 * wallet signs `tx_bytes`; the backend never custodies funds. Works without
 * Supabase — the bundle id is just a label on the share receipt.
 */
async function prepareDepositHandler(req: Request, res: Response) {
  try {
    if (!vaultConfigured()) return notConfigured(res);
    const { bundle_id, wallet_address, amount_usdc } = req.body as {
      bundle_id: string;
      wallet_address: string;
      amount_usdc: number;
    };

    const prep = await prepareDeposit({
      owner: wallet_address,
      amount_usdc,
      label: bundle_id,
    });

    res.status(200).json({
      kind: 'prepared',
      bundle_id,
      wallet_address,
      amount_usdc,
      fee_usdc: prep.economics.fee_usdc,
      net_usdc: prep.economics.net_usdc,
      issue_price: prep.economics.share_price,
      tokens_minted: prep.economics.expected_shares,
      expected_tokens: prep.economics.expected_shares,
      deposit_fee_bps: prep.economics.deposit_fee_bps,
      sui_market_id: prep.vault_id,
      sui_pool_id: prep.vault_id,
      sui_receipt_type: prep.share_type,
      // The actual on-chain transaction for the wallet to sign + execute:
      tx_bytes: prep.tx_bytes,
      sender: prep.sender,
      dry_run: prep.dry_run,
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error('POST /api/deposit/prepare error:', msg);
    res.status(statusForError(msg)).json({ error: `Failed to prepare deposit: ${msg}` });
  }
}

router.post('/prepare', validate(depositSchema), prepareDepositHandler);
router.post('/', validate(depositSchema), prepareDepositHandler);

router.get('/vault-price/:bundleId', async (req: Request, res: Response) => {
  try {
    if (!vaultConfigured()) return notConfigured(res);
    const state = await readVaultState();
    res.json({
      bundle_id: req.params.bundleId,
      vault_id: VAULT.vaultObjectId,
      issue_price: state.share_price,
      fee_bps: state.deposit_fee_bps,
      redeem_fee_bps: state.redeem_fee_bps,
      total_assets_usdc: Number(state.total_assets_raw) / 10 ** VAULT.usdcDecimals,
      total_shares: Number(state.total_shares) / 10 ** VAULT.usdcDecimals,
      vault_state: 'active',
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch vault price: ${(err as Error).message}` });
  }
});

router.get('/vault-prices', async (_req: Request, res: Response) => {
  try {
    if (!vaultConfigured()) return res.json({ count: 0, prices: [] });
    const state = await readVaultState();
    res.json({
      count: 1,
      prices: [
        {
          bundle_id: 'pelagos-vault',
          bundle_name: 'Pelagos Vault (MOCK_USDC)',
          vault_id: VAULT.vaultObjectId,
          issue_price: state.share_price,
          fee_bps: state.deposit_fee_bps,
          total_assets_usdc: Number(state.total_assets_raw) / 10 ** VAULT.usdcDecimals,
        },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch vault prices: ${(err as Error).message}` });
  }
});

router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const { bundle_id, wallet_address, amount_usdc, signature, tokens_minted, issue_price, fee_usdc } =
      req.body as {
        bundle_id: string;
        wallet_address: string;
        amount_usdc: number;
        signature: string;
        tokens_minted?: number;
        issue_price?: number;
        fee_usdc?: number;
      };
    if (!signature) return res.status(400).json({ error: 'signature (tx digest) required' });

    const c = await confirmDigest(signature, wallet_address);
    if (!c.ok) {
      return res.status(400).json({ error: `Sui transaction not confirmed: ${c.status}`, ...c });
    }
    // Owner-binding: reject a real digest claimed by the wrong wallet.
    if (ownerMismatch(c.event, wallet_address)) {
      return res
        .status(400)
        .json({ error: 'Digest owner does not match wallet_address', event_owner: c.event?.owner });
    }
    // Bundle-binding: the on-chain deposit label must match the claimed bundle
    // so a digest can't be attributed to the wrong basket.
    const label = eventLabel(c.event);
    if (label && label !== bundle_id) {
      return res
        .status(400)
        .json({ error: 'Digest bundle label does not match bundle_id', event_label: label });
    }
    // Idempotency: a digest already recorded returns the existing row unchanged.
    const existing = await getTransactionBySignature(signature).catch(() => null);
    if (existing) {
      return res.status(200).json({
        confirmed: true,
        idempotent: true,
        digest: signature,
        explorer_url: c.explorer_url,
        event: c.event,
        transaction_id: existing.id,
        bundle_id,
      });
    }

    // Best-effort off-chain indexing (no-op if Supabase is unconfigured).
    let transactionId: string | null = null;
    try {
      const position = await createPosition({
        bundle_id,
        wallet_address,
        tokens_held: tokens_minted ?? 0,
        entry_price: issue_price ?? 1,
        deposited_usdc: amount_usdc,
      });
      const transaction = await createTransaction({
        bundle_id,
        wallet_address,
        type: 'deposit',
        amount_usdc,
        tokens: tokens_minted ?? 0,
        fee_usdc: fee_usdc ?? 0,
        tx_signature: signature,
      });
      transactionId = transaction?.id ?? null;
      if (transaction) {
        await supabase
          .from('transactions')
          .update({ onchain_tx_signature: signature })
          .eq('id', transaction.id);
      }
      void position;
    } catch {
      /* indexing optional */
    }

    res.status(201).json({
      confirmed: true,
      digest: signature,
      explorer_url: c.explorer_url,
      event: c.event,
      transaction_id: transactionId,
      bundle_id,
      tokens_minted: tokens_minted ?? null,
      issue_price: issue_price ?? null,
      fee_usdc: fee_usdc ?? null,
    });
  } catch (err) {
    console.error('POST /api/deposit/confirm error:', err);
    res.status(500).json({ error: `Failed to confirm deposit: ${(err as Error).message}` });
  }
});

router.post('/redeem/prepare', validate(redeemSchema), async (req: Request, res: Response) => {
  try {
    if (!vaultConfigured()) return notConfigured(res);
    const { bundle_id, wallet_address } = req.body as { bundle_id: string; wallet_address: string };
    const prep = await prepareRedeem({ owner: wallet_address, label: bundle_id });
    res.status(200).json({
      kind: 'prepared',
      bundle_id,
      wallet_address,
      share_id: prep.share_id,
      total_tokens: prep.economics.shares,
      expected_usdc: prep.economics.net_usdc,
      gross_usdc: prep.economics.gross_usdc,
      exit_fee_usdc: prep.economics.fee_usdc,
      redeem_kind: 'active_early',
      sui_market_id: prep.vault_id,
      sui_pool_id: prep.vault_id,
      tx_bytes: prep.tx_bytes,
      sender: prep.sender,
      dry_run: prep.dry_run,
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error('POST /api/deposit/redeem/prepare error:', msg);
    res.status(statusForError(msg)).json({ error: `Failed to prepare redeem: ${msg}` });
  }
});

router.post('/redeem/confirm', async (req: Request, res: Response) => {
  try {
    const { bundle_id, wallet_address, signature } = req.body as {
      bundle_id: string;
      wallet_address: string;
      signature: string;
    };
    if (!signature) return res.status(400).json({ error: 'signature (tx digest) required' });

    const c = await confirmDigest(signature, wallet_address);
    if (!c.ok) {
      return res.status(400).json({ error: `Sui transaction not confirmed: ${c.status}`, ...c });
    }
    if (ownerMismatch(c.event, wallet_address)) {
      return res
        .status(400)
        .json({ error: 'Digest owner does not match wallet_address', event_owner: c.event?.owner });
    }
    const existingRedeem = await getTransactionBySignature(signature).catch(() => null);
    if (existingRedeem) {
      return res.status(200).json({
        confirmed: true,
        idempotent: true,
        digest: signature,
        explorer_url: c.explorer_url,
        bundle_id,
        wallet_address,
        payout_usdc: c.usdc_delta ?? null,
        transaction_id: existingRedeem.id,
      });
    }

    let transactionId: string | null = null;
    try {
      const tx = await createTransaction({
        bundle_id,
        wallet_address,
        type: 'redemption',
        amount_usdc: c.usdc_delta ?? 0,
        tokens: 0,
        fee_usdc: 0,
        tx_signature: signature,
      });
      transactionId = tx?.id ?? null;
    } catch {
      /* indexing optional */
    }

    res.status(200).json({
      confirmed: true,
      digest: signature,
      explorer_url: c.explorer_url,
      bundle_id,
      wallet_address,
      payout_usdc: c.usdc_delta ?? null,
      event: c.event,
      transaction_id: transactionId,
    });
  } catch (err) {
    console.error('POST /api/deposit/redeem/confirm error:', err);
    res.status(500).json({ error: `Failed to confirm redeem: ${(err as Error).message}` });
  }
});

router.post('/redeem', validate(redeemSchema), async (req: Request, res: Response) => {
  // Alias: redeem == redeem/prepare (build the signable tx).
  try {
    if (!vaultConfigured()) return notConfigured(res);
    const { bundle_id, wallet_address } = req.body as { bundle_id: string; wallet_address: string };
    const prep = await prepareRedeem({ owner: wallet_address, label: bundle_id });
    res.status(200).json({
      kind: 'prepared',
      bundle_id,
      wallet_address,
      share_id: prep.share_id,
      total_tokens: prep.economics.shares,
      expected_usdc: prep.economics.net_usdc,
      exit_fee_usdc: prep.economics.fee_usdc,
      tx_bytes: prep.tx_bytes,
      sender: prep.sender,
      dry_run: prep.dry_run,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to prepare redeem: ${(err as Error).message}` });
  }
});

/** Live on-chain portfolio: the wallet's real VaultShare receipts, valued at the
 *  live share price. */
router.get('/portfolio/:walletAddress', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    if (!vaultConfigured()) {
      return res.json({ wallet_address: walletAddress, positions: [], total_value: 0, total_pnl: 0 });
    }
    const [state, shares] = await Promise.all([readVaultState(), listShares(walletAddress)]);

    const positions = shares.map((s) => {
      const currentValue = s.shares * state.share_price;
      const costBasis = s.principal_usdc;
      const unrealizedPnl = currentValue - costBasis;
      return {
        position_id: s.share_id,
        share_id: s.share_id,
        bundle_id: s.label || 'pelagos-vault',
        bundle_name: s.label || 'Pelagos Vault',
        bundle_status: 'active',
        tokens_held: s.shares,
        entry_price: costBasis > 0 && s.shares > 0 ? costBasis / s.shares : 1,
        deposited_usdc: costBasis,
        current_nav: state.share_price,
        current_value: currentValue,
        unrealized_pnl: unrealizedPnl,
        pnl_percent: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
      };
    });

    const totalValue = positions.reduce((s, p) => s + p.current_value, 0);
    const totalDeposited = positions.reduce((s, p) => s + p.deposited_usdc, 0);
    const totalPnl = totalValue - totalDeposited;
    res.json({
      wallet_address: walletAddress,
      vault_id: VAULT.vaultObjectId,
      share_price: state.share_price,
      positions,
      total_value: totalValue,
      total_deposited: totalDeposited,
      total_pnl: totalPnl,
      total_pnl_percent: totalDeposited > 0 ? (totalPnl / totalDeposited) * 100 : 0,
    });
  } catch (err) {
    console.error('GET /api/deposit/portfolio error:', err);
    res.status(500).json({ error: `Failed to fetch portfolio: ${(err as Error).message}` });
  }
});

router.get('/transactions/:walletAddress', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    const [transactions, ledgerVaults] = await Promise.all([
      getTransactionsByWallet(walletAddress),
      getPPNVaultsForLedger(walletAddress).catch(() => []),
    ]);
    // Map every vault's deposit + redemption digest -> the vault, so each
    // transaction can be tagged with its product type (note / tranche). A tx
    // with no vault match is a Market Basket (PBU units, no vault share).
    const vaultBySig = new Map<string, (typeof ledgerVaults)[number]>();
    for (const v of ledgerVaults) {
      if (v.onchain_tx_signature) vaultBySig.set(v.onchain_tx_signature, v);
      if (v.redemption_tx_signature) vaultBySig.set(v.redemption_tx_signature, v);
    }
    const enriched = await Promise.all(
      transactions.map(async (tx) => {
        const bundle = await getBundleById(tx.bundle_id).catch(() => null);
        const v = tx.tx_signature ? vaultBySig.get(tx.tx_signature) : undefined;
        // product: 'tranche' (has tranche_kind) | 'note' (vault share, no
        // tranche) | 'basket' (no vault match). Drives the History label.
        const product = v ? (v.tranche_kind ? 'tranche' : 'note') : 'basket';
        return {
          id: tx.id,
          bundle_id: tx.bundle_id,
          bundle_name: bundle?.name ?? 'Pelagos Vault',
          type: tx.type,
          amount_usdc: tx.amount_usdc,
          tokens: tx.tokens,
          fee_usdc: tx.fee_usdc,
          tx_signature: tx.tx_signature,
          created_at: tx.created_at,
          product,
          tranche_kind: v?.tranche_kind ?? null,
          principal_usdc: v ? v.principal_usdc : null,
        };
      }),
    );
    res.json({ wallet_address: walletAddress, count: enriched.length, transactions: enriched });
  } catch (err) {
    console.error('GET /api/deposit/transactions error:', err);
    res.status(500).json({ error: `Failed to fetch transactions: ${(err as Error).message}` });
  }
});

export const depositRoutes = router;
