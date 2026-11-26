//! `split_stream` / `merge_streams` (issue #197): value conservation, lineage
//! records, event payloads and ordering, authorization, and refusals.
#![cfg(test)]

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, TestCaseError, TestRunner};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::token::Client as TokenClient;
use soroban_sdk::{vec, Address, Event as _};

use crate::test::Fixture;
use crate::{
    MergeStream, SplitStream, StreamError, StreamStatus, MIN_CLAIM_AMOUNT, MIN_STREAM_DEPOSIT,
};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 1_000_000_000;

/// `split_stream` returns `[first_child_id, second_child_id]`.
fn pair(ids: soroban_sdk::Vec<u64>) -> (u64, u64) {
    assert_eq!(ids.len(), 2);
    (ids.get_unchecked(0), ids.get_unchecked(1))
}

/// Withdrawn, claimable and refundable value of one stream, read from the
/// public views only (`get_stream` + `available`).
#[derive(Copy, Clone, Debug, Default, Eq, PartialEq)]
struct Value {
    withdrawn: i128,
    claimable: i128,
    refundable: i128,
}

impl Value {
    fn plus(self, o: Value) -> Value {
        Value {
            withdrawn: self.withdrawn + o.withdrawn,
            claimable: self.claimable + o.claimable,
            refundable: self.refundable + o.refundable,
        }
    }
}

fn value(f: &Fixture, id: u64) -> Value {
    let s = f.client.get_stream(&id);
    let claimable = f.client.available(&id);
    let streamed = s.withdrawn + claimable;
    let v = Value {
        withdrawn: s.withdrawn,
        claimable,
        refundable: s.deposit - streamed,
    };
    assert!(v.claimable >= 0 && v.refundable >= 0, "stream {id}: {v:?}");
    assert_eq!(s.deposit, v.withdrawn + v.claimable + v.refundable);
    v
}

fn contract_balance(f: &Fixture) -> i128 {
    TokenClient::new(&f.env, &f.token).balance(&f.client.address)
}

fn recipient_balance(f: &Fixture) -> i128 {
    TokenClient::new(&f.env, &f.token).balance(&f.recipient)
}

/// A stream that started now, ran three days of ten, and paid out 100 tokens.
fn running_stream(f: &Fixture) -> u64 {
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, true);
    f.advance_time(3 * DAY);
    f.client.mock_all_auths().withdraw(&id, &MIN_CLAIM_AMOUNT);
    id
}

#[test]
fn split_moves_history_to_first_child_and_conserves_value() {
    let f = Fixture::setup_quiet();
    let id = running_stream(&f);
    let parent = f.client.get_stream(&id);
    let before = value(&f, id);
    let escrow = contract_balance(&f);
    let first_remaining = before.refundable / 3;

    let (a, b) = pair(f.client.mock_all_auths().split_stream(
        &id,
        &first_remaining,
        &parent.end_time,
        &(parent.end_time + 5 * DAY),
    ));

    // Parent: terminal, no payout.
    let retired = f.client.get_stream(&id);
    assert_eq!(retired.status, StreamStatus::Cancelled);
    assert_eq!(f.client.available(&id), 0);
    assert_eq!(contract_balance(&f), escrow, "a split moves no tokens");

    // Children keep start_time, parties, token, cancelability.
    let ca = f.client.get_stream(&a);
    let cb = f.client.get_stream(&b);
    for c in [&ca, &cb] {
        assert_eq!(c.start_time, parent.start_time);
        assert_eq!(c.sender, parent.sender);
        assert_eq!(c.recipient, parent.recipient);
        assert_eq!(c.token, parent.token);
        assert_eq!(c.cancelable, parent.cancelable);
        assert_eq!(c.status, StreamStatus::Active);
    }
    assert_eq!(ca.withdrawn, parent.withdrawn, "history moves to child A");
    assert_eq!(cb.withdrawn, 0);
    assert_eq!(ca.deposit + cb.deposit, parent.deposit);
    assert_eq!(ca.end_time, parent.end_time);
    assert_eq!(cb.end_time, parent.end_time + 5 * DAY);

    let va = value(&f, a);
    let vb = value(&f, b);
    assert_eq!(
        va.claimable, before.claimable,
        "accrued balance stays claimable"
    );
    assert_eq!(vb.claimable, 0);
    assert_eq!(va.refundable, first_remaining);
    assert_eq!(
        va.plus(vb),
        before,
        "withdrawn + claimable + refundable conserved"
    );

    // Lineage graph, both directions.
    let up = f.client.split_merge_lineage(&id).unwrap();
    assert_eq!(up.children, vec![&f.env, a, b]);
    assert!(up.parents.is_empty());
    for c in [a, b] {
        let down = f.client.split_merge_lineage(&c).unwrap();
        assert_eq!(down.parents, vec![&f.env, id]);
        assert!(down.children.is_empty());
    }
}

#[test]
fn split_children_stream_out_exactly_the_remaining_deposit() {
    let f = Fixture::setup_quiet();
    let id = running_stream(&f);
    let parent = f.client.get_stream(&id);
    let paid_before = recipient_balance(&f);
    let (a, b) = pair(f.client.mock_all_auths().split_stream(
        &id,
        &(DEPOSIT / 4),
        &(parent.end_time + DAY),
        &(parent.end_time + 3 * DAY),
    ));

    f.advance_time(20 * DAY);
    let got_a = f.client.mock_all_auths().withdraw_max(&a);
    let got_b = f.client.mock_all_auths().withdraw_max(&b);
    assert_eq!(got_a + got_b, parent.deposit - parent.withdrawn);
    assert_eq!(recipient_balance(&f) - paid_before, got_a + got_b);
    assert_eq!(contract_balance(&f), 0, "nothing created, nothing stranded");
}

#[test]
fn split_children_never_accrue_ahead_of_the_parent() {
    let f = Fixture::setup_quiet();
    let id = running_stream(&f);
    let parent = f.client.get_stream(&id);
    let (a, b) = pair(f.client.mock_all_auths().split_stream(
        &id,
        &(DEPOSIT / 3),
        &parent.end_time,
        &(parent.end_time + 2 * DAY),
    ));
    let mut step = 0;
    while step < 12 {
        f.advance_time(DAY / 2);
        let now = f.ledger_time();
        let parent_accrued = crate::streamed_at(
            parent.deposit,
            parent.end_time - parent.start_time,
            now.min(parent.end_time) - parent.start_time,
        )
        .unwrap();
        let children = value(&f, a).claimable + value(&f, b).claimable + parent.withdrawn;
        // One token of slack per child for the floor in each tail window.
        assert!(
            children <= parent_accrued + 2,
            "children {children} ahead of parent {parent_accrued} at {now}"
        );
        step += 1;
    }
}

#[test]
fn split_then_merge_round_trips_value_and_lineage() {
    let f = Fixture::setup_quiet();
    let id = running_stream(&f);
    let parent = f.client.get_stream(&id);
    let (a, b) = pair(f.client.mock_all_auths().split_stream(
        &id,
        &(DEPOSIT / 5),
        &(parent.end_time + DAY),
        &(parent.end_time + 4 * DAY),
    ));
    f.advance_time(DAY);
    let before = value(&f, a).plus(value(&f, b));
    let escrow = contract_balance(&f);

    let m = f.client.mock_all_auths().merge_streams(&a, &b);

    assert_eq!(contract_balance(&f), escrow, "a merge moves no tokens");
    let merged = f.client.get_stream(&m);
    assert_eq!(merged.start_time, parent.start_time);
    assert_eq!(merged.end_time, parent.end_time + DAY, "earlier end wins");
    assert_eq!(merged.deposit, parent.deposit);
    assert_eq!(merged.withdrawn, parent.withdrawn);
    assert_eq!(value(&f, m), before);
    for p in [a, b] {
        assert_eq!(f.client.get_stream(&p).status, StreamStatus::Cancelled);
        assert_eq!(
            f.client.split_merge_lineage(&p).unwrap().children,
            vec![&f.env, m]
        );
    }
    let lineage = f.client.split_merge_lineage(&m).unwrap();
    assert_eq!(lineage.parents, vec![&f.env, a, b]);

    // The surplus is re-allocated, never truncated: everything streams out by
    // the merged end.
    f.advance_time(30 * DAY);
    let got = f.client.mock_all_auths().withdraw_max(&m);
    assert_eq!(got, before.claimable + before.refundable);
    assert_eq!(contract_balance(&f), 0);
}

#[test]
fn merge_of_independent_streams_sums_both() {
    let f = Fixture::setup_quiet();
    let x = f.create_stream(DEPOSIT / 2, 0, 10 * DAY, false);
    let y = f.create_stream(DEPOSIT / 4, DAY, 4 * DAY, false);
    f.advance_time(2 * DAY);
    f.client.mock_all_auths().withdraw(&x, &MIN_CLAIM_AMOUNT);
    let before = value(&f, x).plus(value(&f, y));
    let m = f.client.mock_all_auths().merge_streams(&x, &y);
    let merged = f.client.get_stream(&m);
    assert_eq!(merged.deposit, DEPOSIT / 2 + DEPOSIT / 4);
    assert_eq!(merged.end_time, f.client.get_stream(&y).end_time);
    assert_eq!(value(&f, m), before);
}

#[test]
fn split_before_start_behaves_like_two_fresh_streams() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    let parent = f.client.get_stream(&id);
    let (a, b) = pair(f.client.mock_all_auths().split_stream(
        &id,
        &(DEPOSIT / 2),
        &parent.end_time,
        &parent.end_time,
    ));
    assert!(f.client.rate_segments(&a).is_empty());
    assert!(f.client.rate_segments(&b).is_empty());
    f.advance_time(DAY + 5 * DAY);
    assert_eq!(
        value(&f, a).claimable + value(&f, b).claimable,
        DEPOSIT / 2,
        "half of the window, half of the deposit"
    );
}

#[test]
fn split_preserves_a_renegotiated_schedule() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
    f.advance_time(DAY);
    let rate = DEPOSIT / (20 * DAY) as i128;
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &id, &rate);
    f.client
        .mock_all_auths()
        .accept_rate_change(&f.recipient, &id);
    f.advance_time(2 * DAY);
    let before = value(&f, id);
    let parent = f.client.get_stream(&id);
    let (a, b) = pair(f.client.mock_all_auths().split_stream(
        &id,
        &(before.refundable / 2),
        &parent.end_time,
        &parent.end_time,
    ));
    assert_eq!(value(&f, a).plus(value(&f, b)), before);
    assert_eq!(value(&f, a).claimable, before.claimable);
}

#[test]
fn split_children_support_top_up_and_cancel() {
    let f = Fixture::setup_quiet();
    let id = running_stream(&f);
    let parent = f.client.get_stream(&id);
    let (a, b) = pair(f.client.mock_all_auths().split_stream(
        &id,
        &(DEPOSIT / 2),
        &parent.end_time,
        &parent.end_time,
    ));
    f.client.mock_all_auths().top_up(&b, &1_000);
    let vb = value(&f, b);
    let sender_before = TokenClient::new(&f.env, &f.token).balance(&f.sender);
    f.client.mock_all_auths().cancel_stream(&f.sender, &b);
    let sender_after = TokenClient::new(&f.env, &f.token).balance(&f.sender);
    assert_eq!(sender_after - sender_before, vb.refundable);
    assert_eq!(f.client.get_stream(&a).status, StreamStatus::Active);
}

#[test]
fn split_requires_recipient_and_merge_requires_both_parties() {
    let f = Fixture::setup_quiet();
    let id = running_stream(&f);
    let parent = f.client.get_stream(&id);
    let (a, b) = pair(f.client.mock_all_auths().split_stream(
        &id,
        &(DEPOSIT / 2),
        &parent.end_time,
        &parent.end_time,
    ));
    let signers: std::vec::Vec<Address> = f.env.auths().into_iter().map(|(a, _)| a).collect();
    assert_eq!(signers, std::vec![f.recipient.clone()]);

    f.client.mock_all_auths().merge_streams(&a, &b);
    let signers: std::vec::Vec<Address> = f.env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&f.sender));
    assert!(signers.contains(&f.recipient));
    assert_eq!(signers.len(), 2);
}

#[test]
fn split_and_merge_emit_one_lineage_event_with_parent_child_links() {
    let f = Fixture::setup_quiet();
    let id = running_stream(&f);
    let parent = f.client.get_stream(&id);
    let before = value(&f, id);
    let first_remaining = DEPOSIT / 3;
    let now = f.ledger_time();
    let (a, b) = pair(f.client.mock_all_auths().split_stream(
        &id,
        &first_remaining,
        &parent.end_time,
        &(parent.end_time + DAY),
    ));
    let split = SplitStream {
        parent_id: id,
        first_child_id: a,
        second_child_id: b,
        split_at: now,
        first_remaining,
        second_remaining: before.refundable - first_remaining,
        first_end_time: parent.end_time,
        second_end_time: parent.end_time + DAY,
        claimable: before.claimable,
        withdrawn: parent.withdrawn,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [split.to_xdr(&f.env, &f.client.address)]
    );

    let m = f.client.mock_all_auths().merge_streams(&a, &b);
    let merge = MergeStream {
        child_id: m,
        first_parent_id: a,
        second_parent_id: b,
        merged_at: now,
        remaining: before.refundable,
        end_time: parent.end_time,
        claimable: before.claimable,
        withdrawn: parent.withdrawn,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [merge.to_xdr(&f.env, &f.client.address)]
    );
}

#[test]
fn lineage_ops_refuse_encumbered_and_terminal_streams() {
    let f = Fixture::setup_quiet();
    let end = |id: u64| f.client.get_stream(&id).end_time;

    // Open dispute.
    let disputed = running_stream(&f);
    f.raise_dispute(disputed);
    assert_eq!(
        f.client
            .mock_all_auths()
            .try_split_stream(&disputed, &1, &end(disputed), &end(disputed)),
        Err(Ok(StreamError::StreamEncumbered))
    );

    // Pending rate proposal.
    let proposed = running_stream(&f);
    f.client
        .mock_all_auths()
        .propose_rate_change(&f.sender, &proposed, &1);
    assert_eq!(
        f.client
            .mock_all_auths()
            .try_split_stream(&proposed, &1, &end(proposed), &end(proposed)),
        Err(Ok(StreamError::StreamEncumbered))
    );

    // Registered hook.
    let hooked = running_stream(&f);
    f.client.mock_all_auths().register_hook(
        &f.sender,
        &hooked,
        &crate::HookEventClass::Cancel,
        &Address::generate(&f.env),
        &soroban_sdk::Symbol::new(&f.env, "on_cancel"),
        &crate::HookFailurePolicy::EmitAndContinue,
    );
    let plain = running_stream(&f);
    assert_eq!(
        f.client.mock_all_auths().try_merge_streams(&plain, &hooked),
        Err(Ok(StreamError::StreamEncumbered))
    );

    // Terminal parent: a split stream cannot be split again.
    let (a, _) = pair(f.client.mock_all_auths().split_stream(
        &plain,
        &(DEPOSIT / 4),
        &end(plain),
        &end(plain),
    ));
    assert_eq!(
        f.client
            .mock_all_auths()
            .try_split_stream(&plain, &1, &end(plain), &end(plain)),
        Err(Ok(StreamError::StreamNotActive))
    );
    // ...but its child can.
    assert!(f
        .client
        .mock_all_auths()
        .try_split_stream(&a, &1, &end(a), &end(a))
        .is_ok());
}

#[test]
fn merge_refuses_mismatched_parties() {
    let f = Fixture::setup_quiet();
    let x = f.create_stream(DEPOSIT / 4, 0, 10 * DAY, false);
    let other = Address::generate(&f.env);
    let now = f.ledger_time();
    let y = f.client.mock_all_auths().create_stream(
        &f.sender,
        &other,
        &f.token,
        &(DEPOSIT / 4),
        &now,
        &(now + 10 * DAY),
        &false,
    );
    assert_eq!(
        f.client.mock_all_auths().try_merge_streams(&x, &y),
        Err(Ok(StreamError::MergeIncompatibleStreams))
    );
}

/// Random split -> merge sequences never create or destroy value: at the split
/// and at the merge, withdrawn + claimable + refundable summed over the live
/// streams equals the inputs', the contract's balance never moves, and after
/// every window ends the recipient has been paid exactly the deposit.
#[test]
fn proptest_split_merge_round_trips_preserve_value() {
    let mut runner = TestRunner::new(ProptestConfig {
        cases: 48,
        failure_persistence: None,
        ..ProptestConfig::default()
    });
    let strategy = (
        MIN_STREAM_DEPOSIT..=DEPOSIT, // deposit
        100u64..=30 * DAY,            // duration
        0u32..=99,                    // % of window elapsed before the split
        0u32..=100,                   // % of the claimable balance withdrawn first
        1u32..=99,                    // % of the remainder on the first child
        (0u64..=DAY, 0u64..=DAY),     // extra seconds on each child end
        0u32..=99,                    // % of the earlier child window before merging
    );
    runner
        .run(
            &strategy,
            |(deposit, duration, pre, wd, share, (ext_a, ext_b), merge_at)| {
                let f = Fixture::setup_quiet();
                let id = f.create_stream(deposit, 10, duration, true);
                f.advance_time(10 + duration * pre as u64 / 100);
                let avail = f.client.available(&id);
                let take = avail * wd as i128 / 100;
                // Below MIN_CLAIM_AMOUNT a mid-stream withdraw is refused (#78).
                if take >= MIN_CLAIM_AMOUNT {
                    f.client.mock_all_auths().withdraw(&id, &take);
                }
                let parent = f.client.get_stream(&id);
                let before = value(&f, id);
                let first = before.refundable * share as i128 / 100;
                let escrow = contract_balance(&f);
                let split = f.client.mock_all_auths().try_split_stream(
                    &id,
                    &first,
                    &(parent.end_time + ext_a),
                    &(parent.end_time + ext_b),
                );
                if first <= 0 || first >= before.refundable {
                    prop_assert_eq!(split, Err(Ok(StreamError::InvalidSplitAllocation)));
                    return Ok(());
                }
                let (a, b) = pair(split.unwrap().unwrap());
                prop_assert_eq!(value(&f, a).plus(value(&f, b)), before);
                prop_assert_eq!(contract_balance(&f), escrow);

                let earlier = (parent.end_time + ext_a).min(parent.end_time + ext_b);
                let now = f.ledger_time();
                f.advance_time((earlier - now) * merge_at as u64 / 100);
                let mid = value(&f, a).plus(value(&f, b));
                let m = f.client.mock_all_auths().merge_streams(&a, &b);
                prop_assert_eq!(value(&f, m), mid);
                prop_assert_eq!(contract_balance(&f), escrow);

                f.advance_time(3 * DAY + duration);
                let paid_before = recipient_balance(&f);
                let claim = f.client.available(&m);
                if claim > 0 {
                    f.client.mock_all_auths().withdraw_max(&m);
                }
                prop_assert_eq!(
                    recipient_balance(&f) - paid_before + parent.withdrawn,
                    deposit
                );
                prop_assert_eq!(contract_balance(&f), 0);
                Ok::<(), TestCaseError>(())
            },
        )
        .unwrap();
}
