//! End-to-end: the reference multisig as a StreamPay sender and recipient.
//!
//! The streaming contract is the real `streampay-contract` crate, unmodified.
//! Every authorization *of the multisig* below is real: either a signed
//! Soroban authorization entry verified by `Multisig::__check_auth`
//! (`env.set_auths`, no mocking), or a proposal whose approvals are ed25519
//! signatures checked on-chain. `mock_all_auths` is used only for the test
//! scaffolding around it (minting test tokens, a classic-account sender).

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{
        Hash, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits,
        ScAddress, ScSymbol, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, VecM, WriteXdr,
    },
    Address, Bytes, BytesN, Env, FromVal, IntoVal, Symbol, TryFromVal, Val, Vec,
};
use streampay_contract::{
    test_client::StreamingPaymentsClient, StreamStatus, StreamingPayments, MIN_STREAM_DEPOSIT,
};
use streampay_multisig::{
    Action, Call, FnPolicy, Multisig, MultisigClient, MultisigError, Op, SignerSignature,
};

/// The streaming contract refuses deposits below `MIN_STREAM_DEPOSIT`; half of
/// it (the halfway withdrawal below) still clears `MIN_CLAIM_AMOUNT`.
const DEPOSIT: i128 = MIN_STREAM_DEPOSIT;
const START: u64 = 10_000;
const DURATION: u64 = 1_000;

struct World {
    env: Env,
    ks: std::vec::Vec<SigningKey>,
    ms: MultisigClient<'static>,
    streaming: StreamingPaymentsClient<'static>,
    token: TokenClient<'static>,
    nonce: core::cell::Cell<i64>,
}

fn keys() -> std::vec::Vec<SigningKey> {
    let mut ks: std::vec::Vec<SigningKey> = [3u8, 5, 9]
        .iter()
        .map(|b| SigningKey::from_bytes(&[*b; 32]))
        .collect();
    ks.sort_by_key(|k| k.verifying_key().to_bytes());
    ks
}

fn pk(env: &Env, k: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &k.verifying_key().to_bytes())
}

/// A 2-of-3 multisig, the real streaming contract and a SAC token. The
/// multisig holds `10 * DEPOSIT` tokens.
fn world() -> World {
    let mut env = Env::default();
    env.set_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().set_timestamp(START - 100);
    env.ledger().set_sequence_number(100);

    let ks = keys();
    let mut signers = Vec::new(&env);
    for k in &ks {
        signers.push_back(pk(&env, k));
    }
    let ms = MultisigClient::new(&env, &env.register(Multisig, (signers, 2u32)));
    let governor = Address::generate(&env);
    let streaming =
        StreamingPaymentsClient::new(&env, &env.register(StreamingPayments, (governor,)));
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = TokenClient::new(&env, &sac.address());

    // Scaffolding only: the SAC admin mints with mocked auth.
    env.mock_all_auths();
    StellarAssetClient::new(&env, &sac.address()).mint(&ms.address, &(10 * DEPOSIT));
    // From here on, nothing is mocked unless a test opts in again.
    env.set_auths(&[]);

    World {
        env,
        ks,
        ms,
        streaming,
        token,
        nonce: core::cell::Cell::new(1),
    }
}

impl World {
    /// Installs a signed authorization entry for `contract.func(args)` on
    /// behalf of the multisig, signed by `signers` (indices into `ks`). The
    /// payload is the one the host hands to `__check_auth`:
    /// `sha256(HashIdPreimage::SorobanAuthorization { network_id, nonce,
    /// signature_expiration_ledger, invocation })`.
    fn sign_auth(&self, signers: &[usize], contract: &Address, func: &str, args: Vec<Val>) {
        let env = &self.env;
        let nonce = self.nonce.get();
        self.nonce.set(nonce + 1);
        let exp = env.ledger().sequence() + 100;

        let sc_args: std::vec::Vec<ScVal> = args
            .iter()
            .map(|v| ScVal::try_from_val(env, &v).unwrap())
            .collect();
        let invocation = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(contract),
                function_name: ScSymbol(func.try_into().unwrap()),
                args: sc_args.try_into().unwrap(),
            }),
            sub_invocations: VecM::default(),
        };
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: Hash(env.ledger().network_id().to_array()),
            nonce,
            signature_expiration_ledger: exp,
            invocation: invocation.clone(),
        });
        let xdr = preimage.to_xdr(Limits::none()).unwrap();
        let payload = env
            .crypto()
            .sha256(&Bytes::from_slice(env, &xdr))
            .to_array();

        let mut sigs: Vec<SignerSignature> = Vec::new(env);
        for &i in signers {
            let k = &self.ks[i];
            sigs.push_back(SignerSignature {
                public_key: pk(env, k),
                signature: BytesN::from_array(env, &k.sign(&payload).to_bytes()),
            });
        }
        let sig_val: Val = sigs.into_val(env);
        let entry = SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(&self.ms.address),
                nonce,
                signature_expiration_ledger: exp,
                signature: ScVal::try_from_val(env, &sig_val).unwrap(),
            }),
            root_invocation: invocation,
        };
        env.set_auths(&[entry]);
    }

    fn approve_args(&self, amount: i128) -> Vec<Val> {
        vec![
            &self.env,
            self.ms.address.into_val(&self.env),
            self.streaming.address.into_val(&self.env),
            amount.into_val(&self.env),
            (self.env.ledger().sequence() + 10_000).into_val(&self.env),
        ]
    }

    fn create_args(&self, recipient: &Address, cancelable: bool) -> Vec<Val> {
        vec![
            &self.env,
            self.ms.address.into_val(&self.env),
            recipient.into_val(&self.env),
            self.token.address.into_val(&self.env),
            DEPOSIT.into_val(&self.env),
            START.into_val(&self.env),
            (START + DURATION).into_val(&self.env),
            cancelable.into_val(&self.env),
        ]
    }

    fn call(&self, contract: &Address, func: &str, args: Vec<Val>) -> Call {
        Call {
            contract: contract.clone(),
            func: Symbol::new(&self.env, func),
            args,
            auth: Vec::new(&self.env),
        }
    }

    fn invoke(&self, calls: std::vec::Vec<Call>) -> Action {
        let mut v = Vec::new(&self.env);
        for c in calls {
            v.push_back(c);
        }
        Action::Invoke(v)
    }

    fn sig(&self, k: usize, op: Op, id: u64, action_hash: &BytesN<32>, exp: u64) -> BytesN<64> {
        let msg = self.ms.signing_payload(&op, &id, action_hash, &exp);
        BytesN::from_array(&self.env, &self.ks[k].sign(&msg.to_array()).to_bytes())
    }

    /// Proposes as `ks[proposer]`, approves with `approvers`, executes.
    fn run_proposal(&self, action: &Action, proposer: usize, approvers: &[usize]) -> Vec<Val> {
        let exp = self.env.ledger().timestamp() + 3_600;
        let id = self.ms.next_proposal_id();
        let h = self.ms.action_hash(action);
        self.ms.propose(
            &pk(&self.env, &self.ks[proposer]),
            action,
            &exp,
            &self.sig(proposer, Op::Propose, id, &h, exp),
        );
        for &k in approvers {
            self.ms.approve(
                &id,
                &pk(&self.env, &self.ks[k]),
                &self.sig(k, Op::Approve, id, &h, exp),
            );
        }
        self.ms.execute(&id)
    }

    /// Creates a stream from the multisig with 2-of-3 `__check_auth`.
    fn create_via_check_auth(&self, recipient: &Address, cancelable: bool) -> u64 {
        self.sign_auth(
            &[0, 2],
            &self.token.address,
            "approve",
            self.approve_args(2 * DEPOSIT),
        );
        self.token.approve(
            &self.ms.address,
            &self.streaming.address,
            &(2 * DEPOSIT),
            &(self.env.ledger().sequence() + 10_000),
        );
        self.sign_auth(
            &[0, 2],
            &self.streaming.address,
            "create_stream",
            self.create_args(recipient, cancelable),
        );
        self.streaming.create_stream(
            &self.ms.address,
            recipient,
            &self.token.address,
            &DEPOSIT,
            &START,
            &(START + DURATION),
            &cancelable,
        )
    }

    fn relax_cancel_to_one(&self) {
        let policy = FnPolicy {
            contract: self.streaming.address.clone(),
            func: Symbol::new(&self.env, "cancel_stream"),
            threshold: 1,
        };
        self.run_proposal(&Action::SetPolicy(policy), 0, &[1]);
    }
}

// ----------------------------------------------------------------------
// create_stream
// ----------------------------------------------------------------------

#[test]
fn two_of_three_creates_stream_via_check_auth() {
    let w = world();
    let recipient = Address::generate(&w.env);
    let id = w.create_via_check_auth(&recipient, true);

    let s = w.streaming.get_stream(&id);
    assert_eq!(s.sender, w.ms.address);
    assert_eq!(s.recipient, recipient);
    assert_eq!(s.deposit, DEPOSIT);
    assert_eq!(w.token.balance(&w.ms.address), 9 * DEPOSIT);
    assert_eq!(w.token.balance(&w.streaming.address), DEPOSIT);
}

#[test]
fn one_signature_cannot_create_stream() {
    let w = world();
    let recipient = Address::generate(&w.env);
    w.sign_auth(
        &[0, 1],
        &w.token.address,
        "approve",
        w.approve_args(DEPOSIT),
    );
    w.token.approve(
        &w.ms.address,
        &w.streaming.address,
        &DEPOSIT,
        &(w.env.ledger().sequence() + 10_000),
    );
    w.sign_auth(
        &[1],
        &w.streaming.address,
        "create_stream",
        w.create_args(&recipient, true),
    );
    let res = w.streaming.try_create_stream(
        &w.ms.address,
        &recipient,
        &w.token.address,
        &DEPOSIT,
        &START,
        &(START + DURATION),
        &true,
    );
    assert!(res.is_err());
    assert_eq!(w.token.balance(&w.ms.address), 10 * DEPOSIT);
}

#[test]
fn signatures_for_other_args_do_not_authorize() {
    // Two valid signatures over a create_stream to recipient A cannot be
    // used to create a stream to recipient B: the payload binds the args.
    let w = world();
    let a = Address::generate(&w.env);
    let b = Address::generate(&w.env);
    w.sign_auth(
        &[0, 1],
        &w.token.address,
        "approve",
        w.approve_args(DEPOSIT),
    );
    w.token.approve(
        &w.ms.address,
        &w.streaming.address,
        &DEPOSIT,
        &(w.env.ledger().sequence() + 10_000),
    );
    w.sign_auth(
        &[0, 1],
        &w.streaming.address,
        "create_stream",
        w.create_args(&a, true),
    );
    let res = w.streaming.try_create_stream(
        &w.ms.address,
        &b,
        &w.token.address,
        &DEPOSIT,
        &START,
        &(START + DURATION),
        &true,
    );
    assert!(res.is_err());
}

#[test]
fn two_of_three_creates_stream_via_proposal() {
    let w = world();
    let recipient = Address::generate(&w.env);
    // approve + create_stream in one proposal: the multisig is the direct
    // invoker of both, so no auth entries are needed at all.
    let action = w.invoke(std::vec![
        w.call(&w.token.address, "approve", w.approve_args(DEPOSIT)),
        w.call(
            &w.streaming.address,
            "create_stream",
            w.create_args(&recipient, false)
        ),
    ]);
    assert_eq!(w.ms.required_approvals(&action), 2);
    let out = w.run_proposal(&action, 1, &[2]);
    let id = u64::from_val(&w.env, &out.get(1).unwrap());
    let s = w.streaming.get_stream(&id);
    assert_eq!(s.sender, w.ms.address);
    assert_eq!(s.deposit, DEPOSIT);
    assert!(!s.cancelable);
}

// ----------------------------------------------------------------------
// top_up
// ----------------------------------------------------------------------

#[test]
fn top_up_needs_two_of_three() {
    let w = world();
    let recipient = Address::generate(&w.env);
    let id = w.create_via_check_auth(&recipient, true);
    let args = vec![&w.env, id.into_val(&w.env), 500i128.into_val(&w.env)];

    w.sign_auth(&[2], &w.streaming.address, "top_up", args.clone());
    assert!(w.streaming.try_top_up(&id, &500).is_err());

    w.sign_auth(&[1, 2], &w.streaming.address, "top_up", args.clone());
    w.streaming.top_up(&id, &500);
    assert_eq!(w.streaming.get_stream(&id).deposit, DEPOSIT + 500);

    // And through a proposal.
    let action = w.invoke(std::vec![w.call(&w.streaming.address, "top_up", args)]);
    w.run_proposal(&action, 0, &[2]);
    assert_eq!(w.streaming.get_stream(&id).deposit, DEPOSIT + 1_000);
}

// ----------------------------------------------------------------------
// cancel_stream: a single signer, under the 1-of-N cancel policy
// ----------------------------------------------------------------------

#[test]
fn without_policy_one_signer_cannot_cancel() {
    let w = world();
    let id = w.create_via_check_auth(&Address::generate(&w.env), true);
    let args = vec![&w.env, w.ms.address.into_val(&w.env), id.into_val(&w.env)];
    w.sign_auth(&[1], &w.streaming.address, "cancel_stream", args);
    assert!(w.streaming.try_cancel_stream(&w.ms.address, &id).is_err());
    assert_eq!(w.streaming.get_stream(&id).status, StreamStatus::Active);
}

#[test]
fn one_signer_cancels_via_check_auth() {
    let w = world();
    let recipient = Address::generate(&w.env);
    let id = w.create_via_check_auth(&recipient, true);
    w.relax_cancel_to_one();

    w.env.ledger().set_timestamp(START + DURATION / 4);
    let args = vec![&w.env, w.ms.address.into_val(&w.env), id.into_val(&w.env)];
    w.sign_auth(&[1], &w.streaming.address, "cancel_stream", args);
    w.streaming.cancel_stream(&w.ms.address, &id);

    assert_eq!(w.streaming.get_stream(&id).status, StreamStatus::Cancelled);
    // Accrued quarter to the recipient, the rest refunded to the multisig.
    assert_eq!(w.token.balance(&recipient), DEPOSIT / 4);
    assert_eq!(
        w.token.balance(&w.ms.address),
        9 * DEPOSIT + 3 * DEPOSIT / 4
    );
}

#[test]
fn one_signer_cancels_via_proposal() {
    let w = world();
    let id = w.create_via_check_auth(&Address::generate(&w.env), true);
    w.relax_cancel_to_one();

    let action = w.invoke(std::vec![w.call(
        &w.streaming.address,
        "cancel_stream",
        vec![&w.env, w.ms.address.into_val(&w.env), id.into_val(&w.env)],
    )]);
    assert_eq!(w.ms.required_approvals(&action), 1);
    // Proposer's own approval is enough: no other signer involved.
    w.run_proposal(&action, 2, &[]);
    assert_eq!(w.streaming.get_stream(&id).status, StreamStatus::Cancelled);
}

#[test]
fn relaxed_cancel_cannot_carry_a_top_up() {
    let w = world();
    let id = w.create_via_check_auth(&Address::generate(&w.env), true);
    w.relax_cancel_to_one();
    let action = w.invoke(std::vec![
        w.call(
            &w.streaming.address,
            "top_up",
            vec![&w.env, id.into_val(&w.env), 1i128.into_val(&w.env)]
        ),
        w.call(
            &w.streaming.address,
            "cancel_stream",
            vec![&w.env, w.ms.address.into_val(&w.env), id.into_val(&w.env)]
        ),
    ]);
    assert_eq!(w.ms.required_approvals(&action), 2);
    let exp = w.env.ledger().timestamp() + 60;
    let h = w.ms.action_hash(&action);
    let next = w.ms.next_proposal_id();
    let pid = w.ms.propose(
        &pk(&w.env, &w.ks[0]),
        &action,
        &exp,
        &w.sig(0, Op::Propose, next, &h, exp),
    );
    assert_eq!(
        w.ms.try_execute(&pid),
        Err(Ok(MultisigError::BelowThreshold))
    );
}

// ----------------------------------------------------------------------
// withdraw to a multisig recipient
// ----------------------------------------------------------------------

#[test]
fn withdraw_to_multisig_recipient() {
    let w = world();
    // A classic account streams to the multisig (its auth is scaffolding).
    let payer = Address::generate(&w.env);
    w.env.mock_all_auths();
    StellarAssetClient::new(&w.env, &w.token.address).mint(&payer, &DEPOSIT);
    w.token
        .approve(&payer, &w.streaming.address, &DEPOSIT, &10_000u32);
    let id = w.streaming.create_stream(
        &payer,
        &w.ms.address,
        &w.token.address,
        &DEPOSIT,
        &START,
        &(START + DURATION),
        &true,
    );
    w.env.set_auths(&[]);
    let before = w.token.balance(&w.ms.address);

    // Halfway: withdraw_max authorized 2-of-3 through __check_auth.
    w.env.ledger().set_timestamp(START + DURATION / 2);
    let args = vec![&w.env, id.into_val(&w.env)];
    w.sign_auth(&[2], &w.streaming.address, "withdraw_max", args.clone());
    assert!(w.streaming.try_withdraw_max(&id).is_err());
    w.sign_auth(&[0, 1], &w.streaming.address, "withdraw_max", args.clone());
    assert_eq!(w.streaming.withdraw_max(&id), DEPOSIT / 2);
    assert_eq!(w.token.balance(&w.ms.address), before + DEPOSIT / 2);

    // At the end: the rest through a proposal.
    w.env.ledger().set_timestamp(START + DURATION);
    let action = w.invoke(std::vec![w.call(
        &w.streaming.address,
        "withdraw_max",
        args
    )]);
    let out = w.run_proposal(&action, 0, &[2]);
    assert_eq!(i128::from_val(&w.env, &out.get(0).unwrap()), DEPOSIT / 2);
    assert_eq!(w.token.balance(&w.ms.address), before + DEPOSIT);

    // The multisig can then move the funds on, again 2-of-3.
    let dest = Address::generate(&w.env);
    let transfer = w.invoke(std::vec![w.call(
        &w.token.address,
        "transfer",
        vec![
            &w.env,
            w.ms.address.into_val(&w.env),
            dest.into_val(&w.env),
            DEPOSIT.into_val(&w.env),
        ],
    )]);
    w.run_proposal(&transfer, 1, &[0]);
    assert_eq!(w.token.balance(&dest), DEPOSIT);
}

#[test]
fn check_auth_nonce_prevents_replay() {
    let w = world();
    let id = w.create_via_check_auth(&Address::generate(&w.env), true);
    let args = vec![&w.env, id.into_val(&w.env), 10i128.into_val(&w.env)];
    w.sign_auth(&[0, 1], &w.streaming.address, "top_up", args);
    w.streaming.top_up(&id, &10);
    // The same signed entry (same nonce) is consumed; a second call fails.
    assert!(w.streaming.try_top_up(&id, &10).is_err());
    assert_eq!(w.streaming.get_stream(&id).deposit, DEPOSIT + 10);
}
