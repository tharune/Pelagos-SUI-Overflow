/**
 * Real mUSDC minting + balance reads against the SHARED `mock_usdc::Faucet`.
 * Minting is permissionless on-chain (anyone can mint); the backend dev-faucet
 * route signs with the protocol signer for convenience. mUSDC is the freely-
 * mintable collateral that keeps Pelagos's own contracts (vault / baskets /
 * tranche / PPN wrappers) un-bottlenecked vs faucet-gated dUSDC.
 */
import { Transaction } from '@mysten/sui/transactions';
import { getSuiClient, getSigner } from './predict/sui';

const USDC_TYPE =
  process.env.MOCK_USDC_TYPE ??
  '0x598434be38a69bf97b70490d320a698445990de38eb36e2f4c9d41dbe1ff3e45::mock_usdc::MOCK_USDC';
const FAUCET_ID =
  process.env.MOCK_USDC_FAUCET_ID ??
  '0xd1f67a0ec1d4b26631fcd1810f16bbc0fdf88a83cfe04c26ad400566528a07f0';
const DECIMALS = Number(process.env.MOCK_USDC_DECIMALS ?? 6);
const USDC_PKG = USDC_TYPE.split('::')[0];
// Matches MAX_PER_CALL in mock_usdc.move (1,000,000 mUSDC at 6dp).
const MAX_PER_CALL_RAW = 1_000_000_000_000n;

/**
 * Mint mUSDC to `recipient` via the shared faucet. Large requests are split into
 * multiple <=MAX_PER_CALL mint commands in one PTB so seeding pools isn't capped.
 */
export async function mintMockUsdc(
  recipient: string,
  displayAmount: number,
): Promise<{ digest: string; amount: number; recipient: string; explorer_url: string }> {
  if (!FAUCET_ID) throw new Error('MOCK_USDC_FAUCET_ID not configured');
  const client = getSuiClient();
  const signer = getSigner();
  let raw = BigInt(Math.round(displayAmount * 10 ** DECIMALS));
  if (raw <= 0n) throw new Error('amount must be positive');

  const tx = new Transaction();
  // Up to 16 chunks per tx keeps the PTB small; covers 16M mUSDC per call.
  let chunks = 0;
  while (raw > 0n && chunks < 16) {
    const amt = raw > MAX_PER_CALL_RAW ? MAX_PER_CALL_RAW : raw;
    tx.moveCall({
      target: `${USDC_PKG}::mock_usdc::mint`,
      arguments: [tx.object(FAUCET_ID), tx.pure.u64(amt), tx.pure.address(recipient)],
    });
    raw -= amt;
    chunks++;
  }
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true },
  });
  const status = res.effects?.status.status ?? 'unknown';
  if (status !== 'success') {
    throw new Error(`mint failed (${res.digest}): ${res.effects?.status.error}`);
  }
  // Block until the fullnode has indexed this tx. Without this, an immediate
  // `suix_getBalance` read after a mint (e.g. the /balances refresh fired right
  // after a sim settle) races the indexer and returns the STALE pre-mint balance.
  // Matches the waitForTransaction pattern used by vault/structured/distribution.
  await client.waitForTransaction({ digest: res.digest });
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

/** Add a permissionless mUSDC mint to an existing PTB (lets the combined test-funds
 *  faucet mint mUSDC + dispense dUSDC + SUI in a single wallet-free operator tx). */
export function addMintMockUsdc(tx: Transaction, recipient: string, displayAmount: number): void {
  const raw = BigInt(Math.round(displayAmount * 10 ** DECIMALS));
  if (raw <= 0n) return;
  tx.moveCall({
    target: `${USDC_PKG}::mock_usdc::mint`,
    arguments: [tx.object(FAUCET_ID), tx.pure.u64(raw), tx.pure.address(recipient)],
  });
}
