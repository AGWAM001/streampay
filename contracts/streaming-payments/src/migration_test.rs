//! Tests for the emergency state migration (issue #569).
//!
//! The round-trip test is the storage-replay proof the issue asks for: a
//! populated source instance is exported, the snapshot is imported into a
//! fresh instance, and the target's stored state is asserted record-for-
//! record equal to the source's. The negative tests are the tamper and
//! partial-import fixtures: a modified record fails its Merkle proof, a
//! partial import cannot finalize, and neither a page nor a whole root can
//! be replayed.
#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, BytesN, Env, Vec,
};

use crate::migration::{leaf_hash, merkle_root, node_hash};
use crate::test_client::StreamingPaymentsClient as Client;
use crate::{
    ExportPhase, GovernanceAction, ImportPhase, MigrationProof, MigrationRecord, StreamError,
    StreamPolicy, StreamingPayments,
};

const DAY: u64 = 86_400;
const DEPOSIT: i128 = 1_000_000;

struct Pair {
    env: Env,
    token: Address,
    sender: Address,
    recipient: Address,
    governor: Address,
    source: Address,
    source_client: Client<'static>,
    target: Address,
    target_client: Client<'static>,
}

fn setup_pair() -> Pair {
    let env = Env::default();
    env.mock_all_auths();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = sac.address();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let governor = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&sender, &(40 * DEPOSIT));

    let source = env.register(StreamingPayments, (governor.clone(),));
    let source_client = Client::new(&env, &source);
    let target = env.register(StreamingPayments, (governor.clone(),));
    let target_client = Client::new(&env, &target);

    StellarAssetClient::new(&env, &token).approve(&sender, &source, &(40 * DEPOSIT), &1_000_000u32);

    Pair {
        env,
        token,
        sender,
        recipient,
        governor,
        source,
        source_client,
        target,
        target_client,
    }
}

impl Pair {
    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    fn advance(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += seconds);
    }

    fn create_stream(&self, deposit: i128, start_in: u64, duration: u64) -> u64 {
        let now = self.now();
        self.source_client
            .mock_all_auths()
            .create_stream_with_oracle(
                &self.sender,
                &self.recipient,
                &self.token,
                &deposit,
                &(now + start_in),
                &(now + start_in + duration),
                &true,
                &false,
            )
    }

    /// Populates the source with one of every record kind and returns the
    /// records in canonical export order (after the auto-written globals).
    fn populate(&self) -> std::vec::Vec<MigrationRecord> {
        let c = self.source_client.mock_all_auths();
        // A fee rate first, so stream creation produces fee + treasury state.
        c.set_fee_bps(&self.governor, &100);
        let s1 = self.create_stream(DEPOSIT, DAY, 10 * DAY);
        let s2 = self.create_stream(2 * DEPOSIT, DAY, 10 * DAY);
        let s3 = self.create_stream(3 * DEPOSIT, 2 * DAY, 10 * DAY);
        // Accrue and partially withdraw from s1 so `withdrawn > 0`.
        self.advance(3 * DAY);
        c.withdraw(&s1, &100_000);
        // An open dispute on s2 (bond escrowed by the recipient).
        StellarAssetClient::new(&self.env, &self.token).mint(&self.recipient, &(10 * DEPOSIT));
        StellarAssetClient::new(&self.env, &self.token).approve(
            &self.recipient,
            &self.source,
            &(10 * DEPOSIT),
            &1_000_000u32,
        );
        c.raise_dispute(&s2);
        // A scheduled intent with escrow still outstanding.
        let now = self.now();
        let intent = c.schedule_stream(
            &self.sender,
            &self.recipient,
            &self.token,
            &(DEPOSIT / 2),
            &(now + DAY),
            &(now + 2 * DAY),
            &true,
            &DAY,
            &3u32,
            &1_000i128,
            &now,
            &(now + 30 * DAY),
        );
        // A sponsor configuration and a global stream policy.
        let sponsor = Address::generate(&self.env);
        let op_key = BytesN::from_array(&self.env, &[7u8; 32]);
        c.register_sponsor(
            &sponsor,
            &self.token,
            &(10 * DEPOSIT),
            &(5 * DEPOSIT),
            &DAY,
            &op_key,
        );
        c.set_stream_policy(
            &self.governor,
            &Option::<Address>::None,
            &StreamPolicy {
                min_rate: 1,
                max_rate: 1_000_000,
                min_duration: 60,
                max_duration: 365 * DAY,
                min_deposit: 1,
            },
        );

        let mut records = std::vec::Vec::new();
        for id in [s1, s2, s3] {
            records.push(MigrationRecord::Stream(c.get_stream(&id)));
        }
        records.push(MigrationRecord::Intent(c.get_intent(&intent)));
        records.push(MigrationRecord::Dispute(c.get_dispute(&s2)));
        records.push(MigrationRecord::Fee(
            s1,
            self.env.as_contract(&self.source, || {
                crate::treasury::get_stream_fee_record(&self.env, s1).expect("fee record")
            }),
        ));
        let treasury = self.env.as_contract(&self.source, || {
            crate::treasury::get_treasury(&self.env, &self.token)
        });
        records.push(MigrationRecord::Treasury(self.token.clone(), treasury));
        records.push(MigrationRecord::Sponsor(
            sponsor.clone(),
            self.env.as_contract(&self.source, || {
                crate::sponsor::get_config(&self.env, &sponsor).expect("sponsor config")
            }),
        ));
        records.push(MigrationRecord::Policy(
            None,
            c.get_stream_policy(&Option::<Address>::None)
                .expect("global policy"),
        ));
        records
    }
}

// ------------------------------------------------------------ proof helpers

macro_rules! soroban_vec {
    ($env:expr, $items:expr) => {{
        let mut v = Vec::new($env);
        for item in $items {
            v.push_back(item.clone());
        }
        v
    }};
}

/// Builds the proofs for one page and returns (page_root, proofs).
fn page_proofs(
    env: &Env,
    records: &[MigrationRecord],
) -> (BytesN<32>, std::vec::Vec<MigrationProof>) {
    let leaves: std::vec::Vec<BytesN<32>> = records.iter().map(|r| leaf_hash(env, r)).collect();
    let root = merkle_root(env, &soroban_vec!(env, &leaves));
    let proofs = (0..leaves.len())
        .map(|i| MigrationProof {
            siblings: soroban_vec!(env, &siblings_for(&leaves, i, env)),
        })
        .collect();
    (root, proofs)
}

/// The sibling hashes proving `leaves[index]` against the page root,
/// under the promote-odd-node rule of `migration::merkle_root`.
fn siblings_for(leaves: &[BytesN<32>], index: usize, env: &Env) -> std::vec::Vec<BytesN<32>> {
    let mut siblings = std::vec::Vec::new();
    let mut level = leaves.to_vec();
    let mut idx = index;
    while level.len() > 1 {
        if idx % 2 == 0 {
            if idx + 1 < level.len() {
                siblings.push(level[idx + 1].clone());
            }
        } else {
            siblings.push(level[idx - 1].clone());
        }
        let mut next = std::vec::Vec::new();
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push(node_hash(env, &level[i], &level[i + 1]));
            } else {
                next.push(level[i].clone());
            }
            i += 2;
        }
        idx /= 2;
        level = next;
    }
    siblings
}

/// Runs a full export of `records` (already in canonical order, split into
/// pages of `page_size`) and returns the published root.
fn run_export(p: &Pair, records: &[MigrationRecord], page_size: usize) -> BytesN<32> {
    let c = p.source_client.mock_all_auths();
    c.migration_begin_export(&p.governor);
    for chunk in records.chunks(page_size) {
        c.migration_export_page(&soroban_vec!(&p.env, chunk));
    }
    c.migration_finalize_export()
}

/// Imports page `page` of a completed export into the target.
fn import_page(p: &Pair, page: u32, records: &[MigrationRecord], page_roots: &[BytesN<32>]) {
    let (page_root, proofs) = page_proofs(&p.env, records);
    assert_eq!(&page_root, &page_roots[page as usize], "page root drift");
    let page_siblings = siblings_for(page_roots, page as usize, &p.env);
    p.target_client.mock_all_auths().migration_import_page(
        &page,
        &soroban_vec!(&p.env, &page_siblings),
        &soroban_vec!(&p.env, records),
        &soroban_vec!(&p.env, &proofs),
    );
}

/// All page roots of the source's export, page zero first.
fn all_page_roots(
    p: &Pair,
    records: &[MigrationRecord],
    page_size: usize,
) -> std::vec::Vec<BytesN<32>> {
    let c = p.source_client.mock_all_auths();
    let session = c.migration_export().expect("export session");
    let mut roots = std::vec::Vec::new();
    // Page zero is the globals record written by begin_export.
    roots.push(c.migration_page_root(&0).expect("page zero root"));
    let mut page = 1u32;
    for chunk in records.chunks(page_size) {
        let (root, _) = page_proofs(&p.env, chunk);
        assert_eq!(Some(root.clone()), c.migration_page_root(&page));
        roots.push(root);
        page += 1;
    }
    assert_eq!(roots.len() as u32, session.pages);
    roots
}

/// The globals record the source wrote as page zero. The source is frozen
/// once the export begins, so the `migration_globals` view still returns
/// exactly the record `begin_export` captured.
fn globals_record(p: &Pair) -> MigrationRecord {
    MigrationRecord::Globals(p.source_client.mock_all_auths().migration_globals())
}

// ------------------------------------------------------------------- tests

#[test]
fn export_import_round_trip_replays_state() {
    let p = setup_pair();
    let records = p.populate();
    let root = run_export(&p, &records, 4);

    let source = p.source_client.mock_all_auths();
    let session = source.migration_export().expect("session");
    assert_eq!(session.phase, ExportPhase::Exported);
    assert_eq!(session.root, Some(root.clone()));
    assert!(source.is_frozen(), "source must stay frozen after export");

    let page_roots = all_page_roots(&p, &records, 4);
    let target = p.target_client.mock_all_auths();
    let committed = target.migration_begin_import(&p.governor, &p.source);
    assert_eq!(committed, root);

    // Pages out of order: last page first, then page zero, then the rest.
    let chunks: std::vec::Vec<&[MigrationRecord]> = records.chunks(4).collect();
    assert_eq!(chunks.len(), 3, "9 records in pages of 4");
    import_page(&p, 3, chunks[2], &page_roots);
    import_page(&p, 0, &[globals_record(&p)], &page_roots);
    import_page(&p, 1, chunks[0], &page_roots);
    import_page(&p, 2, chunks[1], &page_roots);
    target.migration_finalize_import();

    let import = target.migration_import().expect("import session");
    assert_eq!(import.phase, ImportPhase::Imported);
    assert_eq!(import.records_done, import.records);
    assert_eq!(import.value_done, import.total_value);
    assert_eq!(import.total_value, session.total_value);
    assert!(
        import.total_value > 0,
        "snapshot must carry real escrow value"
    );

    // Replay: every record kind reads back identical on the target.
    for record in &records {
        match record {
            MigrationRecord::Stream(s) => {
                assert_eq!(target.get_stream(&s.id), source.get_stream(&s.id));
                assert_eq!(target.get_stream(&s.id), *s);
            }
            MigrationRecord::Intent(i) => {
                assert_eq!(target.get_intent(&i.id), *i);
            }
            MigrationRecord::Dispute(d) => {
                assert_eq!(target.get_dispute(&d.stream_id), *d);
            }
            MigrationRecord::Fee(id, fee) => {
                let stored = p.env.as_contract(&p.target, || {
                    crate::treasury::get_stream_fee_record(&p.env, *id)
                });
                assert_eq!(stored, Some(fee.clone()));
            }
            MigrationRecord::Treasury(token, t) => {
                assert_eq!(target.treasury_status(token), source.treasury_status(token));
                let stored = p
                    .env
                    .as_contract(&p.target, || crate::treasury::get_treasury(&p.env, token));
                assert_eq!(&stored, t);
            }
            MigrationRecord::Sponsor(address, cfg) => {
                assert_eq!(target.get_sponsor(address), Some(cfg.clone()));
            }
            MigrationRecord::Policy(token, policy) => {
                assert_eq!(target.get_stream_policy(token), Some(policy.clone()));
            }
            MigrationRecord::Globals(_) => unreachable!("globals is page zero"),
        }
    }
    // The globals record landed: counters continue where the source left off.
    assert_eq!(target.total_streams(), source.total_streams());
    // The target stays frozen until governance unfreezes it.
    assert!(target.is_frozen());
}

#[test]
fn tampered_record_fails_its_proof() {
    let p = setup_pair();
    let records = p.populate();
    run_export(&p, &records, 32);
    let page_roots = all_page_roots(&p, &records, 32);
    p.target_client
        .mock_all_auths()
        .migration_begin_import(&p.governor, &p.source);

    // Page zero imports cleanly.
    import_page(&p, 0, &[globals_record(&p)], &page_roots);

    // Tamper: inflate one stream's deposit after its proof was computed.
    let mut tampered = records.clone();
    let (page_root, proofs) = page_proofs(&p.env, &records);
    assert_eq!(page_root, page_roots[1]);
    if let MigrationRecord::Stream(s) = &mut tampered[0] {
        s.deposit += 1;
    } else {
        panic!("first record is a stream");
    }
    let page_siblings = siblings_for(&page_roots, 1, &p.env);
    let err = p
        .target_client
        .mock_all_auths()
        .try_migration_import_page(
            &1,
            &soroban_vec!(&p.env, &page_siblings),
            &soroban_vec!(&p.env, &tampered),
            &soroban_vec!(&p.env, &proofs),
        )
        .expect_err("tampered page must be refused")
        .unwrap();
    assert_eq!(err, StreamError::MigrationProofInvalid);
}

#[test]
fn partial_import_cannot_finalize() {
    let p = setup_pair();
    let records = p.populate();
    run_export(&p, &records, 4);
    let page_roots = all_page_roots(&p, &records, 4);
    let target = p.target_client.mock_all_auths();
    target.migration_begin_import(&p.governor, &p.source);
    import_page(&p, 0, &[globals_record(&p)], &page_roots);

    let err = target
        .try_migration_finalize_import()
        .expect_err("partial import must not finalize")
        .unwrap();
    assert_eq!(err, StreamError::MigrationImportIncomplete);
}

#[test]
fn imported_page_cannot_be_replayed() {
    let p = setup_pair();
    let records = p.populate();
    run_export(&p, &records, 4);
    let page_roots = all_page_roots(&p, &records, 4);
    p.target_client
        .mock_all_auths()
        .migration_begin_import(&p.governor, &p.source);
    import_page(&p, 0, &[globals_record(&p)], &page_roots);

    let (page_root, proofs) = page_proofs(&p.env, &[globals_record(&p)]);
    assert_eq!(page_root, page_roots[0]);
    let page_siblings = siblings_for(&page_roots, 0, &p.env);
    let err = p
        .target_client
        .mock_all_auths()
        .try_migration_import_page(
            &0,
            &soroban_vec!(&p.env, &page_siblings),
            &soroban_vec!(&p.env, &[globals_record(&p)]),
            &soroban_vec!(&p.env, &proofs),
        )
        .expect_err("page replay must be refused")
        .unwrap();
    assert_eq!(err, StreamError::MigrationPageAlreadyImported);
}

#[test]
fn consumed_root_cannot_be_imported_twice() {
    let p = setup_pair();
    let records = p.populate();
    run_export(&p, &records, 32);
    let page_roots = all_page_roots(&p, &records, 32);
    let target = p.target_client.mock_all_auths();
    target.migration_begin_import(&p.governor, &p.source);
    import_page(&p, 0, &[globals_record(&p)], &page_roots);
    import_page(&p, 1, &records, &page_roots);
    target.migration_finalize_import();

    let err = target
        .try_migration_begin_import(&p.governor, &p.source)
        .expect_err("second import of the same root must be refused")
        .unwrap();
    assert_eq!(err, StreamError::MigrationRootConsumed);
}

#[test]
fn export_rejects_fabricated_and_out_of_order_records() {
    let p = setup_pair();
    let records = p.populate();
    let c = p.source_client.mock_all_auths();
    c.migration_begin_export(&p.governor);

    // Fabricated: a stream record whose deposit does not match storage.
    let mut fake = records.clone();
    if let MigrationRecord::Stream(s) = &mut fake[0] {
        s.deposit += 1;
    }
    let err = c
        .try_migration_export_page(&soroban_vec!(&p.env, &fake[..1]))
        .expect_err("fabricated record must be refused")
        .unwrap();
    assert_eq!(err, StreamError::MigrationRecordMismatch);

    // Out of order: stream 2 before stream 1 within one page.
    let err = c
        .try_migration_export_page(&soroban_vec!(
            &p.env,
            &[records[1].clone(), records[0].clone()]
        ))
        .expect_err("out-of-order page must be refused")
        .unwrap();
    assert_eq!(err, StreamError::MigrationExportOrderViolation);
}

#[test]
fn begin_import_rejects_unfinalized_source_and_non_fresh_target() {
    let p = setup_pair();
    let records = p.populate();
    let c = p.source_client.mock_all_auths();
    c.migration_begin_export(&p.governor);
    // Export begun but not finalized: no published root to commit to.
    let err = p
        .target_client
        .mock_all_auths()
        .try_migration_begin_import(&p.governor, &p.source)
        .expect_err("unfinalized source must be refused")
        .unwrap();
    assert_eq!(err, StreamError::MigrationSourceNotFinalized);

    for chunk in records.chunks(32) {
        c.migration_export_page(&soroban_vec!(&p.env, chunk));
    }
    c.migration_finalize_export();

    // Non-fresh target: hand out a stream id on a third instance.
    let third = p.env.register(StreamingPayments, (p.governor.clone(),));
    let third_client = Client::new(&p.env, &third);
    StellarAssetClient::new(&p.env, &p.token).approve(
        &p.sender,
        &third,
        &(10 * DEPOSIT),
        &1_000_000u32,
    );
    let now = p.now();
    third_client.mock_all_auths().create_stream_with_oracle(
        &p.sender,
        &p.recipient,
        &p.token,
        &DEPOSIT,
        &(now + DAY),
        &(now + 2 * DAY),
        &true,
        &false,
    );
    let err = third_client
        .mock_all_auths()
        .try_migration_begin_import(&p.governor, &p.source)
        .expect_err("non-fresh target must be refused")
        .unwrap();
    assert_eq!(err, StreamError::MigrationTargetNotFresh);
}

#[test]
fn export_freezes_the_source() {
    let p = setup_pair();
    p.populate();
    let c = p.source_client.mock_all_auths();
    c.migration_begin_export(&p.governor);
    assert!(c.is_frozen());
    let now = p.now();
    let err = c
        .try_create_stream_with_oracle(
            &p.sender,
            &p.recipient,
            &p.token,
            &DEPOSIT,
            &(now + DAY),
            &(now + 2 * DAY),
            &true,
            &false,
        )
        .expect_err("frozen source must refuse new streams")
        .unwrap();
    assert_eq!(err, StreamError::ContractFrozen);
}

#[test]
fn governance_timelock_gates_begin_export() {
    let p = setup_pair();
    p.populate();
    let c = p.source_client.mock_all_auths();
    let a = Address::generate(&p.env);
    let b = Address::generate(&p.env);
    let mut signers = Vec::new(&p.env);
    signers.push_back(a.clone());
    signers.push_back(b.clone());
    c.governance_bootstrap(&p.governor, &signers, &crate::DEFAULT_VETO_WINDOW_SECONDS);

    // Direct begin is closed once the timelock owns the admin surface.
    let err = c
        .try_migration_begin_export(&p.governor)
        .expect_err("direct begin must be refused under governance")
        .unwrap();
    assert_eq!(err, StreamError::GovernanceTimelockRequired);

    // The proposal path works: propose, two distinct signatures, mature,
    // execute — and the export opens, frozen.
    let id = c.governance_propose(&a, &GovernanceAction::BeginMigrationExport);
    c.governance_sign(&a, &id);
    c.governance_sign(&b, &id);
    p.advance(crate::DEFAULT_VETO_WINDOW_SECONDS + 1);
    c.governance_execute(&p.governor, &id);
    let session = c.migration_export().expect("export session");
    assert_eq!(session.phase, ExportPhase::Exporting);
    assert!(c.is_frozen());
}

#[test]
fn conservation_holds_over_randomized_state() {
    // A seeded LCG drives stream creation/withdrawal so the state is
    // irregular but the test is deterministic.
    let mut seed = 0x5690_2026u64;
    let mut next = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as u32
    };

    let p = setup_pair();
    let c = p.source_client.mock_all_auths();
    let mut ids = std::vec::Vec::new();
    for i in 0..10 {
        let deposit = 100_000 + (next() % 900_000) as i128;
        let id = p.create_stream(deposit, DAY, 30 * DAY);
        ids.push(id);
        if i % 3 == 0 {
            p.advance(5 * DAY);
            let accrued = c.available(&id);
            if accrued > 10 {
                c.withdraw(&id, &(accrued / 2));
            }
        }
    }
    let mut records = std::vec::Vec::new();
    for id in &ids {
        records.push(MigrationRecord::Stream(c.get_stream(id)));
    }
    let expected_value: i128 = records
        .iter()
        .map(|r| crate::migration::record_value(r).expect("value"))
        .sum();
    assert!(expected_value > 0);

    run_export(&p, &records, 3);
    let page_roots = all_page_roots(&p, &records, 3);
    let target = p.target_client.mock_all_auths();
    target.migration_begin_import(&p.governor, &p.source);
    import_page(&p, 0, &[globals_record(&p)], &page_roots);
    for (n, chunk) in records.chunks(3).enumerate() {
        import_page(&p, (n + 1) as u32, chunk, &page_roots);
    }
    target.migration_finalize_import();

    let import = target.migration_import().expect("import session");
    assert_eq!(import.total_value, expected_value);
    assert_eq!(import.value_done, expected_value);
    for id in &ids {
        assert_eq!(target.get_stream(id), c.get_stream(id));
    }
}
