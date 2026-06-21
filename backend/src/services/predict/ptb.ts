/**
 * Low-level Programmable Transaction Block (PTB) builders for DeepBook Predict.
 * Each `add*` helper appends Move calls (createManager, deposit, mint/redeem,
 * range mint/redeem, supply/withdraw) or read-only previews (getTradeAmounts,
 * getRangeTradeAmounts) to a caller-owned Transaction for atomic composition.
 * Also exports the MarketKeyParams / RangeKeyParams shapes used across the service.
 */
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { PREDICT, predictTarget } from './config';

/**
 * Low-level PTB builders for DeepBook Predict.
 *
 * Each helper appends commands to a caller-owned `Transaction` so multiple
 * actions can be composed atomically (e.g. split dUSDC -> deposit -> mint in one
 * block). The protocol model:
 *   - `Predict` shared object is the market root (passed &mut).
 *   - `PredictManager` is the per-user account (passed &mut).
 *   - positions/ranges are balances inside the manager, keyed by Market/RangeKey.
 *   - `OracleSVI` is the per-(underlying, expiry) market state (passed &).
 */

export interface MarketKeyParams {
  oracleId: string;
  expiry: number | string | bigint;
  strike: number | string | bigint;
  isUp: boolean;
}

export interface RangeKeyParams {
  oracleId: string;
  expiry: number | string | bigint;
  lowerStrike: number | string | bigint;
  higherStrike: number | string | bigint;
}

const DUSDC = () => PREDICT.dusdcType;
const clock = (tx: Transaction) => tx.object(PREDICT.clockId);
const predict = (tx: Transaction) => tx.object(PREDICT.predictObjectId);

/** `market_key::up|down(oracle_id, expiry, strike) -> MarketKey` */
function buildMarketKey(tx: Transaction, p: MarketKeyParams): TransactionObjectArgument {
  return tx.moveCall({
    target: predictTarget('market_key', p.isUp ? 'up' : 'down'),
    arguments: [tx.pure.id(p.oracleId), tx.pure.u64(p.expiry), tx.pure.u64(p.strike)],
  });
}

/** `range_key::new(oracle_id, expiry, lower, higher) -> RangeKey` */
function buildRangeKey(tx: Transaction, p: RangeKeyParams): TransactionObjectArgument {
  return tx.moveCall({
    target: predictTarget('range_key', 'new'),
    arguments: [
      tx.pure.id(p.oracleId),
      tx.pure.u64(p.expiry),
      tx.pure.u64(p.lowerStrike),
      tx.pure.u64(p.higherStrike),
    ],
  });
}

/** `predict::create_manager(ctx) -> ID` (also shares the new PredictManager). */
export function addCreateManager(tx: Transaction): TransactionObjectArgument {
  return tx.moveCall({ target: predictTarget('predict', 'create_manager') });
}

/** `predict_manager::deposit<DUSDC>(manager, coin, ctx)` */
export function addDeposit(
  tx: Transaction,
  managerId: string,
  coin: TransactionObjectArgument,
): void {
  tx.moveCall({
    target: predictTarget('predict_manager', 'deposit'),
    typeArguments: [DUSDC()],
    arguments: [tx.object(managerId), coin],
  });
}

/** `predict::mint<DUSDC>(predict, manager, oracle, key, quantity, clock, ctx)` */
export function addMint(
  tx: Transaction,
  args: { managerId: string; key: MarketKeyParams; quantity: number | string | bigint },
): void {
  const key = buildMarketKey(tx, args.key);
  tx.moveCall({
    target: predictTarget('predict', 'mint'),
    typeArguments: [DUSDC()],
    arguments: [
      predict(tx),
      tx.object(args.managerId),
      tx.object(args.key.oracleId),
      key,
      tx.pure.u64(args.quantity),
      clock(tx),
    ],
  });
}

/**
 * `predict::redeem<DUSDC>` (live) or `redeem_permissionless<DUSDC>` (settled).
 * Payout lands in the manager's internal balance either way.
 */
export function addRedeem(
  tx: Transaction,
  args: {
    managerId: string;
    key: MarketKeyParams;
    quantity: number | string | bigint;
    permissionless?: boolean;
  },
): void {
  const key = buildMarketKey(tx, args.key);
  tx.moveCall({
    target: predictTarget('predict', args.permissionless ? 'redeem_permissionless' : 'redeem'),
    typeArguments: [DUSDC()],
    arguments: [
      predict(tx),
      tx.object(args.managerId),
      tx.object(args.key.oracleId),
      key,
      tx.pure.u64(args.quantity),
      clock(tx),
    ],
  });
}

/** `predict::mint_range<DUSDC>(predict, manager, oracle, key, quantity, clock, ctx)` */
export function addMintRange(
  tx: Transaction,
  args: { managerId: string; key: RangeKeyParams; quantity: number | string | bigint },
): void {
  const key = buildRangeKey(tx, args.key);
  tx.moveCall({
    target: predictTarget('predict', 'mint_range'),
    typeArguments: [DUSDC()],
    arguments: [
      predict(tx),
      tx.object(args.managerId),
      tx.object(args.key.oracleId),
      key,
      tx.pure.u64(args.quantity),
      clock(tx),
    ],
  });
}

/** `predict::redeem_range<DUSDC>(predict, manager, oracle, key, quantity, clock, ctx)` */
export function addRedeemRange(
  tx: Transaction,
  args: { managerId: string; key: RangeKeyParams; quantity: number | string | bigint },
): void {
  const key = buildRangeKey(tx, args.key);
  tx.moveCall({
    target: predictTarget('predict', 'redeem_range'),
    typeArguments: [DUSDC()],
    arguments: [
      predict(tx),
      tx.object(args.managerId),
      tx.object(args.key.oracleId),
      key,
      tx.pure.u64(args.quantity),
      clock(tx),
    ],
  });
}

/** `predict::supply<DUSDC>(predict, coin, clock, ctx) -> Coin<PLP>` */
export function addSupply(
  tx: Transaction,
  coin: TransactionObjectArgument,
): TransactionObjectArgument {
  return tx.moveCall({
    target: predictTarget('predict', 'supply'),
    typeArguments: [DUSDC()],
    arguments: [predict(tx), coin, clock(tx)],
  });
}

/** `predict::withdraw<DUSDC>(predict, lp_coin, clock, ctx) -> Coin<DUSDC>` */
export function addWithdraw(
  tx: Transaction,
  lpCoin: TransactionObjectArgument,
): TransactionObjectArgument {
  return tx.moveCall({
    target: predictTarget('predict', 'withdraw'),
    typeArguments: [DUSDC()],
    arguments: [predict(tx), lpCoin, clock(tx)],
  });
}

/**
 * `predict::get_trade_amounts(predict, oracle, key, quantity, clock) -> (mint_cost, redeem_payout)`
 * Read-only preview; intended for devInspect, not execution.
 */
export function addGetTradeAmounts(
  tx: Transaction,
  args: { key: MarketKeyParams; quantity: number | string | bigint },
): void {
  const key = buildMarketKey(tx, args.key);
  tx.moveCall({
    target: predictTarget('predict', 'get_trade_amounts'),
    arguments: [predict(tx), tx.object(args.key.oracleId), key, tx.pure.u64(args.quantity), clock(tx)],
  });
}

/**
 * `predict::get_range_trade_amounts(predict, oracle, key, quantity, clock) -> (mint_cost, redeem_payout)`
 * Read-only preview for a vertical RANGE (lower, higher]; intended for devInspect.
 * fair_range = up(lower) - up(higher); the returned cost includes the same
 * spread/utilization the on-chain mint_range charges (priced post-trade).
 */
export function addGetRangeTradeAmounts(
  tx: Transaction,
  args: { key: RangeKeyParams; quantity: number | string | bigint },
): void {
  const key = buildRangeKey(tx, args.key);
  tx.moveCall({
    target: predictTarget('predict', 'get_range_trade_amounts'),
    arguments: [predict(tx), tx.object(args.key.oracleId), key, tx.pure.u64(args.quantity), clock(tx)],
  });
}
