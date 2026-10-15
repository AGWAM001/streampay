//! Error types for StreamPay.
//!
//! Every expected failure is expressed as a [`StreamError`] variant with a
//! stable numeric code, so clients can branch on failures without parsing
//! strings. The contract never panics on expected failure paths: all public
//! entrypoints return `Result<_, StreamError>` and all arithmetic is checked.
//!
//! Codes are part of the public interface — never renumber or reuse a variant;
//! only append new ones.
//!
//! Token-side failures are always translated into one of the `*TransferFailed`
//! variants below. A token contract's own error numbers live in the same
//! `Error(Contract, #N)` namespace as this enum's codes, so letting a raw
//! token failure surface would let — say — a token's `#5` masquerade as
//! [`StreamError::StreamNotActive`] in clients. The contract therefore invokes
//! every token transfer through the SDK's fallible (`try_`) client and maps
//! any failure to a distinct StreamPay code; the original token error is
//! intentionally not propagated.

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
    /// The token transfer in `create_stream` failed: the sender's balance or
    /// allowance was insufficient, or the asset refused the transfer
    /// (frozen/unauthorized/deauthorized holder, or any non-compliant token).
    DepositTransferFailed = 14,
    /// The token transfer in `top_up` failed (see
    /// [`StreamError::DepositTransferFailed`]; the stream's deposit is left
    /// untouched).
    TopUpTransferFailed = 15,
    /// The payout of accrued funds to the stream recipient failed — from
    /// `withdraw`, `withdraw_max`, or the recipient leg of `cancel_stream`.
    /// State changes made before the transfer are rolled back with the error.
    RecipientPayoutFailed = 16,
    /// The refund of unaccrued funds back to the sender failed during
    /// `cancel_stream` (the recipient leg, if any, was already paid).
    /// The cancellation is rolled back in full, so the stream stays active.
    SenderRefundFailed = 17,
}
