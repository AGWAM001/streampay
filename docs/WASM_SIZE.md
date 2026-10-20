# Contract Wasm size (issue #58)

Goal: keep the deployed `streampay_contract.wasm` **below 60 KB** without any
behavior change, so the contract stays cheap to deploy and close to the
Soroban instruction/size comfort zone while the CI size budget
(`WASM_SIZE_BUDGET_KB` in `.github/workflows/ci.yml`) holds the line.

All numbers below are built with the pinned release toolchain
(`stellar-cli 28.1.0`, `rustc 1.99.1`, `wasm32v1-none`, `stellar contract build`
→ spec-shaking v2 + wasm-opt `-Oz` with convergence). Reproduce any row with:

```bash
cd contracts/streaming-payments && stellar contract build
node scripts/wasm-report.mjs ../../target/wasm32v1-none/release/streampay_contract.wasm
```

## Measured progression

| Stage | Technique | Total (bytes) | Δ |
|---|---|---|---|
| Baseline | commit `09516fe` (post oracle-time + sponsor merge) | **91,004** | — |
| 1 | Doc strings removed from the on-chain spec | 60,852 | −30,152 |
| 2 | Creation effects-leg dedup (`persist_new_stream`) | 60,386 | −466 |

Final size: **60,386 bytes (59.0 KiB)** — under the 60 KB target, and 33.6 %
smaller than the baseline this work started from (59.7 % of it). Measured
against the 120 KB budget the size gate was set at (issue #35), the binary is
now **under half that budget**; the budget itself is lowered to 60 KB here so
any regression fails CI.

### Section breakdown (baseline → final)

| Section | Baseline | Final | Δ |
|---|---|---|---|
| `contractspecv0` | 46,863 | 16,711 | −30,152 |
| `code` | 37,770 | 37,288 | −482 |
| `data` | 3,963 | 3,963 | 0 |
| `export` | 1,278 | 1,278 | 0 |
| `contractmetav0` ×2 | 230 | 230 | 0 |
| `contractenvmetav0` | 30 | 30 | 0 |
| headers/other | 870 | 886 | +16 |

The interface spec section alone was more than half the deployed binary. A
control experiment (stripping the `///` doc comments of the contract interface
items for one measurement build) shrank `contractspecv0` from 46,863 B to
16,711 B, proving most of the spec section is documentation strings embedded
into the Wasm by `soroban-sdk-macros` — the techniques in this branch attack
exactly that.

### Baseline function-level sizes (top of `code`)

| Function | Bytes |
|---|---|
| `sponsored_withdraw` | 1,589 |
| `create_streams` | 1,413 |
| `schedule_stream` | 1,268 |
| `create_streams_batch` | 1,086 |
| `execute_scheduled` | 914 |
| `top_up` | 756 |
| `cancel_stream` | 631 |
| `migrate_storage` | 564 |

(Regenerable in full with `scripts/wasm-report.mjs` against any build
artifact.)

## Technique 1 — stop embedding doc strings in the deployed spec (−30,152 B)

`soroban-sdk-macros` copies every `///` doc comment of the contract interface
(`#[contractimpl]` entrypoints, `#[contracttype]` fields/variants,
`#[contracterror]` variants, `#[contractevent]` structs — events ship in the
spec as UDT entries) into `contractspecv0`. On this contract that prose was
**30,152 B of the 46,863 B spec section** — a third of the whole binary —
paid on every deploy and baked into the on-chain interface.

The fix is purely mechanical: each such doc comment becomes

```rust
#[cfg_attr(not(target_family = "wasm"), doc = " …the original text… ")]
```

Proc-macro attributes are token-matched **before** `cfg_attr` expansion, so on
the `wasm32v1-none` build the spec macros see no `#[doc]` attributes at all
and emit empty doc strings; on host builds (tests, rustdoc, analytics
tooling) the attribute expands back into the identical `#[doc]` items. Source
documentation is preserved 1:1; only its duplication into the binary stops.

- No signature, name, arity, event-topic, or error-code change: `stellar
  contract invoke`, the frontend SDK typings pipeline, `canary_check.sh` and
  `schema_diff.sh` all keep working. The canonical interface hash does change
  (doc strings were part of the hashed spec) — see the operator-notification
  section at the end of this document.
- Module-internal docs (helpers, storage math) were never embedded and are
  left as plain `///`.

After this step the binary is **60,852 B (59.4 KiB)** — under the 60 KB
target, sections: `code` 37,770 · `contractspecv0` 16,711 · `data` 3,963.

## Technique 2 — dedup the stream-creation effects leg (−466 B)

`create_stream_with_oracle`, `create_stream_internal` (scheduled execution)
and `create_single_batch_entry` each contained the same id → persist → index →
optional fee → `StreamCreated` → optional `FeeCharged` leg, with only the fee
and oracle flag differing. They now share one private helper,
`StreamingPayments::persist_new_stream`, keeping the exact effect order (the
CEI operation-order goldens for the scheduled paths are byte-identical).

The atomic `create_streams` batch loop intentionally does **not** emit
per-stream `StreamCreated` events, so it keeps its own leg and was not merged.

`code` shrinks 37,770 → 37,288; the two call sites that inlined the leg
(`create_streams_batch` 1,086 → 795, `execute_scheduled` 914 → 773) now call
the shared helper. Final binary: **60,386 B (59.0 KiB)**.

## Categories investigated and rejected (with measurements)

| Candidate | Verdict |
|---|---|
| `[profile.release]` tuning (`opt-level="z"`, `lto=true`, `codegen-units=1`, `panic="abort"`, `strip="symbols"`, `debug=0`) | Already maxed out on main; every knob was at its size-optimal setting before this work. No delta available. |
| Extra `wasm-opt` passes | `stellar contract build` already runs `-Oz` to convergence with MVP/sign-ext/mutable-globals/bulk-memory; there is no supported flag surface left to flip, and changing it would break reproducible builds (the canonical build is the CLI's). |
| Trimming soroban-sdk features (`no_std` surface) | The crate already builds with `#![no_std]` and no default features; the SDK's own surface (env host glue, XDR, Vec/Map serialization) is where the remaining `code` section lives. No unused feature to cut. |
| Dead-code elimination in event/error formatting | Nothing to eliminate: `surface::reject` instrumentation already compiles away in non-test builds, event publishing is live code, and error `code()`s are u32 consts. The dead bytes were doc prose (Technique 1), not formatting. |
| Stripping `contractspecv0` entirely (would save another −16.7 KB) | **Rejected.** The host executes a spec-less Wasm, but `stellar contract invoke`, `stellar contract info interface`, `canary_check.sh` (all three checks), the schema gates and every integrator's auto-generated client depend on the embedded spec. Removing it trades 16 KB for breaking the entire operational surface. Use `stellar contract info hash` only as a last-resort deploy check, not as a substitute. |
| Splitting rarely-used entrypoints into a second contract | **Rejected for now.** Entry points cost size mainly through their spec entries (~16.7 KB spread over 46 functions); moving e.g. the sponsor/attestation surface out would break the single-contract deploy/upgrade model (storage is per-contract; streams and sponsor budgets share instance storage), double the deploy pipeline, and change every integrator's address. If the contract grows past the next budget step, revisit with the governance/sponsor surface as the split candidate — it is the least used by the frontend today. |
| `overflow-checks = false` | Saves a few hundred bytes at the cost of wrapping arithmetic in production — rejected on safety grounds (the contract's value model depends on checked math; `MathOverflow` is part of the published error surface). |

## Digest change — operator notification (expected)

This work changes the deployed bytes, so the release digest changes. This is
expected and is **not** a supply-chain signal. Operators must:

1. Expect `release-metadata.json.wasm_sha256`, `SHA256SUMS` and the
   `UPGRADE_DIGESTS.txt` head to change at the first release built from this
   branch. Any tool that pinned the old digest (watchtowers, canary configs,
   integrator allow-lists) must be repinned **before** the release tag.
2. Expect the canonicalized-interface hash (`scripts/contract_interface_hash.sh`)
   to change: doc strings are part of the hashed spec. The promote pipeline
   handles it — set `schema_change_ack: true` on the promote workflow run (and
   `SCHEMA_CHANGE_ACK=1` for `scripts/release_gates.sh`), which re-baselines
   `deployments/interface/<env>.sha256` for the canary's schema-continuity
   check. Existing deployments keep their old baseline until they are
   upgraded; `canary_check.sh` skips comparison when no baseline exists, and a
   wrong-Wasm deploy still fails on the new baseline.
3. Functionally nothing changes: storage layout, event topics, error codes and
   entrypoint signatures are untouched (verified by the unchanged
   `docs/ERRORS.md` regeneration and the differential/model tests), so the
   upgrade can follow the standard rehearsal → canary → promote flow in
   `docs/CANARY_RUNBOOK.md` with the ack steps above added.

Auditor-facing rebuild instructions are unchanged (`docs/REPRODUCING.md`):
the same pinned toolchain triad reproduces the new bytes.

## Function-level breakdown (top sizes)

Baseline (91,004 B) vs final (60,386 B), `code` section per function:

| Function | Baseline | Final |
|---|---|---|
| `sponsored_withdraw` | 1,589 | 1,589 |
| `create_streams` | 1,413 | 1,413 |
| `schedule_stream` | 1,268 | 1,268 |
| `create_streams_batch` | 1,086 | 795 |
| `execute_scheduled` | 914 | 773 |
| `top_up` | 756 | 756 |
| `cancel_stream` | 631 | 631 |
| `migrate_storage` | 564 | 564 |

`create_streams_batch` and `execute_scheduled` shrink because their inlined
copies of the creation effects leg now call the shared `persist_new_stream`
helper (which accounts for most of the remaining −50 B of spread). Full
before/after tables are regenerable with `scripts/wasm-report.mjs` against any
build artifact.
