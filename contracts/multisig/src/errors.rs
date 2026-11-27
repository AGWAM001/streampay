//! Error codes for the reference multisig.
//!
//! Codes are stable once deployed: never renumber or reuse a variant, only
//! append new ones with the next free code.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MultisigError {
    /// The signer set is empty.
    NoSigners = 1,
    /// More than `MAX_SIGNERS` signers.
    TooManySigners = 2,
    /// Signer keys must be strictly ascending (sorted, no duplicates).
    SignersNotSorted = 3,
    /// Threshold is zero or larger than the number of signers.
    InvalidThreshold = 4,
    /// The key is not a member of the current signer set.
    NotASigner = 5,
    /// `__check_auth` signatures are not strictly ascending by public key
    /// (this is how a duplicated signer is rejected).
    DuplicateSignature = 6,
    /// Fewer valid signatures / approvals than the required threshold.
    BelowThreshold = 7,
    /// No proposal with this id.
    ProposalNotFound = 8,
    /// The proposal was already executed or revoked.
    ProposalNotPending = 9,
    /// The proposal's expiry has passed.
    ProposalExpired = 10,
    /// The signer set, threshold or a policy changed after the proposal was
    /// created; it can no longer be approved or executed.
    StaleProposal = 11,
    /// This signer already approved the proposal.
    AlreadyApproved = 12,
    /// Only the proposer can revoke a proposal.
    NotProposer = 13,
    /// Expiry is not in the future or is further out than `MAX_PROPOSAL_TTL`.
    InvalidExpiry = 14,
    /// An `Invoke` action with no calls.
    EmptyAction = 15,
    /// A call targets the multisig itself (Soroban forbids re-entry; config
    /// changes use the dedicated actions instead).
    SelfCall = 16,
    /// More than `MAX_CALLS` calls in one action.
    TooManyCalls = 17,
    /// More than `MAX_POLICIES` per-function policies.
    TooManyPolicies = 18,
    /// A per-function policy threshold is zero or exceeds the signer count
    /// (also raised when shrinking the signer set would strand an existing
    /// policy).
    InvalidPolicy = 19,
}
