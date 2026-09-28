# Dash Forge v2 contracts (protocol 14)

Two shared data contracts, **forge-core** and **forge-collab**, registered once per network and joined by a PV14 contract group. Every repository is a set of documents in these two contracts, keyed by the `repo` document's id (`repoId`). This is the only data model Dash Forge implements.

- Schemas: `forge-contracts/contracts/forge-core.json`, `forge-contracts/contracts/forge-collab.json`
- Offline validation: `tools/contract-validate` (rs-dpp `v4.2.0-beta.5`, `PlatformVersion` 14)
- Registration: `forge-contracts/scripts/deploy-v2.mjs` (evo-sdk `4.2.0-beta.5`)
- Decision record: roadmap D-A (owner decision of 2026-09-24, reviewed by a protocol architect)

## 1. Why shared contracts

Contract registration is priced per contract (a base fee plus a fee per document type, per index and per token). A design where each repository is its own contract therefore pays that fee for every repository and every fork, whatever its size. That was forge-v1: a global registry contract plus one contract per repository, with access control by WRITE/MAINTAIN tokens, at about 1.18 DASH a repository. It was removed on 2026-09-26 with no backwards compatibility; [data-contracts.md](data-contracts.md) keeps its design for the record.

Protocol 14 can express per-repository access control inside a shared contract:

- **`ownerRefersTo`**: a document type can require its writer (`$ownerId`) to be found through a unique index of another document type. Consensus checks this on create, and on every replace when the target is a `deletableDocument`.
- **`lookup`** references resolve a key such as `(repoId, memberId)` through a unique index, so a membership document is enough; the writer does not have to name it.
- **`propertyAgreement` with `$ownerId`** makes "only the owner of the referenced document may write this" a consensus rule.
- **Contract groups** give the pair a provable "these contracts belong together" record.

The per-repo "sovereign" tier is dropped. Anyone who wants different rules can register their own copy of these schemas (the deploy script works for any identity). Clients treat a copy as a different forge.

## 2. Types and who can write them

"Gate" means the consensus `ownerRefersTo` check on create. M = the writer has a `maintainer` document for the repo. W = the writer has a `writer` document for the repo. Replace and delete are always limited to the document's owner (Platform rule), and documents cannot be transferred.

### forge-core

| Type | Gate (create) | Mutable | Deletable | Notes |
|---|---|---|---|---|
| `repo` | anyone | yes; `name`, `visibility`, `forkOf` immutable | **no** (target of `permanentDocument` refs) | unique `($ownerId, name)`, rangeCountable (repos per owner); `name` is the immutable URL slug `^[a-z0-9][a-z0-9._-]{0,62}$`; `displayName` (≤ 400 bytes) and `description` are editable; `forkOf` → permanent `repo` |
| `maintainer` | repo owner only (`repoId` → repo with `{"$ownerId":"$ownerId"}`) | no | yes (= revoke) | unique `(repoId, memberId)`; `memberId` → existing identity; index `memberId` |
| `writer` | repo owner only | no | yes (= revoke) | same shape as `maintainer` |
| `refUpdate` | M or W | no | **no** | `(repoId, refNameHash, $createdAt)` ref state, `(repoId, $createdAt)` reflog, `(repoId, $ownerId, $createdAt)` pusher |
| `protectedRefUpdate` | M | no | **no** | same indexes |
| `config` | M | no | **no** | append-only, newest wins; `protectedPatterns` and `backend.uris` are typed string arrays now |
| `packManifest` | M or W | no | **no** | unique `(repoId, $ownerId, packHash)`; `(repoId, packHash)` lookup; `(repoId, $createdAt)` rangeCountable (pack count); `(repoId, kind, $createdAt)` |
| `manifestPart` | M or W | no | **no** | unique `(repoId, $ownerId, packHash, partSeq)` |
| `chunk` | M or W | no | **no** | unique `(repoId, $ownerId, packHash, seq)`, rangeCountable (availability audit per uploader) |
| `release` | **M** | no | yes | newest per `(repoId, tagName)` wins; maintainer-only because a release names artifacts users install |
| `label` | M or W | no | yes | newest per `(repoId, name)` wins |
| `repoKey` | M | no | **no** | unique `(repoId, memberId, epoch, $ownerId)`; private repos, §5 |

### forge-collab

References into forge-core carry `contractId`. The schema file holds the placeholder `FORGE_CORE_CONTRACT_ID`, and the deploy script replaces it with forge-core's id before registering.

| Type | Gate (create) | Mutable | Deletable | Notes |
|---|---|---|---|---|
| `issue` | anyone (fees are the spam floor) | yes (title, body), history kept; `repoId`, `number` immutable; `$updatedAt` required | **no** | unique `(repoId, number)` rangeCountable; unique `($ownerId, repoId, number)` (the author lookup `authorEvent` uses); `repoId` → permanent `repo` |
| `patch` (PR) | anyone | yes (title, body), history kept; `repoId`, `number`, `sourceRepoId`, the four ref-name fields, `headOid` (the *initial* head; later heads are `headUpdate` events) and `draft` immutable; `$updatedAt` required | **no** | as `issue`, plus `sourceRepoId` → permanent `repo` (the fork holding the PR's objects), index `sourceRef (sourceRepoId, sourceRefNameHash)` ("the PRs from this branch"; `sourceRepoId ==` alone also uses it); optional `draft` (opened as a draft) |
| `comment` | anyone | yes (body); `repoId`, `targetId` and the anchor (`replyTo`, `commitOid`, `path`, `line`, `side`, `startLine`, `reviewId`) immutable; `$updatedAt` required | yes | `targetId` → permanent `issue` or `patch` of the same repo (`propertyAgreement` on `repoId`); `(targetId, $createdAt)` rangeCountable; `reply (replyTo)` ("replies to my comment"; `nullSearchable: false`, so only replies are in it); `startLine` (first line of a range); `reviewId` → deletable `review` with `propertyAgreement {repoId: repoId, targetId: patchId, $ownerId: $ownerId}`, so only the reviewer can attach comments to their review, and only on its PR (consensus) |
| `review` | anyone | no | yes | `patchId` → permanent `patch` of the same repo; `(patchId, $createdAt)` rangeCountable (review count per PR); `commentCount` (how many `reviewId` comments the submit writes); clients count approvals only from M/W holders (§6) |
| `event` | M or W | no | **no** | every kind 1–18 (§3); `refId` (a thread root, a reviewer, a review) with index `addressee (refId)` (`nullSearchable: false`: only events that carry a `refId` are in it); optional `enc`/`epoch` (`dependentRequired`): a private repo's event seals its `value` there (private-repos.md §4.3) |
| `authorEvent` | **the author of the target issue or PR** | no | **no** | `kind ∈ {1, 2, 9, 10, 11, 12, 13, 14, 16}`, enforced by the schema (`enum`); `refId`, `oid`; indexes `(targetId, $createdAt)`, repo feed `(repoId, $createdAt)` and `addressee (refId)` (sparse, as on `event`); §3 |
| `checkRun` | M or W | yes (status progression); `repoId`, `headOid`, `name` immutable | yes | a replace re-checks the gate, so a revoked runner cannot advance its runs |
| `policy` | **M** | no | **no** | a branch policy: `requiredApprovals` 0–10, `approverRole` (0 any member, 1 maintainers), `requireChecks`, `mergeMethods` bitmask (1 fast-forward, 2 merge commit, 4 squash, 8 rebase; 0 any); newest by `($createdAt, $id)` wins; non-deletable so a revoked maintainer cannot revert it by deleting it; a client rule in the merge box, never consensus |
| `webhook` | M | yes (`url`, `events`, `secret`, `disabled`); `repoId`, `hookId` immutable | yes | the creating maintainer toggles `disabled` or edits in place; a replace re-checks the gate, so a revoked maintainer cannot re-enable a hook. Another maintainer supersedes it with a newer doc for the same `hookId` (newest wins) or asks the creator to delete. `secret` is `encryptedFor` the relay identity's encryption key (§5) |
| `profile` | anyone | yes | yes | one per identity |
| `star` | anyone | no | yes (unstar) | `indexOnly`: `(repoId)` countable = star count; `($ownerId)` with terminal `repoId` = my stars; one star per (repo, identity) is structural |
| `follow` | anyone | no | yes (unfollow) | `indexOnly`: follower and following counts are both countable; `identityId` → existing identity, `distinctFrom: $ownerId` |

Shared shapes (`id`, `oid`, `h32`, `refName`, `body`, `enc`, …) are in `schemaDefs` and referenced with `$ref`. A document type may use each `$defs` entry **once**: rs-dpp's depth walker treats a second `$ref` to the same definition in one type as a cycle (`InvalidJsonSchemaRefError`). The same goes for the `integer` shape of a key id named by `encryptedFor` or `keyIdProperty`, which must be inline (the parser's `is_key_id_schema` resolves `$ref` against the document schema, which has no `$defs`). Repeats are inlined for these reasons.

## 3. Events, and what "authorization survives revocation" means

Issue and PR state changes are two document types, one per kind of authority, so a reader always knows which gate admitted a document:

- **`event`** (every kind, table below) is gated by `ownerRefersTo anyOf` with two operands:
  1. a `maintainer` for `repoId` (deletable lookup `byRepoMember` into forge-core),
  2. a `writer` for `repoId`.
- **`authorEvent`** (the author's kinds, table below) is gated by `ownerRefersTo anyOf` with two operands:
  1. the author of the target issue: the lookup `author($ownerId = writer, repoId, number = targetNumber)` on `issue`, with `propertyAgreement {"targetId": "$id"}`, so the issue found must be the one the document targets,
  2. the same for `patch`.

  Its `kind` is an integer with `enum [1, 2, 9, 10, 11, 12, 13, 14, 16]` (close, reopen, draft, ready, thread resolve and unresolve, review request and remove, head update), so an author's merge, label, assign, retarget, review dismissal or milestone is refused outright. The document fails the node's document schema validation, and the SDK runs the same validation and refuses to broadcast. It carries `refId` and `oid`, never `value`.

For both types, `targetId` must be an `issue` or `patch` whose `repoId` and `number` equal the document's `repoId` and `targetNumber`. Membership of repo A cannot authorize an event on repo B's issue, and the author of issue #3 cannot act on issue #4. Both are indexed `(targetId, $createdAt)` (a target's history) and `(repoId, $createdAt)` (the repo's activity feed, which reads both types).

`authorEvent`'s operands are `permanentDocument` lookups, so `issue` and `patch` must be non-deletable (registration rejects a permanent lookup into a deletable type with 40122). That is why issues and PRs can no longer be deleted for a refund.

**Why two types.** The first registration gated a single `event` type by all four operands. A reader then could not tell which operand admitted a given event: a maintainer who also authored the PR, and was later revoked, left merges that might have been admitted by the author path, where merge is not allowed. The split removes the question. Protocol 14 freezes `ownerRefersTo` on update (removing an `anyOf` operand is an incompatible schema change; `tools/contract-validate --previous` reports it), so the split shipped as a new forge-collab registration (§8), not an update.

Both types are immutable and non-deletable, and the gate is judged at creation. **A document's existence therefore proves its writer was authorized at its block time**: an `event` proves the writer held a `maintainer` or `writer` document for the repo then, and an `authorEvent` proves the writer was the target's author. Revoking a maintainer later does not invalidate their past events, and nothing has to be reconstructed from membership history.

**Kinds.** `kind` is a `u8` on both types (integer widths are fixed at registration). Payload fields: `value` (≤ 120 chars, plaintext), `oid`, `refId` (an identifier).

| # | kind | payload | from `event` (any M/W at write time) | from `authorEvent` |
|---|---|---|---|---|
| 1, 2 | close, reopen | — | yes | yes |
| 3 | merge | `oid` merge commit | yes, if `oid` is reachable from the base tip | never (schema) |
| 4, 5 | label+, label− | `value` label | yes | never (schema) |
| 6, 7 | assign, unassign | `value` identity | yes | never (schema) |
| 8 | retarget | `value` base ref | yes | never (schema) |
| 9, 10 | draft, ready | — | yes | yes |
| 11, 12 | threadResolve, threadUnresolve | `refId` thread root comment | yes | yes |
| 13, 14 | reviewRequest, reviewRequestRemove | `refId` reviewer identity | yes | yes |
| 15 | reviewDismiss | `refId` review, `value` reason | yes | never (schema) |
| 16 | headUpdate | `oid` new head | yes | yes |
| 17, 18 | milestoneSet, milestoneClear | `value` milestone | yes | never (schema) |

**Kind rules (`FORGE_RULES_V2`, `forge-core::rules::v2` and `rules::review`, `forge-web/lib/rules/v2` and `review`).** An `authorEvent` applies when its kind is an author kind (`is_author_kind`) and its writer is the target's author. `fold_pr_state_v2` applies kinds 1–10 to the PR state (seeded with the patch's `draft`); `fold_pr_review_v2` folds kinds 11–18 into the review state (head, requested reviewers, resolved threads, dismissed reviews, milestone). An `authorEvent` of a kind outside the author set cannot exist on chain; the folds treat one handed to them as inert anyway, and ignore one whose writer is not `target_author`. Events of both types are merged into one log and ordered by `($createdAt, $id)`, with `$id` compared by Unicode code point (UTF-8 byte order; JavaScript's `<` compares UTF-16 code units and disagrees on astral characters, so the TypeScript port uses `compareStrings`). Documents with the same key keep their input order, `event`s first. A merged PR cannot be reopened.

**Known design choices.** The author may reopen what a member closed, and a member can close it again; nothing stops the two alternating except fees. A member's approval counts on their own PR (§6), because a `review` does not know the PR's author; clients may show a self-approval distinctly.

## 4. Non-deletable audit types

Protocol 14 checks references on create and replace only; **a delete is never reference-checked**. Any owner can delete their own document of a deletable type, even after their membership is revoked. The types whose deletion would rewrite history are therefore non-deletable:

- `refUpdate`, `protectedRefUpdate`: otherwise the author of a tip could delete it and silently rewind the branch;
- `config`: as-of protection evaluation needs every historical config;
- `packManifest`, `manifestPart`: otherwise a revoked writer could delete the index of packs other people's refs point into;
- `event`, `authorEvent`, `issue`, `patch`, `repo`: see §3, and `repo` is the target of every `permanentDocument` reference;
- `chunk`: the pack bytes themselves (owner decision 2026-09-25: an unbreakable repo outweighs the refund);
- `repoKey`: past epochs must stay readable to past members.

**Platform-tier storage is permanent.** A chunk once written stays, so bring-your-own storage (S3-compatible, IPFS) is the cheap default and Platform chunks are the tier you pick for packs that must outlive every bucket. Consequences:

- **Repack on the Platform tier only consolidates.** It writes a superseding pack (a new `packManifest` with `supersedes`, new chunks) and deletes nothing. Readers prefer the consolidated pack; the old one stays readable.
- **`dg repack` deletes nothing on Platform**: deleting superseded chunks and manifests would be refused at consensus. GC applies only to external storage the user controls.

**Front-running.** Every pack-write unique index includes `$ownerId` (`packManifest (repoId, $ownerId, packHash)`, `manifestPart (…, partSeq)`, `chunk (…, seq)`). Without it, the first writer to claim a `(repoId, packHash)` would own that slot forever: a hostile writer could post a manifest with the right hash and wrong content, or one chunk, and block the honest upload. With it, each writer has its own slot. **Reader rule** (`FORGE_RULES_V2`: `order_pack_copies`, `select_pack_copy`, `pack_read_order`, vectors `pack_copies__*`): for a `packHash`, gather every writer's manifest (`(repoId, packHash)` index) and try them in order: uploaders who are currently maintainers, then current writers, then everyone else (members since revoked), each group by `$createdAt` then `$id`. Read the first copy whose reassembled bytes verify against `packHash`; a copy that fails verification is ignored, and a pack with no verifying copy is unreadable. A `supersedes` list is honoured only from the copy actually read, and only when it verifies. A superseded pack is read after the others as a fallback, never dropped: a hash proves a pack's bytes, not that it holds everything it claims to replace.

**The pack list** (`FORGE_RULES_V2`: `v2_pack_list`, vectors `v2_pack_list__*`). A locator's `packRef` indexes "the repo's pack list", which must be derived identically by every reader and writer. With several copies per pack it is:

1. Take every `packManifest` of the repo (all kinds). An older locator bounds the set **as of** its own `($createdAt, $id)`, inclusive.
2. Group the copies by `packHash`. Rank each group like the reader rule (maintainers, writers, everyone else; then `($createdAt, $id)`), drop copies whose bytes failed verification, and call the first remaining copy the **representative**. A hash with no remaining copy is not in the list. The pack's `kind` and metadata (`sizeBytes`, `objectCount`, `chunkCount`, `supersedes`) are the representative's; copies claiming another `kind` are dropped, so a stranger's copy cannot re-label a pack.
3. A pack's position is its **first upload**: the earliest `($createdAt, $id)` among all copies of the hash, failed and other-kind ones included. A later or higher-ranked copy never moves a pack.
4. `packRef` is the pack's index, by first upload, **among the packs of its kind**: kind-0 git packs are numbered 0..n regardless of interleaved kind-1 index fragments.
5. A pack is superseded when another listed pack's representative names it in `supersedes` **and that representative verified**; an unchecked claim supersedes nothing. Superseded packs keep their `packRef` (positions never shift); readers skip them only when fetching whole packs, and read them as a fallback.

The function is kind-agnostic: callers pass every copy and select a kind from its output (the locator space is the kind-0 packs). Superseded packs keep their place in the packRef space. Manifests are permanent, and a position that never moves means no locator ever needs renumbering.

**Chunks referenced across repositories (forks).** A `platform://` locator names whose chunks it reads: `platform://<core>/<repoId>/<uploader>/<packHash>`. A fork records its parent's Platform-stored packs without re-uploading them: its `packManifest` has `storage = 1`, `chunkCount = 0`, and in `uris` the parent's chunk locators (`<repoId>` = the parent), members' copies first, followed by any external URIs the parent's copies record. A reader of such a manifest reads the chunks from the named repo's scope, within the same forge-core contract only, and accepts only bytes that hash to the manifest's `packHash`; a locator naming another pack hash or another contract is ignored. `chunk` and `packManifest` are non-deletable, so the parent cannot pull the bytes out from under the fork. (Rust: `repo::fetch_artifact_from`, `fork.rs`; the web reader must follow these locators the same way, or a fork of a Platform-stored repository does not browse.)

`release`, `label`, `webhook`, `checkRun`, `comment`, `review`, `star`, `follow` and `profile` stay deletable. Their resolution is newest-wins or per-author, so a deletion removes only the deleter's own contribution. Residual risk: a revoked maintainer can delete a release they published. Readers fall back to the next-newest release for that tag.

The contracts are **not readonly**, so the owner identity can still update them, within the protocol 14 update rules: indexes, `refersTo`/`ownerRefersTo`, `immutable` and `encryptedFor` are all frozen on update, so an update can add optional properties and new document types but cannot loosen an existing gate. **Readonly cannot be switched on later**: a config update to `readonly: true` is refused (`validate_update` v0, "contract can not be changed to readonly"). To make the final mainnet contracts readonly, set `config.readonly` in the JSON when registering them (§8).

## 5. Private repositories

A private repo is a `repo` with `visibility: "private"`; `visibility` is immutable. Consensus cannot hide data, so the key model is client-side, and the contract carries its envelope:

- **Content key per epoch.** A maintainer draws a 32-byte key for epoch 0 and wraps it for every member (the owner included) in a `repoKey` document `{repoId, memberId, epoch, recipientKeyId, senderKeyId, wrapped}`.
  - `wrapped` is `encryptedFor {recipient: memberId, recipientKey: recipientKeyId, senderKey: senderKeyId, scheme: ecdh-secp256k1-aes256-cbc}`. Consensus checks its shape: at least 32 bytes and a multiple of 16.
  - `memberId` carries `refersTo identityPublicKey` with `keyIdProperty: recipientKeyId` and `keyRequirements {purpose: encryption}`, and `senderKeyId` carries the owner form (`identityProperty: $ownerId`, purpose encryption). Consensus refuses a wrap to a key that does not exist, is disabled, or is not an encryption key.
  - Unique `(repoId, memberId, epoch, $ownerId)`; gated to maintainers; immutable and non-deletable. `$ownerId` is in the key so one maintainer cannot claim a member's slot for an epoch before another.
  - **Reader rule** (`docs/security/private-repos.md` §5.4, which is normative and wins over this summary). A member accepts a wrapped key for `(repo, epoch)` only if its writer is a **current** maintainer (a removed maintainer's wraps and configs are withdrawn with their membership), the epoch exists (it has an anchor: the first config for it, by `($createdAtBlockHeight, $id)`, written by a current maintainer), the unwrapped plaintext `0x01 ‖ KCV_e ‖ K_e` has a matching 14-byte key-check value (error detection only), and `COMMIT_e` derived from the key equals the commitment the anchor's `enc` v0x02 carries. A key that fails the last check raises a `KeyMismatch` alert naming the wrap's author; the reader never looks for another config the key opens. Older epochs are reached only through the anchors' `prevEpochKey` chain.
  - Consensus cannot also require `memberId` to be a member: an `identityPublicKey` reference cannot be combined with other operands. Wrapping the key to a non-member amounts to leaking it, which a maintainer can always do anyway.
- **Rotation.** On removing a member, a maintainer posts epoch `n+1` wraps for the remaining members (self first), then the anchor `config` for `n+1` (carrying `prevEpoch = n` and `K_n`), and writes under `n+1` only after a proof-verified read shows its anchor is first. Future content uses the new key. Past content stays readable to past members, and the product says so plainly. Content written under a superseded epoch more than 240 blocks after the next anchor by a non-member is hidden (the late-content rule).
- **Encrypted fields.** `issue`, `patch`, `comment` and `review` take `enc` plus `epoch`, and leave the plaintext `title`/`body` (and an inline comment's `path`) empty. `refUpdate`, `protectedRefUpdate` and `config` take the same `enc`/`epoch` pair. `enc` is `0x01 ‖ nonce ‖ AES-256-GCM(K_doc,e, TLV plaintext, AD) ‖ tag` under an HKDF-SHA256 subkey of the epoch key, with the associated data binding the repo, `$ownerId`, the epoch, the type and the document's plaintext identity; `config` always uses the key-committing `0x02 ‖ COMMIT_e ‖ …` layout. Layouts, TLV tags and AD are in `docs/security/private-repos.md` §4.
  - A private ref update puts `refName` inside `enc` and sets `refNameHash = HMAC-SHA256(K_ref,e, refName)` under the epoch's ref subkey, so ref names cannot be recovered by dictionary and differ across epochs. `refName` is optional for this reason. A reader recomputes the hash from the decrypted name and treats a mismatch as malformed.
  - `dependentRequired {enc: [epoch]}` makes consensus refuse ciphertext without an epoch.
  - **"Plaintext or `enc`, not both, not neither" is a client rule** (`is_well_formed`, vectors `well_formed__*`). `propertyConstraints` compare integer expressions only and cannot test whether a string is present, and the meta-schema admits no `oneOf`/`not` at the document-type level. Each kind has plaintext fields and at most one required one: `issue` (`title` required, `body`), `patch` (`title` required, `body`, `baseRefName`, `sourceRefName`), `comment` (`body` required), `review` (`body`, optional: a review's content is its verdict and `commitOid`, which are never encrypted), a ref update (`refName` required), `config` (`defaultBranch`, `protectedPatterns`, neither required). In a **public** repo a document is well-formed when it has no `enc` and has its required field, if its kind has one. In a **private** repo it is well-formed when it has a non-empty `enc`, an `epoch`, and none of its plaintext fields, so a private repo's `refUpdate` carrying a plaintext `refName` is malformed. An empty string, or an empty `protectedPatterns` list, counts as absent. Clients skip a malformed document, and every other rule (approvals included) only sees well-formed ones.
  - **Ref names must hash to their keys** (part of `is_well_formed`; `ref_name_hashes_agree`, vectors `well_formed__*ref_hash*`, `ref_name_hashes__*`). A public `patch` whose `baseRefName` is present is well-formed only if `baseRefNameHash` is present and equals `sha256(baseRefName)`, and likewise `sourceRefName` / `sourceRefNameHash`; a public ref update likewise needs `sha256(refName) == refNameHash`. A hash with no name has nothing to check. Readers find a base's history and a ref's updates by the hash, and git and a merge act on the name; a document whose two disagree would be read as one branch and acted on as another. In a private repo the names are inside `enc`, and the same check runs after decryption with `HMAC-SHA256(K_ref,e, name)` (`docs/security/private-repos.md` §4.5). No other type carries a name/hash pair (`release.tagName` and `label.name` have no indexed hash).
  - Packs are encrypted before upload (Platform chunks or external storage): a 36-byte header and 16 KiB AES-256-GCM STREAM segments under a per-file key, so a browser decrypts any byte range. `packHash` is the sealed bytes' hash. Oids, sizes and timing stay visible.
  - `$createdAtBlockHeight` is required on `config`, `repoKey`, `refUpdate`, `protectedRefUpdate`, `packManifest`, `issue`, `patch`, `comment` and `review` (private-repos.md §13), and `$updatedAt` / `$updatedAtBlockHeight` on the three editable content types `issue`, `patch` and `comment` (a replace sets them only when required): anchors are ordered and late content is judged by the network-set height, never the client-set `$createdAt`. forge-core's `enc` holds up to 1536 bytes (a config anchor carries up to 8 patterns, the default branch and the previous epoch's key).
- **What a stranger can still do.** Issues and PRs are un-gated, so anyone can post plaintext into a private repo's namespace. Clients show only documents that decrypt under a key the reader holds, or that come from a member.

The AEAD layouts, key derivation, anchors, rotation and conformance vectors are specified in `docs/security/private-repos.md` (reviewed; normative where it differs from this section). The cryptographic core is `forge-core::private` and `forge-web/lib/private`, held in byte-for-byte parity by the `private_*` vectors.

## 6. What consensus enforces and what stays a client rule

| Concern | Enforced by |
|---|---|
| Push authorization | consensus: `ownerRefersTo` M or W |
| Protected refs | consensus: M gate on `protectedRefUpdate`. **Routing is a rule**: consensus cannot read `protectedPatterns`, so a plain `refUpdate` naming a protected ref can exist, and it is inert by the as-of config rule — for ref resolution and for merge verification alike (`merge_base_tips`: the base history a merge is checked against holds only valid updates, so a plain update cannot put a PR head "on" a protected branch; vectors `merge_base_tips__*`, `fold_pr*__merge_via_*`) |
| Revocation | delete the `maintainer`/`writer` document; the next write is refused (40120) |
| Event actor authorization | consensus at create time (§3): `event` is M/W only, `authorEvent` is the target's author with kind close/reopen only. **Merge reachability is a rule**: `merge` needs `oid` reachable from the base tip, and the base must have been a branch when the PR was opened (`pr_base_tips`, vectors `pr_base_tips__*`, `fold_pr_v2__merge_into_base_*`): a base with no valid tip at the patch's `$createdAt` (never pushed, or deleted then) has no tips, so a merge into a branch created later never counts. The fold reads the base the patch was opened against (`baseRefName`, at its `$createdAt`), so a retarget does not change it. This applies to merge events already on chain: a PR that read as merged because its merge created its base now reads open. **Readers check membership, never ancestry** (D-602, vectors `fold_pr_v2__merge_naming_a_later_base_tip_counts`, `fold_pr_v2__merge_naming_a_non_tip_ancestor_inert`, `fold_pr_v2__merge_after_close_repairs_an_imported_pr`): "reachable from the base tip" is proved by `oid` having been a valid tip of the base, so a merge commit that is an ancestor of a tip without ever being one does not count. A commit-graph walk per PR in a list would need pack reads for every row. So a writer that knows ancestry names a tip: `dg pr merge` names the commit it pushed to the base, and `forge-import` (whose source's merge commit is rarely a tip the mirror pushed) names the newest base tip it pushed that contains the merge commit (`git merge-base --is-ancestor` in its local mirror, after that run's push). When no mirrored tip contains it (the base is not mirrored, or was deleted), the importer records a close instead. It never writes a close after a counted merge, and a PR a previous import recorded closed takes the merge event on a later run (only a merged PR is final; the importer's incremental state is versioned, so the first run after an upgrade revisits every item). The base history is re-read for up to ~20 s when the chain does not show the tip this run pushed yet, so a node's read-after-write lag does not record a fresh merge as a close. Clients refuse to open a PR against a base that is not a branch, and `dg pr merge` and the browser merge refuse to push to a base that does not exist (it would create it) |
| Repository listing | the `repo` document is the listing; its `$ownerId` is the owner |
| Owner lock-out prevention | client rule: the owner self-enrols as maintainer in the same session that creates the repo |
| Concurrent-push divergence, newest-wins resolution, ref-name glob matching, overlay | client rules (the base rules, shared by every client). Ref resolution (`resolve_ref`, vectors `resolve_ref__*`) folds a ref's valid updates in consensus-clock order (`$createdAt`, required on both ref update types); only inside one block does the `prevOid` chain order them (an update naming another's tip comes after it), then `$id`, a chain cycle inside one block being broken at the smallest-`$id` update that waits on nothing outside its own cycle (every update it builds on builds back on it). A `prevOid` names a commit, not a document, and a ref can hold the same commit twice (`A → B → force A`), so a chain match against a newer update is no causal link; the fold only lets a later update supersede an earlier one, and a ref whose newest update names a commit is never unborn |
| Issue and PR numbering | client rule, see below |
| PR approvals | client rule (`count_approvals`, vectors `approvals__*`): `review` is un-gated. Its input is the PR's reviews filtered by `is_well_formed` (§5) first. A review counts only if it is on the PR's current head (the folded head: the newest `headUpdate`, else `patch.headOid`) and its reviewer had a current `maintainer`/`writer` document created at or before the review's `$createdAt`. Each reviewer's newest counting approve (1) or request-changes (2) review by `($createdAt, $id)` stands; comment (3), unknown verdicts and dismissed reviews (`reviewDismiss`) neither count nor clear. A revoked reviewer's document is gone, so their reviews stop counting. A member's approval of their own PR counts (§3, known design choices) |
| Review comments belong to their review | consensus: `comment.reviewId`'s `propertyAgreement` (`$ownerId`, `repoId`, `targetId` = `patchId`). Readers also filter by owner (`group_review_comments`) |
| Branch policy (required approvals, approver role, checks, merge methods) | client rule in the merge box (`meets_policy`). The `policy` document is maintainer-gated at consensus, but nothing at consensus requires approvals, and a maintainer can override |
| Open / closed counts | client rule: open is a fold over `event` + `authorEvent`, not a stored field, so no count index can hold it (§6.1) |

### 6.1 Counts

A provable `COUNT(*)` needs a `countable` or `rangeCountable` index whose properties the query's `==`/`in` clauses cover exactly (Platform book, `drive/document-count-trees.md`, "Choosing What to Set"), or cover all but the last property of a `rangeCountable` index. The second form is in rs-drive v4.2.0-beta.4 (`DriveDocumentCountQuery::find_countable_index_for_where_clauses`, "prefix-to-last", and `point_lookup_count_path_query`) but not yet in the book, which still describes exact coverage only; the live test (`forge-web/lib/repo/v2.live.test.ts`) exercises it. What the contracts count:

| Count | Query | Index |
|---|---|---|
| Issues / PRs ever opened in a repo (open and closed) | `repoId ==` | `issue.number` / `patch.number` `(repoId, number)` rangeCountable |
| Comments on an issue or PR | `targetId ==` (or `in` for a list page: one entry per target) | `comment.target (targetId, $createdAt)` rangeCountable |
| Reviews on a PR | `patchId ==` / `in` | `review.patch (patchId, $createdAt)` rangeCountable |
| Stars, followers | `repoId ==`, `identityId ==` | `star.byRepo`, `follow.byTarget` countable |

A composite query (`documents.composite`, Platform 4.2) can prove a page of PRs plus a `counts` sub-query per type (bound from `$id` to `targetId` / `patchId`) under one merged proof. The count sub-query uses the same index picker, so these indexes serve it.

**Open and closed counts are folded, because they are not stored.** An issue's or PR's state is the fold of its `event` and `authorEvent` documents (§3). Who may close, reopen or merge is decided per document at consensus, and a merge counts only if its commit is on the base branch, a rule no index evaluates. A count tree counts documents by their stored index values, so an open count would need a stored state field. That field could only live on the `issue`/`patch` document, which only its author can replace, while members close and merge. A separate summary document would be a second, unverified copy of the fold that any member could write wrongly. Neither is sound, so readers fold. The web's tab counts fold the cached list pages, and show no number while a list is incomplete (forge-web `listIssuesCached` / `listPullsCached`).

**Requested reviewers** are also a fold (the newest request or remove per identity), so nothing counts them. `event.addressee (refId)` / `authorEvent.addressee` find the requests addressed to one identity (readers sort by `$createdAt`).

**Numbering** (client rule, `allocate_number`, vectors `allocate_number__*`). Numbers are unique per repo at consensus, but anyone can claim any number, so allocation must tolerate gaps and hostile claims. A max+1 rule breaks as soon as someone posts #4294967295. The rule:

1. `n` = the provable count of the repo's issues (rangeCountable `number` index).
2. `ceiling` = `min(2 × n + 100, 2³² − 1)`.
3. `base` = the largest taken number ≤ `ceiling` (a range query on the `number` index, descending from `ceiling`, limit 1), or 0 if there is none.
4. Claim the first number greater than `base` that is not taken. Every number in `(base, ceiling]` is free by the choice of `base`, so below the ceiling this is `base + 1`. Only when `base` equals `ceiling` can squatters sit directly above it, and the probe steps over them: an ascending query from `base + 1`, **paged to the end of the contiguous run** (the first gap). Stopping after one page hands the allocator a run cut short, and it would pick a number that is already taken.
5. If every number from `base + 1` to 2³² − 1 is taken, there is nothing to allocate.

Gaps below `base` are never filled. A number above the ceiling cannot be reached until the repo grows to about half that many issues, so a squatter at 2³²−1 (or anywhere far ahead) is ignored. A squatter at exactly the ceiling is counted, and allocation continues above it. Squatting the number the allocator is about to take costs the squatter a document fee and the allocator one retry: consensus refuses the duplicate, and the next attempt sees it as `base`. Issues and PRs number independently.

**Repository names** (`is_valid_repo_name`, `normalize_repo_name`, vectors `repo_name__*`). A name is valid when it matches the contract's pattern `^[a-z0-9][a-z0-9._-]{0,62}$` in full; a trailing newline does not match. Clients lowercase ASCII `A`–`Z` in user input before checking, and change nothing else, so `Dash-Forge` names `dash-forge`. Other characters are not folded: `é`, or the Kelvin sign that Unicode lowercases to `k`, leaves the name invalid.

**Conformance.** `FORGE_RULES_V2` is `forge-core::rules::v2` (Rust) and `forge-web/lib/rules/v2.ts` (TypeScript). The shared vectors in `forge-contracts/vectors/` are dispatched on their `rules` field: a vector without one tests a base rule (ref resolution, protected-pattern matching, display ref name, overlay, verdict mapping), which `FORGE_RULES_V2` builds on, and `"rules": "v2"` tests one of the rules below:

| Rule | Functions | Vectors |
|---|---|---|
| Issue/PR fold over `event` + `authorEvent` (§3) | `fold_issue_state_v2`, `fold_pr_state_v2` | `fold_issue_v2__*`, `fold_pr_v2__*` |
| A PR's base history (§6 merge reachability) | `merge_base_tips`, `pr_base_tips` | `merge_base_tips__*`, `pr_base_tips__*` |
| Membership | `RoleOracle::{role_at, member_at, current_role}` | through `approvals__*` |
| Numbering | `allocate_number`, `number_ceiling` | `allocate_number__*` |
| Pack reader rule (§4) | `order_pack_copies`, `select_pack_copy`, `pack_read_order` | `pack_copies__*` |
| Pack list / `packRef` space (§4) | `v2_pack_list` | `v2_pack_list__*` |
| Approvals (dismissed reviews skipped) | `count_approvals` | `approvals__*` |
| Review state: folded head, requested reviewers, resolved threads, dismissals, milestone | `fold_pr_review_v2` | `fold_review_v2__*` |
| Branch policy | `meets_policy` | `policy__*` |
| Inline anchors: file-level, line, range | `anchor_of` | `anchor__*` |
| A review's comments | `group_review_comments` | `review_group__*` |
| Suggestion blocks | `parse_suggestions`, `apply_suggestion` | `suggestion__*` |
| Linked issues, `fixes #n` | `linked_issues` | `linked_issues__*` |
| Plaintext xor `enc` (§5) | `is_well_formed` | `well_formed__*` |
| Repository names | `is_valid_repo_name`, `normalize_repo_name` | `repo_name__*` |
| Private content: key derivation, ref-name hashes, `enc` seal/open with the ref-name hash check and the late-content rule (private-repos.md §2–§4, §8) | `EpochKeys::derive`, `ref_name_hash`, `open_content`, `is_late` | `private_kdf__*`, `private_ref_hash__*`, `private_doc_seal__*`, `private_doc_open__*`, `private_hedge__*` |
| Sealed artifacts (§3) | `pack::{seal, open, open_streaming}`, `PackHeader::{sealed_range, open_range}` | `private_pack_seal__*`, `private_pack_open__*`, `private_pack_range__*` |
| Wraps (§5.1) | `wrap::{plaintext, parse, check_against_anchor}`, `platform::wrap::{seal_wrap, open_wrap}` | `private_wrap_seal__*`, `private_wrap_open__*` |
| Anchors, current epoch, chain walk, alerts, repair check (§5.3–§5.6) | `resolve_epochs` (`select_anchors`, `current_epoch`, `chain_walk`, `repair_check`) | `private_epoch__*` |

The v2 fold takes no membership input: an `event`'s existence is its authorization. `RoleOracle` answers "was X a member at time t" from the repo's *current* `maintainer`/`writer` documents, so a revoked member (whose document was deleted) is not a member at any time, and a re-added member counts from their new document. The repoKey reader rule of §5 is `resolve_epochs`, a pure function over flattened rows with `private_epoch__*` vectors; `comment.path` is a content field of `is_well_formed` (vector `well_formed__private_comment_plaintext_path`).

## 7. Measured size and cost

From `tools/contract-validate` (rs-dpp v4.2.0-beta.5, `PlatformVersion` 14; the same sizes as under beta.4). The signed-shape transitions carry a 65-byte recoverable signature and the contract group fields. The deploy script's dry run built the same transitions with the evo-sdk wasm, signed them, and got the same byte counts.

| | forge-core | forge-collab |
|---|---|---|
| Document types / indexes | 12 / 26 | 12 / 27 |
| Serialized contract | 11,876 B | 14,181 B |
| Signed `DataContractCreate` v1 | **12,039 B** | **14,287 B** |
| vs `max_state_transition_size` (20,480 B, the hard limit) | 58.8% | 69.8% |
| Registration fee (fee schedule v3: 0.1 base + 0.02/type + 0.01/index) | **0.60 DASH** | **0.61 DASH** |

`estimated_contract_max_serialized_size` (16,384 B) is not a limit. It is the size Drive's fee *estimation* assumes when it prices reading a stored contract (`apply_contract_with_serialization` v0). Both contracts are under it anyway.

Total one-time registration fees are **1.21 DASH**, paid once by the deployer, plus storage. A new repository is three documents (`repo`, the owner's `maintainer`, the first `config`), about 0.001 DASH in storage by the 27,000 credits/byte rate. `dg repo create` quotes an upper bound of 0.002 DASH before signing and reports the measured cost afterwards.

**Measured on devnet moutai**, as the deployer's balance change. The current contracts are the forge-core of 2026-09-26 (the private-repository changes of `docs/security/private-repos.md` §13) and the forge-collab of 2026-09-27 (the review-parity revision, `docs/design/review-parity-spec.md` §3):

| | forge-core | forge-collab |
|---|---|---|
| Total cost | 0.605726 DASH (60,572,562,220 credits) | 0.616306 DASH (61,630,588,260 credits) |
| of which the registration fee | 0.60 | 0.61 |
| storage + processing | 0.0057 | 0.0063 |

Together that is **1.222032 DASH**. The superseded registrations (§8) cost: the two review-parity iterations of 2026-09-27 0.616286 DASH (61,628,633,380 credits, nonce 8) and 0.616288 DASH (61,628,799,160 credits, nonce 9); the 2026-09-26 forge-collab 0.555554 DASH (55,555,374,110 credits); the 2026-09-25 pair 0.605711 DASH (60,571,079,360 credits) + 0.555523 DASH (55,552,297,710 credits); the first two forge-collab attempts 0.515157 DASH (51,515,695,120 credits, the four-operand `event`) and 0.545473 DASH (54,547,323,690 credits, the split without the feed index).

## 8. Deploying

```sh
(cd forge-contracts/sdk-v2 && npm ci)
node forge-contracts/scripts/deploy-v2.mjs --self-test
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --dry-run
# re-register forge-collab alone (new id) against the recorded forge-core and group:
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --only collab --force-new [--dry-run]
# re-register both (new forge-core, new group, new forge-collab) after a forge-core change the
# update rules refuse:
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --force-new [--dry-run]
# would an in-place DataContractUpdate from the registered schema be accepted instead?
git show <commit it was registered from>:forge-contracts/contracts/forge-collab.json > /tmp/registered-forge-collab.json
cargo +1.98.1 run -q --locked --manifest-path tools/contract-validate/Cargo.toml -- \
     forge-contracts/contracts/forge-core.json forge-contracts/contracts/forge-collab.json \
     --previous /tmp/registered-forge-collab.json
```

- forge-core's create transition registers the contract group (`dash-forge`) and enrols forge-core as a whole contract.
- forge-collab's transition enrols it in the same group. The group id is `hash_double("contract_group" ‖ owner ‖ nonce)` of forge-core's transition.
- Results go to the `v2` section of `deployments/<network>.json` (`devnet-<name>.json` for a devnet). Each step's nonce (masked to its low 40 bits, as rs-dpp does), contract id, group id derived from that same nonce, and pre-broadcast balance are written before broadcasting. A rerun that finds the contract on chain completes the record (status, cost, owner) rather than skipping it; one whose reserved nonce never landed takes the chain's next nonce and re-derives both ids from it. It never registers a second copy unless told to. Each record also carries `schemaHash`, the sha256 of the schema JSON (after placeholder substitution, compactly re-serialized) it was registered from; a rerun that finds a recorded contract whose hash differs from the current schema warns and leaves it as is. A dry run's forge-core step is not checked against a leftover record.
- `--force-new` without `--only` supersedes the pair when the recorded forge-core was registered from a different schema: forge-core's record moves to `v2.forgeCoreSuperseded`, the group to `v2.contractGroupSuperseded`, forge-collab (whose schema names forge-core's id) to `v2.forgeCollabSuperseded`, and a new forge-core (registering a new group) and forge-collab are registered. A rerun after success registers nothing.
- `--only collab` registers forge-collab alone, against the forge-core and group already recorded and found on chain; it never registers forge-core. With `--force-new` it registers a new forge-collab when the recorded one is registered from a different schema (its `schemaHash` differs, or it predates the field): the old record moves to `v2.forgeCollabSuperseded`, and the new one takes the next nonce and so a new id. A recorded contract from the current schema, or one still `broadcasting` (an interrupted run, which is completed or retried instead), is never superseded, so rerunning the same command registers nothing. This is how a schema change the update rules refuse ships. Documents written under the old contract stay under its id.
- The script refuses a CRITICAL key that is missing, different from the identity file, or disabled on chain.
- **Registered on devnet moutai** (protocol 14, drive 4.2.0-beta.5) by the moutai DEPLOYER `7mRv16E77y5dPzhNhBBhUMqFNMoBNTNsBeEYCAtpLnTu`. moutai's Platform chain was wiped and restarted on drive 4.2.0-beta.5 on 2026-09-27, taking every contract, identity, name and document with it. The pair was then registered fresh from the same schemas as before the reset: the private-repository changes of `docs/security/private-repos.md` §13 and the review-parity forge-collab (`docs/design/review-parity-spec.md` §3, §3.9). The ids are recorded in `deployments/devnet-moutai.json`, and the script checked on chain that the group exists, that the deployer owns it, and that both contracts are enrolled. The read fixtures were re-seeded under the new ids (`forge-contracts/scripts/seed-v2-fixture.mjs`, `seed-issues-paging.mjs`):
  - forge-core `6DJ3px1ZDGpx9kvLEMDuLdLtHo4WYirWzyJ2GVWegGux` (nonce 1), 12,039 B signed, 0.605738 DASH
  - forge-collab `6BbENuf3uZhkntw9DSsxQcTu9a5fATxQoSe6Ph1JxHkS` (nonce 2), 14,287 B signed, 0.616292 DASH
  - contract group `FtHLFE1xLqn7s6FzS56GbY6Hh6KgLjCezNJ8HLUNJ3mc` (`dash-forge`)
  - the key-exchange copy for wallet sign-in (`deploy-key-exchange.mjs`) `CErHv5FHjnXJ1Zv6TNmtWirzELYbz8H7rinvn4UtQFZQ` (nonce 3)
  - Before the reset, the pair went through several registrations on the old chain. Each one was needed because the update rules refuse the schema change: adding a `required` system field, an index, or an `enum`, or removing `ownerRefersTo` operands. None of those contracts exists any more. The history is in git (this section before 2026-09-27).
- For mainnet (roadmap D-D, D-J), decide on `config.readonly` before registering, since it cannot be added afterwards (§4).

What the offline validator cannot check, and registration will: that forge-core exists in state when forge-collab registers (the validator uses the in-memory contract), the deployer's identity and balance, and the contract-group state rules (the group is new; the signer owns the group a membership names).

### Contract group trust

A limited key is bound to the `dash-forge` contract group, and a group-bound key can sign documents for **every member** of the group, including members added after the key was registered. Binding a key therefore trusts whoever can add members. On protocol 14 that is only the group's owner or one of its admins:

- A member joins in the create transition of its own contract (`contract_group_memberships`). drive-abci (`data_contract_create/state/v1`) accepts the join only when the signer is the group's owner or an admin (`ContractGroupOwner::may_add_members`). A contract cannot enrol another contract, and no other transition adds members.
- The owner and admins are fixed when the group is registered. No transition changes them, and memberships are creation-only.

So `dg` and the web app pin the **trust root**, not the member list. Before offering to bind a key to the group (before the confirmation prompt), each one checks, with every read proof-verified:

1. **Owner pin.** `getContractGroupInfo` returns the owner recorded in the bundled `deployments/<network>.json` (`v2.contractGroup.owner` when its `id` is the current group, else forge-core's `ownerId`), and **no admins** (`deploy-v2.mjs` registers none). A different owner, any admin, or a missing group is refused. With this pin, consensus alone guarantees that every member was created by the Forge deployer.
2. **The current pair.** forge-core and forge-collab are whole-contract members. This is checked before any member contract is read.
3. **Member owners, as a cross-check.** Every other member (a whole contract, a document type or a token) should belong to a contract whose `$ownerId` is the pinned owner. The client reads each unknown member contract, up to 64 of them, and refuses on a proof-verified owner mismatch.
4. **Unknown members are shown, not refused.** A member the client does not know passes and is listed before the key is confirmed. Examples are a newer forge-collab revision or a trending-index contract. `dg` prints a `note:` line (part of the key explanation, or right after the group check in `dg auth new`), and reports `unknownGroupMembers` in `--json` output. The web app shows the note on the key-creation screen. The note reads "newer Forge contract revision(s)", or "additional group member(s)" when a member is a document type or token of a contract the client already knows. Earlier contracts the deployment lists as superseded in the same group count as known.
5. **Strict mode (`dg` only).** `dg auth … --strict-group`, or `DASH_FORGE_STRICT_GROUP=1` for CI, accepts only the known set: the current pair and its superseded predecessors. Anything else is refused, and no member contract is read. The web app has no strict mode.

**Trade-off: a member the client cannot read is accepted.** A member contract that cannot be fetched or decoded (for example, a contract format newer than the installed binary) is accepted. The note names it ("could not read contract X; accepted because the group owner is pinned"), and `--json` lists it under `uncheckedGroupMembers`. The same applies to unknown members past the cap of 64. Rule 1 is what bounds a key: only the pinned owner can add members, and consensus enforces that, so rule 3 adds no security that rule 1 lacks. Refusing on a read failure would turn every future contract format into an outage for every installed client, which is the failure this design removes. Only a proof-verified owner that differs from the pin is refused.

Registering a new Forge contract into the group (`deploy-v2.mjs --only collab --force-new`) therefore breaks no installed client. Only a change of owner or admins does, and that would need a new group, and so a new deployment file.

## 9. Rules that changed from the brief

- **The author path is a lookup on a second unique index.** A permanent lookup needs a unique index that includes the writer. `issue` and `patch` therefore carry `author($ownerId, repoId, number)` next to `number(repoId, number)`, and `authorEvent` (and `event`, for the target agreement) carries `targetNumber` so the lookup key can be assembled. The id reference `targetId` is tied to it with `{"targetId": "$id"}`.
- **`documentsKeepHistory` only on `issue` and `patch`.** Platform refuses history on a deletable type (the storage layer cannot delete such documents). `comment` stays deletable, so it has no history.
- **`repoKey` recipients are not required to be members**; see §5.
- **Author events are their own type** (`authorEvent`, kind close/reopen only) rather than a third and fourth operand of `event`'s gate; see §3.
- **Stars and follows are `indexOnly`** with a `$createdAt`-free proof index. "Who starred, newest first" is no longer ordered by time; star and follower counts and "did I star this" are O(1).
