# Multisig senders and recipients (K-of-N)

Issue #50. A StreamPay stream can be created, topped up, cancelled and withdrawn
by a **K-of-N signer set** instead of a single key. The repository ships a
reference implementation, [`contracts/multisig`](../contracts/multisig/README.md)
(`streampay-multisig`), and the streaming contract is **unchanged**: it calls
`sender.require_auth()` / `recipient.require_auth()` / `caller.require_auth()`
exactly as before and never asks whether the address is a multisig.

- [1. How it fits](#1-how-it-fits)
- [2. Reusable multisig vs bring-your-own](#2-reusable-multisig-vs-bring-your-own)
- [3. The reference contract](#3-the-reference-contract)
- [4. Stream operations through the multisig](#4-stream-operations-through-the-multisig)
- [5. Fee implications](#5-fee-implications)
- [6. Security notes](#6-security-notes)
- [7. Threshold and membership edge cases](#7-threshold-and-membership-edge-cases)
- [8. Frontend](#8-frontend)
- [9. Tests](#9-tests)

## 1. How it fits

Soroban authorization is address-based. When the streaming contract calls
`require_auth()` on a **contract** address (`C…`), the host invokes that
contract's `__check_auth` with the signature payload of the authorization and
the list of calls being authorized. Any contract implementing
`CustomAccountInterface` is therefore a valid StreamPay sender or recipient,
with no special case in `contracts/streaming-payments`:

| Stream entry point | Auth it requires | Token movement |
|---|---|---|
| `create_stream(sender, …)` | `sender.require_auth()` | `transfer_from(spender = streaming contract, from = sender)` — the sender must have `approve`d the streaming contract first |
| `top_up(stream_id, amount)` | `s.sender.require_auth()` | `transfer_from` as above |
| `cancel_stream(caller, stream_id)` | `caller.require_auth()`; caller must be the sender, or the recipient of a `cancelable` stream | `transfer` out of the streaming contract |
| `withdraw` / `withdraw_max` | `s.recipient.require_auth()` | `transfer` to the recipient |

Because deposits are pulled with `transfer_from` (the streaming contract is the
spender), the multisig authorizes two things for a new stream: the token
`approve` and the `create_stream` call itself. Nothing deeper in the call tree
needs the multisig's signature.

## 2. Reusable multisig vs bring-your-own

| Option | Works with StreamPay today | Strengths | Weaknesses |
|---|---|---|---|
| **Classic Stellar account multisig** (a `G…` account with weighted signers and thresholds) | Yes, no code | Signatures are verified by stellar-core outside Soroban metering, so it is the cheapest; supported by existing wallets and signing tools | Thresholds are per account and operation class, not per contract function; no on-chain proposal workflow (signatures are collected off-chain by passing XDR around); signer weights are not visible to a contract |
| **Third-party smart-account framework** (vendor or community `__check_auth` accounts) | Yes, as any custom account | Maintained by a third party, may be audited, richer policy engines | Extra dependency that has to track this workspace's pinned `soroban-sdk = 29.0.1`; a larger surface than StreamPay needs to demonstrate; its API is outside this repo's control |
| **Bring-your-own reference** (`contracts/multisig`, this PR) | Yes | Small, self-contained, same SDK pin, tested end to end against the real streaming contract; adds an on-chain propose / approve / execute flow and per-function thresholds | Not audited; a reference to copy or replace, not a product |

**Decision.** StreamPay stays wallet-agnostic: the streaming contract must not
depend on any multisig implementation, and the tests prove that a custom
account works through the unmodified auth paths. We ship a small
bring-your-own reference rather than vendoring a framework, because what the
issue needs is a *working, tested reference* of the integration, and a
self-contained crate is the easiest one to read, audit and keep on the
workspace's SDK pin. Teams with an existing classic multisig account or a
vendor smart account can use that instead; nothing in StreamPay changes.

## 3. The reference contract

`contracts/multisig/src/lib.rs`. One signer set (ed25519 public keys, strictly
ascending, at most 20), one default threshold `K`, and optional per-function
policies. Two ways to authorize:

1. **Account abstraction — `__check_auth`.** The signature is a
   `Vec<SignerSignature { public_key, signature }>` over the host-supplied
   payload. The contract requires strictly ascending public keys (rejects a
   duplicated signer with `DuplicateSignature`), membership of every key
   (`NotASigner`), a valid ed25519 signature for each (an invalid one traps),
   and at least as many signatures as the **highest** threshold among the
   authorized contexts (`BelowThreshold`). One relayer submits one
   transaction carrying all signatures.
2. **On-chain proposals — `propose` / `approve` / `revoke` / `execute`.** An
   `Action` is one of `Invoke(Vec<Call>)` (call other contracts as the
   multisig), `SetSigners` or `SetPolicy`. Each approval is an ed25519
   signature over a domain-separated payload (see [§6](#6-security-notes)),
   verified on-chain, so signers never submit transactions themselves.
   `propose` counts as the proposer's approval. `execute` is permissionless
   once enough approvals are recorded; it marks the proposal executed *before*
   calling out, and the multisig is then the **direct invoker** of each call,
   so `require_auth` on its address succeeds without `__check_auth`. Calls
   that need the multisig's auth deeper in the tree carry
   `InvokerContractAuthEntry`s, passed to `env.authorize_as_current_contract`.

**Per-function policies.** `FnPolicy { contract, func, threshold }` sets a
different threshold for one entry point of one contract, for example
`(streaming contract, cancel_stream, 1)` so that **any single signer can
cancel** — an emergency brake. When one authorization (or one `Invoke` action)
covers several calls, the highest requirement applies, so a relaxed call
cannot smuggle a stricter one. Contract-creation contexts and configuration
actions always need the default threshold.

**Governance.** Membership, threshold and policies change only through a
`SetSigners` / `SetPolicy` proposal at the default threshold; there is no
admin key and no upgrade entry point. Every change bumps the config `epoch`.

## 4. Stream operations through the multisig

| Operation | `__check_auth` path (one transaction) | Proposal path |
|---|---|---|
| Create | Two signed auth entries (`token.approve`, `create_stream`), each with K signatures | One `Invoke` action: `[token.approve(multisig, streaming, amount, live_until), streaming.create_stream(multisig, …)]` |
| Top up | `top_up` entry with K signatures (and an allowance) | `Invoke([top_up])`, preceded by `approve` if the allowance is spent |
| Cancel | `cancel_stream(multisig, id)` entry; K signatures, or 1 under a `cancel_stream` policy of 1 | `Invoke([cancel_stream])`; with the 1-of-N policy the proposer can execute immediately |
| Withdraw (multisig recipient) | `withdraw_max(id)` entry with K signatures; tokens land on the multisig | `Invoke([withdraw_max])`; move funds on with `Invoke([token.transfer(multisig, to, amount)])` |

## 5. Fee implications

Every Soroban transaction pays an inclusion fee plus a resource fee (CPU
instructions, ledger reads/writes, transaction size, rent, events). How the K
signatures are carried changes which of these grows with K:

| | Classic account multisig as transaction source (account-level signatures) | `__check_auth` custom account (one auth entry, K signatures) | Per-signer auth (K separate addresses each calling `require_auth`) | On-chain proposals |
|---|---|---|---|---|
| Transactions | 1 | 1 | 1 | K + 1 (`propose`, K − 1 `approve`, `execute`) |
| Signature bytes | K decorated signatures in the envelope | K × (32-byte key + 64-byte signature) as an `ScVal` in the auth entry | K auth entries, each with its own signature and invocation tree | 96 bytes (key + signature) per `propose` / `approve` |
| Signature verification | by stellar-core, outside Soroban CPU metering | in `__check_auth`, metered: ≈ 424 k CPU instructions per signature (measured in the native test env: 475 k for 1, 899 k for 2, 1.32 M for 3, 2.17 M for 5 signatures) | K verifications, each metered | one verification per `propose` / `approve` |
| Ledger writes for replay protection | the source account's sequence number | one temporary nonce entry per auth entry (address credentials) | K nonce entries | none for signatures; the proposal entry is rewritten on every step and kept for up to 31 days (rent) |

Notes:

- The multisig collapses K independent authorizations into **one** auth
  entry: one nonce write, one payload, one invocation tree. That is why it is
  cheaper than "every signer authorizes" designs, and why StreamPay never needs
  to know K.
- A classic account multisig is cheapest on CPU when it is the transaction
  source (source-account credentials: its signatures sit on the envelope).
  When it authorizes through address credentials instead (someone else pays),
  the host verifies its signatures inside Soroban and they are metered like
  the custom account's. Either way it cannot express per-function thresholds
  or on-chain approval collection.
- The proposal flow costs the most in total (K + 1 transactions and a
  persistent entry), but each signer needs neither XLM nor a funded account:
  anyone can relay `propose` / `approve` / `execute`.
- The CPU figures exclude Wasm VM instantiation (the tests run the contract
  natively) and are a guide, not a quote; simulate on the target network.
  The contract bounds work per call: at most 20 signers, 8 calls per action
  and 16 policies.

## 6. Security notes

**Replay between networks.** A `__check_auth` signature payload is
`sha256(HashIdPreimage::SorobanAuthorization { network_id, nonce,
signature_expiration_ledger, invocation })`: it commits to the network
passphrase hash, a per-address nonce the host consumes, an expiration ledger
and the exact invocation tree (contract, function, arguments, sub-calls). A
testnet signature cannot be replayed on mainnet, the same signature cannot be
used twice on one network, and a signature for one set of arguments does not
authorize another (`signatures_for_other_args_do_not_authorize`,
`check_auth_nonce_prevents_replay`).

**Replay of proposal signatures.** Proposal signatures are not host-managed,
so the contract domain-separates them itself:

```text
sha256( "streampay.multisig.v1" ‖ network_id ‖ xdr(multisig address) ‖ op
        ‖ proposal_id ‖ epoch ‖ action_hash ‖ expires_at )
```

- `network_id` — no replay across networks;
- the multisig's own address — no replay onto another multisig with the same
  signers (`proposal_signatures_do_not_replay_across_contracts_or_networks`);
- `op` (`Propose` / `Approve` / `Revoke`) — an approval cannot be submitted as
  a revocation;
- `proposal_id` — ids are never reused;
- `epoch` — signatures die with the configuration they were made under;
- `action_hash = sha256(xdr(action))` and `expires_at` — the signature is for
  exactly this action until exactly this time.

**Signer keys are raw ed25519 keys.** They are not "the signers of a `G…`
account": removing a key from a classic account does not remove it from the
multisig. Rotate through a `SetSigners` proposal.

**Relaxed policies are per function, not per stream.** A 1-of-N
`cancel_stream` policy lets any single signer cancel **every** stream where the
multisig can cancel: as sender, and as recipient of a `cancelable` stream (which
stops further accrual to the multisig). `__check_auth` does not inspect
arguments; if you need per-stream rules, keep the default threshold or write a
policy contract that does.

**`execute` is permissionless.** Once a proposal has its approvals, anyone
can execute it at any time before `expires_at`. Choose short expiries.
Execution is atomic: if any call fails, nothing happens and the proposal stays
pending.

**Full threshold means full control.** An `Invoke` action at the default
threshold can call any contract with any arguments as the multisig (except the
multisig itself — Soroban forbids re-entry, and configuration has dedicated
actions).

**Storage liveness.** The instance (configuration) TTL is extended on every
configuration write and every successful `__check_auth`; proposals are
extended to outlive their maximum 30-day lifetime. An idle multisig's instance
can still be archived and must then be restored before use.

**Not audited.** The contract is a reference implementation.

## 7. Threshold and membership edge cases

| Case | Behavior | Test |
|---|---|---|
| Same signer twice in `__check_auth` | `DuplicateSignature` (keys must be strictly ascending) | `check_auth_rejects_duplicate_signer` |
| Same signer approves twice | `AlreadyApproved`; the proposer's `propose` already counts | `duplicate_approval_rejected` |
| Non-member signs or approves | `NotASigner` | `check_auth_rejects_non_member`, `non_member_cannot_propose_or_approve` |
| Revoked proposal | Terminal: approve / execute / revoke return `ProposalNotPending`; only the proposer can revoke | `revoke_by_proposer` |
| Signer set or threshold changes mid-proposal | Every older proposal becomes `StaleProposal` for approve and execute; the proposer can still revoke it | `member_change_invalidates_in_flight_proposals` |
| Policy changes mid-proposal | Also bumps the epoch, so the same rule applies | `config_actions_need_default_threshold_even_with_relaxed_policy` |
| Threshold 0, threshold > N, empty set, unsorted or duplicate keys, > 20 signers | Rejected at deploy and in `SetSigners` | `constructor_rejects_*`, `set_signers_validation` |
| Policy threshold 0 or > N; shrinking N below an existing policy; > 16 policies | `InvalidPolicy` / `TooManyPolicies` (threshold 0 in `SetPolicy` removes a policy) | `policy_validation` |
| Proposal past `expires_at` | `ProposalExpired`; expiry must be in the future and at most 30 days out | `expiry_is_enforced` |
| Lost keys | With fewer than K keys left the account is locked; there is no recovery path. Choose K and N so that N − K covers expected key loss. | — |

## 8. Frontend

The create-stream form (`frontend/components/StreamForm.tsx`) now accepts a
contract (`C…`) recipient. When the recipient or the connected sender is a
contract address it reads the contract's `config()` view through the
`readMultisigConfigAction` server action and shows the signer requirement
("a 2-of-3 multisig: each withdrawal needs 2 signer approvals", plus the
single-signer cancel rule when the multisig sets a `cancel_stream` policy for
the configured streaming contract). A contract that is not a multisig shows a
generic note that it must be able to authorize withdrawals. Submitting a
stream *from* a multisig is not done by the browser wallet; use one of the
paths in [§4](#4-stream-operations-through-the-multisig).

## 9. Tests

```bash
cargo test -p streampay-multisig            # unit + integration
cargo build --release --target wasm32v1-none -p streampay-multisig
```

`contracts/multisig/src/test.rs` covers `__check_auth` through the host's
account-contract path with real signatures, the proposal lifecycle, policies,
configuration changes and replay. `contracts/multisig/tests/stream_integration.rs`
drives the real `streampay-contract` (a dev-dependency) with real
authorization — `env.set_auths` with signed entries, never `mock_all_auths`
for the multisig: a 2-of-3 multisig creates a stream (both paths), one signer
cannot create or top up, one signer cancels under the 1-of-N policy (both
paths), a relaxed cancel cannot carry a top-up, and a stream pays out to a
multisig recipient that then moves the funds on.
