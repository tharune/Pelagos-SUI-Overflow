/**
 * End-to-end test of the continuous distribution market with a REAL on-chain
 * collateral deposit. Simulates the wallet with the deployer signer.
 *
 *   GET  markets -> POST quote -> POST open/prepare -> sign+execute (real Sui tx)
 *   -> POST open/confirm -> GET positions
 */
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { getSuiClient, getSigner } from '../services/predict/sui';

const BASE = process.env.BUTTON_TEST_BASE ?? 'http://localhost:13101';
const client = getSuiClient();
const signer = getSigner();
const WALLET = signer.getPublicKey().toSuiAddress();

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

async function signExec(txBytesB64: string): Promise<string> {
  const tx = Transaction.from(fromBase64(txBytesB64));
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, options: { showEffects: true } });
  if (res.effects?.status.status !== 'success') {
    throw new Error(`on-chain failure (${res.digest}): ${res.effects?.status.error}`);
  }
  await client.waitForTransaction({ digest: res.digest }).catch(() => {});
  return res.digest;
}

async function main() {
  console.log(`\nContinuous distribution market — on-chain test`);
  console.log(`wallet (deployer): ${WALLET}\n`);

  const { markets } = await api<{ markets: Array<{ id: string; mu: number; sigma: number; question: string }> }>(
    'GET',
    '/api/distribution/continuous/markets',
  );
  const m = markets[0];
  console.log(`market: ${m.question}  mu=${m.mu} sigma=${m.sigma}`);

  // A bullish, more-confident view: mean above market, tighter sigma.
  const targetMu = Math.round(m.mu + m.sigma * 0.6);
  const targetSigma = Math.round(m.sigma * 0.8);
  const collateral = 25;

  const quote = await api<{
    collateral_required_usdc: number;
    max_profit_usdc: number;
    max_loss_usdc: number;
    expected_value_usdc: number;
  }>('POST', '/api/distribution/continuous/quote', {
    market_id: m.id,
    target_mu: targetMu,
    target_sigma: targetSigma,
    collateral_usdc: collateral,
  });
  console.log(`quote: view mu=${targetMu} sigma=${targetSigma} collateral=$${collateral}`);
  console.log(
    `  locks $${quote.collateral_required_usdc} | max profit $${quote.max_profit_usdc} | max loss $${quote.max_loss_usdc} | EV(if right) $${quote.expected_value_usdc}`,
  );

  const prep = await api<{ tx_bytes: string; label: string; dry_run: { ok: boolean; status: string } }>(
    'POST',
    '/api/distribution/continuous/open/prepare',
    { wallet_address: WALLET, market_id: m.id, target_mu: targetMu, target_sigma: targetSigma, collateral_usdc: collateral },
  );
  console.log(`prepare: label="${prep.label}" dry_run=${prep.dry_run.status}`);

  const digest = await signExec(prep.tx_bytes);
  console.log(`  ✓ on-chain open digest: ${digest}`);

  const conf = await api<{ confirmed: boolean; explorer_url: string }>(
    'POST',
    '/api/distribution/continuous/open/confirm',
    { signature: digest },
  );
  console.log(`confirm: confirmed=${conf.confirmed}  ${conf.explorer_url}`);

  const { positions } = await api<{ positions: Array<{ market_id: string; target_mu: number; target_sigma: number; collateral_usdc: number }> }>(
    'GET',
    `/api/distribution/continuous/positions/${WALLET}`,
  );
  const mine = positions.filter((p) => p.market_id === m.id);
  console.log(`positions on-chain: ${positions.length} (this market: ${mine.length})`);
  for (const p of mine.slice(0, 3)) console.log(`  - mu=${p.target_mu} sigma=${p.target_sigma} collateral=$${p.collateral_usdc}`);

  console.log(`\n${conf.confirmed && mine.length > 0 ? '✓ PASS — continuous distribution trade settled on testnet' : '✗ FAIL'}\n`);
  if (!conf.confirmed || mine.length === 0) process.exit(1);
}

main().catch((e) => {
  console.error('\n✗ error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
