//! Stream lineage: `split_stream` and `merge_streams` (issue #197).
//!
//! A split turns one active stream into two children; a merge turns two
//! compatible streams into one. Neither moves tokens: the escrow the contract
//! already holds is re-assigned between stream records, so there is no
//! settlement, no refund/re-deposit and no transfer path at all.
//!
//! # How value is carried
//!
//! Every operation is evaluated at one *boundary* timestamp `b`:
//!
//! * the **history** of each input — what it accrued before `b` — is carried
//!   into exactly one output as the input's rate schedule clipped at `b`
//!   ([`clip_schedule`]). A clipped segment keeps its `allocation` and
//!   `basis_seconds`, so it accrues exactly what the input accrued, at every
//!   timestamp up to and including `b`;
//! * the **remainder** (`deposit - accrued(b)`) is re-allocated to new tail
//!   segments starting at `b`;
//! * cumulative `withdrawn` moves with the history.
//!
//! # Conservation invariant
//!
//! For every stream `s` at `b`:
//!
//! ```text
//! deposit(s) == withdrawn(s) + claimable(s, b) + refundable(s, b)
//! ```
//!
//! where `claimable = accrued - withdrawn` and `refundable = deposit - accrued`.
//! [`check_conservation`] evaluates that identity for every input and every
//! output, and requires the inputs' and outputs' sums of `withdrawn`,
//! `claimable` and `refundable` to be equal. It runs in-crate on every split and
//! merge, before anything is written; a violation aborts the call. It is a
//! defensive guard — the construction above makes it hold by design.

use soroban_sdk::{contracttype, Env, Vec};

use crate::errors::StreamError;
use crate::stream::{
    self, validate_capacity, DataKey, RateSegment, Stream, TTL_EXTEND_LEDGERS,
    TTL_THRESHOLD_LEDGERS,
};
use crate::surface::{self, Branch};

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Split/merge lineage of one stream, stored under `DataKey::StreamLineage`."
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `parents` are the streams this one was created from (one for a split"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " child, two for a merge child); `children` are the streams its value moved"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " to when it was split or merged.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamLineage {
    pub parents: Vec<u64>,
    pub children: Vec<u64>,
}

/// One stream's value at the boundary, split into the three buckets of the
/// conservation identity.
#[derive(Copy, Clone, Debug, Default, Eq, PartialEq)]
pub struct ValueBreakdown {
    pub deposit: i128,
    pub withdrawn: i128,
    pub claimable: i128,
    pub refundable: i128,
}

impl ValueBreakdown {
    fn add(self, other: ValueBreakdown) -> Result<ValueBreakdown, StreamError> {
        let sum = |a: i128, b: i128| {
            a.checked_add(b)
                .ok_or_else(|| surface::reject(Branch::LineageConservationViolated))
        };
        Ok(ValueBreakdown {
            deposit: sum(self.deposit, other.deposit)?,
            withdrawn: sum(self.withdrawn, other.withdrawn)?,
            claimable: sum(self.claimable, other.claimable)?,
            refundable: sum(self.refundable, other.refundable)?,
        })
    }
}

/// A stream record and the rate schedule that prices it.
#[derive(Clone, Debug)]
pub struct Planned {
    pub stream: Stream,
    pub segments: Vec<RateSegment>,
}

/// Accrued amount of `stream` under `segments` at `at`.
fn accrued(stream: &Stream, segments: &Vec<RateSegment>, at: u64) -> Result<i128, StreamError> {
    stream::streamed_amount_at_segments(stream, at, segments)
}

/// [`ValueBreakdown`] of an *active* stream at `at`.
pub fn breakdown_at(
    stream: &Stream,
    segments: &Vec<RateSegment>,
    at: u64,
) -> Result<ValueBreakdown, StreamError> {
    let streamed = accrued(stream, segments, at)?;
    let violated = || surface::reject(Branch::LineageConservationViolated);
    let claimable = streamed
        .checked_sub(stream.withdrawn)
        .ok_or_else(violated)?;
    let refundable = stream.deposit.checked_sub(streamed).ok_or_else(violated)?;
    if claimable < 0 || refundable < 0 {
        return Err(violated());
    }
    Ok(ValueBreakdown {
        deposit: stream.deposit,
        withdrawn: stream.withdrawn,
        claimable,
        refundable,
    })
}

/// Checks the conservation identity per stream and across the operation.
///
/// Returns the (equal) totals so callers and tests can report them.
pub fn check_conservation(
    inputs: &[&Planned],
    outputs: &[&Planned],
    at: u64,
) -> Result<ValueBreakdown, StreamError> {
    let total = |set: &[&Planned]| -> Result<ValueBreakdown, StreamError> {
        let mut sum = ValueBreakdown::default();
        for p in set {
            let b = breakdown_at(&p.stream, &p.segments, at)?;
            // Per-stream identity: deposit == withdrawn + claimable + refundable.
            let parts = b
                .withdrawn
                .checked_add(b.claimable)
                .and_then(|x| x.checked_add(b.refundable));
            if parts != Some(b.deposit) {
                return Err(surface::reject(Branch::LineageConservationViolated));
            }
            sum = sum.add(b)?;
        }
        Ok(sum)
    };
    let before = total(inputs)?;
    let after = total(outputs)?;
    if before != after {
        return Err(surface::reject(Branch::LineageConservationViolated));
    }
    Ok(after)
}

/// The stream's schedule with its single-window formula made explicit, so
/// every stream can be treated as a list of segments.
fn explicit_schedule(env: &Env, s: &Stream, segments: &Vec<RateSegment>) -> Vec<RateSegment> {
    if !segments.is_empty() {
        return segments.clone();
    }
    let mut head = Vec::new(env);
    head.push_back(RateSegment {
        start_time: s.start_time,
        end_time: s.end_time,
        allocation: s.deposit,
        basis_seconds: s.duration(),
    });
    head
}

/// The part of a schedule that lies before `boundary`. Each kept segment keeps
/// its `allocation` and `basis_seconds`, so it accrues exactly what it did
/// before, at every timestamp up to `boundary`.
fn clip_schedule(
    env: &Env,
    s: &Stream,
    segments: &Vec<RateSegment>,
    boundary: u64,
) -> Vec<RateSegment> {
    let mut kept = Vec::new(env);
    for seg in explicit_schedule(env, s, segments).iter() {
        if seg.start_time >= boundary {
            continue;
        }
        let end_time = seg.end_time.min(boundary);
        if end_time <= seg.start_time {
            continue;
        }
        kept.push_back(RateSegment {
            start_time: seg.start_time,
            end_time,
            allocation: seg.allocation,
            basis_seconds: seg.basis_seconds,
        });
    }
    kept
}

/// Builds an output stream: `history` (clipped segments) plus one tail window
/// `[boundary, end_time)` carrying `tail` tokens.
#[allow(clippy::too_many_arguments)]
fn build_output(
    template: &Stream,
    id: u64,
    start_time: u64,
    end_time: u64,
    history: Vec<RateSegment>,
    history_accrued: i128,
    withdrawn: i128,
    boundary: u64,
    tail: i128,
) -> Result<Planned, StreamError> {
    let tail_seconds = end_time - boundary;
    validate_capacity(tail, tail_seconds)?;
    let deposit = history_accrued
        .checked_add(tail)
        .ok_or_else(|| surface::reject(Branch::LineageConservationViolated))?;
    validate_capacity(deposit, end_time - start_time)?;

    let mut stream = template.clone();
    stream.id = id;
    stream.deposit = deposit;
    stream.withdrawn = withdrawn;
    stream.start_time = start_time;
    stream.end_time = end_time;

    let mut segments = history;
    let tail_segment = RateSegment {
        start_time: boundary,
        end_time,
        allocation: tail,
        basis_seconds: tail_seconds,
    };
    if segments.is_empty() && boundary == start_time {
        // A fresh window that starts at the stream's own start: the plain
        // single-window formula prices it identically, so store no schedule.
    } else {
        if segments.len() >= crate::MAX_RATE_SEGMENTS {
            return Err(surface::reject(Branch::RateSegmentLimitReached));
        }
        segments.push_back(tail_segment);
    }
    Ok(Planned { stream, segments })
}

/// Plans a split of `parent` at `boundary` into two children.
///
/// The first child carries the parent's history (its accrued amount and its
/// cumulative `withdrawn`) plus `first_remaining` of the unaccrued remainder
/// over `[boundary, first_end)`; the second child carries the rest of the
/// remainder over `[boundary, second_end)`. Both keep the parent's
/// `start_time`, parties, token, cancelability and oracle flag.
#[allow(clippy::too_many_arguments)]
pub fn plan_split(
    env: &Env,
    parent: &Planned,
    boundary: u64,
    first_id: u64,
    first_remaining: i128,
    first_end: u64,
    second_id: u64,
    second_end: u64,
) -> Result<(Planned, Planned), StreamError> {
    let p = &parent.stream;
    if boundary >= p.end_time {
        return Err(surface::reject(Branch::LineageWindowElapsed));
    }
    if first_end < p.end_time || second_end < p.end_time {
        return Err(surface::reject(Branch::SplitEndBeforeParent));
    }
    if first_end - p.start_time > crate::MAX_DURATION_SECONDS
        || second_end - p.start_time > crate::MAX_DURATION_SECONDS
    {
        return Err(surface::reject(Branch::SplitDurationTooLong));
    }
    let history_accrued = accrued(p, &parent.segments, boundary)?;
    let remaining = p
        .deposit
        .checked_sub(history_accrued)
        .ok_or_else(|| surface::reject(Branch::LineageConservationViolated))?;
    if first_remaining <= 0 || first_remaining >= remaining {
        return Err(surface::reject(Branch::SplitAllocationOutOfRange));
    }
    let second_remaining = remaining - first_remaining;

    let first = build_output(
        p,
        first_id,
        p.start_time,
        first_end,
        clip_schedule(env, p, &parent.segments, boundary),
        history_accrued,
        p.withdrawn,
        boundary,
        first_remaining,
    )?;
    let second = build_output(
        p,
        second_id,
        p.start_time,
        second_end,
        Vec::new(env),
        0,
        0,
        boundary,
        second_remaining,
    )?;
    check_conservation(&[parent], &[&first, &second], boundary)?;
    Ok((first, second))
}

/// Whether two streams may be merged (everything but their windows and
/// amounts must match).
pub fn mergeable(a: &Stream, b: &Stream) -> bool {
    a.sender == b.sender
        && a.recipient == b.recipient
        && a.token == b.token
        && a.status == b.status
        && a.cancelable == b.cancelable
        && a.uses_oracle() == b.uses_oracle()
}

/// Plans the merge of `first` and `second` at `boundary` into one stream.
///
/// The merged stream starts at the earlier start, carries both histories and
/// the sum of both `withdrawn`, and streams the sum of both remainders over
/// `[boundary, min(end_a, end_b))`: the summed rate, plus the longer stream's
/// surplus re-allocated into the shared window rather than truncated.
pub fn plan_merge(
    env: &Env,
    first: &Planned,
    second: &Planned,
    boundary: u64,
    merged_id: u64,
) -> Result<Planned, StreamError> {
    let a = &first.stream;
    let b = &second.stream;
    let end_time = a.end_time.min(b.end_time);
    if boundary >= end_time {
        return Err(surface::reject(Branch::LineageWindowElapsed));
    }
    let start_time = a.start_time.min(b.start_time);

    let accrued_a = accrued(a, &first.segments, boundary)?;
    let accrued_b = accrued(b, &second.segments, boundary)?;
    let overflow = || surface::reject(Branch::LineageConservationViolated);
    let history_accrued = accrued_a.checked_add(accrued_b).ok_or_else(overflow)?;
    let remaining = a
        .deposit
        .checked_sub(accrued_a)
        .and_then(|x| b.deposit.checked_sub(accrued_b)?.checked_add(x))
        .ok_or_else(overflow)?;
    let withdrawn = a.withdrawn.checked_add(b.withdrawn).ok_or_else(overflow)?;

    let mut history = clip_schedule(env, a, &first.segments, boundary);
    for seg in clip_schedule(env, b, &second.segments, boundary).iter() {
        history.push_back(seg);
    }

    let merged = build_output(
        a,
        merged_id,
        start_time,
        end_time,
        history,
        history_accrued,
        withdrawn,
        boundary,
        remaining,
    )?;
    check_conservation(&[first, second], &[&merged], boundary)?;
    Ok(merged)
}

/// Lineage record of `id` (empty when it was never split or merged).
pub fn get_lineage(env: &Env, id: u64) -> Option<StreamLineage> {
    let key = DataKey::StreamLineage(id);
    let storage = env.storage().persistent();
    let lineage = storage.get(&key);
    if lineage.is_some() {
        storage.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }
    lineage
}

fn put_lineage(env: &Env, id: u64, lineage: &StreamLineage) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent StreamLineage({id})"));
    let key = DataKey::StreamLineage(id);
    env.storage().persistent().set(&key, lineage);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Records `parents -> children` on every stream involved. A parent keeps the
/// parents it already had (a split child can be merged later, and so on), so
/// the records form the lineage graph an indexer can walk in both directions.
pub fn record_lineage(env: &Env, parents: &[u64], children: &[u64]) {
    let mut parent_ids = Vec::new(env);
    for &p in parents {
        parent_ids.push_back(p);
    }
    let mut child_ids = Vec::new(env);
    for &c in children {
        child_ids.push_back(c);
    }
    for &p in parents {
        let mut record = get_lineage(env, p).unwrap_or(StreamLineage {
            parents: Vec::new(env),
            children: Vec::new(env),
        });
        record.children = child_ids.clone();
        put_lineage(env, p, &record);
    }
    for &c in children {
        put_lineage(
            env,
            c,
            &StreamLineage {
                parents: parent_ids.clone(),
                children: Vec::new(env),
            },
        );
    }
}
