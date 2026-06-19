/**
 * dUSDC test-dispenser.
 *
 * dUSDC is the ONLY asset DeepBook Predict accepts as collateral, and unlike
 * mUSDC it is faucet-gated — its TreasuryCap belongs to Mysten, so we cannot
 * mint it. To keep the full Predict flow (distribution / volatility / PPN /
 * tranche / term baskets) testable end-to-end by anyone who connects a wallet,
 * the operator wallet holds a dUSDC float (topped up via the Predict faucet
 * form at https://tally.so/r/Xx102L) and dispenses a small, capped grant on
 * request. Operator-signed; it transfers — never mints — dUSDC.
 */
import { Transaction } from '@mysten/sui/transactions';
import { getSuiClient, getSigner, signerAddress } from './predict/sui';
import { PREDICT } from './predict/config';

const DECIMALS = PREDICT.dusdcDecimals;
/** Per-request ceiling — enough to mint a real structure and see it settle,
 *  small enough that the operator float serves many testers between top-ups. */
const MAX_GRANT_UI = Number(process.env.DUSDC_GRANT_MAX_UI ?? 25);

export async function dusdcBalance(owner: string): Promise<number> {
  const client = getSuiClient();
  const bal = await client.getBalance({ owner, coinType: PREDICT.dusdcType });
  return Number(BigInt(bal.totalBalance)) / 10 ** DECIMALS;
}

export interface DusdcGrant {
  digest: string;
  amount: number;
  recipient: string;
  explorer_url: string;
  operator_remaining: number;
}

/** Transfer `displayAmount` dUSDC (capped at MAX_GRANT_UI) from the operator
 *  float to `recipient`, signed by the operator. */
export async function dispenseDusdc(recipient: string, displayAmount: number): Promise<DusdcGrant> {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(recipient)) throw new Error('recipient (0x...) is required');
  const amt = Math.min(Math.max(0, displayAmount), MAX_GRANT_UI);
  if (amt <= 0) throw new Error('amount must be positive');
  const amountRaw = BigInt(Math.round(amt * 10 ** DECIMALS));

  const client = getSuiClient();
  const signer = getSigner();
  const operator = signerAddress();
  if (!operator) throw new Error('Operator signer not configured (SUI_PRIVATE_KEY) — cannot dispense dUSDC.');

  // Operator's dUSDC float (faucet-gated; we transfer, never mint).
  const { data } = await client.getCoins({ owner: operator, coinType: PREDICT.dusdcType });
  const total = data.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (total < amountRaw) {
    throw new Error(
      `Operator dUSDC float is low (${Number(total) / 10 ** DECIMALS} dUSDC left). ` +
        `Top up ${operator} via https://tally.so/r/Xx102L and retry.`,
    );
  }

  const tx = new Transaction();
  const [primary, ...rest] = data.map((c) => c.coinObjectId);
  if (rest.length > 0) {
    tx.mergeCoins(
      tx.object(primary),
      rest.map((id) => tx.object(id)),
    );
  }
  const [grant] = tx.splitCoins(tx.object(primary), [tx.pure.u64(amountRaw)]);
  tx.transferObjects([grant], tx.pure.address(recipient));

  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true },
  });
  const status = res.effects?.status.status ?? 'unknown';
  if (status !== 'success') {
    throw new Error(`dUSDC dispense failed (${res.digest}): ${res.effects?.status.error}`);
  }

  return {
    digest: res.digest,
    amount: amt,
    recipient,
    explorer_url: `https://suiscan.xyz/${process.env.SUI_NETWORK ?? 'testnet'}/tx/${res.digest}`,
    operator_remaining: (Number(total) - Number(amountRaw)) / 10 ** DECIMALS,
  };
}
