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
import { addMintMockUsdc } from './mock-usdc';
import { PREDICT } from './predict/config';

const DECIMALS = PREDICT.dusdcDecimals;
/** Per-request ceiling — enough to mint a real structure and see it settle,
 *  small enough that the operator float serves many testers between top-ups. */
const MAX_GRANT_UI = Number(process.env.DUSDC_GRANT_MAX_UI ?? 25);

// The combined "Test funds" grant — one operator tx tops a wallet with all three
// assets the app uses. mUSDC mints freely; dUSDC comes from the operator float
// (faucet-gated); SUI is gas so the user can actually sign their first tx.
const DUSDC_GRANT_UI = Math.min(25, MAX_GRANT_UI);
const MUSDC_GRANT_UI = Number(process.env.MUSDC_GRANT_UI ?? 10_000);
// 0.4 SUI. The heavy dUSDC DeepBook Predict opens (multi-leg strips/baskets) now
// pin an explicit gas budget (PREDICT_OPEN_GAS_BUDGET_MIST, see structured.ts), so
// the wallet no longer reserves the full ~1.2-1.7 SUI auto-estimate — 0.4 SUI
// covers create_manager + the pinned open + a redeem with headroom, while the
// cheap mUSDC vault rail uses a fraction of it. Override with SUI_GRANT_MIST.
// NOTE: validate the pinned budget against a funded multi-leg dUSDC open before
// relying on the heaviest products; if they fail insufficient-gas, raise both
// PREDICT_OPEN_GAS_BUDGET_MIST and this grant.
const SUI_GRANT_MIST = BigInt(process.env.SUI_GRANT_MIST ?? 400_000_000); // 0.4 SUI

export interface TestFundsGrant {
  digest: string;
  dusdc: number;
  musdc: number;
  sui: number;
  explorer_url: string;
}

// Serialize ALL operator-signed dispenses through a single in-process promise
// chain. Each dispense reads the operator's primary coin (getCoins → merge →
// split → signAndExecute); running two concurrently against DIFFERENT recipients
// would have them both build on the SAME stale coin version, so the second tx
// aborts with an object-version conflict. The queue forces them one-at-a-time so
// each sees the previous tx's committed coin state.
let opQueue: Promise<unknown> = Promise.resolve();
function enqueueOp<T>(op: () => Promise<T>): Promise<T> {
  const run = opQueue.then(op, op);
  // Keep the chain alive even if a dispense rejects (swallow only for the gate,
  // the real result/error still propagates to the caller via `run`).
  opQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Mint mUSDC + transfer dUSDC + transfer the SUI gas grant to `recipient` in ONE
 *  operator-signed PTB. Atomic, one digest, one fee. */
export async function dispenseTestFunds(recipient: string): Promise<TestFundsGrant> {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(recipient)) throw new Error('recipient (0x...) is required');
  // Serialized through the operator queue: this PTB mints/splits from the
  // operator's primary mUSDC/dUSDC/gas coins, which must not race another dispense.
  return enqueueOp(async () => {
  const client = getSuiClient();
  const signer = getSigner();
  const operator = signerAddress();
  if (!operator) throw new Error('Operator signer not configured (SUI_PRIVATE_KEY) — cannot dispense test funds.');

  const tx = new Transaction();

  // 1. mUSDC — permissionless mint straight to the recipient.
  addMintMockUsdc(tx, recipient, MUSDC_GRANT_UI);

  // 2. dUSDC — from the operator float (degrade to the remainder if low).
  const wantDusdc = BigInt(Math.round(DUSDC_GRANT_UI * 10 ** DECIMALS));
  const { data: dusdcCoins } = await client.getCoins({ owner: operator, coinType: PREDICT.dusdcType });
  const dusdcTotal = dusdcCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const giveDusdc = wantDusdc < dusdcTotal ? wantDusdc : dusdcTotal;
  if (giveDusdc > 0n && dusdcCoins.length > 0) {
    const [primary, ...rest] = dusdcCoins.map((c) => c.coinObjectId);
    if (rest.length > 0) tx.mergeCoins(tx.object(primary), rest.map((id) => tx.object(id)));
    const [d] = tx.splitCoins(tx.object(primary), [tx.pure.u64(giveDusdc)]);
    tx.transferObjects([d], tx.pure.address(recipient));
  }

  // 3. SUI for gas — split from the operator's gas coin.
  const [s] = tx.splitCoins(tx.gas, [tx.pure.u64(SUI_GRANT_MIST)]);
  tx.transferObjects([s], tx.pure.address(recipient));

  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, options: { showEffects: true } });
  const status = res.effects?.status.status ?? 'unknown';
  if (status !== 'success') throw new Error(`test-funds dispense failed (${res.digest}): ${res.effects?.status.error}`);

  return {
    digest: res.digest,
    dusdc: Number(giveDusdc) / 10 ** DECIMALS,
    musdc: MUSDC_GRANT_UI,
    sui: Number(SUI_GRANT_MIST) / 1e9,
    explorer_url: `https://suiscan.xyz/${process.env.SUI_NETWORK ?? 'testnet'}/tx/${res.digest}`,
  };
  });
}

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
  const want = Math.min(Math.max(0, displayAmount), MAX_GRANT_UI);
  if (want <= 0) throw new Error('amount must be positive');

  // Serialized through the operator queue: same operator dUSDC float as
  // dispenseTestFunds, so concurrent dispenses must not race the primary coin.
  return enqueueOp(async () => {
  const client = getSuiClient();
  const signer = getSigner();
  const operator = signerAddress();
  if (!operator) throw new Error('Operator signer not configured (SUI_PRIVATE_KEY) — cannot dispense dUSDC.');

  // Operator's dUSDC float (faucet-gated; we transfer, never mint). Dispense the
  // requested grant, or whatever the float still holds if it's running low — so
  // the faucet degrades gracefully instead of hard-failing on the last drops.
  const { data } = await client.getCoins({ owner: operator, coinType: PREDICT.dusdcType });
  const total = data.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (total <= 0n) {
    throw new Error(
      `Operator dUSDC float is empty. Top up ${operator} via https://tally.so/r/Xx102L and retry.`,
    );
  }
  const wantRaw = BigInt(Math.round(want * 10 ** DECIMALS));
  const amountRaw = wantRaw < total ? wantRaw : total;
  const amt = Number(amountRaw) / 10 ** DECIMALS;

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
  });
}
