#[test_only]
module pelagos_vault::vault_tests;

use pelagos_vault::vault::{Self, Vault, VaultShare, VaultAdminCap};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts};

public struct TESTCOIN has drop {}

#[test]
fun deposit_redeem_and_fees() {
    let admin = @0xA;
    let user = @0xB;
    let mut sc = ts::begin(admin);

    // 1% deposit fee, 0.5% redeem fee
    vault::create_vault<TESTCOIN>(100, 50, ts::ctx(&mut sc));

    // user deposits 1_000_000 → fee 10_000, net 990_000, shares 990_000
    ts::next_tx(&mut sc, user);
    {
        let mut v = ts::take_shared<Vault<TESTCOIN>>(&sc);
        let c = coin::mint_for_testing<TESTCOIN>(1_000_000, ts::ctx(&mut sc));
        vault::deposit<TESTCOIN>(&mut v, c, b"PBU-HIGH-SHORT", ts::ctx(&mut sc));
        assert!(vault::total_assets(&v) == 990_000, 0);
        assert!(vault::total_shares(&v) == 990_000, 1);
        assert!(vault::accrued_fees(&v) == 10_000, 2);
        ts::return_shared(v);
    };

    // user redeems all → gross_out 990_000, redeem fee 4_950, net 985_050
    ts::next_tx(&mut sc, user);
    {
        let mut v = ts::take_shared<Vault<TESTCOIN>>(&sc);
        let share = ts::take_from_sender<VaultShare<TESTCOIN>>(&sc);
        assert!(vault::receipt_shares(&share) == 990_000, 3);
        vault::redeem<TESTCOIN>(&mut v, share, ts::ctx(&mut sc));
        assert!(vault::total_shares(&v) == 0, 4);
        assert!(vault::accrued_fees(&v) == 14_950, 5); // 10_000 + 4_950
        ts::return_shared(v);
    };

    // user received 985_050 of the coin
    ts::next_tx(&mut sc, user);
    {
        let c = ts::take_from_sender<Coin<TESTCOIN>>(&sc);
        assert!(coin::value(&c) == 985_050, 6);
        coin::burn_for_testing(c);
    };

    // admin sweeps the 14_950 fees
    ts::next_tx(&mut sc, admin);
    {
        let cap = ts::take_from_sender<VaultAdminCap>(&sc);
        let mut v = ts::take_shared<Vault<TESTCOIN>>(&sc);
        vault::withdraw_fees<TESTCOIN>(&cap, &mut v, ts::ctx(&mut sc));
        assert!(vault::accrued_fees(&v) == 0, 7);
        ts::return_shared(v);
        ts::return_to_sender(&sc, cap);
    };
    ts::next_tx(&mut sc, admin);
    {
        let c = ts::take_from_sender<Coin<TESTCOIN>>(&sc);
        assert!(coin::value(&c) == 14_950, 8);
        coin::burn_for_testing(c);
    };

    ts::end(sc);
}

#[test]
fun second_depositor_shares_track_nav() {
    let admin = @0xA;
    let alice = @0xB;
    let bob = @0xC;
    let mut sc = ts::begin(admin);
    vault::create_vault<TESTCOIN>(0, 0, ts::ctx(&mut sc)); // no fees for clean math

    // Alice deposits 1_000_000 → 1_000_000 shares
    ts::next_tx(&mut sc, alice);
    {
        let mut v = ts::take_shared<Vault<TESTCOIN>>(&sc);
        let c = coin::mint_for_testing<TESTCOIN>(1_000_000, ts::ctx(&mut sc));
        vault::deposit<TESTCOIN>(&mut v, c, b"", ts::ctx(&mut sc));
        assert!(vault::total_shares(&v) == 1_000_000, 0);
        ts::return_shared(v);
    };

    // Bob deposits 500_000 at price 1.0 → 500_000 shares
    ts::next_tx(&mut sc, bob);
    {
        let mut v = ts::take_shared<Vault<TESTCOIN>>(&sc);
        let c = coin::mint_for_testing<TESTCOIN>(500_000, ts::ctx(&mut sc));
        vault::deposit<TESTCOIN>(&mut v, c, b"", ts::ctx(&mut sc));
        assert!(vault::total_shares(&v) == 1_500_000, 1);
        assert!(vault::total_assets(&v) == 1_500_000, 2);
        ts::return_shared(v);
    };

    ts::end(sc);
}
