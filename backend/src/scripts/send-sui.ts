/**
 * One-off: send testnet SUI gas from the protocol signer to an address.
 *   npx tsx --tsconfig ./tsconfig.dev.json src/scripts/send-sui.ts <to> <sui>
 */
import 'dotenv/config';
import { Transaction } from '@mysten/sui/transactions';
import { getSuiClient, getSigner } from '../services/predict/sui';

async function main() {
  const to = process.argv[2];
  const sui = Number(process.argv[3] ?? 0.1);
  if (!/^0x[0-9a-fA-F]{64}$/.test(to)) throw new Error('usage: send-sui.ts <0xaddr> <sui>');
  const client = getSuiClient();
  const signer = getSigner();
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(Math.round(sui * 1e9))]);
  tx.transferObjects([coin], tx.pure.address(to));
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, options: { showEffects: true } });
  console.log('SENT', sui, 'SUI ->', to, '| digest', res.digest, res.effects?.status.status);
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); });
