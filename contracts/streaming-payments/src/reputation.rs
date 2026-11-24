//! Non-transferable stream credit reputation (issue #574).
//!
//! Every address accumulates a reputation record from its stream settlement
//! history. Integrators read the score through
//! [`crate::StreamingPayments::reputation_score`] /
//! [`crate::StreamingPayments::get_reputation`] to gate access. The score
//! moves no token value, has no transfer/approval surface, and is bound to
//! the address it was earned by: the record lives in contract storage keyed
//! by that address and can only be mutated by the contract's own settlement
//! paths.
//!
//! # What earns (and loses) score
//!
//! The score derives **only** from settled outcomes and resolved disputes:
//!
//! * **Completion** — a stream that runs to depletion (`withdrawn ==
//!   deposit` through the payout path) credits both sender and recipient.
//!   Cancellations never credit anyone, however much had accrued: a cancel
//!   is churn, not settlement.
//! * **Refill reliability** — a completion credits the *sender* a refill
//!   bonus when the stream had been topped up at least once. A top-up alone
//!   earns nothing: it is a pending deposit until the stream settles, so
//!   topping up and cancelling cannot farm the bonus.
//! * **Resolved disputes** — the party the outcome favours gains, the other
//!   loses: `resolve_dispute(accept = true)` upholds the recipient's
//!   dispute (recipient wins, sender loses); `accept = false` rejects it as
//!   bad-faith (sender wins, recipient loses). Dispute *expiry* is neutral
//!   and moves no counters.
//!
//! # Anti-wash rules
//!
//! * Create + cancel churn yields exactly zero score, at any volume: no
//!   counter moves on create or on cancel (proved by a proptest over the
//!   scoring core and by entrypoint tests).
//! * Self-streams (`sender == recipient`) earn nothing, so two pockets of
//!   the same actor cannot credit each other.
//! * Zero-value settlements earn nothing.
//! * Per-source caps bound any single behaviour's contribution, and the
//!   total is clamped to [`MAX_SCORE`], so even genuine completion farming
//!   saturates quickly — and every completion still costs the farmer a
//!   full stream duration of locked capital.
//!
//! # Formula (deterministic, bounded)
//!
//! ```text
//! raw = min(40 * completed_streams, 700)
//!     + min(10 * refilled_completions, 100)
//!     + min(20 * disputes_won, 200)
//!     - 30 * disputes_lost
//! score_raw = clamp(raw, 0, 1000)
//! ```
//!
//! # Decay
//!
//! The stored record is the *raw* history; the score integrators read
//! decays linearly with inactivity, reaching zero
//! [`DECAY_WINDOW_SECONDS`] (180 days) after `last_activity` — the same
//! linear recency shape as `voting_power`. Decay is computed at read time
//! from the ledger timestamp, so a read never writes and the same record
//! always yields the same score at the same ledger time (determinism).
//!
//! # Cost
//!
//! Counters are aggregates, not a history list: a read is one persistent
//! storage load plus O(1) arithmetic, independent of how many streams the
//! address has settled. No loops, no scans — the query is gas-budgeted by
//! construction.
//!
//! # Storage / errors
//!
//! Records sit under [`ReputationDataKey`], in keys separate from the
//! stream keys (the `dispute.rs` pattern), so the stream record wire format
//! never changes. No new [`crate::errors::StreamError`] codes are added:
//! recording is internal and infallible, and the reads return a default
//! (zero) record for unknown addresses instead of reverting.

use soroban_sdk::{contracttype, Address, Env};

use crate::events::ReputationUpdated;
use crate::stream::{Stream, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};

/// Maximum reputation score. Scores are clamped to `0..=MAX_SCORE`.
pub const MAX_SCORE: u32 = 1_000;
/// Points per completed (fully settled) stream, before the source cap.
pub const POINTS_PER_COMPLETION: u32 = 40;
/// Cap on points earned from completions alone.
pub const COMPLETION_POINTS_CAP: u32 = 700;
/// Points per refilled completion (sender only), before the source cap.
pub const POINTS_PER_REFILLED_COMPLETION: u32 = 10;
/// Cap on points earned from refilled completions alone.
pub const REFILL_POINTS_CAP: u32 = 100;
/// Points per dispute resolved in the subject's favour, before the cap.
pub const POINTS_PER_DISPUTE_WON: u32 = 20;
/// Cap on points earned from disputes won alone.
pub const DISPUTE_WON_POINTS_CAP: u32 = 200;
/// Points lost per dispute resolved against the subject.
pub const POINTS_PER_DISPUTE_LOST: u32 = 30;
/// Inactivity window over which the score decays linearly to zero:
/// 180 days in seconds, matching the voting-power decay window.
pub const DECAY_WINDOW_SECONDS: u64 = 180 * 24 * 60 * 60;

/// Accumulated reputation counters for one address.
///
/// Field order and names are the storage wire format for the reputation
/// record; only append fields. Counters are aggregates: they are the whole
/// history the score needs, which is what keeps reads O(1).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationRecord {
    /// Streams that ran to full settlement with this address as a party.
    pub completed_streams: u32,
    /// Completed streams this address funded that had been topped up at
    /// least once before settling (sender-side refill reliability).
    pub refilled_completions: u32,
    /// Disputes resolved in this address's favour.
    pub disputes_won: u32,
    /// Disputes resolved against this address.
    pub disputes_lost: u32,
    /// Total value settled across this address's completed streams.
    /// Informational (auditing/integrator display); never scored directly,
    /// so inflating stream sizes cannot inflate the score.
    pub settled_total: i128,
    /// Ledger timestamp of the last scored outcome. Drives decay.
    pub last_activity: u64,
}

impl ReputationRecord {
    pub fn zero() -> Self {
        ReputationRecord {
            completed_streams: 0,
            refilled_completions: 0,
            disputes_won: 0,
            disputes_lost: 0,
            settled_total: 0,
            last_activity: 0,
        }
    }
}

/// What the integrator-facing read returns: the stored counters plus the
/// score as of the current ledger time (raw and decayed).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationView {
    pub record: ReputationRecord,
    /// Score before inactivity decay.
    pub raw_score: u32,
    /// Score after inactivity decay at the current ledger timestamp. This
    /// is the value access gates should use.
    pub score: u32,
}

/// Storage keys for reputation state, kept separate from the stream keys
/// so existing stream serialization never changes.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReputationDataKey {
    /// The reputation record of the given address.
    Record(Address),
    /// Number of successful top-ups a stream has received. Unscored on its
    /// own; only consulted (and cleared) when the stream completes.
    StreamRefills(u64),
}

/// The uncapped-then-clamped score a record's counters produce, before
/// inactivity decay. Pure: same counters, same score, always.
pub fn raw_score(record: &ReputationRecord) -> u32 {
    let completion = record
        .completed_streams
        .saturating_mul(POINTS_PER_COMPLETION)
        .min(COMPLETION_POINTS_CAP);
    let refill = record
        .refilled_completions
        .saturating_mul(POINTS_PER_REFILLED_COMPLETION)
        .min(REFILL_POINTS_CAP);
    let won = record
        .disputes_won
        .saturating_mul(POINTS_PER_DISPUTE_WON)
        .min(DISPUTE_WON_POINTS_CAP);
    let lost = record.disputes_lost.saturating_mul(POINTS_PER_DISPUTE_LOST);

    let positive = completion.saturating_add(refill).saturating_add(won);
    positive.saturating_sub(lost).min(MAX_SCORE)
}

/// Apply inactivity decay to a raw score: full score at `last_activity`,
/// linearly down to zero once `now - last_activity >= DECAY_WINDOW_SECONDS`.
/// Pure and boundary-exact (age 0 → raw; age == window → 0).
pub fn decayed_score(record: &ReputationRecord, now: u64) -> u32 {
    let raw = raw_score(record);
    if raw == 0 || record.last_activity == 0 {
        return raw;
    }
    let age = now.saturating_sub(record.last_activity);
    if age >= DECAY_WINDOW_SECONDS {
        return 0;
    }
    let remaining = (DECAY_WINDOW_SECONDS - age) as u128;
    ((raw as u128 * remaining) / DECAY_WINDOW_SECONDS as u128) as u32
}

/// Load an address's record, or the zero record if it has none.
pub fn get_record(env: &Env, subject: &Address) -> ReputationRecord {
    env.storage()
        .persistent()
        .get(&ReputationDataKey::Record(subject.clone()))
        .unwrap_or_else(ReputationRecord::zero)
}

fn put_record(env: &Env, subject: &Address, record: &ReputationRecord) {
    let key = ReputationDataKey::Record(subject.clone());
    env.storage().persistent().set(&key, record);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Number of successful top-ups recorded for a stream (unscored side data).
pub fn stream_refills(env: &Env, stream_id: u64) -> u32 {
    env.storage()
        .persistent()
        .get(&ReputationDataKey::StreamRefills(stream_id))
        .unwrap_or(0)
}

/// Note a successful top-up. Moves no score by itself: the refill only
/// counts if and when the stream later completes (see
/// [`record_completion`]).
pub fn note_top_up(env: &Env, stream_id: u64) {
    let key = ReputationDataKey::StreamRefills(stream_id);
    let next = stream_refills(env, stream_id).saturating_add(1);
    env.storage().persistent().set(&key, &next);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

fn publish_update(env: &Env, subject: &Address, stream_id: u64, record: &ReputationRecord) {
    ReputationUpdated {
        subject: subject.clone(),
        stream_id,
        score: raw_score(record),
        completed_streams: record.completed_streams,
    }
    .publish(env);
}

/// Credit a stream that has just fully settled (run to depletion through
/// the payout path) to both parties.
///
/// Anti-wash: self-streams and zero-value settlements credit nobody, and
/// this is the *only* completion entry point — stream creation and
/// cancellation never call it, so churn cannot inflate the score.
///
/// `emit_events` controls the per-subject [`ReputationUpdated`] events.
/// Batch settlement paths (`withdraw_many`, `withdraw_all`) pass `false`:
/// two events per stream across a 20–50 stream batch would exceed the
/// per-invocation event-size budget and break the documented batch
/// limits. Records are updated identically either way — the score is
/// always readable via `get_reputation` — and the batch's own summary
/// event marks the settlement. Single-stream paths and dispute
/// resolutions always emit.
pub fn record_completion(
    env: &Env,
    stream: &Stream,
    settled_value: i128,
    now: u64,
    emit_events: bool,
) {
    if settled_value <= 0 || stream.sender == stream.recipient {
        return;
    }
    let refilled = stream_refills(env, stream.id) > 0;

    for subject in [&stream.sender, &stream.recipient] {
        let mut record = get_record(env, subject);
        record.completed_streams = record.completed_streams.saturating_add(1);
        record.settled_total = record.settled_total.saturating_add(settled_value);
        if refilled && *subject == stream.sender {
            record.refilled_completions = record.refilled_completions.saturating_add(1);
        }
        record.last_activity = now;
        put_record(env, subject, &record);
        if emit_events {
            publish_update(env, subject, stream.id, &record);
        }
    }

    if refilled {
        env.storage()
            .persistent()
            .remove(&ReputationDataKey::StreamRefills(stream.id));
    }
}

/// Credit a resolved dispute: `accepted = true` upholds the recipient's
/// dispute (recipient wins, sender loses); `accepted = false` rejects it
/// as bad-faith (sender wins, recipient loses). Expiry never calls this —
/// an expired dispute is neutral and moves no counters.
pub fn record_dispute_resolution(env: &Env, stream: &Stream, accepted: bool, now: u64) {
    if stream.sender == stream.recipient {
        return;
    }
    let (winner, loser) = if accepted {
        (&stream.recipient, &stream.sender)
    } else {
        (&stream.sender, &stream.recipient)
    };

    let mut win_record = get_record(env, winner);
    win_record.disputes_won = win_record.disputes_won.saturating_add(1);
    win_record.last_activity = now;
    put_record(env, winner, &win_record);
    publish_update(env, winner, stream.id, &win_record);

    let mut lose_record = get_record(env, loser);
    lose_record.disputes_lost = lose_record.disputes_lost.saturating_add(1);
    lose_record.last_activity = now;
    put_record(env, loser, &lose_record);
    publish_update(env, loser, stream.id, &lose_record);
}

/// The integrator read: stored counters plus raw and decayed scores at
/// `now`. One storage load and O(1) arithmetic.
pub fn view(env: &Env, subject: &Address, now: u64) -> ReputationView {
    let record = get_record(env, subject);
    ReputationView {
        raw_score: raw_score(&record),
        score: decayed_score(&record, now),
        record,
    }
}
