//! Tests for the PasskeySigner contract.
//!
//! # Strategy
//!
//! Real WebAuthn assertions cannot be produced inside a unit test (no
//! browser / authenticator). Instead we:
//!
//! 1. Build synthetic authData, clientDataJSON, and challenge values
//!    that are structurally correct.
//! 2. Test all structural validation error paths with deliberately invalid inputs.
//! 3. Test the replay-prevention store directly using the `registry` module.
//!
//! "Recorded real assertions" note
//! ---------------------------------
//! The full signature verification path requires `env.crypto().secp256r1_verify`
//! which is only possible with a valid P-256 key pair + message. The Soroban
//! testutils `Env` does provide `secp256r1_verify` in test mode; however,
//! generating a matching assertion without an actual authenticator requires a
//! test-only key pair. The crypto module tests (below) verify the structural
//! path; integration tests with real assertions run as off-chain scripts in CI.

#![cfg(test)]
extern crate std;

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Bytes, BytesN, Env, String, Vec};
use std::vec;

use crate::errors::PasskeyError;
use crate::registry::REGISTRATION_FLAGS_REQUIRE_UV;
use crate::PasskeySigner;

// ── Test client ───────────────────────────────────────────────────────────────
// The soroban-sdk `#[contractclient]` attribute generates a typed client
// from a trait that mirrors the contract's public API.

use soroban_sdk::contractclient;

/// Interface of the PasskeySigner contract for tests.
#[contractclient(name = "PasskeySignerTestClient")]
#[allow(dead_code)] // generated client methods are used selectively per test
pub trait PasskeySignerApi {
    fn register(
        env: Env,
        owner: Address,
        rp_id_hash: BytesN<32>,
        x: BytesN<32>,
        y: BytesN<32>,
        flags: u32,
    ) -> Result<(), PasskeyError>;
    fn deregister(env: Env, owner: Address) -> Result<(), PasskeyError>;
    fn get_credential(
        env: Env,
        owner: Address,
    ) -> Result<crate::registry::Credential, PasskeyError>;
    fn verify_and_record(
        env: Env,
        owner: Address,
        auth_data: Bytes,
        client_data_json: Bytes,
        challenge: BytesN<32>,
        sig_r: BytesN<32>,
        sig_s: BytesN<32>,
    ) -> Result<(), PasskeyError>;
    fn is_nonce_used(env: Env, challenge: BytesN<32>) -> bool;
    fn list_credentials(env: Env, owner: Address) -> Vec<crate::registry::CredentialRecord>;
    #[allow(clippy::too_many_arguments)]
    fn register_device(
        env: Env,
        owner: Address,
        id: BytesN<32>,
        device_label: String,
        rp_id_hash: BytesN<32>,
        x: BytesN<32>,
        y: BytesN<32>,
        flags: u32,
    ) -> Result<(), PasskeyError>;
    fn revoke_device(
        env: Env,
        owner: Address,
        id: BytesN<32>,
        allow_last: bool,
    ) -> Result<(), PasskeyError>;
    #[allow(clippy::too_many_arguments)]
    fn recover_device(
        env: Env,
        owner: Address,
        new_id: BytesN<32>,
        device_label: String,
        rp_id_hash: BytesN<32>,
        x: BytesN<32>,
        y: BytesN<32>,
        flags: u32,
        governance_approved: bool,
    ) -> Result<(), PasskeyError>;
    #[allow(clippy::too_many_arguments)]
    fn verify_and_record_with_guards(
        env: Env,
        owner: Address,
        cred_id: BytesN<32>,
        auth_data: Bytes,
        client_data_json: Bytes,
        challenge: BytesN<32>,
        challenge_expires_at: u64,
        sig_r: BytesN<32>,
        sig_s: BytesN<32>,
    ) -> Result<(), PasskeyError>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn new_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env
}

fn deploy(env: &Env) -> (soroban_sdk::Address, PasskeySignerTestClient<'_>) {
    let contract_id = env.register(PasskeySigner, ());
    let client = PasskeySignerTestClient::new(env, &contract_id);
    (contract_id, client)
}

fn to_bytes(env: &Env, v: &[u8]) -> Bytes {
    Bytes::from_slice(env, v)
}

fn to_bytes32(env: &Env, v: &[u8; 32]) -> BytesN<32> {
    BytesN::from_array(env, v)
}

fn fake_pub_key() -> ([u8; 32], [u8; 32]) {
    ([1u8; 32], [2u8; 32])
}

fn make_auth_data(rp_id_hash: &[u8; 32], flags: u8) -> std::vec::Vec<u8> {
    let mut v = std::vec::Vec::with_capacity(37);
    v.extend_from_slice(rp_id_hash);
    v.push(flags);
    v.extend_from_slice(&0u32.to_be_bytes());
    v
}

fn base64url(input: &[u8]) -> std::string::String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = std::string::String::new();
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i];
        let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };
        out.push(CHARS[((b0 >> 2) & 0x3F) as usize] as char);
        out.push(CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < input.len() {
            out.push(CHARS[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        }
        if i + 2 < input.len() {
            out.push(CHARS[(b2 & 0x3F) as usize] as char);
        }
        i += 3;
    }
    out
}

fn make_client_data_json(challenge: &[u8]) -> std::string::String {
    std::format!(
        r#"{{"type":"webauthn.get","challenge":"{}","origin":"https://streampay.app"}}"#,
        base64url(challenge)
    )
}

// ── Registration tests ────────────────────────────────────────────────────────

#[test]
fn register_and_get_credential_roundtrip() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x11u8; 32];
    let (x, y) = fake_pub_key();

    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let cred = client.get_credential(&owner);
    assert_eq!(cred.rp_id_hash, to_bytes32(&env, &rp_id_hash));
    assert_eq!(cred.x, to_bytes32(&env, &x));
    assert_eq!(cred.y, to_bytes32(&env, &y));
    assert_eq!(cred.flags, 0u32);
}

#[test]
fn get_credential_not_registered_returns_error() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let result = client.try_get_credential(&owner);
    assert_eq!(result, Err(Ok(PasskeyError::CredentialNotFound)));
}

#[test]
fn deregister_removes_credential() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x22u8; 32];
    let (x, y) = fake_pub_key();

    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );
    client.deregister(&owner);
    assert_eq!(
        client.try_get_credential(&owner),
        Err(Ok(PasskeyError::CredentialNotFound))
    );
}

#[test]
fn deregister_not_registered_returns_error() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    assert_eq!(
        client.try_deregister(&owner),
        Err(Ok(PasskeyError::CredentialNotFound))
    );
}

// ── authData validation tests ─────────────────────────────────────────────────

#[test]
fn auth_data_too_short_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x33u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);
    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &[0u8; 10]),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::AuthDataTooShort)));
}

#[test]
fn rp_id_hash_mismatch_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x44u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);
    let wrong_rp = [0xFFu8; 32];
    let auth_data_bytes = make_auth_data(&wrong_rp, 0x01);

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::RpIdHashMismatch)));
}

#[test]
fn user_presence_not_set_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x55u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x00); // UP not set

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::UserPresenceNotSet)));
}

#[test]
fn uv_required_but_not_set_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x66u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &REGISTRATION_FLAGS_REQUIRE_UV,
    );

    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x01); // UP set, UV not set

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::UserVerificationNotSet)));
}

// ── clientDataJSON tests ───────────────────────────────────────────────────────

#[test]
fn wrong_type_in_client_data_json_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x77u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let wrong_cdj = std::format!(
        r#"{{"type":"webauthn.create","challenge":"{}","origin":"https://streampay.app"}}"#,
        base64url(&challenge)
    );
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x01);

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, wrong_cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::ClientDataTypeMismatch)));
}

#[test]
fn wrong_challenge_in_client_data_json_rejected() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let rp_id_hash = [0x88u8; 32];
    let (x, y) = fake_pub_key();
    client.register(
        &owner,
        &to_bytes32(&env, &rp_id_hash),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0u32,
    );

    let challenge = [0x01u8; 32];
    let wrong_cdj = std::format!(
        r#"{{"type":"webauthn.get","challenge":"{}","origin":"https://streampay.app"}}"#,
        base64url(&[0xFFu8; 32]) // different challenge in CDJ
    );
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x01);

    let result = client.try_verify_and_record(
        &owner,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, wrong_cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::ChallengeMismatch)));
}

// ── Replay prevention tests ────────────────────────────────────────────────────

#[test]
fn is_nonce_used_false_before_use() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let challenge = [0xBBu8; 32];
    assert!(!client.is_nonce_used(&to_bytes32(&env, &challenge)));
}

#[test]
fn challenge_replay_prevented_via_registry() {
    let env = new_env();
    let (contract_id, client) = deploy(&env);
    let challenge = to_bytes32(&env, &[0xAAu8; 32]);
    env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &challenge).expect("first record ok");
    });

    // is_nonce_used reads from the same contract storage.
    assert!(client.is_nonce_used(&challenge));

    let result = env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &challenge)
    });
    assert_eq!(result, Err(PasskeyError::ChallengeAlreadyUsed));
}

// ── verify without registration ───────────────────────────────────────────────

#[test]
fn verify_without_registration_returns_not_found() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let unregistered = Address::generate(&env);
    let rp_id_hash = [0x00u8; 32];
    let auth_data_bytes = make_auth_data(&rp_id_hash, 0x01);
    let challenge = [0x01u8; 32];
    let cdj = make_client_data_json(&challenge);

    let result = client.try_verify_and_record(
        &unregistered,
        &to_bytes(&env, &auth_data_bytes),
        &to_bytes(&env, cdj.as_bytes()),
        &to_bytes32(&env, &challenge),
        &to_bytes32(&env, &[0u8; 32]),
        &to_bytes32(&env, &[0u8; 32]),
    );
    assert_eq!(result, Err(Ok(PasskeyError::CredentialNotFound)));
}

/// Expired-challenge scenario: same nonce reused → rejected.
#[test]
fn expired_challenge_nonce_rejected() {
    let env = new_env();
    let (contract_id, client) = deploy(&env);
    let challenge = to_bytes32(&env, &[0xCCu8; 32]);
    env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &challenge).expect("first record should succeed");
    });

    assert!(
        client.is_nonce_used(&challenge),
        "nonce must be marked used"
    );

    // Attempting record_challenge again must fail.
    let result = env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &challenge)
    });
    assert_eq!(result, Err(PasskeyError::ChallengeAlreadyUsed));
}

/// Challenge nonce expiry boundary matrix: walks the ledger clock across the
/// TTL expiry boundary for both fresh and already-used nonces to pin the
/// registry's exact TTL semantics.
///
/// TTL constants from registry.rs:
/// - TTL_THRESHOLD: 200_000 ledgers
/// - TTL_EXTEND: 500_000 ledgers
///
/// A nonce recorded at ledger N will have its TTL extended to last until
/// approximately ledger N + 500_000. This test verifies the behavior at:
/// - expiry - 1: nonce should still be present
/// - expiry: document actual behavior (implementation-dependent boundary)
/// - expiry + 1: nonce should be expired (absent from storage)
///
/// It also verifies that replay attacks are prevented at all clock positions,
/// and that fresh registrations work after expiry.
#[test]
fn challenge_expiry_boundary_matrix() {
    // Constants from registry.rs
    const TTL_EXTEND: u32 = 500_000;

    // Test matrix rows
    struct TestCase {
        name: &'static str,
        ledger_offset: u32,
        expected_is_used: bool,
        expected_record_result: Result<(), PasskeyError>,
        description: &'static str,
    }

    let test_cases = vec![
        TestCase {
            name: "expiry_minus_1",
            ledger_offset: TTL_EXTEND - 1,
            expected_is_used: true,
            expected_record_result: Err(PasskeyError::ChallengeAlreadyUsed),
            description: "One ledger before expiry: nonce still present, replay rejected",
        },
        TestCase {
            name: "at_expiry",
            ledger_offset: TTL_EXTEND,
            expected_is_used: true,
            expected_record_result: Err(PasskeyError::ChallengeAlreadyUsed),
            description: "Exactly at expiry ledger: nonce still present (TTL is inclusive)",
        },
        TestCase {
            name: "expiry_plus_1",
            ledger_offset: TTL_EXTEND + 1,
            expected_is_used: false,
            expected_record_result: Ok(()),
            description: "One ledger after expiry: nonce expired, fresh record succeeds",
        },
    ];

    for tc in test_cases {
        std::println!("\n=== {} ===", tc.name);
        std::println!("{}", tc.description);

        let env = new_env();
        let (contract_id, client) = deploy(&env);

        // Use a unique challenge for this test case
        let challenge_byte = match tc.name {
            "expiry_minus_1" => 0xD1u8,
            "at_expiry" => 0xD2u8,
            "expiry_plus_1" => 0xD3u8,
            _ => 0xD0u8,
        };
        let challenge = to_bytes32(&env, &[challenge_byte; 32]);

        // Initial ledger sequence
        let initial_ledger = env.ledger().sequence();
        std::println!("Initial ledger: {}", initial_ledger);

        // Record the challenge at initial ledger
        env.as_contract(&contract_id, || {
            crate::registry::record_challenge(&env, &challenge)
                .expect("initial record must succeed");
        });

        // Verify nonce is marked as used immediately after recording
        assert!(
            client.is_nonce_used(&challenge),
            "[{}] nonce must be marked used immediately after recording",
            tc.name
        );

        // Advance ledger to the test boundary
        let target_ledger = initial_ledger + tc.ledger_offset;
        env.ledger().with_mut(|li| {
            li.sequence_number = target_ledger;
        });
        std::println!(
            "Advanced to ledger {} (offset: {})",
            target_ledger,
            tc.ledger_offset
        );

        // Check if nonce is still marked as used at this ledger
        let is_used = client.is_nonce_used(&challenge);
        assert_eq!(
            is_used, tc.expected_is_used,
            "[{}] is_nonce_used at ledger {} should be {}",
            tc.name, target_ledger, tc.expected_is_used
        );

        // Attempt to record the same challenge again (replay test)
        let replay_result = env.as_contract(&contract_id, || {
            crate::registry::record_challenge(&env, &challenge)
        });
        assert_eq!(
            replay_result, tc.expected_record_result,
            "[{}] replay record_challenge result at ledger {} should match expected",
            tc.name, target_ledger
        );

        std::println!("✓ is_used={}, replay_result={:?}", is_used, replay_result);
    }

    // Additional test: verify a fresh nonce can be registered after the original expires
    std::println!("\n=== fresh_registration_after_expiry ===");
    std::println!("Verify that a new nonce can be registered after a previous nonce expires");

    let env = new_env();
    let (contract_id, client) = deploy(&env);

    let first_challenge = to_bytes32(&env, &[0xE1u8; 32]);
    let second_challenge = to_bytes32(&env, &[0xE2u8; 32]);

    let initial_ledger = env.ledger().sequence();

    // Record first challenge
    env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &first_challenge)
            .expect("first challenge record must succeed");
    });

    // Advance past expiry
    env.ledger().with_mut(|li| {
        li.sequence_number = initial_ledger + TTL_EXTEND + 1;
    });

    // First challenge should be expired
    assert!(
        !client.is_nonce_used(&first_challenge),
        "first challenge should be expired"
    );

    // Should be able to record a completely new challenge
    let new_record_result = env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &second_challenge)
    });
    assert_eq!(
        new_record_result,
        Ok(()),
        "recording a new challenge after expiry must succeed"
    );

    // The new challenge should be marked as used
    assert!(
        client.is_nonce_used(&second_challenge),
        "newly recorded challenge must be marked used"
    );

    // Even better: the expired first challenge can be re-registered
    let reregister_result = env.as_contract(&contract_id, || {
        crate::registry::record_challenge(&env, &first_challenge)
    });
    assert_eq!(
        reregister_result,
        Ok(()),
        "re-registering an expired challenge must succeed"
    );

    assert!(
        client.is_nonce_used(&first_challenge),
        "re-registered challenge must be marked used"
    );

    std::println!("✓ Fresh and re-registration after expiry both succeed");
}

#[test]
fn multi_device_register_list_revoke_and_last_credential_guard() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let (x, y) = fake_pub_key();
    let rp = [0xAAu8; 32];
    let id1 = to_bytes32(&env, &[1u8; 32]);
    let id2 = to_bytes32(&env, &[2u8; 32]);

    client.register_device(
        &owner,
        &id1,
        &String::from_str(&env, "MacBook Touch ID"),
        &to_bytes32(&env, &rp),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0,
    );
    client.register_device(
        &owner,
        &id2,
        &String::from_str(&env, "YubiKey 5C"),
        &to_bytes32(&env, &rp),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &REGISTRATION_FLAGS_REQUIRE_UV,
    );

    let list = client.list_credentials(&owner);
    assert_eq!(list.len(), 2);

    // Revoking one of two devices succeeds without allow_last
    client.revoke_device(&owner, &id1, &false);

    // Revoking the last remaining device without allow_last fails
    let err = client.try_revoke_device(&owner, &id2, &false);
    assert_eq!(err, Err(Ok(PasskeyError::LastCredentialProtected)));

    // Revoking with allow_last = true succeeds
    client.revoke_device(&owner, &id2, &true);
}

#[test]
fn recovery_requires_active_credential_or_governance_approval() {
    let env = new_env();
    let (_, client) = deploy(&env);
    let owner = Address::generate(&env);
    let (x, y) = fake_pub_key();
    let rp = [0xBBu8; 32];
    let id1 = to_bytes32(&env, &[10u8; 32]);
    let id2 = to_bytes32(&env, &[20u8; 32]);

    // No credentials and governance_approved=false -> rejected
    let err = client.try_recover_device(
        &owner,
        &id1,
        &String::from_str(&env, "Replacement Phone"),
        &to_bytes32(&env, &rp),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0,
        &false,
    );
    assert_eq!(err, Err(Ok(PasskeyError::RecoveryNotAuthorized)));

    // Governance-approved recovery succeeds with 0 active credentials
    client.recover_device(
        &owner,
        &id1,
        &String::from_str(&env, "Governance Recovery Key"),
        &to_bytes32(&env, &rp),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0,
        &true,
    );
    assert_eq!(client.list_credentials(&owner).len(), 1);

    // Now with >= 1 active credential, user can recover/bind a new device without governance
    client.recover_device(
        &owner,
        &id2,
        &String::from_str(&env, "Backup Hardware Key"),
        &to_bytes32(&env, &rp),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0,
        &false,
    );
    assert_eq!(client.list_credentials(&owner).len(), 2);
}

#[test]
fn guards_reject_expired_challenge_and_sign_count_regression() {
    let env = new_env();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_700_000_100;
    });
    let (contract_id, client) = deploy(&env);
    let owner = Address::generate(&env);
    let (x, y) = fake_pub_key();
    let rp = [0xCCu8; 32];
    let id1 = to_bytes32(&env, &[30u8; 32]);

    client.register_device(
        &owner,
        &id1,
        &String::from_str(&env, "Primary Device"),
        &to_bytes32(&env, &rp),
        &to_bytes32(&env, &x),
        &to_bytes32(&env, &y),
        &0,
    );

    // Simulate previous usage at sign_count = 5
    env.as_contract(&contract_id, || {
        crate::registry::update_device_usage(&env, &owner, &id1, 5, 1_700_000_050)
            .expect("initial sign count update succeeds");
    });

    // Sign-count regression (<= 5) is rejected by registry
    let reg_err = env.as_contract(&contract_id, || {
        crate::registry::update_device_usage(&env, &owner, &id1, 5, 1_700_000_060)
    });
    assert_eq!(reg_err, Err(PasskeyError::SignCountRegression));

    // Expired challenge (expires_at < ledger.timestamp) is rejected by contract gate
    let mut auth = std::vec::Vec::with_capacity(37);
    auth.extend_from_slice(&rp);
    auth.push(0x01);
    auth.extend_from_slice(&6u32.to_be_bytes());
    let challenge = to_bytes32(&env, &[9u8; 32]);
    let cdj = to_bytes(&env, b"{\"type\":\"webauthn.get\",\"challenge\":\"\"}");
    let sig_r = to_bytes32(&env, &[1u8; 32]);
    let sig_s = to_bytes32(&env, &[2u8; 32]);

    let expired_err = client.try_verify_and_record_with_guards(
        &owner,
        &id1,
        &to_bytes(&env, &auth),
        &cdj,
        &challenge,
        &1_700_000_099, // expired!
        &sig_r,
        &sig_s,
    );
    assert_eq!(expired_err, Err(Ok(PasskeyError::ChallengeExpired)));
}
