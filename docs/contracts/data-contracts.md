# Dash Forge — Data Contract Design

Per INIT.md: one global **registry contract** + **one repo contract per repository** instantiated from a canonical, versioned template. Token-cost ACL supplies consensus-enforced authorization. Constraint-forced deviations from INIT.md are marked (D2 etc. — see [init-reconciliation.md](../init-reconciliation.md)).

Conventions:
- `identifier` = 32-byte byteArray, `contentMediaType: application/x.dash.dpp.identifier`; `oid` = byteArray 20–32; `hash32` = byteArray 32.
- All types: `additionalProperties: false`, require `$createdAt` (`$updatedAt` on mutables).
- Indexed strings ≤ 63 chars; total index key ≤ 255 bytes; 100-doc query pages everywhere. Long names (git refs) index via sha256 hash.
- Query encoding: identifiers → base58; plain byteArrays → base64 (yappr `sdk-helpers.ts` rules).

## 1. Registry contract (deployed once; DCG/DAO-owned identity; open creation)

### `repoListing` — mutable, deletable (owned by repo owner)
| Field | Type | Notes |
|---|---|---|
| `name` / `normalizedName` | string 100 / `^[a-z0-9][a-z0-9._-]{0,62}$` | display / unique key |
| `repoContractId` | identifier | the per-repo contract |
| `templateVersion` | integer | repo-contract template version (migration tracking) |
| `description` | string ≤ 500 | |
| `defaultBranch` | string ≤ 255 | |
| `backend` | object | `{ mode: 0 platform \| 1 ipfs \| 2 s3 \| 3 https \| 4 mixed, uris: array ≤ 4 of string ≤ 300 }` |
| `protectedPatterns` | array ≤ 8 of string ≤ 100 | refs matching require `protectedRefUpdate` |
| `visibility` | integer | 0 public (v1 only value) |
| `topics` | array ≤ 10 of string ≤ 30 | |
| `forkOf` | identifier (optional) | upstream repoListing |

Indices: unique `($ownerId, normalizedName)`; `(normalizedName, $createdAt desc)`; `(forkOf)`.
Client rule: a listing is only believed if the referenced repo contract's owner matches `$ownerId`.

### `profile` — mutable, deletable
`displayName` ≤ 60, `bio` ≤ 500, `avatarConfig` ≤ 200 (dicebear string, yappr pattern), `links` array ≤ 4 of string ≤ 200. Unique `($ownerId)`.

### `star` / `follow` — immutable, deletable
`star`: `listingId` identifier. Unique `($ownerId, listingId)`; `(listingId)` for count-trees; `($ownerId, $createdAt desc)`.
`follow`: `identityId` identifier. Unique `($ownerId, identityId)`; `(identityId)`.

## 2. Repo contract template (v1)

Instantiated per repo by the client at `dg repo create`; owner = repo owner identity (or group-controlled for orgs). `canBeDeleted: true` (repo deletion reclaims refunds). Template JSON lives in `forge-contracts/templates/repo-v1.json`, versioned under the DCG template identity; migration across template versions is a Phase 1 design-review item (INIT.md).

### 2.1 Tokens

| Pos | Token | Purpose | Config |
|---|---|---|---|
| 0 | `WRITE` | push meter + collaborator gate | mintable/freezable/destroy-frozen by owner; control-rule **groups** for multi-admin orgs |
| 1 | `MAINTAIN` | protected refs, releases, labels, webhooks, contract updates | same |

Grant = mint 10⁹ units to collaborator (spend is a meter, not the control); suspend = freeze; revoke = freeze + destroy frozen funds. Balances publicly queryable ⇒ on-chain collaborator list. Open questions: frozen-identity delete-for-refund semantics (Phase 0 S0.7 answers); needs Platform-core review of freeze edge cases (INIT.md risk 2).

### 2.2 Token costs per document type

| Doc type | Cost | Doc type | Cost |
|---|---|---|---|
| `refUpdate`, `chunk`, `packManifest`, `manifestPart`, `checkRun` | 1 WRITE | `protectedRefUpdate`, `release`, `label`, `webhook` | 1 MAINTAIN |
| `issue`, `comment`, `review`, `patch`, `event`* | un-gated (platform fees only) | contract update | MAINTAIN group |

\* `event` docs that *change state* (close/merge) are believed only from identities holding WRITE/MAINTAIN at fold time (client rule — events are cheap and un-gated to let authors close their own issues). D3: INIT.md priced `patch` at 1 WRITE; un-gated here to preserve drive-by PRs — flagged for review.

### 2.3 Git-data document types

**`refUpdate` — immutable (create-only), deletable — merged ref + reflog (D2)**
```jsonc
{ "refNameHash": hash32,          // sha256(refName)
  "refName":  string ≤ 255,
  "newOid":   oid,                // all-zero = delete ref
  "prevOid":  oid?,               // expected previous tip (audit + force detection)
  "force":    boolean }
```
Indices: `(refNameHash, $createdAt desc)` (ref state = newest); `($createdAt desc)` (repo reflog); `($ownerId, $createdAt desc)` (pusher audit).
Existence ⇒ authorized (token-gated at consensus). No on-chain fast-forward enforcement — the reflog *is* the audit trail (explicit INIT.md non-goal). Deletable for pruning after repack; newest per ref retained by convention.

**`protectedRefUpdate`** — identical shape, MAINTAIN-gated. Clients resolving a ref matching `protectedPatterns` consider only this type.

**`packManifest` — immutable, deletable**
```jsonc
{ "packHash": hash32,             // sha256 of packfile
  "sizeBytes": integer, "objectCount": integer,
  "storage":  integer,            // 0 platform-chunks | 1 external
  "chunkCount": integer,          // when platform
  "uris":     array ≤ 8 of string ≤ 300,   // when external (ipfs://CID, https://, s3://)
  "prereqs":  array ≤ 16 of oid,  // thin-pack bases
  "tips":     array ≤ 16 of oid,
  "supersedes": array ≤ 32 of hash32,      // repack replacement
  "offsetIndexParts": integer }   // number of manifestPart docs
```
Indices: unique `(packHash)`; `($createdAt desc)`.

**`manifestPart` — immutable, deletable** — per-object offset index continuation: `packHash`, `partSeq`, `entries` (byteArray ≤ 4900 ×3: packed rows of `oid | byteOffset | length`). Unique `(packHash, partSeq)`. Enables ranged chunk fetch → partial/shallow clone.

**`chunk` — immutable, deletable**
`packHash` hash32, `seq` integer, `d0` byteArray ≤ 4900 (required), `d1`,`d2` byteArray ≤ 4900 (optional) — ~14.4 KiB payload, sized so the full signed ST stays under 20,480 B (validated in S0.2; chunker asserts ≤ 19 KiB serialized).
Unique `(packHash, seq)`.

### 2.4 Collaboration document types

| Type | Mutability | Key fields | Indices |
|---|---|---|---|
| `issue` | author-mutable, deletable (refund) | `number`, `title` ≤ 256, `body` ≤ 5120, `labels` array ≤ 10 of ≤ 30 | unique `(number)`; `($createdAt desc)`; `($ownerId, $createdAt desc)` |
| `comment` | author-mutable (revision history via `$revision`), deletable | `targetId`, `body` ≤ 5120, `replyTo?`, review anchors `commitOid?`, `path` ≤ 500, `line?`, `side?` | `(targetId, $createdAt asc)` |
| `patch` (PR) | author-mutable, deletable | `number`, `title`, `body` ≤ 5120, `baseRefNameHash` + name, `headOid`, `sourceListingId?` (fork), `patchManifestHash?` (pack with PR objects) | unique `(number)`; `($createdAt desc)`; `(sourceListingId)` |
| `review` | immutable, deletable | `patchId`, `verdict` (1 approve/2 request-changes/3 comment), `commitOid`, `body` ≤ 5120 | `(patchId, $createdAt desc)` |
| `event` | immutable, deletable | `targetId`, `kind` (close/reopen/merge/label±/assign±/retarget/draft/ready), `value` ≤ 120, `oid?` (merge commit) | `(targetId, $createdAt asc)` |
| `label` | MAINTAIN; mutable, deletable | `name` ≤ 30, `color` ≤ 7, `description` ≤ 200 | unique `(name)` |
| `release` | MAINTAIN; mutable, deletable | `tagName` ≤ 63, `name` ≤ 120, `notes` ≤ 5120, `assets` array ≤ 10 of `{name, sha256, sizeBytes, uris ≤ 4}` | unique `(tagName)`; `($createdAt desc)` |
| `checkRun` | WRITE (CI identity); mutable by runner, deletable | `headOid`, `name` ≤ 100, `status`, `conclusion`, `detailsUrl` ≤ 300, `summary` ≤ 1000 | `(headOid, $createdAt desc)` |
| `webhook` | MAINTAIN; mutable, deletable | `url` ≤ 300, `events` array ≤ 16 of ≤ 30, `relayIdentityId`, `encryptedSecret` byteArray ≤ 128 | `($createdAt desc)` |

Issue/patch numbering: optimistic `max+1` with unique-index retry. Issue/PR state = event fold (`FORGE_RULES_V1`, shared conformance vectors).

### 2.5 Size budget (D4)

14 doc types + 2 tokens must serialize < 16 KiB (`estimated_contract_max_serialized_size`). S0.6 measures the drafted template; fallback: split per-repo into `repo-core` (git data + tokens) and `repo-collab` contracts — doubles per-repo instantiation cost (< 0.02 DASH total), no other design impact.

## 3. Deployment & template lifecycle

- **Registry**: deployed once per network by the DCG/DAO identity; ID in `forge-contracts/deployments/<network>.json`, baked into forge-core constants.
- **Repo contracts**: client instantiates from `templates/repo-v1.json` at `dg repo create` (contract publish + token config + initial mints + `repoListing` write). Cost < 0.01 DASH.
- **Template versioning**: template registered under DCG identity with version history; `repoListing.templateVersion` tracks each repo; migration strategy (new-version contract updates vs side-by-side) is a Phase 1 design-review deliverable (INIT.md "decide early").
- **Validation gates**: JSON lint + wasm-sdk `fullValidation` construction + serialized-size check in CI before any deploy; devnet → testnet → mainnet rehearsal (e2e plan §6).
