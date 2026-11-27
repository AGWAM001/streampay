//! Events emitted by the reference multisig.

use soroban_sdk::{contractevent, BytesN};

/// A proposal was created (the proposer's signature counts as approval #1).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreated {
    #[topic]
    pub proposal_id: u64,
    pub proposer: BytesN<32>,
    pub action_hash: BytesN<32>,
    pub expires_at: u64,
    pub epoch: u32,
}

/// A signer approved a proposal.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalApproved {
    #[topic]
    pub proposal_id: u64,
    pub signer: BytesN<32>,
    pub approvals: u32,
}

/// The proposer revoked a pending proposal.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalRevoked {
    #[topic]
    pub proposal_id: u64,
}

/// A proposal reached its threshold and was executed.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecuted {
    #[topic]
    pub proposal_id: u64,
}

/// The signer set, threshold or a per-function policy changed. Every
/// proposal created under an older epoch is now stale.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigChanged {
    pub epoch: u32,
    pub threshold: u32,
    pub signers: u32,
}
