# Dash Forge — Data Contract Design (v3)

One global **registry contract** + **one repo contract per repository** from a versioned template (INIT.md). This revision adds: explicit count-tree assignments per user story, delete-gating via `tokenCost.delete`, a `config` document type that makes protected refs enforceable, non-deletable audit types (closing the ref-rewind hole), and an enforcement matrix stating exactly what consensus enforces vs what `FORGE_RULES_V1` client rules enforce.

## 0. Platform mechanics this design is built on (verified in `../platform`)

| Mechanic | Fact | Source |
|---|---|---|
| Mutation ownership | replace/delete only by the document's creator, ever. Multi-writer state ⇒ append-only + resolution rules | dpp document rules |
| Token gating | `tokenCost` per doc type on **create, replace, delete, transfer, update_price, purchase**; payer = the acting identity; frozen identity cannot spend ⇒ gated action fails at consensus | `document-meta.json:576` |
| Count trees | per-index `countable: "countable"` → CountTree, O(1) provable totals per index prefix; `rangeCountable` for O(log n) range counts; doc-type-level `documentsCountable` / `documentsSummable("<prop>")` on the primary tree | `document-meta.json:431-554`, `index/mod.rs:286-377` |
| Aggregates in SDK | `documents.count / sum / average` (+ WithProof), `group_by` split counts | `wasm-sdk queries/document.rs` |
| Arrays | string arrays fine as **non-indexed** props (DPNS/keyword-search precedent); array-membership indexing not usable → never design a query on an array field | system contracts |
| Discovery | contract-level `keywords` (≤ 50, unique) auto-mirror into the system keyword-search contract | `data_contract.rs:64-67` |
| Edit history | `documentsKeepHistory: true` per doc type → all revisions queryable (`getDocumentHistory`) | contract config |
| Timestamps | `$createdAt`/`$updatedAt` are consensus block times — the only clock `FORGE_RULES` may use | dpp |

Conventions: `identifier` = 32-byte identifier byteArray; `oid` = byteArray 20–32; `hash32` = byteArray 32; indexed strings ≤ 63 chars (long names indexed via sha256); ≤ 100 docs/query, cursor pagination always.

## 1. Registry contract (deployed once; DCG/DAO identity; open creation)

Discovery and social graph **only** — all operational repo state lives in the repo contract (so MAINTAIN collaborators, not just the listing owner, can change it).

### `repoListing` — mutable (owner), deletable
| Field | Type | Notes |
|---|---|---|
| `name` / `normalizedName` | string ≤ 100 / `^[a-z0-9][a-z0-9._-]{0,62}$` | rename = **replace** (doc `$id` stable ⇒ stars/forks/links by id survive; name-URLs break — documented) |
| `repoContractId` | identifier | |
| `templateVersion` | integer | migration tracking |
| `description` | string ≤ 500 | |
| `topics` | array ≤ 10 of string ≤ 30 | **display only** (search runs through repo-contract `keywords`) |
| `forkOf` | identifier (optional) | upstream listing `$id` |

Indices:
- unique `($ownerId, normalizedName)` — resolution; **countable** → "N repositories" on profiles, O(1).
- `(normalizedName)` — `startsWith` name search.
- `(forkOf)` with `nullSearchable: false` — fork enumeration; **countable** → fork count, O(1).

### `profile` — mutable, deletable
`displayName` ≤ 60, `bio` ≤ 500, `avatarConfig` ≤ 200, `links` array ≤ 4 of ≤ 200. Unique `($ownerId)`. (DPNS supplies names; this is presentation.)

### `star` — immutable, deletable (unstar = delete)
`listingId` identifier. Indices: unique `($ownerId, listingId)`; `(listingId, $createdAt desc)` **countable** → star count O(1) + "who starred" list; `($ownerId, $createdAt desc)` → "my stars".

### `follow` — immutable, deletable
`identityId` identifier. Indices: unique `($ownerId, identityId)`; `(identityId, $createdAt desc)` **countable** → follower count; `($ownerId, $createdAt desc)` **countable** → following count.

Client validity rules (registry): a listing is believed only if the repo contract's owner == listing `$ownerId`; among multiple listings naming the same contract, the repo-owner's newest is canonical.

## 2. Repo contract template (v1)

Owner = repo owner identity. Contract-level: `keywords` = topics (≤ 50 → keyword-search discovery), `description` mirror. Creation flow (one-time, by owner): publish contract → **self-mint 10⁹ WRITE + 10⁹ MAINTAIN** (owner must hold tokens like anyone else) → `config` #1 → `repoListing`.

### 2.1 Tokens

| Pos | Token | Grants | Suspend | Revoke |
|---|---|---|---|---|
| 0 `WRITE` | push, upload, CI | mint 10⁹ | freeze | freeze + destroy frozen |
| 1 `MAINTAIN` | protected refs, releases, labels, webhooks, config, contract updates | mint 10⁹ | freeze | freeze + destroy frozen |

Control-rule **groups** hold mint/freeze/destroy admin for org repos. Balances queryable ⇒ on-chain collaborator list. **Delete-gating** (new): destructive actions on availability-critical docs also cost tokens, so a *frozen* identity cannot delete what it previously uploaded — revocation now consensus-protects both future writes *and* past availability.

### 2.2 Document types — full matrix

Legend: create/replace/delete gates are `tokenCost` (consensus); "—" = platform-fee only. KeepHist = `documentsKeepHistory`.

| Type | Create | Replace | Delete | KeepHist | Countable | Purpose |
|---|---|---|---|---|---|---|
| `config` | MAINTAIN | ✗ (append-only) | ✗ **non-deletable** | — | — | operational settings, as-of history |
| `refUpdate` | WRITE | ✗ | ✗ **non-deletable** | — | — | ref state + reflog |
| `protectedRefUpdate` | MAINTAIN | ✗ | ✗ **non-deletable** | — | — | protected-ref state |
| `packManifest` | WRITE | ✗ | WRITE | — | doc-type → pack count | pack metadata |
| `manifestPart` | WRITE | ✗ | WRITE | — | — | offset-index overflow |
| `chunk` | WRITE | ✗ | WRITE | — | index → presence audit | on-platform pack bytes |
| `issue` | — | author | author (refund) | ✓ | doc-type → total issues | |
| `patch` | — (D3) | author | author | ✓ | doc-type → total PRs | |
| `comment` | — | author | author | ✓ | index → per-target counts | |
| `event` | — | ✗ | ✗ **non-deletable** | — | — | state/label/assign audit log |
| `review` | — | ✗ | author | — | — | PR verdicts |
| `label` | MAINTAIN | ✗ | MAINTAIN (creator) | — | — | label definitions |
| `release` | MAINTAIN | creator | MAINTAIN (creator) | — | doc-type → release count | |
| `checkRun` | WRITE | creator (status progression) | WRITE (creator) | — | — | CI results |
| `webhook` | MAINTAIN | creator | MAINTAIN (creator) | — | — | relay subscriptions |

Why the non-deletables: a deletable `refUpdate` lets whoever authored the current tip delete it and **silently rewind the branch** (no new signed doc, nothing to audit); same attack reopens closed issues via `event` deletion, and a deleted old `config` breaks as-of protection evaluation. These docs are ~200–400 bytes (~0.00008 DASH, ~50-year horizon) — audit permanence is worth more than the refund. Refunds stay where the money is: `chunk`/`packManifest` (repack/GC), gated so only *unfrozen* WRITE holders can reclaim.

### 2.3 Field schemas

**`config`** — `defaultBranch` string ≤ 255; `protectedPatterns` array ≤ 8 of string ≤ 100 (git-fnmatch globs, e.g. `refs/heads/main`, `refs/heads/release/*`; exact syntax pinned in `FORGE_RULES_V1`); `backend` object `{ mode: 0 platform|1 ipfs|2 s3|3 https|4 mixed, uris: array ≤ 4 of ≤ 300 }` (writer-side default; readers always follow manifest URIs). Index `($createdAt desc)`. **Current config = newest; historical configs resolve protection as-of any past update** (§4).

**`refUpdate` / `protectedRefUpdate`** — `refNameHash` hash32 = sha256(`refName`); `refName` string ≤ 255; `newOid` oid (all-zero = ref deletion); `prevOid` oid optional; `force` boolean. Indices: `(refNameHash, $createdAt desc)` ref state; `($createdAt desc)` reflog/activity; `($ownerId, $createdAt desc)` pusher audit.
Branch/tag enumeration (no distinct-values query on Platform): **skip-scan** — query `refNameHash > <last>` orderBy `refNameHash` limit 100 to discover names, then batch tip lookups (`in` on ≤ 100 hashes, first-row-per-hash, individual fallback for hyperactive refs). Spec'd in `FORGE_RULES_V1`; fine for real-world ref counts.

**`packManifest`** — `packHash` hash32; `sizeBytes`, `objectCount`, `chunkCount` integers; `storage` 0 platform / 1 external; `uris` array ≤ 8 of ≤ 300; `prereqs` ≤ 16 oid; `tips` ≤ 16 oid; `supersedes` ≤ 32 hash32; `offsetIndexParts` integer. Indices: unique `(packHash)`; `($createdAt desc)`.

**`manifestPart`** — `packHash`, `partSeq`, `entries` byteArray ≤ 4900 ×3 (packed `oid|offset|length` rows). Unique `(packHash, partSeq)`.

**`chunk`** — `packHash`, `seq`, `d0..d2` byteArray ≤ 4900. Unique `(packHash, seq)` **countable** → `count(packHash=H) == manifest.chunkCount` is an O(1) provable availability audit (`dg storage status`, pre-clone health check).

**`issue`** — `number` ≥ 1 (optimistic max+1, unique-index retry), `title` ≤ 256, `body` ≤ 5120, optional `imported` object `{ author ≤ 120, createdAt integer, url ≤ 300 }` (importer provenance, since `$createdAt` is consensus time). No labels field — labels are event-derived (a maintainer can't edit an author-owned doc). Indices: unique `(number)`; `($createdAt desc)`; `($ownerId, $createdAt desc)`.

**`patch`** — `number`, `title`, `body` ≤ 5120, `baseRefNameHash` + `baseRefName`, `sourceListingId` identifier, `sourceContractId` identifier (direct, survives listing deletion), `sourceRefName(Hash)`, `headOid` oid, `patchManifestHash` hash32 optional — **a manifest in the source (fork) contract**; PR object bytes live in the contributor's own contract where they hold WRITE by ownership, never in the base repo. Optional `imported`. Indices: unique `(number)`; `($createdAt desc)`; `(sourceListingId)`. (Issues and PRs number independently — unlike GitHub's shared space; documented.)

**`comment`** — `targetId` identifier, `body` ≤ 5120, `replyTo?`, anchors `commitOid?`, `path` ≤ 500, `line?`, `side?`; optional `imported`. Index `(targetId, $createdAt asc)` **countable** → "💬 N" per issue/PR row, O(1).

**`event`** — `targetId`, `kind` integer (1 close, 2 reopen, 3 merge, 4 label+, 5 label−, 6 assign, 7 unassign, 8 retarget, 9 draft, 10 ready), `value` ≤ 120, `oid?` (merge commit). Indices: `(targetId, $createdAt asc)`; `($createdAt desc)` repo activity feed.

**`review`** — `patchId`, `verdict` 1/2/3, `commitOid`, `body` ≤ 5120, optional `imported`. Index `(patchId, $createdAt desc)`.

**`label`** `name` ≤ 30 unique, `color` ≤ 7, `description` ≤ 200 · **`release`** `tagName` ≤ 63 unique, `name` ≤ 120, `notes` ≤ 5120, `assets` array ≤ 10 of `{name, sha256, sizeBytes, uris ≤ 4}` · **`checkRun`** `headOid`, `name` ≤ 100, `status`, `conclusion`, `detailsUrl` ≤ 300, `summary` ≤ 1000, index `(headOid, $createdAt desc)` · **`webhook`** `url` ≤ 300, `events` array ≤ 16 of ≤ 30, `relayIdentityId`, `encryptedSecret` byteArray ≤ 128.

## 3. Count-tree assignments — user story ⇄ mechanism

Count trees cost per-index storage overhead; they are assigned **only** where a UI surface needs an O(1) number, and never where the number can't be an indexed fact.

| UI surface | Mechanism | Cost |
|---|---|---|
| ⭐ star count (repo header, discovery cards) | countable `star(listingId)` | O(1) |
| follower / following (profile) | countable `follow(identityId)` / `follow($ownerId)` | O(1) |
| "N repositories" (profile) | countable `repoListing($ownerId, …)` | O(1) |
| fork count | countable `repoListing(forkOf)` | O(1) |
| "Issues (N)" / "PRs (N)" tab totals | `documentsCountable` on `issue` / `patch` | O(1) |
| comment count per issue/PR row | countable `comment(targetId)` | O(1) |
| pack/release totals (`dg storage status`, releases page) | `documentsCountable` on `packManifest` / `release` | O(1) |
| chunk availability audit | countable `chunk(packHash, seq)` vs `manifest.chunkCount` | O(1) |
| **open vs closed issue/PR counts** | **not natively countable — by design, not omission**: state is a fold of `event` docs (mutation ownership forbids an authoritative indexed `state` field on the author-owned doc). Strategy: list pages fold events per page (one `in` query on ≤ 100 targetIds); results cached in IndexedDB keyed by newest-event cursor; tabs render "Issues (N)" instantly and "open/closed" splits hydrate. Optional v1.1: MAINTAIN-posted `stateSummary` cache doc, explicitly non-authoritative, always corrected by fold. | fold |
| branch/tag counts | skip-scan enumeration (cached); no count tree (distinct-count ≠ doc-count) | O(refs) |

Not countable (no story pays for the overhead): `refUpdate`, `event`, `manifestPart`, `checkRun`, `label`, `webhook`, `profile`. Flag validity for the unique+countable combinations is a named S0.6 check.

## 4. Enforcement matrix & FORGE_RULES_V1

Three enforcement tiers — every interaction below names its tier. **Consensus** = the network rejects the transition. **Rules** = deterministic client-side resolution all conforming clients share (versioned + conformance vectors). **UX** = convention only.

| Interaction | Consensus enforces | Rules enforce | Notes |
|---|---|---|---|
| Push (refUpdate/chunk/manifest) | WRITE token spend; schema; uniqueness | newest-per-ref resolution; prevOid force detection | existence ⇒ was authorized |
| Protected push | MAINTAIN spend on `protectedRefUpdate` | **protection routing** (below) | a WRITE-holder *can* write a plain refUpdate naming a protected ref; consensus can't read patterns — rules make it inert |
| Branch rewind via doc deletion | **impossible** — refUpdate non-deletable | — | closes the tip-deletion hole |
| Collaborator revoke | freeze blocks all gated creates **and gated deletes** (chunks/manifests/releases stay available) | pre-revocation docs remain valid (consensus timestamps) | |
| Ref/issue/PR reads | proofs (Merkle) | — | |
| Issue/PR state | — | event fold; valid actors: target author (close/reopen own), WRITE/MAINTAIN holders (all kinds), `merge` requires MAINTAIN-or-WRITE **and** `oid` reachable from base ref | spam events from strangers exist but are inert (they paid fees) |
| Merge integrity | — | Rules + git: merge event's `oid` must be an ancestor-reachable commit on base | no on-chain merge validation (INIT.md non-goal) |
| Listing authenticity | — | listing.$ownerId == repo-contract owner | |
| checkRun trust | WRITE spend | display runner identity; UI marks which identity attested | CI is as trustworthy as the identity you minted to |
| Fork PR objects | fork-contract ownership | patch → sourceContractId manifests; OIDs chain to base refs after merge | |
| Counts | provable via count-tree proofs | — | |

**Protected-ref resolution (normative):**
```
state(R) = newest valid update u for refNameHash(R), ordered by ($createdAt, $id)
valid(u):
  cfg = newest config with cfg.$createdAt <= u.$createdAt   # as-of update time
        (tie at equal $createdAt: config applies — conservative)
  if R matches any cfg.protectedPatterns → u must be protectedRefUpdate
  else → u may be either type (MAINTAIN holders may use protectedRefUpdate anywhere)
```
Consequences: protecting a branch does not retroactively invalidate its history (old plain updates stay valid as-of their time); after protection, only MAINTAIN-gated updates move the ref; un-protecting re-admits plain updates from the lifting config's time forward. Deterministic because `config` is append-only and non-deletable.

## 5. Interaction walkthroughs (ST sequences)

1. **Create repo** — publish repo contract (identity nonce) → self-mint WRITE+MAINTAIN → `config` #1 (defaultBranch, backend) → registry `repoListing`. 4 transitions, < 0.02 DASH.
2. **Push** — chunks (pipelined) → `packManifest` (+ parts) → `refUpdate`(s). Resume via journal; every doc's existence is consensus-proof of authorization.
3. **Protect main** — MAINTAIN posts `config` #2 adding `refs/heads/main`; effective for all later updates.
4. **Grant / suspend / revoke** — mint / freeze / freeze+destroy; no doc changes needed anywhere else; balances are the ACL.
5. **Fork + PR** — fork: new contract + own listing (`forkOf`), refs copied as own refUpdates, packs shared by CID where external else re-uploaded. PR: contributor pushes branch to fork, creates `patch` in **base** (un-gated) pointing at fork contract + headOid (+ patchManifestHash in fork). Reviewers fetch from fork; merge: maintainer merges locally, pushes merge commit to base (WRITE/MAINTAIN), posts `merge` event with merge-commit oid.
6. **Repack** — build consolidated pack → upload → new manifest w/ `supersedes` → delete own superseded chunks/manifests (WRITE-gated deletes; storage refund). Frozen ex-collaborators' stale packs: any WRITE holder re-uploads missing bytes if an ex-collaborator's docs were pruned pre-freeze; chunk-count audit detects gaps.
7. **Rename repo** — replace listing (same `$id`); stars/fork links intact; name-URLs break (no redirects — documented limitation).
8. **Delete repo** — delete owned chunks/manifests/listing (refunds); non-deletable audit docs remain in the abandoned contract (tiny, harmless); contract itself deletable if platform permits empty-contract deletion — else parked.
9. **Import** — bulk creates with `imported` provenance fields; numbering assigned sequentially by importer; cost gate + resume per PRD 06.

## 6. Size budget & validation (D4)

15 doc types + 2 tokens in one template vs the 16 KiB serialized estimate — S0.6 measures the drafted JSON; the prepared fallback is a 2-contract split per repo (`repo-core`: config/refs/packs/tokens; `repo-collab`: issues/PRs/social), which changes nothing else in this design. S0.6 also validates: countable-flag acceptance on unique indices, tokenCost-on-delete behavior, keepsHistory + replace interaction, and `fullValidation` construction of both contracts.

## 7. Deployment & template lifecycle

Unchanged from v2: registry deployed once per network (DCG/DAO identity), IDs in `deployments/<network>.json`; repo contracts client-instantiated from `templates/repo-v1.json`; template versioned under the DCG identity; migration strategy is the Phase 1 design-review deliverable. CI gates: schema lint, wasm-sdk `fullValidation`, size check, additive-only compat check, devnet → testnet → mainnet rehearsal.
