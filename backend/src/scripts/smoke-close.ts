/**
 * Smoke: open a continuous distribution position then SELL/CLOSE it through the
 * AMM (unwind, mark-to-f minus fee + slippage). Verifies the on-chain sell path.
 *   npx tsx --tsconfig ./tsconfig.dev.json src/scripts/smoke-close.ts
 */
import 'dotenv/config';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { getSuiClient, getSigner } from '../services/predict/sui';
import {
  listContinuousMarketsLive,
  prepareContinuousOpen,
  confirmContinuousOpen,
  closeContinuousPosition,
} from '../services/distribution-continuous';

async function main() {
  const owner = process.env.SUI_ACTIVE_ADDRESS!;
  const client = getSuiClient();
  const signer = getSigner();

  const markets = await listContinuousMarketsLive();
  const m = markets.find((x) => x.source === 'polymarket') ?? markets[0];
  console.log(`market: ${m.id} "${m.question}" pool=$${m.pool_liquidity_usdc}`);

  const targetMu = Math.round(m.mu * 1.1 * 100) / 100;
  const targetSigma = Math.round(m.sigma * 0.7 * 100) / 100;
  const prep = await prepareContinuousOpen({ owner, marketId: m.id, targetMu, targetSigma, collateralUsdc: 10 });
  const tx = Transaction.from(fromBase64(prep.tx_bytes));
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, options: { showEffects: true } });
  console.log('OPEN digest:', res.digest, res.effects?.status.status, '| locked $', prep.collateral_usdc);
  const pos = await confirmContinuousOpen({ owner, marketId: m.id, targetMu, targetSigma, collateralUsdc: 10, digest: res.digest });

  const close = await closeContinuousPosition({ owner, positionId: pos.id });
  console.log('SELL/CLOSE via AMM:', {
    mark_usdc: close.mark_usdc,
    slippage_usdc: close.slippage_usdc,
    fee_usdc: close.fee_usdc,
    net_usdc: close.net_usdc,
    pnl_usdc: close.pnl_usdc,
    price_impact_bps: close.price_impact_bps,
    close_digest: close.close_digest,
  });
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); });
