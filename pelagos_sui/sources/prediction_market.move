/// USDC-collateral binary prediction-market core for Pelagos on Sui.
module pelagos_sui::prediction_market;

use pelagos_sui::mock_usdc::MOCK_USDC;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

const SIDE_YES: u8 = 1;
const SIDE_NO: u8 = 2;

const EMarketResolved: u64 = 0;
const EZeroStake: u64 = 1;
const ENotResolved: u64 = 2;
const EMarketMismatch: u64 = 3;
const EPositionLost: u64 = 4;
const EAlreadyResolved: u64 = 5;
const EInvalidSide: u64 = 6;

public struct AdminCap has key, store {
    id: UID,
}

public struct Market has key {
    id: UID,
    question: vector<u8>,
    close_ms: u64,
    resolved: bool,
    outcome: u8,
    yes_stake: u64,
    no_stake: u64,
    yes_pool: Balance<MOCK_USDC>,
    no_pool: Balance<MOCK_USDC>,
}

public struct Position has key, store {
    id: UID,
    market_id: ID,
    side: u8,
    stake: u64,
}

public struct MarketCreated has copy, drop {
    market_id: ID,
    close_ms: u64,
}

public struct PositionOpened has copy, drop {
    market_id: ID,
    position_id: ID,
    owner: address,
    side: u8,
    stake: u64,
}

public struct MarketResolved has copy, drop {
    market_id: ID,
    outcome: u8,
}

public struct PositionClaimed has copy, drop {
    market_id: ID,
    owner: address,
    side: u8,
    stake: u64,
    payout: u64,
}

fun init(ctx: &mut TxContext) {
    transfer::public_transfer(AdminCap { id: object::new(ctx) }, tx_context::sender(ctx));
}

entry fun create_market(
    _cap: &AdminCap,
    question: vector<u8>,
    close_ms: u64,
    ctx: &mut TxContext,
) {
    let market = Market {
        id: object::new(ctx),
        question,
        close_ms,
        resolved: false,
        outcome: 0,
        yes_stake: 0,
        no_stake: 0,
        yes_pool: balance::zero(),
        no_pool: balance::zero(),
    };
    event::emit(MarketCreated {
        market_id: object::id(&market),
        close_ms,
    });
    transfer::share_object(market);
}

#[allow(lint(self_transfer))]
entry fun buy_yes(market: &mut Market, payment: Coin<MOCK_USDC>, ctx: &mut TxContext) {
    open_position(market, SIDE_YES, payment, ctx);
}

#[allow(lint(self_transfer))]
entry fun buy_no(market: &mut Market, payment: Coin<MOCK_USDC>, ctx: &mut TxContext) {
    open_position(market, SIDE_NO, payment, ctx);
}

entry fun resolve_yes(_cap: &AdminCap, market: &mut Market) {
    resolve(market, SIDE_YES);
}

entry fun resolve_no(_cap: &AdminCap, market: &mut Market) {
    resolve(market, SIDE_NO);
}

entry fun claim(market: &mut Market, position: Position, ctx: &mut TxContext) {
    assert!(market.resolved, ENotResolved);
    assert!(position.market_id == object::id(market), EMarketMismatch);
    assert!(position.side == market.outcome, EPositionLost);

    let Position { id, market_id, side, stake } = position;
    object::delete(id);

    let payout = if (side == SIDE_YES) {
        let reward = prorata_reward(stake, market.yes_stake, market.no_stake);
        let mut payout_coin = coin::take(&mut market.yes_pool, stake, ctx);
        if (reward > 0) {
            let reward_coin = coin::take(&mut market.no_pool, reward, ctx);
            coin::join(&mut payout_coin, reward_coin);
        };
        payout_coin
    } else {
        let reward = prorata_reward(stake, market.no_stake, market.yes_stake);
        let mut payout_coin = coin::take(&mut market.no_pool, stake, ctx);
        if (reward > 0) {
            let reward_coin = coin::take(&mut market.yes_pool, reward, ctx);
            coin::join(&mut payout_coin, reward_coin);
        };
        payout_coin
    };

    let payout_value = coin::value(&payout);
    let owner = tx_context::sender(ctx);
    event::emit(PositionClaimed {
        market_id,
        owner,
        side,
        stake,
        payout: payout_value,
    });
    transfer::public_transfer(payout, owner);
}

public fun question(market: &Market): &vector<u8> {
    &market.question
}

public fun close_ms(market: &Market): u64 {
    market.close_ms
}

public fun resolved(market: &Market): bool {
    market.resolved
}

public fun outcome(market: &Market): u8 {
    market.outcome
}

public fun stakes(market: &Market): (u64, u64) {
    (market.yes_stake, market.no_stake)
}

fun open_position(market: &mut Market, side: u8, payment: Coin<MOCK_USDC>, ctx: &mut TxContext) {
    assert!(!market.resolved, EMarketResolved);
    assert!(side == SIDE_YES || side == SIDE_NO, EInvalidSide);

    let stake = coin::value(&payment);
    assert!(stake > 0, EZeroStake);

    if (side == SIDE_YES) {
        market.yes_stake = market.yes_stake + stake;
        coin::put(&mut market.yes_pool, payment);
    } else {
        market.no_stake = market.no_stake + stake;
        coin::put(&mut market.no_pool, payment);
    };

    let position = Position {
        id: object::new(ctx),
        market_id: object::id(market),
        side,
        stake,
    };
    let position_id = object::id(&position);
    let owner = tx_context::sender(ctx);
    event::emit(PositionOpened {
        market_id: object::id(market),
        position_id,
        owner,
        side,
        stake,
    });
    transfer::public_transfer(position, owner);
}

fun resolve(market: &mut Market, side: u8) {
    assert!(!market.resolved, EAlreadyResolved);
    assert!(side == SIDE_YES || side == SIDE_NO, EInvalidSide);
    market.resolved = true;
    market.outcome = side;
    event::emit(MarketResolved {
        market_id: object::id(market),
        outcome: side,
    });
}

fun prorata_reward(stake: u64, winning_stake: u64, losing_stake: u64): u64 {
    if (winning_stake == 0 || losing_stake == 0) {
        0
    } else {
        ((stake as u128) * (losing_stake as u128) / (winning_stake as u128) as u64)
    }
}

#[test_only]
public fun prorata_reward_for_testing(stake: u64, winning_stake: u64, losing_stake: u64): u64 {
    prorata_reward(stake, winning_stake, losing_stake)
}
