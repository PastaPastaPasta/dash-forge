# Dash Forge — Data Contract Design

Two contracts, both **open-creation** (any identity may create documents, like DPNS), registered once by the Forge deployer identity, IDs baked into forge-core constants (yappr `lib/constants.ts` pattern).

- **forge-core-contract** — storage-critical: `repository`, `collaborator`, `refUpdate`, `pack`, `packChunk`, `packMirror`.
- **forge-collab-contract** — social: `issue`, `pullRequest`, `comment`, `event`, `review`, `star`, `release`.

Split keeps each under the ~16 KiB serialized-contract estimate and lets collab iterate without touching the core. Both contracts: `canBeDeleted: false`, `readonly: false` (backward-compatible updates allowed), keywords `["git","forge","code","repository"]` for keyword-search discovery.

Conventions used below:
- `identifier` = 32-byte byteArray with `contentMediaType: application/x.dash.dpp.identifier`.
- `oid` = byteArray `minItems 20, maxItems 32` (SHA-1 now, SHA-256 ready).
- `hash32` = byteArray exactly 32 (sha256).
- All document types set `additionalProperties: false` and require `$createdAt` (plus `$updatedAt` on mutable types).
- Indexed strings respect the 63-char cap; indexed byteArrays ≤ 255; total index key ≤ 255 bytes. Ref names are indexed via `refNameHash = sha256(refName)` because git ref names exceed 63 chars.

## 1. forge-core-contract

### 1.1 `repository` — mutable, deletable

```jsonc
{
  "type": "object",
  "documentsMutable": true, "canBeDeleted": true,
  "properties": {
    "name":           { "type": "string", "minLength": 1, "maxLength": 100, "position": 0 },
    "normalizedName": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,62}$", "maxLength": 63, "position": 1 },
    "description":    { "type": "string", "maxLength": 500, "position": 2 },
    "defaultBranch":  { "type": "string", "maxLength": 255, "position": 3 },      // e.g. "refs/heads/main"
    "storageMode":    { "type": "integer", "minimum": 0, "maximum": 2, "position": 4 }, // 0=external, 1=platform, 2=hybrid
    "objectFormat":   { "type": "integer", "minimum": 0, "maximum": 1, "position": 5 }, // 0=sha1, 1=sha256
    "forkOf":         { /* identifier */ "position": 6 },                          // optional
    "topics":         { "type": "array", "items": { "type": "string", "maxLength": 30 }, "maxItems": 10, "position": 7 }
  },
  "required": ["name", "normalizedName", "defaultBranch", "storageMode", "objectFormat", "$createdAt", "$updatedAt"],
  "indices": [
    { "name": "ownerName", "properties": [{ "$ownerId": "asc" }, { "normalizedName": "asc" }], "unique": true },
    { "name": "byName",    "properties": [{ "normalizedName": "asc" }, { "$createdAt": "desc" }] },
    { "name": "byForkOf",  "properties": [{ "forkOf": "asc" }] }
  ]
}
```
The document `$id` is the canonical **repoId** referenced everywhere else. `$ownerId` is the repo owner (authorization root).

### 1.2 `collaborator` — mutable, deletable (owned by repo owner)

| Field | Type | Notes |
|---|---|---|
| `repoId` | identifier | |
| `memberId` | identifier | collaborator's identity |
| `role` | integer | 1=TRIAGE (reserved), 2=WRITE, 3=MAINTAIN |
| `active` | boolean | soft revocation (history-preserving) |

Indices: unique `(repoId, memberId)`; `(memberId)` for "repos I collaborate on".
**Client validation rule:** a collaborator doc is valid **only if its `$ownerId` equals the repository's `$ownerId`** — anyone can write into the open contract; forgeries are filtered client-side. This rule applies to every owner-anchored type.

### 1.3 `refUpdate` — immutable, deletable (append-only ref log)

```jsonc
{
  "documentsMutable": false, "canBeDeleted": true,
  "properties": {
    "repoId":      { /* identifier */ },
    "refNameHash": { /* hash32 */ },          // sha256(refName)
    "refName":     { "type": "string", "maxLength": 255 },
    "newOid":      { /* oid */ },             // all-zero = ref deletion
    "prevOid":     { /* oid, optional */ },   // expected previous tip (client CAS / force detection)
    "force":       { "type": "boolean" }      // explicit force-push marker
  },
  "required": ["repoId", "refNameHash", "refName", "newOid", "$createdAt"],
  "indices": [
    { "name": "refState", "properties": [{ "repoId": "asc" }, { "refNameHash": "asc" }, { "$createdAt": "desc" }] },
    { "name": "repoLog",  "properties": [{ "repoId": "asc" }, { "$createdAt": "desc" }] }
  ]
}
```
**Current ref value** = newest `refUpdate` for `(repoId, refNameHash)` authored by the repo owner or an identity with an `active` WRITE+ collaborator doc at that `$createdAt`. This resolution rule is versioned in forge-core with shared test vectors. Deletable so authors can prune their own history after repacks (refunds); the newest update per ref must be retained by convention (clients treat a ref with zero updates as unborn).

### 1.4 `pack` — immutable, deletable (pack manifest; both tiers)

| Field | Type | Notes |
|---|---|---|
| `repoId` | identifier | |
| `packHash` | hash32 | sha256 of pack bytes (the content address) |
| `sizeBytes` | integer | |
| `objectCount` | integer | |
| `chunked` | boolean | true → bytes in `packChunk` docs (Tier P) |
| `chunkCount` | integer | 0 when external |
| `uris` | array ≤ 8 of string ≤ 300 | `ipfs://CID`, `https://…`, `s3://bucket/key`, `gitmirror://<remote>` (Tier X; may be empty for pure Tier P) |
| `tips` | array ≤ 16 of oid | commit tips whose closure this pack (with its predecessors) covers |
| `prereqs` | array ≤ 16 of oid | thin-pack prerequisite bases (objects assumed present) |
| `supersedes` | array ≤ 32 of hash32 | packs made redundant by this repack |

Indices: unique `(repoId, packHash)`; `(repoId, $createdAt desc)`.
Integrity: pack bytes verify against `packHash`; objects inside verify against git OIDs; OIDs chain to signed refs. External hosts are availability-only.

### 1.5 `packChunk` — immutable, deletable (Tier P bytes)

| Field | Type |
|---|---|
| `repoId` | identifier |
| `packHash` | hash32 |
| `chunkIdx` | integer ≥ 0 |
| `d0` | byteArray ≤ 5120 (required) |
| `d1`, `d2` | byteArray ≤ 5120 (optional) |

Index: unique `(repoId, packHash, chunkIdx)`. ~15,360 payload bytes/doc; a document + overhead stays under the 20,480-byte transition cap (validated by construction in forge-core chunker: assert serialized ST ≤ 19 KiB, headroom for signature variance).

### 1.6 `packMirror` — immutable, deletable

Anyone may announce extra URIs for an existing pack (re-seeding): `repoId`, `packHash`, `uris` (≤ 8). Index `(repoId, packHash, $createdAt desc)`. Safe from any author — hash-verified.

## 2. forge-collab-contract

### 2.1 `issue` — mutable(title/body by author), deletable
`repoId`, `number` (integer ≥ 1), `title` ≤ 256, `body` ≤ 5120, `labels` (array ≤ 10 of string ≤ 30).
Indices: unique `(repoId, number)`; `(repoId, $createdAt desc)`; `($ownerId, $createdAt desc)`.
Numbering: writer queries max `number`, writes `number+1`; unique-index conflict → refetch & retry (bounded loop). Body > 5 KiB: continued in `comment` docs flagged `isBodyContinuation` (v1: cap at 5 KiB + one continuation).

### 2.2 `pullRequest` — mutable(title/body by author), deletable
`repoId` (base), `number`, `title` ≤ 256, `body` ≤ 5120, `baseRefName` ≤ 255, `baseRefNameHash` hash32, `sourceRepoId` identifier, `sourceRefName` ≤ 255, `sourceRefNameHash` hash32, `headOid` oid (author-updated as source branch moves; history via `$revision`/keepsHistory not needed — events log pushes).
Indices: unique `(repoId, number)` (shared counter-space with issues is NOT used — PRs number independently); `(repoId, $createdAt desc)`; `(sourceRepoId)`.

### 2.3 `comment` — mutable (author edits), deletable
`repoId`, `targetId` identifier (issue/PR/review doc $id — or repoId itself for commit comments), `body` ≤ 5120, `replyTo` identifier (optional), and optional review anchors: `commitOid` oid, `path` string ≤ 500, `line` integer, `side` integer (0 old/1 new).
Indices: `(targetId, $createdAt asc)`; `(repoId, $createdAt desc)`.

### 2.4 `event` — immutable, deletable (append-only state log)
`repoId`, `targetId`, `kind` integer (1 close, 2 reopen, 3 merge, 4 label+, 5 label−, 6 assign, 7 unassign, 8 retarget, 9 draft, 10 ready), `value` string ≤ 120 (label name, assignee b58, new base), `oid` oid optional (merge commit).
Index: `(targetId, $createdAt asc)`.
Resolution: issue/PR state = fold of events authored by {issue author (close/reopen own), repo owner, active WRITE+ collaborators}. `merge` valid only from owner/collaborators and, for honest clients, only when `oid` is reachable from the base branch.

### 2.5 `review` — immutable, deletable
`repoId`, `prId` identifier, `verdict` integer (1 approve, 2 request-changes, 3 comment), `commitOid` oid, `body` ≤ 5120. Index `(prId, $createdAt desc)`.

### 2.6 `star` — immutable, deletable
`repoId` only. Indices: unique `($ownerId, repoId)`; `(repoId)` (count via count-tree); `($ownerId, $createdAt desc)`.

### 2.7 `release` — mutable (owner/collab), deletable
`repoId`, `tagName` ≤ 63, `name` ≤ 120, `notes` ≤ 5120, `assets`: array ≤ 10 of object `{ name ≤ 100, sha256 hash32, sizeBytes, uris: array ≤ 4 of string ≤ 300 }`.
Indices: unique `(repoId, tagName)`; `(repoId, $createdAt desc)`.

## 3. Cross-cutting rules

1. **Owner-anchoring:** documents that confer authority (`collaborator`) or represent maintainer actions are only *believed* when `$ownerId` matches the authorization rules; the contract cannot enforce this — forge-core's `authz` module is the single implementation, with a versioned rule spec (`AUTHZ_RULES_V1`) and test vectors shared by CLI and web.
2. **Timestamps** are consensus block times (`$createdAt`); clients never trust user-supplied clocks.
3. **Query encoding** (yappr `sdk-helpers.ts` rules): identifier fields → base58 strings in where clauses; plain byteArrays (`refNameHash`, `packHash`) → base64 operands.
4. **Pagination:** every list view uses index-backed `orderBy` + `startAfter` cursors; 100-doc pages.
5. **Contract evolution:** additive-only (new doc types, new optional fields). Breaking changes → new contract version deployed alongside, dual-read/single-write migration in clients (yappr's `-v2/-v3` precedent).

## 4. Deployment

- Deployer identity (Forge maintainers') publishes both contracts via `sdk.contracts.publish` — scripted in `forge-contracts/scripts/deploy.mjs` (template: `yappr/scripts/set-yappr-price.mjs` flow: load identity JSON → connect testnetTrusted → publish → verify by fetch).
- Registered IDs recorded in `forge-contracts/deployments/{testnet,mainnet}.json` and consumed by forge-core `constants.ts`.
- Contract JSON source of truth: `forge-contracts/contracts/forge-core.json`, `forge-collab.json` with JSON-schema lint + a validation test that runs `DataContract` construction with `fullValidation: true` in wasm-sdk before any deploy.
- Fee estimate at 27,000 credits/byte on ~10 KiB serialized each: < 0.01 DASH per contract, one-time.
