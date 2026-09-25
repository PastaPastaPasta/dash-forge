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
| `repo` | anyone | yes; `name`, `visibility`, `forkOf` immutable | **no** (target of `permanentDocument` refs) | unique `($ownerId, name)`, rangeCountable (repos per owner); `name` `^[a-z0-9][a-z0-9._-]{0,62}$`; `forkOf` → permanent `repo` |
| `maintainer` | repo owner only (`repoId` → repo with `{"$ownerId":"$ownerId"}`) | no | yes (= revoke) | unique `(repoId, memberId)`; `memberId` → existing identity; index `memberId` |
| `writer` | repo owner only | no | yes (= revoke) | same shape as `maintainer` |
| `refUpdate` | M or W | no | **no** | `(repoId, refNameHash, $createdAt)` ref state, `(repoId, $createdAt)` reflog, `(repoId, $ownerId, $createdAt)` pusher |
| `protectedRefUpdate` | M | no | **no** | same indexes |
| `config` | M | no | **no** | append-only, newest wins; `protectedPatterns` and `backend.uris` are typed string arrays now |
| `packManifest` | M or W | no | **no** | unique `(repoId, packHash)`; `(repoId, $createdAt)` rangeCountable (pack count); `(repoId, kind, $createdAt)` |
| `manifestPart` | M or W | no | **no** | unique `(repoId, packHash, partSeq)` |
| `chunk` | M or W | no | yes (refund) | unique `(repoId, packHash, seq)`, rangeCountable (availability audit) |
| `release` | M or W | no | yes | newest per `(repoId, tagName)` wins |
| `label` | M or W | no | yes | newest per `(repoId, name)` wins |
| `repoKey` | M | no | **no** | private repos, §5 |

### forge-collab

References into forge-core carry `contractId`. The schema file holds the placeholder `FORGE_CORE_CONTRACT_ID`, and the deploy script replaces it with forge-core's id before registering.

| Type | Gate (create) | Mutable | Deletable | Notes |
|---|---|---|---|---|
| `issue` | anyone (fees are the spam floor) | yes, history kept; `repoId`, `number` immutable | **no** | unique `(repoId, number)` rangeCountable; unique `($ownerId, repoId, number)` (the author lookup `event` uses); `repoId` → permanent `repo` |
| `patch` (PR) | anyone | yes, history kept; `repoId`, `number`, `sourceRepoId` immutable | **no** | as `issue`, plus `sourceRepoId` → permanent `repo` (the fork holding the PR's objects), index `sourceRepoId` |
| `comment` | anyone | yes; `repoId`, `targetId` immutable | yes | `targetId` → permanent `issue` or `patch` of the same repo (`propertyAgreement` on `repoId`); `(targetId, $createdAt)` rangeCountable |
| `review` | anyone | no | yes | `patchId` → permanent `patch` of the same repo |
| `event` | M or W, **or the author of the target issue or PR** | no | **no** | §3 |
| `checkRun` | M or W | yes (status progression); `repoId`, `headOid`, `name` immutable | yes | a replace re-checks the gate, so a revoked runner cannot advance its runs |
| `webhook` | M | no | yes | `secret` is `encryptedFor` the relay identity's encryption key (§5) |
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

## 4. Non-deletable audit types

Protocol 14 checks references on create and replace only; **a delete is never reference-checked**. Any owner can delete their own document of a deletable type, even after their membership is revoked. The types whose deletion would rewrite history are therefore non-deletable:

- `refUpdate`, `protectedRefUpdate`: otherwise the author of a tip could delete it and silently rewind the branch;
- `config`: as-of protection evaluation needs every historical config;
- `packManifest`, `manifestPart`: otherwise a revoked writer could delete the index of packs other people's refs point into;
- `event`, `issue`, `patch`, `repo`: see §3, and `repo` is the target of every `permanentDocument` reference;
- `repoKey`: past epochs must stay readable to past members.

`chunk` stays deletable. Platform chunks are a cache of packs that can also live in the owner's storage, and repack must be able to reclaim storage. A revoked writer can delete the chunks they uploaded: the manifest survives, the chunk-count audit (`count(repoId, packHash) == chunkCount`, O(1) on the rangeCountable index) detects the gap, and any current writer re-uploads.

`release`, `label`, `webhook`, `checkRun`, `comment`, `review`, `star`, `follow` and `profile` stay deletable. Their resolution is newest-wins or per-author, so a deletion removes only the deleter's own contribution. Residual risk: a revoked maintainer can delete a release they published. Readers fall back to the next-newest release for that tag.

The contracts are **not readonly**, so the owner identity can still update them, within the protocol 14 update rules: indexes, `refersTo`/`ownerRefersTo`, `immutable` and `encryptedFor` are all frozen on update, so an update can add optional properties and new document types but cannot loosen an existing gate. **Readonly cannot be switched on later**: a config update to `readonly: true` is refused (`validate_update` v0, "contract can not be changed to readonly"). To make the final mainnet contracts readonly, set `config.readonly` in the JSON when registering them (§8).

## 5. Private repositories

A private repo is a `repo` with `visibility: "private"`; `visibility` is immutable. Consensus cannot hide data, so the key model is client-side, and the contract carries its envelope:

- **Content key per epoch.** A maintainer draws a 32-byte key for epoch 0 and wraps it for every member (the owner included) in a `repoKey` document `{repoId, memberId, epoch, recipientKeyId, senderKeyId, wrapped}`.
  - `wrapped` is `encryptedFor {recipient: memberId, recipientKey: recipientKeyId, senderKey: senderKeyId, scheme: ecdh-secp256k1-aes256-cbc}`. Consensus checks its shape: at least 32 bytes and a multiple of 16.
  - `memberId` carries `refersTo identityPublicKey` with `keyIdProperty: recipientKeyId` and `keyRequirements {purpose: encryption}`, and `senderKeyId` carries the owner form (`identityProperty: $ownerId`, purpose encryption). Consensus refuses a wrap to a key that does not exist, is disabled, or is not an encryption key.
  - Unique `(repoId, memberId, epoch)`; gated to maintainers; immutable and non-deletable.
  - Consensus cannot also require `memberId` to be a member: an `identityPublicKey` reference cannot be combined with other operands. Wrapping the key to a non-member amounts to leaking it, which a maintainer can always do anyway.
- **Rotation.** On removing a member, a maintainer posts epoch `n+1` wraps for the remaining members. Future content uses the new key. Past content stays readable to past members, and the product says so plainly.
- **Encrypted fields.** `issue`, `patch`, `comment` and `review` take `enc` (a byte array, AES-256-GCM under the epoch key, including title and body) plus `epoch`, and leave the plaintext `title`/`body` empty. `refUpdate`, `protectedRefUpdate` and `config` take the same `enc`/`epoch` pair.
  - A private ref update puts `refName` inside `enc` and sets `refNameHash = HMAC-SHA256(epoch key, refName)`, so ref names cannot be recovered by dictionary. `refName` is optional for this reason.
  - `dependentRequired {enc: [epoch]}` makes consensus refuse ciphertext without an epoch.
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
| Issue and PR numbering | unchanged in spirit, see below |

**Numbering.** A unique `(repoId, number)` and optimistic max+1 would let a spammer post issue #4294967295 and stop allocation. v2 clients allocate `count(repoId) + 1`, using the rangeCountable `number` index (an O(log n) provable count), and on a collision probe upward to the first free number. A squatted number costs the squatter a document fee and the allocator one retry.

**Holdings vectors.** The `holdings__*` conformance vectors (token-history reconstruction) and the as-of-authorization parts of the `fold_*` vectors no longer apply to v2 repos. They stay for reading v1 repos. New v2 vectors are membership-existence facts plus the unchanged kind rules.

## 7. Measured size and cost

From `tools/contract-validate` (rs-dpp v4.2.0-beta.4, `PlatformVersion` 14). The signed-shape transitions carry a 65-byte recoverable signature and the contract group fields. The deploy script's dry run built the same transitions with the evo-sdk wasm, signed them, and got the same byte counts.

| | forge-core | forge-collab |
|---|---|---|
| Document types / indexes | 12 / 25 | 10 / 21 |
| Serialized contract | 11,691 B | 11,199 B |
| Signed `DataContractCreate` v1 | **11,854 B** | **11,305 B** |
| vs `max_state_transition_size` (20,480 B, the hard limit) | 57.9% | 55.2% |
| Registration fee (fee schedule v3: 0.1 base + 0.02/type + 0.01/index) | **0.59 DASH** | **0.51 DASH** |

`estimated_contract_max_serialized_size` (16,384 B) is not a limit. It is the size Drive's fee *estimation* assumes when it prices reading a stored contract (`apply_contract_with_serialization` v0). Both contracts are under it anyway.

Total one-time registration fees are **1.10 DASH**, paid once by the deployer, plus storage. A new repository is now three documents (`repo`, the owner's `maintainer`, the first `config`), about 0.001 DASH in storage by the 27,000 credits/byte rate, compared with ~1.18 DASH for a v1 repo contract. This estimate still needs confirming on moutai.

## 8. Deploying

```sh
(cd forge-contracts/sdk-v2 && npm ci)
node forge-contracts/scripts/deploy-v2.mjs --self-test
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
     --network devnet --devnet-name moutai --dry-run
```

- forge-core's create transition registers the contract group (`dash-forge`) and enrols forge-core as a whole contract.
- forge-collab's transition enrols it in the same group. The group id is `hash_double("contract_group" ‖ owner ‖ nonce)` of forge-core's transition.
- Results go to the `v2` section of `deployments/<network>.json` (`devnet-<name>.json` for a devnet). Each step's nonce and id are written before broadcasting, so rerunning the same command resumes, and it never registers a second copy.
- The dry run against moutai (2026-09-25) confirmed protocol 14 and drive 4.2.0-beta.4 there. The contracts are not registered yet: no deployer identity exists on moutai.
- For mainnet (roadmap D-D, D-J), decide on `config.readonly` before registering, since it cannot be added afterwards (§4).

What the offline validator cannot check, and registration will: that forge-core exists in state when forge-collab registers (the validator uses the in-memory contract), the deployer's identity and balance, and the contract-group state rules (the group is new; the signer owns the group a membership names).

## 9. Rules that changed from the brief

- **The event author path is a lookup on a second unique index.** A permanent lookup needs a unique index that includes the writer. `issue` and `patch` therefore carry `author($ownerId, repoId, number)` next to `number(repoId, number)`, and `event` carries `targetNumber` so the lookup key can be assembled. The id reference `targetId` is tied to it with `{"targetId": "$id"}`.
- **`documentsKeepHistory` only on `issue` and `patch`.** Platform refuses history on a deletable type (the storage layer cannot delete such documents). `comment` stays deletable, so it has no history.
- **`repoKey` recipients are not required to be members**; see §5.
- **Stars and follows are `indexOnly`** with a `$createdAt`-free proof index. "Who starred, newest first" is no longer ordered by time; star and follower counts and "did I star this" are O(1).
