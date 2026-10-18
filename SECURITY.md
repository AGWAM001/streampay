# Security policy

## Supported versions

| Version | Supported |
|---|---|
| main branch | ✅ |

## Reporting a vulnerability

StreamPay moves real funds. If you find a bug that could move funds
incorrectly, break an invariant (`0 ≤ withdrawn ≤ streamed ≤ deposit`, or the
contract-balance coverage invariant), or bypass an auth check:

1. **Do not open a public issue.**
2. Use GitHub's [private vulnerability reporting](
   https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
   on this repository — it reaches the maintainers directly and keeps the
   report confidential. If GitHub is unavailable to you, open a private
   report against any maintainer fork, or DM the handle listed in
   `.github/CODEOWNERS` — we will move the conversation to a confidential
   channel immediately.
3. Include a reproduction (test, tx traces, or a written scenario).

> Before mainnet (v1.0) we will publish a dedicated `security@` address with
> a PGP key alongside the release artifacts; until then, GitHub private
> reports are the canonical intake channel.

For **non-exploitable** findings — hardening gaps, defense-in-depth weaknesses,
or issues that are already disclosed or fixed — use the public
[security report form](.github/ISSUE_TEMPLATE/security-report.yml). It is
classified, labeled, and acknowledged automatically by the
[triage workflow](.github/workflows/security-triage.yml). Reward tiers, scope,
the loss model behind them, and the triage SLA are documented in
[`docs/BOUNTY.md`](docs/BOUNTY.md).

We aim to acknowledge within 72 hours and will credit reporters in the
release notes unless they prefer anonymity. Please give us a reasonable
window to fix before public disclosure.

## Operational key management

The contract concentrates power in a small set of keys — the treasury
governor, per-employee policy admins, and the operational agents that deploy
and keep the service alive. How we generate, split, back up, rotate, and
drill those keys is documented and executable:

- [`docs/ceremony.md`](docs/ceremony.md) — key ceremony: multisig + offline
  Shamir-split backup, witness checklist, small-team air-gap procedure, and
  what is explicitly deferred pre-v1.0.
- [`docs/rotation-runbook.md`](docs/rotation-runbook.md) — rotation runbook
  for every privileged role, with live-stream implications (in-flight
  amendments, scheduled refills, re-authorizing agent sets) and a
  verification step per surface.
- [`docs/KEY_COMPROMISE_TEMPLATE.md`](docs/KEY_COMPROMISE_TEMPLATE.md) —
  incident template for a suspected key compromise (containment order,
  per-role rotation evidence, blast-radius assessment). If you suspect one of
  our keys is compromised, report it via the private channel above.
- [`docs/SECURITY_LOG.md`](docs/SECURITY_LOG.md) — append-only audit trail:
  ceremonies, rotations, secrets-hygiene audits, and drill results.
- [`.github/workflows/key-rotation-drill.yml`](.github/workflows/key-rotation-drill.yml)
  — quarterly scheduled drill ([`scripts/key_rotation_drill.ts`](scripts/key_rotation_drill.ts))
  that rotates roles on a fresh testnet deploy and asserts no privileged
  operation survives an old key; its pass/fail matrix is attached to each
  run.

## Invariants worth testing against

- Per stream: `0 ≤ withdrawn ≤ streamed ≤ deposit`.
- Global: contract token balance ≥ Σ(deposit − withdrawn) over live streams.
- Every payout path is checks-effects-interactions ordered (no reentrancy
  window on token transfers).
- All expected failures return `StreamError` codes; no panics on any input.
