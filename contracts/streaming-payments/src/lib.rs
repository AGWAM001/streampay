#![no_std]

//! StreamPay: continuous, linear streaming payments for Stellar (Soroban).
//!
//! Lock a deposit and let it accrue to a recipient per second between
//! `start_time` and `end_time` — for payroll, DAO contributor pay,
//! subscriptions, or vesting. The recipient withdraws accrued funds at any
//! time; the sender can top up or cancel with a fair pro-rata refund.
//!
//! # Entry points
//!
//! - [`StreamingPayments::create_stream`] — open a stream and pull the deposit
//! - [`StreamingPayments::withdraw`] — recipient claims accrued funds
//! - [`StreamingPayments::withdraw_max`] — recipient claims *all* accrued
//!   funds in one atomic call
//! - [`StreamingPayments::cancel_stream`] — sender (or recipient, if the
//!   stream is `cancelable`) closes the stream with a pro-rata split
//! - [`StreamingPayments::top_up`] — add funds to a running stream
//! - [`StreamingPayments::get_stream`] / [`StreamingPayments::available`] —
//!   read-only views
//! - [`StreamingPayments::recipient_streams`] /
//!   [`StreamingPayments::sender_streams`] — paginated on-chain discovery
//!   indexes per address
//!
//! # Invariants
//!
//! - `0 <= withdrawn <= streamed <= deposit` for every stored stream.
//! - The contract's token balance always covers `sum(deposit - withdrawn)`
//!   over all streams (funds are only ever moved by these entry points).
//! - All state changes happen *before* token transfers (checks-effects-
//!   interactions), so reentrant token callbacks cannot over-withdraw.
//! - Every token call goes through the SDK's fallible (`try_`) client and a
//!   failure is re-raised as a distinct `StreamError` transfer-failure code
//!   (14–17). Token contract errors share the `Error(Contract, #N)` namespace
//!   with this contract's codes, so propagating them raw would let a token's
//!   own code masquerade as a StreamPay code in clients. Because the failure
//!   is still returned as `Err`, the whole invocation — including any effects
//!   written before the transfer — rolls back atomically.

mod errors;
mod events;
mod stream;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_client;

use soroban_sdk::{
    contract, contractimpl, token::TokenClient, Address, ConversionError, Env,
    Error as SorobanError, InvokeError, MuxedAddress, Vec,
};

pub use errors::StreamError;
pub use events::{StreamCancelled, StreamCreated, StreamToppedUp, Withdrawn};
// `streamed_at` is re-exported for the fuzz target and downstream rate
// calculators: it is a pure function requiring no `Env`.
pub use stream::{streamed_at, Stream, StreamStatus, MAX_DURATION_SECONDS, MAX_PAGE_SIZE};

/// The StreamPay streaming-payments contract.
#[contract]
pub struct StreamingPayments;

/// Outcome of an SDK fallible (`try_`) call on a token contract: an outer
/// `Err` is a failed invocation (token contract error or host failure), an
/// inner `Err` a return-value conversion failure (a non-SEP-41 return type).
type TokenCall<T> = Result<Result<T, ConversionError>, Result<SorobanError, InvokeError>>;

/// Unwraps a token call, mapping **every** failure mode to `on_failure`.
///
/// A token's own error code must never escape this contract: contract error
/// numbers are per-contract and clients see them as `Error(Contract, #N)`, so
/// a token's `#5` would otherwise be indistinguishable from
/// [`StreamError::StreamNotActive`] (#5). Callers must always propagate the
/// mapped error with `?`: returning `Err` aborts the top-level invocation, so
/// effects already written in this call roll back together with the failed
/// (and therefore fully rolled-back) token transfer — no partial state and no
/// partial event log can survive a failed transfer.
fn token_result<T>(res: TokenCall<T>, on_failure: StreamError) -> Result<T, StreamError> {
    match res {
        Ok(Ok(value)) => Ok(value),
        // Conversion failures mean the callee did not return a SEP-41 shaped
        // value; treat a non-compliant token exactly like a failed transfer.
        Ok(Err(_)) | Err(_) => Err(on_failure),
    }
}

/// Pulls `amount` of `token` from `payer` into this contract via
/// `transfer_from`, mapping a token-side failure (insufficient balance or
/// allowance, a non-transferable asset, a non-token contract) to
/// `on_failure`.
fn pull(
    env: &Env,
    token: &Address,
    payer: &Address,
    amount: i128,
    on_failure: StreamError,
) -> Result<(), StreamError> {
    let res = TokenClient::new(env, token).try_transfer_from(
        &env.current_contract_address(),
        payer,
        &env.current_contract_address(),
        &amount,
    );
    token_result(res, on_failure)
}

/// Sends `amount` of `token` held by this contract to `recipient` via
/// `transfer`, mapping a token-side failure to `on_failure`.
fn push(
    env: &Env,
    token: &Address,
    recipient: &MuxedAddress,
    amount: i128,
    on_failure: StreamError,
) -> Result<(), StreamError> {
    let res = TokenClient::new(env, token).try_transfer(
        &env.current_contract_address(),
        recipient,
        &amount,
    );
    token_result(res, on_failure)
}

#[contractimpl]
impl StreamingPayments {
    /// Creates a linear payment stream and pulls `deposit_amount` of `token`
    /// from `sender` into this contract.
    ///
    /// The sender must first approve this contract as a spender on `token`
    /// (`token.approve(sender, streaming_contract, deposit_amount, ...)`).
    ///
    /// * `start_time` must not be in the past (UIs pass the current time to
    ///   start streaming immediately).
    /// * `end_time` must be strictly after `start_time` (zero-duration streams
    ///   are rejected) and at most `MAX_DURATION_SECONDS` long.
    #[allow(clippy::too_many_arguments)] // 8-arg surface is the intended client API
    /// * `cancelable` controls whether the recipient may also call
    ///   `cancel_stream` to reclaim their accrued balance.
    ///
    /// Returns the new stream id (monotonically increasing, starting at 1).
    ///
    /// The deposit pull is mapped to [`StreamError::DepositTransferFailed`]
    /// (missing balance/allowance, or an asset that refuses the transfer);
    /// nothing is persisted when it fails, so no stream id is consumed.
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
    ) -> Result<u64, StreamError> {
        sender.require_auth();

        if deposit_amount <= 0 {
            return Err(StreamError::ZeroAmount);
        }
        let now = env.ledger().timestamp();
        if start_time < now {
            return Err(StreamError::StartTimeInPast);
        }
        if end_time <= start_time {
            return Err(StreamError::InvalidTimeRange);
        }
        let duration = end_time - start_time;
        if duration > MAX_DURATION_SECONDS {
            return Err(StreamError::DurationTooLong);
        }
        stream::validate_capacity(deposit_amount, duration)?;

        // Interaction: pull the deposit from the sender. A token-side failure
        // maps to a distinct code; returning `Err` aborts before anything is
        // persisted (no id consumed, no event emitted).
        pull(
            &env,
            &token,
            &sender,
            deposit_amount,
            StreamError::DepositTransferFailed,
        )?;

        // Effects: persist the stream and announce it.
        let id = stream::next_stream_id(&env);
        let s = Stream {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            deposit: deposit_amount,
            withdrawn: 0,
            start_time,
            end_time,
            cancelable,
            status: StreamStatus::Active,
        };
        stream::put_stream(&env, &s);
        stream::index_stream(&env, &s);

        StreamCreated {
            stream_id: id,
            sender,
            recipient,
            token,
            deposit: deposit_amount,
            start_time,
            end_time,
            cancelable,
        }
        .publish(&env);

        Ok(id)
    }

    /// Withdraws up to `amount` of the accrued-but-unwithdrawn balance and
    /// pays it to the stream recipient. Only the recipient can call this
    /// (their authorization is required).
    ///
    /// Reverts with [`StreamError::AmountExceedsAvailable`] if `amount`
    /// exceeds what has accrued so far; before `start_time` nothing has
    /// accrued, at or after `end_time` the full remainder is available.
    ///
    /// A token-side failure to deliver the payout returns
    /// [`StreamError::RecipientPayoutFailed`] and rolls the recorded
    /// `withdrawn` update back with it.
    pub fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError> {
        if amount <= 0 {
            return Err(StreamError::ZeroAmount);
        }
        let mut s = Self::authorize_withdrawal(&env, stream_id)?;

        let available = stream::available_amount(&env, &s)?;
        if amount > available {
            return Err(StreamError::AmountExceedsAvailable);
        }

        Self::pay_out(&env, &mut s, amount)
    }

    /// Withdraws the entire accrued-but-unwithdrawn balance in one call and
    /// returns the amount paid. Only the recipient can call this (their
    /// authorization is required).
    ///
    /// This is the atomic form of "read `available`, then `withdraw` it":
    /// clients never risk a stale amount between the two calls. Reverts with
    /// [`StreamError::NothingToWithdraw`] when nothing has accrued yet (or
    /// everything accrued has already been withdrawn), with
    /// [`StreamError::StreamNotActive`] on cancelled or depleted streams, and
    /// with [`StreamError::RecipientPayoutFailed`] if the token refuses the
    /// payout (state rolls back unchanged).
    pub fn withdraw_max(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        let mut s = Self::authorize_withdrawal(&env, stream_id)?;

        let amount = stream::available_amount(&env, &s)?;
        if amount <= 0 {
            return Err(StreamError::NothingToWithdraw);
        }

        Self::pay_out(&env, &mut s, amount)?;
        Ok(amount)
    }

    /// Shared preamble for both withdrawal paths: load the stream, require
    /// the recipient's authorization, and reject terminal streams.
    fn authorize_withdrawal(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
        let s = stream::get_stream(env, stream_id)?;
        s.recipient.require_auth();
        if s.status != StreamStatus::Active {
            return Err(StreamError::StreamNotActive);
        }
        Ok(s)
    }

    /// Shared payout tail for both withdrawal paths, checks-effects-
    /// interactions ordered: record `withdrawn` and emit the event *before*
    /// moving tokens, so a reentrant token callback can never double-spend.
    fn pay_out(env: &Env, s: &mut Stream, amount: i128) -> Result<(), StreamError> {
        s.withdrawn = s
            .withdrawn
            .checked_add(amount)
            .ok_or(StreamError::MathOverflow)?;
        if s.withdrawn == s.deposit {
            s.status = StreamStatus::Depleted;
        }
        stream::put_stream(env, s);

        Withdrawn {
            stream_id: s.id,
            recipient: s.recipient.clone(),
            amount,
            withdrawn_total: s.withdrawn,
        }
        .publish(env);

        push(
            env,
            &s.token,
            &stream::muxed(&s.recipient),
            amount,
            StreamError::RecipientPayoutFailed,
        )
    }

    /// Cancels a stream: pays the recipient their accrued-but-unwithdrawn
    /// balance and refunds the sender the unaccrued remainder, atomically.
    ///
    /// Callable by the sender always, and by the recipient only if the stream
    /// was created with `cancelable = true`. Cancelling an already-cancelled
    /// or depleted stream reverts with [`StreamError::StreamNotActive`].
    ///
    /// Each payout leg maps a token-side failure to its own code —
    /// [`StreamError::RecipientPayoutFailed`] for the recipient's accrued
    /// share and [`StreamError::SenderRefundFailed`] for the sender's refund —
    /// and any failure rolls the whole cancellation back: the stream stays
    /// `Active`, `withdrawn` is restored, and no event survives.
    pub fn cancel_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError> {
        caller.require_auth();

        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(StreamError::StreamNotActive);
        }
        if caller != s.sender {
            if caller == s.recipient {
                if !s.cancelable {
                    return Err(StreamError::StreamNotCancellable);
                }
            } else {
                return Err(StreamError::NotAuthorized);
            }
        }

        let (recipient_amount, sender_amount) = stream::cancel_amounts(&env, &s)?;

        // Effects first (CEI): finalise state before moving tokens.
        s.status = StreamStatus::Cancelled;
        s.withdrawn = s
            .withdrawn
            .checked_add(recipient_amount)
            .ok_or(StreamError::MathOverflow)?;
        stream::put_stream(&env, &s);

        StreamCancelled {
            stream_id,
            cancelled_by: caller,
            recipient_amount,
            sender_amount,
        }
        .publish(&env);

        if recipient_amount > 0 {
            push(
                &env,
                &s.token,
                &stream::muxed(&s.recipient),
                recipient_amount,
                StreamError::RecipientPayoutFailed,
            )?;
        }
        if sender_amount > 0 {
            push(
                &env,
                &s.token,
                &stream::muxed(&s.sender),
                sender_amount,
                StreamError::SenderRefundFailed,
            )?;
        }

        Ok(())
    }

    /// Adds funds to an existing active stream. The deposit grows and accrual
    /// remains linear over the original window, so the recipient's accrued
    /// amount increases pro-rata immediately (Sablier-v1 `increaseAmount`
    /// semantics).
    ///
    /// Top-ups are rejected on cancelled or depleted streams. Topping up a
    /// stream that has already passed `end_time` adds fully-accrued funds the
    /// recipient can withdraw immediately.
    ///
    /// A token-side failure to pull the funds returns
    /// [`StreamError::TopUpTransferFailed`] and leaves `deposit` unchanged.
    ///
    /// Note: extending `end_time` is intentionally not supported in v1 —
    /// retroactively re-baselining accrual is lossy for the recipient; see
    /// `docs/ARCHITECTURE.md` for the design considerations and roadmap.
    pub fn top_up(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError> {
        if amount <= 0 {
            return Err(StreamError::ZeroAmount);
        }
        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(StreamError::StreamNotActive);
        }
        s.sender.require_auth();

        let new_deposit = s
            .deposit
            .checked_add(amount)
            .ok_or(StreamError::MathOverflow)?;
        stream::validate_capacity(new_deposit, s.duration())?;

        // Interaction: pull the added funds from the sender. A token-side
        // failure maps to a distinct code; the effects below never run, and
        // no partial state survives the `Err`.
        pull(
            &env,
            &s.token,
            &s.sender,
            amount,
            StreamError::TopUpTransferFailed,
        )?;

        // Effects: record the new deposit and announce it.
        s.deposit = new_deposit;
        stream::put_stream(&env, &s);

        StreamToppedUp {
            stream_id,
            sender: s.sender.clone(),
            amount,
            new_deposit,
        }
        .publish(&env);

        Ok(())
    }

    /// Read-only view of a stream's full state.
    pub fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError> {
        stream::get_stream(&env, stream_id)
    }

    /// Read-only view of the accrued-but-unwithdrawn balance at the current
    /// ledger time. Zero before `start_time` and for cancelled streams; the
    /// full remainder at or after `end_time`.
    pub fn available(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        stream::available_amount(&env, &s)
    }

    /// A page of stream ids where `recipient` is the recipient, in creation
    /// order (oldest first). `limit` is clamped to `MAX_PAGE_SIZE`; paginate
    /// by advancing `offset`. Unknown addresses yield an empty page.
    ///
    /// Discovery view only: it does not authorize anything and terminal
    /// (cancelled/depleted) streams keep their ids — read each stream's
    /// `status` for lifecycle state.
    pub fn recipient_streams(env: Env, recipient: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(
            &env,
            &stream::DataKey::RecipientStreams(recipient),
            offset,
            limit,
        )
    }

    /// A page of stream ids created by `sender`, in creation order. Same
    /// pagination and advisory semantics as [`StreamingPayments::recipient_streams`].
    pub fn sender_streams(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(&env, &stream::DataKey::SenderStreams(sender), offset, limit)
    }
}
