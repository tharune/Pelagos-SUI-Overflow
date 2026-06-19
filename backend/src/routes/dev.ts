import { Router, Request, Response } from 'express';
import { mintMockUsdc, usdcBalance } from '../services/mock-usdc';
import { dispenseDusdc, dusdcBalance } from '../services/dusdc-faucet';
import { listShares, confirmDigest, vaultConfigured } from '../services/vault';

const router = Router();

/** Real mUSDC faucet: mints testnet mUSDC to the wallet via the TreasuryCap. */
router.post('/airdrop-mock-usdc', async (req: Request, res: Response) => {
  const { walletAddress, amount } = req.body as { walletAddress?: string; amount?: number };
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });
  const amt = typeof amount === 'number' && amount > 0 ? amount : 1000;
  try {
    const result = await mintMockUsdc(walletAddress, amt);
    res.json({ chain: 'sui', walletAddress, ...result });
  } catch (err) {
    res.status(500).json({ error: `Airdrop failed: ${(err as Error).message}` });
  }
});

/**
 * dUSDC test grant: transfers a small, capped dUSDC float from the operator to
 * the wallet so the full DeepBook Predict flow (distribution / volatility / PPN
 * / tranche / term baskets) is testable end-to-end without the manual faucet.
 * dUSDC is faucet-gated (TreasuryCap is Mysten's), so this transfers — never
 * mints — and is bounded by the operator's float.
 */
router.post('/airdrop-dusdc', async (req: Request, res: Response) => {
  const { walletAddress, amount } = req.body as { walletAddress?: string; amount?: number };
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });
  const amt = typeof amount === 'number' && amount > 0 ? amount : 25;
  try {
    const result = await dispenseDusdc(walletAddress, amt);
    res.json({ chain: 'sui', walletAddress, ...result });
  } catch (err) {
    res.status(500).json({ error: `dUSDC grant failed: ${(err as Error).message}` });
  }
});

/** Live dUSDC balance for a wallet (Predict's faucet-gated quote asset). */
router.get('/dusdc-balance/:walletAddress', async (req: Request, res: Response) => {
  try {
    res.json({ chain: 'sui', wallet: req.params.walletAddress, dusdc: await dusdcBalance(req.params.walletAddress) });
  } catch (err) {
    res.status(500).json({ error: `Failed to read dUSDC balance: ${(err as Error).message}` });
  }
});

/** Real balances: live mUSDC balance + on-chain vault share receipts. */
router.get('/balances/:walletAddress', async (req: Request, res: Response) => {
  const wallet = req.params.walletAddress;
  try {
    const usdc = await usdcBalance(wallet);
    const pbu = vaultConfigured() ? await listShares(wallet) : [];
    res.json({ chain: 'sui', wallet, usdc, pbu });
  } catch (err) {
    res.status(500).json({ error: `Failed to read balances: ${(err as Error).message}` });
  }
});

/** Real digest status from the chain. */
router.get('/tx-status/:digest', async (req: Request, res: Response) => {
  try {
    const c = await confirmDigest(req.params.digest);
    res.json({
      chain: 'sui',
      digest: req.params.digest,
      status: c.ok ? 'success' : c.status,
      explorer_url: c.explorer_url,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to read tx status: ${(err as Error).message}` });
  }
});

export const devRoutes = router;
