/**
 * Real mUSDC minting + balance reads. `mock_usdc::mint` is signed by the
 * protocol signer (which holds the TreasuryCap). Used by the dev faucet.
 */
import { Transaction } from '@mysten/sui/transactions';
import { getSuiClient, getSigner } from './predict/sui';

const USDC_TYPE =
  process.env.MOCK_USDC_TYPE ??
  '0xa630b97e9c5f1cd9804553018c9c14cf38a3ce51c341899ba7bc92a5f7c6a2af::mock_usdc::MOCK_USDC';
const TREASURY_CAP = process.env.MOCK_USDC_TREASURY_CAP_ID ?? '';
const DECIMALS = Number(process.env.MOCK_USDC_DECIMALS ?? 6);
const USDC_PKG = USDC_TYPE.split('::')[0];

export async function mintMockUsdc(
  recipient: string,
  displayAmount: number,
): Promise<{ digest: string; amount: number; recipient: string; explorer_url: string }> {
  if (!TREASURY_CAP) throw new Error('MOCK_USDC_TREASURY_CAP_ID not configured');
  const client = getSuiClient();
  const signer = getSigner();
  const raw = BigInt(Math.round(displayAmount * 10 ** DECIMALS));
  if (raw <= 0n) throw new Error('amount must be positive');

  const tx = new Transaction();
  tx.moveCall({
    target: `${USDC_PKG}::mock_usdc::mint`,
    arguments: [tx.object(TREASURY_CAP), tx.pure.u64(raw), tx.pure.address(recipient)],
  });
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true },
  });
  const status = res.effects?.status.status ?? 'unknown';
  if (status !== 'success') {
    throw new Error(`mint failed (${res.digest}): ${res.effects?.status.error}`);
  }
  return {
    digest: res.digest,
    amount: displayAmount,
    recipient,
    explorer_url: `https://suiscan.xyz/${process.env.SUI_NETWORK ?? 'testnet'}/tx/${res.digest}`,
  };
}

export async function usdcBalance(owner: string): Promise<number> {
  const client = getSuiClient();
  const bal = await client.getBalance({ owner, coinType: USDC_TYPE });
  return Number(BigInt(bal.totalBalance)) / 10 ** DECIMALS;
}
