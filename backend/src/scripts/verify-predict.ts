/**
 * DeepBook Predict on-chain wiring smoke test.
 *
 * Proves the backend integration resolves against the live testnet package
 * using only read paths and devInspect — no signer, no dUSDC, no funds moved.
 *
 *   npx tsx src/scripts/verify-predict.ts [BTC|ETH|...]
 *
 * Checks, in order:
 *   1. predict-server indexer reachable (/config)
 *   2. an active oracle is discoverable
 *   3. create_manager resolves via devInspect (entry + package + PTB wiring)
 *   4. get_trade_amounts prices a live market via devInspect (oracle pricing)
 */
import * as predict from '../services/predict';
import { snapStrikeToGrid } from '../services/predict';

const underlying = (process.argv[2] || 'BTC').toUpperCase();
let failures = 0;

function ok(name: string, detail: unknown) {
  console.log(`  ✓ ${name}`);
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
}
function bad(name: string, err: unknown) {
  failures++;
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`  ✗ ${name}: ${msg}`);
}

/** Pull a plausible spot/forward from an oracle price payload of unknown shape. */
function numericFrom(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

async function main() {
  console.log('\nDeepBook Predict wiring check');
  console.log('Config:', JSON.stringify(predict.predictConfig()));
  console.log(
    `Signer: ${predict.signerAddress() ?? '(none — read/devInspect only)'}\n`,
  );

  // 1. Indexer reachable
  try {
    const cfg = await predict.predictServer.config();
    ok('predict-server /config reachable', { keys: Object.keys(cfg).slice(0, 6) });
  } catch (err) {
    bad('predict-server /config reachable', err);
  }

  // 2. Active oracle
  const oracle = await predict.findActiveOracle(underlying).catch(() => null);
  if (!oracle) {
    bad(`active ${underlying} oracle found`, 'none returned by indexer');
  } else {
    ok(`active ${underlying} oracle found`, {
      oracle_id: oracle.oracle_id,
      expiry: oracle.expiry,
      min_strike: oracle.min_strike,
      tick_size: oracle.tick_size,
    });
  }

  // 3. create_manager via devInspect (no oracle needed)
  try {
    const sim = await predict.simulateCreateManager();
    if (!sim.ok) throw new Error(`status=${sim.status} ${sim.error ?? ''}`);
    ok('create_manager resolves (devInspect)', sim);
  } catch (err) {
    bad('create_manager resolves (devInspect)', err);
  }

  // 4. get_trade_amounts via devInspect (live oracle pricing)
  if (oracle) {
    let target: number | undefined;
    try {
      const price = await predict.predictServer.oraclePriceLatest(oracle.oracle_id);
      target = numericFrom(price, ['price', 'forward', 'spot', 'mark', 'underlying_price']);
    } catch {
      /* best-effort: fall back to grid base */
    }
    const strike = snapStrikeToGrid(oracle, target);
    try {
      const preview = await predict.previewTrade({
        key: {
          oracleId: oracle.oracle_id,
          expiry: oracle.expiry,
          strike,
          isUp: true,
        },
        quantity: 1_000_000n,
      });
      ok(`get_trade_amounts priced UP @ strike ${strike}`, preview);
    } catch (err) {
      bad(`get_trade_amounts priced UP @ strike ${strike}`, err);
    }
  }

  console.log(
    failures === 0
      ? '\nAll checks passed — wiring resolves against the live package.\n'
      : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
