//! Reputation suite (issue #574): non-transferable, wash-resistant stream
//! credit reputation.
//!
//! Coverage map against the issue's test list:
//! * *proptest that wash churn yields no score gain* —
//!   [`wash_churn_cannot_inflate_score`] (model-based, over fabricated
//!   settlement state — the same state the read path derives from) plus
//!   the entrypoint churn tests
//!   ([`create_cancel_churn_earns_nothing`],
//!   [`top_up_then_cancel_earns_nothing`]).
//! * *determinism and decay boundary tests* — [`raw_score_is_deterministic`],
//!   [`decay_boundaries_are_exact`], [`score_decays_to_zero_after_window`].
//! * *storage-golden for reputation records* —
//!   [`completion_writes_exact_record`] asserts the merged record
//!   field-for-field after a known settlement.
//!
//! Also covered: dispute outcomes in both directions, expiry neutrality,
//! refill reliability (sender only, and only on completion), self-stream
//! and zero-value exclusions, caps, and the unknown-address zero read.
#![cfg(test)]

extern crate std;

use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address};

use crate::reputation::{
    self, ReputationRecord, DECAY_WINDOW_SECONDS, MAX_SCORE, POINTS_PER_COMPLETION,
    POINTS_PER_DISPUTE_WON, POINTS_PER_REFILLED_COMPLETION,
};
use crate::stream::{Stream, StreamStatus};
use crate::test::Fixture;

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

fn record(
    completed: u32,
    refilled: u32,
    won: u32,
    lost: u32,
    last_activity: u64,
) -> ReputationRecord {
    ReputationRecord {
        completed_streams: completed,
        refilled_completions: refilled,
        disputes_won: won,
        disputes_lost: lost,
        settled_total: 0,
        last_activity,
    }
}

// ---------------------------------------------------------------- formula

#[test]
fn raw_score_is_deterministic_and_bounded() {
    // Same counters -> same score, every time.
    let r = record(3, 2, 1, 1, 1_000);
    assert_eq!(reputation::raw_score(&r), reputation::raw_score(&r));
    assert_eq!(
        reputation::raw_score(&r),
        3 * POINTS_PER_COMPLETION + 2 * POINTS_PER_REFILLED_COMPLETION + POINTS_PER_DISPUTE_WON
            - 30
    );

    // Saturating counters can never escape the bound.
    let whale = record(u32::MAX, u32::MAX, u32::MAX, 0, 1_000);
    assert_eq!(reputation::raw_score(&whale), MAX_SCORE);

    // Losses alone floor at zero, never negative.
    let loser = record(0, 0, 0, u32::MAX, 1_000);
    assert_eq!(reputation::raw_score(&loser), 0);
}

#[test]
fn decay_boundaries_are_exact() {
    let t0 = 1_000_000u64;
    let r = record(1, 0, 0, 0, t0);
    let raw = reputation::raw_score(&r);
    assert_eq!(raw, POINTS_PER_COMPLETION);

    // Age 0: full score. Half the window: exactly half. At the window: 0.
    assert_eq!(reputation::decayed_score(&r, t0), raw);
    assert_eq!(
        reputation::decayed_score(&r, t0 + DECAY_WINDOW_SECONDS / 2),
        raw / 2
    );
    assert_eq!(reputation::decayed_score(&r, t0 + DECAY_WINDOW_SECONDS), 0);
    assert_eq!(
        reputation::decayed_score(&r, t0 + DECAY_WINDOW_SECONDS + 1),
        0
    );
    assert_eq!(reputation::decayed_score(&r, u64::MAX), 0);

    // A record with no activity has no score to decay.
    assert_eq!(reputation::decayed_score(&ReputationRecord::zero(), t0), 0);
}

// ------------------------------------------------------------- proptest

/// One action in the wash-resistance model. `Churn` stands for any number
/// of create/cancel/expire cycles: in the contract those paths never call
/// a reputation writer, so the only churn-adjacent writer is the unscored
/// refill side-counter exercised by `TopUp`.
#[derive(Clone, Debug)]
enum Action {
    Churn,
    TopUp(u64),
    Complete(u64),
    DisputeWon,
    DisputeLost,
}

fn action_strategy() -> impl Strategy<Value = Action> {
    prop_oneof![
        Just(Action::Churn),
        (1u64..=3).prop_map(Action::TopUp),
        (1u64..=3).prop_map(Action::Complete),
        Just(Action::DisputeWon),
        Just(Action::DisputeLost),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]

    /// Wash churn cannot inflate the score: after any interleaving of
    /// churn, top-ups, completions and dispute outcomes, the merged record
    /// equals the model built *only* from settled outcomes and resolved
    /// disputes — churn and top-ups move no counter, and a top-up counts
    /// only when its stream later completes (for the sender).
    ///
    /// A completion is modelled by writing the stream's settled state
    /// (Depleted, fully withdrawn) into storage and both discovery
    /// indexes — exactly the state the read path derives counters from,
    /// and the state a real depleting payout leaves behind.
    #[test]
    fn wash_churn_cannot_inflate_score(actions in prop::collection::vec(action_strategy(), 0..24)) {
        let f = Fixture::setup_quiet();
        let now = f.env.ledger().timestamp();
        let mk_stream = |id: u64| Stream {
            id,
            sender: f.sender.clone(),
            recipient: f.recipient.clone(),
            token: f.token.clone(),
            deposit: DEPOSIT,
            withdrawn: 0,
            start_time: now,
            end_time: now + DAY,
            cancelable: true,
            status: StreamStatus::Active,
            use_oracle: Some(false),
        };

        // Model state. Each pool slot (stream ids 1..=3) stands for one
        // live stream; completing a slot settles its current stream and
        // rotates the slot to a fresh id, like a real stream lifecycle.
        let mut refills = [0u32; 4];
        let mut slot_stream = [0u64, 1, 2, 3];
        let mut next_id = 4u64;
        let mut model_sender = ReputationRecord::zero();
        let mut model_recipient = ReputationRecord::zero();

        f.env.as_contract(&f.client.address, || -> Result<(), TestCaseError> {
            for action in &actions {
                match *action {
                    Action::Churn => {
                        // Create + cancel (and dispute expiry) settle
                        // nothing: no state the read path counts, by design.
                    }
                    Action::TopUp(slot) => {
                        let id = slot_stream[slot as usize];
                        reputation::note_top_up(&f.env, id);
                        refills[slot as usize] += 1;
                    }
                    Action::Complete(slot) => {
                        let id = slot_stream[slot as usize];
                        let mut settled = mk_stream(id);
                        settled.status = StreamStatus::Depleted;
                        settled.withdrawn = DEPOSIT;
                        crate::stream::put_stream(&f.env, &settled);
                        crate::stream::index_stream(&f.env, &settled);
                        model_sender.completed_streams += 1;
                        model_sender.settled_total += DEPOSIT;
                        model_sender.last_activity = now + DAY;
                        if refills[slot as usize] > 0 {
                            model_sender.refilled_completions += 1;
                            refills[slot as usize] = 0;
                        }
                        model_recipient.completed_streams += 1;
                        model_recipient.settled_total += DEPOSIT;
                        model_recipient.last_activity = now + DAY;
                        slot_stream[slot as usize] = next_id;
                        next_id += 1;
                    }
                    Action::DisputeWon => {
                        // Recipient's dispute upheld: recipient wins, sender loses.
                        reputation::record_dispute_resolution(&f.env, &mk_stream(1), true, now);
                        model_recipient.disputes_won += 1;
                        model_recipient.last_activity = model_recipient.last_activity.max(now);
                        model_sender.disputes_lost += 1;
                        model_sender.last_activity = model_sender.last_activity.max(now);
                    }
                    Action::DisputeLost => {
                        reputation::record_dispute_resolution(&f.env, &mk_stream(1), false, now);
                        model_sender.disputes_won += 1;
                        model_sender.last_activity = model_sender.last_activity.max(now);
                        model_recipient.disputes_lost += 1;
                        model_recipient.last_activity = model_recipient.last_activity.max(now);
                    }
                }
            }

            let sender = reputation::get_record(&f.env, &f.sender);
            let recipient = reputation::get_record(&f.env, &f.recipient);
            prop_assert_eq!(&sender, &model_sender);
            prop_assert_eq!(&recipient, &model_recipient);
            prop_assert!(reputation::raw_score(&sender) <= MAX_SCORE);
            prop_assert!(reputation::raw_score(&recipient) <= MAX_SCORE);

            // Pure churn (no settled outcome at all) must be exactly zero.
            if model_sender.completed_streams == 0
                && model_sender.disputes_won == 0
                && model_sender.disputes_lost == 0
            {
                prop_assert_eq!(reputation::raw_score(&sender), 0);
            }
            Ok(())
        })?;
    }
}

// ------------------------------------------------------- module-level

#[test]
fn self_stream_and_zero_value_completion_earn_nothing() {
    let f = Fixture::setup_quiet();
    let now = f.env.ledger().timestamp();
    let self_stream = Stream {
        id: 7,
        sender: f.sender.clone(),
        recipient: f.sender.clone(),
        token: f.token.clone(),
        deposit: DEPOSIT,
        withdrawn: 0,
        start_time: now,
        end_time: now + DAY,
        cancelable: true,
        status: StreamStatus::Active,
        use_oracle: Some(false),
    };
    let pair_stream = Stream {
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        deposit: 0,
        ..self_stream.clone()
    };

    f.env.as_contract(&f.client.address, || {
        // Both streams sit in storage and the indexes in a settled
        // (Depleted) state — the read path must still count neither: one
        // is a self-stream, the other settled zero value.
        for settled in [&self_stream, &pair_stream] {
            let mut settled = settled.clone();
            settled.status = StreamStatus::Depleted;
            settled.withdrawn = settled.deposit;
            crate::stream::put_stream(&f.env, &settled);
            crate::stream::index_stream(&f.env, &settled);
        }
        reputation::record_dispute_resolution(&f.env, &self_stream, true, now);
        assert_eq!(
            reputation::get_record(&f.env, &f.sender),
            ReputationRecord::zero()
        );
        assert_eq!(
            reputation::get_record(&f.env, &f.recipient),
            ReputationRecord::zero()
        );
    });
}

// -------------------------------------------------------- entrypoints

#[test]
fn unknown_address_reads_zero() {
    let f = Fixture::setup_quiet();
    let stranger = Address::generate(&f.env);
    let view = f.client.get_reputation(&stranger);
    assert_eq!(view.record, ReputationRecord::zero());
    assert_eq!(view.raw_score, 0);
    assert_eq!(view.score, 0);
    assert_eq!(f.client.reputation_score(&stranger), 0);
}

/// Record-golden: after one known settlement, the merged records are
/// exactly this, field for field.
#[test]
fn completion_writes_exact_record() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 2 * DAY, false);
    // Settle exactly at end_time: the completion's decay anchor is the
    // stream's end_time (see reputation.rs), which is this ledger time.
    f.advance_time(2 * DAY);
    let settled_at = f.ledger_time();
    let amount = f.client.mock_all_auths().withdraw_max(&id);
    assert_eq!(amount, DEPOSIT);

    let expected = ReputationRecord {
        completed_streams: 1,
        refilled_completions: 0,
        disputes_won: 0,
        disputes_lost: 0,
        settled_total: DEPOSIT,
        last_activity: settled_at,
    };
    let sender_view = f.client.get_reputation(&f.sender);
    let recipient_view = f.client.get_reputation(&f.recipient);
    assert_eq!(sender_view.record, expected);
    assert_eq!(recipient_view.record, expected);
    assert_eq!(sender_view.raw_score, POINTS_PER_COMPLETION);
    assert_eq!(sender_view.score, POINTS_PER_COMPLETION);
    assert_eq!(f.client.reputation_score(&f.sender), POINTS_PER_COMPLETION);
    assert_eq!(
        f.client.reputation_score(&f.recipient),
        POINTS_PER_COMPLETION
    );
}

#[test]
fn create_cancel_churn_earns_nothing() {
    let f = Fixture::setup_quiet();
    // Repeated create + immediate cancel cycles: pure wash churn.
    for _ in 0..3 {
        let id = f.create_stream(DEPOSIT, 0, 10 * DAY, true);
        f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    }
    assert_eq!(f.client.reputation_score(&f.sender), 0);
    assert_eq!(f.client.reputation_score(&f.recipient), 0);
    assert_eq!(
        f.client.get_reputation(&f.sender).record,
        ReputationRecord::zero()
    );
    assert_eq!(
        f.client.get_reputation(&f.recipient).record,
        ReputationRecord::zero()
    );
}

#[test]
fn top_up_then_cancel_earns_nothing() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, true);
    f.client.mock_all_auths().top_up(&id, &(DEPOSIT / 2));
    f.client.mock_all_auths().cancel_stream(&f.sender, &id);
    // The refill was a pending deposit that never settled: no credit.
    assert_eq!(
        f.client.get_reputation(&f.sender).record,
        ReputationRecord::zero()
    );
    assert_eq!(f.client.reputation_score(&f.sender), 0);
}

#[test]
fn top_up_then_complete_credits_refill_to_sender_only() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 2 * DAY, false);
    f.client.mock_all_auths().top_up(&id, &(DEPOSIT / 2));
    f.advance_time(5 * DAY);
    f.client.mock_all_auths().withdraw_max(&id);

    let sender = f.client.get_reputation(&f.sender);
    assert_eq!(sender.record.completed_streams, 1);
    assert_eq!(sender.record.refilled_completions, 1);
    assert_eq!(
        sender.raw_score,
        POINTS_PER_COMPLETION + POINTS_PER_REFILLED_COMPLETION
    );

    let recipient = f.client.get_reputation(&f.recipient);
    assert_eq!(recipient.record.completed_streams, 1);
    assert_eq!(recipient.record.refilled_completions, 0);
    assert_eq!(recipient.raw_score, POINTS_PER_COMPLETION);
}

#[test]
fn dispute_upheld_credits_recipient_and_debits_sender() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);
    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &true);

    let recipient = f.client.get_reputation(&f.recipient);
    assert_eq!(recipient.record.disputes_won, 1);
    assert_eq!(recipient.record.disputes_lost, 0);
    assert_eq!(recipient.raw_score, POINTS_PER_DISPUTE_WON);

    let sender = f.client.get_reputation(&f.sender);
    assert_eq!(sender.record.disputes_won, 0);
    assert_eq!(sender.record.disputes_lost, 1);
    // One loss (-30) against no gains floors at zero.
    assert_eq!(sender.raw_score, 0);
}

#[test]
fn dispute_rejected_credits_sender_and_debits_recipient() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);
    f.client
        .mock_all_auths()
        .resolve_dispute(&f.sender, &id, &false);

    let sender = f.client.get_reputation(&f.sender);
    assert_eq!(sender.record.disputes_won, 1);
    assert_eq!(sender.raw_score, POINTS_PER_DISPUTE_WON);

    let recipient = f.client.get_reputation(&f.recipient);
    assert_eq!(recipient.record.disputes_lost, 1);
    assert_eq!(recipient.raw_score, 0);
}

#[test]
fn dispute_expired_is_neutral() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
    f.raise_dispute(id);
    f.advance_time(crate::DISPUTE_TIMEOUT_SECONDS + DAY);
    f.client.mock_all_auths().expire_dispute(&id);

    assert_eq!(
        f.client.get_reputation(&f.sender).record,
        ReputationRecord::zero()
    );
    assert_eq!(
        f.client.get_reputation(&f.recipient).record,
        ReputationRecord::zero()
    );
}

#[test]
fn batch_completion_updates_records_without_per_stream_events() {
    let f = Fixture::setup_quiet();
    // Two streams to the same recipient, both fully accrued.
    f.create_stream(DEPOSIT, 0, 2 * DAY, false);
    f.create_stream(DEPOSIT, 0, 2 * DAY, false);
    f.advance_time(5 * DAY);

    use soroban_sdk::testutils::Events as _;
    let _ = f.env.events().all(); // drain everything emitted so far
    let res = f.client.mock_all_auths().withdraw_all(&f.recipient, &None);
    assert_eq!(res.successful_stream_ids.len(), 2);

    // Completions emit no ReputationUpdated events at all (they are
    // derived at read time; see reputation.rs): this contract's events
    // for the invocation are exactly the two Withdrawn events.
    let own_events = f
        .env
        .events()
        .all()
        .filter_by_contract(&f.client.address)
        .events()
        .len();
    assert_eq!(own_events, 2);

    // Records read back exactly as on the single-stream path.
    let recipient = f.client.get_reputation(&f.recipient);
    assert_eq!(recipient.record.completed_streams, 2);
    assert_eq!(recipient.record.settled_total, 2 * DEPOSIT);
    assert_eq!(recipient.raw_score, 2 * POINTS_PER_COMPLETION);
    let sender = f.client.get_reputation(&f.sender);
    assert_eq!(sender.record.completed_streams, 2);
}

#[test]
fn score_decays_to_zero_after_window() {
    let f = Fixture::setup_quiet();
    let id = f.create_stream(DEPOSIT, 0, 2 * DAY, false);
    f.advance_time(2 * DAY);
    f.client.mock_all_auths().withdraw_max(&id);
    assert_eq!(f.client.reputation_score(&f.sender), POINTS_PER_COMPLETION);

    // Half the decay window later: exactly half the score remains, while
    // the raw (stored-history) score is unchanged.
    f.advance_time(DECAY_WINDOW_SECONDS / 2);
    assert_eq!(
        f.client.reputation_score(&f.sender),
        POINTS_PER_COMPLETION / 2
    );
    assert_eq!(
        f.client.get_reputation(&f.sender).raw_score,
        POINTS_PER_COMPLETION
    );

    // Past the window: fully decayed.
    f.advance_time(DECAY_WINDOW_SECONDS / 2 + DAY);
    assert_eq!(f.client.reputation_score(&f.sender), 0);
}
