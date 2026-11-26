# streampay-multisig — reference K-of-N multisig

A Soroban contract that lets K of N ed25519 signer keys act as one `C…` address
for StreamPay: it can create, top up and cancel streams as the **sender** and
withdraw as the **recipient**. The streaming contract is unmodified and does
not know the address is a multisig.

Design, the reusable-vs-bring-your-own evaluation, fee implications and
security notes: [`docs/MULTISIG.md`](../../docs/MULTISIG.md).

> Reference implementation, not audited.

## Interface

| Entry point | Purpose |
|---|---|
| `__constructor(signers: Vec<BytesN<32>>, threshold: u32)` | Signer keys strictly ascending, 1–20 keys, `1 <= threshold <= N` |
| `__check_auth(payload, Vec<SignerSignature>, contexts)` | Custom-account auth: ≥ the highest threshold among `contexts` of valid member signatures, keys strictly ascending |
| `propose(proposer, action, expires_at, signature) -> u64` | Store an `Action`; the proposer's signature is approval #1 |
| `approve(proposal_id, signer, signature) -> u32` | Add one approval (duplicates rejected) |
| `revoke(proposal_id, signature)` | Proposer withdraws a pending proposal |
| `execute(proposal_id) -> Vec<Val>` | Permissionless once approvals ≥ the action's threshold |
| `config()`, `is_signer`, `required_approvals`, `next_proposal_id`, `get_proposal`, `action_hash`, `signing_payload` | Views |

`Action` is `Invoke(Vec<Call>)`, `SetSigners(SignerUpdate)` or
`SetPolicy(FnPolicy)`. A `Call` is `{ contract, func, args, auth }`; `auth`
holds `InvokerContractAuthEntry`s for `require_auth` calls on the multisig that
happen below the direct call (empty for every StreamPay entry point).

`FnPolicy { contract, func, threshold }` overrides the threshold for one
function of one contract — e.g. `(streaming, cancel_stream, 1)` lets any one
signer cancel. Configuration actions always need the default threshold, and
every configuration change bumps `epoch`, which makes every older proposal
stale.

## Signing

`__check_auth` signers sign the 32-byte Soroban authorization payload (the
same payload any custom account receives; it already binds network id, nonce,
expiration ledger and invocation). Proposal signers sign the 32 bytes returned
by `signing_payload(op, proposal_id, action_hash(action), expires_at)`:

```text
sha256("streampay.multisig.v1" ‖ network_id ‖ xdr(contract) ‖ op ‖ id ‖ epoch ‖ action_hash ‖ expires_at)
```

## Build and test

```bash
cargo test -p streampay-multisig
SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1 \
  cargo build --release --target wasm32v1-none -p streampay-multisig
```

`tests/stream_integration.rs` runs the real streaming contract against the
multisig with real (non-mocked) authorization.
