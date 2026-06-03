/// Testnet-only mock USDC for local Pelagos-on-Sui development.
module pelagos_sui::mock_usdc;

use std::option;
use sui::coin::{Self, Coin, TreasuryCap};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

public struct MOCK_USDC has drop {}

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
    transfer::public_transfer(treasury_cap, tx_context::sender(ctx));
}

entry fun mint(
    treasury_cap: &mut TreasuryCap<MOCK_USDC>,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    let coin = coin::mint(treasury_cap, amount, ctx);
    transfer::public_transfer(coin, recipient);
}

entry fun burn(treasury_cap: &mut TreasuryCap<MOCK_USDC>, coin: Coin<MOCK_USDC>) {
    coin::burn(treasury_cap, coin);
}
