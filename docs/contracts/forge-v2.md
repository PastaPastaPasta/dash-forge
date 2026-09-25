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
| `issue` | anyone (fees are the spam floor) | yes, history kept; `repoId`, `number` immutable | **no** | unique `(repoId, number)` rangeCountable; unique `($ownerId, repoId, number)` (the author lookup `event` uses); `repoId` → permanent `repo` |
| `patch` (PR) | anyone | yes, history kept; `repoId`, `number`, `sourceRepoId` immutable | **no** | as `issue`, plus `sourceRepoId` → permanent `repo` (the fork holding the PR's objects), index `sourceRepoId` |
| `comment` | anyone | yes; `repoId`, `targetId` immutable | yes | `targetId` → permanent `issue` or `patch` of the same repo (`propertyAgreement` on `repoId`); `(targetId, $createdAt)` rangeCountable |
| `review` | anyone | no | yes | `patchId` → permanent `patch` of the same repo; clients count approvals only from M/W holders (§6) |
| `event` | M or W, **or the author of the target issue or PR** | no | **no** | §3 |
| `checkRun` | M or W | yes (status progression); `repoId`, `headOid`, `name` immutable | yes | a replace re-checks the gate, so a revoked runner cannot advance its runs |
| `webhook` | M | yes (`url`, `events`, `secret`, `disabled`); `repoId`, `hookId` immutable | yes | the creating maintainer toggles `disabled` or edits in place; a replace re-checks the gate, so a revoked maintainer cannot re-enable a hook. Another maintainer supersedes it with a newer doc for the same `hookId` (newest wins) or asks the creator to delete. `secret` is `encryptedFor` the relay identity's encryption key (§5) |
| `profile` | anyone | yes | yes | one per identity |
| `star` | anyone | no | yes (unstar) | `indexOnly`: `(repoId)` countable = star count; `($ownerId)` with terminal `repoId` = my stars; one star per (repo, identity) is structural |
| `follow` | anyone | no | yes (unfollow) | `indexOnly`: follower and following counts are both countable; `identityId` → existing identity, `distinctFrom: $ownerId` |

Shared shapes (`id`, `oid`, `h32`, `refName`, `body`, `enc`, …) are in `schemaDefs` and referenced with `$ref`. A document type may use each `$defs` entry **once**: rs-dpp's depth walker treats a second `$ref` to the same definition in one type as a cycle (`InvalidJsonSchemaRefError`). The same goes for the `integer` shape of a key id named by `encryptedFor` or `keyIdProperty`, which must be inline (the parser's `is_key_id_schema` resolves `$ref` against the document schema, which has no `$defs`). Repeats are inlined for these reasons.

## 3. Events, and what "authorization survives revocation" means

`event` (close, reopen, merge, label, assign, retarget, draft, ready) is gated by one `ownerRefersTo` expression with four operands, the protocol maximum:

1. a `maintainer` for `repoId` (deletable lookup into forge-core),
2. a `writer` for `repoId`,
3. the author of the target issue: the lookup `author($ownerId = writer, repoId, number = targetNumber)` on `issue`, with `propertyAgreement {"targetId": "$id"}`, so the issue found must be the one the event targets,
4. the same for `patch`.

`targetId` itself must be an `issue` or `patch` whose `repoId` and `number` equal the event's `repoId` and `targetNumber`. Membership of repo A cannot authorize an event on repo B's issue, and the author of issue #3 cannot act on issue #4.

Operands 3 and 4 are `permanentDocument` lookups, so `issue` and `patch` must be non-deletable (registration rejects a permanent lookup into a deletable type with 40122). That is why issues and PRs can no longer be deleted for a refund.

Events are immutable and non-deletable, and the gate is judged at creation. **An event's existence therefore proves its writer was authorized at its block time.** Revoking a maintainer later does not invalidate their past events, and nothing has to be reconstructed from token history.

**Kinds are authorized by kind and role, client-side.** Consensus admits an event from any of the four operands, whatever its `kind`. The fold (`forge-core::rules::actor_authorized`, `FORGE_RULES_V1`, and the `fold_issue__*` / `fold_pr__*` conformance vectors) then decides per kind:

| kind | who may apply it |
|---|---|
| close, reopen | M, W, or the target's author |
| merge | M or W, and `oid` reachable from the base tip |
| label+, label−, assign, unassign, retarget, draft, ready | M or W |

An author's `label` or `merge` event exists on chain but is inert. For v2, "M or W" means a `maintainer`/`writer` document for the repo existed when the event was created. The gate already proves that for operands 1 and 2, so a client can tell which operand held by looking the membership up as of the event's `$createdAt` (membership docs carry `$createdAt`; a deleted one is found in the reader's cache or the operand is assumed to be the author path).

## 4. Non-deletable audit types

Protocol 14 checks references on create and replace only; **a delete is never reference-checked**. Any owner can delete their own document of a deletable type, even after their membership is revoked. The types whose deletion would rewrite history are therefore non-deletable:

- `refUpdate`, `protectedRefUpdate`: otherwise the author of a tip could delete it and silently rewind the branch;
- `config`: as-of protection evaluation needs every historical config;
- `packManifest`, `manifestPart`: otherwise a revoked writer could delete the index of packs other people's refs point into;
- `event`, `issue`, `patch`, `repo`: see §3, and `repo` is the target of every `permanentDocument` reference;
- `chunk`: the pack bytes themselves (owner decision 2026-09-25: an unbreakable repo outweighs the refund);
- `repoKey`: past epochs must stay readable to past members.

**Platform-tier storage is permanent.** A chunk once written stays, so bring-your-own storage (S3-compatible, IPFS) is the cheap default and Platform chunks are the tier you pick for packs that must outlive every bucket. Consequences:

- **Repack on the Platform tier only consolidates.** It writes a superseding pack (a new `packManifest` with `supersedes`, new chunks) and deletes nothing. Readers prefer the consolidated pack; the old one stays readable.
- **`dg repack` / GC must change**: today they delete superseded chunks and manifests for the refund (`crates/dg`, `forge-core::pack`). On v2 those deletes are refused at consensus, so the delete step goes, and GC applies only to external storage the user controls.

**Front-running.** Every pack-write unique index includes `$ownerId` (`packManifest (repoId, $ownerId, packHash)`, `manifestPart (…, partSeq)`, `chunk (…, seq)`). Without it, the first writer to claim a `(repoId, packHash)` would own that slot forever: a hostile writer could post a manifest with the right hash and wrong content, or one chunk, and block the honest upload. With it, each writer has its own slot. **Reader rule:** for a `packHash`, gather every writer's manifest (`(repoId, packHash)` index), verify the reassembled bytes against `packHash`, use the first that verifies, and try maintainers' copies before writers'. A copy that fails verification is ignored.

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
  - **"Plaintext or `enc`, not both, not neither" is a client rule.** `propertyConstraints` compare integer expressions only and cannot test whether a string is present, and the meta-schema admits no `oneOf`/`not` at the document-type level. Clients treat an `issue`/`patch` with neither `title` nor `enc`, a `comment`/`review` with neither `body` nor `enc`, or a private repo's `refUpdate` carrying a plaintext `refName`, as malformed and skip it.
  - Packs are encrypted before upload (Platform chunks or external storage). Oids, sizes and timing stay visible.
- **What a stranger can still do.** Issues and PRs are un-gated, so anyone can post plaintext into a private repo's namespace. Clients show only documents that decrypt under a key the reader holds, or that come from a member.

The concrete AEAD layout, key derivation and test vectors are Phase 3 work and need their own security review (roadmap Phase 3). The contract fields above are what that design writes into.

## 6. What moves from client rules to consensus

| v1 (client rules / `FORGE_RULES_V1`) | v2 |
|---|---|
| Push authorization: WRITE token spend | consensus: `ownerRefersTo` M or W |
| Protected refs: MAINTAIN spend on `protectedRefUpdate` | consensus: M gate. **Routing stays a rule**: consensus cannot read `protectedPatterns`, so a plain `refUpdate` naming a protected ref still exists and is inert by the as-of config rule |
| Revocation: freeze (+ destroy) | delete the `maintainer`/`writer` document; the next write is refused (40120) |
| Event actor authorization, reconstructed as-of from token history | consensus at create time (§3). **Kind rules stay**: an author may only close or reopen their own target, and `merge` needs M or W plus `oid` reachable from the base tip. Consensus admits any kind from an author, so the fold still ignores an author's `label`/`merge` |
| Listing authenticity (listing owner == repo contract owner) | gone: `repo` is the listing |
| Owner lock-out prevention (`baseSupply`) | client rule: the owner self-enrols as maintainer in the same session that creates the repo |
| Concurrent-push divergence, newest-wins resolution, ref-name glob matching, overlay | unchanged, still rules |
| Issue and PR numbering | client rule, see below |
| PR approvals | client rule: `review` is un-gated, and only reviews by M/W holders (as of the review's `$createdAt`) count toward approval |

**Numbering (client rule, to implement).** Numbers are unique per repo at consensus, but anyone can claim any number, so allocation must tolerate gaps and hostile claims. A max+1 rule breaks as soon as someone posts #4294967295. The rule:

1. `n` = the provable count of the repo's issues (rangeCountable `number` index).
2. `ceiling` = `2 × n + 100`.
3. `base` = the largest existing number ≤ `ceiling` (a range query on the `number` index, descending, limit 1), or 0.
4. Allocate `base + 1`; if taken, probe upward to the first free number ≤ `ceiling`, then above it.

A number above the ceiling cannot be reached without the repo actually growing to about half that many issues, so a squatter at 2³²−1 (or anywhere far ahead) is ignored. Gaps below the ceiling are simply skipped. Squatting a number just ahead of the allocator costs the squatter a document fee and the allocator one retry. Issues and PRs number independently.

**Conformance.** The kind-and-role rule of §3, the numbering rule above, the pack reader rule of §4, and the repoKey reader rule of §5 are `FORGE_RULES_V2` rules. Each needs conformance vectors before a client ships on v2.

**Holdings vectors.** The `holdings__*` conformance vectors (token-history reconstruction) and the as-of-authorization parts of the `fold_*` vectors no longer apply to v2 repos. They stay for reading v1 repos. New v2 vectors are membership-existence facts plus the unchanged kind rules.

## 7. Measured size and cost

From `tools/contract-validate` (rs-dpp v4.2.0-beta.4, `PlatformVersion` 14). The signed-shape transitions carry a 65-byte recoverable signature and the contract group fields. The deploy script's dry run built the same transitions with the evo-sdk wasm, signed them, and got the same byte counts.

| | forge-core | forge-collab |
|---|---|---|
| Document types / indexes | 12 / 26 | 10 / 21 |
| Serialized contract | 11,761 B | 11,208 B |
| Signed `DataContractCreate` v1 | **11,924 B** | **11,314 B** |
| vs `max_state_transition_size` (20,480 B, the hard limit) | 58.2% | 55.2% |
| Registration fee (fee schedule v3: 0.1 base + 0.02/type + 0.01/index) | **0.60 DASH** | **0.51 DASH** |

`estimated_contract_max_serialized_size` (16,384 B) is not a limit. It is the size Drive's fee *estimation* assumes when it prices reading a stored contract (`apply_contract_with_serialization` v0). Both contracts are under it anyway.

Total one-time registration fees are **1.11 DASH**, paid once by the deployer, plus storage. A new repository is now three documents (`repo`, the owner's `maintainer`, the first `config`), about 0.001 DASH in storage by the 27,000 credits/byte rate, compared with ~1.18 DASH for a v1 repo contract. The per-repo figure is an estimate still to be measured on moutai.

**Measured on devnet moutai (2026-09-25)**, as the deployer's balance change:

| | forge-core | forge-collab |
|---|---|---|
| Total cost | 0.605711 DASH (60,571,079,360 credits) | 0.515157 DASH (51,515,695,120 credits) |
| of which the registration fee | 0.60 | 0.51 |
| storage + processing | 0.0057 | 0.0052 |

Together that is **1.120868 DASH**.

## 8. Deploying

```sh
(cd forge-contracts/sdk-v2 && npm ci)
node forge-contracts/scripts/deploy-v2.mjs --self-test
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --dry-run
```

- forge-core's create transition registers the contract group (`dash-forge`) and enrols forge-core as a whole contract.
- forge-collab's transition enrols it in the same group. The group id is `hash_double("contract_group" ‖ owner ‖ nonce)` of forge-core's transition.
- Results go to the `v2` section of `deployments/<network>.json` (`devnet-<name>.json` for a devnet). Each step's nonce (masked to its low 40 bits, as rs-dpp does), contract id, group id derived from that same nonce, and pre-broadcast balance are written before broadcasting. A rerun that finds the contract on chain completes the record (status, cost, owner) rather than skipping it; one whose reserved nonce never landed takes the chain's next nonce and re-derives both ids from it. It never registers a second copy.
- The script refuses a CRITICAL key that is missing, different from the identity file, or disabled on chain.
- **Registered on devnet moutai** (protocol 14, drive 4.2.0-beta.4) on 2026-09-25 by the moutai DEPLOYER `8HGxMu4atPn4jThH5h9X1MajzhoD3PRnzCRGrAsFcLcV`. The ids are recorded in `deployments/devnet-moutai.json`, and the script checked on chain that the group exists, that the deployer owns it, and that both contracts are enrolled:
  - forge-core `GdZYaEntYPiW9dvUGCHyeqN7H7qEocbSkuj81n341i3L` (nonce 1)
  - forge-collab `9fCcSGF3UmajGCNHuuDGz2ou3Gm3EXhrwB3SRS9ocm4Y` (nonce 2)
  - contract group `23iVLZABbVQ5a4heSa6GLVbVqSWr74JTSESSMTEYNd6o` (`dash-forge`)
  - A rerun found both on chain and broadcast nothing.
- For mainnet (roadmap D-D, D-J), decide on `config.readonly` before registering, since it cannot be added afterwards (§4).

What the offline validator cannot check, and registration will: that forge-core exists in state when forge-collab registers (the validator uses the in-memory contract), the deployer's identity and balance, and the contract-group state rules (the group is new; the signer owns the group a membership names).

## 9. Rules that changed from the brief

- **The event author path is a lookup on a second unique index.** A permanent lookup needs a unique index that includes the writer. `issue` and `patch` therefore carry `author($ownerId, repoId, number)` next to `number(repoId, number)`, and `event` carries `targetNumber` so the lookup key can be assembled. The id reference `targetId` is tied to it with `{"targetId": "$id"}`.
- **`documentsKeepHistory` only on `issue` and `patch`.** Platform refuses history on a deletable type (the storage layer cannot delete such documents). `comment` stays deletable, so it has no history.
- **`repoKey` recipients are not required to be members**; see §5.
- **Stars and follows are `indexOnly`** with a `$createdAt`-free proof index. "Who starred, newest first" is no longer ordered by time; star and follower counts and "did I star this" are O(1).
