# Emergency State Migration Runbook

The break-glass path for moving **all** StreamPay state from one contract
instance to a fresh one (issue #569), with Merkleized export/import proofs.
Use it when an in-place upgrade is not enough: a critical vulnerability in
the deployed instance, or state grown past what an upgrade can carry. It is
not a replacement for the proxy upgrade (#48) or schema versioning (#202) —
those change code or layout in place; this changes *instance*.

The protocol lives in `contracts/streaming-payments/src/migration.rs`. This
runbook is the operator procedure around it.

## Rules before you start

1. **Governance gates the beginning, nothing else.** Beginning an export or
   an import requires an executed two-key timelock proposal
   (`BeginMigrationExport` / `BeginMigrationImport(Address)`) once the
   signer set is bootstrapped (#119), or the governor directly before
   bootstrap. Pages, finalization and views are permissionless by design:
   every byte is either read back from the source instance cross-contract
   or proven against its published Merkle root, so a permissionless
   transport cannot inject state.
2. **Beginning an export freezes the source.** Immediately and
   irreversibly for the purposes of the snapshot: user traffic stops, the
   snapshot is taken against still state, and the source never unfreezes
   as part of this procedure. Announce the freeze before you begin.
3. **Records move; custody moves separately.** The migration moves the
   ledger's *meaning* (streams, intents, disputes, fees, treasuries,
   sponsors, policies, globals). The token balances themselves must be
   transferred to the new instance as an operational step (step 5), and
   the export's `total_value` is the amount to reconcile against.

## Procedure

### 0. Prepare the target

Deploy the new instance with the same governor. Do not let it serve any
traffic: it must be *fresh* (no stream or intent ids handed out) or
`migration_begin_import` refuses it with `MigrationTargetNotFresh`.

### 1. Begin the export (source)

Via governance (preferred): propose `BeginMigrationExport`, collect two
distinct signatures, wait out the veto window, execute. Or, pre-bootstrap,
the governor calls `migration_begin_export` directly.

Effects: the source freezes (`ContractFrozenStateChanged`), the export
session opens with nonce 1, and page zero — the globals record — is
written by the begin call itself.

### 2. Export the remaining pages

Snapshot the source with `tools/streampay-state` (the same model the
records mirror) and submit the records with `migration_export_page`, at
most 32 per page, in canonical record-key order: globals, streams by id,
intents by id, disputes by stream id, fee records by stream id, treasuries
by token, sponsors by address, global policy, per-asset policies.

Every record is checked against the source's own storage before it is
hashed in (`MigrationRecordMismatch` if it is not *the* stored record) and
ordering is enforced (`MigrationExportOrderViolation`). The operator is a
transport, never a source of truth.

### 3. Finalize the export (source)

Call `migration_finalize_export`. The page roots fold into one Merkle
root, published in the session (`migration_export`) and in the
`MigrationExported` event. Record the root, the nonce, the record count
and `total_value` in the incident log — this is the public proof artifact
the import will be audited against, together with the streampay-state
snapshot from step 2.

### 4. Begin the import (target)

Via governance: propose `BeginMigrationImport(<source address>)`, sign,
mature, execute. Or the governor calls `migration_begin_import(source)`
directly pre-bootstrap.

The target reads the source's session cross-contract, requires the export
finalized and the source frozen (`MigrationSourceNotFinalized`), and
consumes the root immediately: it can never be imported into this instance
again (`MigrationRootConsumed`), and no second import of anything can
begin while this one lives.

### 5. Move the custody

Transfer the escrow balances to the new instance's address so its token
balances cover, per token, the outstanding obligations implied by the
snapshot (live streams' un-withdrawn deposits, intent escrow, dispute
bonds, treasury collectibles). Reconcile the transferred totals against
the export's `total_value` before continuing.

### 6. Import the pages (target)

For each page, supply the records and their Merkle proofs with
`migration_import_page`, together with the page root's proof against the
committed root. Pages may arrive in any order, each exactly once
(`MigrationPageAlreadyImported` on a repeat). A tampered or partial page
fails closed (`MigrationProofInvalid`, `MigrationRootMismatch`) and
writes nothing.

### 7. Finalize the import (target)

Call `migration_finalize_import`. It asserts page, record and **value**
conservation against the export (`MigrationImportIncomplete`,
`MigrationConservationMismatch`) and emits `MigrationImported` and
`MigrationFinalized`. The target stays frozen.

### 8. Hand over

- Unfreeze the target through governance (`SetFrozen(false)` proposal) as
  a separate, visible act.
- Repoint indexers, frontends and keeper jobs at the new instance.
- Beneficiaries of gas sponsorship re-enroll their consent keys on the
  new instance: sponsor *configurations* migrate, but per-beneficiary
  consent keys and period spend windows are keyed by addresses no on-chain
  index enumerates, so they do not travel. Re-enrollment is a signature,
  not a fund movement.
- Keep the frozen source read-only for audit. Its export session and page
  roots remain the permanent proof of what was migrated.
