//! Merkleized snapshot leaves, inclusion proofs, and migration proofs.
//!
//! Leaves use canonical JSON (object keys sorted) and SHA-256. The tree pairs
//! hashes left-to-right and duplicates the last leaf when a level is odd, so
//! the root is identical on every platform.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::model::Snapshot;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InclusionProof {
    pub index: usize,
    pub leaf: String,
    pub siblings: Vec<String>,
    pub root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MigrationProof {
    pub schema_from: u32,
    pub schema_to: u32,
    pub old_root: String,
    pub new_root: String,
    pub old_leaf_count: u64,
    pub new_leaf_count: u64,
}

pub fn seal(mut snapshot: Snapshot) -> Snapshot {
    let leaves = snapshot_leaves(&snapshot);
    snapshot.merkle_leaf_count = Some(leaves.len() as u64);
    snapshot.merkle_root = Some(merkle_root(&leaves));
    snapshot
}

pub fn verify_snapshot(snapshot: &Snapshot) -> Result<()> {
    match (&snapshot.merkle_root, snapshot.merkle_leaf_count) {
        (None, None) => Ok(()),
        (Some(root), Some(count)) => {
            let leaves = snapshot_leaves(snapshot);
            if leaves.len() as u64 != count {
                return Err(anyhow!("truncated snapshot: leaf count does not match"));
            }
            let computed = merkle_root(&leaves);
            if &computed != root {
                return Err(anyhow!("merkle root mismatch"));
            }
            Ok(())
        }
        _ => Err(anyhow!("snapshot merkle header is incomplete")),
    }
}

pub fn inclusion_proof(snapshot: &Snapshot, index: usize) -> Result<InclusionProof> {
    verify_snapshot(snapshot)?;
    let leaves = snapshot_leaves(snapshot);
    let leaf = leaves
        .get(index)
        .cloned()
        .ok_or_else(|| anyhow!("record index out of range"))?;
    let siblings = proof_siblings(&leaves, index);
    let root = snapshot
        .merkle_root
        .clone()
        .unwrap_or_else(|| merkle_root(&leaves));
    let proof = InclusionProof {
        index,
        leaf,
        siblings,
        root,
    };
    if !verify_inclusion(&proof) {
        return Err(anyhow!("inclusion proof does not match the snapshot root"));
    }
    Ok(proof)
}

pub fn verify_inclusion(proof: &InclusionProof) -> bool {
    let mut current = proof.leaf.clone();
    let mut index = proof.index;
    for sibling in &proof.siblings {
        current = if index % 2 == 0 {
            hash_pair(&current, sibling)
        } else {
            hash_pair(sibling, &current)
        };
        index /= 2;
    }
    current == proof.root
}

pub fn verify_migration<F>(old: &Snapshot, new: &Snapshot, migrate: F) -> Result<MigrationProof>
where
    F: Fn(&Snapshot) -> Snapshot,
{
    let old_sealed = seal(old.clone());
    let expected = seal(migrate(old));
    verify_snapshot(new)?;
    let new_root = new
        .merkle_root
        .clone()
        .ok_or_else(|| anyhow!("migrated snapshot has no merkle root"))?;
    let expected_root = expected.merkle_root.clone().unwrap();
    if new_root != expected_root || snapshot_leaves(new) != snapshot_leaves(&expected) {
        return Err(anyhow!(
            "migrated snapshot root does not match the migration"
        ));
    }
    Ok(MigrationProof {
        schema_from: old_sealed.schema_version,
        schema_to: new.schema_version,
        old_root: old_sealed.merkle_root.unwrap(),
        new_root,
        old_leaf_count: old_sealed.merkle_leaf_count.unwrap(),
        new_leaf_count: new.merkle_leaf_count.unwrap(),
    })
}

fn snapshot_leaves(snapshot: &Snapshot) -> Vec<String> {
    let mut leaves = Vec::new();
    let mut streams = snapshot.streams.clone();
    streams.sort_by_key(|entry| entry.id);
    for entry in streams {
        leaves.push(leaf("stream", &entry));
    }
    let mut intents = snapshot.scheduled_intents.clone();
    intents.sort_by_key(|entry| entry.id);
    for entry in intents {
        leaves.push(leaf("intent", &entry));
    }
    let mut treasuries = snapshot.treasuries.clone();
    treasuries.sort_by(|left, right| left.token.cmp(&right.token));
    for entry in treasuries {
        leaves.push(leaf("treasury", &entry));
    }
    let mut fees = snapshot.stream_fees.clone();
    fees.sort_by_key(|entry| (entry.stream_id, entry.token.clone()));
    for entry in fees {
        leaves.push(leaf("fee", &entry));
    }
    let mut senders = snapshot.sender_indexes.clone();
    senders.sort_by(|left, right| left.address.cmp(&right.address));
    for entry in senders {
        leaves.push(leaf("sender", &entry));
    }
    let mut recipients = snapshot.recipient_indexes.clone();
    recipients.sort_by(|left, right| left.address.cmp(&right.address));
    for entry in recipients {
        leaves.push(leaf("recipient", &entry));
    }
    leaves
}

fn leaf(kind: &str, value: &impl Serialize) -> String {
    let json = serde_json::to_value(value).unwrap_or(Value::Null);
    hash_bytes(format!("{kind}:{}", canonical(&json)).as_bytes())
}

fn merkle_root(leaves: &[String]) -> String {
    if leaves.is_empty() {
        return hash_bytes(b"streampay-empty");
    }
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            let last = level[level.len() - 1].clone();
            level.push(last);
        }
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            next.push(hash_pair(&pair[0], &pair[1]));
        }
        level = next;
    }
    level.remove(0)
}

fn proof_siblings(leaves: &[String], mut index: usize) -> Vec<String> {
    if leaves.is_empty() {
        return Vec::new();
    }
    let mut level = leaves.to_vec();
    let mut siblings = Vec::new();
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            let last = level[level.len() - 1].clone();
            level.push(last);
        }
        let sibling_index = if index % 2 == 0 { index + 1 } else { index - 1 };
        siblings.push(level[sibling_index].clone());
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            next.push(hash_pair(&pair[0], &pair[1]));
        }
        level = next;
        index /= 2;
    }
    siblings
}

fn hash_pair(left: &str, right: &str) -> String {
    hash_bytes(format!("{left}{right}").as_bytes())
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(canonical).collect();
            format!("[{}]", parts.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Snapshot, StreamEntry, SNAPSHOT_SCHEMA_FINGERPRINT};

    fn sample() -> Snapshot {
        Snapshot {
            schema_version: 1,
            schema_fingerprint: SNAPSHOT_SCHEMA_FINGERPRINT.to_string(),
            exported_at: 1,
            rpc_url: "http://rpc".to_string(),
            contract_id: "C".to_string(),
            latest_ledger: 10,
            contract_schema_version: 1,
            contract_frozen: false,
            governor: "G".to_string(),
            streams: vec![stream(2, 20), stream(1, 10)],
            scheduled_intents: vec![],
            treasuries: vec![],
            stream_fees: vec![],
            sender_indexes: vec![],
            recipient_indexes: vec![],
            merkle_root: None,
            merkle_leaf_count: None,
        }
    }

    fn stream(id: u64, deposit: i128) -> StreamEntry {
        StreamEntry {
            id,
            sender: "S".to_string(),
            recipient: "R".to_string(),
            token: "T".to_string(),
            deposit,
            withdrawn: 0,
            start_time: 1,
            end_time: 2,
            cancelable: true,
            status: "Active".to_string(),
        }
    }

    #[test]
    fn root_is_stable_when_record_order_changes() {
        let mut reversed = sample();
        reversed.streams.reverse();
        assert_eq!(seal(sample()).merkle_root, seal(reversed).merkle_root);
    }

    #[test]
    fn tamper_and_truncation_fail_closed() {
        let sealed = seal(sample());
        let mut tampered = sealed.clone();
        tampered.streams[0].deposit = 999;
        assert!(verify_snapshot(&tampered).is_err());

        let mut truncated = sealed.clone();
        truncated.streams.pop();
        assert!(verify_snapshot(&truncated).is_err());
        assert!(verify_snapshot(&sealed).is_ok());
    }

    #[test]
    fn inclusion_proof_round_trips() {
        let sealed = seal(sample());
        let proof = inclusion_proof(&sealed, 0).unwrap();
        assert!(verify_inclusion(&proof));
        let mut forged = proof.clone();
        forged.leaf = "00".repeat(32);
        assert!(!verify_inclusion(&forged));
    }

    #[test]
    fn migration_root_matches_the_migrated_records() {
        let old = sample();
        let migrate = |source: &Snapshot| {
            let mut next = source.clone();
            next.schema_version = 2;
            next.streams
                .iter_mut()
                .find(|entry| entry.id == 1)
                .unwrap()
                .status = "Depleted".to_string();
            next.merkle_root = None;
            next.merkle_leaf_count = None;
            next
        };
        let migrated = seal(migrate(&old));
        let proof = verify_migration(&old, &migrated, migrate).unwrap();
        assert_eq!(proof.schema_from, 1);
        assert_eq!(proof.schema_to, 2);
        assert_ne!(proof.old_root, proof.new_root);
    }
}
