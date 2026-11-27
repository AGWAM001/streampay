//! Unit tests for the reference multisig. Every signature here is a real
//! ed25519 signature: `__check_auth` and the proposal flow verify them
//! on-chain, so nothing below mocks the multisig's own authorization.

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    auth::ContractContext,
    contract, contractimpl,
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    vec, Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};
use std::vec::Vec as StdVec;

// ----------------------------------------------------------------------
// A target contract the multisig calls through proposals.
// ----------------------------------------------------------------------

#[contract]
pub struct Target;

#[contractimpl]
impl Target {
    /// Requires `caller`'s auth and records `v`.
    pub fn ping(env: Env, caller: Address, v: u32) -> u32 {
        caller.require_auth();
        env.storage().instance().set(&Symbol::new(&env, "last"), &v);
        v
    }

    /// Calls `inner.ping(caller, 7)`: `caller` is *not* the direct invoker
    /// of `inner`, so its auth must be pre-authorized.
    pub fn deep(env: Env, inner: Address, caller: Address) -> u32 {
        TargetClient::new(&env, &inner).ping(&caller, &7)
    }

    pub fn last(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "last"))
            .unwrap_or(0)
    }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

/// `n` signing keys, sorted ascending by public key.
fn keys(n: u8) -> StdVec<SigningKey> {
    let mut ks: StdVec<SigningKey> = (0..n)
        .map(|i| SigningKey::from_bytes(&[i.wrapping_mul(37).wrapping_add(11); 32]))
        .collect();
    ks.sort_by_key(|k| k.verifying_key().to_bytes());
    ks
}

fn pk(env: &Env, k: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &k.verifying_key().to_bytes())
}

fn sign(env: &Env, k: &SigningKey, msg: &BytesN<32>) -> BytesN<64> {
    BytesN::from_array(env, &k.sign(&msg.to_array()).to_bytes())
}

fn signer_vec(env: &Env, ks: &[SigningKey]) -> Vec<BytesN<32>> {
    let mut v = Vec::new(env);
    for k in ks {
        v.push_back(pk(env, k));
    }
    v
}

fn new_env() -> Env {
    let mut env = Env::default();
    env.set_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().set_timestamp(1_000);
    env
}

struct Fx {
    env: Env,
    ks: StdVec<SigningKey>,
    ms: MultisigClient<'static>,
    target: TargetClient<'static>,
}

fn setup(n: u8, threshold: u32) -> Fx {
    let env = new_env();
    let ks = keys(n);
    let id = env.register(Multisig, (signer_vec(&env, &ks), threshold));
    let target_id = env.register(Target, ());
    let ms = MultisigClient::new(&env, &id);
    let target = TargetClient::new(&env, &target_id);
    Fx {
        env,
        ks,
        ms,
        target,
    }
}

impl Fx {
    fn ping_call(&self, v: u32) -> Call {
        Call {
            contract: self.target.address.clone(),
            func: Symbol::new(&self.env, "ping"),
            args: vec![
                &self.env,
                self.ms.address.into_val(&self.env),
                v.into_val(&self.env),
            ],
            auth: Vec::new(&self.env),
        }
    }

    fn invoke(&self, calls: StdVec<Call>) -> Action {
        let mut v = Vec::new(&self.env);
        for c in calls {
            v.push_back(c);
        }
        Action::Invoke(v)
    }

    fn expiry(&self) -> u64 {
        self.env.ledger().timestamp() + 3_600
    }

    fn propose_as(&self, k: usize, action: &Action, expires_at: u64) -> u64 {
        let id = self.ms.next_proposal_id();
        let h = self.ms.action_hash(action);
        let msg = self.ms.signing_payload(&Op::Propose, &id, &h, &expires_at);
        self.ms.propose(
            &pk(&self.env, &self.ks[k]),
            action,
            &expires_at,
            &sign(&self.env, &self.ks[k], &msg),
        )
    }

    fn approval_sig(&self, k: usize, op: Op, id: u64) -> BytesN<64> {
        let p = self.ms.get_proposal(&id).unwrap();
        let msg = self
            .ms
            .signing_payload(&op, &id, &p.action_hash, &p.expires_at);
        sign(&self.env, &self.ks[k], &msg)
    }

    fn approve_as(&self, k: usize, id: u64) -> u32 {
        let sig = self.approval_sig(k, Op::Approve, id);
        self.ms.approve(&id, &pk(&self.env, &self.ks[k]), &sig)
    }

    /// Proposes as `ks[0]`, approves with `ks[1..approvers]`, executes.
    fn pass(&self, action: &Action, approvers: usize) -> Vec<Val> {
        let id = self.propose_as(0, action, self.expiry());
        for k in 1..approvers {
            self.approve_as(k, id);
        }
        self.ms.execute(&id)
    }

    fn sigs(&self, idx: &[usize], payload: &BytesN<32>) -> Vec<SignerSignature> {
        let mut v = Vec::new(&self.env);
        for &i in idx {
            v.push_back(SignerSignature {
                public_key: pk(&self.env, &self.ks[i]),
                signature: sign(&self.env, &self.ks[i], payload),
            });
        }
        v
    }

    fn ctx(&self, contract: &Address, func: &str) -> Context {
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: Symbol::new(&self.env, func),
            args: Vec::new(&self.env),
        })
    }

    fn check_auth(
        &self,
        payload: &BytesN<32>,
        sigs: Vec<SignerSignature>,
        ctxs: Vec<Context>,
    ) -> Result<(), Result<MultisigError, soroban_sdk::InvokeError>> {
        self.env.try_invoke_contract_check_auth::<MultisigError>(
            &self.ms.address,
            payload,
            sigs.into_val(&self.env),
            &ctxs,
        )
    }

    fn payload(&self, b: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[b; 32])
    }
}

// ----------------------------------------------------------------------
// Constructor / config validation
// ----------------------------------------------------------------------

#[test]
fn constructor_stores_config() {
    let f = setup(3, 2);
    let c = f.ms.config();
    assert_eq!(c.signers, signer_vec(&f.env, &f.ks));
    assert_eq!(c.threshold, 2);
    assert_eq!(c.epoch, 0);
    assert!(c.policies.is_empty());
    assert!(f.ms.is_signer(&pk(&f.env, &f.ks[2])));
    assert!(!f.ms.is_signer(&f.payload(9)));
    assert_eq!(f.ms.next_proposal_id(), 1);
    assert!(f.ms.get_proposal(&1).is_none());
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn constructor_rejects_empty_signers() {
    let env = new_env();
    env.register(Multisig, (Vec::<BytesN<32>>::new(&env), 1u32));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_zero_threshold() {
    let env = new_env();
    env.register(Multisig, (signer_vec(&env, &keys(2)), 0u32));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_threshold_above_n() {
    let env = new_env();
    env.register(Multisig, (signer_vec(&env, &keys(2)), 3u32));
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn constructor_rejects_unsorted_signers() {
    let env = new_env();
    let mut ks = keys(2);
    ks.reverse();
    env.register(Multisig, (signer_vec(&env, &ks), 1u32));
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn constructor_rejects_duplicate_signers() {
    let env = new_env();
    let ks = keys(1);
    let v = signer_vec(&env, &[ks[0].clone(), ks[0].clone()]);
    env.register(Multisig, (v, 1u32));
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn constructor_rejects_too_many_signers() {
    let env = new_env();
    let ks = keys(MAX_SIGNERS as u8 + 1);
    env.register(Multisig, (signer_vec(&env, &ks), 1u32));
}

// ----------------------------------------------------------------------
// __check_auth
// ----------------------------------------------------------------------

#[test]
fn check_auth_two_of_three_passes() {
    let f = setup(3, 2);
    let p = f.payload(1);
    let ctx = vec![&f.env, f.ctx(&f.target.address, "ping")];
    assert_eq!(f.check_auth(&p, f.sigs(&[0, 1], &p), ctx.clone()), Ok(()));
    assert_eq!(f.check_auth(&p, f.sigs(&[0, 2], &p), ctx.clone()), Ok(()));
    assert_eq!(f.check_auth(&p, f.sigs(&[0, 1, 2], &p), ctx), Ok(()));
}

#[test]
fn check_auth_rejects_below_threshold() {
    let f = setup(3, 2);
    let p = f.payload(1);
    let ctx = vec![&f.env, f.ctx(&f.target.address, "ping")];
    assert_eq!(
        f.check_auth(&p, f.sigs(&[1], &p), ctx.clone()),
        Err(Ok(MultisigError::BelowThreshold))
    );
    assert_eq!(
        f.check_auth(&p, Vec::new(&f.env), ctx),
        Err(Ok(MultisigError::BelowThreshold))
    );
}

#[test]
fn check_auth_rejects_duplicate_signer() {
    let f = setup(3, 2);
    let p = f.payload(1);
    let ctx = vec![&f.env, f.ctx(&f.target.address, "ping")];
    // The same signer twice must not count as two signatures.
    assert_eq!(
        f.check_auth(&p, f.sigs(&[1, 1], &p), ctx),
        Err(Ok(MultisigError::DuplicateSignature))
    );
}

#[test]
fn check_auth_rejects_unsorted_signatures() {
    let f = setup(3, 2);
    let p = f.payload(1);
    let ctx = vec![&f.env, f.ctx(&f.target.address, "ping")];
    assert_eq!(
        f.check_auth(&p, f.sigs(&[2, 0], &p), ctx),
        Err(Ok(MultisigError::DuplicateSignature))
    );
}

#[test]
fn check_auth_rejects_non_member() {
    let f = setup(3, 2);
    let outsider = SigningKey::from_bytes(&[200; 32]);
    let p = f.payload(1);
    let mut sigs = f.sigs(&[0], &p);
    sigs.push_back(SignerSignature {
        public_key: pk(&f.env, &outsider),
        signature: sign(&f.env, &outsider, &p),
    });
    // Order the pair so the only failure is membership.
    let (a, b) = (sigs.get(0).unwrap(), sigs.get(1).unwrap());
    let sigs = if a.public_key < b.public_key {
        vec![&f.env, a, b]
    } else {
        vec![&f.env, b, a]
    };
    let ctx = vec![&f.env, f.ctx(&f.target.address, "ping")];
    assert_eq!(
        f.check_auth(&p, sigs, ctx),
        Err(Ok(MultisigError::NotASigner))
    );
}

#[test]
fn check_auth_rejects_bad_signature() {
    let f = setup(3, 2);
    let p = f.payload(1);
    // Signed over a different payload: ed25519 verification traps.
    let sigs = f.sigs(&[0, 1], &f.payload(2));
    let ctx = vec![&f.env, f.ctx(&f.target.address, "ping")];
    let res = f.check_auth(&p, sigs, ctx);
    assert!(matches!(res, Err(Err(_))), "{res:?}");
}

#[test]
fn check_auth_empty_contexts_need_default_threshold() {
    let f = setup(3, 2);
    let p = f.payload(1);
    assert_eq!(
        f.check_auth(&p, f.sigs(&[0], &p), Vec::new(&f.env)),
        Err(Ok(MultisigError::BelowThreshold))
    );
    assert_eq!(
        f.check_auth(&p, f.sigs(&[0, 1], &p), Vec::new(&f.env)),
        Ok(())
    );
}

#[test]
fn check_auth_policy_relaxes_one_function_only() {
    let f = setup(3, 2);
    let policy = FnPolicy {
        contract: f.target.address.clone(),
        func: Symbol::new(&f.env, "ping"),
        threshold: 1,
    };
    f.pass(&Action::SetPolicy(policy), 2);

    let p = f.payload(1);
    // One signature is enough for the relaxed function...
    let ping = vec![&f.env, f.ctx(&f.target.address, "ping")];
    assert_eq!(f.check_auth(&p, f.sigs(&[2], &p), ping), Ok(()));
    // ...but not for another function on the same contract...
    let deep = vec![&f.env, f.ctx(&f.target.address, "deep")];
    assert_eq!(
        f.check_auth(&p, f.sigs(&[2], &p), deep),
        Err(Ok(MultisigError::BelowThreshold))
    );
    // ...nor for the same name on another contract...
    let other = Address::generate(&f.env);
    let elsewhere = vec![&f.env, f.ctx(&other, "ping")];
    assert_eq!(
        f.check_auth(&p, f.sigs(&[2], &p), elsewhere),
        Err(Ok(MultisigError::BelowThreshold))
    );
    // ...and bundling it with a stricter call takes the stricter threshold.
    let mixed = vec![
        &f.env,
        f.ctx(&f.target.address, "ping"),
        f.ctx(&f.target.address, "deep"),
    ];
    assert_eq!(
        f.check_auth(&p, f.sigs(&[2], &p), mixed.clone()),
        Err(Ok(MultisigError::BelowThreshold))
    );
    assert_eq!(f.check_auth(&p, f.sigs(&[1, 2], &p), mixed), Ok(()));
}

#[test]
fn check_auth_policy_can_tighten() {
    let f = setup(3, 1);
    let policy = FnPolicy {
        contract: f.target.address.clone(),
        func: Symbol::new(&f.env, "ping"),
        threshold: 3,
    };
    f.pass(&Action::SetPolicy(policy), 1);
    let p = f.payload(1);
    let ping = vec![&f.env, f.ctx(&f.target.address, "ping")];
    assert_eq!(
        f.check_auth(&p, f.sigs(&[0, 1], &p), ping.clone()),
        Err(Ok(MultisigError::BelowThreshold))
    );
    assert_eq!(f.check_auth(&p, f.sigs(&[0, 1, 2], &p), ping), Ok(()));
}

#[test]
fn check_auth_contract_creation_needs_default_threshold() {
    use soroban_sdk::auth::CreateContractHostFnContext;
    let f = setup(3, 2);
    let p = f.payload(1);
    let ctx = vec![
        &f.env,
        Context::CreateContractHostFn(CreateContractHostFnContext {
            executable: soroban_sdk::auth::ContractExecutable::Wasm(f.payload(3)),
            salt: f.payload(4),
        }),
    ];
    assert_eq!(
        f.check_auth(&p, f.sigs(&[0], &p), ctx.clone()),
        Err(Ok(MultisigError::BelowThreshold))
    );
    assert_eq!(f.check_auth(&p, f.sigs(&[0, 1], &p), ctx), Ok(()));
}

#[test]
fn check_auth_uses_current_signer_set() {
    let f = setup(3, 2);
    // Replace signers {0,1,2} with {1,2}; key 0 no longer counts.
    let update = SignerUpdate {
        signers: signer_vec(&f.env, &f.ks[1..]),
        threshold: 2,
    };
    f.pass(&Action::SetSigners(update), 2);
    let p = f.payload(1);
    let ctx = vec![&f.env, f.ctx(&f.target.address, "ping")];
    assert_eq!(
        f.check_auth(&p, f.sigs(&[0, 1], &p), ctx.clone()),
        Err(Ok(MultisigError::NotASigner))
    );
    assert_eq!(f.check_auth(&p, f.sigs(&[1, 2], &p), ctx), Ok(()));
}

// ----------------------------------------------------------------------
// Proposal flow
// ----------------------------------------------------------------------

#[test]
fn propose_approve_execute_invokes_target() {
    let f = setup(3, 2);
    let action = f.invoke(std::vec![f.ping_call(42)]);
    assert_eq!(f.ms.required_approvals(&action), 2);
    let id = f.propose_as(0, &action, f.expiry());
    assert_eq!(id, 1);
    assert_eq!(f.ms.next_proposal_id(), 2);

    // One approval (the proposer's) is not enough.
    assert_eq!(
        f.ms.try_execute(&id),
        Err(Ok(MultisigError::BelowThreshold))
    );
    assert_eq!(f.approve_as(2, id), 2);

    let out = f.ms.execute(&id);
    assert_eq!(out.len(), 1);
    let v: u32 = soroban_sdk::FromVal::from_val(&f.env, &out.get(0).unwrap());
    assert_eq!(v, 42);
    assert_eq!(f.target.last(), 42);

    let p = f.ms.get_proposal(&id).unwrap();
    assert_eq!(p.status, ProposalStatus::Executed);
    assert_eq!(p.approvals.len(), 2);
    assert_eq!(p.proposer, pk(&f.env, &f.ks[0]));
    // Executed proposals cannot run (or be approved / revoked) again.
    assert_eq!(
        f.ms.try_execute(&id),
        Err(Ok(MultisigError::ProposalNotPending))
    );
    let sig = f.approval_sig(1, Op::Approve, id);
    assert_eq!(
        f.ms.try_approve(&id, &pk(&f.env, &f.ks[1]), &sig),
        Err(Ok(MultisigError::ProposalNotPending))
    );
    let sig = f.approval_sig(0, Op::Revoke, id);
    assert_eq!(
        f.ms.try_revoke(&id, &sig),
        Err(Ok(MultisigError::ProposalNotPending))
    );
}

#[test]
fn multi_call_action_runs_in_order() {
    let f = setup(2, 2);
    let action = f.invoke(std::vec![f.ping_call(1), f.ping_call(2)]);
    let out = f.pass(&action, 2);
    assert_eq!(out.len(), 2);
    assert_eq!(f.target.last(), 2);
}

#[test]
fn duplicate_approval_rejected() {
    let f = setup(3, 2);
    let id = f.propose_as(0, &f.invoke(std::vec![f.ping_call(1)]), f.expiry());
    // The proposer already approved by proposing.
    let sig = f.approval_sig(0, Op::Approve, id);
    assert_eq!(
        f.ms.try_approve(&id, &pk(&f.env, &f.ks[0]), &sig),
        Err(Ok(MultisigError::AlreadyApproved))
    );
    f.approve_as(1, id);
    let sig = f.approval_sig(1, Op::Approve, id);
    assert_eq!(
        f.ms.try_approve(&id, &pk(&f.env, &f.ks[1]), &sig),
        Err(Ok(MultisigError::AlreadyApproved))
    );
}

#[test]
fn non_member_cannot_propose_or_approve() {
    let f = setup(3, 2);
    let outsider = SigningKey::from_bytes(&[201; 32]);
    let action = f.invoke(std::vec![f.ping_call(1)]);
    let h = f.ms.action_hash(&action);
    let exp = f.expiry();
    let msg = f.ms.signing_payload(&Op::Propose, &1, &h, &exp);
    assert_eq!(
        f.ms.try_propose(
            &pk(&f.env, &outsider),
            &action,
            &exp,
            &sign(&f.env, &outsider, &msg)
        ),
        Err(Ok(MultisigError::NotASigner))
    );
    let id = f.propose_as(0, &action, exp);
    let p = f.ms.get_proposal(&id).unwrap();
    let msg =
        f.ms.signing_payload(&Op::Approve, &id, &p.action_hash, &p.expires_at);
    assert_eq!(
        f.ms.try_approve(&id, &pk(&f.env, &outsider), &sign(&f.env, &outsider, &msg)),
        Err(Ok(MultisigError::NotASigner))
    );
}

#[test]
fn approval_signature_must_match_op_and_signer() {
    let f = setup(3, 2);
    let id = f.propose_as(0, &f.invoke(std::vec![f.ping_call(1)]), f.expiry());
    // A Revoke-payload signature cannot be used as an approval.
    let wrong_op = f.approval_sig(1, Op::Revoke, id);
    assert!(f
        .ms
        .try_approve(&id, &pk(&f.env, &f.ks[1]), &wrong_op)
        .is_err());
    // Signer 2's signature cannot be submitted as signer 1's approval.
    let other = f.approval_sig(2, Op::Approve, id);
    assert!(f
        .ms
        .try_approve(&id, &pk(&f.env, &f.ks[1]), &other)
        .is_err());
    assert_eq!(f.ms.get_proposal(&id).unwrap().approvals.len(), 1);
}

#[test]
fn propose_signature_binds_action() {
    let f = setup(3, 2);
    let a = f.invoke(std::vec![f.ping_call(1)]);
    let b = f.invoke(std::vec![f.ping_call(2)]);
    let exp = f.expiry();
    let msg =
        f.ms.signing_payload(&Op::Propose, &1, &f.ms.action_hash(&a), &exp);
    // Signature over action `a`, submitted with action `b`.
    assert!(f
        .ms
        .try_propose(
            &pk(&f.env, &f.ks[0]),
            &b,
            &exp,
            &sign(&f.env, &f.ks[0], &msg)
        )
        .is_err());
}

#[test]
fn revoke_by_proposer() {
    let f = setup(3, 2);
    let id = f.propose_as(1, &f.invoke(std::vec![f.ping_call(1)]), f.expiry());
    f.approve_as(2, id);
    // Only the proposer's key can revoke.
    let not_proposer = f.approval_sig(2, Op::Revoke, id);
    assert!(f.ms.try_revoke(&id, &not_proposer).is_err());

    f.ms.revoke(&id, &f.approval_sig(1, Op::Revoke, id));
    assert_eq!(
        f.ms.get_proposal(&id).unwrap().status,
        ProposalStatus::Revoked
    );
    assert_eq!(
        f.ms.try_execute(&id),
        Err(Ok(MultisigError::ProposalNotPending))
    );
    let sig = f.approval_sig(0, Op::Approve, id);
    assert_eq!(
        f.ms.try_approve(&id, &pk(&f.env, &f.ks[0]), &sig),
        Err(Ok(MultisigError::ProposalNotPending))
    );
    assert_eq!(f.target.last(), 0);
}

#[test]
fn unknown_proposal() {
    let f = setup(3, 2);
    assert_eq!(
        f.ms.try_execute(&9),
        Err(Ok(MultisigError::ProposalNotFound))
    );
    let zero = BytesN::from_array(&f.env, &[0; 64]);
    assert_eq!(
        f.ms.try_revoke(&9, &zero),
        Err(Ok(MultisigError::ProposalNotFound))
    );
    assert_eq!(
        f.ms.try_approve(&9, &pk(&f.env, &f.ks[0]), &zero),
        Err(Ok(MultisigError::ProposalNotFound))
    );
}

#[test]
fn expiry_is_enforced() {
    let f = setup(3, 2);
    let action = f.invoke(std::vec![f.ping_call(1)]);
    let now = f.env.ledger().timestamp();
    let k = pk(&f.env, &f.ks[0]);
    let zero = BytesN::from_array(&f.env, &[0; 64]);
    for bad in [now, now - 1, now + MAX_PROPOSAL_TTL + 1] {
        assert_eq!(
            f.ms.try_propose(&k, &action, &bad, &zero),
            Err(Ok(MultisigError::InvalidExpiry))
        );
    }
    let id = f.propose_as(0, &action, now + MAX_PROPOSAL_TTL);
    let id2 = f.propose_as(0, &action, now + 10);
    f.env.ledger().set_timestamp(now + 10);
    let sig = f.approval_sig(1, Op::Approve, id2);
    assert_eq!(
        f.ms.try_approve(&id2, &pk(&f.env, &f.ks[1]), &sig),
        Err(Ok(MultisigError::ProposalExpired))
    );
    assert_eq!(
        f.ms.try_execute(&id2),
        Err(Ok(MultisigError::ProposalExpired))
    );
    // The long-lived one is still open.
    f.approve_as(1, id);
    f.ms.execute(&id);
}

#[test]
fn invalid_invoke_actions_rejected() {
    let f = setup(3, 2);
    let k = pk(&f.env, &f.ks[0]);
    let zero = BytesN::from_array(&f.env, &[0; 64]);
    let exp = f.expiry();

    let empty = Action::Invoke(Vec::new(&f.env));
    assert_eq!(
        f.ms.try_propose(&k, &empty, &exp, &zero),
        Err(Ok(MultisigError::EmptyAction))
    );
    // An empty action still reports the default threshold.
    assert_eq!(f.ms.required_approvals(&empty), 2);

    let many = f.invoke((0..=MAX_CALLS).map(|i| f.ping_call(i)).collect());
    assert_eq!(
        f.ms.try_propose(&k, &many, &exp, &zero),
        Err(Ok(MultisigError::TooManyCalls))
    );

    let mut self_call = f.ping_call(1);
    self_call.contract = f.ms.address.clone();
    let self_call = f.invoke(std::vec![self_call]);
    assert_eq!(
        f.ms.try_propose(&k, &self_call, &exp, &zero),
        Err(Ok(MultisigError::SelfCall))
    );
}

#[test]
fn failing_call_reverts_the_whole_execution() {
    let f = setup(2, 2);
    let mut bad = f.ping_call(5);
    bad.func = Symbol::new(&f.env, "no_such_fn");
    let action = f.invoke(std::vec![f.ping_call(1), bad]);
    let id = f.propose_as(0, &action, f.expiry());
    f.approve_as(1, id);
    assert!(f.ms.try_execute(&id).is_err());
    // Atomic: no call took effect and the proposal is still pending.
    assert_eq!(f.target.last(), 0);
    assert_eq!(
        f.ms.get_proposal(&id).unwrap().status,
        ProposalStatus::Pending
    );
}

#[test]
fn nested_auth_via_authorize_as_current_contract() {
    use soroban_sdk::auth::SubContractInvocation;
    let f = setup(2, 1);
    let inner = TargetClient::new(&f.env, &f.env.register(Target, ()));
    let deep_args: Vec<Val> = vec![
        &f.env,
        inner.address.into_val(&f.env),
        f.ms.address.into_val(&f.env),
    ];

    // Without pre-authorization the inner ping's require_auth fails: the
    // multisig is not the direct invoker of `inner`.
    let no_auth = Call {
        contract: f.target.address.clone(),
        func: Symbol::new(&f.env, "deep"),
        args: deep_args.clone(),
        auth: Vec::new(&f.env),
    };
    let id = f.propose_as(0, &f.invoke(std::vec![no_auth]), f.expiry());
    assert!(f.ms.try_execute(&id).is_err());

    let entry = InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: inner.address.clone(),
            fn_name: Symbol::new(&f.env, "ping"),
            args: vec![&f.env, f.ms.address.into_val(&f.env), 7u32.into_val(&f.env)],
        },
        sub_invocations: Vec::new(&f.env),
    });
    let with_auth = Call {
        contract: f.target.address.clone(),
        func: Symbol::new(&f.env, "deep"),
        args: deep_args,
        auth: vec![&f.env, entry],
    };
    f.pass(&f.invoke(std::vec![with_auth]), 1);
    assert_eq!(inner.last(), 7);
}

// ----------------------------------------------------------------------
// Configuration changes
// ----------------------------------------------------------------------

#[test]
fn member_change_invalidates_in_flight_proposals() {
    let f = setup(3, 2);
    let pending = f.propose_as(0, &f.invoke(std::vec![f.ping_call(9)]), f.expiry());
    f.approve_as(1, pending);

    // Rotate in a fourth key, raising the threshold to 3.
    let mut ks4 = keys(4);
    ks4.retain(|k| f.ks.iter().all(|o| o.verifying_key() != k.verifying_key()));
    let mut all = f.ks.clone();
    all.push(ks4[0].clone());
    all.sort_by_key(|k| k.verifying_key().to_bytes());
    let update = SignerUpdate {
        signers: signer_vec(&f.env, &all),
        threshold: 3,
    };
    f.pass(&Action::SetSigners(update), 2);
    let c = f.ms.config();
    assert_eq!((c.threshold, c.epoch, c.signers.len()), (3, 1, 4));

    // The proposal approved under epoch 0 can no longer move.
    assert_eq!(
        f.ms.try_execute(&pending),
        Err(Ok(MultisigError::StaleProposal))
    );
    let sig = f.approval_sig(2, Op::Approve, pending);
    assert_eq!(
        f.ms.try_approve(&pending, &pk(&f.env, &f.ks[2]), &sig),
        Err(Ok(MultisigError::StaleProposal))
    );
    // The proposer can still revoke it (signed under its original epoch).
    let p = f.ms.get_proposal(&pending).unwrap();
    let mut b = Bytes::from_slice(&f.env, DOMAIN_TAG);
    b.append(&Bytes::from(f.env.ledger().network_id()));
    b.append(&f.ms.address.clone().to_xdr(&f.env));
    b.extend_from_array(&3u32.to_be_bytes());
    b.extend_from_array(&pending.to_be_bytes());
    b.extend_from_array(&0u32.to_be_bytes());
    b.append(&Bytes::from(p.action_hash.clone()));
    b.extend_from_array(&p.expires_at.to_be_bytes());
    let msg: BytesN<32> = f.env.crypto().sha256(&b).into();
    f.ms.revoke(&pending, &sign(&f.env, &f.ks[0], &msg));
    assert_eq!(f.target.last(), 0);
}

#[test]
fn set_signers_validation() {
    let f = setup(3, 2);
    let k = pk(&f.env, &f.ks[0]);
    let zero = BytesN::from_array(&f.env, &[0; 64]);
    let exp = f.expiry();
    let bad = |signers: Vec<BytesN<32>>, threshold: u32| {
        f.ms.try_propose(
            &k,
            &Action::SetSigners(SignerUpdate { signers, threshold }),
            &exp,
            &zero,
        )
    };
    assert_eq!(bad(Vec::new(&f.env), 1), Err(Ok(MultisigError::NoSigners)));
    assert_eq!(
        bad(signer_vec(&f.env, &f.ks), 4),
        Err(Ok(MultisigError::InvalidThreshold))
    );
    let mut rev = f.ks.clone();
    rev.reverse();
    assert_eq!(
        bad(signer_vec(&f.env, &rev), 1),
        Err(Ok(MultisigError::SignersNotSorted))
    );
}

#[test]
fn config_actions_need_default_threshold_even_with_relaxed_policy() {
    let f = setup(3, 2);
    let relax = FnPolicy {
        contract: f.target.address.clone(),
        func: Symbol::new(&f.env, "ping"),
        threshold: 1,
    };
    f.pass(&Action::SetPolicy(relax.clone()), 2);
    assert_eq!(f.ms.config().policies, vec![&f.env, relax.clone()]);
    assert_eq!(f.ms.config().epoch, 1);

    // The relaxed call executes with the proposer's approval alone.
    assert_eq!(
        f.ms.required_approvals(&f.invoke(std::vec![f.ping_call(3)])),
        1
    );
    f.pass(&f.invoke(std::vec![f.ping_call(3)]), 1);
    assert_eq!(f.target.last(), 3);

    // Governance actions still need the default threshold.
    let update = SignerUpdate {
        signers: signer_vec(&f.env, &f.ks),
        threshold: 1,
    };
    let action = Action::SetSigners(update);
    assert_eq!(f.ms.required_approvals(&action), 2);
    let id = f.propose_as(2, &action, f.expiry());
    assert_eq!(
        f.ms.try_execute(&id),
        Err(Ok(MultisigError::BelowThreshold))
    );

    // Updating, then removing, the policy.
    let mut stricter = relax.clone();
    stricter.threshold = 3;
    f.pass(&Action::SetPolicy(stricter.clone()), 2);
    assert_eq!(f.ms.config().policies, vec![&f.env, stricter]);
    let mut remove = relax;
    remove.threshold = 0;
    f.pass(&Action::SetPolicy(remove), 2);
    assert!(f.ms.config().policies.is_empty());
    assert_eq!(f.ms.config().epoch, 3);
}

#[test]
fn policy_validation() {
    let f = setup(2, 1);
    let k = pk(&f.env, &f.ks[0]);
    let zero = BytesN::from_array(&f.env, &[0; 64]);
    let exp = f.expiry();
    let too_high = FnPolicy {
        contract: f.target.address.clone(),
        func: Symbol::new(&f.env, "ping"),
        threshold: 3,
    };
    assert_eq!(
        f.ms.try_propose(&k, &Action::SetPolicy(too_high), &exp, &zero),
        Err(Ok(MultisigError::InvalidPolicy))
    );

    // A policy of 2 blocks shrinking the set to one signer.
    let two = FnPolicy {
        contract: f.target.address.clone(),
        func: Symbol::new(&f.env, "ping"),
        threshold: 2,
    };
    f.pass(&Action::SetPolicy(two), 1);
    let shrink = Action::SetSigners(SignerUpdate {
        signers: signer_vec(&f.env, &f.ks[..1]),
        threshold: 1,
    });
    assert_eq!(
        f.ms.try_propose(&k, &shrink, &exp, &zero),
        Err(Ok(MultisigError::InvalidPolicy))
    );

    // Policy count cap.
    for i in 1..MAX_POLICIES {
        let p = FnPolicy {
            contract: f.target.address.clone(),
            func: Symbol::new(&f.env, &std::format!("f{i}")),
            threshold: 1,
        };
        f.pass(&Action::SetPolicy(p), 1);
    }
    assert_eq!(f.ms.config().policies.len(), MAX_POLICIES);
    let one_more = FnPolicy {
        contract: f.target.address.clone(),
        func: Symbol::new(&f.env, "overflow"),
        threshold: 1,
    };
    assert_eq!(
        f.ms.try_propose(&k, &Action::SetPolicy(one_more), &exp, &zero),
        Err(Ok(MultisigError::TooManyPolicies))
    );
}

// ----------------------------------------------------------------------
// Replay / domain separation
// ----------------------------------------------------------------------

#[test]
fn proposal_signatures_do_not_replay_across_contracts_or_networks() {
    let f = setup(3, 2);
    // A second multisig with the same signers.
    let twin = MultisigClient::new(
        &f.env,
        &f.env.register(Multisig, (signer_vec(&f.env, &f.ks), 2u32)),
    );
    let action = f.invoke(std::vec![f.ping_call(1)]);
    let exp = f.expiry();
    let h = f.ms.action_hash(&action);
    let msg = f.ms.signing_payload(&Op::Propose, &1, &h, &exp);
    let sig = sign(&f.env, &f.ks[0], &msg);
    let k = pk(&f.env, &f.ks[0]);

    // Same id, same action, same epoch, different contract: rejected.
    assert_ne!(twin.signing_payload(&Op::Propose, &1, &h, &exp), msg);
    assert!(twin.try_propose(&k, &action, &exp, &sig).is_err());

    // Same contract on a different network: payload changes, rejected.
    f.env.ledger().set_network_id([7; 32]);
    assert_ne!(f.ms.signing_payload(&Op::Propose, &1, &h, &exp), msg);
    assert!(f.ms.try_propose(&k, &action, &exp, &sig).is_err());
}

#[test]
fn events_are_emitted() {
    use soroban_sdk::testutils::Events as _;
    let f = setup(2, 2);
    let id = f.propose_as(0, &f.invoke(std::vec![f.ping_call(1)]), f.expiry());
    assert!(!f.env.events().all().events().is_empty());
    f.approve_as(1, id);
    assert!(!f.env.events().all().events().is_empty());
    f.ms.execute(&id);
    assert!(!f.env.events().all().events().is_empty());
}
