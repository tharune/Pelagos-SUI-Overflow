#[test_only]
module pelagos_strategies::structured_note_tests;

use pelagos_strategies::structured_note::{Self as note, Note, NotePosition, NoteAdminCap};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts};

public struct TESTCOIN has drop {}

/// A 100%-floor principal-protected note: principal sits in the pool, the admin
/// `fund`s the realised yield-sleeve upside, settles above par, and the holder
/// redeems principal + upside.
#[test]
fun ppn_with_upside() {
    let admin = @0xA;
    let user = @0xB;
    let mut sc = ts::begin(admin);

    note::create_note<TESTCOIN>(10_000, b"PPN-GUARD", 0, 2, ts::ctx(&mut sc));

    // user deposits 1_000_000 principal
    ts::next_tx(&mut sc, user);
    {
        let mut n = ts::take_shared<Note<TESTCOIN>>(&sc);
        let c = coin::mint_for_testing<TESTCOIN>(1_000_000, ts::ctx(&mut sc));
        note::deposit<TESTCOIN>(&mut n, c, b"PPN-GUARD", ts::ctx(&mut sc));
        assert!(note::pool_value(&n) == 1_000_000, 0);
        assert!(note::total_shares(&n) == 1_000_000, 1);
        ts::return_shared(n);
    };

    // admin funds 80_000 of realised yield upside, then settles at 1.08 / share
    ts::next_tx(&mut sc, admin);
    {
        let cap = ts::take_from_sender<NoteAdminCap>(&sc);
        let mut n = ts::take_shared<Note<TESTCOIN>>(&sc);
        let up = coin::mint_for_testing<TESTCOIN>(80_000, ts::ctx(&mut sc));
        note::fund<TESTCOIN>(&cap, &mut n, up);
        assert!(note::pool_value(&n) == 1_080_000, 2);
        note::settle<TESTCOIN>(&cap, &mut n, 1_080_000, 1_000_000);
        assert!(note::is_settled(&n), 3);
        ts::return_shared(n);
        ts::return_to_sender(&sc, cap);
    };

    // user redeems → principal + upside = 1_080_000
    ts::next_tx(&mut sc, user);
    {
        let mut n = ts::take_shared<Note<TESTCOIN>>(&sc);
        let pos = ts::take_from_sender<NotePosition<TESTCOIN>>(&sc);
        note::redeem<TESTCOIN>(&mut n, pos, ts::ctx(&mut sc));
        assert!(note::total_shares(&n) == 0, 4);
        assert!(note::pool_value(&n) == 0, 5);
        ts::return_shared(n);
    };
    ts::next_tx(&mut sc, user);
    {
        let c = ts::take_from_sender<Coin<TESTCOIN>>(&sc);
        assert!(coin::value(&c) == 1_080_000, 6);
        coin::burn_for_testing(c);
    };

    ts::end(sc);
}

/// A 0%-floor at-risk basket that settles at a loss (0.6 of NAV): the holder
/// receives the settled amount; the residual stays in the pool.
#[test]
fun at_risk_basket_loss() {
    let admin = @0xA;
    let user = @0xB;
    let mut sc = ts::begin(admin);

    note::create_note<TESTCOIN>(0, b"BASKET", 1, 1, ts::ctx(&mut sc));

    ts::next_tx(&mut sc, user);
    {
        let mut n = ts::take_shared<Note<TESTCOIN>>(&sc);
        let c = coin::mint_for_testing<TESTCOIN>(1_000_000, ts::ctx(&mut sc));
        note::deposit<TESTCOIN>(&mut n, c, b"BASKET", ts::ctx(&mut sc));
        ts::return_shared(n);
    };

    ts::next_tx(&mut sc, admin);
    {
        let cap = ts::take_from_sender<NoteAdminCap>(&sc);
        let mut n = ts::take_shared<Note<TESTCOIN>>(&sc);
        note::settle<TESTCOIN>(&cap, &mut n, 600_000, 1_000_000); // 0.6 / share
        ts::return_shared(n);
        ts::return_to_sender(&sc, cap);
    };

    ts::next_tx(&mut sc, user);
    {
        let mut n = ts::take_shared<Note<TESTCOIN>>(&sc);
        let pos = ts::take_from_sender<NotePosition<TESTCOIN>>(&sc);
        note::redeem<TESTCOIN>(&mut n, pos, ts::ctx(&mut sc));
        assert!(note::pool_value(&n) == 400_000, 0); // residual
        ts::return_shared(n);
    };
    ts::next_tx(&mut sc, user);
    {
        let c = ts::take_from_sender<Coin<TESTCOIN>>(&sc);
        assert!(coin::value(&c) == 600_000, 1);
        coin::burn_for_testing(c);
    };

    ts::end(sc);
}

/// Pre-settlement early exit returns par (min of principal and pro-rata pool).
#[test]
fun early_exit_at_par() {
    let admin = @0xA;
    let user = @0xB;
    let mut sc = ts::begin(admin);

    note::create_note<TESTCOIN>(10_000, b"PPN-GUARD", 0, 2, ts::ctx(&mut sc));

    ts::next_tx(&mut sc, user);
    {
        let mut n = ts::take_shared<Note<TESTCOIN>>(&sc);
        let c = coin::mint_for_testing<TESTCOIN>(500_000, ts::ctx(&mut sc));
        note::deposit<TESTCOIN>(&mut n, c, b"PPN-GUARD", ts::ctx(&mut sc));
        ts::return_shared(n);
    };

    // redeem before any settlement → par
    ts::next_tx(&mut sc, user);
    {
        let mut n = ts::take_shared<Note<TESTCOIN>>(&sc);
        let pos = ts::take_from_sender<NotePosition<TESTCOIN>>(&sc);
        note::redeem<TESTCOIN>(&mut n, pos, ts::ctx(&mut sc));
        assert!(note::pool_value(&n) == 0, 0);
        ts::return_shared(n);
    };
    ts::next_tx(&mut sc, user);
    {
        let c = ts::take_from_sender<Coin<TESTCOIN>>(&sc);
        assert!(coin::value(&c) == 500_000, 1);
        coin::burn_for_testing(c);
    };

    ts::end(sc);
}
