/**
 * One-off smoke test: real deposit + redeem through the on-chain vault using
 * the backend's own PTB builders. Run with `npx tsx src/scripts/smoke-vault.ts`.
 */
import 'dotenv/config';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { getSuiClient, getSigner } from '../services/predict/sui';
import { prepareDeposit, prepareRedeem, confirmDigest, readVaultState, listShares } from '../services/vault';

async function main() {
  const owner = process.env.SUI_ACTIVE_ADDRESS!;
  const amount = Number(process.argv[2] ?? process.env.SMOKE_AMOUNT ?? 5);
  const client = getSuiClient();
  const signer = getSigner();

  console.log('vault state before:', await readVaultState());

  // --- deposit `amount` mUSDC (default 5; override via argv/SMOKE_AMOUNT) ---
  const dep = await prepareDeposit({ owner, amount_usdc: amount, label: 'PBU-HIGH-SHORT' });
  console.log('deposit economics:', dep.economics, '| dry_run:', dep.dry_run);
  const depTx = Transaction.from(fromBase64(dep.tx_bytes));
  const depRes = await client.signAndExecuteTransaction({
    transaction: depTx,
    signer,
    options: { showEffects: true },
  });
  console.log('DEPOSIT digest:', depRes.digest, 'status:', depRes.effects?.status.status);
  console.log('confirm:', await confirmDigest(depRes.digest, owner));

  const sharesAfter = await listShares(owner);
  console.log('shares after deposit:', sharesAfter.length, sharesAfter.slice(-1));
  console.log('vault state after deposit:', await readVaultState());

  // --- redeem that position ---
  const red = await prepareRedeem({ owner, label: 'PBU-HIGH-SHORT' });
  console.log('redeem economics:', red.economics, '| dry_run:', red.dry_run);
  const redTx = Transaction.from(fromBase64(red.tx_bytes));
  const redRes = await client.signAndExecuteTransaction({
    transaction: redTx,
    signer,
    options: { showEffects: true },
  });
  console.log('REDEEM digest:', redRes.digest, 'status:', redRes.effects?.status.status);
  console.log('confirm redeem:', await confirmDigest(redRes.digest, owner));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
