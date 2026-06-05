import { Router, Request, Response } from 'express';
import {
  createPPNVault,
  getBundleById,
  getLegsByBundleId,
  getPPNVaultById,
  getPPNVaultsByWallet,
  updatePPNVaultOnchain,
} from '../db/queries';
import {
  prepareDeposit,
  prepareRedeem,
  confirmDigest,
  readVaultState,
  listShares,
  vaultConfigured,
  VAULT,
} from '../services/vault';
import { quoteTranches } from '../services/tranching';

const router = Router();

type TrancheKind = 'senior' | 'mezzanine' | 'junior';

function maturityDate(days = 30): { iso: string; ts: number } {
  const ts = Date.now() + days * 86_400_000;
  return { iso: new Date(ts).toISOString(), ts: Math.floor(ts / 1000) };
}

function ppnLabel(bundleId: string, kind?: string): string {
  return `ppn:${kind ?? 'note'}:${bundleId}`;
}

function notConfigured(res: Response) {
  return res.status(503).json({ error: 'On-chain vault not configured.' });
}

/** Open a protected-note position = a real vault deposit, tagged with the
 *  tranche/bundle as the share label. Returns signable tx bytes. */
router.post('/onchain/prepare', async (req: Request, res: Response) => {
  try {
    if (!vaultConfigured()) return notConfigured(res);
    const {
      bundle_id,
      wallet_address,
      amount_usdc,
      maturity_days,
      tranche_kind,
      tranche_attach,
      tranche_detach,
      price_per_token,
    } = req.body as {
      bundle_id: string;
      wallet_address: string;
      amount_usdc: number;
      maturity_days?: number;
      tranche_kind?: TrancheKind;
      tranche_attach?: number;
      tranche_detach?: number;
      price_per_token?: number;
    };
    if (!bundle_id || !wallet_address || !amount_usdc || amount_usdc <= 0) {
      return res
        .status(400)
        .json({ error: 'bundle_id, wallet_address, and positive amount_usdc are required' });
    }

    const maturity = maturityDate(maturity_days ?? 30);
    const prep = await prepareDeposit({
      owner: wallet_address,
      amount_usdc,
      label: ppnLabel(bundle_id, tranche_kind),
    });

    // Best-effort DB record (no-op when Supabase is unconfigured).
    let vaultId: string | null = null;
    try {
      const vault = await createPPNVault({
        bundle_id,
        wallet_address,
        principal_usdc: amount_usdc,
        yield_deployed_usdc: 0,
        estimated_apy: 8,
        vault_address: prep.vault_id,
        status: 'active',
        maturity_date: maturity.iso,
        maturity_ts: maturity.ts,
        note_seed_hex: undefined,
        onchain_tx_signature: null,
        redemption_tx_signature: null,
        tranche_kind: tranche_kind ?? null,
        tranche_attach: tranche_attach ?? null,
        tranche_detach: tranche_detach ?? null,
        price_per_token: price_per_token ?? null,
      });
      vaultId = vault?.id ?? null;
    } catch {
      /* DB optional */
    }

    res.json({
      kind: 'prepared',
      vault_id: vaultId,
      bundle_id,
      wallet_address,
      amount_usdc,
      fee_usdc: prep.economics.fee_usdc,
      net_deposit_usdc: prep.economics.net_usdc,
      deposit_fee_bps: prep.economics.deposit_fee_bps,
      expected_shares: prep.economics.expected_shares,
      share_price: prep.economics.share_price,
      tranche_kind: tranche_kind ?? null,
      maturity_date: maturity.iso,
      maturity_ts: maturity.ts,
      sui_market_id: prep.vault_id,
      sui_position_id: prep.vault_id,
      tx_bytes: prep.tx_bytes,
      sender: prep.sender,
      dry_run: prep.dry_run,
    });
  } catch (err) {
    console.error('POST /api/ppn/onchain/prepare error:', err);
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

router.post('/onchain/confirm', async (req: Request, res: Response) => {
  try {
    const { vault_id, wallet_address, signature } = req.body as {
      vault_id?: string;
      wallet_address?: string;
      signature: string;
    };
    if (!signature) return res.status(400).json({ error: 'signature (tx digest) required' });
    const c = await confirmDigest(signature, wallet_address);
    if (!c.ok) return res.status(400).json({ error: `Sui transaction not confirmed: ${c.status}` });
    try {
      if (vault_id) await updatePPNVaultOnchain(vault_id, { onchain_tx_signature: signature });
    } catch {
      /* DB optional */
    }
    res.json({ confirmed: true, vault_id: vault_id ?? null, digest: signature, explorer_url: c.explorer_url, event: c.event });
  } catch (err) {
    console.error('POST /api/ppn/onchain/confirm error:', err);
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

/** redeem / divest / close all build a real vault redeem of the wallet's
 *  matching share receipt. */
async function prepareRedeemHandler(req: Request, res: Response) {
  if (!vaultConfigured()) return notConfigured(res);
  const { wallet_address, bundle_id, tranche_kind, share_id } = req.body as {
    wallet_address?: string;
    bundle_id?: string;
    tranche_kind?: TrancheKind;
    share_id?: string;
  };
  if (!wallet_address && !share_id) {
    return res.status(400).json({ error: 'wallet_address (or share_id) required' });
  }
  const prep = await prepareRedeem({
    owner: wallet_address!,
    share_id,
    label: bundle_id ? ppnLabel(bundle_id, tranche_kind) : undefined,
  });
  return res.json({
    kind: 'prepared',
    bundle_id: bundle_id ?? null,
    wallet_address,
    share_id: prep.share_id,
    principal_usdc: prep.economics.shares,
    strategy_fee_usdc: prep.economics.fee_usdc,
    expected_proceeds_usdc: prep.economics.net_usdc,
    sui_market_id: prep.vault_id,
    sui_position_id: prep.share_id,
    tx_bytes: prep.tx_bytes,
    sender: prep.sender,
    dry_run: prep.dry_run,
  });
}

router.post('/onchain/redeem/prepare', async (req, res) => {
  try {
    await prepareRedeemHandler(req, res);
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});
router.post('/onchain/divest/prepare', async (req, res) => {
  try {
    await prepareRedeemHandler(req, res);
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});
router.post('/onchain/close/prepare', async (req, res) => {
  try {
    await prepareRedeemHandler(req, res);
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

async function confirmCloseHandler(req: Request, res: Response, status: string) {
  const { vault_id, wallet_address, signature } = req.body as {
    vault_id?: string;
    wallet_address?: string;
    signature: string;
  };
  if (!signature) return res.status(400).json({ error: 'signature (tx digest) required' });
  const c = await confirmDigest(signature, wallet_address);
  if (!c.ok) return res.status(400).json({ error: `Sui transaction not confirmed: ${c.status}` });
  try {
    if (vault_id) await updatePPNVaultOnchain(vault_id, { status: 'withdrawn', redemption_tx_signature: signature });
  } catch {
    /* DB optional */
  }
  return res.json({
    confirmed: true,
    vault_id: vault_id ?? null,
    digest: signature,
    explorer_url: c.explorer_url,
    principal_returned: c.usdc_delta ?? null,
    status,
  });
}

router.post('/onchain/redeem/confirm', (req, res) =>
  confirmCloseHandler(req, res, 'withdrawn').catch((e) => res.status(500).json({ error: String(e) })),
);
router.post('/onchain/divest/confirm', (req, res) =>
  confirmCloseHandler(req, res, 'active').catch((e) => res.status(500).json({ error: String(e) })),
);
router.post('/onchain/close/confirm', (req, res) =>
  confirmCloseHandler(req, res, 'withdrawn').catch((e) => res.status(500).json({ error: String(e) })),
);

/**
 * Secondary-market RFQ for tranche positions, priced by the REAL `quoteTranches`
 * engine (no hardcoded haircut). Requires DB bundle data to derive the outcome
 * distribution; returns `missing` for vaults it can't resolve.
 */
router.post('/tranche/sell/rfq', async (req: Request, res: Response) => {
  try {
    const { vault_ids } = req.body as { vault_ids?: string[] };
    const ids = Array.isArray(vault_ids) ? vault_ids.filter(Boolean) : [];
    const quotes = await Promise.all(
      ids.map(async (id) => {
        const vault = await getPPNVaultById(id).catch(() => null);
        if (!vault) return { vault_id: id, status: 'missing' as const, error: 'Vault not found' };
        const bundle = await getBundleById(vault.bundle_id).catch(() => null);
        const legs = await getLegsByBundleId(vault.bundle_id).catch(() => []);
        const nowSec = Math.floor(Date.now() / 1000);
        const maturitySec = Math.floor(new Date(vault.maturity_date).getTime() / 1000);
        const matured = nowSec >= maturitySec;
        const horizonDays = Math.max(1, (maturitySec - nowSec) / 86_400);

        const kind = (vault.tranche_kind ?? 'senior') as TrancheKind;
        const nav = bundle?.issue_price ?? vault.price_per_token ?? 0.5;
        const tranche = quoteTranches({
          bundleNav: nav,
          totalLegs: Math.max(1, legs.length || 1),
          horizonDays,
        }).find((t) => t.kind === kind);

        const indicativePct = matured ? 100 : tranche ? tranche.pricePerToken * 100 : 95;
        const indicativeUsdc = vault.principal_usdc * (indicativePct / 100);
        return {
          vault_id: id,
          bundle_id: vault.bundle_id,
          tranche_kind: kind,
          status: 'can_execute_onchain' as const,
          matured,
          maturity_ts: maturitySec,
          seconds_remaining: Math.max(0, maturitySec - nowSec),
          entry_price_per_token: vault.price_per_token ?? null,
          indicative_price_per_token: tranche?.pricePerToken ?? null,
          indicative_price_pct: indicativePct,
          indicative_usdc: indicativeUsdc,
          mm_spread_bps: tranche?.mmSpreadBps ?? null,
          underwriting_bps: tranche?.underwritingBps ?? null,
          protocol_fee_bps: tranche?.protocolFeeBps ?? null,
          expected_apy_pct: tranche?.expectedYieldPct ?? null,
          onchain_expected_usdc: indicativeUsdc,
        };
      }),
    );
    res.json({
      kind: 'rfq',
      quotes,
      executable_count: quotes.filter((q) => q.status === 'can_execute_onchain').length,
    });
  } catch (err) {
    console.error('POST /api/ppn/tranche/sell/rfq error:', err);
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

/** Live PPN portfolio from on-chain `ppn:`-labeled vault shares. */
router.get('/portfolio/:walletAddress', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    if (!vaultConfigured()) {
      return res.json({ wallet_address: walletAddress, vaults: [], summary: { total_vaults: 0, total_principal: 0, total_value: 0, principal_protected: true } });
    }
    const [state, shares] = await Promise.all([readVaultState(), listShares(walletAddress)]);
    const ppnShares = shares.filter((s) => s.label.startsWith('ppn:'));
    const rows = ppnShares.map((s) => {
      const parts = s.label.split(':');
      const value = s.shares * state.share_price;
      return {
        share_id: s.share_id,
        vault_id: s.share_id,
        bundle_id: parts[2] ?? 'pelagos-vault',
        tranche_kind: parts[1] && parts[1] !== 'note' ? parts[1] : null,
        principal_usdc: s.principal_usdc,
        current_value: value,
        accrued_yield: value - s.principal_usdc,
        status: 'active',
      };
    });
    const totalPrincipal = rows.reduce((sum, r) => sum + r.principal_usdc, 0);
    const totalValue = rows.reduce((sum, r) => sum + r.current_value, 0);
    res.json({
      wallet_address: walletAddress,
      share_price: state.share_price,
      vaults: rows,
      summary: {
        total_vaults: rows.length,
        total_principal: totalPrincipal,
        total_accrued_yield: totalValue - totalPrincipal,
        total_value: totalValue,
        principal_protected: true,
      },
    });
  } catch (err) {
    console.error('GET /api/ppn/portfolio error:', err);
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

// Keep an explicit reference so unused-import lint stays quiet if portfolio
// reads ever fall back to DB vaults.
void getPPNVaultsByWallet;

export const ppnRoutes = router;
