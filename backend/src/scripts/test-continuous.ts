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

  const conf = await api<{ confirmed: boolean; position: { id: string; realized_x: number } }>(
    'POST',
    '/api/distribution/continuous/open/confirm',
    { wallet_address: WALLET, market_id: m.id, target_mu: targetMu, target_sigma: targetSigma, collateral_usdc: collateral, signature: digest },
  );
  console.log(`confirm: recorded position ${conf.position.id.slice(0, 10)}… (realized x* = ${conf.position.realized_x} locked in)`);

  const { positions } = await api<{ positions: Array<{ id: string; settled: boolean }> }>(
    'GET',
    `/api/distribution/continuous/positions/${WALLET}`,
  );
  console.log(`open positions: ${positions.filter((p) => !p.settled).length}`);

  const settle = await api<{
    realized_x: number;
    payoff_usdc: number;
    net_usdc: number;
    pnl_usdc: number;
    settle_digest: string | null;
    explorer_url: string | null;
  }>('POST', '/api/distribution/continuous/settle', { wallet_address: WALLET, position_id: conf.position.id });
  console.log(`settle: resolved x* = ${settle.realized_x}  ->  payoff $${settle.payoff_usdc}, net returned $${settle.net_usdc}, P&L $${settle.pnl_usdc}`);
  console.log(`  payout digest: ${settle.settle_digest ?? '(total loss — no payout minted)'}${settle.explorer_url ? "  " + settle.explorer_url : ""}`);

  const consistent = settle.net_usdc === 0 || Math.abs(settle.pnl_usdc - settle.payoff_usdc) < 0.05;
  console.log(`\n${conf.confirmed && consistent ? "✓ PASS — open + settle both on testnet, P&L reconciles" : "✗ FAIL"}\n`);
  if (!conf.confirmed || !consistent) process.exit(1);
}

main().catch((e) => {
  console.error('\n✗ error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
