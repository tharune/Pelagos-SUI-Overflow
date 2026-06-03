import { Router, Request, Response } from 'express';
import {
  createPPNVault,
  createTransaction,
  getActivePPNVault,
  getBundleById,
  getPPNVaultById,
  getPPNVaultsByWallet,
  updatePPNVaultOnchain,
} from '../db/queries';
import { confirmSuiDigest, derivedObjectsForBundle } from '../services/pelagos-chain';

const router = Router();

function maturityDate(days = 30): { iso: string; ts: number } {
  const ts = Date.now() + days * 86_400_000;
  return { iso: new Date(ts).toISOString(), ts: Math.floor(ts / 1000) };
}

function fees(amountUsdc: number) {
  const managementFee = amountUsdc * 0.001;
  const strategyFee = amountUsdc * 0.0005;
  return {
    managementFee,
    strategyFee,
    totalOpenFee: managementFee + strategyFee,
    netDeposit: amountUsdc - managementFee - strategyFee,
  };
}

function vaultObjectId(vaultId: string): string {
  return `sui-product:${vaultId}`;
}

function accruedYield(vault: {
  principal_usdc: number;
  estimated_apy: number;
  created_at: string;
  maturity_date: string;
}) {
  const created = new Date(vault.created_at).getTime();
  const maturity = new Date(vault.maturity_date).getTime();
  const now = Date.now();
  const elapsedDays = Math.max(0, (Math.min(now, maturity) - created) / 86_400_000);
  return vault.principal_usdc * (vault.estimated_apy / 100 / 365) * elapsedDays;
}

router.post('/onchain/prepare', async (req: Request, res: Response) => {
  try {
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
      tranche_kind?: 'senior' | 'mezzanine' | 'junior';
      tranche_attach?: number;
      tranche_detach?: number;
      price_per_token?: number;
    };

    if (!bundle_id || !wallet_address || !amount_usdc || amount_usdc <= 0) {
      return res.status(400).json({ error: 'bundle_id, wallet_address, and positive amount_usdc are required' });
    }
    const bundle = await getBundleById(bundle_id);
    if (!bundle) return res.status(404).json({ error: `Bundle not found: ${bundle_id}` });

    const maturity = maturityDate(maturity_days ?? 30);
    const fee = fees(amount_usdc);
    const vault = await createPPNVault({
      bundle_id,
      wallet_address,
      principal_usdc: amount_usdc,
      yield_deployed_usdc: 0,
      estimated_apy: 8,
      vault_address: vaultObjectId(`${bundle_id}:${wallet_address}:${Date.now()}`),
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
    if (!vault) return res.status(500).json({ error: 'Failed to create product vault' });

    const objects = derivedObjectsForBundle(bundle_id);
    res.json({
      kind: 'prepared',
      vault_id: vault.id,
      bundle_id,
      wallet_address,
      amount_usdc,
      management_fee_bps: 10,
      management_fee_usdc: fee.managementFee,
      strategy_fee_bps: 5,
      strategy_fee_usdc: fee.strategyFee,
      total_open_fee_usdc: fee.totalOpenFee,
      net_deposit_usdc: fee.netDeposit,
      estimated_apy: 8,
      maturity_date: maturity.iso,
      maturity_ts: maturity.ts,
      sui_market_id: objects.suiMarketId,
      sui_position_id: vault.vault_address,
      transaction_digest: null,
    });
  } catch (err) {
    console.error('POST /api/ppn/onchain/prepare error:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.post('/onchain/confirm', async (req: Request, res: Response) => {
  try {
    const { vault_id, signature } = req.body as { vault_id: string; signature: string };
    if (!vault_id || !signature) return res.status(400).json({ error: 'vault_id and signature are required' });
    if (!await confirmSuiDigest(signature)) {
      return res.status(400).json({ error: 'Sui transaction has not confirmed yet' });
    }
    const vault = await getPPNVaultById(vault_id);
    if (!vault) return res.status(404).json({ error: `Vault not found: ${vault_id}` });
    const updated = await updatePPNVaultOnchain(vault_id, { onchain_tx_signature: signature });
    const tx = await createTransaction({
      bundle_id: vault.bundle_id,
      wallet_address: vault.wallet_address,
      type: 'deposit',
      amount_usdc: vault.principal_usdc,
      tokens: 0,
      fee_usdc: vault.principal_usdc * 0.0015,
      tx_signature: signature,
    });
    res.json({
      vault_id,
      bundle_id: vault.bundle_id,
      wallet_address: vault.wallet_address,
      principal_usdc: vault.principal_usdc,
      signature,
      transaction_id: tx?.id ?? null,
      updated,
    });
  } catch (err) {
    console.error('POST /api/ppn/onchain/confirm error:', err);
    res.status(500).json({ error: String(err) });
  }
});

async function resolveVault(req: Request) {
  const { vault_id, bundle_id, wallet_address } = req.body as {
    vault_id?: string;
    bundle_id?: string;
    wallet_address?: string;
  };
  if (vault_id) return getPPNVaultById(vault_id);
  if (bundle_id && wallet_address) return getActivePPNVault(wallet_address, bundle_id);
  return null;
}

router.post('/onchain/redeem/prepare', async (req: Request, res: Response) => {
  try {
    const vault = await resolveVault(req);
    if (!vault) return res.status(404).json({ error: 'Active product vault not found' });
    const objects = derivedObjectsForBundle(vault.bundle_id);
    const strategyFee = vault.principal_usdc * 0.0005;
    res.json({
      kind: 'prepared',
      vault_id: vault.id,
      bundle_id: vault.bundle_id,
      wallet_address: vault.wallet_address,
      principal_usdc: vault.principal_usdc,
      strategy_fee_bps: 5,
      strategy_fee_usdc: strategyFee,
      expected_proceeds_usdc: Math.max(0, vault.principal_usdc - strategyFee),
      sui_market_id: objects.suiMarketId,
      sui_position_id: vault.vault_address,
      transaction_digest: null,
    });
  } catch (err) {
    console.error('POST /api/ppn/onchain/redeem/prepare error:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.post('/onchain/redeem/confirm', async (req: Request, res: Response) => {
  try {
    const { vault_id, signature } = req.body as { vault_id: string; signature: string };
    if (!vault_id || !signature) return res.status(400).json({ error: 'vault_id and signature are required' });
    const vault = await getPPNVaultById(vault_id);
    if (!vault) return res.status(404).json({ error: `Vault not found: ${vault_id}` });
    await updatePPNVaultOnchain(vault_id, {
      status: 'withdrawn',
      redemption_tx_signature: signature,
    });
    const tx = await createTransaction({
      bundle_id: vault.bundle_id,
      wallet_address: vault.wallet_address,
      type: 'redemption',
      amount_usdc: vault.principal_usdc,
      tokens: 0,
      fee_usdc: vault.principal_usdc * 0.0005,
      tx_signature: signature,
    });
    res.json({
      vault_id,
      bundle_id: vault.bundle_id,
      wallet_address: vault.wallet_address,
      principal_returned: vault.principal_usdc,
      signature,
      transaction_id: tx?.id ?? null,
    });
  } catch (err) {
    console.error('POST /api/ppn/onchain/redeem/confirm error:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.post('/onchain/divest/prepare', async (req: Request, res: Response) => {
  try {
    const vault = await resolveVault(req);
    if (!vault) return res.status(404).json({ error: 'Active product vault not found' });
    const objects = derivedObjectsForBundle(vault.bundle_id);
    res.json({
      kind: 'prepared',
      vault_id: vault.id,
      bundle_id: vault.bundle_id,
      wallet_address: vault.wallet_address,
      strategy_fee_bps: 5,
      estimated_strategy_fee_usdc: vault.principal_usdc * 0.0005,
      sui_market_id: objects.suiMarketId,
      sui_position_id: vault.vault_address,
      transaction_digest: null,
    });
  } catch (err) {
    console.error('POST /api/ppn/onchain/divest/prepare error:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.post('/onchain/divest/confirm', async (req: Request, res: Response) => {
  const { vault_id, signature } = req.body as { vault_id: string; signature: string };
  const vault = await getPPNVaultById(vault_id);
  if (!vault) return res.status(404).json({ error: `Vault not found: ${vault_id}` });
  res.json({
    vault_id,
    bundle_id: vault.bundle_id,
    wallet_address: vault.wallet_address,
    signature,
    status: 'active',
  });
});

router.post('/onchain/close/prepare', async (req: Request, res: Response) => {
  try {
    const vault = await resolveVault(req);
    if (!vault) return res.status(404).json({ error: 'Active product vault not found' });
    const objects = derivedObjectsForBundle(vault.bundle_id);
    const strategyFee = vault.principal_usdc * 0.0005;
    res.json({
      kind: 'prepared',
      vault_id: vault.id,
      bundle_id: vault.bundle_id,
      wallet_address: vault.wallet_address,
      principal_usdc: vault.principal_usdc,
      strategy_fee_bps: 5,
      estimated_strategy_fee_usdc: strategyFee,
      estimated_net_usdc: Math.max(0, vault.principal_usdc - strategyFee),
      sui_market_id: objects.suiMarketId,
      sui_position_id: vault.vault_address,
      transaction_digest: null,
    });
  } catch (err) {
    console.error('POST /api/ppn/onchain/close/prepare error:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.post('/onchain/close/confirm', async (req: Request, res: Response) => {
  try {
    const { vault_id, signature } = req.body as { vault_id: string; signature: string };
    const vault = await getPPNVaultById(vault_id);
    if (!vault) return res.status(404).json({ error: `Vault not found: ${vault_id}` });
    await updatePPNVaultOnchain(vault_id, {
      status: 'withdrawn',
      redemption_tx_signature: signature,
    });
    const tx = await createTransaction({
      bundle_id: vault.bundle_id,
      wallet_address: vault.wallet_address,
      type: 'redemption',
      amount_usdc: vault.principal_usdc,
      tokens: 0,
      fee_usdc: vault.principal_usdc * 0.0005,
      tx_signature: signature,
    });
    res.json({
      vault_id,
      bundle_id: vault.bundle_id,
      wallet_address: vault.wallet_address,
      principal_returned: vault.principal_usdc,
      signature,
      transaction_id: tx?.id ?? null,
      status: 'withdrawn',
    });
  } catch (err) {
    console.error('POST /api/ppn/onchain/close/confirm error:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.post('/tranche/sell/rfq', async (req: Request, res: Response) => {
  try {
    const { vault_ids } = req.body as { vault_ids?: string[]; wallet_address?: string };
    const ids = Array.isArray(vault_ids) ? vault_ids.filter(Boolean) : [];
    const quotes = await Promise.all(
      ids.map(async (id) => {
        const vault = await getPPNVaultById(id);
        if (!vault) return { vault_id: id, status: 'missing' as const, error: 'Vault not found' };
        const nowSec = Math.floor(Date.now() / 1000);
        const maturitySec = Math.floor(new Date(vault.maturity_date).getTime() / 1000);
        const matured = nowSec >= maturitySec;
        const base = vault.price_per_token && vault.price_per_token > 0
          ? vault.principal_usdc / vault.price_per_token
          : vault.principal_usdc;
        const haircutBps = matured ? 5 : 85;
        const indicativeUsdc = vault.principal_usdc * (1 - haircutBps / 10_000);
        return {
          vault_id: id,
          bundle_id: vault.bundle_id,
          tranche_kind: vault.tranche_kind ?? null,
          status: 'can_execute_onchain' as const,
          matured,
          maturity_ts: maturitySec,
          seconds_remaining: Math.max(0, maturitySec - nowSec),
          entry_price_per_token: vault.price_per_token ?? null,
          indicative_price_per_token: vault.price_per_token
            ? vault.price_per_token * (1 - haircutBps / 10_000)
            : undefined,
          indicative_price_pct: 100 - haircutBps / 100,
          indicative_usdc: indicativeUsdc,
          mm_spread_bps: matured ? 0 : 50,
          slippage_bps: matured ? 0 : 25,
          underwriting_bps: matured ? 0 : 10,
          total_haircut_bps: haircutBps,
          onchain_expected_usdc: indicativeUsdc,
          onchain_gross_usdc: base,
          onchain_basket_exit_fee_bps: matured ? 0 : 30,
          onchain_strategy_fee_bps: 5,
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
    res.status(500).json({ error: String(err) });
  }
});

router.get('/portfolio/:walletAddress', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    const vaults = await getPPNVaultsByWallet(walletAddress);
    const rows = await Promise.all(
      vaults.map(async (vault) => {
        const bundle = await getBundleById(vault.bundle_id);
        const created = new Date(vault.created_at).getTime();
        const maturity = new Date(vault.maturity_date).getTime();
        const now = Date.now();
        const daysElapsed = Math.max(0, (Math.min(now, maturity) - created) / 86_400_000);
        const daysRemaining = Math.max(0, (maturity - now) / 86_400_000);
        const accrued = accruedYield(vault);
        return {
          vault_id: vault.id,
          bundle_id: vault.bundle_id,
          bundle_name: bundle?.name ?? 'Unknown',
          bundle_status: bundle?.status ?? 'unknown',
          principal_usdc: vault.principal_usdc,
          yield_deployed_usdc: vault.yield_deployed_usdc,
          accrued_yield: accrued,
          projected_total_yield: vault.principal_usdc * (vault.estimated_apy / 100 / 365) * Math.max(1, daysElapsed + daysRemaining),
          estimated_apy: vault.estimated_apy,
          status: vault.status,
          days_elapsed: daysElapsed,
          days_remaining: daysRemaining,
          maturity_date: vault.maturity_date,
          created_at: vault.created_at,
          total_value: vault.principal_usdc + accrued,
          tranche_kind: vault.tranche_kind ?? null,
          tranche_attach: vault.tranche_attach ?? null,
          tranche_detach: vault.tranche_detach ?? null,
          price_per_token: vault.price_per_token ?? null,
        };
      }),
    );
    const totalPrincipal = rows.reduce((sum, row) => sum + row.principal_usdc, 0);
    const totalAccruedYield = rows.reduce((sum, row) => sum + row.accrued_yield, 0);
    res.json({
      wallet_address: walletAddress,
      vaults: rows,
      summary: {
        total_vaults: rows.length,
        total_principal: totalPrincipal,
        total_accrued_yield: totalAccruedYield,
        total_value: totalPrincipal + totalAccruedYield,
        principal_protected: true,
      },
    });
  } catch (err) {
    console.error('GET /api/ppn/portfolio/:walletAddress error:', err);
    res.status(500).json({ error: String(err) });
  }
});

export const ppnRoutes = router;
