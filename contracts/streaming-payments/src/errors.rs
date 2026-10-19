//! Error types for StreamPay.
//!
//! Every expected failure is expressed as a [`StreamError`] variant with a
//! stable numeric code, so clients can branch on failures without parsing
//! strings. The contract never panics on expected failure paths: all public
//! entrypoints return `Result<_, StreamError>` and all arithmetic is checked.
//!
//! Codes are part of the public interface — never renumber or reuse a variant;
//! only append new ones.

use soroban_sdk::contracterror;

/// Errors returned by the StreamPay contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StreamError {
    /// No stream exists with the provided id.
    StreamNotFound = 1,
    /// The caller is not the sender of the stream.
    NotStreamSender = 2,
    /// The caller is not the recipient of the stream.
    NotStreamRecipient = 3,
    /// The stream is not `cancelable`, so the recipient cannot cancel it.
    StreamNotCancellable = 4,
    /// The stream is cancelled or depleted; the operation is not permitted.
    StreamNotActive = 5,
    /// `start_time` is before the current ledger timestamp.
    StartTimeInPast = 6,
    /// `end_time` is not strictly after `start_time`.
    InvalidTimeRange = 7,
    /// The stream duration exceeds the maximum supported duration.
    DurationTooLong = 8,
    /// A provided amount (deposit, top-up, or withdrawal) is zero or negative.
    ZeroAmount = 9,
    /// The requested withdrawal exceeds the accrued, unwithdrawn balance.
    AmountExceedsAvailable = 10,
    /// An intermediate computation would overflow; all math is checked.
    MathOverflow = 11,
    /// The caller is not permitted to perform this action.
    NotAuthorized = 12,
    /// `withdraw_max` found nothing accrued-but-unwithdrawn to pay out.
    NothingToWithdraw = 13,
    /// No two-step ownership proposal exists for this stream.
    NoPendingOwnership = 14,
    /// The pending ownership proposal's acceptance window has elapsed; the
    /// target must be proposed again by the current role holder.
    OwnershipProposalExpired = 15,
    /// The proposed new owner is already the current holder of that role (or
    /// is otherwise not a valid transfer target).
    InvalidTransferTarget = 16,
    /// An unexpired ownership proposal already exists for this stream; cancel
    /// or accept it before proposing another.
    OwnershipProposalPending = 17,
}
