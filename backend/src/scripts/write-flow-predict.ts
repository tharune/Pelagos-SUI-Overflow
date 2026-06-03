/**
 * DeepBook Predict end-to-end WRITE proof.
 *
 * Goes beyond verify-predict.ts (which is read/devInspect only) by executing the
 * full on-chain write path against live testnet through the same backend wiring
 * the /api/predict routes use:
 *
 *   create_manager -> deposit+mint -> (read position) -> redeem
 *                                  -> supply -> withdraw
 *
 * Requires a funded testnet signer holding dUSDC + some SUI for gas:
 *   - PREDICT_SIGNER_PRIVATE_KEY=suiprivkey... (or base64), OR
 *   - SUI_KEYSTORE_PATH (+ SUI_ACTIVE_ADDRESS) pointing at your Sui CLI keystore
 *   - dUSDC is faucet-gated (NOT testnet USDC): request via https://tally.so/r/Xx102L
 *
 * Usage:
 *   npx tsx src/scripts/write-flow-predict.ts [BTC] [quantity] [supplyAmount]
 *       # preflight + preview + devInspect simulate only (NO writes) — safe default
 *   npx tsx src/scripts/write-flow-predict.ts [BTC] [quantity] [supplyAmount] --execute
 *       # actually submits the transactions (moves real testnet dUSDC)
 *
 * quantity / supplyAmount are raw u64 (dUSDC has 6 decimals -> 1_000_000 = 1.0).
 */
import * as predict from '../services/predict';
import { snapStrikeToGrid } from '../services/predict';
import { getSuiClient, signerAddress } from '../services/predict/sui';
import { PREDICT } from '../services/predict/config';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const positional = args.filter((a) => !a.startsWith('--'));
const underlying = (positional[0] || 'BTC').toUpperCase();
const QUANTITY = BigInt(positional[1] || '1000000'); // 1.0 contract
const SUPPLY_AMOUNT = BigInt(positional[2] || '1000000'); // 1.0 dUSDC

// SUI gas guardrails (9 decimals). Refuse to start writes below MIN; warn below REC.
const SUI_MIN_MIST = 20_000_000n; // 0.02 SUI
const SUI_REC_MIST = 100_000_000n; // 0.10 SUI

function human(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}
const dusdc = (raw: bigint) => `${human(raw, PREDICT.dusdcDecimals)} dUSDC (${raw} raw)`;
const sui = (mist: bigint) => `${human(mist, 9)} SUI (${mist} mist)`;

function step(n: number, label: string) {
  console.log(`\n[${n}] ${label}`);
}
function done(label: string, r: { digest: string; explorer_url: string }) {
  console.log(`  ✓ ${label}`);
  console.log(`      digest:   ${r.digest}`);
  console.log(`      explorer: ${r.explorer_url}`);
}

async function main() {
  console.log('\nDeepBook Predict — write-path proof');
  console.log('Config:', JSON.stringify(predict.predictConfig()));
  console.log(`Mode:   ${EXECUTE ? 'EXECUTE (real on-chain writes)' : 'DRY-RUN (preflight + devInspect only)'}`);

  // --- Preflight: signer + funding ------------------------------------------
  const owner = signerAddress();
  if (!owner) {
    console.error(
      '\n✗ No signer configured. To prove the write path, provide a funded testnet key:\n' +
        '    PREDICT_SIGNER_PRIVATE_KEY=suiprivkey...   (in backend/.env), or\n' +
        '    SUI_KEYSTORE_PATH=/path/to/.sui/sui_config  (+ SUI_ACTIVE_ADDRESS=0x...)\n' +
        '  The signer must hold dUSDC (faucet form https://tally.so/r/Xx102L) and some SUI for gas.',
    );
    process.exit(1);
  }
  console.log(`Signer: ${owner}\n`);

  const client = getSuiClient();
  const [suiBal, dusdcBal] = await Promise.all([
    client.getBalance({ owner }).then((b) => BigInt(b.totalBalance)),
    client
      .getBalance({ owner, coinType: PREDICT.dusdcType })
      .then((b) => BigInt(b.totalBalance))
      .catch(() => 0n),
  ]);
  console.log('Balances:');
  console.log(`  SUI (gas):  ${sui(suiBal)}`);
  console.log(`  dUSDC:      ${dusdc(dusdcBal)}`);

  // --- Pick a live market + price the trade ---------------------------------
  const oracle = await predict.findActiveOracle(underlying);
  if (!oracle) {
    console.error(`\n✗ No active ${underlying} oracle from the indexer; cannot price a trade.`);
    process.exit(1);
  }
  let target: number | undefined;
  try {
    const price = await predict.predictServer.oraclePriceLatest(oracle.oracle_id);
    for (const k of ['price', 'forward', 'spot', 'mark', 'underlying_price']) {
      const n = Number((price as Record<string, unknown>)[k]);
      if (Number.isFinite(n) && n > 0) {
        target = n;
        break;
      }
    }
  } catch {
    /* fall back to grid base */
  }
  const strike = snapStrikeToGrid(oracle, target);
  const key = { oracleId: oracle.oracle_id, expiry: oracle.expiry, strike, isUp: true };
  console.log(`\nMarket: ${underlying} UP @ strike ${strike} (oracle ${oracle.oracle_id}, expiry ${oracle.expiry})`);

  const preview = await predict.previewTrade({ key, quantity: QUANTITY });
  const mintCost = BigInt(preview.mint_cost);
  const redeemPayout = BigInt(preview.redeem_payout);
  console.log(
    `Preview qty ${QUANTITY}: mint_cost ${dusdc(mintCost)}, redeem_payout ${dusdc(redeemPayout)}`,
  );

  // Deposit a little over preview cost to absorb price drift between preview and exec.
  const depositNeeded = (mintCost * 5n) / 4n + 1n; // ~1.25x
  const requiredForFull = depositNeeded + SUPPLY_AMOUNT;
  console.log(
    `\nFunding plan: deposit ${dusdc(depositNeeded)} for mint, ${dusdc(SUPPLY_AMOUNT)} for supply ` +
      `=> need ${dusdc(requiredForFull)} total.`,
  );

  const canMint = dusdcBal >= depositNeeded;
  const canSupply = dusdcBal >= requiredForFull;
  if (!canMint) {
    console.log(
      `\n⚠ dUSDC balance ${dusdc(dusdcBal)} is below the mint requirement ${dusdc(depositNeeded)}.\n` +
        `  Request dUSDC via the DeepBook Predict form: https://tally.so/r/Xx102L`,
    );
  } else if (!canSupply) {
    console.log(
      `\n⚠ Enough for mint/redeem but not the extra ${dusdc(SUPPLY_AMOUNT)} for supply/withdraw; ` +
        `the supply phase will be skipped.`,
    );
  }

  if (!EXECUTE) {
    // Safe path: prove the mint resolves on-chain via devInspect, move nothing.
    step(0, 'devInspect simulate mint (no funds moved)');
    const sim = await predict.simulateMint({
      managerId: PREDICT.predictObjectId, // placeholder; create_manager not run in dry mode
      key,
      quantity: QUANTITY,
    }).catch((e) => ({ ok: false, status: 'error', sender: owner, error: String(e) }));
    console.log(`  ${sim.ok ? '✓' : '✗'} simulateMint: ${JSON.stringify(sim)}`);
    console.log(
      '\nDry-run complete. Re-run with --execute (and a funded signer) to submit real writes.',
    );
    process.exit(0);
  }

  // --- EXECUTE: real on-chain writes ----------------------------------------
  if (suiBal < SUI_MIN_MIST) {
    console.error(`\n✗ SUI gas ${sui(suiBal)} below minimum ${sui(SUI_MIN_MIST)}. Fund gas and retry.`);
    process.exit(1);
  }
  if (suiBal < SUI_REC_MIST) {
    console.log(`\n⚠ Low SUI gas ${sui(suiBal)} (recommended ≥ ${sui(SUI_REC_MIST)}). Continuing.`);
  }
  if (!canMint) {
    console.error('\n✗ Insufficient dUSDC to mint. Aborting writes.');
    process.exit(1);
  }

  // 1. Reuse this owner's manager if the indexer knows one; else create fresh.
  step(1, 'resolve PredictManager');
  let managerId: string | null = null;
  const existing = await predict.managersForOwner(owner).catch(() => []);
  if (existing.length > 0) {
    managerId = existing[0].manager_id;
    console.log(`  ✓ reusing manager ${managerId}`);
  } else {
    const created = await predict.createManager();
    managerId = created.manager_id;
    done('created manager', created);
    console.log(`      manager_id: ${managerId}`);
  }
  if (!managerId) {
    console.error('  ✗ could not resolve a manager id; aborting.');
    process.exit(1);
  }

  // 2. deposit + mint atomically (deposit dUSDC into manager, then mint UP).
  step(2, `mint ${QUANTITY} UP (deposit ${dusdc(depositNeeded)} in-PTB)`);
  const minted = await predict.mint({
    managerId,
    key,
    quantity: QUANTITY,
    depositAmountRaw: depositNeeded,
  });
  done('mint', minted);

  // 3. read the resulting position (best-effort; indexer may lag a few seconds).
  step(3, 'read manager positions (indexer, best-effort)');
  try {
    const positions = await predict.predictServer.managerPositions(managerId);
    console.log(`  ✓ positions: ${JSON.stringify(positions).slice(0, 600)}`);
  } catch (e) {
    console.log(`  · positions not yet indexed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. redeem the position back (live redeem; payout lands in manager balance).
  step(4, `redeem ${QUANTITY} UP`);
  const redeemed = await predict.redeem({ managerId, key, quantity: QUANTITY });
  done('redeem', redeemed);

  // 5 + 6. PLP vault round-trip: supply dUSDC -> withdraw all PLP back to dUSDC.
  if (canSupply) {
    step(5, `supply ${dusdc(SUPPLY_AMOUNT)} to PLP vault`);
    const supplied = await predict.supply({ amountRaw: SUPPLY_AMOUNT });
    done('supply', supplied);

    step(6, 'withdraw all PLP back to dUSDC');
    const withdrawn = await predict.withdraw({});
    done('withdraw', withdrawn);
  } else {
    console.log('\n[5-6] supply/withdraw skipped (insufficient dUSDC for the supply leg).');
  }

  // --- Closing balances ------------------------------------------------------
  const [suiAfter, dusdcAfter] = await Promise.all([
    client.getBalance({ owner }).then((b) => BigInt(b.totalBalance)),
    client
      .getBalance({ owner, coinType: PREDICT.dusdcType })
      .then((b) => BigInt(b.totalBalance))
      .catch(() => 0n),
  ]);
  console.log('\nClosing wallet balances:');
  console.log(`  SUI (gas):  ${sui(suiAfter)}  (Δ ${sui(suiAfter - suiBal)})`);
  console.log(`  dUSDC:      ${dusdc(dusdcAfter)}  (Δ ${dusdc(dusdcAfter - dusdcBal)})`);
  console.log(`  manager:    ${managerId} (mint cost + redeem payout settle in its internal balance)`);
  console.log('\n✓ Write-path proof complete — real transactions landed on testnet.\n');
}

main().catch((err) => {
  console.error('\n✗ write-flow failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
