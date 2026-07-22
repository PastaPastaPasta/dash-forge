# Dash Platform — Constraints & Research Findings

All findings verified against the local monorepo `../platform` (version **4.0.0-beta.3**, protocol v12 era). File paths below are relative to that repo. These numbers are the load-bearing inputs to every Dash Forge design decision.

## 1. Hard system limits

Source: `packages/rs-platform-version/src/version/system_limits/v1.rs`

| Limit | Value | Impact on Forge |
|---|---|---|
| `max_field_value_size` | **5,120 bytes (5 KiB)** | Any single byteArray/string field caps at 5 KiB. Binary payloads must be split across multiple fields. |
| `max_state_transition_size` | **20,480 bytes (20 KiB)** | Whole signed transition (document + signature + overhead) must fit. Practical payload per document ≈ 15 KiB (3 × 5 KiB data fields). |
| `max_transitions_in_documents_batch` | **1** | *One document operation per state transition.* No atomic multi-document writes. Every git object/chunk write is its own fee-bearing, nonce-incrementing transition. Intentional (platform issue #2867 — batch atomicity/nonce semantics undefined). |
| `estimated_contract_max_serialized_size` | 16,384 bytes | A data contract's serialized schema must stay under ~16 KiB → we split Forge into two contracts (core + collaboration). |
| `max_contract_group_size` | 256 | Upper bound if we ever use platform groups. |

## 2. Schema & index limits

Sources: `packages/rs-dpp/src/data_contract/document_type/mod.rs`, `.../class_methods/try_from_schema/mod.rs`, `packages/rs-dpp/schema/meta_schemas/document/v1/document-meta.json`

| Limit | Value |
|---|---|
| Max properties per document type | 100 (`maxProperties`) |
| Property name | `^[a-zA-Z0-9-_]{1,64}$` |
| `MAX_INDEX_SIZE` (total indexed key bytes) | 255 |
| Indexed string `maxLength` | ≤ 63 |
| Indexed byteArray `maxItems` | ≤ 255 |
| `additionalProperties` | must be `false` |

Consequences: git ref names (which can exceed 63 chars) cannot be indexed as strings → we index a 32-byte hash of the ref name instead. All query patterns must be planned as contract indices up front; mutable contracts can add document types and optional fields but cannot change existing indexed properties.

## 3. Query limits

Source: `packages/rs-drive/src/config.rs`, `packages/rs-drive/src/query/conditions.rs`

- **Max 100 documents per query** (`DEFAULT_MAX_QUERY_LIMIT = 100`); higher limits are rejected. Pagination via `startAt`/`startAfter` cursors + `orderBy` (index-backed only).
- Operators: `==, >, >=, <, <=, Between*, in, startsWith`. Range operators only on the trailing index component.
- Aggregates exist: `count`, `sum`, `average` (evo-sdk documents facade), plus grouped count-trees — yappr migrated counts to these for performance.
- **No document push subscriptions.** `waitForStateTransitionResult` covers only your own writes. Live UI = polling with cursors. (Core-layer gRPC streams exist for L1 blocks/tx only.)

## 4. Fees & storage economics

Sources: `packages/rs-platform-version/src/version/fee/storage/v1.rs`, `packages/rs-dpp/src/fee/default_costs/constants.rs`, `packages/rs-dpp/src/balances/credits.rs`, `packages/rs-dpp/src/fee/epoch/{mod.rs,distribution.rs}`

- 1 DASH = 100,000,000 duffs = **10^11 credits** (`CREDITS_PER_DUFF = 1000`).
- **Storage: 27,000 credits/byte** (`storage_disk_usage_credit_per_byte`) — prepaid "perpetual" storage (50 eras ≈ 50 years), **refundable pro-rata on deletion**.
- Processing: `storage_processing_credit_per_byte = 400`, `PROCESSING_CREDIT_PER_BYTE = 12`, `BASE_ST_PROCESSING_FEE = 10,000`, `WRITE_BASE_PROCESSING_COST = 6,000`, `storage_seek_cost = 2,000`.
- Fee constants are protocol-versioned, identical on testnet and mainnet. Basis: "30 $/DASH" per the source comment.

Rule-of-thumb costs (storage component, refundable):

| Data | Credits | DASH |
|---|---|---|
| 1 KiB | ~28M | ~0.00028 |
| 100 KiB | ~2.8B | ~0.028 |
| 1 MiB | ~28.3B | **~0.283** |
| Typical ref update doc (~300 B) | ~8M | ~0.00008 |

**Conclusion: raw repository content on-platform is a premium option; the default bulk path must be external content-addressed storage with on-platform manifests.** This is exactly the "reduced fees via IPFS/S3/HTTPS/alt git hosts" requirement.

## 5. State transitions & nonces

- All document CRUD flows through the **Batch** transition (`state_transition_types.rs`): document_create / replace / delete / transfer / purchase / update_price (+ token ops).
- Two nonce spaces: **identity nonce** (contract creation etc.) and **identity-contract nonce** (per identity+contract, document ops), DIP-30 masked (`sequence = rawNonce & (2^40 - 1)`).
- The SDK caches and bumps nonces per call (`bump_first=true`). **Concurrent transitions from one identity race on the cached nonce** → serialize writes per identity+contract, or carefully pipeline sequential nonces without awaiting each result (throughput-critical for push; must be validated experimentally — see e2e plan). `refreshIdentityNonce` recovers from desync.
- yappr's proven idempotent-write pattern (`yappr/lib/services/state-transition-service.ts`): build transition → sign → **cache signed ST bytes in localStorage** → broadcast → wait; on timeout, rebroadcast the *same bytes* (same nonce → no double-write); treat "already exists" as success.

## 6. Contract features relevant to Forge

- **Ownership**: every document has `owner_id`; only the owner can replace/delete (per document-type `documentsMutable`/`canBeDeleted`). There is **no per-document ACL** → multi-writer state (refs, PR status) must be modeled append-only with client-side authorization resolution.
- **Anyone can create documents in a contract** unless `creationRestrictionMode` restricts to the contract owner (DPNS model). Forge contracts are open-creation, like DPNS.
- **Document-type settings**: `documentsMutable`, `canBeDeleted`, `documentsKeepHistory`, `transferable`, `transient` fields, `signatureSecurityLevelRequirement`.
- **Contract keywords**: contract-level `keywords`/`description` mirror into the system keyword-search contract — usable for discovery of the Forge contracts themselves, not per-repo search (per-repo search needs our own indices).
- **ContractBounds on identity keys**: an identity key can be scoped to a single contract/document type — enables scoped "deploy keys" (a CI identity key that can only write to Forge contracts).
- **Tokens** (contract-embedded, as yappr's YAPP): available for future spam control or bounties; not in scope for v1.
- Identity keys: purposes (AUTHENTICATION, ENCRYPTION, TRANSFER...), security levels MASTER/CRITICAL/HIGH/MEDIUM. Document writes require AUTHENTICATION at CRITICAL or HIGH.

## 7. SDK & client stack

- **`@dashevo/evo-sdk`** (yappr pins `^4.0.0-rc.2`) — recommended TS facade over `@dashevo/wasm-sdk` (Rust core → WASM). ESM, browser + Node ≥18.18. Factories: `EvoSDK.testnetTrusted()` / `mainnetTrusted()` / `testnet()` (proof-verifying) etc.; `sdk.connect()`.
- Facades: `identities`, `documents` (query/get/create/replace/delete/count/sum + WithProof variants), `contracts` (fetch/publish/update), `stateTransitions` (broadcast/waitForResponse), `dpns`, `tokens`, `group`, `voting`.
- **Client-side proof verification** works in the browser (trusted mode prefetches quorum keys; `wasm-drive-verify` exposes ~75 low-level verifiers incl. `verify_documents_with_query`, `verify_state_transition_was_executed_with_proof`).
- Legacy `js-dash-sdk` ("dash") is deprecated — do not use.
- Static-export WASM gotchas (from `yappr/next.config.js`): COOP/COEP headers (`credentialless`), CSP via `<meta>`, webpack `asyncWebAssembly`, split `@dashevo` chunk.
- Contract publish: `contractPublish({ dataContract, identityKey, signer })`; contract ID derived from owner + identity nonce. Registration cost ≈ contract size × fee schedule (sub-0.01 DASH); one-time.

## 8. yappr patterns to reuse (file paths in `../yappr`)

| Pattern | File |
|---|---|
| SDK singleton init + contract preload + reconnect | `lib/services/evo-sdk-service.ts` |
| Idempotent write / nonce mask / ST-byte cache / retry | `lib/services/state-transition-service.ts` |
| Query encoding rules (identifiers→base58, bytes→base64) | `lib/services/sdk-helpers.ts` |
| Cached document CRUD base class | `lib/services/document-service.ts` |
| Cursor pagination + count-tree helpers | `lib/services/pagination-utils.ts` |
| Error taxonomy (timeout/already-exists/insufficient) | `lib/error-utils.ts` |
| Headless auth engine (key login, password vault, passkey PRF, wallet QR) | `vendor/platform-auth/` + `contexts/auth-context.tsx` |
| Encrypted key storage in browser | `lib/secure-storage.ts` |
| 5 KiB field chunking precedent (blog `data0..data3`) | `lib/constants.ts` (`BLOG_CHUNK_SIZE`) |
| IPFS upload provider abstraction (Storacha, Pinata) | `lib/upload/` |
| Contract-owner admin script template | `scripts/set-yapp-price.mjs` |
| Static export + WASM build config | `next.config.js` |
| Zero-backend architecture rules (no API routes, no dynamic segments) | `CLAUDE.md` |

## 9. Identity & funding infrastructure (for users and e2e tests)

- **bridge.thepasta.org** = `../mainnet-bridge` (static Vite app, GitHub Pages). Non-custodial L1→L2: derives HD keys from mnemonic, funds a deposit address, builds a type-8 asset-lock tx, waits for InstantSend lock, registers the identity via `sdk.identities.create`. Exports `dash-identity-<id>.json` (mnemonic + 5 keys with WIFs: Master/High-Auth/Critical-Auth/Transfer/Encryption).
- **faucet.thepasta.org** = `../platform-identity-faucet` (FastAPI + Dash Core node). **Scriptable HTTP API**: `GET /api/status`, `POST /api/core-faucet {address}` → sends ~1 tDASH. Rate limit 3/hour/IP; optional CAP proof-of-work captcha. Testnet only.
- No turnkey "mint funded identity" endpoint exists; e2e tests either drive the bridge with Playwright or replicate the asset-lock flow in Node using evo-sdk + the bridge's pure TS modules (`src/platform/identity.ts`, `src/transaction/builder.ts`, `src/proof/builder.ts`, `src/crypto/keys.ts`).

## 10. Design consequences (summary)

1. **Chunk everything; ~14–15 KiB usable per document; one write per transition.** Push throughput is bounded by sequential state transitions — pipelined nonces are the key optimization to validate early (INIT.md's "batch ST packing" is unavailable while `max_transitions_in_documents_batch = 1`).
2. **Platform is primary storage and source of truth** (per INIT.md); IPFS/S3/HTTPS are hash-verified fee-reduction/archival backends; refs + manifests always on Platform.
3. **Append-only models for multi-writer state** (refUpdate = ref + reflog): documents are replaceable only by their creator, so maintainer B can never mutate maintainer A's ref doc. Authorization itself is consensus-enforced via token-cost ACLs (`tokenCost` per doc type, freeze = suspend) — yappr proves the pattern.
4. **Design indices first**; 100-doc query pages; poll for liveness (relay bridges to webhooks).
5. **rs-sdk (Rust) for helper/CLI/relay; wasm/evo-sdk for web** — with yappr's write-retry and caching patterns; parity via shared conformance vectors.
6. **Deletion refunds** make on-platform storage economically sane (repack + delete superseded docs → steady-state cost ≈ current repo size; delete repo → recover ~most storage credits).
