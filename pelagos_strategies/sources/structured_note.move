/// Pelagos structured-note primitive.
///
/// A `Note<T>` is a generic on-chain structured product over a single coin type
/// `T` (Pelagos uses the existing `MOCK_USDC`). It generalises the plain vault
/// with two extra features the new products need:
///
///   1. **Principal-protection floor** (`floor_bps`). On redemption a position
///      is guaranteed back at least `floor_bps/10_000` of its deposited
///      principal. A 100% floor (`floor_bps = 10_000`) is a true
///      principal-protected note: principal sits untouched in the pool and only
///      a separately-`fund`ed reserve (the DeFi-yield sleeve / strategy upside)
///      pays the convex upside. A 0% floor is an at-risk basket that settles at
///      its realised NAV.
///
///   2. **Admin settlement** (`settle`). At maturity the note's admin records a
///      realised `payout per share` (a rational `num/den` in `T` units). Before
///      settlement a holder may early-exit at ~par (min of principal and the
///      pro-rata pool); after settlement they redeem at `max(floor, settled
///      payout)`, always clamped to what the pool actually holds.
///
///   On-chain risk metadata (`strategy_tag`, `tail_risk`, `convexity`) lets the
///   indexer / UI describe each note's risk profile without an off-chain table.
///
/// There is no fabricated state: every payout is derived from the live on-chain
/// balance, the recorded settlement, and the position's own principal.
module pelagos_strategies::structured_note;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

// --- errors ---
const EZeroAmount: u64 = 0;
const EWrongNote: u64 = 1;
const ENoShares: u64 = 2;
const EBadFloor: u64 = 3;
const EBadProfile: u64 = 4;
const EAlreadySettled: u64 = 5;
const EBadPayout: u64 = 6;
const ENotAdmin: u64 = 7;

const BPS_DENOM: u64 = 10_000;

/// Admin capability bound to one note. Required to fund the reserve and to
/// settle the note at maturity.
public struct NoteAdminCap has key, store {
    id: UID,
    note_id: ID,
}

/// Shared, per-coin-type structured note.
///
/// `pool` holds principal + any funded reserve and backs every redemption.
/// `total_principal` is the gross net principal still outstanding (informational
/// floor base; the binding floor is per-position). `payout_num / payout_den` is
/// the settled payout per share, only meaningful once `settled`.
public struct Note<phantom T> has key {
    id: UID,
    pool: Balance<T>,
    total_shares: u64,
    total_principal: u64,
    floor_bps: u64,
    settled: bool,
    payout_num: u64,
    payout_den: u64,
    strategy_tag: vector<u8>,
    tail_risk: u8,   // 0 = low, 1 = medium, 2 = high
    convexity: u8,   // 0 = short, 1 = neutral, 2 = long
    admin: address,
}

/// Transferable holder receipt. `principal` is the net deposit (the floor base
/// and the early-exit par); `shares` price the pool / settled payout.
public struct NotePosition<phantom T> has key, store {
    id: UID,
    note_id: ID,
    shares: u64,
    principal: u64,
    label: vector<u8>,
}

// --- events ---
public struct NoteCreated has copy, drop {
    note_id: ID,
    admin: address,
    floor_bps: u64,
    tail_risk: u8,
    convexity: u8,
    strategy_tag: vector<u8>,
}

public struct Deposited has copy, drop {
    note_id: ID,
    owner: address,
    position_id: ID,
    principal: u64,
    shares: u64,
    label: vector<u8>,
}

public struct Funded has copy, drop {
    note_id: ID,
    amount: u64,
    pool_after: u64,
}

public struct Settled has copy, drop {
    note_id: ID,
    payout_num: u64,
    payout_den: u64,
}

public struct Redeemed has copy, drop {
    note_id: ID,
    owner: address,
    shares: u64,
    principal: u64,
    paid: u64,
    settled: bool,
}

/// Create and share a new structured note for coin type `T`, transferring a
/// bound `NoteAdminCap` to the caller.
public fun create_note<T>(
    floor_bps: u64,
    strategy_tag: vector<u8>,
    tail_risk: u8,
    convexity: u8,
    ctx: &mut TxContext,
) {
    assert!(floor_bps <= BPS_DENOM, EBadFloor);
    assert!(tail_risk <= 2 && convexity <= 2, EBadProfile);
    let sender = tx_context::sender(ctx);
    let note = Note<T> {
        id: object::new(ctx),
        pool: balance::zero<T>(),
        total_shares: 0,
        total_principal: 0,
        floor_bps,
        settled: false,
        payout_num: 0,
        payout_den: 1,
        strategy_tag,
        tail_risk,
        convexity,
        admin: sender,
    };
    let note_id = object::id(&note);
    transfer::public_transfer(NoteAdminCap { id: object::new(ctx), note_id }, sender);
    event::emit(NoteCreated {
        note_id,
        admin: sender,
        floor_bps,
        tail_risk,
        convexity,
        strategy_tag,
    });
    transfer::share_object(note);
}

/// Deposit `payment`, mint proportional shares, and send the caller a
/// `NotePosition<T>` receipt. Shares are 1:1 with principal on the first
/// deposit and pool-pro-rata thereafter.
public fun deposit<T>(
    note: &mut Note<T>,
    payment: Coin<T>,
    label: vector<u8>,
    ctx: &mut TxContext,
) {
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroAmount);

    let pool_before = balance::value(&note.pool);
    let shares = if (note.total_shares == 0 || pool_before == 0) {
        amount
    } else {
        (((amount as u128) * (note.total_shares as u128) / (pool_before as u128)) as u64)
    };
    assert!(shares > 0, ENoShares);

    balance::join(&mut note.pool, coin::into_balance(payment));
    note.total_shares = note.total_shares + shares;
    note.total_principal = note.total_principal + amount;

    let note_id = object::id(note);
    let position = NotePosition<T> {
        id: object::new(ctx),
        note_id,
        shares,
        principal: amount,
        label,
    };
    let owner = tx_context::sender(ctx);
    event::emit(Deposited {
        note_id,
        owner,
        position_id: object::id(&position),
        principal: amount,
        shares,
        label,
    });
    transfer::public_transfer(position, owner);
}

/// Admin: add reserve to the pool WITHOUT minting shares. This is how the
/// realised DeFi-yield sleeve / strategy upside is paid in, lifting redemption
/// value above principal.
public fun fund<T>(cap: &NoteAdminCap, note: &mut Note<T>, payment: Coin<T>) {
    assert!(cap.note_id == object::id(note), ENotAdmin);
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroAmount);
    balance::join(&mut note.pool, coin::into_balance(payment));
    event::emit(Funded { note_id: object::id(note), amount, pool_after: balance::value(&note.pool) });
}

/// Admin: settle the note with a realised payout-per-share rational
/// `payout_num / payout_den` (in `T` units). Idempotent-guarded.
public fun settle<T>(
    cap: &NoteAdminCap,
    note: &mut Note<T>,
    payout_num: u64,
    payout_den: u64,
) {
    assert!(cap.note_id == object::id(note), ENotAdmin);
    assert!(!note.settled, EAlreadySettled);
    assert!(payout_den > 0, EBadPayout);
    note.settled = true;
    note.payout_num = payout_num;
    note.payout_den = payout_den;
    event::emit(Settled { note_id: object::id(note), payout_num, payout_den });
}

/// Burn a `NotePosition<T>` and pay the holder. Pre-settlement: early-exit at
/// `min(principal, pool pro-rata)`. Post-settlement:
/// `max(floor, shares * payout_num/payout_den)`. Always clamped to the pool.
public fun redeem<T>(
    note: &mut Note<T>,
    position: NotePosition<T>,
    ctx: &mut TxContext,
) {
    let NotePosition { id, note_id, shares, principal, label: _ } = position;
    assert!(note_id == object::id(note), EWrongNote);
    object::delete(id);
    assert!(shares > 0 && note.total_shares >= shares, ENoShares);

    let pool = balance::value(&note.pool);
    let prorata = (((shares as u128) * (pool as u128) / (note.total_shares as u128)) as u64);
    let floor_out = (((principal as u128) * (note.floor_bps as u128) / (BPS_DENOM as u128)) as u64);

    let mut payout = if (note.settled) {
        let settled_out = (((shares as u128) * (note.payout_num as u128) / (note.payout_den as u128)) as u64);
        if (settled_out > floor_out) { settled_out } else { floor_out }
    } else {
        // Early exit at ~par: never more than the principal, never more than the
        // holder's pro-rata claim on the pool.
        if (principal < prorata) { principal } else { prorata }
    };
    // Can never pay more than the pool holds.
    if (payout > pool) { payout = pool };

    note.total_shares = note.total_shares - shares;
    note.total_principal = if (note.total_principal > principal) {
        note.total_principal - principal
    } else { 0 };

    let owner = tx_context::sender(ctx);
    let out = balance::split(&mut note.pool, payout);
    event::emit(Redeemed { note_id, owner, shares, principal, paid: payout, settled: note.settled });
    transfer::public_transfer(coin::from_balance(out, ctx), owner);
}

// --- read-only views (devInspect / off-chain pricing) ---
public fun pool_value<T>(note: &Note<T>): u64 { balance::value(&note.pool) }
public fun total_shares<T>(note: &Note<T>): u64 { note.total_shares }
public fun total_principal<T>(note: &Note<T>): u64 { note.total_principal }
public fun floor_bps<T>(note: &Note<T>): u64 { note.floor_bps }
public fun is_settled<T>(note: &Note<T>): bool { note.settled }
public fun payout_ratio<T>(note: &Note<T>): (u64, u64) { (note.payout_num, note.payout_den) }
public fun risk_profile<T>(note: &Note<T>): (u8, u8) { (note.tail_risk, note.convexity) }

/// Share price as (pool, total_shares); empty note => (1,1).
public fun share_price<T>(note: &Note<T>): (u64, u64) {
    if (note.total_shares == 0) { (1, 1) } else { (balance::value(&note.pool), note.total_shares) }
}

public fun position_shares<T>(p: &NotePosition<T>): u64 { p.shares }
public fun position_principal<T>(p: &NotePosition<T>): u64 { p.principal }
