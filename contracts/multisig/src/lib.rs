#![no_std]

//! # StreamPay reference K-of-N multisig
//!
//! A Soroban contract that lets a set of ed25519 signer keys act as **one
//! address** (a `C...` contract address) for StreamPay streams: it can be the
//! `sender` that creates, tops up and cancels a stream, and the `recipient`
//! that withdraws from one. The streaming contract is not modified and does
//! not know the address is a multisig: it calls `sender.require_auth()` /
//! `recipient.require_auth()` exactly as it does for a classic account.
//!
//! Two ways to authorize, sharing one signer set and one threshold:
//!
//! 1. **Account abstraction (`__check_auth`).** The multisig is a custom
//!    account. Any `require_auth` on its address makes the host call
//!    [`Multisig::__check_auth`] with the authorization's signature payload,
//!    which already commits to the network id, a per-address nonce, an
//!    expiration ledger and the exact invocation tree. K signers sign that
//!    payload off-chain; one relayer submits the transaction.
//! 2. **On-chain proposals (`propose` / `approve` / `execute`).** Signers
//!    approve a stored [`Action`] one at a time (each approval is a signature
//!    checked on-chain, so no signer needs to submit a transaction or hold
//!    XLM). Once enough approvals are in, anyone calls `execute`, and the
//!    multisig itself calls the target contracts: it is then the *direct
//!    invoker*, so `require_auth` on its address passes without
//!    `__check_auth`. Deeper authorizations can be pre-authorized with
//!    `env.authorize_as_current_contract` through [`Call::auth`].
//!
//! ## Thresholds
//!
//! The default threshold applies to everything. A per-function policy
//! ([`FnPolicy`], keyed by `(contract, function)`) can require a *different*
//! number of signers for one entry point, e.g. a 1-of-N `cancel_stream` on
//! the streaming contract (an emergency brake any signer can pull). When one
//! authorization covers several calls, the **highest** requirement among
//! them applies, so a relaxed call can never carry a stricter one along.
//! Configuration changes ([`Action::SetSigners`], [`Action::SetPolicy`]) can
//! only happen through a proposal at the default threshold, and every change
//! bumps the config `epoch`, which invalidates all in-flight proposals.
//!
//! See `contracts/multisig/README.md` and `docs/MULTISIG.md` for the design
//! rationale, fee implications and security notes.

#[cfg(test)]
extern crate std;

mod errors;
mod events;
#[cfg(test)]
mod test;

use soroban_sdk::{
    auth::{Context, CustomAccountInterface, InvokerContractAuthEntry},
    contract, contractimpl, contracttype,
    crypto::Hash,
    panic_with_error,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Symbol, Val, Vec,
};

pub use errors::MultisigError;
pub use events::{
    ConfigChanged, ProposalApproved, ProposalCreated, ProposalExecuted, ProposalRevoked,
};

/// Maximum number of signers.
pub const MAX_SIGNERS: u32 = 20;
/// Maximum number of per-function policies.
pub const MAX_POLICIES: u32 = 16;
/// Maximum number of calls in one `Invoke` action.
pub const MAX_CALLS: u32 = 8;
/// Longest a proposal may stay open, in seconds (30 days).
pub const MAX_PROPOSAL_TTL: u64 = 30 * 24 * 60 * 60;
/// Domain-separation tag prefixed to every proposal signing payload.
pub const DOMAIN_TAG: &[u8] = b"streampay.multisig.v1";

const LEDGERS_PER_DAY: u32 = 17_280;
const INSTANCE_TTL_THRESHOLD: u32 = 7 * LEDGERS_PER_DAY;
const INSTANCE_TTL_EXTEND: u32 = 30 * LEDGERS_PER_DAY;
/// Proposals live at most `MAX_PROPOSAL_TTL`; keep them a day longer so the
/// final state stays readable.
const PROPOSAL_TTL_EXTEND: u32 = 31 * LEDGERS_PER_DAY;

/// One signer's signature in a `__check_auth` call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerSignature {
    pub public_key: BytesN<32>,
    pub signature: BytesN<64>,
}

/// A per-function threshold override.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FnPolicy {
    pub contract: Address,
    pub func: Symbol,
    /// Signatures required for this function, `1..=signers`. In a
    /// `SetPolicy` action, `0` removes the policy.
    pub threshold: u32,
}

/// The multisig's configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// Ed25519 public keys, strictly ascending.
    pub signers: Vec<BytesN<32>>,
    /// Default number of signatures required.
    pub threshold: u32,
    /// Bumped on every configuration change; proposals bind to it.
    pub epoch: u32,
    pub policies: Vec<FnPolicy>,
}

/// New signer set and threshold, applied by [`Action::SetSigners`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerUpdate {
    pub signers: Vec<BytesN<32>>,
    pub threshold: u32,
}

/// One contract call made by the multisig when a proposal executes.
#[contracttype]
#[derive(Clone)]
pub struct Call {
    pub contract: Address,
    pub func: Symbol,
    pub args: Vec<Val>,
    /// Authorizations for `require_auth` calls on the multisig's address that
    /// happen deeper than the direct call (passed to
    /// `env.authorize_as_current_contract` before invoking). Empty for the
    /// StreamPay entry points, where the multisig is the direct invoker.
    pub auth: Vec<InvokerContractAuthEntry>,
}

/// What a proposal does when executed.
#[contracttype]
#[derive(Clone)]
pub enum Action {
    /// Call other contracts, in order, as the multisig.
    Invoke(Vec<Call>),
    /// Replace the signer set and default threshold.
    SetSigners(SignerUpdate),
    /// Add, change (`threshold > 0`) or remove (`threshold == 0`) a
    /// per-function policy.
    SetPolicy(FnPolicy),
}

/// Proposal lifecycle.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Pending,
    Executed,
    Revoked,
}

/// What a proposal signature is for. Part of the signed payload, so an
/// approval can never be replayed as a revocation (or vice versa).
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Op {
    Propose,
    Approve,
    Revoke,
}

/// A stored proposal.
#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub proposer: BytesN<32>,
    pub action: Action,
    pub action_hash: BytesN<32>,
    pub approvals: Vec<BytesN<32>>,
    pub epoch: u32,
    pub expires_at: u64,
    pub status: ProposalStatus,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    NextId,
    Proposal(u64),
}

#[contract]
pub struct Multisig;

#[contractimpl]
impl Multisig {
    /// Deploys the multisig with its initial signer set and threshold.
    pub fn __constructor(env: Env, signers: Vec<BytesN<32>>, threshold: u32) {
        let policies = Vec::new(&env);
        if let Err(e) = validate_config(&signers, threshold, &policies) {
            panic_with_error!(&env, e);
        }
        put_config(
            &env,
            &Config {
                signers,
                threshold,
                epoch: 0,
                policies,
            },
        );
        env.storage().instance().set(&DataKey::NextId, &1u64);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// Current signer set, default threshold, epoch and policies.
    pub fn config(env: Env) -> Config {
        get_config(&env)
    }

    /// `true` if `key` is in the current signer set.
    pub fn is_signer(env: Env, key: BytesN<32>) -> bool {
        get_config(&env).signers.binary_search(&key).is_ok()
    }

    /// Signatures an action needs under the current configuration.
    pub fn required_approvals(env: Env, action: Action) -> u32 {
        required_for_action(&get_config(&env), &action)
    }

    /// The id the next `propose` will use (it is part of the proposer's
    /// signed payload).
    pub fn next_proposal_id(env: Env) -> u64 {
        next_id(&env)
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }

    /// `sha256(action.to_xdr())`, the digest proposals commit to.
    pub fn action_hash(env: Env, action: Action) -> BytesN<32> {
        hash_action(&env, &action)
    }

    /// The 32-byte payload a signer signs for `op` on a proposal, under the
    /// current epoch:
    /// `sha256(DOMAIN_TAG ‖ network_id ‖ xdr(this contract) ‖ op ‖ id ‖ epoch ‖ action_hash ‖ expires_at)`.
    pub fn signing_payload(
        env: Env,
        op: Op,
        proposal_id: u64,
        action_hash: BytesN<32>,
        expires_at: u64,
    ) -> BytesN<32> {
        let epoch = get_config(&env).epoch;
        payload(&env, op, proposal_id, epoch, &action_hash, expires_at)
    }

    // ------------------------------------------------------------------
    // Proposal flow
    // ------------------------------------------------------------------

    /// Stores `action` as proposal [`Self::next_proposal_id`]. `signature`
    /// is `proposer`'s ed25519 signature over
    /// `signing_payload(Propose, id, action_hash(action), expires_at)` and
    /// counts as the first approval. Returns the proposal id.
    pub fn propose(
        env: Env,
        proposer: BytesN<32>,
        action: Action,
        expires_at: u64,
        signature: BytesN<64>,
    ) -> Result<u64, MultisigError> {
        let config = get_config(&env);
        require_member(&config, &proposer)?;
        let now = env.ledger().timestamp();
        if expires_at <= now || expires_at - now > MAX_PROPOSAL_TTL {
            return Err(MultisigError::InvalidExpiry);
        }
        validate_action(&env, &config, &action)?;

        let id = next_id(&env);
        let action_hash = hash_action(&env, &action);
        let msg = payload(
            &env,
            Op::Propose,
            id,
            config.epoch,
            &action_hash,
            expires_at,
        );
        env.crypto()
            .ed25519_verify(&proposer, &Bytes::from(msg), &signature);

        let mut approvals = Vec::new(&env);
        approvals.push_back(proposer.clone());
        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            action,
            action_hash: action_hash.clone(),
            approvals,
            epoch: config.epoch,
            expires_at,
            status: ProposalStatus::Pending,
        };
        put_proposal(&env, &proposal);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        bump_instance(&env);

        ProposalCreated {
            proposal_id: id,
            proposer,
            action_hash,
            expires_at,
            epoch: config.epoch,
        }
        .publish(&env);
        Ok(id)
    }

    /// Adds `signer`'s approval. `signature` is over
    /// `signing_payload(Approve, ...)` for this proposal. A second approval
    /// by the same signer is rejected with `AlreadyApproved`. Returns the
    /// approval count.
    pub fn approve(
        env: Env,
        proposal_id: u64,
        signer: BytesN<32>,
        signature: BytesN<64>,
    ) -> Result<u32, MultisigError> {
        let config = get_config(&env);
        let mut proposal = load_open_proposal(&env, &config, proposal_id)?;
        require_member(&config, &signer)?;
        if proposal.approvals.contains(&signer) {
            return Err(MultisigError::AlreadyApproved);
        }
        let msg = payload(
            &env,
            Op::Approve,
            proposal_id,
            proposal.epoch,
            &proposal.action_hash,
            proposal.expires_at,
        );
        env.crypto()
            .ed25519_verify(&signer, &Bytes::from(msg), &signature);

        proposal.approvals.push_back(signer.clone());
        let approvals = proposal.approvals.len();
        put_proposal(&env, &proposal);
        ProposalApproved {
            proposal_id,
            signer,
            approvals,
        }
        .publish(&env);
        Ok(approvals)
    }

    /// Revokes a pending proposal. Only the proposer can revoke, with a
    /// signature over `signing_payload(Revoke, ...)`.
    pub fn revoke(env: Env, proposal_id: u64, signature: BytesN<64>) -> Result<(), MultisigError> {
        let mut proposal = load_proposal(&env, proposal_id)?;
        if proposal.status != ProposalStatus::Pending {
            return Err(MultisigError::ProposalNotPending);
        }
        let msg = payload(
            &env,
            Op::Revoke,
            proposal_id,
            proposal.epoch,
            &proposal.action_hash,
            proposal.expires_at,
        );
        env.crypto()
            .ed25519_verify(&proposal.proposer, &Bytes::from(msg), &signature);
        proposal.status = ProposalStatus::Revoked;
        put_proposal(&env, &proposal);
        ProposalRevoked { proposal_id }.publish(&env);
        Ok(())
    }

    /// Executes a proposal that has enough approvals under the *current*
    /// configuration. Permissionless: the approvals are the authorization.
    /// The proposal is marked executed before any call is made. Returns the
    /// return values of an `Invoke` action's calls (empty otherwise).
    pub fn execute(env: Env, proposal_id: u64) -> Result<Vec<Val>, MultisigError> {
        let config = get_config(&env);
        let mut proposal = load_open_proposal(&env, &config, proposal_id)?;
        let required = required_for_action(&config, &proposal.action);
        if proposal.approvals.len() < required {
            return Err(MultisigError::BelowThreshold);
        }

        // Effects before interactions.
        proposal.status = ProposalStatus::Executed;
        put_proposal(&env, &proposal);
        ProposalExecuted { proposal_id }.publish(&env);

        let mut results = Vec::new(&env);
        match proposal.action {
            Action::Invoke(calls) => {
                for call in calls.iter() {
                    if !call.auth.is_empty() {
                        env.authorize_as_current_contract(call.auth.clone());
                    }
                    let rv: Val = env.invoke_contract(&call.contract, &call.func, call.args);
                    results.push_back(rv);
                }
            }
            Action::SetSigners(update) => {
                apply_config(&env, config, update.signers, update.threshold, None)?;
            }
            Action::SetPolicy(policy) => {
                let signers = config.signers.clone();
                let threshold = config.threshold;
                apply_config(&env, config, signers, threshold, Some(policy))?;
            }
        }
        Ok(results)
    }
}

#[contractimpl]
impl CustomAccountInterface for Multisig {
    type Signature = Vec<SignerSignature>;
    type Error = MultisigError;

    /// Verifies K-of-N ed25519 signatures over the host-supplied
    /// `signature_payload`. Signatures must be strictly ascending by public
    /// key (rejects duplicates), every key must be a current signer, and the
    /// count must reach the highest threshold any of `auth_contexts`
    /// requires (per-function policy, else the default threshold).
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: Vec<SignerSignature>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), MultisigError> {
        let config = get_config(&env);
        let msg: Bytes = signature_payload.into();

        let mut prev: Option<BytesN<32>> = None;
        for sig in signatures.iter() {
            if let Some(p) = &prev {
                if *p >= sig.public_key {
                    return Err(MultisigError::DuplicateSignature);
                }
            }
            require_member(&config, &sig.public_key)?;
            env.crypto()
                .ed25519_verify(&sig.public_key, &msg, &sig.signature);
            prev = Some(sig.public_key);
        }

        let mut required = 0u32;
        if auth_contexts.is_empty() {
            required = config.threshold;
        }
        for ctx in auth_contexts.iter() {
            let r = match ctx {
                Context::Contract(c) => required_for_fn(&config, &c.contract, &c.fn_name),
                _ => config.threshold,
            };
            if r > required {
                required = r;
            }
        }
        if signatures.len() < required {
            return Err(MultisigError::BelowThreshold);
        }
        bump_instance(&env);
        Ok(())
    }
}

// ----------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------

fn get_config(env: &Env) -> Config {
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn put_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
    bump_instance(env);
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}

fn next_id(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::NextId).unwrap()
}

fn put_proposal(env: &Env, proposal: &Proposal) {
    let key = DataKey::Proposal(proposal.id);
    env.storage().persistent().set(&key, proposal);
    env.storage()
        .persistent()
        .extend_ttl(&key, PROPOSAL_TTL_EXTEND, PROPOSAL_TTL_EXTEND);
}

fn load_proposal(env: &Env, id: u64) -> Result<Proposal, MultisigError> {
    env.storage()
        .persistent()
        .get(&DataKey::Proposal(id))
        .ok_or(MultisigError::ProposalNotFound)
}

/// Loads a proposal that can still be approved or executed: pending, not
/// expired, and created under the current config epoch.
fn load_open_proposal(env: &Env, config: &Config, id: u64) -> Result<Proposal, MultisigError> {
    let proposal = load_proposal(env, id)?;
    if proposal.status != ProposalStatus::Pending {
        return Err(MultisigError::ProposalNotPending);
    }
    if env.ledger().timestamp() >= proposal.expires_at {
        return Err(MultisigError::ProposalExpired);
    }
    if proposal.epoch != config.epoch {
        return Err(MultisigError::StaleProposal);
    }
    Ok(proposal)
}

fn require_member(config: &Config, key: &BytesN<32>) -> Result<(), MultisigError> {
    if config.signers.binary_search(key).is_ok() {
        Ok(())
    } else {
        Err(MultisigError::NotASigner)
    }
}

fn required_for_fn(config: &Config, contract: &Address, func: &Symbol) -> u32 {
    for p in config.policies.iter() {
        if p.contract == *contract && p.func == *func {
            return p.threshold;
        }
    }
    config.threshold
}

fn required_for_action(config: &Config, action: &Action) -> u32 {
    match action {
        Action::Invoke(calls) => {
            let mut required = 0;
            for call in calls.iter() {
                let r = required_for_fn(config, &call.contract, &call.func);
                if r > required {
                    required = r;
                }
            }
            if required == 0 {
                config.threshold
            } else {
                required
            }
        }
        Action::SetSigners(_) | Action::SetPolicy(_) => config.threshold,
    }
}

fn validate_action(env: &Env, config: &Config, action: &Action) -> Result<(), MultisigError> {
    match action {
        Action::Invoke(calls) => {
            if calls.is_empty() {
                return Err(MultisigError::EmptyAction);
            }
            if calls.len() > MAX_CALLS {
                return Err(MultisigError::TooManyCalls);
            }
            let me = env.current_contract_address();
            for call in calls.iter() {
                if call.contract == me {
                    return Err(MultisigError::SelfCall);
                }
            }
            Ok(())
        }
        Action::SetSigners(update) => {
            validate_config(&update.signers, update.threshold, &config.policies)
        }
        Action::SetPolicy(policy) => {
            let policies = with_policy(env, &config.policies, policy);
            validate_config(&config.signers, config.threshold, &policies)
        }
    }
}

fn validate_config(
    signers: &Vec<BytesN<32>>,
    threshold: u32,
    policies: &Vec<FnPolicy>,
) -> Result<(), MultisigError> {
    let n = signers.len();
    if n == 0 {
        return Err(MultisigError::NoSigners);
    }
    if n > MAX_SIGNERS {
        return Err(MultisigError::TooManySigners);
    }
    for i in 1..n {
        if signers.get_unchecked(i - 1) >= signers.get_unchecked(i) {
            return Err(MultisigError::SignersNotSorted);
        }
    }
    if threshold == 0 || threshold > n {
        return Err(MultisigError::InvalidThreshold);
    }
    if policies.len() > MAX_POLICIES {
        return Err(MultisigError::TooManyPolicies);
    }
    for p in policies.iter() {
        if p.threshold == 0 || p.threshold > n {
            return Err(MultisigError::InvalidPolicy);
        }
    }
    Ok(())
}

/// `policies` with `policy` inserted, replaced, or (threshold 0) removed.
fn with_policy(env: &Env, policies: &Vec<FnPolicy>, policy: &FnPolicy) -> Vec<FnPolicy> {
    let mut out = Vec::new(env);
    for p in policies.iter() {
        if !(p.contract == policy.contract && p.func == policy.func) {
            out.push_back(p);
        }
    }
    if policy.threshold > 0 {
        out.push_back(policy.clone());
    }
    out
}

/// Re-validates (the config may have changed since `propose`) and stores a
/// new configuration under the next epoch.
fn apply_config(
    env: &Env,
    old: Config,
    signers: Vec<BytesN<32>>,
    threshold: u32,
    policy: Option<FnPolicy>,
) -> Result<(), MultisigError> {
    let policies = match policy {
        Some(p) => with_policy(env, &old.policies, &p),
        None => old.policies,
    };
    validate_config(&signers, threshold, &policies)?;
    let epoch = old.epoch + 1;
    let n = signers.len();
    put_config(
        env,
        &Config {
            signers,
            threshold,
            epoch,
            policies,
        },
    );
    ConfigChanged {
        epoch,
        threshold,
        signers: n,
    }
    .publish(env);
    Ok(())
}

fn hash_action(env: &Env, action: &Action) -> BytesN<32> {
    env.crypto().sha256(&action.clone().to_xdr(env)).into()
}

fn op_code(op: Op) -> u32 {
    match op {
        Op::Propose => 1,
        Op::Approve => 2,
        Op::Revoke => 3,
    }
}

fn payload(
    env: &Env,
    op: Op,
    proposal_id: u64,
    epoch: u32,
    action_hash: &BytesN<32>,
    expires_at: u64,
) -> BytesN<32> {
    let mut b = Bytes::from_slice(env, DOMAIN_TAG);
    b.append(&Bytes::from(env.ledger().network_id()));
    b.append(&env.current_contract_address().to_xdr(env));
    b.extend_from_array(&op_code(op).to_be_bytes());
    b.extend_from_array(&proposal_id.to_be_bytes());
    b.extend_from_array(&epoch.to_be_bytes());
    b.append(&Bytes::from(action_hash.clone()));
    b.extend_from_array(&expires_at.to_be_bytes());
    env.crypto().sha256(&b).into()
}
