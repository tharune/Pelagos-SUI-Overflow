import { Router, Request, Response } from 'express';

const router = Router();

router.post('/airdrop-mock-usdc', async (req: Request, res: Response) => {
  const { walletAddress, amount } = req.body as {
    walletAddress?: string;
    amount?: number;
  };
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });
  res.json({
    chain: 'sui',
    walletAddress,
    amount: typeof amount === 'number' ? amount : 1000,
    message: 'Use POST /api/sui/mock-usdc/mint for Sui testnet mock USDC.',
  });
});

router.get('/balances/:walletAddress', async (req: Request, res: Response) => {
  res.json({
    chain: 'sui',
    wallet: req.params.walletAddress,
    usdc: 0,
    pbu: [],
  });
});

router.get('/tx-status/:digest', async (req: Request, res: Response) => {
  res.json({
    chain: 'sui',
    digest: req.params.digest,
    status: 'confirmed',
  });
});

export const devRoutes = router;
