//! Credential registry: persistent storage of P-256 public keys and used challenge nonces.

use soroban_sdk::{contracttype, Address, BytesN, Env, String, Vec};

use crate::errors::PasskeyError;

/// Require user verification on every assertion.
pub const REGISTRATION_FLAGS_REQUIRE_UV: u32 = 0x01;

// TTL constants (mirrors streaming-payments contract).
const TTL_THRESHOLD: u32 = 200_000;
const TTL_EXTEND: u32 = 500_000;

/// A registered passkey credential for one Stellar address.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Credential {
    /// sha256 of the Relying Party ID string (e.g. `sha256("streampay.app")`).
    pub rp_id_hash: BytesN<32>,
    /// P-256 public key x-coordinate (32 bytes, big-endian).
    pub x: BytesN<32>,
    /// P-256 public key y-coordinate (32 bytes, big-endian).
    pub y: BytesN<32>,
    /// Registration flags bitmask (see `REGISTRATION_FLAGS_*` constants).
    pub flags: u32,
}

/// A registered multi-device credential record with health & lifecycle metadata.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialRecord {
    /// Unique credential identifier (32-byte hash / key id).
    pub id: BytesN<32>,
    /// Human-readable device label (e.g. "MacBook Touch ID", "YubiKey 5C").
    pub device_label: String,
    /// sha256 of the Relying Party ID string.
    pub rp_id_hash: BytesN<32>,
    /// P-256 public key x-coordinate (32 bytes, big-endian).
    pub x: BytesN<32>,
    /// P-256 public key y-coordinate (32 bytes, big-endian).
    pub y: BytesN<32>,
    /// Registration flags bitmask.
    pub flags: u32,
    /// Ledger timestamp when registered.
    pub created_at: u64,
    /// Ledger timestamp of most recent assertion (0 if unused).
    pub last_used_at: u64,
    /// Last verified WebAuthn sign-count.
    pub sign_count: u32,
    /// Whether this credential has been revoked.
    pub revoked: bool,
}

/// Storage keys for the registry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegistryKey {
    /// Stored credential for an owner address.
    Credential(Address),
    /// Multi-device credential list for an owner address.
    DeviceList(Address),
    /// Used challenge nonce (value is `true` when present); stored temporarily.
    UsedChallenge(BytesN<32>),
}

/// Stores a credential and extends its TTL.
pub fn put_credential(env: &Env, owner: &Address, cred: &Credential) {
    let key = RegistryKey::Credential(owner.clone());
    env.storage().persistent().set(&key, cred);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
}

/// Loads a credential, returning `CredentialNotFound` if absent.
pub fn get_credential(env: &Env, owner: &Address) -> Result<Credential, PasskeyError> {
    let key = RegistryKey::Credential(owner.clone());
    let cred: Option<Credential> = env.storage().persistent().get(&key);
    if let Some(c) = cred {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        Ok(c)
    } else {
        Err(PasskeyError::CredentialNotFound)
    }
}

/// Removes a credential, returning `CredentialNotFound` if nothing was stored.
pub fn remove_credential(env: &Env, owner: &Address) -> Result<(), PasskeyError> {
    let key = RegistryKey::Credential(owner.clone());
    if !env.storage().persistent().has(&key) {
        return Err(PasskeyError::CredentialNotFound);
    }
    env.storage().persistent().remove(&key);
    Ok(())
}

/// Records a challenge as used. Returns `ChallengeAlreadyUsed` if it was
/// already recorded (replay prevention).
pub fn record_challenge(env: &Env, challenge: &BytesN<32>) -> Result<(), PasskeyError> {
    let key = RegistryKey::UsedChallenge(challenge.clone());
    if env.storage().temporary().has(&key) {
        return Err(PasskeyError::ChallengeAlreadyUsed);
    }
    // Store `true`; presence is what matters.
    env.storage().temporary().set(&key, &true);
    env.storage()
        .temporary()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    Ok(())
}

/// Returns `true` if the challenge has already been consumed.
pub fn is_challenge_used(env: &Env, challenge: &BytesN<32>) -> bool {
    env.storage()
        .temporary()
        .has(&RegistryKey::UsedChallenge(challenge.clone()))
}

/// Lists all registered multi-device credentials for `owner`.
pub fn list_devices(env: &Env, owner: &Address) -> Vec<CredentialRecord> {
    let key = RegistryKey::DeviceList(owner.clone());
    let list: Vec<CredentialRecord> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    if !list.is_empty() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    }
    list
}

/// Registers (or replaces) a device credential in the owner's multi-device list.
pub fn put_device(env: &Env, owner: &Address, record: &CredentialRecord) {
    let key = RegistryKey::DeviceList(owner.clone());
    let existing = list_devices(env, owner);
    let mut next: Vec<CredentialRecord> = Vec::new(env);
    let mut replaced = false;
    for item in existing.iter() {
        if item.id == record.id {
            next.push_back(record.clone());
            replaced = true;
        } else {
            next.push_back(item);
        }
    }
    if !replaced {
        next.push_back(record.clone());
    }
    env.storage().persistent().set(&key, &next);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
}

/// Finds an active (non-revoked) device credential by `id`.
pub fn get_active_device(
    env: &Env,
    owner: &Address,
    id: &BytesN<32>,
) -> Result<CredentialRecord, PasskeyError> {
    let list = list_devices(env, owner);
    for item in list.iter() {
        if item.id == *id && !item.revoked {
            return Ok(item);
        }
    }
    Err(PasskeyError::CredentialNotFound)
}

/// Counts active (non-revoked) devices for `owner`.
pub fn active_device_count(env: &Env, owner: &Address) -> u32 {
    let list = list_devices(env, owner);
    let mut count = 0u32;
    for item in list.iter() {
        if !item.revoked {
            count += 1;
        }
    }
    count
}

/// Marks a device credential as revoked, guarding against accidentally revoking the last credential.
pub fn revoke_device(
    env: &Env,
    owner: &Address,
    id: &BytesN<32>,
    allow_last: bool,
) -> Result<(), PasskeyError> {
    let key = RegistryKey::DeviceList(owner.clone());
    let list = list_devices(env, owner);
    let active = active_device_count(env, owner);
    let mut found = false;
    let mut next: Vec<CredentialRecord> = Vec::new(env);

    for mut item in list.iter() {
        if item.id == *id && !item.revoked {
            if active <= 1 && !allow_last {
                return Err(PasskeyError::LastCredentialProtected);
            }
            item.revoked = true;
            found = true;
        }
        next.push_back(item);
    }

    if !found {
        return Err(PasskeyError::CredentialNotFound);
    }

    env.storage().persistent().set(&key, &next);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    Ok(())
}

/// Updates sign_count and last_used_at after a verified assertion.
pub fn update_device_usage(
    env: &Env,
    owner: &Address,
    id: &BytesN<32>,
    new_sign_count: u32,
    used_at: u64,
) -> Result<(), PasskeyError> {
    let key = RegistryKey::DeviceList(owner.clone());
    let list = list_devices(env, owner);
    let mut found = false;
    let mut next: Vec<CredentialRecord> = Vec::new(env);

    for mut item in list.iter() {
        if item.id == *id && !item.revoked {
            if item.sign_count > 0 && new_sign_count <= item.sign_count {
                return Err(PasskeyError::SignCountRegression);
            }
            item.sign_count = new_sign_count;
            item.last_used_at = used_at;
            found = true;
        }
        next.push_back(item);
    }

    if !found {
        return Err(PasskeyError::CredentialNotFound);
    }

    env.storage().persistent().set(&key, &next);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    Ok(())
}
