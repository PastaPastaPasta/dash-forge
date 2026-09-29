# Dash Forge v2 contracts (protocol 14)

Three shared data contracts, **forge-core**, **forge-collab** and **forge-community**, registered once per network and joined by a PV14 contract group. Every repository is a set of documents in these contracts, keyed by the `repo` document's id (`repoId`). This is the only data model Dash Forge implements.

- Schemas: `forge-contracts/contracts/forge-core.json`, `forge-contracts/contracts/forge-collab.json`, `forge-contracts/contracts/forge-community.json`
- Offline validation: `tools/contract-validate` (rs-dpp `v4.2.0-beta.7`, `PlatformVersion` 14), `.github/workflows/contracts.yml`
- Registration: `forge-contracts/scripts/deploy-v2.mjs` (evo-sdk `4.2.0-beta.7`)
- Decision record: roadmap D-A (owner decision of 2026-09-24, reviewed by a protocol architect)

## 1. Why shared contracts

Contract registration is priced per contract (a base fee plus a fee per document type, per index and per token). A design where each repository is its own contract therefore pays that fee for every repository and every fork, whatever its size. That was forge-v1: a global registry contract plus one contract per repository, with access control by WRITE/MAINTAIN tokens, at about 1.18 DASH a repository. It was removed on 2026-09-26 with no backwards compatibility; [data-contracts.md](data-contracts.md) keeps its design for the record.

Protocol 14 can express per-repository access control inside a shared contract:

- **`ownerRefersTo`**: a document type can require its writer (`$ownerId`) to be found through a unique index of another document type. Consensus checks this on create, and on every replace when the target is a `deletableDocument`.
- **`findBy`** references find a document through the unique index whose properties are exactly the ones named, e.g. `{"repoId": "repoId", "memberId": "."}` (`"."` is the reference's own value: the writer, for `ownerRefersTo`), so a membership document is enough; the writer does not have to name it.
- **`where`** checks properties of the document found, keyed by **its** property: `{"$ownerId": "$ownerId"}` makes "only the owner of the referenced document may write this" a consensus rule, and `{"number": "targetNumber"}` means the found document's `number` equals ours.
- **Contract groups** give the three contracts a provable "these contracts belong together" record.

**Spelling (platform#5197, beta.7).** `findBy` and `where` replaced `lookup {index, keys}` and `propertyAgreement {referring: referenced}` in v4.2.0-beta.7: the index name is gone (Platform picks the unique index the `findBy` keys name), and `where` is keyed by the referenced property, the reverse of `propertyAgreement`. The parsed model, validation and fees are unchanged. The old keywords are refused **on every parse**, stored contracts included, so the contracts registered before the beta.7 wipe cannot be read by a beta.7 client; that is why this schema is a fresh registration (§8).

The per-repo "sovereign" tier is dropped. Anyone who wants different rules can register their own copy of these schemas (the deploy script works for any identity). Clients treat a copy as a different forge.

## 2. Types and who can write them

"Gate" means the consensus `ownerRefersTo` check on create. M = the writer has a `maintainer` document for the repo. W = the writer has a `writer` document for the repo. Replace and delete are always limited to the document's owner (Platform rule), and documents cannot be transferred.

### forge-core

| Type | Gate (create) | Mutable | Deletable | Notes |
|---|---|---|---|---|
| `repo` | anyone | yes; `name`, `visibility`, `forkOf` immutable | **no** (target of `permanentDocument` refs) | unique `($ownerId, name)`, rangeCountable (repos per owner); `name` is the immutable URL slug `^[a-z0-9][a-z0-9._-]{0,62}$`; `displayName` (≤ 400 bytes) and `description` are editable; `forkOf` → permanent `repo`, ranked index `skipIfAbsent` (a non-fork writes no entry, so "most forked" has no null group) |
| `maintainer` | repo owner only (`repoId` → repo with `{"$ownerId":"$ownerId"}`) | no | yes (= revoke) | unique `(repoId, memberId)`; `memberId` → existing identity; index `memberId` |
| `writer` | repo owner only | no | yes (= revoke) | same shape as `maintainer` |
| `refUpdate` | M or W | no | **no** | `(repoId, refNameHash, $createdAt)` ref state, `(repoId, $createdAt)` reflog, `(repoId, $ownerId, $createdAt)` pusher |
| `protectedRefUpdate` | M | no | **no** | same indexes |
| `config` | M | no | **no** | append-only, newest wins; `protectedPatterns` and `backend.uris` are typed string arrays now |
| `packManifest` | M or W | no | **no** | unique `(repoId, $ownerId, packHash)`; `(repoId, packHash)` lookup; `(repoId, $createdAt)` rangeCountable (pack count); `(repoId, kind, $createdAt)`. `kind`: 0 git pack, 1 `objectLocator`, 2 `flatIndex`, **3 `releaseAssets`** (a release's full asset list, named by `release.assetManifest`; `docs/design/release-asset-manifest.md`) |
| `manifestPart` | M or W | no | **no** | unique `(repoId, $ownerId, packHash, partSeq)` |
| `chunk` | M or W | no | **no** | unique `(repoId, $ownerId, packHash, seq)`, rangeCountable (availability audit per uploader); `documentsCountable` (the chunk total, a ceiling for the fee estimator; `dash-forge-qa/design/CHUNK-COUNT-ESTIMATOR.md`, kept only if its count-tree cost measures under ~5 % of a chunk write) |
| `release` | **M** | no | yes | newest per `(repoId, tagName)` wins; maintainer-only because a release names artifacts users install; optional `enc`/`epoch` (C-1) for a private repo, with `tagName` the keyed hash of the tag; optional `assetManifest` (h32: the `packHash` of a kind-3 `packManifest` holding the full asset list when `assets` does not fit) and `imported {author, createdAt, url}` (a mirrored release); `noPlain` covers `assetManifest` too |
| `label` | M or W | no | yes | newest per `(repoId, name)` wins; optional `enc`/`epoch` (C-1), `name` then the keyed hash of the name |
| `repoKey` | M | no | **no** | unique `(repoId, memberId, epoch, $ownerId)`; private repos, §5 |
| `runner` | repo owner only (as `maintainer`) | no | yes (= revoke) | CI membership (C-1, platform-parity-spec §2.2): unique `(repoId, memberId)`, index `memberId`; a runner may post `checkRun` (forge-community) and nothing else |
| `topic` | repo owner only (as `maintainer`) | no | yes (untag) | C-1: unique `(repoId, name)`; `byName (name, $createdAt)` countable and ranked at `name` (repos per topic, popular topics); `name` `^[a-z0-9][a-z0-9-]{0,29}$`; the owner tags, so an untag is always possible |

forge-core is registered fresh at the beta.7 wipe, in the `findBy`/`where` spelling, with the release asset manifest, the countable `chunk` type and the sparse `forkOf` index. Later changes ship as an in-place `DataContractUpdate`: new types and new optional properties. CI (`.github/workflows/contracts.yml`) validates it with `contract-validate --expect-update forge-contracts/contracts/registered/forge-core.v1.json`, the schema of that fresh registration.

### forge-collab

Issues, PRs and everything that changes their state or discusses them. References into forge-core carry `contractId`. The schema file holds the placeholder `FORGE_CORE_CONTRACT_ID`, and the deploy script replaces it with forge-core's id before registering.

| Type | Gate (create) | Mutable | Deletable | Notes |
|---|---|---|---|---|
| `issue` | anyone (fees are the spam floor) | yes (title, body), history kept; `repoId`, `number`, `tk`, `upstreamNumber` immutable; `$updatedAt` required | **no** | `tk = 0` (the target-kind tag a `transition` agrees with); `number` is **dense** (§6.2): unique `(repoId, number)`; `perRepo (repoId)` countable (the numbering total and the header's issue total); unique `author ($ownerId, repoId, number)` rangeCountable (the author lookup `authorEvent` and `transition` use; author totals); optional `upstreamNumber` (a mirror's source number) with `upstream (repoId, upstreamNumber)` `skipIfAbsent`; `repoId` → permanent `repo` |
| `patch` (PR) | anyone | yes (title, body), history kept; `repoId`, `number`, `tk`, `upstreamNumber`, `sourceRepoId`, the four ref-name fields and `headOid` (the *initial* head; later heads are `headUpdate` events) immutable; `$updatedAt` required | **no** | as `issue` with `tk = 1`, sharing the issues' number sequence, plus `sourceRepoId` → permanent `repo` (the fork holding the PR's objects), index `sourceRef (sourceRepoId, sourceRefNameHash)` ("the PRs from this branch"; `sourceRepoId ==` alone also uses it). No `draft` field: a draft PR is a `patch` plus a kind-14 `transition` |
| `transition` | M or W, **or** the author of the target | no | **no** | a state change of an issue or PR (§3.1): `kind`, signed `delta`, `targetKind`, `asAuthor`, `oid` (merge); `perTarget (targetId)` countable + `summable: delta` (the target's state), `perRepoKind (repoId, kind)` countable (the header counts), `feed (repoId, $createdAt)` |
| `comment` | anyone | yes (body); `repoId`, `targetId` and the anchor (`replyTo`, `commitOid`, `path`, `line`, `side`, `startLine`, `reviewId`) immutable; `$updatedAt` required | yes | `targetId` → permanent `issue` or `patch` of the same repo (`where` on `repoId`); `(targetId, $createdAt)` rangeCountable; `reply (replyTo)` ("replies to my comment"; `skipIfAbsent`, so only replies are in it); `startLine` (first line of a range); `reviewId` → deletable `review` with `where {repoId: repoId, patchId: targetId, $ownerId: $ownerId}` (the review's `patchId` must equal the comment's `targetId`), so only the reviewer can attach comments to their review, and only on its PR (consensus) |
| `review` | anyone | no | yes | `patchId` → permanent `patch` of the same repo; `(patchId, $createdAt)` rangeCountable (review count per PR); `commentCount` (how many `reviewId` comments the submit writes); clients count approvals only from M/W holders (§6) |
| `event` | M or W | no | **no** | the non-state kinds 4–8, 11–22 (§3; `kind ≥ 4` and rule `noState` keep 9, 10 out); `refId` (a thread root, a reviewer, a review) with index `addressee (refId)` (`skipIfAbsent`: only events that carry a `refId` are in it); optional `enc`/`epoch` (`dependentRequired`): a private repo's event seals its `value` there (private-repos.md §4.3) |
| `authorEvent` | **the author of the target issue or PR** | no | **no** | `kind ∈ {11, 12, 13, 14, 16}`, enforced by the schema (`enum`); `refId`, `oid`; indexes `(targetId, $createdAt)`, repo feed `(repoId, $createdAt)` and `addressee (refId)` (sparse, as on `event`); §3 |
| `milestone` | M or W | no | yes | newest per `(repoId, title)` wins (index `byRepo (repoId, title, $createdAt)`); `description`, `dueOn`, `closed`; a private repo's milestone seals them in `enc` and keeps the keyed hash of the title in `title`; set / cleared on an issue or PR by event kinds 17 / 18 |

### forge-community

The social graph, CI and repo automation: types no collab rule counts, split off so both collab and community keep real headroom. References into forge-core carry `contractId` (`FORGE_CORE_CONTRACT_ID`, substituted like forge-collab's). A key bound to the contract group covers all three contracts; a runner key is bound to `(forge-community, checkRun)` only.

| Type | Gate (create) | Mutable | Deletable | Notes |
|---|---|---|---|---|
| `checkRun` | **runner**, M or W | yes (status progression); `repoId`, `headOid`, `name` immutable; `startedAt`, `completedAt`, `conclusion`, `externalId` **set once** (`immutableAllowSetting`); `$updatedAt` required | yes | a replace re-checks the gate, so a revoked runner cannot advance its runs; `conclusion` is GitHub's enum and present exactly when `status` is `completed`; **monotonic** (§6): `startedAt` present exactly when `status ≠ queued`, `completedAt` present exactly when `status = completed`, and a set-once field can never change or be removed (40128), so a completed run is final; `logUrl` + `logSha256` (both or neither); indexes `head (repoId, headOid, $createdAt)`, `recent (repoId, $createdAt)` and `updated (repoId, $updatedAt)` (for pollers) |
| `policy` | **M** | no | **no** | a branch policy: `requiredApprovals` 0–10, `approverRole` (0 any member, 1 maintainers), `requireChecks`, `requiredChecks` (≤ 10 names, C-1), `mergeMethods` bitmask (1 fast-forward, 2 merge commit, 4 squash, 8 rebase; 0 any); newest by `($createdAt, $id)` wins; non-deletable so a revoked maintainer cannot revert it by deleting it; a client rule in the merge box, never consensus. "Checks only from runners" (`policy.checksFrom`) stays a client rule too: there is no consensus "posted by a runner" bit (wipe decision D-6) |
| `webhook` | M | yes (`url`, `events`, `secret`, `disabled`); `repoId`, `hookId` immutable | yes | the creating maintainer toggles `disabled` or edits in place; a replace re-checks the gate, so a revoked maintainer cannot re-enable a hook. Another maintainer supersedes it with a newer doc for the same `hookId` (newest wins) or asks the creator to delete. `secret` is `encryptedFor` the relay identity's encryption key (§5) |
| `profile` | anyone | yes | yes | one per identity; `location`, `company`, `pubkeys` (≤ 4: `gpg:<fingerprint>` / `ssh-ed25519 …`, for signed-commit badges) |
| `star` | anyone | no | yes (unstar) | `indexOnly`: `(repoId)` countable + ranked = star count and all-time "most starred"; `($ownerId)` with terminal `repoId` = my stars; one star per (repo, identity) is structural; no `$createdAt`, so an unstar never needs a timestamp (platform-parity-spec §4.3) |
| `starBeat` | anyone | no | **no** | trending: `indexOnly`; `byOwner ($ownerId)` terminal `repoId` (one per identity and repo, ever); `byWeek ($createdAt, repoId)` 7-day windows every day, ranked, whose entries expire through the index's `ttl` (one week). Written beside a new star when the starrer counts toward Trending (default on) |
| `watch` | anyone | no | yes (unwatch) | `indexOnly`: `(repoId)` countable = watchers; `($ownerId)` terminal `repoId` = what I watch (the inbox's subscriptions, on every device) |
| `follow` | anyone | no | yes (unfollow) | `indexOnly`: follower and following counts are both countable, and `byTarget` is ranked ("most followed"); `identityId` → existing identity, `distinctFrom: $ownerId` |

Shared shapes (`id`, `oid`, `h32`, `refName`, `body`, `enc`, …) are in `schemaDefs` and referenced with `$ref`. A document type may use each `$defs` entry **once**: rs-dpp's depth walker treats a second `$ref` to the same definition in one type as a cycle (`InvalidJsonSchemaRefError`). The same goes for the `integer` shape of a key id named by `encryptedFor` or `keyIdProperty`, which must be inline (the parser's `is_key_id_schema` resolves `$ref` against the document schema, which has no `$defs`). Repeats are inlined for these reasons.

## 3. Events, and what "authorization survives revocation" means

The state of an issue or PR (open, closed, merged, draft) is a **`transition`** (§3.1). Everything else that happens to one is an event of two document types, one per kind of authority, so a reader always knows which gate admitted a document:

- **`event`** (the member kinds, table below) is gated by `ownerRefersTo anyOf` with two operands:
  1. a `maintainer` for `repoId` (deletable, `findBy {"repoId": "repoId", "memberId": "."}` into forge-core),
  2. a `writer` for `repoId`.
- **`authorEvent`** (the author's kinds, table below) is gated by `ownerRefersTo anyOf` with two operands:
  1. the author of the target issue: `findBy {"$ownerId": ".", "repoId": "repoId", "number": "targetNumber"}` on `issue` (its unique `author` index), with `where {"$id": "targetId"}`, so the issue found must be the one the document targets,
  2. the same for `patch`.

  Its `kind` is an integer with `enum [11, 12, 13, 14, 16]` (thread resolve and unresolve, review request and remove, head update), so an author's label, assign, retarget, review dismissal or milestone is refused outright. The document fails the node's document schema validation, and the SDK runs the same validation and refuses to broadcast. It carries `refId` and `oid`, never `value`.

For both types, `targetId` must be an `issue` or `patch` whose `repoId` and `number` equal the document's `repoId` and `targetNumber`. Membership of repo A cannot authorize an event on repo B's issue, and the author of issue #3 cannot act on issue #4. Both are indexed `(targetId, $createdAt)` (a target's history) and `(repoId, $createdAt)` (the repo's activity feed, which reads both types).

`authorEvent`'s and `transition`'s author operands are `permanentDocument` lookups, so `issue` and `patch` must be non-deletable (registration rejects a permanent lookup into a deletable type with 40122). That is why issues and PRs can no longer be deleted for a refund.

**Why two types.** The first registration gated a single `event` type by all four operands. A reader then could not tell which operand admitted a given event: a maintainer who also authored the PR, and was later revoked, left merges that might have been admitted by the author path, where merge is not allowed. The split removes the question. Protocol 14 freezes `ownerRefersTo` on update (removing an `anyOf` operand is an incompatible schema change; `tools/contract-validate --previous` reports it), so the split shipped as a new forge-collab registration (§8), not an update.

Both types are immutable and non-deletable, and the gate is judged at creation. **A document's existence therefore proves its writer was authorized at its block time**: an `event` proves the writer held a `maintainer` or `writer` document for the repo then, and an `authorEvent` proves the writer was the target's author. Revoking a maintainer later does not invalidate their past events, and nothing has to be reconstructed from membership history.

**Kinds.** `kind` is a `u8` on both types (integer widths are fixed at registration). `event.kind` / `authorEvent.kind` and `transition.kind` are separate number spaces: transition kinds 11–17 are PR state moves (§3.1), not the thread and review kinds 11–17 below, and only the pair of document type and kind names an action. Payload fields: `value` (≤ 120 chars, plaintext), `oid`, `refId` (an identifier).

| # | kind | payload | from `event` (any M/W at write time) | from `authorEvent` |
|---|---|---|---|---|
| 1, 2, 3, 9, 10 | close, reopen, merge, draft, ready | — | **never**: a `transition` (§3.1); `event.kind ≥ 4` and rule `noState` refuse them | never (schema) |
| 4, 5 | label+, label− | `value` label | yes | never (schema) |
| 6, 7 | assign, unassign | `value` identity | yes | never (schema) |
| 8 | retarget | `value` base ref | yes | never (schema) |
| 11, 12 | threadResolve, threadUnresolve | `refId` thread root comment | yes | yes |
| 13, 14 | reviewRequest, reviewRequestRemove | `refId` reviewer identity | yes | yes |
| 15 | reviewDismiss | `refId` review, `value` reason | yes | never (schema) |
| 16 | headUpdate | `oid` new head | yes | yes |
| 17, 18 | milestoneSet, milestoneClear | `value` milestone title | yes | never (schema) |
| 19, 20 | pin, unpin | — | yes | never (schema) |
| 21, 22 | lock, unlock | — (a locked thread: clients offer the composer to members only; fees stay the only floor) | yes | never (schema) |

**Kind rules (`FORGE_RULES_V2`, `forge-core::rules::v2` and `rules::review`, `forge-web/lib/rules/v2` and `review`).** An `authorEvent` applies when its kind is an author kind (`is_author_kind`) and its writer is the target's author. The state is the target's `transition` sum (§3.1), not a fold; `fold_pr_review_v2` folds kinds 11–18 into the review state (head, requested reviewers, resolved threads, dismissed reviews, milestone). An `authorEvent` of a kind outside the author set cannot exist on chain; the folds treat one handed to them as inert anyway, and ignore one whose writer is not `target_author`. Events of both types are merged into one log and ordered by `($createdAt, $id)`, with `$id` compared by Unicode code point (UTF-8 byte order; JavaScript's `<` compares UTF-16 code units and disagrees on astral characters, so the TypeScript port uses `compareStrings`). Documents with the same key keep their input order, `event`s first. A merged PR cannot be reopened.

**Known design choices.** The author may reopen what a member closed, and a member can close it again; nothing stops the two alternating except fees. A member's approval counts on their own PR (§6), because a `review` does not know the PR's author; clients may show a self-approval distinctly.

### 3.1 `transition`: state as a consensus sum

Every state change is a `transition` document with a small signed `delta`. **The running sum of `delta` over a target's transitions is its state code**, and the type's `propertyConstraints` make every stored transition a legal move from the current state, so the state is a proved `sum` read, not a fold:

| code | issue | PR |
|---|---|---|
| 0 | open | open, ready |
| 1 | closed | closed (not merged) |
| 2 | — | merged (terminal) |
| 8 | — | open draft |
| 9 | — | closed draft |

| kind | name | delta | from | to | who |
|---|---|---|---|---|---|
| 1 | issue close | +1 | 0 | 1 | member or author |
| 2 | issue reopen | −1 | 1 | 0 | member or author |
| 11 | PR close | +1 | 0 | 1 | member or author |
| 12 | PR reopen | −1 | 1 | 0 | member or author |
| 13 | PR merge (`oid` required) | +2 | 0 | 2 | member only |
| 14 | PR draft | +8 | 0 | 8 | member or author |
| 15 | PR ready | −8 | 8 | 0 | member or author |
| 16 | PR close while draft | +1 | 8 | 9 | member or author |
| 17 | PR reopen while draft | −1 | 9 | 8 | member or author |

The rules: `a_kindOfTarget` (`targetKind == kind / 10`, and `targetId`'s `where {"tk": "targetKind"}` ties it to the target's `tk`, so an issue kind cannot name a PR); `b1`–`b3` pin the delta per kind; `c1`–`c5` pin the target's sum **after** the write per kind (`sumOf(transition, delta, {targetId})` on the `perTarget` index; a create's total already includes the new document), which pins the state before it; `e_mergeOid` (a merge carries `oid`); `f_authorNoMerge`. A merged PR can be neither reopened, closed nor drafted; a draft must be readied before it merges. Two closes in one block: the second sees sum 2 after its own write and is refused by `c1` (a nonce bump); a stale write is refused free at CheckTx.

**Authority.** `ownerRefersTo anyOf` with four operands: `maintainer`, `writer` (forge-core, `findBy {"repoId": "repoId", "memberId": "."}`), and the author of the target `issue` / `patch` (`findBy {"$ownerId": ".", "repoId": "repoId", "number": "targetNumber"}`, `where {"$id": "targetId", "number": "asAuthor"}`). A writer admitted as the author must set `asAuthor == targetNumber` (≥ 1); a member sets `asAuthor = 0`. So **`asAuthor = 0` proves the writer held a `maintainer` or `writer` document for the repo at the block time**, and `f_authorNoMerge` refuses a merge unless `asAuthor = 0`: "merged" is a chain fact recorded by a member. `anyOf` admits through the first operand that holds, so a member-author may also write as the author. The repo owner is admitted only through their own `maintainer` document, written in the repo-create session (REPO-01): an owner without it cannot close issues.

**What "merged" means (D-9).** The chain records that a member merged a PR with an `oid`; it cannot see git. Readers still check that `oid` has been a valid tip of the base (the D-602 membership rule, §6) and label a merge that fails it "merged (merge commit not found on the base)" instead of treating it as inert; counts use the chain fact. forge-import records a merge with the upstream merge sha whenever the source says merged.

**Private repos.** `transition` has no `enc`: kinds, times and actors of state changes were already visible (private-repos.md §7), and a sealed kind could not be judged or counted. The counts of a private repo are public, as every count query is.

## 4. Non-deletable audit types

Protocol 14 checks references on create and replace only; **a delete is never reference-checked**. Any owner can delete their own document of a deletable type, even after their membership is revoked. The types whose deletion would rewrite history are therefore non-deletable:

- `refUpdate`, `protectedRefUpdate`: otherwise the author of a tip could delete it and silently rewind the branch;
- `config`: as-of protection evaluation needs every historical config;
- `packManifest`, `manifestPart`: otherwise a revoked writer could delete the index of packs other people's refs point into;
- `event`, `authorEvent`, `transition`, `issue`, `patch`, `repo`: see §3, and `repo` is the target of every `permanentDocument` reference;
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
  - **"Plaintext or `enc`, not both, not neither"**: since C-1, forge-collab's `issue`, `patch`, `comment`, `review`, `milestone` and `event` carry protocol-14 beta.5 `propertyConstraints` that enforce what one document can show: with `enc`, none of its plaintext fields (`noPlain`); without `enc`, its required plaintext field (`hasTitle`, `hasBody`); and every optional plaintext string has `minLength: 1`, so an empty string can no longer stand in for "absent". What consensus still cannot see is the repository's `visibility` (another contract's document), so "a private repo's document is sealed" stays a client rule, `is_well_formed` (vectors `well_formed__*`), as do all of forge-core's types (their rules are fixed at creation; forge-core is only ever updated in place). Each kind has plaintext fields and at most one required one: `issue` (`title` required, `body`), `patch` (`title` required, `body`, `baseRefName`, `sourceRefName`), `comment` (`body` required), `review` (`body`, optional: a review's content is its verdict and `commitOid`, which are never encrypted), a ref update (`refName` required), `config` (`defaultBranch`, `protectedPatterns`, neither required). In a **public** repo a document is well-formed when it has no `enc` and has its required field, if its kind has one. In a **private** repo it is well-formed when it has a non-empty `enc`, an `epoch`, and none of its plaintext fields, so a private repo's `refUpdate` carrying a plaintext `refName` is malformed. An empty string, or an empty `protectedPatterns` list, counts as absent. Clients skip a malformed document, and every other rule (approvals included) only sees well-formed ones.
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
| Issue / PR state | consensus (§3.1): a `transition` is accepted only as a legal move from the target's current state, and a merge only from a member (`asAuthor = 0`). The state is the target's proved `delta` sum |
| Event actor authorization | consensus at create time (§3): `event` is M/W only, `authorEvent` is the target's author with the review kinds only. **Merge reachability is a rule**: `merge` needs `oid` reachable from the base tip, and the base must have been a branch when the PR was opened (`pr_base_tips`, vectors `pr_base_tips__*`, `fold_pr_v2__merge_into_base_*`): a base with no valid tip at the patch's `$createdAt` (never pushed, or deleted then) has no tips, so a merge into a branch created later never counts. The fold reads the base the patch was opened against (`baseRefName`, at its `$createdAt`), so a retarget does not change it. This applies to merge events already on chain: a PR that read as merged because its merge created its base now reads open. **Readers check membership, never ancestry** (D-602, vectors `fold_pr_v2__merge_naming_a_later_base_tip_on_base`, `fold_pr_v2__merge_naming_a_non_tip_ancestor_labelled`, `fold_pr_v2__merge_after_reopen`; on the fresh registration a recorded merge stays merged, and a merge whose `oid` never was a base tip is labelled "merge commit not found on the base" instead of inert, D-9): "reachable from the base tip" is proved by `oid` having been a valid tip of the base, so a merge commit that is an ancestor of a tip without ever being one does not count. A commit-graph walk per PR in a list would need pack reads for every row. So a writer that knows ancestry names a tip: `dg pr merge` names the commit it pushed to the base, and `forge-import` (whose source's merge commit is rarely a tip the mirror pushed) names the newest base tip on chain that contains the merge commit (`git merge-base --is-ancestor` in its local mirror, after that run's push; a run that syncs no code fetches the base branches' commits for the check and pushes nothing). When no mirrored tip contains it (the base is not mirrored, or was deleted), the importer records a close instead. It never writes a close after a counted merge, and a PR a previous import recorded closed takes the merge event on a later run (only a merged PR is final; the importer's incremental state is versioned, so the first run after an upgrade revisits every item). The base history is re-read for up to ~20 s when the chain does not show the tip this run pushed yet, so a node's read-after-write lag does not record a fresh merge as a close. Clients refuse to open a PR against a base that is not a branch, and `dg pr merge` and the browser merge refuse to push to a base that does not exist (it would create it) |
| Repository listing | the `repo` document is the listing; its `$ownerId` is the owner |
| Owner lock-out prevention | client rule: the owner self-enrols as maintainer in the same session that creates the repo |
| Concurrent-push divergence, newest-wins resolution, ref-name glob matching, overlay | client rules (the base rules, shared by every client). Ref resolution (`resolve_ref`, vectors `resolve_ref__*`) folds a ref's valid updates in consensus-clock order (`$createdAt`, required on both ref update types); only inside one block does the `prevOid` chain order them (an update naming another's tip comes after it), then `$id`, a chain cycle inside one block being broken at the smallest-`$id` update that waits on nothing outside its own cycle (every update it builds on builds back on it). A `prevOid` names a commit, not a document, and a ref can hold the same commit twice (`A → B → force A`), so a chain match against a newer update is no causal link; the fold only lets a later update supersede an earlier one, and a ref whose newest update names a commit is never unborn |
| Issue and PR numbering | consensus: dense, shared by issues and PRs (§6.2) |
| PR approvals | client rule (`count_approvals`, vectors `approvals__*`): `review` is un-gated. Its input is the PR's reviews filtered by `is_well_formed` (§5) first. A review counts only if it is on the PR's current head (the folded head: the newest `headUpdate`, else `patch.headOid`) and its reviewer had a current `maintainer`/`writer` document created at or before the review's `$createdAt`. Each reviewer's newest counting approve (1) or request-changes (2) review by `($createdAt, $id)` stands; comment (3), unknown verdicts and dismissed reviews (`reviewDismiss`) neither count nor clear. A revoked reviewer's document is gone, so their reviews stop counting. A member's approval of their own PR counts (§3, known design choices) |
| Review comments belong to their review | consensus: `comment.reviewId`'s `where` (`$ownerId`, `repoId`, the review's `patchId` = the comment's `targetId`). Readers also filter by owner (`group_review_comments`) |
| Branch policy (required approvals, approver role, checks, merge methods) | client rule in the merge box (`meets_policy`). The `policy` document is maintainer-gated at consensus, but nothing at consensus requires approvals, and a maintainer can override |
| Open / closed / merged / draft counts | consensus-backed: differences of proved counts of `transition` kinds (§6.1) |
| CI run progression | consensus: `checkRun` is monotonic (queued → in progress → completed, with `startedAt` / `completedAt` set once, and a completed run final); which runs a branch policy trusts stays a client rule (`checks_state`) |

### 6.1 Counts

A provable `COUNT(*)` needs a `countable` or `rangeCountable` index whose properties the query's `==`/`in` clauses cover exactly (Platform book, `drive/document-count-trees.md`, "Choosing What to Set"), or cover all but the last property of a `rangeCountable` index. The second form is in rs-drive v4.2.0-beta.4 (`DriveDocumentCountQuery::find_countable_index_for_where_clauses`, "prefix-to-last", and `point_lookup_count_path_query`) but not yet in the book, which still describes exact coverage only; the live test (`forge-web/lib/repo/v2.live.test.ts`) exercises it. What the contracts count:

| Count | Query | Index |
|---|---|---|
| Issues / PRs ever opened in a repo (open and closed) | `repoId ==` | `issue.perRepo` / `patch.perRepo` `(repoId)` countable |
| Transitions of each kind in a repo | `repoId == R and kind in [1, 2, 11, …, 17]`, `groupBy [kind]` (one request, one proof; an absent kind reads 0) | `transition.perRepoKind (repoId, kind)` countable |
| A page of targets' states | `sum(delta)` where `targetId in [page]`, `groupBy [targetId]` (a missing entry is state 0) | `transition.perTarget (targetId)` summable |
| Issues / PRs by an author | `$ownerId == A and repoId == R` (prefix-to-last) | `author` rangeCountable |
| Chunks (the estimator ceiling) | the type total | `chunk` `documentsCountable` |
| CI runs updated since | `repoId == R and $updatedAt >` (documents, not a count) | `checkRun.updated` |
| Comments on an issue or PR | `targetId ==` (or `in` for a list page: one entry per target) | `comment.target (targetId, $createdAt)` rangeCountable |
| Reviews on a PR | `patchId ==` / `in` | `review.patch (patchId, $createdAt)` rangeCountable |
| Stars, followers (forge-community) | `repoId ==`, `identityId ==` | `star.byRepo`, `follow.byTarget` countable |

A composite query (`documents.composite`, Platform 4.2) can prove a page of PRs plus a `counts` sub-query per type (bound from `$id` to `targetId` / `patchId`) under one merged proof. The count sub-query uses the same index picker, so these indexes serve it.

**Open, closed, merged and draft counts are differences of proved counts.** Every stored transition is a legal move, so per target the closes and reopens strictly alternate, and with `I`, `P` the issue and PR totals and `c_k` the count of kind-`k` transitions:

| Number | Formula |
|---|---|
| issues closed | `c1 − c2` |
| issues open | `I − (c1 − c2)` |
| PRs merged | `c13` |
| PRs closed (not merged) | `(c11 − c12) + (c16 − c17)` |
| PRs draft (open) | `(c14 − c15) − (c16 − c17)` |
| PRs open (GitHub's tab, drafts included) | `P − c13 − (c11 − c12) − (c16 − c17)` |

So the header is three requests (the two `perRepo` counts and the grouped `perRepoKind` count), each O(1) and proved, and a list page is one documents query plus one sum query for its rows' states. Filtered counts (by label, assignee, milestone) are still folds over `event`.

**Requested reviewers** are also a fold (the newest request or remove per identity), so nothing counts them. `event.addressee (refId)` / `authorEvent.addressee` find the requests addressed to one identity (readers sort by `$createdAt`).

### 6.2 Numbering: dense, shared, chain-enforced

`issue` and `patch` carry the rule

```json
"dense": { "ifThen": [
  { "equal": ["$createdAtBlockHeight", "$updatedAtBlockHeight"] },
  { "equal": ["number", { "add": [
      { "countOf": ["issue", { "repoId": "repoId" }] },
      { "countOf": ["patch", { "repoId": "repoId" }] } ] }] } ] }
```

answered by the countable `perRepo (repoId)` index on both types. On create the totals include the new document, so a repo's first issue or PR is **#1**, the next **#2**, and issues and PRs **share one sequence**, as on GitHub. The guard makes it a create-only rule (both heights are required; a replace in a later block is not re-judged).

- **No squatting, no gaps.** No number exists without a document at exactly `count + 1`; the old ceiling allocator (`allocate_number`, its trusted-number step and its vectors) is retired.
- **Races.** Two creators in one block: the second is refused by `dense` (10422 naming `dense`, before the unique-index check) as a nonce bump, and retries with `count + 1`. Across blocks a stale write is refused free at CheckTx. A client reads the two `perRepo` counts, writes `I + P + 1`, and retries on a `dense` refusal.
- **Griefing.** A stranger can only advance the sequence by creating real issues at the spam floor; they cannot reserve, skip or block a number.

**Mirrors.** forge-import imports issues and PRs **in upstream order**, so a fresh mirror of a source without deleted items numbers identically. The source's number goes in the optional, immutable `upstreamNumber` (top-level, because a `skipIfAbsent` property must be; the index `upstream (repoId, upstreamNumber)` skips native documents). After the first upstream gap the numbers diverge, and readers show "#12 · upstream #7761". `#7761` in a mirrored body resolves through the `upstream` index, trusted only from the mirror signer or a member (ISS-02). An incremental run refuses to start when an earlier upstream item is missing.

**Repository names** (`is_valid_repo_name`, `normalize_repo_name`, vectors `repo_name__*`). A name is valid when it matches the contract's pattern `^[a-z0-9][a-z0-9._-]{0,62}$` in full; a trailing newline does not match. Clients lowercase ASCII `A`–`Z` in user input before checking, and change nothing else, so `Dash-Forge` names `dash-forge`. Other characters are not folded: `é`, or the Kelvin sign that Unicode lowercases to `k`, leaves the name invalid.

**Conformance.** `FORGE_RULES_V2` is `forge-core::rules::v2` (Rust) and `forge-web/lib/rules/v2.ts` (TypeScript). The shared vectors in `forge-contracts/vectors/` are dispatched on their `rules` field: a vector without one tests a base rule (ref resolution, protected-pattern matching, display ref name, overlay, verdict mapping), which `FORGE_RULES_V2` builds on, and `"rules": "v2"` tests one of the rules below:

| Rule | Functions | Vectors |
|---|---|---|
| Issue/PR state (§3.1): the transition sum and the feed fold for labels, assignees and head | `fold_issue_state_v2`, `fold_pr_state_v2` | `fold_issue_v2__*`, `fold_pr_v2__*` (reshaped to transitions with the client work) |
| A PR's base history (§6 merge reachability) | `merge_base_tips`, `pr_base_tips` | `merge_base_tips__*`, `pr_base_tips__*` |
| Membership | `RoleOracle::{role_at, member_at, current_role}` | through `approvals__*` |
| Pack reader rule (§4) | `order_pack_copies`, `select_pack_copy`, `pack_read_order` | `pack_copies__*` |
| Pack list / `packRef` space (§4) | `v2_pack_list` | `v2_pack_list__*` |
| Approvals (dismissed reviews skipped) | `count_approvals` | `approvals__*` |
| Review state: folded head, requested reviewers, resolved threads, dismissals, milestone | `fold_pr_review_v2` | `fold_review_v2__*` |
| Branch policy | `meets_policy` | `policy__*` |
| Inline anchors: file-level, line, range | `anchor_of` | `anchor__*` |
| A review's comments | `group_review_comments` | `review_group__*` |
| Suggestion blocks | `parse_suggestions`, `apply_suggestion` | `suggestion__*` |
| Linked issues, `fixes #n` | `linked_issues` | `linked_issues__*` |
| Required checks: the newest trusted run per name on the head (maintainer, writer or runner), `requiredChecks` or `requireChecks` (platform-parity-spec §2.6) | `checks_state` | `checks__*` |
| A thread's milestone, pin and lock (kinds 17–22) | `fold_thread_meta_v2` | `thread_meta__*` |
| The repo's pinned issues and PRs | `pinned_targets` | `pinned__*` |
| Milestones: newest definition per title, with open / closed counts | `fold_milestones_v2` | `milestones__*` |
| Trending: the window a ranked read covers, and the ranking recomputed from the beats (§4 of the parity spec) | `trending_window`, `trending_recount` | `trending__*` |
| Plaintext xor `enc` (§5) | `is_well_formed` | `well_formed__*` |
| Repository names | `is_valid_repo_name`, `normalize_repo_name` | `repo_name__*` |
| Private content: key derivation, ref-name hashes, `enc` seal/open with the ref-name hash check and the late-content rule (private-repos.md §2–§4, §8) | `EpochKeys::derive`, `ref_name_hash`, `open_content`, `is_late` | `private_kdf__*`, `private_ref_hash__*`, `private_doc_seal__*`, `private_doc_open__*`, `private_hedge__*` |
| Sealed artifacts (§3) | `pack::{seal, open, open_streaming}`, `PackHeader::{sealed_range, open_range}` | `private_pack_seal__*`, `private_pack_open__*`, `private_pack_range__*` |
| Wraps (§5.1) | `wrap::{plaintext, parse, check_against_anchor}`, `platform::wrap::{seal_wrap, open_wrap}` | `private_wrap_seal__*`, `private_wrap_open__*` |
| Anchors, current epoch, chain walk, alerts, repair check (§5.3–§5.6) | `resolve_epochs` (`select_anchors`, `current_epoch`, `chain_walk`, `repair_check`) | `private_epoch__*` |

The v2 fold takes no membership input: an `event`'s existence is its authorization. `RoleOracle` answers "was X a member at time t" from the repo's *current* `maintainer`/`writer` documents, so a revoked member (whose document was deleted) is not a member at any time, and a re-added member counts from their new document. The repoKey reader rule of §5 is `resolve_epochs`, a pure function over flattened rows with `private_epoch__*` vectors; `comment.path` is a content field of `is_well_formed` (vector `well_formed__private_comment_plaintext_path`).

## 7. Measured size and cost

From `tools/contract-validate` (rs-dpp v4.2.0-beta.7, `PlatformVersion` 14) and the beta.7 gate (`dash-forge-qa/design/final-schema/`). The signed-shape transitions carry a 65-byte recoverable signature and the contract group fields.

| | forge-core | forge-collab | forge-community |
|---|---|---|---|
| Document types / indexes | 14 / 30 | 8 / 25 | 8 / 16 |
| Serialized contract | 14,329 B | 15,671 B | 8,134 B |
| Signed create transition | **14,509 B** | **15,777 B** | **8,240 B** |
| vs `max_state_transition_size` (20,480 B) | 70.8 % | 77.0 % | 40.2 % |
| Headroom for later in-place updates | ≈ 5.9 KB | ≈ 4.7 KB | ≈ 12.2 KB |
| Fee (fee schedule v3: 0.1 base + 0.02/type + 0.01/index) | **0.68 DASH** | **0.51 DASH** | **0.42 DASH** |

**Each contract's size is a lifetime budget.** A `DataContractUpdate` carries the whole contract, so every later in-place update (a new optional property, a new type) must fit under 20,480 B. The split into three contracts keeps at least 3 KB of headroom in each (the wipe brief's floor).

`estimated_contract_max_serialized_size` (16,384 B) is not a limit. It is the size Drive's fee *estimation* assumes when it prices reading a stored contract (`apply_contract_with_serialization` v0). All three contracts are under it anyway.

Total one-time registration fees are **≈ 1.61 DASH**, paid once by the deployer, plus storage. A new repository is three documents (`repo`, the owner's `maintainer`, the first `config`), about 0.001 DASH in storage by the 27,000 credits/byte rate. `dg repo create` quotes an upper bound of 0.002 DASH before signing and reports the measured cost afterwards. The costs measured on the beta.7 chain are recorded here after the wipe (`dash-forge-qa/WIPE-PLAN.md` §3 step 8).

## 8. Deploying

```sh
(cd forge-contracts/sdk-v2 && npm ci)
node forge-contracts/scripts/deploy-v2.mjs --self-test
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --dry-run
# re-register forge-collab (or forge-community) alone (new id) against the recorded forge-core
# and group:
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --only collab --force-new --same-group [--dry-run]
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --only community --force-new --same-group [--dry-run]
# re-register all three (new forge-core, new group, new forge-collab and forge-community) after a
# forge-core change the update rules refuse:
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --force-new [--dry-run]
# update the recorded forge-core in place (DataContractUpdate, next version; same id and group):
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --update core [--dry-run]
# would an in-place DataContractUpdate from the registered schema be accepted instead?
git show <commit it was registered from>:forge-contracts/contracts/forge-collab.json > /tmp/registered-forge-collab.json
cargo +1.98.1 run -q --locked --manifest-path tools/contract-validate/Cargo.toml -- \
     forge-contracts/contracts/forge-core.json forge-contracts/contracts/forge-collab.json \
     --previous /tmp/registered-forge-collab.json forge-contracts/contracts/forge-community.json
```

- forge-core's create transition registers the contract group (`dash-forge`) and enrols forge-core as a whole contract.
- forge-collab's and then forge-community's transitions enrol them in the same group. The group id is `hash_double("contract_group" ‖ owner ‖ nonce)` of forge-core's transition. Once all three are registered the script checks on chain that the group exists, that the deployer owns it, and that every contract is enrolled.
- Results go to the `v2` section of `deployments/<network>.json` (`devnet-<name>.json` for a devnet). Each step's nonce (masked to its low 40 bits, as rs-dpp does), contract id, group id derived from that same nonce, and pre-broadcast balance are written before broadcasting. A rerun that finds the contract on chain completes the record (status, cost, owner) rather than skipping it; one whose reserved nonce never landed takes the chain's next nonce and re-derives both ids from it. It never registers a second copy unless told to. Each record also carries `schemaHash`, the sha256 of the schema JSON (after placeholder substitution, compactly re-serialized) it was registered from; a rerun that finds a recorded contract whose hash differs from the current schema warns and leaves it as is. A dry run's forge-core step is not checked against a leftover record.
- `--force-new` without `--only` supersedes the set when the recorded forge-core was registered from a different schema: forge-core's record moves to `v2.forgeCoreSuperseded`, the group to `v2.contractGroupSuperseded`, forge-collab and forge-community (whose schemas name forge-core's id) to `v2.forgeCollabSuperseded` / `v2.forgeCommunitySuperseded`, and a new forge-core (registering a new group), forge-collab and forge-community are registered. A rerun after success registers nothing.
- `--only collab` / `--only community` registers that contract alone, against the forge-core and group already recorded and found on chain; it never registers forge-core or the other one. With `--force-new --same-group` it registers a new one when the recorded one is registered from a different schema (its `schemaHash` differs, or it predates the field): the old record moves to `v2.forgeCollabSuperseded` (or `v2.forgeCommunitySuperseded`), and the new one takes the next nonce and so a new id. A recorded contract from the current schema, or one still `broadcasting` (an interrupted run, which is completed or retried instead), is never superseded, so rerunning the same command registers nothing. This is how a schema change the update rules refuse ships. Documents written under the old contract stay under its id.
- The script refuses a CRITICAL key that is missing, different from the identity file, or disabled on chain.
- **Devnet moutai** is re-registered at the beta.7 wipe (the runbook is `dash-forge-qa/WIPE-PLAN.md` §3): forge-core, forge-collab and forge-community fresh, in that order, in one new group, then the key-exchange copy (`deploy-key-exchange.mjs`) and `snapshot-contracts.mjs`. The ids are recorded in `deployments/devnet-moutai.json`. The contracts registered on the beta.6 chain (forge-core `A2KL77ng…`, forge-collab `C1zHeeG7…`, group `6dV3kMBW…`) use the pre-beta.7 spelling and cannot be loaded by a beta.7 node or client; the history of earlier registrations is in git.
- For mainnet (roadmap D-D, D-J), decide on `config.readonly` before registering, since it cannot be added afterwards (§4).

What the offline validator cannot check, and registration will: that forge-core exists in state when forge-collab registers (the validator uses the in-memory contract), the deployer's identity and balance, and the contract-group state rules (the group is new; the signer owns the group a membership names).

### Contract group trust

A limited key is bound to the `dash-forge` contract group, and a group-bound key can sign documents for **every member** of the group, including members added after the key was registered. Binding a key therefore trusts whoever can add members. On protocol 14 that is only the group's owner or one of its admins:

- A member joins in the create transition of its own contract (`contract_group_memberships`). drive-abci (`data_contract_create/state/v1`) accepts the join only when the signer is the group's owner or an admin (`ContractGroupOwner::may_add_members`). A contract cannot enrol another contract, and no other transition adds members.
- The owner and admins are fixed when the group is registered. No transition changes them, and memberships are creation-only.

So `dg` and the web app pin the **trust root**, not the member list. Before offering to bind a key to the group (before the confirmation prompt), each one checks, with every read proof-verified:

1. **Owner pin.** `getContractGroupInfo` returns the owner recorded in the bundled `deployments/<network>.json` (`v2.contractGroup.owner` when its `id` is the current group, else forge-core's `ownerId`), and **no admins** (`deploy-v2.mjs` registers none). A different owner, any admin, or a missing group is refused. With this pin, consensus alone guarantees that every member was created by the Forge deployer.
2. **The current set.** forge-core, forge-collab and forge-community are whole-contract members. This is checked before any member contract is read.
3. **Member owners, as a cross-check.** Every other member (a whole contract, a document type or a token) should belong to a contract whose `$ownerId` is the pinned owner. The client reads each unknown member contract, up to 64 of them, and refuses on a proof-verified owner mismatch.
4. **Unknown members are shown, not refused.** A member the client does not know passes and is listed before the key is confirmed. Examples are a newer forge-collab revision or a trending-index contract. `dg` prints a `note:` line (part of the key explanation, or right after the group check in `dg auth new`), and reports `unknownGroupMembers` in `--json` output. The web app shows the note on the key-creation screen. The note reads "newer Forge contract revision(s)", or "additional group member(s)" when a member is a document type or token of a contract the client already knows. Earlier contracts the deployment lists as superseded in the same group count as known.
5. **Strict mode (`dg` only).** `dg auth … --strict-group`, or `DASH_FORGE_STRICT_GROUP=1` for CI, accepts only the known set: the three current contracts and their superseded predecessors. Anything else is refused, and no member contract is read. The web app has no strict mode.

**Trade-off: a member the client cannot read is accepted.** A member contract that cannot be fetched or decoded (for example, a contract format newer than the installed binary) is accepted. The note names it ("could not read contract X; accepted because the group owner is pinned"), and `--json` lists it under `uncheckedGroupMembers`. The same applies to unknown members past the cap of 64. Rule 1 is what bounds a key: only the pinned owner can add members, and consensus enforces that, so rule 3 adds no security that rule 1 lacks. Refusing on a read failure would turn every future contract format into an outage for every installed client, which is the failure this design removes. Only a proof-verified owner that differs from the pin is refused.

Registering a new Forge contract into the group (`deploy-v2.mjs --only collab --force-new --same-group`) therefore breaks no installed client. `--force-new` without `--only` also refuses to put a new forge-collab or forge-community into the existing group (when forge-core itself was not superseded) unless `--same-group` is given. Only a change of owner or admins does, and that would need a new group, and so a new deployment file.

## 9. Rules that changed from the brief

- **The author path is a `findBy` on a second unique index.** A permanent `findBy` needs a unique index that includes the writer. `issue` and `patch` therefore carry `author($ownerId, repoId, number)` next to `number(repoId, number)`, and `authorEvent`, `transition` (and `event`, for the target agreement) carry `targetNumber` so the key can be assembled. The id reference `targetId` is tied to it with `where {"$id": "targetId"}`.
- **`documentsKeepHistory` only on `issue` and `patch`.** Platform refuses history on a deletable type (the storage layer cannot delete such documents). `comment` stays deletable, so it has no history.
- **`repoKey` recipients are not required to be members**; see §5.
- **Author events are their own type** (`authorEvent`) rather than a third and fourth operand of `event`'s gate; see §3. State changes moved to `transition` (§3.1), whose four operands are all used.
- **Stars and follows are `indexOnly`** with a `$createdAt`-free proof index. "Who starred, newest first" is no longer ordered by time; star and follower counts and "did I star this" are O(1).
