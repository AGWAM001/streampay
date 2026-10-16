## What

Implements opt-in, privacy-preserving, anonymized stream discovery listings for StreamPay on Stellar (Soroban). Stream parties (sender and recipient) can mutually consent using native Ed25519 wallet signatures to publish coarsened stream listings (asset, rate band, duration band) to an off-chain directory with zero address disclosure by default, verifiable against on-chain contract state via HMAC attestation and protected by dynamic $k$-anonymity.

Fixes #[issue_id]
Closes #[issue_id]

---

## Contract impact

- [x] No public API change (signatures / error codes / events)
- [ ] Error codes appended (not renumbered)
- [ ] New behavior covered by tests
- [ ] `docs/ARCHITECTURE.md` updated if a design decision changed

---

## Checklist (CI runs all of these)

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --all-targets -- -D warnings`
- [x] `cargo check -p streampay-contract`
- [x] `cd frontend && npm run typecheck && npm run build` (if frontend touched)
- [x] `cd frontend && npm run lint && npm test`

---

## Architecture & Privacy Design Summary

Full specification and threat model are documented in [docs/discovery-privacy.md](docs/discovery-privacy.md).

### 1. Strict Field Egress Allowlist
The directory service isolates private authorization proofs from public views. Public API responses and browse views only contain allowlisted fields:
- `listingId`: Ephemeral random UUIDv4 (completely unlinked from on-chain `streamId`).
- `asset`: Token contract address (or symbol).
- `rateBucket`: Coarsened logarithmic band (`RATE_MICRO`, `RATE_LOW`, `RATE_MEDIUM`, `RATE_HIGH`, `RATE_WHALE`).
- `durationBucket`: Coarsened duration band (`DUR_FLASH`, `DUR_WEEK`, `DUR_MONTH`, `DUR_QUARTER`, `DUR_LONG`).
- `status`: Coarse state (`Active`, `Completed`).
- `listedDay`: UTC date (`YYYY-MM-DD`). Precision timestamps are purged.
- `anonymitySetSize`: Number of active streams in the same equivalence class.
- `anonymityFlag`: `normal` ($\ge k$) or `low` ($< k$).
- `addressesShared`: `{ sender: boolean, recipient: boolean }`.
- `verificationHash`: HMAC blind attestation proving on-chain verification.

**Fields Never Published**:
- On-chain `streamId`
- Exact deposit / balance / withdrawn stroop amounts
- Exact start/end timestamps or transaction hashes
- Parties' Stellar public keys (`G...`) unless **both** parties explicitly opt into address sharing.
- Signatures and nonces.

### 2. $k$-Anonymity Model
- Equivalence class: $E = (\text{asset}, \text{rateBucket}, \text{durationBucket})$.
- Minimum anonymity threshold $k$ (default $k = 3$, configurable via `DISCOVERY_K_ANONYMITY_THRESHOLD`).
- Equivalence classes with $< k$ streams are suppressed from default browse views. Users can view them only if explicitly requested, with a clear `⚠️ Low Anonymity` indicator.

### 3. Reverse-Lookup Analysis (Adversary Matrix)

| Threat | Adversarial Capability | Chosen Mitigation | Residual Risk |
| :--- | :--- | :--- | :--- |
| **Timing Correlation** | Intersecting $|T_{\text{listing}} - T_{\text{ledger}}|$ | Listing timestamp coarsened to UTC calendar day (`YYYY-MM-DD`); sub-day times dropped | In low-volume network conditions where only one stream occurred that day, day-level correlation may narrow candidates |
| **Exact-Amount Matching** | Joining exact deposit stroops with `StreamCreated` events | Continuous numbers mapped to wide logarithmic rate bands; client-provided values ignored; values recomputed from contract state | None for exact amounts; coarse band is public |
| **Rare Bucket Uniqueness** | Identifying a sole whale or rare token stream | $k$-Anonymity suppression ($k \ge 3$); singleton buckets excluded from default search | If users explicitly opt to view low-anonymity streams |
| **Longitudinal Linking** | Tracking repeated payroll or subscription patterns | Ephemeral random UUIDv4 per listing; zero persistent party pseudonyms | Recurring periodic behavior might be statistically inferred across epochs |
| **Stream ID De-Anonymizer** | Following on-chain verification deep link | `streamId` is never published; verification uses directory-signed HMAC attestation; explorer links appear only on mutual opt-in | Disclosing addresses removes anonymity by mutual party choice |

---

## Signature Scheme & Consent Protocol

All actions require native Stellar Ed25519 signatures over canonical JSON payloads:
- **Domain Separation Tag**: `StreamPayDiscovery:v1`
- **Replay Protection**: Nonce verification and expiration timestamp enforcement
- **Network & Contract Validation**: Signatures must specify the target network passphrase and contract ID

### Lifecycle State Machine:
`PROPOSED` $\to$ `CONSENTED_BY_ONE` $\to$ `CONSENTED_BY_BOTH` $\to$ `PUBLISHED` $\to$ `WITHDRAWN`

- **Dual Consent**: Both `stream.sender` and `stream.recipient` must provide valid Ed25519 signatures before publication.
- **Unilateral Revocation**: Either party can sign a `STREAM_DISCOVERY_WITHDRAW` message at any time to immediately remove the listing permanently.

---

## Directory Service API Endpoints

- `GET /api/listings`: Browse listings with filters (`asset`, `rateBucket`, `durationBucket`, `status`, `includeLowAnonymity`, `page`, `limit`).
- `POST /api/listings`: Ingest dual-consent listing submission with on-chain verification.
- `GET /api/listings/:id`: Fetch single listing with verification attestation.
- `POST /api/listings/:id/withdraw`: Submit signed unilateral withdrawal.
- `GET /api/listings/propose` & `POST /api/listings/propose`: Coordinate proposals between sender and recipient.

---

## Frontend UI Deliverables

1. **Browse Directory (`/listings`)**:
   - Filter bar: asset, rate band, duration band, status, and low-anonymity toggle.
   - $k$-Anonymity badges (`✓ N-Anonymous` or `⚠️ Low Anonymity (N)`).
   - Verification deep-link modal explaining on-chain verification and HMAC proof without exposing addresses.
   - Pagination controls, loading skeletons, empty states, and error handling.
2. **Stream Detail (`/stream/[id]`) & Consent Modal (`DiscoveryConsentModal`)**:
   - Allows stream parties to preview exact allowlisted fields before publication.
   - Separate, off-by-default checkbox for address sharing.
   - One-click signing via Freighter wallet (`signMessage`).
   - Unilateral withdrawal action if the stream is already listed.
3. **App Header & Navigation**:
   - Direct link to `Browse Discovery Directory →` from the home page.

---

## Testing & Verification

- **Crypto & Bucketing Unit Tests** (`frontend/lib/discovery/crypto.test.ts`):
  - Deterministic canonical serialization
  - Valid Ed25519 consent & withdrawal signatures
  - Rejection of expired consent, wrong signers, malformed signatures, and wrong network/contract
  - Rate and duration bucket boundary calculations
  - Dynamic $k$-anonymity set evaluation
- **Service & Privacy Regression Tests** (`frontend/lib/discovery/service.test.ts`):
  - Dual consent ingestion and contract parameter recomputation
  - Privacy assertion: zero address leakage by default
  - Single-party opt-in address suppression (both must opt in)
  - Mutual opt-in address disclosure
  - Rejection of cancelled streams and replayed nonces
  - Unilateral withdrawal by sender and recipient; rejection of unauthorized third parties
  - $k$-Anonymity suppression when count $< k$
- **All 36 Node Tests Pass**: `npm test`
- **Lint & Types Pass**: `npm run lint` (0 errors), `npm run typecheck` (0 errors)
- **Production Build Pass**: `npm run build` (Turbopack, all static & dynamic routes compiled)
- **Contract Compiles**: `cargo check -p streampay-contract`
