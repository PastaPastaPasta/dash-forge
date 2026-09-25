# Dash Forge v2 contracts (protocol 14)

Two shared data contracts, **forge-core** and **forge-collab**, registered once per network and joined by a PV14 contract group. They replace the per-repo contract template (`templates/repo-v1.json`, token ACL) and the global registry (`contracts/registry.json`). Every repository is a set of documents in these two contracts, keyed by the `repo` document's id (`repoId`).

- Schemas: `forge-contracts/contracts/forge-core.json`, `forge-contracts/contracts/forge-collab.json`
- Offline validation: `tools/contract-validate` (rs-dpp `v4.2.0-beta.4`, `PlatformVersion` 14)
- Registration: `forge-contracts/scripts/deploy-v2.mjs` (evo-sdk `4.2.0-beta.4`)
- Decision record: roadmap D-A (owner decision of 2026-09-24, reviewed by a protocol architect)

## 1. Why the model changed

Under v1 each repository was its own contract. Write access came from two tokens (WRITE, MAINTAIN): a `tokenCost` on each write-path type, with freezing to suspend and destroying to revoke. That worked at consensus, but a repository cost about 1.18 DASH, most of it contract registration fees (base fee, plus a fee per document type, per index and per token), and a fork cost the same again. Nothing could make that cheap.

Protocol 14 can express the same access control inside a shared contract:

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
| `issue` | anyone (fees are the spam floor) | yes, history kept; `repoId`, `number` immutable | **no** | unique `(repoId, number)` rangeCountable; unique `($ownerId, repoId, number)` (the author lookup `authorEvent` uses); `repoId` → permanent `repo` |
| `patch` (PR) | anyone | yes, history kept; `repoId`, `number`, `sourceRepoId` immutable | **no** | as `issue`, plus `sourceRepoId` → permanent `repo` (the fork holding the PR's objects), index `sourceRepoId` |
| `comment` | anyone | yes; `repoId`, `targetId` immutable | yes | `targetId` → permanent `issue` or `patch` of the same repo (`propertyAgreement` on `repoId`); `(targetId, $createdAt)` rangeCountable |
| `review` | anyone | no | yes | `patchId` → permanent `patch` of the same repo; clients count approvals only from M/W holders (§6) |
| `event` | M or W | no | **no** | every kind (close, reopen, merge, label, assign, retarget, draft, ready); §3 |
| `authorEvent` | **the author of the target issue or PR** | no | **no** | `kind` is 1 (close) or 2 (reopen) only, enforced by the schema; indexes `(targetId, $createdAt)` and repo feed `(repoId, $createdAt)`; §3 |
| `checkRun` | M or W | yes (status progression); `repoId`, `headOid`, `name` immutable | yes | a replace re-checks the gate, so a revoked runner cannot advance its runs |
| `webhook` | M | yes (`url`, `events`, `secret`, `disabled`); `repoId`, `hookId` immutable | yes | the creating maintainer toggles `disabled` or edits in place; a replace re-checks the gate, so a revoked maintainer cannot re-enable a hook. Another maintainer supersedes it with a newer doc for the same `hookId` (newest wins) or asks the creator to delete. `secret` is `encryptedFor` the relay identity's encryption key (§5) |
| `profile` | anyone | yes | yes | one per identity |
| `star` | anyone | no | yes (unstar) | `indexOnly`: `(repoId)` countable = star count; `($ownerId)` with terminal `repoId` = my stars; one star per (repo, identity) is structural |
| `follow` | anyone | no | yes (unfollow) | `indexOnly`: follower and following counts are both countable; `identityId` → existing identity, `distinctFrom: $ownerId` |

Shared shapes (`id`, `oid`, `h32`, `refName`, `body`, `enc`, …) are in `schemaDefs` and referenced with `$ref`. A document type may use each `$defs` entry **once**: rs-dpp's depth walker treats a second `$ref` to the same definition in one type as a cycle (`InvalidJsonSchemaRefError`). The same goes for the `integer` shape of a key id named by `encryptedFor` or `keyIdProperty`, which must be inline (the parser's `is_key_id_schema` resolves `$ref` against the document schema, which has no `$defs`). Repeats are inlined for these reasons.

## 3. Events, and what "authorization survives revocation" means

Issue and PR state changes are two document types, one per kind of authority, so a reader always knows which gate admitted a document:

- **`event`** (close, reopen, merge, label, assign, retarget, draft, ready) is gated by `ownerRefersTo anyOf` with two operands:
  1. a `maintainer` for `repoId` (deletable lookup `byRepoMember` into forge-core),
  2. a `writer` for `repoId`.
- **`authorEvent`** (close, reopen) is gated by `ownerRefersTo anyOf` with two operands:
  1. the author of the target issue: the lookup `author($ownerId = writer, repoId, number = targetNumber)` on `issue`, with `propertyAgreement {"targetId": "$id"}`, so the issue found must be the one the document targets,
  2. the same for `patch`.

  Its `kind` is an integer with `minimum 1, maximum 2`, so consensus refuses an author's merge, label or any other kind outright. It carries no `value` or `oid`.

For both types, `targetId` must be an `issue` or `patch` whose `repoId` and `number` equal the document's `repoId` and `targetNumber`. Membership of repo A cannot authorize an event on repo B's issue, and the author of issue #3 cannot act on issue #4. Both are indexed `(targetId, $createdAt)` (a target's history) and `(repoId, $createdAt)` (the repo's activity feed, which reads both types).

`authorEvent`'s operands are `permanentDocument` lookups, so `issue` and `patch` must be non-deletable (registration rejects a permanent lookup into a deletable type with 40122). That is why issues and PRs can no longer be deleted for a refund.

**Why two types.** The first registration gated a single `event` type by all four operands. A reader then could not tell which operand admitted a given event: a maintainer who also authored the PR, and was later revoked, left merges that might have been admitted by the author path, where merge is not allowed. The split removes the question. Protocol 14 freezes `ownerRefersTo` on update (removing an `anyOf` operand is an incompatible schema change; `tools/contract-validate --previous` reports it), so the split shipped as a new forge-collab registration (§8), not an update.

Both types are immutable and non-deletable, and the gate is judged at creation. **A document's existence therefore proves its writer was authorized at its block time**: an `event` proves the writer held a `maintainer` or `writer` document for the repo then, and an `authorEvent` proves the writer was the target's author. Revoking a maintainer later does not invalidate their past events, and nothing has to be reconstructed from membership history.

**Kind rules (`FORGE_RULES_V2`, `forge-core::rules::v2`, `forge-web/lib/rules/v2`).** The fold applies:

| kind | from `event` (any M/W at write time) | from `authorEvent` |
|---|---|---|
| close, reopen | yes | yes |
| merge | yes, if `oid` is reachable from the base tip (the v1 predicate) | never (consensus refuses the kind) |
| label+, label−, assign, unassign, retarget, draft, ready | yes | never |

An `authorEvent` whose `kind` is not close or reopen cannot exist on chain; the fold treats one handed to it as inert anyway, and ignores one whose writer is not `target_author`. Events of both types are merged into one log and ordered by `($createdAt, $id)`, the v1 order, with `$id` compared by Unicode code point (UTF-8 byte order; JavaScript's `<` compares UTF-16 code units and disagrees on astral characters, so the TypeScript port uses `compareStrings`). Documents with the same key keep their input order, `event`s first. A merged PR cannot be reopened, as in v1.

**Known design choices, kept from v1.** The author may reopen what a member closed, and a member can close it again; nothing stops the two alternating except fees. A member's approval counts on their own PR (§6), because a `review` does not know the PR's author; clients may show a self-approval distinctly.

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
- **`dg repack` / GC must change**: today they delete superseded chunks and manifests for the refund (`crates/dg`, `forge-core::pack`). On v2 those deletes are refused at consensus, so the delete step goes, and GC applies only to external storage the user controls.

**Front-running.** Every pack-write unique index includes `$ownerId` (`packManifest (repoId, $ownerId, packHash)`, `manifestPart (…, partSeq)`, `chunk (…, seq)`). Without it, the first writer to claim a `(repoId, packHash)` would own that slot forever: a hostile writer could post a manifest with the right hash and wrong content, or one chunk, and block the honest upload. With it, each writer has its own slot. **Reader rule** (`FORGE_RULES_V2`: `order_pack_copies`, `select_pack_copy`, `pack_read_order`, vectors `pack_copies__*`): for a `packHash`, gather every writer's manifest (`(repoId, packHash)` index) and try them in order: uploaders who are currently maintainers, then current writers, then everyone else (members since revoked), each group by `$createdAt` then `$id`. Read the first copy whose reassembled bytes verify against `packHash`; a copy that fails verification is ignored, and a pack with no verifying copy is unreadable. A `supersedes` list is honoured only from the copy actually read, and only when it verifies. A superseded pack is read after the others as a fallback, never dropped: a hash proves a pack's bytes, not that it holds everything it claims to replace.

**The pack list** (`FORGE_RULES_V2`: `v2_pack_list`, vectors `v2_pack_list__*`). A locator's `packRef` indexes "the repo's pack list", which must be derived identically by every reader and writer. With several copies per pack it is:

1. Take every `packManifest` of the repo (all kinds). An older locator bounds the set **as of** its own `($createdAt, $id)`, inclusive.
2. Group the copies by `packHash`. Rank each group like the reader rule (maintainers, writers, everyone else; then `($createdAt, $id)`), drop copies whose bytes failed verification, and call the first remaining copy the **representative**. A hash with no remaining copy is not in the list. The pack's `kind` and metadata (`sizeBytes`, `objectCount`, `chunkCount`, `supersedes`) are the representative's; copies claiming another `kind` are dropped, so a stranger's copy cannot re-label a pack.
3. A pack's position is its **first upload**: the earliest `($createdAt, $id)` among all copies of the hash, failed and other-kind ones included. A later or higher-ranked copy never moves a pack.
4. `packRef` is the pack's index, by first upload, **among the packs of its kind**: kind-0 git packs are numbered 0..n regardless of interleaved kind-1 index fragments.
5. A pack is superseded when another listed pack's representative names it in `supersedes` **and that representative verified**; an unchecked claim supersedes nothing. Superseded packs keep their `packRef` (positions never shift); readers skip them only when fetching whole packs, and read them as a fallback.

The function is kind-agnostic: callers pass every copy and select a kind from its output (the locator space is the kind-0 packs). It differs from the v1 rule on purpose: v1 dropped superseded packs from the space (a v1 repack deleted the caller's own), while v2 keeps them, because v2 manifests are permanent and a position that never moves means no locator ever needs renumbering. Locators of v1 repositories keep the v1 rule.

`release`, `label`, `webhook`, `checkRun`, `comment`, `review`, `star`, `follow` and `profile` stay deletable. Their resolution is newest-wins or per-author, so a deletion removes only the deleter's own contribution. Residual risk: a revoked maintainer can delete a release they published. Readers fall back to the next-newest release for that tag.

The contracts are **not readonly**, so the owner identity can still update them, within the protocol 14 update rules: indexes, `refersTo`/`ownerRefersTo`, `immutable` and `encryptedFor` are all frozen on update, so an update can add optional properties and new document types but cannot loosen an existing gate. **Readonly cannot be switched on later**: a config update to `readonly: true` is refused (`validate_update` v0, "contract can not be changed to readonly"). To make the final mainnet contracts readonly, set `config.readonly` in the JSON when registering them (§8).

## 5. Private repositories

A private repo is a `repo` with `visibility: "private"`; `visibility` is immutable. Consensus cannot hide data, so the key model is client-side, and the contract carries its envelope:

- **Content key per epoch.** A maintainer draws a 32-byte key for epoch 0 and wraps it for every member (the owner included) in a `repoKey` document `{repoId, memberId, epoch, recipientKeyId, senderKeyId, wrapped}`.
  - `wrapped` is `encryptedFor {recipient: memberId, recipientKey: recipientKeyId, senderKey: senderKeyId, scheme: ecdh-secp256k1-aes256-cbc}`. Consensus checks its shape: at least 32 bytes and a multiple of 16.
  - `memberId` carries `refersTo identityPublicKey` with `keyIdProperty: recipientKeyId` and `keyRequirements {purpose: encryption}`, and `senderKeyId` carries the owner form (`identityProperty: $ownerId`, purpose encryption). Consensus refuses a wrap to a key that does not exist, is disabled, or is not an encryption key.
  - Unique `(repoId, memberId, epoch, $ownerId)`; gated to maintainers; immutable and non-deletable. `$ownerId` is in the key so one maintainer cannot claim a member's slot for an epoch before another.
  - **Reader rule.** A member accepts a wrapped key for `(repo, epoch)` only if its writer was a maintainer when it was written (the gate proves it held then), and only if the unwrapped key verifies against the epoch's key-check value. A key-check value is `HMAC-SHA256(key, "forge-v2 key check" ‖ repoId ‖ epoch)`, carried by the epoch's first `config` (Phase 3 fixes the exact field). When several maintainers wrapped for the same epoch, any copy that verifies is the key.
  - Consensus cannot also require `memberId` to be a member: an `identityPublicKey` reference cannot be combined with other operands. Wrapping the key to a non-member amounts to leaking it, which a maintainer can always do anyway.
- **Rotation.** On removing a member, a maintainer posts epoch `n+1` wraps for the remaining members. Future content uses the new key. Past content stays readable to past members, and the product says so plainly.
- **Encrypted fields.** `issue`, `patch`, `comment` and `review` take `enc` (a byte array, AES-256-GCM under the epoch key, including title and body) plus `epoch`, and leave the plaintext `title`/`body` empty. `refUpdate`, `protectedRefUpdate` and `config` take the same `enc`/`epoch` pair.
  - A private ref update puts `refName` inside `enc` and sets `refNameHash = HMAC-SHA256(epoch key, refName)`, so ref names cannot be recovered by dictionary. `refName` is optional for this reason.
  - `dependentRequired {enc: [epoch]}` makes consensus refuse ciphertext without an epoch.
  - **"Plaintext or `enc`, not both, not neither" is a client rule** (`is_well_formed`, vectors `well_formed__*`). `propertyConstraints` compare integer expressions only and cannot test whether a string is present, and the meta-schema admits no `oneOf`/`not` at the document-type level. Each kind has plaintext fields and at most one required one: `issue` (`title` required, `body`), `patch` (`title` required, `body`, `baseRefName`, `sourceRefName`), `comment` (`body` required), `review` (`body`, optional: a review's content is its verdict and `commitOid`, which are never encrypted), a ref update (`refName` required), `config` (`defaultBranch`, `protectedPatterns`, neither required). In a **public** repo a document is well-formed when it has no `enc` and has its required field, if its kind has one. In a **private** repo it is well-formed when it has a non-empty `enc`, an `epoch`, and none of its plaintext fields, so a private repo's `refUpdate` carrying a plaintext `refName` is malformed. An empty string, or an empty `protectedPatterns` list, counts as absent. Clients skip a malformed document, and every other rule (approvals included) only sees well-formed ones.
  - Packs are encrypted before upload (Platform chunks or external storage). Oids, sizes and timing stay visible.
- **What a stranger can still do.** Issues and PRs are un-gated, so anyone can post plaintext into a private repo's namespace. Clients show only documents that decrypt under a key the reader holds, or that come from a member.

The concrete AEAD layout, key derivation and test vectors are Phase 3 work and need their own security review (roadmap Phase 3). The contract fields above are what that design writes into.

## 6. What moves from client rules to consensus

| v1 (client rules / `FORGE_RULES_V1`) | v2 |
|---|---|
| Push authorization: WRITE token spend | consensus: `ownerRefersTo` M or W |
| Protected refs: MAINTAIN spend on `protectedRefUpdate` | consensus: M gate. **Routing stays a rule**: consensus cannot read `protectedPatterns`, so a plain `refUpdate` naming a protected ref still exists and is inert by the as-of config rule |
| Revocation: freeze (+ destroy) | delete the `maintainer`/`writer` document; the next write is refused (40120) |
| Event actor authorization, reconstructed as-of from token history | consensus at create time (§3): `event` is M/W only, `authorEvent` is the target's author with kind close/reopen only. **Merge reachability stays a rule**: `merge` needs `oid` reachable from the base tip |
| Listing authenticity (listing owner == repo contract owner) | gone: `repo` is the listing |
| Owner lock-out prevention (`baseSupply`) | client rule: the owner self-enrols as maintainer in the same session that creates the repo |
| Concurrent-push divergence, newest-wins resolution, ref-name glob matching, overlay | unchanged, still rules |
| Issue and PR numbering | client rule, see below |
| PR approvals | client rule (`count_approvals`, vectors `approvals__*`): `review` is un-gated. Its input is the PR's reviews filtered by `is_well_formed` (§5) first. A review counts only if it is on the PR's current `headOid` and its reviewer had a current `maintainer`/`writer` document created at or before the review's `$createdAt`. Each reviewer's newest counting approve (1) or request-changes (2) review by `($createdAt, $id)` stands; comment (3) and unknown verdicts neither count nor clear. A revoked reviewer's document is gone, so their reviews stop counting. A member's approval of their own PR counts (§3, known design choices) |

**Numbering** (client rule, `allocate_number`, vectors `allocate_number__*`). Numbers are unique per repo at consensus, but anyone can claim any number, so allocation must tolerate gaps and hostile claims. A max+1 rule breaks as soon as someone posts #4294967295. The rule:

1. `n` = the provable count of the repo's issues (rangeCountable `number` index).
2. `ceiling` = `min(2 × n + 100, 2³² − 1)`.
3. `base` = the largest taken number ≤ `ceiling` (a range query on the `number` index, descending from `ceiling`, limit 1), or 0 if there is none.
4. Claim the first number greater than `base` that is not taken. Every number in `(base, ceiling]` is free by the choice of `base`, so below the ceiling this is `base + 1`. Only when `base` equals `ceiling` can squatters sit directly above it, and the probe steps over them: an ascending query from `base + 1`, **paged to the end of the contiguous run** (the first gap). Stopping after one page hands the allocator a run cut short, and it would pick a number that is already taken.
5. If every number from `base + 1` to 2³² − 1 is taken, there is nothing to allocate.

Gaps below `base` are never filled. A number above the ceiling cannot be reached until the repo grows to about half that many issues, so a squatter at 2³²−1 (or anywhere far ahead) is ignored. A squatter at exactly the ceiling is counted, and allocation continues above it. Squatting the number the allocator is about to take costs the squatter a document fee and the allocator one retry: consensus refuses the duplicate, and the next attempt sees it as `base`. Issues and PRs number independently.

**Repository names** (`is_valid_repo_name`, `normalize_repo_name`, vectors `repo_name__*`). A name is valid when it matches the contract's pattern `^[a-z0-9][a-z0-9._-]{0,62}$` in full; a trailing newline does not match. Clients lowercase ASCII `A`–`Z` in user input before checking, and change nothing else, so `Dash-Forge` names `dash-forge`. Other characters are not folded: `é`, or the Kelvin sign that Unicode lowercases to `k`, leaves the name invalid.

**Conformance.** `FORGE_RULES_V2` is `forge-core::rules::v2` (Rust) and `forge-web/lib/rules/v2.ts` (TypeScript). The shared vectors in `forge-contracts/vectors/` carry `"rules": "v2"`; a vector without `rules` is v1, and both harnesses dispatch on the field. The v2 rules are:

| Rule | Functions | Vectors |
|---|---|---|
| Issue/PR fold over `event` + `authorEvent` (§3) | `fold_issue_state_v2`, `fold_pr_state_v2` | `fold_issue_v2__*`, `fold_pr_v2__*` |
| Membership | `RoleOracle::{role_at, member_at, current_role}` | through `approvals__*` |
| Numbering | `allocate_number`, `number_ceiling` | `allocate_number__*` |
| Pack reader rule (§4) | `order_pack_copies`, `select_pack_copy`, `pack_read_order` | `pack_copies__*` |
| Pack list / `packRef` space (§4) | `v2_pack_list` | `v2_pack_list__*` |
| Approvals | `count_approvals` | `approvals__*` |
| Plaintext xor `enc` (§5) | `is_well_formed` | `well_formed__*` |
| Repository names | `is_valid_repo_name`, `normalize_repo_name` | `repo_name__*` |

The v2 fold takes no membership input: an `event`'s existence is its authorization. `RoleOracle` answers "was X a member at time t" from the repo's *current* `maintainer`/`writer` documents, so a revoked member (whose document was deleted) is not a member at any time, and a re-added member counts from their new document. The repoKey reader rule of §5 is Phase 3 work and has no vectors yet.

**Holdings vectors.** The `holdings__*` conformance vectors (token-history reconstruction) and the v1 `fold_issue__*` / `fold_pr__*` vectors do not apply to v2 repos. They stay, unchanged, for reading v1 repos.

## 7. Measured size and cost

From `tools/contract-validate` (rs-dpp v4.2.0-beta.4, `PlatformVersion` 14). The signed-shape transitions carry a 65-byte recoverable signature and the contract group fields. The deploy script's dry run built the same transitions with the evo-sdk wasm, signed them, and got the same byte counts.

| | forge-core | forge-collab |
|---|---|---|
| Document types / indexes | 12 / 26 | 11 / 23 |
| Serialized contract | 11,761 B | 12,043 B |
| Signed `DataContractCreate` v1 | **11,924 B** | **12,149 B** |
| vs `max_state_transition_size` (20,480 B, the hard limit) | 58.2% | 59.3% |
| Registration fee (fee schedule v3: 0.1 base + 0.02/type + 0.01/index) | **0.60 DASH** | **0.55 DASH** |

`estimated_contract_max_serialized_size` (16,384 B) is not a limit. It is the size Drive's fee *estimation* assumes when it prices reading a stored contract (`apply_contract_with_serialization` v0). Both contracts are under it anyway.

Total one-time registration fees are **1.15 DASH**, paid once by the deployer, plus storage. A new repository is now three documents (`repo`, the owner's `maintainer`, the first `config`), about 0.001 DASH in storage by the 27,000 credits/byte rate, compared with ~1.18 DASH for a v1 repo contract. The per-repo figure is an estimate still to be measured on moutai.

**Measured on devnet moutai (2026-09-25)**, as the deployer's balance change:

| | forge-core | forge-collab |
|---|---|---|
| Total cost | 0.605711 DASH (60,571,079,360 credits) | 0.555523 DASH (55,552,297,710 credits) |
| of which the registration fee | 0.60 | 0.55 |
| storage + processing | 0.0057 | 0.0055 |

Together that is **1.161234 DASH**. The two superseded forge-collab registrations (§8) cost a further 0.515157 DASH (51,515,695,120 credits, the four-operand `event`) and 0.545473 DASH (54,547,323,690 credits, the split without the feed index).

## 8. Deploying

```sh
(cd forge-contracts/sdk-v2 && npm ci)
node forge-contracts/scripts/deploy-v2.mjs --self-test
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --dry-run
# re-register forge-collab alone (new id) against the recorded forge-core and group:
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --only collab --force-new [--dry-run]
# would an in-place DataContractUpdate from the registered schema be accepted instead?
git show <commit it was registered from>:forge-contracts/contracts/forge-collab.json > /tmp/registered-forge-collab.json
cargo +1.98.1 run -q --locked --manifest-path tools/contract-validate/Cargo.toml -- \
     forge-contracts/contracts/forge-core.json forge-contracts/contracts/forge-collab.json \
     --previous /tmp/registered-forge-collab.json
```

- forge-core's create transition registers the contract group (`dash-forge`) and enrols forge-core as a whole contract.
- forge-collab's transition enrols it in the same group. The group id is `hash_double("contract_group" ‖ owner ‖ nonce)` of forge-core's transition.
- Results go to the `v2` section of `deployments/<network>.json` (`devnet-<name>.json` for a devnet). Each step's nonce (masked to its low 40 bits, as rs-dpp does), contract id, group id derived from that same nonce, and pre-broadcast balance are written before broadcasting. A rerun that finds the contract on chain completes the record (status, cost, owner) rather than skipping it; one whose reserved nonce never landed takes the chain's next nonce and re-derives both ids from it. It never registers a second copy unless told to. Each record also carries `schemaHash`, the sha256 of the schema JSON (after placeholder substitution, compactly re-serialized) it was registered from; a rerun that finds a recorded contract whose hash differs from the current schema warns and leaves it as is. A dry run's forge-core step is not checked against a leftover record.
- `--only collab` registers forge-collab alone, against the forge-core and group already recorded and found on chain; it never registers forge-core. With `--force-new` it registers a new forge-collab when the recorded one is registered from a different schema (its `schemaHash` differs, or it predates the field): the old record moves to `v2.forgeCollabSuperseded`, and the new one takes the next nonce and so a new id. A recorded contract from the current schema, or one still `broadcasting` (an interrupted run, which is completed or retried instead), is never superseded, so rerunning the same command registers nothing. This is how a schema change the update rules refuse ships. Documents written under the old contract stay under its id.
- The script refuses a CRITICAL key that is missing, different from the identity file, or disabled on chain.
- **Registered on devnet moutai** (protocol 14, drive 4.2.0-beta.4) on 2026-09-25 by the moutai DEPLOYER `8HGxMu4atPn4jThH5h9X1MajzhoD3PRnzCRGrAsFcLcV`. The ids are recorded in `deployments/devnet-moutai.json`, and the script checked on chain that the group exists, that the deployer owns it, and that both contracts are enrolled:
  - forge-core `GdZYaEntYPiW9dvUGCHyeqN7H7qEocbSkuj81n341i3L` (nonce 1)
  - forge-collab `CbsaT6oxuoESYhWuoJuPW9QikvAP7RS2x8NGQAYiwsMq` (nonce 4), the current schema (the `event`/`authorEvent` split of §3, with `authorEvent`'s feed index), registered with `--only collab --force-new`
  - contract group `23iVLZABbVQ5a4heSa6GLVbVqSWr74JTSESSMTEYNd6o` (`dash-forge`)
  - superseded, still on chain and in the group, not read by clients:
    - forge-collab `9fCcSGF3UmajGCNHuuDGz2ou3Gm3EXhrwB3SRS9ocm4Y` (nonce 2), the first registration, whose `event` took all four operands. The split could not be an update: `--previous` reports `validate_update` refusing the removal of `event`'s `ownerRefersTo` operands (adding `authorEvent` alone would have been accepted).
    - forge-collab `6tm5ehZGoNSwenkCZkXjUm97Vt2bdXfFFsfh9KZ5N43W` (nonce 3), the split without `authorEvent`'s feed index. Adding an index is refused on update too ("we do not allow modifications of data contract index paths").
- For mainnet (roadmap D-D, D-J), decide on `config.readonly` before registering, since it cannot be added afterwards (§4).

What the offline validator cannot check, and registration will: that forge-core exists in state when forge-collab registers (the validator uses the in-memory contract), the deployer's identity and balance, and the contract-group state rules (the group is new; the signer owns the group a membership names).

## 9. Rules that changed from the brief

- **The author path is a lookup on a second unique index.** A permanent lookup needs a unique index that includes the writer. `issue` and `patch` therefore carry `author($ownerId, repoId, number)` next to `number(repoId, number)`, and `authorEvent` (and `event`, for the target agreement) carries `targetNumber` so the lookup key can be assembled. The id reference `targetId` is tied to it with `{"targetId": "$id"}`.
- **`documentsKeepHistory` only on `issue` and `patch`.** Platform refuses history on a deletable type (the storage layer cannot delete such documents). `comment` stays deletable, so it has no history.
- **`repoKey` recipients are not required to be members**; see §5.
- **Author events are their own type** (`authorEvent`, kind close/reopen only) rather than a third and fourth operand of `event`'s gate; see §3.
- **Stars and follows are `indexOnly`** with a `$createdAt`-free proof index. "Who starred, newest first" is no longer ordered by time; star and follower counts and "did I star this" are O(1).
