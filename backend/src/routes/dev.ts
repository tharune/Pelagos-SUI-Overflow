import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { mintMockUsdc, usdcBalance } from '../services/mock-usdc';
import { dispenseDusdc, dusdcBalance, dispenseTestFunds } from '../services/dusdc-faucet';
import { listShares, confirmDigest, vaultConfigured } from '../services/vault';

const router = Router();

// The faucet routes (/faucet, /airdrop-mock-usdc, /airdrop-dusdc) spend the
// operator's dUSDC + SUI float (and mint mUSDC). They MUST stay reachable by the
// FE faucet button (so no requireAdmin), but with no gate an anonymous caller can
// loop them and drain the operator float. Two cheap, FE-compatible guards:
//   1) a per-IP rate limit, and
//   2) a per-recipient-wallet in-memory cooldown (default 60s).

/** Per-IP limiter for the float-spending faucet routes. */
const faucetIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many faucet requests, please try again later' },
});

// Per-recipient-wallet cooldown so one IP rotating wallets (or many IPs hitting
// the same wallet) still can't drain the float faster than once per window.
const FAUCET_COOLDOWN_MS = 60_000;
const lastDispenseAt = new Map<string, number>();

/**
 * Canonical cooldown key for a Sui address: lowercase 0x + 64 hex (zero-padded).
 * Without this, `0xabc` and `0x0abc` (the same address) hash to different keys
 * and a caller can bypass the cooldown by varying the zero-padding/case.
 */
function faucetKey(wallet: string): string {
  const hex = wallet.trim().toLowerCase().replace(/^0x/, '');
  return `0x${hex.padStart(64, '0')}`;
}

/** Returns null if the wallet may be served now, else seconds until it can. */
function faucetCooldownRemaining(wallet: string): number | null {
  const last = lastDispenseAt.get(faucetKey(wallet));
  const now = Date.now();
  if (last != null && now - last < FAUCET_COOLDOWN_MS) {
    return Math.ceil((FAUCET_COOLDOWN_MS - (now - last)) / 1000);
  }
  return null;
}

/**
 * Reserve the wallet's cooldown slot SYNCHRONOUSLY, right after the cooldown
 * check passes, so two concurrent calls for the same fresh wallet can't both
 * slip through the check-then-dispense window. On a dispense failure the caller
 * rolls this back via `clearDispense`, preserving the "a failed call doesn't
 * lock the wallet out for 60s" behavior.
 */
function recordDispense(wallet: string): void {
  lastDispenseAt.set(faucetKey(wallet), Date.now());
}

/** Roll back a provisional reservation when the dispense throws. */
function clearDispense(wallet: string): void {
  lastDispenseAt.delete(faucetKey(wallet));
}

/**
 * Combined "Test funds" faucet — one operator tx tops a wallet with every asset
 * the app uses: mUSDC (vault/baskets, minted), dUSDC (Predict quote, from the
 * operator float), and 0.05 SUI for gas so the user can sign their first tx.
 * Powers the header faucet's Mint button.
 */
router.post('/faucet', faucetIpLimiter, async (req: Request, res: Response) => {
  const { walletAddress } = req.body as { walletAddress?: string };
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });
  const wait = faucetCooldownRemaining(walletAddress);
  if (wait != null) return res.status(429).json({ error: `Faucet cooldown: try again in ${wait}s` });
  // Reserve the cooldown slot synchronously to close the concurrent-call window,
  // then roll it back if the dispense throws.
  recordDispense(walletAddress);
  try {
    const result = await dispenseTestFunds(walletAddress);
    res.json({ chain: 'sui', walletAddress, ...result });
  } catch (err) {
    clearDispense(walletAddress);
    res.status(500).json({ error: `Test-funds dispense failed: ${(err as Error).message}` });
  }
});

/** Real mUSDC faucet: mints testnet mUSDC to the wallet via the TreasuryCap. */
router.post('/airdrop-mock-usdc', faucetIpLimiter, async (req: Request, res: Response) => {
  const { walletAddress, amount } = req.body as { walletAddress?: string; amount?: number };
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });
  const wait = faucetCooldownRemaining(walletAddress);
  if (wait != null) return res.status(429).json({ error: `Faucet cooldown: try again in ${wait}s` });
  // Cap the mint so a single call can't request an unbounded mUSDC amount.
  const MAX_AIRDROP = 1_000_000;
  const amt = typeof amount === 'number' && amount > 0 ? Math.min(amount, MAX_AIRDROP) : 1000;
  // Reserve the cooldown slot synchronously to close the concurrent-call window,
  // then roll it back if the mint throws.
  recordDispense(walletAddress);
  try {
    const result = await mintMockUsdc(walletAddress, amt);
    res.json({ chain: 'sui', walletAddress, ...result });
  } catch (err) {
    clearDispense(walletAddress);
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
router.post('/airdrop-dusdc', faucetIpLimiter, async (req: Request, res: Response) => {
  const { walletAddress, amount } = req.body as { walletAddress?: string; amount?: number };
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });
  const wait = faucetCooldownRemaining(walletAddress);
  if (wait != null) return res.status(429).json({ error: `Faucet cooldown: try again in ${wait}s` });
  const amt = typeof amount === 'number' && amount > 0 ? amount : 25;
  // Reserve the cooldown slot synchronously to close the concurrent-call window,
  // then roll it back if the grant throws.
  recordDispense(walletAddress);
  try {
    const result = await dispenseDusdc(walletAddress, amt);
    res.json({ chain: 'sui', walletAddress, ...result });
  } catch (err) {
    clearDispense(walletAddress);
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
  // Reject malformed addresses before any Sui RPC so a bad param returns a
  // clean 400 instead of a raw RPC-driven 500.
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(wallet)) {
    return res.status(400).json({ error: 'invalid address' });
  }
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
