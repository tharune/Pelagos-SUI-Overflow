/// Testnet-only mock USDC for Pelagos. Freely mintable via a SHARED faucet so
/// neither the backend nor any wallet is ever bottlenecked on collateral — the
/// optional, no-friction alternative to faucet-gated dUSDC for every Pelagos
/// contract that is generic over its coin type (vault, structurer, baskets).
module pelagos_sui::mock_usdc;

use std::option;
use sui::coin::{Self, Coin, TreasuryCap};
use sui::object::{Self, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

public struct MOCK_USDC has drop {}

/// Shared object custodying the mint authority so minting is permissionless.
public struct Faucet has key {
    id: UID,
    cap: TreasuryCap<MOCK_USDC>,
}

/// Per-call mint cap (1,000,000 mUSDC at 6 decimals) — generous, prevents abuse.
const MAX_PER_CALL: u64 = 1_000_000_000_000;

const EZeroAmount: u64 = 0;

#[allow(deprecated_usage)]
fun init(witness: MOCK_USDC, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency(
        witness,
        6,
        b"mUSDC",
        b"Pelagos Mock USDC",
        b"Testnet-only USDC used by the Pelagos Sui deployment.",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    // Share the mint authority instead of giving it to one owner: the token is a
    // public testnet faucet, so demos never stall waiting on a privileged minter.
    transfer::share_object(Faucet { id: object::new(ctx), cap: treasury_cap });
}

fun do_mint(faucet: &mut Faucet, amount: u64, recipient: address, ctx: &mut TxContext) {
    assert!(amount > 0, EZeroAmount);
    let amt = if (amount > MAX_PER_CALL) { MAX_PER_CALL } else { amount };
    let coin = coin::mint(&mut faucet.cap, amt, ctx);
    transfer::public_transfer(coin, recipient);
}

/// Permissionless: mint up to MAX_PER_CALL mUSDC to the caller.
entry fun faucet(faucet: &mut Faucet, amount: u64, ctx: &mut TxContext) {
    do_mint(faucet, amount, tx_context::sender(ctx), ctx);
}

/// Permissionless: mint up to MAX_PER_CALL mUSDC to an arbitrary recipient.
entry fun mint(faucet: &mut Faucet, amount: u64, recipient: address, ctx: &mut TxContext) {
    do_mint(faucet, amount, recipient, ctx);
}

entry fun burn(faucet: &mut Faucet, coin: Coin<MOCK_USDC>) {
    coin::burn(&mut faucet.cap, coin);
}

/// Total minted supply (for read-only display).
public fun total_supply(faucet: &Faucet): u64 {
    coin::total_supply(&faucet.cap)
}
