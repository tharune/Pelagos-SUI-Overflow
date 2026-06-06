/**
 * End-to-end "every actionable button" verifier.
 *
 * Each on-chain button in the UI runs the same non-custodial flow:
 *   backend /prepare (builds a PTB, returns base64 tx_bytes)
 *     -> wallet signs + executes the bytes  (returns the tx digest)
 *       -> backend /confirm (verifies the digest, persists)
 *
 * This script SIMULATES the wallet using the configured server signer (the
 * Pelagos deployer, which holds mUSDC + gas) so we can drive the real backend
 * endpoints + real testnet execution headlessly — exactly what each button does
 * when a user clicks it. Every step prints a real digest you can open in the
 * explorer.
 *
 * Usage: npx tsx --tsconfig ./tsconfig.dev.json src/scripts/test-buttons.ts
 *   BUTTON_TEST_BASE  override backend base (default http://localhost:13101)
 */
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { getSuiClient, getSigner } from '../services/predict/sui';

const BASE = process.env.BUTTON_TEST_BASE ?? 'http://localhost:13101';
const client = getSuiClient();
const signer = getSigner();
const WALLET = signer.getPublicKey().toSuiAddress();

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function log(s: string) {
  console.log(s);
}
function pass(name: string, detail: string) {
  results.push({ name, ok: true, detail });
  log(`  ✓ ${name} — ${detail}`);
}
function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
  log(`  ✗ ${name} — ${detail}`);
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    const msg =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
  }
  return payload as T;
}

/** Simulate the wallet: sign + execute backend-built tx bytes, return digest. */
async function signExec(txBytesB64: string): Promise<string> {
  const tx = Transaction.from(fromBase64(txBytesB64));
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true },
  });
  if (res.effects?.status.status !== 'success') {
    throw new Error(`on-chain failure (${res.digest}): ${res.effects?.status.error ?? '?'}`);
  }
  // Let the fullnode index it so the next tx doesn't race on the gas coin.
  await client.waitForTransaction({ digest: res.digest }).catch(() => {});
  return res.digest;
}

const human = (mist: bigint, d = 9) => (Number(mist) / 10 ** d).toFixed(4);

async function main() {
  log(`\nPelagos button verifier`);
  log(`Backend: ${BASE}`);
  log(`Simulated wallet (deployer): ${WALLET}\n`);

  // Preflight: balances
  const sui = await client.getBalance({ owner: WALLET }).then((b) => BigInt(b.totalBalance));
  log(`Gas: ${human(sui)} SUI`);
  if (sui < 20_000_000n) {
    log(`⚠ low SUI gas — fund ${WALLET} from https://faucet.sui.io (testnet) before writes.`);
  }

  // Pick a live bundle.
  const bundles = await api<Array<{ id: string; name: string; status: string }>>('GET', '/api/bundles');
  const bundle = bundles.find((b) => b.status === 'active') ?? bundles[0];
  if (!bundle) throw new Error('no bundles from /api/bundles');
  log(`Bundle under test: ${bundle.name} (${bundle.id})\n`);

  // 1) FAUCET — "Get test mUSDC" (server-signed)
  log('[1] Faucet  POST /api/dev/airdrop-mock-usdc');
  try {
    const r = await api<{ digest: string }>('POST', '/api/dev/airdrop-mock-usdc', {
      walletAddress: WALLET,
      amount: 5000,
    });
    pass('faucet (Get test mUSDC)', `digest ${r.digest}`);
  } catch (e) {
    fail('faucet (Get test mUSDC)', (e as Error).message);
  }

  // 2) BASKET BUY — "Buy position"  (prepare -> sign -> confirm)
  log('\n[2] Basket Buy  /api/deposit/prepare -> sign -> /api/deposit/confirm');
  try {
    const prep = await api<{
      tx_bytes?: string;
      tokens_minted: number;
      issue_price: number;
      fee_usdc: number;
    }>('POST', '/api/deposit/prepare', {
      bundle_id: bundle.id,
      wallet_address: WALLET,
      amount_usdc: 25,
    });
    if (!prep.tx_bytes) throw new Error('no tx_bytes from prepare');
    const digest = await signExec(prep.tx_bytes);
    const conf = await api<{ tokens_minted: number }>('POST', '/api/deposit/confirm', {
      bundle_id: bundle.id,
      wallet_address: WALLET,
      amount_usdc: 25,
      signature: digest,
      tokens_minted: prep.tokens_minted,
      issue_price: prep.issue_price,
      fee_usdc: prep.fee_usdc,
    });
    pass('basket Buy position', `digest ${digest}, minted ${conf.tokens_minted}`);
  } catch (e) {
    fail('basket Buy position', (e as Error).message);
  }

  // 3) BASKET SELL — "Sell position" / portfolio "Redeem"
  log('\n[3] Basket Sell/Redeem  /api/deposit/redeem/prepare -> sign -> confirm');
  try {
    const prep = await api<{
      tx_bytes?: string;
      total_tokens: number;
      expected_usdc: number;
    }>('POST', '/api/deposit/redeem/prepare', {
      bundle_id: bundle.id,
      wallet_address: WALLET,
    });
    if (!prep.tx_bytes) throw new Error('no tx_bytes (no position to redeem?)');
    const digest = await signExec(prep.tx_bytes);
    await api('POST', '/api/deposit/redeem/confirm', {
      bundle_id: bundle.id,
      wallet_address: WALLET,
      signature: digest,
      expected_usdc: prep.expected_usdc,
      tokens_redeemed: prep.total_tokens,
    });
    pass('basket Sell/Redeem', `digest ${digest}, tokens ${prep.total_tokens}`);
  } catch (e) {
    fail('basket Sell/Redeem', (e as Error).message);
  }

  // 4) PPN DEPLOY — "Deploy protected note"
  log('\n[4] PPN Deploy  /api/ppn/onchain/prepare -> sign -> confirm');
  let ppnVaultId: string | null = null;
  try {
    const prep = await api<{ tx_bytes?: string; vault_id: string | null }>(
      'POST',
      '/api/ppn/onchain/prepare',
      { bundle_id: bundle.id, wallet_address: WALLET, amount_usdc: 100, maturity_days: 30 },
    );
    if (!prep.tx_bytes) throw new Error('no tx_bytes from ppn prepare');
    const digest = await signExec(prep.tx_bytes);
    ppnVaultId = prep.vault_id;
    const conf = await api<{ vault_id?: string | null }>('POST', '/api/ppn/onchain/confirm', {
      vault_id: prep.vault_id,
      wallet_address: WALLET,
      signature: digest,
    });
    ppnVaultId = ppnVaultId ?? conf.vault_id ?? null;
    pass('PPN Deploy protected note', `digest ${digest}, vault ${ppnVaultId ?? '(indexer-pending)'}`);
  } catch (e) {
    fail('PPN Deploy protected note', (e as Error).message);
  }

  // 5) TRANCHE BUY — "Buy <kind> tranche" (PPN prepare + tranche overlay)
  log('\n[5] Tranche Buy  /api/ppn/onchain/prepare (tranche overlay) -> sign -> confirm');
  try {
    const prep = await api<{ tx_bytes?: string; vault_id: string | null }>(
      'POST',
      '/api/ppn/onchain/prepare',
      {
        bundle_id: bundle.id,
        wallet_address: WALLET,
        amount_usdc: 100,
        maturity_days: 30,
        tranche_kind: 'senior',
        tranche_attach: 0,
        tranche_detach: 0.7,
        price_per_token: 0.9,
      },
    );
    if (!prep.tx_bytes) throw new Error('no tx_bytes from tranche prepare');
    const digest = await signExec(prep.tx_bytes);
    await api('POST', '/api/ppn/onchain/confirm', {
      vault_id: prep.vault_id,
      wallet_address: WALLET,
      signature: digest,
    });
    pass('tranche Buy (senior)', `digest ${digest}`);
  } catch (e) {
    fail('tranche Buy (senior)', (e as Error).message);
  }

  // 6) PPN EXIT — "Withdraw" / "Divest" / "Close" (all -> redeem on-chain)
  log('\n[6] PPN Exit (Withdraw/Divest/Close)  /api/ppn/onchain/redeem/prepare -> sign -> confirm');
  try {
    const prep = await api<{ tx_bytes?: string; vault_id?: string | null }>(
      'POST',
      '/api/ppn/onchain/redeem/prepare',
      ppnVaultId
        ? { wallet_address: WALLET, vault_id: ppnVaultId }
        : { wallet_address: WALLET, bundle_id: bundle.id },
    );
    if (!prep.tx_bytes) throw new Error('no tx_bytes (no redeemable PPN position?)');
    const digest = await signExec(prep.tx_bytes);
    await api('POST', '/api/ppn/onchain/redeem/confirm', {
      vault_id: prep.vault_id ?? ppnVaultId,
      wallet_address: WALLET,
      signature: digest,
    });
    pass('PPN Exit (Withdraw/Divest/Close)', `digest ${digest}`);
  } catch (e) {
    fail('PPN Exit (Withdraw/Divest/Close)', (e as Error).message);
  }

  // 7) DISTRIBUTION QUOTE — weight/normalize/reset/collateral controls
  log('\n[7] Distribution quote  GET candidates -> POST /api/distribution/quote');
  try {
    const cands = await api<{ candidates?: Array<{ id: string }> } | Array<{ id: string }>>(
      'GET',
      '/api/distribution/candidates?limit=4&refresh=true',
    );
    const list = Array.isArray(cands) ? cands : (cands.candidates ?? []);
    const cand = list[0];
    if (!cand) throw new Error('no distribution candidates');
    const quoteWith = (n: number) =>
      api<Record<string, unknown>>('POST', '/api/distribution/quote', {
        candidate_id: cand.id,
        weights: Array.from({ length: n }, () => 100 / n),
        collateral_usdc: 1000,
      });
    // The band count is per-candidate; derive it from the validation error.
    const q = await quoteWith(7).catch((e: Error) => {
      const m = /Expected (\d+) curve weights/.exec(e.message);
      if (m) return quoteWith(Number(m[1]));
      throw e;
    });
    pass('distribution quote', `keys ${Object.keys(q).slice(0, 6).join(',')}`);
  } catch (e) {
    fail('distribution quote', (e as Error).message);
  }

  // 8) DISTRIBUTION SUBMIT — "Submit distribution trade" (launch plan)
  log('\n[8] Distribution submit  POST /api/distribution/launch-plan');
  try {
    const cands = await api<{ candidates?: Array<{ id: string }> } | Array<{ id: string }>>(
      'GET',
      '/api/distribution/candidates?limit=4',
    );
    const list = Array.isArray(cands) ? cands : (cands.candidates ?? []);
    const cand = list[0];
    if (!cand) throw new Error('no distribution candidates');
    const plan = await api<Record<string, unknown>>('POST', '/api/distribution/launch-plan', {
      candidate_id: cand.id,
    });
    pass('distribution submit (launch-plan)', `keys ${Object.keys(plan).slice(0, 6).join(',')}`);
  } catch (e) {
    fail('distribution submit (launch-plan)', (e as Error).message);
  }

  // ---- summary ----
  const passed = results.filter((r) => r.ok).length;
  log(`\n========================================`);
  log(`RESULT: ${passed}/${results.length} button flows passed`);
  for (const r of results) log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
  log(`========================================\n`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error('\nharness error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
