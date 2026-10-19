//! Events emitted by StreamPay.
//!
//! Every event is keyed by `stream_id` as a topic, so indexers can filter per
//! stream efficiently. Non-`#[topic]` fields are event data.

use soroban_sdk::{contractevent, Address};

use crate::stream::OwnershipRole;

/// Emitted when a new stream is created and its deposit pulled in.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCreated {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
}

/// Emitted when the recipient withdraws accrued funds.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
    /// Total withdrawn from the stream after this withdrawal.
    pub withdrawn_total: i128,
}

/// Emitted when a stream is cancelled. The recipient's accrued balance and
/// the sender's refund are both paid atomically in the same transaction.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCancelled {
    #[topic]
    pub stream_id: u64,
    pub cancelled_by: Address,
    /// Amount paid out to the recipient at cancellation.
    pub recipient_amount: i128,
    /// Amount refunded to the sender at cancellation.
    pub sender_amount: i128,
}

/// Emitted when the sender adds funds to an existing stream.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamToppedUp {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    pub amount: i128,
    /// Stream deposit after the top-up.
    pub new_deposit: i128,
}

/// Emitted when a current sender or recipient proposes handing their role to a
/// new address. The handoff takes effect only when the target accepts.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipProposed {
    #[topic]
    pub stream_id: u64,
    /// The current role holder (must be the stream's sender or recipient).
    pub current_owner: Address,
    /// Address that must accept before the role moves.
    pub new_owner: Address,
    pub role: OwnershipRole,
    /// Ledger timestamp at or after which the proposal is stale.
    pub expires_at: u64,
}

/// Emitted when a proposed ownership handoff is accepted by its target. The
/// stream's accounting fields (`deposit`, `withdrawn`, time window) are
/// unchanged; only the role address moves.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipAccepted {
    #[topic]
    pub stream_id: u64,
    /// The role holder before the transfer.
    pub previous_owner: Address,
    /// The new role holder (the accepting address).
    pub new_owner: Address,
    pub role: OwnershipRole,
}
