/// Pelagos on-chain vault — a generic, share-accounted vault that custodies a
/// single coin type `T` (Pelagos uses the existing `MOCK_USDC`) and issues
/// transferable `VaultShare<T>` receipts. Shares track assets proportionally
/// (ERC4626-style): the first deposit mints 1 share per net unit, and later
/// deposits/redemptions price shares by `assets / total_shares`, so the vault
/// is yield-bearing as fees accrue. There is no fabricated state here — every
/// number is derived from the on-chain balance.
module pelagos_vault::vault;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

// --- errors ---
const EZeroAmount: u64 = 0;
const EWrongVault: u64 = 1;
const ENoShares: u64 = 2;
const EFeeTooHigh: u64 = 3;

const BPS_DENOM: u64 = 10_000;
const MAX_FEE_BPS: u64 = 1_000; // 10% hard cap on either fee

/// Admin capability, bound to one specific vault by id. Held by the vault
/// creator; required to withdraw accrued protocol fees.
public struct VaultAdminCap has key, store {
    id: UID,
    vault_id: ID,
}

/// Shared, per-coin-type vault. `assets` backs shares 1:1 with NAV; `fees`
/// holds accrued protocol fees (excluded from the share price).
public struct Vault<phantom T> has key {
    id: UID,
    assets: Balance<T>,
    fees: Balance<T>,
    total_shares: u64,
    deposit_fee_bps: u64,
    redeem_fee_bps: u64,
    admin: address,
}

/// Transferable deposit receipt. `principal` is the net amount deposited (for
/// off-chain P&L display); `label` is an opaque product/basket tag.
public struct VaultShare<phantom T> has key, store {
    id: UID,
    vault_id: ID,
    shares: u64,
    principal: u64,
    label: vector<u8>,
}

// --- events ---
public struct VaultCreated has copy, drop {
    vault_id: ID,
    admin: address,
    deposit_fee_bps: u64,
    redeem_fee_bps: u64,
}

public struct Deposited has copy, drop {
    vault_id: ID,
    owner: address,
    share_id: ID,
    gross: u64,
    fee: u64,
    net: u64,
    shares: u64,
    label: vector<u8>,
}

public struct Redeemed has copy, drop {
    vault_id: ID,
    owner: address,
    shares: u64,
    gross_out: u64,
    fee: u64,
    net_out: u64,
}

public struct FeesWithdrawn has copy, drop {
    vault_id: ID,
    amount: u64,
    to: address,
}

/// Create and share a new vault for coin type `T`, transferring a bound
/// `VaultAdminCap` to the caller.
public fun create_vault<T>(
    deposit_fee_bps: u64,
    redeem_fee_bps: u64,
    ctx: &mut TxContext,
) {
    assert!(deposit_fee_bps <= MAX_FEE_BPS && redeem_fee_bps <= MAX_FEE_BPS, EFeeTooHigh);
    let sender = tx_context::sender(ctx);
    let vault = Vault<T> {
        id: object::new(ctx),
        assets: balance::zero<T>(),
        fees: balance::zero<T>(),
        total_shares: 0,
        deposit_fee_bps,
        redeem_fee_bps,
        admin: sender,
    };
    let vault_id = object::id(&vault);
    transfer::public_transfer(
        VaultAdminCap { id: object::new(ctx), vault_id },
        sender,
    );
    event::emit(VaultCreated { vault_id, admin: sender, deposit_fee_bps, redeem_fee_bps });
    transfer::share_object(vault);
}

/// Deposit `payment` of coin `T`, mint proportional shares, and send the
/// caller a `VaultShare<T>` receipt.
public fun deposit<T>(
    vault: &mut Vault<T>,
    payment: Coin<T>,
    label: vector<u8>,
    ctx: &mut TxContext,
) {
    let gross = coin::value(&payment);
    assert!(gross > 0, EZeroAmount);

    let mut funds = coin::into_balance(payment);
    let fee = (((gross as u128) * (vault.deposit_fee_bps as u128) / (BPS_DENOM as u128)) as u64);
    if (fee > 0) {
        balance::join(&mut vault.fees, balance::split(&mut funds, fee));
    };
    let net = balance::value(&funds);
    assert!(net > 0, EZeroAmount);

    let assets_before = balance::value(&vault.assets);
    let shares = if (vault.total_shares == 0 || assets_before == 0) {
        net
    } else {
        (((net as u128) * (vault.total_shares as u128) / (assets_before as u128)) as u64)
    };
    assert!(shares > 0, ENoShares);

    balance::join(&mut vault.assets, funds);
    vault.total_shares = vault.total_shares + shares;

    let vault_id = object::id(vault);
    let receipt = VaultShare<T> {
        id: object::new(ctx),
        vault_id,
        shares,
        principal: net,
        label,
    };
    let owner = tx_context::sender(ctx);
    event::emit(Deposited {
        vault_id,
        owner,
        share_id: object::id(&receipt),
        gross,
        fee,
        net,
        shares,
        label,
    });
    transfer::public_transfer(receipt, owner);
}

/// Burn a `VaultShare<T>` and pay out the proportional assets (minus redeem
/// fee) to the caller.
public fun redeem<T>(
    vault: &mut Vault<T>,
    share: VaultShare<T>,
    ctx: &mut TxContext,
) {
    let VaultShare { id, vault_id, shares, principal: _, label: _ } = share;
    assert!(vault_id == object::id(vault), EWrongVault);
    object::delete(id);
    assert!(shares > 0 && vault.total_shares >= shares, ENoShares);

    let assets = balance::value(&vault.assets);
    let gross_out = (((shares as u128) * (assets as u128) / (vault.total_shares as u128)) as u64);
    vault.total_shares = vault.total_shares - shares;

    let mut out = balance::split(&mut vault.assets, gross_out);
    let fee = (((gross_out as u128) * (vault.redeem_fee_bps as u128) / (BPS_DENOM as u128)) as u64);
    if (fee > 0) {
        balance::join(&mut vault.fees, balance::split(&mut out, fee));
    };
    let net_out = balance::value(&out);

    let owner = tx_context::sender(ctx);
    event::emit(Redeemed { vault_id, owner, shares, gross_out, fee, net_out });
    transfer::public_transfer(coin::from_balance(out, ctx), owner);
}

/// Admin: sweep accrued protocol fees to the vault admin address.
public fun withdraw_fees<T>(
    cap: &VaultAdminCap,
    vault: &mut Vault<T>,
    ctx: &mut TxContext,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let amount = balance::value(&vault.fees);
    assert!(amount > 0, EZeroAmount);
    let swept = balance::split(&mut vault.fees, amount);
    let to = vault.admin;
    event::emit(FeesWithdrawn { vault_id: object::id(vault), amount, to });
    transfer::public_transfer(coin::from_balance(swept, ctx), to);
}

// --- read-only views (for devInspect / off-chain pricing) ---
public fun total_assets<T>(vault: &Vault<T>): u64 { balance::value(&vault.assets) }
public fun total_shares<T>(vault: &Vault<T>): u64 { vault.total_shares }
public fun accrued_fees<T>(vault: &Vault<T>): u64 { balance::value(&vault.fees) }
public fun deposit_fee_bps<T>(vault: &Vault<T>): u64 { vault.deposit_fee_bps }
public fun redeem_fee_bps<T>(vault: &Vault<T>): u64 { vault.redeem_fee_bps }

/// Share price as a (numerator, denominator) = (total_assets, total_shares)
/// pair so callers can compute it without floating point. Empty vault => (1,1).
public fun share_price<T>(vault: &Vault<T>): (u64, u64) {
    if (vault.total_shares == 0) { (1, 1) } else { (balance::value(&vault.assets), vault.total_shares) }
}

public fun receipt_shares<T>(share: &VaultShare<T>): u64 { share.shares }
public fun receipt_principal<T>(share: &VaultShare<T>): u64 { share.principal }
