/**
 * Smoke test: full on-chain round trip for a CONTINUOUS distribution position
 * on a real Polymarket-derived forward — open (escrow collateral) → confirm →
 * settle (protocol pays the realized net). Run:
 *   npx tsx --tsconfig ./tsconfig.dev.json src/scripts/smoke-continuous.ts
 */
import 'dotenv/config';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { getSuiClient, getSigner } from '../services/predict/sui';
import {
  listContinuousMarketsLive,
  prepareContinuousOpen,
  confirmContinuousOpen,
  settleContinuousPosition,
} from '../services/distribution-continuous';

async function main() {
  const owner = process.env.SUI_ACTIVE_ADDRESS!;
  const client = getSuiClient();
  const signer = getSigner();

  // Warm the cache + pick the first real Polymarket forward.
  const markets = await listContinuousMarketsLive();
  const m = markets.find((x) => x.source === 'polymarket') ?? markets[0];
  if (!m) throw new Error('no continuous markets discovered');
  console.log(`market: ${m.id} "${m.question}" f=N(${m.mu}, ${m.sigma}) pool=$${m.pool_liquidity_usdc}`);

  // A confident view: shift the mean up ~15%, tighter sigma.
  const targetMu = Math.round(m.mu * 1.15 * 100) / 100;
  const targetSigma = Math.round(m.sigma * 0.6 * 100) / 100;
  const collateralUsdc = 10;

  const prep = await prepareContinuousOpen({ owner, marketId: m.id, targetMu, targetSigma, collateralUsdc });
  console.log('open prepare · lock $', prep.collateral_usdc, '· dry_run:', prep.dry_run);

  const tx = Transaction.from(fromBase64(prep.tx_bytes));
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, options: { showEffects: true } });
  console.log('OPEN digest:', res.digest, 'status:', res.effects?.status.status);

  const pos = await confirmContinuousOpen({ owner, marketId: m.id, targetMu, targetSigma, collateralUsdc, digest: res.digest });
  console.log('position recorded · realized_x =', pos.realized_x, '· max_profit $', pos.max_profit_usdc);

  const settle = await settleContinuousPosition({ owner, positionId: pos.id });
  console.log('SETTLE:', {
    realized_x: settle.realized_x,
    payoff_usdc: settle.payoff_usdc,
    net_usdc: settle.net_usdc,
    pnl_usdc: settle.pnl_usdc,
    settle_digest: settle.settle_digest,
  });
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
