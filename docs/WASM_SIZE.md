# Contract Wasm size (issue #58)

Goal: keep the deployed `streampay_contract.wasm` **below 60 KB** without any
behavior change, so the contract stays cheap to deploy and close to the
Soroban instruction/size comfort zone while the CI size budget
(`WASM_SIZE_BUDGET_KB` in `.github/workflows/ci.yml`) holds the line.

All numbers are built with the pinned release toolchain
(`stellar-cli 28.1.0`, `rustc 1.99.1`, `wasm32v1-none`, `stellar contract build`
→ spec-shaking v2 + wasm-opt `-Oz` with convergence). Reproduce with:

```bash
cd contracts/streaming-payments && stellar contract build
node scripts/wasm-report.mjs ../../target/wasm32v1-none/release/streampay_contract.wasm
```

## Measured progression

| Stage | Technique | Total (bytes) | Δ |
|---|---|---|---|
| Baseline | commit `09516fe` (post oracle-time + sponsor merge) | **91,004** | — |
| 1 | Doc strings removed from the on-chain spec | 60,852 | −30,152 |

### Baseline section breakdown

| Section | Bytes | Share |
|---|---|---|
| `code` | 37,770 | 41.5 % |
| `contractspecv0` | 46,863 | 51.5 % |
| `data` | 3,963 | 4.4 % |
| `export` | 1,278 | 1.4 % |
| `contractmetav0` ×2 | 230 | 0.3 % |
| `contractenvmetav0` | 30 | 0.03 % |
| headers/other | 870 | 1.0 % |

The interface spec section alone is more than half the deployed binary. A
control experiment (stripping the `///` doc comments of the contract interface
items for one measurement build) shrank `contractspecv0` from 46,863 B to
16,711 B, proving most of the spec section is documentation strings embedded
into the Wasm by `soroban-sdk-macros` — the techniques in this branch attack
exactly that. Each technique's measured delta is documented in the sections
added by its own commit.

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
