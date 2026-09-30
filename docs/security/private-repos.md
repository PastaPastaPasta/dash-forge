# Private repositories: key model, framing and rules

Status: design for roadmap Phase 3, revision 2 after an independent cryptographic review ("sound, with changes needed"; every finding is addressed, see §14). Implementers: `crates/forge-core/src/private.rs` (the `RepoCodec`, `RefNameHasher`, `PackCipher`, `RepoKeyReader` seams), `git-remote-dash`, `dg`, and `forge-web/lib/private/`. The contract fields this design writes into are fixed in `docs/contracts/forge-v2.md` §5 and `forge-contracts/contracts/forge-core.json` (`repoKey`, `enc`/`epoch` on `refUpdate`, `protectedRefUpdate`, `config`) and `forge-collab.json` (`enc`/`epoch` on `issue`, `patch`, `comment`, `review`). §13 lists the schema changes this design needs before mainnet registration. §16 specifies sealed releases within the registered RC1 `release` schema; no client implements it yet. Where this document and §5 differ, this document wins and §5 is to be updated with it.

Everything below is normative unless marked as a note. Byte layouts are exact; all integers are big-endian; `‖` is concatenation; `u8`/`u16`/`u32`/`u64` are 1, 2, 4 and 8 bytes.

## 1. Goal and non-goals

Consensus cannot hide data, so privacy is client-side: a private repo's content (pack bytes, ref names, issue/PR/comment/review text, config) is encrypted under a per-repo key that only members hold. The gate the contract enforces (`repoKey` and `config` are maintainer-only) is what stops a non-maintainer from *distributing* keys or *declaring* epochs through the contract; the encryption is what stops everyone else from *reading*; the reader rules in §5 are what stop a former maintainer from doing either after removal.

Phase 3 gate (roadmap): an outsider with full bucket and chain access learns nothing but sizes and timing. §7 lists exactly what "nothing but" means. We do **not** aim for forward secrecy against a removed member for anything they could already read, deniability, hiding the repo's existence, or protecting content from a maintainer who is a maintainer *now* (who by construction can hand the key to anyone).

## 2. Key hierarchy

### 2.1 Epoch key

One repo has a sequence of **epochs** `e = 0, 1, 2, …` (`u32`, contiguous from 0: an epoch exists only if every epoch below it does, §5.3). Each epoch has a 32-byte **epoch key** `K_e`, drawn from the OS CSPRNG (`getrandom` / `crypto.getRandomValues`) by the maintainer who creates the epoch. Nothing is derived from a password or from an identity key; `K_e` is independent of every other epoch's key.

### 2.2 Subkeys

All uses of `K_e` go through HKDF-SHA256 (RFC 5869):

```
PRK_e            = HKDF-Extract(salt = repoId (32 B), IKM = K_e)      = HMAC-SHA256(key = repoId, msg = K_e)
subkey(label, x) = HKDF-Expand(PRK_e, info = "dash-forge/v2/" ‖ label ‖ 0x00 ‖ u32(e) ‖ x, L = 32)
```

| Subkey | label | x | Used for |
|---|---|---|---|
| `K_doc,e` | `doc` | (empty) | AES-256-GCM of document `enc` fields (§4) |
| `K_ref,e` | `ref` | (empty) | HMAC-SHA256 ref-name hashing (§4.5) |
| `K_pack,e,f` | `pack` | `0x01` (header version) ‖ `fileId` (16 B) | AES-256-GCM of one sealed artifact (§3) |
| `KCV_e` | `kcv` | (empty) | first 14 bytes = the epoch's key-check value (§5.1) |
| `COMMIT_e` | `commit` | (empty) | the 32-byte key commitment carried by anchors (§4.2, §5.3) |
| `K_hedge,e` | `hedge` | (empty) | RNG hedging for nonces and file ids (§3.6) |
| `K_tag,e` | `tag` | (empty) | HMAC-SHA256 of a sealed release's tag, its plaintext `tagName` (§16.1) |

The salt binds every subkey to the repo, so a key accidentally wrapped into two repos still yields different subkeys, and the label/epoch in `info` separates purposes and epochs. There are no commit- or tree-level keys: the unit of pack encryption is the whole artifact, as the browse plane already reads packs by byte range.

### 2.3 Key identifiers

An epoch number identifies a key everywhere the contract needs one (`epoch` on documents, `epoch` on `repoKey`, `epoch` in the pack header). `KCV_e` is an *error-detection* code (it tells "wrong key" from "corrupt data" and lets the UI name a key: "epoch 3 · `7cab1ab7…`"); it is not an authentication tag and never authorizes anything. `COMMIT_e` is the *key commitment* an anchor carries; it is what a reader checks a wrap against. No other key id exists.

## 3. Sealed artifacts (packs, locators, flat indexes)

Every `packManifest` artifact of a private repo, whatever its `kind` (0 git pack, 1 objectLocator, 2 flatIndex, 3 history index, 4 release assets (§16.5), …), is stored **sealed**. The plaintext is the exact bytes a public repo would store, so `git index-pack`, `ObjectLocator::parse` and the flatIndex reader are unchanged after decryption.

### 3.1 Cipher

AES-256-GCM (96-bit nonce, 128-bit tag), in **segments** so a reader can decrypt any byte range without the rest of the file (the STREAM construction, as `age` uses it).

Why AES-GCM rather than XChaCha20-Poly1305: the browser decrypts packs for the browse plane, and AES-GCM is native in WebCrypto (`crypto.subtle`, hardware-accelerated, off the JS heap) while XChaCha would run in JavaScript through `@noble/ciphers` at a tenth of the speed on multi-megabyte packs. Rust has `aes-gcm` with AES-NI. GCM's short nonce is the reason for the per-file key in §3.3: nonces are counters under a key used for one file only, so misuse is structurally impossible. AES-GCM is not key-committing; §4.2 adds an explicit commitment where that matters (anchors), and packs are bound to an epoch by the header and to a key by the anchor chain, so a split-view attack on a pack is caught at the document layer rather than the pack layer.

### 3.2 Layout

```
offset  size  field
0       4     magic            "DFPK" (0x44 0x46 0x50 0x4b)
4       1     version          0x01
5       1     segLog2          L; segment size S = 2^L. Writers MUST use L = 14 (S = 16 KiB). Readers accept 10 ≤ L ≤ 20.
6       2     reserved         MUST be 0x0000; a reader refuses anything else
8       4     epoch            u32 e
12      8     plaintextLen     u64, exact byte length of the plaintext
20      16    fileId           per sealed artifact, §3.6
36      …     segments         nSeg = max(1, ceil(plaintextLen / S)) segments
```

Segment `i` (0-based) covers plaintext bytes `[i·S, min((i+1)·S, plaintextLen))` and is stored as `ciphertext ‖ tag(16)`, so every segment but the last is exactly `S + 16` bytes. A zero-length plaintext has exactly one segment of 16 bytes (an empty ciphertext with a tag). Sealed length is therefore `36 + plaintextLen + 16·nSeg`.

```
nonce_i = u64(i) ‖ 0x00 0x00 0x00 ‖ final          final = 0x01 for the last segment, else 0x00
AD      = the 36-byte header
```

### 3.3 Per-file key

`K_pack,e,fileId = HKDF-Expand(PRK_e, "dash-forge/v2/pack" ‖ 0x00 ‖ u32(e) ‖ 0x01 ‖ fileId)`. The header version byte is part of the domain string so a future layout cannot reuse a key with the same `fileId`. `fileId` is 16 bytes unique per artifact (§3.6), so two artifacts never share a key, the counter nonces never repeat, and re-sealing the same plaintext produces a different ciphertext and a different `packHash`.

### 3.4 `packHash` and the manifest

**`packHash = SHA-256(sealed bytes)`**, the ciphertext hash. Reasons: the pack reader rule and `dg reseed` must let anyone (a reseeder, a mirror auditor, a non-member with a bucket) verify a copy against its manifest without keys; a plaintext hash would let an observer confirm that a private repo holds a known public pack (content-equality oracle) and would give storage nothing to check. Plaintext integrity comes from the per-segment tags, then from git's own pack checksum and object ids.

The manifest is written as for a public repo except:

- `sizeBytes` is the sealed length (what the storage holds; it is what chunking and ranged reads count).
- `objectCount`, `chunkCount`, `kind`, `tips`, `supersedes`, `uris`, `storage` are as today. `tips` are OIDs, visible anyway in `newOid` (§7).
- `offsetIndexParts` is 0 (it is 0 on every kind already; `manifestPart` is never written), except on a history index (kind 3), where it is the index's format version (0 = v1, 2 = with per-path version lists). That is plaintext metadata, like `kind`: it says which layout the sealed artifact has, nothing about its content.

**Reseed copies sealed bytes.** `dg reseed`, `packMirror` and every other re-upload path copy the sealed artifact verbatim; nothing ever re-seals, since a re-seal would change `packHash` and orphan every locator row pointing at the pack.

The **objectLocator rows index plaintext offsets** (they are part of the git pack view). Ranged reads map plaintext ranges to sealed ranges (§3.5). The locator artifact is itself sealed; the browse reader does a ranged read of segment 0 for the fanout header (1024 B), then one more range for the 1/256 slice, exactly as today with one indirection.

### 3.5 Reading and ranged reads

Before any allocation or decryption the reader checks, in order:

1. `sealedLen` (the byte length the storage reports, or the sum of chunk payloads) equals the manifest's `sizeBytes`; otherwise the copy failed verification.
2. The 36-byte header: magic, `version = 0x01`, `10 ≤ L ≤ 20`, `reserved = 0`, and `36 + plaintextLen + 16·nSeg == sealedLen` with `nSeg` computed from `plaintextLen`. Any mismatch is `SealedPackCorrupt`.
3. The header's `epoch` is one the reader holds a key for (§5); otherwise `Unreadable(NoKey)`.

Then each needed segment's tag is checked, with the `final` flag set only on segment `nSeg−1`. A failed tag, a segment count that does not match `plaintextLen`, or a trailing byte after the last segment is `SealedPackCorrupt`; the copy is then treated like a copy that failed `packHash` verification in the pack reader rule (forge-v2.md §4): skipped, next copy tried.

For a plaintext range `[a, b)` of an artifact with segment size `S`:

```
s0 = a >> L ;  s1 = (b − 1) >> L
sealedRange = [36 + s0·(S+16), min(36 + (s1+1)·(S+16), sealedLen))
```

A ranged reader **fetches the header first** (one 36-byte read, or the first segment's range extended to start at 0) and caches it per `(packHash, copy)` for the session, **only after a segment tag has verified under it** (the header is every segment's AD, so a verified tag authenticates it) and after checking it against the manifest's `sizeBytes`; a `SealedPackCorrupt` copy's entry is evicted. A ranged read cannot check `packHash`, so a header cached before any tag verified would let one hostile copy poison every honest copy of the pack for the session. It never derives a key or nonce from a header it has not read. It decrypts segments `s0..=s1`, concatenates, slices `[a − s0·S, b − s0·S)`, inflates, applies deltas, and **checks the reconstructed object's git OID against the OID it looked up** before returning it; an OID mismatch is `SealedPackCorrupt` for that copy. Over Platform chunks, the sealed range maps to `chunk.seq` by the existing 14,700-byte payload arithmetic; over HTTP/S3/IPFS it is an HTTP `Range`. A blob's `deltaChainSpan ≤ 64 KiB` read costs at most five 16 KiB segments, so the "3–5 requests, O(view) bytes" cold-load budget in `docs/architecture.md` holds with roughly 1.1× the bytes.

### 3.6 Randomness: hedged file ids and nonces

`fileId` (§3.2) and every document nonce (§4.1) are drawn through an RNG hedge, so a weak or repeating CSPRNG cannot repeat a nonce under a key:

```
fileId     = HMAC-SHA256(K_hedge,e, 0x01 ‖ rnd(32) ‖ SHA-256(plaintext))[0..16]
doc nonce  = HMAC-SHA256(K_hedge,e, 0x02 ‖ rnd(32) ‖ AD ‖ SHA-256(plaintext))[0..12]
```

`rnd(32)` is fresh CSPRNG output. Production `seal` APIs (`PackCipher::seal`, `RepoCodec::seal`, and their TypeScript equivalents) take **no** caller-supplied `fileId` or nonce; the deterministic variants used to produce the §11 vectors live behind a test-only constructor (`#[cfg(test)]` / a `vectors` build flag that release builds do not set).

## 4. Encrypted document fields

### 4.1 `enc` layout, version 0x01 (issue, patch, comment, review, event, refUpdate, protectedRefUpdate)

```
enc = 0x01 ‖ nonce(12) ‖ AES-256-GCM(K_doc,e, nonce, plaintext, AD) ‖ tag(16)
```

Minimum length 29 bytes (schema `minItems` 28 admits it). Maximum plaintext per type is `maxItems − 29`: **5091 bytes** for collab types, **1507 bytes** for `refUpdate`/`protectedRefUpdate` under the forge-core `enc.maxItems` of 1536 (§13; 995 bytes under the earlier 1024).

### 4.2 `enc` layout, version 0x02 (config, always)

Every private `config` is a candidate anchor (§5.3), and AES-GCM does not commit to its key, so `config` carries an explicit commitment:

```
enc = 0x02 ‖ COMMIT_e(32) ‖ nonce(12) ‖ AES-256-GCM(K_doc,e, nonce, plaintext, AD) ‖ tag(16)
COMMIT_e = HKDF-Expand(PRK_e, "dash-forge/v2/commit" ‖ 0x00 ‖ u32(e), 32)
```

A reader **compares `COMMIT_e` against the commitment derived from its own key before running GCM**; a mismatch is `CommitMismatch`, not `BadTag`, and is surfaced as in §5.4. Overhead is 61 bytes; the maximum config plaintext is 1475 bytes under the 1536-byte cap of §13 (963 bytes under the earlier 1024).

### 4.3 Plaintext: TLV

The plaintext is a sequence of records `tag(u8) ‖ len(u16) ‖ value`. No JSON: key order, escaping and number formatting differ across Rust and TypeScript, and a deterministic encoding keeps the conformance vectors byte-exact.

| tag | field | type | in | cap (from the public schema) |
|---|---|---|---|---|
| 1 | `title` | UTF-8 | issue, patch | 1–256 chars, ≤ 1024 B |
| 2 | `body` | UTF-8 | issue, patch, comment, review, release (its `notes`) | ≤ 5120 chars and bytes |
| 3 | `refName` | UTF-8 | refUpdate, protectedRefUpdate | 1–255 B |
| 4 | `baseRefName` | UTF-8 | patch | 1–255 B |
| 5 | `sourceRefName` | UTF-8 | patch | 1–255 B |
| 6 | `defaultBranch` | UTF-8 | config | 1–255 B |
| 7 | `protectedPattern` | UTF-8, **repeatable**, order kept | config | 1–100 chars each, ≤ 8 records |
| 8 | `prevEpoch` | u32 | config, `e ≥ 1` | exactly 4 B |
| 9 | `prevEpochKey` | bytes | config, `e ≥ 1`, not burned | exactly 32 B |
| 10 | `path` | UTF-8 | comment (inline review comment) | ≤ 500 chars, ≤ 1000 B |
| 11 | `burned` | the single byte `0x01` | config, `e ≥ 1` | exactly 1 B, value `0x01` |
| 12 | `skipEpochKey` | bytes | config, `e ≥ 1`, not burned | exactly 32 B |
| 13 | `importedAuthor` | UTF-8 | issue, patch, comment, review, release (`imported.author`) | 1–120 chars, ≤ 480 B |
| 14 | `importedUrl` | UTF-8 | issue, patch, comment, review, release (`imported.url`) | 1–300 B |
| 15 | `eventValue` | UTF-8 | event (`value`: a label or milestone name, a dismiss reason, an assignee, a retarget base) | 1–120 chars, ≤ 480 B |
| 16–21 | a release's `tag`, `name`, `targetOid`, flags, `importedCreatedAt`, `assetManifest` | see §16.2 | release only | §16.2 (a release also carries tags 2, 13 and 14) |

**Strictness** (any violation is `Malformed`):

- Records are in strictly ascending tag order, except that consecutive tag-7 records repeat; any other repeated tag is malformed.
- A record whose declared `len` runs past the end of the plaintext, or fewer than 3 trailing bytes after the last complete record, is malformed. There are no padding bytes.
- Tags 22–63 are **reserved**: a record with one is malformed. Tags 64–255 are **extension** tags: a reader skips them (forward compatibility) and never interprets them. (Tags 16–21 were reserved before §16; they are release-only, so in every other kind they are still malformed, as "not listed for the kind" below.)
- A tag not listed for the document's kind (tag 3 in an issue, say) is malformed. Tags 11 and 12 are allowed only in a config with `e ≥ 1` (never epoch 0); tag 11's only value is the one byte `0x01`. A **burned** config (tag 11) carries `prevEpoch` but neither `prevEpochKey` nor `skipEpochKey`: its key may sit with someone who never held the key below it.
- Every UTF-8 value must be valid UTF-8, within the cap above, and non-empty unless the cap says otherwise; a zero-length record for a field with `minLength 1` counts as absent. Fixed-size tags must be exactly their size.
- Required fields by kind: issue/patch `title`; comment `body`; event `eventValue` (an event without a value is not sealed, see §7); refUpdate/protectedRefUpdate `refName`; every config with `e ≥ 1`, anchor or not, `prevEpoch`, and unless burned `prevEpochKey` (neither is allowed when `e = 0`): any config of an epoch can become its anchor when an earlier one's author stops being a maintainer (§5.3), and it must then still chain to the previous epoch, so a writer copies the anchor's whole chain link (`prevEpoch`, `prevEpochKey`, `skipEpochKey`, the burned flag) into every later config of the epoch; review and epoch-0 config have none. An empty plaintext is therefore valid only for a review or an epoch-0 non-anchor config.
- Combined size: the `enc` cap (5120) minus the v0x01 framing (29) minus 3 bytes per TLV record the type carries: issue title + body ≤ 5085 bytes; PR title + body + `baseRefName` + `sourceRefName` ≤ 5079; comment `body` + `path` ≤ 5085; review body ≤ 5088. An imported document's `imported.author` / `imported.url` (tags 13, 14) share the same `enc`, so they reduce what is left for the text. The web app and `dg` enforce them before encrypting and say so in the composer (vectors `private_collab_seal__*_at_cap` / `*_over_cap`).

### 4.4 Associated data

```
AD = "dash-forge/v2/doc" ‖ 0x00 ‖ enc[0] ‖ repoId(32) ‖ $ownerId(32) ‖ u32(epoch) ‖ docType(ASCII) ‖ 0x00 ‖ bind
```

`enc[0]` is the version byte (`0x01` or `0x02`), so a ciphertext cannot be re-framed under another version. `docType` is the contract's type name (`issue`, `patch`, `comment`, `review`, `event`, `refUpdate`, `protectedRefUpdate`, `config`, `release`). `bind` is the type's immutable plaintext identity:

| type | bind |
|---|---|
| issue, patch | `u32(number)` |
| comment, event | `targetId` (32) |
| review | `patchId` (32) |
| refUpdate, protectedRefUpdate | `refNameHash` (32) ‖ `oidf(newOid)` ‖ `oidf(prevOid or empty)` ‖ `force` (0x00/0x01) |
| config | `COMMIT_e` (32) |
| release | the document's `tagName` string, as its 43 ASCII bytes (§16.2) |

`oidf(x) = u8(len(x)) ‖ x`. Binding `repoId`, `$ownerId`, `epoch` and the type means a ciphertext lifted from one document cannot be replayed as another: not by an outsider into a new comment in the same repo (different `$ownerId`), not into another repo, not under another type or epoch. `$ownerId` is safe to bind because these nine types are not transferable; making one transferable would be a breaking change to this design. The ref-update binding ties the hidden name to the visible tip, so a stored `enc` cannot be re-used to name a different ref for the same OID. The document's `$id`, `$createdAt` and `$createdAtBlockHeight` are not bound (unknown at encryption time).

### 4.5 Ref-name hashing, and the hash check on read

Private: `refNameHash = HMAC-SHA256(K_ref,e, refName)` with `e` the epoch the update is written under; `patch.baseRefNameHash` and `sourceRefNameHash` likewise under the patch's epoch. Public: `sha256(refName)` (unchanged).

On read, after decryption, `open_content` **recomputes the hash from the decrypted name and compares it with the document's plaintext hash field**: `refNameHash` against tag 3 for ref updates; `baseRefNameHash` against tag 4 and `sourceRefNameHash` against tag 5 for a patch. A hash field that is present requires its name in `enc` (a patch indexed under a base branch it does not name is exactly the disagreement this check prevents); an absent hash field is not checked. A mismatch, or a present hash whose name is missing, is `Malformed` (vectors `private_doc_open__patch_*_hash_without_name`). Without this check a writer could index an update under one branch's hash while naming another inside `enc`, and a reader resolving refs from `enc` and a reader resolving from the `refState` index would disagree.

**A patch keeps its epoch.** A PR's ref-name hashes are immutable (the review-parity forge-collab freezes `baseRefNameHash`, `baseRefName`, `sourceRefNameHash`, `sourceRefName`), and they are HMACs under the patch's epoch, so a title/body edit re-seals `enc` under the **same** `epoch` the patch was created with; re-sealing under a newer epoch would fail this check and make the PR `Malformed`. The consequence, stated plainly: an edit to a PR opened before a rotation is readable by members removed by that rotation (they hold its key), exactly as the original text was. And it is judged late by `$updatedAtBlockHeight` (§8.2): once its author is no longer a member, an edit made after the rotation's grace period makes the PR `Unreadable(LateEdit)` for everyone. `dg pr edit` says so before it signs when the PR's epoch is older than the repo's. Issues and comments carry no ref-name hash; their edits re-seal under the current epoch like any new write. An edit re-seals the **whole** content it read (the untouched fields, a comment's `path`, an importer's author and URL carried over), through the same transform as a create (`private_collab_seal`), and the replace sets only `enc` / `epoch`. The CLI guards every edit with the revision it read: a replace against a newer stored revision is refused (`E607`), so an edit never silently drops a concurrent one (the web guards issue and PR edits the same way, "changed since you opened it"; its comment edits get the guard in review-parity PR 3). The CLI also clears any plaintext `title` / `body` an older client left next to `enc`, and refuses a document whose `repoId` is not the repository named (so the document's own repository, never the caller's argument, decides whether the edit is sealed). The CLI's is `Collab::update_target` / `update_comment` (`reseal_edit`); the web's is `sealEdit`.

The hash is **per epoch**, so a removed member cannot confirm by dictionary that a branch created after their removal exists. The cost: one ref's history spans several hash values across epochs. Readers resolve ref state from the decrypted `refName` over the reflog index `(repoId, $createdAt)`, as the v2 reader does today; a targeted lookup of one ref (`refState` index) is one query per epoch the reader holds, and rotations are rare.

## 5. Wrapping, anchoring and membership

### 5.1 The `repoKey` wrap

`wrapped` uses `encryptedFor` exactly as the contract declares (`ecdh-secp256k1-aes256-cbc`): shared key `SHA-256(parity ‖ x)` of `senderPriv · recipientPub`, random 16-byte IV, AES-256-CBC with PKCS#7. Implementations call the SDK helpers rather than re-implementing it: Rust `dash_sdk::platform::encrypted_for::{encrypt_property, decrypt_property, EncryptedPropertyEnvelope::read}`; TypeScript `sdk.encryptedFor.encrypt / decrypt / envelope` (evo-sdk `4.2.0-beta.7`, `WasmSdk.encryptDocumentProperty` etc.). They read the declaration from the contract, write `recipientKeyId`/`senderKeyId`, and refuse a wrong-shaped ciphertext.

The wrap plaintext is **47 bytes**, padded to 48, so `wrapped` is always **64 bytes** (16 IV + 48):

```
0x01 ‖ KCV_e(14) ‖ K_e(32)
```

CBC has no tag. The version byte and `KCV_e` are **error detection**: after decryption, recompute `KCV_e` from the recovered `K_e` (§2.2) and compare; a mismatch means wrong keys or corrupt bytes (`WrapUnreadable`), never a protocol violation. They do not authenticate the wrap; only the anchor check in §5.4 does. Widening `KCV` to 14 bytes costs nothing (the padded block was mostly padding) and makes an accidental false positive negligible.

Keys: the **sender** is the wrapping maintainer's identity key with purpose `ENCRYPTION` (the contract's `senderKeyId` reference demands it; `DECRYPTION`-purpose keys are refused by consensus); the **recipient** is the member's `ENCRYPTION` key named by `recipientKeyId` (the `memberId` reference requires purpose `encryption`). Both are `ECDSA_SECP256K1`, security level MEDIUM (the only level Platform allows for these purposes). A reader decrypts with its own `ENCRYPTION` private key and the sender's public key; the sender can read its own wraps back with its private key and the recipient's public key.

### 5.2 Encryption keys: derivation, custody, blast radius, rekey

Most identities have no `ENCRYPTION` key. Adding one is an `IdentityUpdate` signed by the master key: `dg auth keys add --encryption`, or the web app's Settings → Keys → "Enable private repos".

**Derivation.** Where the identity comes from a seed, the encryption private key is derived under a hardened Forge-specific branch of the identity's key tree whose last element is a hardened **key index** `k'`: the exact path constants are fixed when `dg auth keys add --encryption` is implemented, but the invariant is normative: `k` starts at 0, every rekey uses `k+1`, and the path is hardened at every level, so a leaked key `k` gives no information about key `k+1` and a mnemonic restore can re-derive every key it ever had by walking `k` upward until it finds no matching public key on the identity. An identity created from a raw key gets a random encryption key and is told to back it up. Contract bounds on the key are a hint only; writers use the highest-id **enabled** `ENCRYPTION` key of the recipient and record the id they used.

**Multi-device.** All devices of an identity share its encryption private key, so one wrap per member suffices. The browser vault (ux-dx-spec §2.3) therefore holds the encryption private key alongside the limited AUTH key: the limited key cannot decrypt anything. The encryption key cannot sign, so a vault compromise exposes reading, not writing.

**Blast radius, stated plainly.** ECDH is symmetric, so an identity's encryption private key decrypts **every wrap it received and every wrap it sent**. For a plain member that is every epoch of every private repo they belong to. For a maintainer it is additionally every epoch key they ever wrapped for anyone: a compromised maintainer encryption key exposes every repo they maintain. The UI says: "This key can read every private repo you're a member of, and every key you've handed out as a maintainer."

**Rekey flow** (`dg auth keys rotate --encryption`; web Settings → Keys → "Replace my private-repo key"). Order matters:

1. Add the new encryption key `k+1` (master-key `IdentityUpdate`). Do **not** disable the old key yet.
2. For every repo where the identity is a **current maintainer** (its `maintainer` documents, via the `memberId` index): run the rotation of §5.5 with the new key as the self-wrap recipient (the new epoch key is wrapped to every member's highest enabled encryption key, the rotator's included).
3. For every repo where the identity is only a **writer**, or a member of a repo it does not maintain: nothing can be written; the client shows "ask a maintainer to rotate". Maintainers' clients detect it through the repair check in §5.6 (a wrap to a key that is now disabled, or a member with no wrap to an enabled key, fails the check) and rotate on their next visit.
4. Disable the old key `k` (master-key `IdentityUpdate`). From here, wraps to `k` are unreadable by this identity; the chain from any new-epoch anchor still reaches old content (§5.3).

A user who disables first and rotates later loses nothing (old epochs are reachable through the chain from any epoch they receive later) but is locked out until a maintainer rotates.

### 5.3 Epoch anchors and the current epoch

The **anchor** of epoch `e` is the first `config` document, by **`($createdAtBlockHeight, $id)`**, with `epoch = e` **whose `$ownerId` is a current maintainer** (`RoleOracle::current_role == Maintainer`), whether or not the reader can open it. `$createdAt` is written by the client (within a consensus tolerance) and is never used to order anchors; `$createdAtBlockHeight` is set by the network. **`$id` is compared as its raw 32 bytes** (lexicographically, as Platform orders identifiers), never as a base58 or hex string: base58 strings of 32-byte ids are 43 or 44 characters long, so string order and byte order disagree, and two clients (or a writer confirming it is first, §5.5 step 4) could pick different anchors at the same block height (vector `private_epoch__anchor_tie_by_raw_id_bytes_not_base58`). **For `e ≥ 1` a config counts only if it comes strictly after `stated(e − 1)` in that order**: the first config for `e − 1` (itself after `stated(e − 2)`), by anyone, that carries the commitment of `anchor(e − 1)` — the moment that epoch's key was first stated on chain. A config posted before the epoch below it had its key is never an anchor, whoever wrote it and whatever their role later becomes: no honest flow pre-posts (a rotation posts `n+1` after `n`'s anchor exists; a re-anchor is for an existing epoch), and this closes the whole family of pre-posted configs that would otherwise become anchors once the epochs below them fill in or their author is granted the maintainer role again (vectors `private_epoch__preposted_future_config_ignored`, `…__preposted_config_ignored_after_regrant`, `…__preposted_after_other_key_ignored`). It is measured from the key's first statement rather than from the selected anchor because `config` history is fixed while membership changes: re-anchoring epoch `e` (same commitment, later height) after its anchor's author is removed must not make epoch `e + 1` stop existing (`…__reanchor_of_middle_epoch_keeps_epochs_above`). `$createdAtBlockHeight` is set by consensus, so every node orders these configs the same way; at equal heights the raw-byte `$id` decides (`…__anchor_tie_at_same_height_after_prev_by_id`). `config` is maintainer-gated and non-deletable, so an anchor is a maintainer's durable statement "epoch `e` uses the key committed here"; the current-maintainer condition means that statement lapses with the maintainer's membership.

**Epochs are contiguous.** Epoch 0 exists when it has an anchor; epoch `e ≥ 1` exists when it has an anchor **and epoch `e − 1` exists**. A current maintainer's config for an epoch above the first missing number is not an anchor: the reader raises an **`EpochGap`** alert naming its author and ignores it, and its wraps and content are those of a non-existent epoch (vectors `private_epoch__epoch_gap_ignored`, `…__chain_with_skipped_epoch_number`, `…__chain_prev_epoch_without_anchor`). A config at a huge epoch number therefore cannot exhaust the epoch space (`…__huge_epoch_from_current_maintainer_is_a_gap`), and a since-removed maintainer's configs are no candidates at all (`…__huge_epoch_from_removed_maintainer_ignored`). The **current epoch** is the highest existing epoch, and a new epoch is always **current + 1**. The anchor of epoch `e ≥ 1` carries tag 8 `prevEpoch`, with **`prevEpoch = e − 1`** required, and, unless it is burned, tag 9 `prevEpochKey`: the previous epoch's key encrypted under the new one.

**Burned epochs.** A rotation may find that the key it must use for `n+1` has already reached someone outside the remaining members (its own earlier run's wrap, §5.5). It then wraps `K_{n+1}` to every remaining member (so any maintainer sees the burn and can finish it; nothing is ever sealed under a burned key), anchors `n+1` with tag 11 **`burned`** and **no `prevEpochKey`**, and at once rotates on to `n+2`. A burned anchor never carries the key below it: the burned key may sit with someone who never held `K_n`, and would hand it to them (`…__burned_anchor_has_no_prev_key`). The next anchor that is not burned carries `prevEpochKey` (the burned epoch's key) and tag 12 **`skipEpochKey`**: the key of the nearest epoch below the burned run that is not burned, so the chain steps over the run (`…__skip_key_walks_past_burned`, `…__consecutive_burned_skip`); epochs inside a run of several burned epochs stay unreadable through the chain, and nothing is sealed under them. An anchor whose `prevEpoch` is burned and that carries no valid `skipEpochKey` is `ChainBroken` (`…__missing_skip_key_chain_broken`). The flag of an epoch is the flag of its **anchor**; every config of a burned epoch carries it, so a re-anchor keeps it (`…__burned_flag_only_on_the_anchor_counts`). A burned epoch exists and is a link like any other (`…__burned_epoch_chain_walks`), but a link only: its `writeEpoch` is null, so nothing is written under it (`…__burned_epoch_not_writable`); content and manifests sealed under it are `Unreadable(Late)` and suspect unless their author is a current member (§8.2; `private_doc_open__content_under_burned_epoch_*`); and the repair check rotates past it while it is current, even when no non-member is wrapped (§5.6; `…__burned_current_requires_rotation`), so any maintainer finishes an interrupted burn. Clients show who anchored a burned current epoch.

**Removing a maintainer re-anchors first.** A maintainer cannot drop their **own** role while they anchor any existing epoch: their anchors would stop counting with it and nobody could re-anchor them first (only the repo owner can delete a maintainer document, and the owner anchors epoch 0), so every epoch from the lowest of theirs up would stop existing; the client refuses. Every epoch whose anchor that maintainer wrote would otherwise stop existing (or fall to another config), rolling the current epoch back to one a previously removed member may hold. Before deleting a maintainer's role, the remover posts, for each such epoch it can read, a config sealed under the same key that **repeats the anchor's burned flag and chain link** (`prevEpoch`, `prevEpochKey`, `skipEpochKey`), so the next anchor by `($createdAtBlockHeight, $id)` among the remaining maintainers carries the same commitment. It then checks the outcome on a proof-verified read with the leaving maintainer's statements taken out: every epoch up to the surviving current one must keep its anchor commitment, its burned flag and its chain link (`COMMIT(prevEpochKey)` equal to the post-removal anchor of `e − 1`), and every key the remover held must still be readable; otherwise the removal is refused and nothing is deleted. Epochs the remover cannot read are dropped only when the leaving maintainer anchored every one of them, none the remover can read lies above them, and no maintainer who stays wrote or received a wrap for any of them — not counting the leaving maintainer's own wraps, which stop counting with the role (wrap rows are public, so this needs no keys; a remover whose own wrap lags must not drop an epoch another maintainer holds): they stop existing under contiguity, and the next rotation takes the lowest of their numbers again. Members who stay and hold a wrap for a dropped epoch are named as losing its content. The removal is refused before anything is written when an unreadable epoch the leaving maintainer anchored lies below a readable one, or when the remover cannot read the epoch that survives as current (the removal's rotation must chain from it): a maintainer who holds it wraps it to the remover first. Before the check, the remover wraps to itself every epoch it holds only through the leaving maintainer's wraps; when the refusal comes from another current maintainer's config taking over an anchor, the client names that maintainer. **Adding a maintainer must not change any anchor**: a returning maintainer's configs from an earlier role would count again and could come first, so the client resolves the anchors with the new maintainer included and refuses if any anchor or the current epoch would change ("this identity can't be made maintainer again: grant writer, or use a new identity"). Their configs for epochs above the current one never count (they predate the epoch below them being stated, see above). Because `config` is newest-wins, an anchor also repeats the current `defaultBranch` and `protectedPatterns`. Epoch 0's anchor is the repo's first `config`, written in the same session as `repo` and the owner's `maintainer` document.

**Chain walk.** Older epochs are reached **only** through the `prevEpochKey` chain starting from an existing (current-maintainer) anchor the reader can open: from `e`, decrypt the anchor, stop at a burned anchor, else take `(prevEpoch, prevEpochKey)`, require `prevEpoch = e − 1` (`…__chain_prev_epoch_must_be_e_minus_1`), derive `COMMIT_prevEpoch` from `prevEpochKey`, and require that it equals the commitment in **the anchor of `prevEpoch`** (again the first current-maintainer config for that epoch). If that anchor is burned, take `skipEpochKey`, find the largest `s < e − 1` whose anchor's commitment it matches, require that anchor not to be burned, and continue from `s`. If `prevEpoch ≠ e − 1`, a commitment differs, or a needed `skipEpochKey` is missing or matches no epoch that is not burned, the walk stops there with a `ChainBroken` alert naming the anchor's author; nothing below is readable through that chain. An epoch with no anchor (all its configs were written by since-removed maintainers) is not an epoch: its documents and packs are `Unreadable(NoKey)` to everyone and the UI shows maintainers "n documents under an unrecognised epoch".

Writers **never write under an epoch without an anchor**, and re-read the repo's anchors (a proof-verified read of all `config` documents for the repo; they are few) **before every write** — a client that caches keys across one command (to read once) still resolves them afresh for each sealed write, so a prompt or a long import never seals under an epoch a rotation superseded meanwhile, so a rotation that landed since the last write is picked up. Readers **never accept a wrap whose key does not match an anchor** (§5.4).

### 5.4 Reader rule for `repoKey`

A client holding identity `I` accepts a `repoKey` `w` for `(repoId, e)` iff:

1. `w.memberId = I` and `w.recipientKeyId` names an encryption key `I` holds (enabled or not: a wrap to a since-disabled key still opens history);
2. **`w.$ownerId` is a current maintainer** of the repo. A wrap written by an identity that is no longer a maintainer is ignored, even though the gate admitted it at the time; the removal of a maintainer withdraws every key statement they made, which is what makes rotation on maintainer removal effective (a removed maintainer could otherwise pre-post wraps and anchors for `n+1`);
3. epoch `e` exists (§5.3);
4. unwrapping yields version `0x01` and a `KCV_e` that matches the recovered key (else `WrapUnreadable`);
5. `COMMIT_e` derived from the recovered key equals the commitment carried by **the anchor** of `e`.

If (5) fails, the client raises a **`KeyMismatch` alert** naming `w.$ownerId`: a maintainer gave this member a key that is not the epoch's key (a split view, or a race loser's leftover wrap). The client **never** looks for a later config that the wrong key does open; the anchor is the anchor. When several accepted wraps exist for `(I, e)`, at most one key can pass (5), so they cannot disagree; a second wrap whose key differs is the alert case above. The readable epochs are the union of accepted wraps and the chain walk from each. Vectors: `private_epoch__*`.

Consequence to note in the UI: if every wrap a member ever received came from since-removed maintainers, and no current maintainer has rotated since, the member reads nothing until the repair check (§5.6) runs on a maintainer's client. This is the price of C1 and is acceptable because a maintainer's removal always triggers a rotation (§5.5).

### 5.5 Rotation and membership changes

**Add member.** Requires the member to have an enabled `ENCRYPTION` key. Write the `maintainer`/`writer` document, then one `repoKey` for the **current** epoch (two transitions). Past epochs come from the chain.

**Remove member** (writer or maintainer, the owner included). Delete the membership document, then rotate:

1. Re-read the anchors; let `n` be the current epoch (burned or not: a burned `n` still chains). Draw `K_{n+1}`, or reuse the key of this maintainer's own standing self-wrap for `n+1` (the journal, below).
2. Post `repoKey` wraps for `n+1` to every **remaining** member's highest enabled encryption key, **self first**.
3. Post the anchor `config` for `n+1` (current config fields + `prevEpoch = n`, `prevEpochKey = K_n`, `enc` version `0x02` with `COMMIT_{n+1}`). This is the commit point.
4. Wait for a proof-verified read at a block height ≥ the anchor's `$createdAtBlockHeight` that lists the repo's configs with `epoch = n+1`; confirm yours is first by `($createdAtBlockHeight, $id)` among those written by current maintainers. Only then does this client write content under `n+1`. (Anything committed at or before that height is visible in that read, so an earlier anchor cannot appear later.)

Cost: `members + 1` transitions, one per state transition (batch cap 1), shown before confirming. Nothing already written is re-encrypted: the removed member could already read it, and rewriting refs would only churn the reflog. The product says so in the words of ux-dx-spec §9.

**Concurrent rotations.** Two maintainers both rotate to `n+1` with different keys. The unique index `(repoId, memberId, epoch, $ownerId)` lets both post wraps. Step 4 decides: the earlier `($createdAtBlockHeight, $id)` anchor **by a current maintainer** is the anchor; the other maintainer sees in step 4 that they lost, checks that the winner's `$ownerId` is a current maintainer (if not, the "winner" is no anchor at all and the loser is in fact first), discards its journal entry and posts nothing more. Its wraps for `n+1` remain on chain and fail check (5) for their recipients, who see a `KeyMismatch` alert naming the loser; the loser's client, on its next visit, sees the same and shows "you posted a superseded key; nothing to do". The winner wrapped for every remaining member, the loser included. Whether the two removals composed correctly is then settled by the repair check below.

**Crash between steps 2 and 3**: `n+1` has wraps and no anchor, so it does not exist and no one writes under it. The rotator's own self-wrap for `n+1` is the journal (it is posted first, and the unique index `(repoId, memberId, epoch, $ownerId)` keeps it, so it is the only key `n+1` can have for this maintainer): unwrapping it recovers `K_{n+1}`, and the rotation resumes with it. Epoch numbers are contiguous, so there is no other number to move to.

**Burn.** If that key may have reached someone outside the remaining members — any of this maintainer's wraps for `n+1` to such an identity is visible, or the rotation removes a member and an earlier run's key for `n+1` exists at all (a lagging read may hide that run's wrap to the member being removed) — the rotator:

1. wraps `K_{n+1}` to every remaining member (a member it cannot wrap is skipped), then posts the anchor of `n+1` under that key with tag 11 `burned`, `prevEpoch = n` and no `prevEpochKey`;
2. waits for a proof-verified read listing `n+1`'s anchor, as in step 4, and checks it is its own (author and commitment). If another maintainer's anchor for `n+1` came first, theirs stands: the rotator posts nothing more and reports that it lost, and the repair check (§5.6) settles the rest;
3. otherwise rotates to `n+2` (steps 2–4) with `prevEpoch = n+1`, `prevEpochKey = K_{n+1}` and `skipEpochKey` = the key of the nearest epoch below `n+1` that is not burned (`K_n`, unless `n` was burned too), wrapping only the remaining members.

A crash after (1) leaves a burned current epoch, which the repair check rotates past on any maintainer's next visit: every remaining maintainer holds its key and can read the key below it. A resumed epoch whose standing wrap to a member cannot be replaced (they changed keys since) is burned the same way, since a wrap cannot be replaced within an epoch.

**Orphan hazard.** A maintainer who posts an anchor for `e` and then loses the key before wrapping anyone leaves `e` unreadable to all but themselves. Self-first wrapping in step 2, before the anchor in step 3, makes this require two independent failures; the repair check makes it visible.

### 5.6 The repair check (every maintainer client, on every visit)

After loading a private repo's membership, `repoKey` and `config` documents, a client whose identity is a current maintainer computes, for the current epoch `n`:

- `wrapped(n)` = the set of `memberId`s with an accepted-shape wrap for `n` from a current maintainer (checks 2–3 of §5.4, no decryption needed; for other members the client cannot open the wrap, and does not need to);
- `members` = current `maintainer` ∪ `writer` holders;
- `enabledKeyOf(m)` = whether the `recipientKeyId` used for `m`'s wrap is still an enabled key on `m`'s identity.

The check passes iff `n` is not burned, `wrapped(n) ⊆ members`, **and** every `m ∈ members` has a wrap for `n` to an enabled key. A burned `n` raises `RotationRequired` with an empty member list. While `wrapped(n) ⊄ members`, `writeEpoch` is null for every reader: nothing is written under a key a non-member holds until the rotation lands (vector `private_epoch__rotation_required_when_wrapped_non_member`). Otherwise:

- a wrapped identity that is not a member (a removed member who slipped through concurrent rotations, or a wrap posted by a maintainer to an outsider), **or a burned current epoch** (§5.3) → **rotate** (§5.5 steps 1–4) whenever the check says so, excluding the non-members if there are any, with the cost shown and confirmed: another maintainer's burn is not paid for silently; `dg` does it on the next command that touches the repo and prints what it did; the web app does it on the next visit and shows "rotating the repo key: bob still had the current key";
- a member with no wrap to an enabled key (added by a maintainer who crashed after the membership write; or the member rekeyed, §5.2) → wrap them for `n` (one transition each), no rotation needed.

`dg doctor` reports the same. The check is a pure function over flattened rows (vector `private_epoch__rotation_required_when_wrapped_non_member`, `…__missing_wrap_repaired_without_rotation`).

## 6. Threat model

| Adversary | Has | Learns / can do | Defence |
|---|---|---|---|
| Storage provider (bucket, gateway, pinning service, Platform chunk reader) | every sealed artifact | sizes, timing, access patterns (which segments a browser fetches, so which objects are hot); can withhold or corrupt | AES-GCM tags + `packHash` + OID check after inflate; the pack reader rule tries other copies; content unreadable |
| Platform observer (any node, any indexer) | every document | the §7 table; can post plaintext or garbage into un-gated types | AD-bound AEAD; the well-formedness rule hides garbage; the gate on `repoKey`, refs, packs, config |
| Removed member (writer) | every key up to their removal epoch; all sealed bytes | everything written before rotation, forever; `refNameHash` dictionary for old epochs; sizes/timing after; can still write plaintext-namespace documents (un-gated types) under their own `$ownerId` | new epoch per removal; per-epoch ref keys; late-content rule (§8.2); stated plainly in the UI |
| Removed maintainer | all of the above, plus pre-posted `repoKey`/`config` for future epochs | tries to define `n+1` before the real rotation, or to hand the old key to outsiders | anchors and wraps count only from **current** maintainers (§5.3, §5.4); a removed maintainer's pre-posts are inert; late-content rule |
| Current malicious maintainer | the key; may write anchors and wraps | can wrap to anyone (consensus cannot stop it); can attempt a split view (different keys to different members) | out of scope for content: a current maintainer is trusted with it by definition; split views are detected (key-committing anchors, `KeyMismatch`/`ChainBroken` alerts name the author) and every wrap is attributable |
| Malicious writer (member with `writer`) | the key; can write refs/packs/manifests | can push garbage packs or malformed `enc`; cannot wrap or rotate | pack verification; malformed documents skipped and counted; revoke + rotate |
| Compromised encryption key (browser vault, laptop) | the identity's encryption private key | reads every wrap that identity received **and sent** (§5.2), until the key is disabled and every affected repo rotated | vault encryption (passkey PRF / Argon2id), auto-lock; the rekey flow of §5.2; the repair check |
| Outsider posting into the namespace | nothing | can post plaintext or ciphertext under their own `$ownerId` to `issue`/`patch`/`comment`/`review` | AD binds `$ownerId`, so their bytes never decrypt as a member's; clients show only documents that decrypt (§8) |

Not defended: traffic analysis, the browser's or OS's memory, a malicious web-app build (roadmap D-C / IPFS build), and Platform itself being wrong about `$ownerId` or block heights.

## 7. Metadata that stays visible

| Visible to everyone | Where |
|---|---|
| The repo exists, its `name`, `displayName`, `description`, `topics`, owner, `forkOf`, creation time | `repo` (plaintext by design: the slug is the URL) |
| Member list and roles, when each joined | `maintainer`/`writer` documents |
| Epoch numbers, when each rotation happened, who rotated, who was wrapped and to which key id; that an epoch number exists (not whether it is burned: tag 11 is inside `enc`) | `repoKey`, anchor `config` |
| Number and timing (ms and block height) of ref updates, pushes, issues, PRs, comments, reviews; who wrote each (`$ownerId`) | every document |
| **Commit-level equality oracles**: `refUpdate.newOid`/`prevOid`, `packManifest.tips`, `patch.headOid`, `review.commitOid`, `comment.commitOid`. Anyone who already knows a commit hash can confirm the repo contains it (and roughly when). Commit *contents* stay hidden; git commit ids are not preimage-resistant hiding of content that is public elsewhere | plaintext fields the rules need |
| `force`; event kinds (close, merge, label added, milestone set…), so *that* a label was added or a review dismissed, and when and by whom. The event's `value` (the label or milestone name, the dismiss reason, the assignee, the retarget base) is sealed in `enc` (TLV 15, bound to `targetId`); an event without a value (close, reopen, merge, draft…) carries no `enc`. **An assignee stays visible**: an assign / unassign also names the identity in the plaintext `refId` (the `addressee` index behind "assigned to me", platform-parity-spec §1.2), so sealing its `value` hides nothing there | `event`, `authorEvent` |
| Which updates share a ref name within an epoch (equal `refNameHash`); which PRs target the same base within an epoch | `refNameHash`, `baseRefNameHash`, `sourceRefNameHash` |
| `patch.sourceRepoId` (which fork a PR comes from, so the fork's membership and activity); `patch.patchManifestHash` (a pointer to a sealed manifest in the fork: a ciphertext hash, not a content oracle) | `patch` |
| Sealed artifact sizes (`sizeBytes`), object counts (`objectCount`), chunk counts, `supersedes`, storage URIs; inside the sealed file, the header's `epoch` and exact `plaintextLen` | `packManifest`, sealed header |
| Approximate plaintext length of every encrypted field (ciphertext − 29, or − 61 for config) | `enc` length |
| Issue/PR numbers, comment targets, `replyTo`, review `verdict`, inline comment `line`/`side`/`startLine` (the `path` is encrypted, §4.3) | plaintext fields |
| When an imported document was created at its source (`imported.createdAt`); its author handle and source URL are sealed (tags 13, 14) | `imported` |
| Review structure and edit times (docs/design/review-parity-spec.md §3): `$updatedAt`/`$updatedAtBlockHeight` (when an issue, PR or comment was last edited); `comment.reviewId` (which review a comment belongs to), `review.commentCount`, `patch.draft`; `event`/`authorEvent` `refId` (the resolved thread's root comment, a requested reviewer's identity, a dismissed review, an assignee) and `oid` (a `headUpdate`'s new head, another commit-equality oracle); `policy` (required approvals, approver role, checks, merge methods) | plaintext by design; none carries a path or free text |
| A sealed release's revisions: that one exists, when, by which maintainer, under which epoch; which revisions of one epoch share a tag (equal keyed `tagName`); the `enc` length; its kind-4 asset manifest's size and timing, and its sealed asset objects' sizes. The tag, name, notes, flags, target commit, provenance and asset list are sealed (§16.6) | `release`, `packManifest` kind 4, storage |
| `label` definitions (`name`, `color`, `description`), `checkRun` (`name`, `summary`, `detailsUrl`), `webhook.url` | **not encrypted in this release** (§13). A label put on an issue is sealed, but a repository that also publishes its label **definitions** publishes the vocabulary: the event value hides *which* label an issue carries, not which labels exist. The importer therefore leaves definitions out of a private destination unless `--include-label-definitions` |

Sizes are not padded. Padding to buckets would cost real credits at 27,000 credits/byte for little gain against an adversary who sees timing anyway; the trust panel states "sizes and timing are visible".

## 8. Well-formedness and the read path

### 8.1 `open_content`

`is_well_formed` (rules v2, vectors `well_formed__*`) stays pure and changes in one place: `comment.path` becomes a **content field** of `ContentKind::Comment` (plaintext fields: `body` required, `path`), so a private comment carrying a plaintext `path` is malformed. Otherwise a private document is well-formed iff it has a non-empty `enc`, an `epoch`, and no plaintext content field. This design adds a key-dependent layer, `open_content(doc, keys, epochs) → Readable(fields) | Unreadable(reason) | Malformed`:

1. `len(enc) < 29`; or `enc[0]` not `0x01` (non-config) / `0x02` (config); or a config `enc` shorter than 61 → `Malformed`.
2. `epoch` does not exist (§5.3) → `Unreadable(NoEpoch)`; exists but the reader holds no key → `Unreadable(NoKey)`.
3. Config only: `COMMIT_epoch` from the reader's key ≠ `enc[1..33]` → `Unreadable(CommitMismatch)` (alert if the document is the anchor, §5.4).
4. AES-GCM under `K_doc,epoch` with the §4.4 AD fails → `Unreadable(BadTag)` (a tampered document, an outsider's bytes, or a copy-paste).
5. TLV parse fails per §4.3 → `Malformed`.
6. Ref-name hash check per §4.5 fails → `Malformed`.
7. The late-content rule of §8.2 applies → `Unreadable(Late)`. (A reading layer that sees `BadTag` or `CommitMismatch` on a document, or a segment-tag failure on an intact sealed pack, dated before `stated(e)` — when the epoch's current key was first stated, §5.3 — reports it as `Unreadable(EarlierUse)`: sealed under an earlier use of the epoch number, whose epochs stopped existing with a maintainer's removal, not tampering. A malformed or truncated pack is still `SealedPackCorrupt`.) A document without `$createdAtBlockHeight` (required by the schema, §13) cannot be judged and is `Malformed`, never assumed early. A member `event` skips this step: it is gated at consensus to current maintainers and writers, so a removed member cannot write one under any key, and its schema does not carry `$createdAtBlockHeight` (vectors `private_doc_open__event_not_judged_late`, `…__event_without_height`). A sealed `release` skips its height clause on the same grounds, and keeps its burned clause (§16.4).

Every other rule (folds, approvals, ref resolution) runs over `Readable` documents only. A member `event` is **always kept**: its kind and `refId` are plaintext and member-gated, so a close, a merge mark or a review dismissal counts whatever happens to its value. Only its `value` depends on the read: one sealed in `enc` is opened in place (TLV 15), and dropped when it does not open (`Unreadable` for this reader); a plaintext `value` next to `enc` is dropped too, the sealed one being the only one that counts. A plaintext `value` on its own was written by a client from before event sealing: consensus admits `event` only from a current member, so it is authentic member data, and it is kept and shown marked "not encrypted". An empty value is no value. The value-driven fold arms (label, assign, milestone, retarget) do nothing without a value; a dismissal still dismisses, without its reason. Readers report how many values were not readable and how many were plaintext (`dg … view` `hiddenEventValues` / `plaintextEventValues`; the web shows a note). The UI hides `Unreadable` and `Malformed` documents and shows maintainers the count (ux-dx-spec §9). A `review` whose `enc` is unreadable still has a plaintext `verdict` and `commitOid`; it is **not** counted, which keeps a non-member's approval from ever being tallied by accident, in line with `count_approvals` taking well-formed input.

For sealed artifacts the equivalent is §3.5; a `SealedPackCorrupt` copy is a copy that failed verification in `select_pack_copy` / `v2_pack_list` (`verified = Some(false)`).

### 8.2 Late content under a superseded epoch

A removed member keeps `K_n` and may keep writing documents under `n` (un-gated types), or may have queued packs. The member-gated `event` is outside the rule (§8.1 step 7): consensus refuses it from a removed member. Let `next(n)` be the smallest existing epoch greater than `n`, and **`H` the block height of `stated(next(n))`** (§5.3): the `$createdAtBlockHeight` of the first `config` for `next(n)`, by anyone, that comes after `stated(n)` and carries the commitment of `next(n)`'s anchor — the moment `next(n)`'s key was first stated on chain. `H` is never above the anchor's own height (the anchor is such a config). A document or manifest with `epoch = n` (for a manifest: the sealed header's `epoch`) and `$createdAtBlockHeight > H + GRACE_BLOCKS` is `Unreadable(Late)` **unless its `$ownerId` is a current member** (`RoleOracle::current_role` is `Some`). `GRACE_BLOCKS = 240` (`FORGE_RULES_V2`; roughly a quarter of an hour of Platform blocks, enough for a client whose last anchor read predates the rotation to finish a push). Content under `n` from before `H + GRACE_BLOCKS` is shown to everyone who can decrypt it, as before. Content under a **burned** epoch (§5.3) is `Unreadable(Late)` at any height unless its `$ownerId` is a current member: nothing is ever written under a burned epoch by an honest client that knew it was burned.

**Why `stated`, not the anchor.** The anchor is re-selected whenever membership changes: when the maintainer who anchored `next(n)` is removed, a remaining maintainer re-anchors it (§5.3: same commitment, later height), and any maintainer may post a further config for the same key at any time (every config repeats the current settings, and `config` is newest-wins). Measured from the selected anchor, each of these would move `H` later, reopening the window in which a removed member's content under `n` is shown, and even re-legitimising content already hidden as `Late`. `stated(next(n))` is fixed by history: `config` is immutable, non-deletable and maintainer-gated at consensus, its `$createdAtBlockHeight` is set by the network (no one can backdate it), and a later config repeating the same commitment does not change which one came first. Only configs carrying the anchor's commitment count, so a config for `next(n)` under another key (a race loser's, a since-removed maintainer's pre-post, an earlier use of the epoch number) moves `H` neither earlier nor later: nobody can pull the cut-off forward over honest content without the epoch's actual key. The reader already fetches every `config` of the repo to select anchors, and the commitment is plaintext (`enc[1..33]`, §4.2), so `H` costs no read and no key, and every reader computes the same `H`. Wraps are not used: a wrap for `next(n)` also states the key, but only its recipient can check which key, so readers would disagree; an honest rotation posts its wraps at most a few blocks before the anchor, well inside `GRACE_BLOCKS` (vectors `private_epoch__reanchored_next_epoch_keeps_first_height`, `…__late_cutoff_ignores_other_key_config`, `private_doc_open__late_cutoff_from_stated_height`, `…__issue_edited_after_stated_height_late`). The same applies to a burned `next(n)`: its re-anchor repeats its commitment and flag, so `H` stays where the burned key was first stated. What `H` does not survive is a change of `next(n)`'s **key**: if its anchor's author is removed without the re-anchor §5.3 requires (a client that bypasses the removal check), a different-key config can become the anchor and `H` becomes that key's first statement. That rewrites the epoch's key for everyone, which only a current maintainer can bring about, and current maintainers are trusted with content (§6).

**Edits are judged too.** `issue`, `patch` and `comment` are replaceable, and a replace keeps `$createdAtBlockHeight`, so the rule also reads `$updatedAtBlockHeight` (required on those three types by the review-parity forge-collab and set by the network on every replace): a document whose `$updatedAtBlockHeight > H + GRACE_BLOCKS` under a superseded epoch `n` is `Unreadable(Late)` on the same terms, unless its owner is a current member. Without this a removed member could keep rewriting their own earlier documents under the old key. A document created in time but edited late is `Unreadable(LateEdit)`, not `Late`: a replace keeps only the newest text, so the original cannot be shown instead, and the reader says "edited after its author was removed; the original text is gone" rather than let the document vanish silently (vectors `private_doc_open__issue_edited_*`, `…__issue_created_late_and_edited_is_late`). A patch is the exception to "re-seal under the current epoch" (§4.5), and an honest author who is a current member is covered by the member exception.

Writers re-read anchors before every write (§5.3), so an honest client rarely writes late; if it does (a long push straddling a rotation), its content is still shown because it is a current member. A reader that sees a **sealed pack whose header epoch is older than the epoch that was current at the manifest's block height** (epoch `e` is current from the height of `stated(e)`, not of its selected anchor, for the reason above) flags the manifest as suspect, and so does a sealed header naming a burned epoch: the UI shows it to maintainers as "uploaded under an old key", and it is read only if its uploader is a current member.

## 9. UX constraints (ux-dx-spec §9) and how the design meets them

- **Create**: `visibility` immutable; the CLI/web refuse to create a private repo unless the creator's identity has an enabled `ENCRYPTION` key, and write `repo` + `maintainer` + anchor `config(epoch 0)` + a self-`repoKey` in one session. The four facts in the confirmation map to §7 and §5.5.
- **Add member**: the app looks up the identity's enabled `ENCRYPTION` keys; none → Add is disabled with the spec's message. Two transitions (`~0.0006 DASH`).
- **Remove member**: the verbatim warning; then delete → wraps (self first) → anchor → confirm; cost `members + 1` writes shown beforehand. The members list reads the current epoch and its anchor's block time/`$ownerId` for "key epoch 3 · rotated 2 d ago by alice".
- **Repair and alerts** (new): "rotating the repo key: bob still had the current key" (§5.6); "alice gave you a key that isn't this repo's key (epoch 3)" (`KeyMismatch`); "the key chain is broken at epoch 2 (anchor by carol)" (`ChainBroken`); "n documents under an unrecognised epoch". Alerts are shown to the affected member and to maintainers; they never silently downgrade.
- **Reading**: the lock chip names the epoch the view decrypted with; hidden-document count from §8, split into "not encrypted for this repo", "wrong or missing key" and "written after the key was rotated".
- **Outsiders**: no decrypted string renders; §6.3's private state comes from `repo.visibility` and the absence of a usable wrap.
- **CLI**: `git clone dash://…` looks up the keychain identity's encryption key; missing → a new error code (§13) `private repo: your identity has no encryption key · fix: dg auth keys add --encryption`. Unwrap failure, `KeyMismatch`, `ChainBroken`, "rotation pending", "sealed pack corrupt" and "late content" get their own codes.
- **Rekey**: `dg auth keys rotate --encryption` and the web equivalent run the §5.2 flow and list the repos rotated and the repos where a maintainer must act.

**Performance.** Browser AES-GCM through WebCrypto runs at hundreds of MB/s; a blob view decrypts ≤ 5 segments (≈ 80 KiB) in well under a millisecond of CPU, dominated by network. Subkeys are derived once per epoch and cached in the session (never persisted outside the vault). The in-browser fallback clone decrypts packs streaming into the IndexedDB pack store, segment by segment, without holding a sealed copy. In Rust, `PackCipher::seal/open` gain streaming variants over `Read`/`Write` so multi-hundred-MB packs are not held twice in memory.

## 10. Libraries

**Rust** (`forge-core`; the SDK stays confined to `forge-core::platform` per the style guide): `aes-gcm = "0.10"` (with `aes` on AES-NI), used as a plain AEAD with the §3.2 nonce built by hand: **not** `aead::stream` (its nonce layout and final-flag convention differ from ours and from the TypeScript side, which has no such helper). `hkdf = "0.12"` (shares `hmac 0.12`/`sha2 0.10`, already present), `getrandom`/`rand_core` for `K_e` and the `rnd(32)` inputs of §3.6. ECDH + AES-CBC wrapping goes through `dash_sdk::platform::encrypted_for` (already a dependency), so no direct `k256`/`secp256k1` use in forge-core. `zeroize` on key material.

**TypeScript** (`forge-web`): `crypto.subtle` for AES-GCM, HKDF, HMAC and SHA-256 (the app is served over HTTPS/localhost, so a secure context is guaranteed). `K_e` is imported once as a **non-extractable** HKDF base key; `K_doc,e`, `K_pack,e,f`, `K_ref,e`, `K_tag,e` and `K_hedge,e` are derived with `deriveKey` as non-extractable `AES-GCM`/`HMAC` keys, and only `KCV_e`, `COMMIT_e` (which must be compared as bytes) and `prevEpochKey` (which must be re-imported) go through `deriveBits`/raw bytes. `@noble/hashes` (present) for HMAC/HKDF in tests and for parity checks; it must produce identical bytes. Wrapping through `@dashevo/evo-sdk` pinned to the exact version `4.2.0-beta.7` (no range specifier) via `sdk.encryptedFor.encrypt/decrypt/envelope`. No `@noble/ciphers`, no `@noble/curves` in the app path.

Both stacks are validated against §11 before either ships; a byte difference between them is a release blocker.

## 11. Conformance vectors

New vector cases in `forge-contracts/vectors/` with `"rules": "v2"`, one file per case, dispatched by `case`. Fixed inputs used throughout: `repoId = 0x11×32`, `$ownerId = 0x22×32`, `K_0 = 00 01 … 1f`, `K_1 = 20 21 … 3f`, `nonce = 000102030405060708090a0b` (through the test-only constructor of §3.6). Expected outputs below were produced independently in Python (`cryptography` 44, HKDF/HMAC/AES-GCM/AES-CBC; secp256k1 by hand) and are the values both implementations must reproduce.

**`private_kdf`** (input: `repoId`, `K_e`, `e`; output: subkeys):
- `PRK_0 = 74b9ee840de5d5a97a0a075fb825e319f4f1fd18e73809ef1dd0cd89fe5921b5`
- `K_doc,0 = 0f21a88819aca66526d4965dcd7854ba141266e080d843b25b79e49cda40ee39`, `K_ref,0 = 6141d2b714c98c85bd535dee436535c7c9c27e91bed3a9cb5d6e7517dffa629e`, `KCV_0 = 7cab1ab77a4b34d31fa6ef954054`, `COMMIT_0 = 2ae6cfc9c4d7f570f56f946332e8d950b2f39d4d3c8c60b7a33d8275ebf3e584`
- `K_doc,1 = 88011c08c79c9c87dba7ba9a464ce66c8c057a4b42e7d29d54e1a98087aa94c2`, `K_ref,1 = e4afad398b71356f3f6955487651500e127071fb4774ea234b85036f4cbed895`, `KCV_1 = 52533798d0b561eddfe088451253`, `COMMIT_1 = 307277ccb5bcfa7871f82e43c6e58515464a5065460b829def44e1cc32521c33`
- `K_pack,0,fileId=f0e1d2c3b4a5968778695a4b3c2d1e0f = 7c3836d19c8c22116136d9a49d6cc92914771e1010c697673a7baba1c521932b` (info ends `… ‖ u32(0) ‖ 0x01 ‖ fileId`)

**`private_ref_hash`**: `refs/heads/main` under `K_ref,0` → `e729d18b929db396450159dfc6256e24302b94c9c3c9eb40643f5ae0be3fe579`; under `K_ref,1` → `7310537f7a9b04d1eaab334d91ee963c89be088d7309ed5dcf84951ed7bb215a` (must differ per epoch); the public `sha256` → `f921bd05e68b03740c450e565e0e6173e546193170b2dd404ddb6f153e9b5bf3` (a private repo carrying the public hash is a bug).

**`private_doc__seal` / `__open`** (input: kind, epoch, bind fields, plaintext fields, nonce; output: AD hex, TLV hex, `enc` hex; the open direction takes the document and yields the fields or the failure):
- issue #7, title `Rotate the signing key`, body `See the runbook.`: AD `646173682d666f7267652f76322f646f6300 01 11…11 22…22 00000000 6973737565 00 00000007` (spaces for reading only); TLV `010016526f7461746520746865207369676e696e67206b6579020010536565207468652072756e626f6f6b2e`; `enc` (73 B) `01000102030405060708090a0b1f7039a0ac468d0d3a5c60dba50b8e67de7316a802d264e22094824ccaf8a0d1650855aba0344d75612e31c48cdfc7b2d5d8c2c6a98c23a1320093aa`.
- refUpdate `refs/heads/main`, `refNameHash` as above (epoch 0), `newOid = aa×20`, no `prevOid`, `force = false`: TLV `03000f726566732f68656164732f6d61696e`; `enc` `01000102030405060708090a0b1d702080a6549f56371975d7b304906fd0738aace1e93172a442bd35c7f049054557` → `Readable`.
- **refUpdate hash mismatch** (H3): the same plaintext sealed with `refNameHash = HMAC(K_ref,0, "refs/heads/dev") = eef70d7506d9e18be1005f88cd0889a9fa321fb0bce4dc1209442c41cc0c47e2` in the bind and on the document: `enc` `01000102030405060708090a0b1d702080a6549f56371975d7b304906fd07300c3612fcbb987e4b0ae16ad06494ccd` decrypts (tag valid) but the recomputed hash of `refs/heads/main` ≠ `refNameHash` → `Malformed`. A patch vector does the same with `baseRefNameHash`/tag 4 and `sourceRefNameHash`/tag 5.
- comment on `targetId = 0x33×32`, empty plaintext: `enc` (29 B) `01000102030405060708090a0bbd9c1374076ddd93b6478109a3cc02c4` → decrypts, then `Malformed` (`body` required).
- inline comment, body `nit: rename`, path `src/lib.rs`: TLV `02000b6e69743a2072656e616d650a000a7372632f6c69622e7273`; `enc` `01000102030405060708090a0b1c70249caa46d6592d197ad2ad4ef70eb36e0da54a9e66e577e4f16f2a8e55d2c8ed09dc06cd085c7a26e3`.
- **config anchor epoch 0** (v0x02), `defaultBranch = refs/heads/main`: AD `… 02 … 00000000 636f6e666967 00 ‖ COMMIT_0`; TLV `06000f726566732f68656164732f6d61696e`; `enc` (79 B) `022ae6cfc9c4d7f570f56f946332e8d950b2f39d4d3c8c60b7a33d8275ebf3e584000102030405060708090a0b18702080a6549f56371975d7b304906fd0739b4b2701a46ecedc74a79a665a7b3473`.
- **config anchor epoch 1** under `K_doc,1`, with tag 6 `defaultBranch = refs/heads/main`, tag 7 `protectedPattern = refs/heads/main`, tag 8 `prevEpoch = 0`, tag 9 `prevEpochKey = K_0`: TLV `06000f726566732f68656164732f6d61696e07000f726566732f68656164732f6d61696e08000400000000090020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`; `enc` `02307277ccb5bcfa7871f82e43c6e58515464a5065460b829def44e1cc32521c33000102030405060708090a0bd0b9cc2c71a2a510ad23e4af9dc285bf3b180fe8ade1be1e55826633284d4657b8bb74aad1ab382bbcebb6776071579f82f9905c711e7dd4af5478299d221175e8af28f11d2cce5f87a7b0fa5bd88567ca44d954ae135b0551f16c90b8d2`. Opening it with `K_1` yields the fields; deriving `COMMIT_0` from tag 9 must equal `2ae6cf…e584`, the epoch-0 anchor's commitment (chain walk succeeds).
- **split view** (H1): the same epoch-1 plaintext sealed under `K_x = 0x77×32` carries `COMMIT = 89f8dd4eb6cb38196f7958b1b644b4f761f82979c8d965aa291f3a2820ca7775`: `enc` `0289f8dd4eb6cb38196f7958b1b644b4f761f82979c8d965aa291f3a2820ca7775000102030405060708090a0b62d8b509a110c74363a7f13c991f9540e7cadfbfca8f15f458b0df9cae818010a978835f90e2633689bc080a101a5d3f0700d9645e9f0c36f60301625817759d9812eb95a6506f4a0145b672c01f5101421fbe9cac9e11adb6104751312f`. A reader holding `K_1` returns `Unreadable(CommitMismatch)` **without** attempting GCM; a reader holding `K_x` opens it, but if the epoch-1 anchor is the `K_1` document above, that reader's wrap fails §5.4(5) → `KeyMismatch` alert.
- negative cases: the issue `enc` opened with `number = 8` → `Unreadable(BadTag)`; with `$ownerId = 0x23×32` → `BadTag`; with `epoch = 1` → `BadTag`; with `enc[0]` rewritten to `0x02` (and 32 bytes inserted) → `Malformed` for a non-config kind; a config with `enc[0] = 0x01` → `Malformed`; a TLV with tag 1 twice → `Malformed`; tags out of order (2 then 1) → `Malformed`; tag 16 in an issue (reserved when this list was written, now release-only) → `Malformed`; tag 11 (`burned`) in an issue, in an epoch-0 config, with value `0x02` or with length 2 → `Malformed`; a burned config with tag 9 or tag 12 → `Malformed`; tag 12 in an issue, in an epoch-0 config or of 31 bytes → `Malformed`; extension tag 200 → skipped, `Readable`; two trailing bytes → `Malformed`; tag 8 with length 3 → `Malformed`; tag 3 in an issue → `Malformed`; tag 8/9 in an epoch-0 config → `Malformed`; a title of 257 characters → `Malformed`.

**`private_collab_seal__*`** (input: the properties the public writer would produce for an issue, PR, comment or review, the epoch key, `$ownerId` and a fixed nonce; output: the sealed properties). Every present sealed field (issue `title`/`body`; PR `title`, `body`, `baseRefName`, `sourceRefName`; comment `body`/`path`; review `body`) leaves the plaintext for `enc`; a PR's `baseRefNameHash`/`sourceRefNameHash` become `HMAC(K_ref,e, name)` (absent when there is no source branch); `epoch` and `enc` are added; everything else (`number`, `targetId`, `patchId`, `sourceRepoId`, `headOid`, `patchManifestHash`, `draft`, `replyTo`, `reviewId`, `commitOid`, `line`, `startLine`, `side`, `verdict`, `commentCount`) is copied unchanged. The CLI and the web app produce these byte for byte. A create whose number is taken re-seals for the new number (`issue_renumbered_8`: the AD binds it). An `event` seals its `value` as TLV 15 bound to `targetId`; `targetNumber`, `kind` and `refId` stay plaintext (`event_label_add`, `event_milestone_set`, `event_review_dismiss`, `event_retarget`); `private_doc_open__event_*` pin the open, the target bind (`event_other_target` → `BadTag`), the required value, and that the late rule does not apply to a member-gated event.

**`private_pack__seal` / `__open` / `__range`** (input: plaintext = bytes `i mod 251` for `i in 0..40000`, `epoch 0`, `fileId` above, `L = 14`):
- header `4446504b010e0000000000000000000000009c40f0e1d2c3b4a5968778695a4b3c2d1e0f`; 3 segments; sealed length 40,084; segment tags `bd93a5ffb088dee81cd4e5c8d6750d33`, `fb62d98c6a0e1d864129988e24495f65`, `69789e159bdc8234933d844b7a8ed32c`; `packHash = 7e7e4e4ed63d4c51a46f0ecd9b3a2a50b2f5fed46e89c58b8ac6450bf7582315` (the plaintext's sha256 `8f272ca6d96caedf3d860ff34ed21868f04ce18a2f41686f513c3c989146ca79` must not be used as `packHash`).
- empty plaintext: sealed = `4446504b010e0000000000000000000000000000f0e1d2c3b4a5968778695a4b3c2d1e0f70ae66b8c3bceb742661fa2f54aa8f1b` (52 B).
- range `[20000, 20100)` → segments `1..=1`, sealed range `[16436, 32836)`, output = plaintext bytes 20000–20099.
- negative: last segment's `final` flag cleared → `SealedPackCorrupt`; sealed bytes truncated by one segment → `SealedPackCorrupt` (caught at the length check before decryption); `reserved = 0x0001` → refused; header `epoch` changed to 1 → every tag fails; `L = 9` → refused; `sizeBytes` in the manifest one byte off → the copy failed verification, nothing allocated.

**`private_wrap`** (deterministic keys: `senderPriv = 840fa5c84d8f6ecf5c27fd778356ba94480b9b35f264e7690933dcf1676f9ac0` → pub `03f3d414f81ac96cea14d3ec25685430f04c47c8b0559fff0ffe77113d8ada7948`; `recipientPriv = f16baad1b1863c015869f5a6a2db471537d06a31d3bd78d961300f13f6b14239` → pub `035bf470bf1fbffac4b0b01c0ae8480b0b56d6695482bb116286c62e99af15e337`):
- shared key `e6cf085ee93d30ba8b5f81451d11709e9856c12acef291ce4e084b18a4c4856b` (both directions);
- wrap plaintext for epoch 0 (47 B): `017cab1ab77a4b34d31fa6ef954054000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`;
- with IV `0f0e0d0c0b0a09080706050403020100`: `wrapped` (64 B) `0f0e0d0c0b0a09080706050403020100828afa35dca4dbd8eb40591d52f363f10671f7b77f5f619a25ee6d03fb88043c7fa0037e5c0d83ea667f9ba7289a82cc`.
- The SDK helper draws its own IV, so the seal direction is vectorized on the shared key and on the raw AES-CBC primitive; the open direction (`wrapped` → `K_0`, `KCV` matches, `COMMIT_0` matches the epoch-0 anchor) is vectorized end to end. Negative: `KCV` byte flipped in the plaintext → `WrapUnreadable`; decrypt with a third key → padding error or `KCV` mismatch → `WrapUnreadable`; a wrap of `K_x` (commit `89f8dd…7775`) against the `K_1` anchor → `KeyMismatch`.

**`private_epoch__*`** (pure, over flattened `repoKey`, `config` and membership rows with `owner_role`, `created_at_block_height`, `id`, `commit`, like `pack_copies__*`):
`accept_wrap_from_current_maintainer`, `reject_wrap_from_non_maintainer`, **`revoked_maintainer_wrap_not_current`** (a wrap whose author has no current `maintainer` document is ignored even though it predates the revocation), **`removed_maintainer_preposted_anchor_ignored`** (a config for `n+1` by a since-removed maintainer, earlier by block height than the real one, is not the anchor; the current maintainer's later config is), `anchor_first_by_block_height_then_id_among_current_maintainers`, `anchor_created_at_ms_not_used_for_order`, **`anchor_does_not_open_alert_no_skip`** (the first current-maintainer config for `e` has a commitment the reader's key does not match → `KeyMismatch`, and a later config for `e` that does match is *not* used), `unanchored_epoch_not_writable_and_unreadable`, `current_epoch_is_highest_anchored`, **`epoch_gap_ignored`** (a config above a missing epoch number is not an anchor: `EpochGap`), **`preposted_future_config_ignored`**, **`preposted_config_ignored_after_regrant`** (a config posted before the epoch below it had its key never counts), `preposted_after_other_key_ignored`, `reanchor_of_middle_epoch_keeps_epochs_above`, `anchor_tie_at_same_height_after_prev_by_id`, `huge_epoch_from_removed_maintainer_ignored`, `huge_epoch_from_current_maintainer_is_a_gap`, `chain_walk_reaches_epoch_0_from_one_wrap`, `chain_with_skipped_epoch_number` (now a gap), **`chain_prev_epoch_must_be_e_minus_1`**, **`burned_anchor_has_no_prev_key`**, **`skip_key_walks_past_burned`**, `consecutive_burned_skip`, **`missing_skip_key_chain_broken`**, `chain_prev_epoch_must_be_smaller` (`prevEpoch ≥ e` → `ChainBroken`), `chain_prev_epoch_without_anchor` (no epoch 0: a gap), **`burned_epoch_not_writable`**, `burned_epoch_chain_walks`, **`burned_current_requires_rotation`**, `burned_flag_only_on_the_anchor_counts`, **`chain_key_must_open_first_anchor_of_prev`** (`prevEpochKey` commits to a config for `prevEpoch` that is not its anchor → `ChainBroken`), **`rotation_required_when_wrapped_non_member`** (H2: `wrapped(n)` contains a removed member → the repair check returns `Rotate`, and no write epoch until it lands), `missing_wrap_repaired_without_rotation`, `wrap_to_disabled_key_requires_repair`, **`late_content_hidden_after_next_anchor_plus_grace`** (document under `n` at height `H + 241` by a removed member → `Unreadable(Late)`), `late_content_within_grace_shown`, `late_content_from_current_member_shown`, **`reanchored_next_epoch_keeps_first_height`** (`H` is `stated(n+1)`: a re-anchor of `n+1` after its author's removal does not move the cut-off later, for content or for the suspect flag), `late_cutoff_ignores_other_key_config` (a config for `n+1` under another key does not move it either), `manifest_under_old_epoch_flagged_suspect`.

**`private_release_seal__*` / `private_release_open__*`**: sealed releases, listed in §16.7.

## 12. Changes this design asks of other documents and code

1. **forge-v2.md §5**: the key-check value is the 14-byte `KCV_e` inside the wrap (error detection) and the key is authenticated by the anchor's commitment; anchors, wraps and the current epoch count only from current maintainers; `refNameHash` is under `K_ref,e`, a subkey, not the raw epoch key; `enc` layouts, TLV and AD as §4; the late-content rule of §8.2. Update the "Phase 3 fixes the exact field" sentence to point here. State in §6's rule table: `open_content`, `select_anchor`, `current_epoch`, `chain_walk`, `repair_check`, `is_late`, with the vectors of §11.
2. **rules v2 `is_well_formed`**: `comment.path` joins `ContentKind::Comment`'s plaintext fields (vector `well_formed__private_comment_plaintext_path`).
3. **errors.md**: new codes for "no encryption key", "no usable repoKey (not a member, or removed)", "key mismatch (a maintainer gave you the wrong key)", "key chain broken", "rotation pending / repair running", "sealed pack corrupt", "written after the key was rotated".
4. **private.rs**: `RepoKeyReader` grows `current_epoch() -> Result<u32>`, `epoch_key(e)` walks the chain, `repair_check()`; `PackCipher` gets streaming and ranged forms with the header cache (keyed by the copy, and filled only once a segment tag has authenticated the header); `RefNameHasher` takes the epoch; `RepoCodec` grows `open_content`. Production seal APIs take no nonce/fileId (§3.6).
5. **Not encrypted in this release** and to be stated in the UI: `label` definitions, `checkRun.summary`/`detailsUrl`, `webhook.url`, `repo.description`. `event.value` is sealed (TLV 15). Releases are sealed as §16 specifies; until the clients implement it they refuse releases on private repositories. `label` already has `enc`/`epoch` in forge-core (§13 row 6); `repo.description` should be left empty by private-repo creators and the create flow says so.

## 13. Contract changes required before mainnet registration

These are schema changes to `forge-core.json` / `forge-collab.json`; they must land before the mainnet registration (roadmap D-J) and should be registered on the devnet first. **Status:** changes 1–3 are in the schemas and were registered on moutai on 2026-09-26, then again from the same schemas after the 2026-09-27 chain reset (forge-core `6DJ3px1ZDGpx9kvLEMDuLdLtHo4WYirWzyJ2GVWegGux`, forge-collab `6BbENuf3uZhkntw9DSsxQcTu9a5fATxQoSe6Ph1JxHkS`, which also carries the review-parity changes; `docs/contracts/forge-v2.md` §8), and again after the 2026-09-28 reset to drive 4.2.0-beta.6 (forge-core `A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1`, forge-collab `C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS`), and a live create of every changed type under them succeeded (`forge-web/lib/private/private.live.test.ts`). The RC1 registration on devnet bonsia (2026-09-29: forge-core `6SbihK14KP8RhUpSH4Tc6WNvWKziWEoAbkNZmi7RadwJ`, forge-collab `H1H5VfTt2KWy1NhwEHoHuwYZGJm8eoetUCUt5xGNuZUp`, forge-community `6ktYsH3cpxC7FbazwtVWGiNuVb4TNE5YrHD1hNY8XqNx`) carries changes 1–3 as well; in RC1 `repoKey` lives in forge-collab and `event` in forge-community. Adding a required system field or raising `maxItems` is fine for a fresh registration; on the existing moutai contracts, raising a byte array's `maxItems` is a compatible update, while adding to `required` is not, so moutai needs a `--force-new` re-registration.

| # | Contract | Change | Why |
|---|---|---|---|
| 1 | forge-core `schemaDefs.enc.maxItems` | 1024 → **1536** | a v0x02 config anchor is 61 bytes of overhead plus up to 1124 bytes of TLV (8 patterns × 103 + `defaultBranch` 258 + `prevEpoch` 7 + `prevEpochKey` 35); the current cap leaves 963 bytes |
| 2 | forge-core `config.required` | add **`$createdAtBlockHeight`** | anchor ordering (§5.3) and the late-content rule (§8.2) must use a network-set order, not the client-set `$createdAt` |
| 3 | forge-core `repoKey`, `refUpdate`, `protectedRefUpdate`, `packManifest`; forge-collab `issue`, `patch`, `comment`, `review` — `required` | add **`$createdAtBlockHeight`** | the late-content rule compares every private document's and manifest's block height with the next anchor's |
| 4 | forge-core `config` | no new index | anchors are found by reading all of a repo's `config` documents (append-only, rarely written) over the existing `(repoId, $createdAt)` index and ordering client-side; a `(repoId, epoch, $createdAtBlockHeight)` index is optional and can be added later, since indexes are additive on a fresh registration only |
| 5 | forge-collab `comment.path` | none (stays optional plaintext-capable) | it becomes content by client rule (§8.1); the schema does not change |
| 6 | (follow-up, not required) `release`, `label`, `event` | add optional `enc` + `epoch` with `dependentRequired` | to close the §7 plaintext list in a later release; additive. **`event` done** in the review-parity forge-collab (`6BbENuf3uZhkntw9DSsxQcTu9a5fATxQoSe6Ph1JxHkS`, 2026-09-27): optional `enc` (the shared `enc` shape) and `epoch`, `dependentRequired {enc: [epoch]}`; the CLI and the web seal every valued event with it (TLV 15). `release` and `label` are forge-core: **done** in the fresh registration after the beta.6 reset (forge-core `A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1`, 2026-09-28), `dependentRequired {enc: [epoch]}` plus a `noPlain` rule, and kept in the RC1 registration on bonsia. Release sealing is specified in §16, which fits that schema with no change; the clients do not seal releases or labels yet |

The `webhook.secret` `encryptedFor` field, and both contracts' `readonly` decision, are unaffected.

## 14. Review changelog (revision 2)

- **C1** current-maintainer rule for anchors, wraps and the current epoch (§5.3, §5.4); the "revoked maintainer's wraps still count" text is gone; race losers check the winner's author (§5.5); threat table row for removed maintainers; vectors `removed_maintainer_preposted_anchor_ignored`, `revoked_maintainer_wrap_not_current`.
- **H1** anchor = first current-maintainer config by block height whether or not it opens; `KeyMismatch` alert, never skip; key-committing `enc` v0x02 for config with `COMMIT_e` checked before GCM (§4.2, §5.4); "cannot disagree" reworded; split-view vector and `anchor_does_not_open_alert_no_skip`.
- **H2** repair check `wrapped(n) ⊆ members` plus enabled-key coverage, automatic re-rotation (§5.6); vector `rotation_required_when_wrapped_non_member`.
- **H3** `open_content` recomputes `refNameHash`/`baseRefNameHash`/`sourceRefNameHash` (§4.5, §8.1 step 6); negative vector `refUpdate hash mismatch` and a patch equivalent.
- **M1** anchors ordered by `($createdAtBlockHeight, $id)`; contract change #2/#3; writers confirm their anchor is first with a proof-verified read at ≥ its height before using the epoch (§5.5 step 4).
- **M2** late-content rule with `GRACE_BLOCKS = 240` and the current-member exception (§8.2); anchors re-read before every write; old-epoch manifests flagged suspect; vectors `late_content_*`, `manifest_under_old_epoch_flagged_suspect`.
- **M3** `comment.path` → TLV tag 10 and a content field in `is_well_formed`; commit-equality oracles, `patchManifestHash` (ciphertext hash), `sourceRepoId`, header `plaintextLen`/`epoch`, `event.value` added to §7.
- **M4** hardened key index in the encryption-key path, bumped on rekey; blast radius (sent and received wraps) stated; rekey flow add → rotate → disable, with the maintainer-driven repair for writer-only repos (§5.2).
- **L1** `KCV` widened to 14 bytes (wrap stays 64 B), described as error detection. **L2** chain walk requires `prevEpoch < e` (revision 3: `prevEpoch = e − 1`, §5.3) and the key must open the *anchor* of `prevEpoch`; `ChainBroken`. **L3** `enc[0]` in the doc AD; header version in the pack key's domain string. **L4** hedged `fileId`/nonces via `K_hedge,e`; reseed copies sealed bytes; production APIs take no nonce/fileId. **L5** `sizeBytes` check before allocation, `reserved = 0`, header fetched/cached before ranged reads, OID check after inflate. **L6** TLV strictness table (§4.3). **L7** epoch-1 anchor vector description lists tag 6. **L8** hand-rolled segment nonce (not `aead::stream`), WebCrypto HKDF with non-extractable keys, evo-sdk pinned exactly.
- New §13 lists every contract change; all §11 vectors regenerated and cross-checked for the new layouts.

## 15. Open risks for the reviewer

- **Availability cost of C1.** A member whose only wraps came from since-removed maintainers reads nothing until a current maintainer's client runs the repair check. Acceptable given removal always rotates; confirm.
- **Random 96-bit GCM nonces for documents** across many writers, hedged: the collision bound is 2⁻³² at 2³² documents per epoch. Acceptable for a repo; confirm.
- **`GRACE_BLOCKS = 240`** is a judgement call between hiding a removed member's late writes and hiding an honest slow push; the current-member exception covers the honest case.
- **`$ownerId` in AD** assumes the nine sealed types stay non-transferable (they are).
- **Events skip the late-content rule** (§8.1 step 7) on the strength of the forge-collab `event` schema: immutable, non-deletable and `ownerRefersTo`-gated to current maintainers and writers, so a removed member cannot write one under an old key. A contract change that relaxed any of the three would need the rule back; `forge-web/lib/private/event-contract.test.ts` and the Rust `event_schema_is_member_gated_and_append_only` test pin them.
- **Encryption-key custody in the browser** widens the vault's blast radius to "read every private repo, and every key handed out as a maintainer". Passkey PRF must be the default where available.
- **Sealed releases skip the height clause of the late-content rule** (§16.4; the burned clause still applies) on the strength of the forge-core `release` schema: immutable, non-deletable and `ownerRefersTo`-gated to a current maintainer. The same caveat as for events applies: relaxing any of the three needs the rule back, and the rule would then need `$createdAtBlockHeight` in `release.required`.
- **Un-encrypted label definitions** may surprise users; the UI must say so. (Event values, including the labels put on issues, are sealed; releases are sealed once §16 is implemented, and refused on private repositories until then.)

## 16. Sealed releases

Status: specification, revision 2 after two independent security reviews (§16.9). The readers implement it (forge-core `releases()`, `dg release list` and `download`, forge-web `readReleases`), and so do the writers (forge-core `create_release_stored`, `dg release create` and `unpublish`, forge-web `createRelease` through `lib/repo/sealed-release.ts`), and forge-import seals the releases it mirrors into a private destination through `create_release_stored` (`crates/forge-import/src/sealed_release.rs`). The section fits the forge-core `release` type as registered for RC1 on bonsia (§13), which mainnet registers unchanged. It needs **no schema change**, and the documents it produces are accepted by that schema (the "§16" cases of `forge-contracts/vectors/rc1/forge-core.json`, judged by `tools/contract-validate --vectors`).

### 16.0 What the registered contract fixes

- `tagName` is required: a string of 1–63 bytes that matches the ref-grammar `pattern`. It keys three indexes, none of them unique: `tag (repoId, tagName, $createdAt)`, `created (repoId, $createdAt)` and `perTag (repoId, tagName)`, which is `summable` on `delta` and `rangeSummable`.
- `enc` (`$defs.enc`, 29–1536 bytes) and `epoch` (u32), with `dependentRequired {enc: [epoch]}`. The dependency is one-way: `epoch` without `enc` is admitted.
- `noPlain`: a document either has no `enc` and `vis = "public"`, or carries none of `name`, `notes`, `assets` and `assetManifest`. `yanked` and `imported` are outside the rule.
- `oneLive`: with `enc` present, `delta = 0`. Otherwise the tag's `delta` sum after the write must be `min(delta + 1, 1)`. The live suite refuses a sealed release with `delta = 1` (`rc1-live.mjs`, "a sealed release that publishes").
- `vis` is required, and `ownerRefersTo` needs a current `maintainer` document of the repository with the same `vis`. So only a current maintainer writes a release, and a private repository's releases are stamped `private`.
- `documentsMutable: false` and `canBeDeleted: false`: every revision is a new document, and none is ever removed.
- `release.required` has no `$createdAtBlockHeight`, so a release carries no network-set height. Its only time is `$createdAt`.

Sealing a release is therefore **not** entirely a consensus rule: the contract also admits a `vis = "private"` release with no `enc`, a plaintext `tagName` and a plaintext `yanked` or `imported`. Readers treat those as malformed (§16.2), but they are on chain.

That gives four constraints, handled below:

- `tagName` must be a keyed hash that fits 63 bytes of the grammar (§16.1).
- Every sealed document has `delta = 0`, so the per-tag ledger and its "one live release" guarantee become client-side (§16.3).
- The whole sealed content must fit 1536 − 29 = **1507 bytes** of plaintext (§16.2), so the asset list, and long notes, live in a sealed artifact (§16.5).
- The height part of the late-content rule cannot be judged, and is not needed. Its burned-epoch part needs no height and still applies (§16.4).

### 16.1 The plaintext `tagName`

```
K_tag,e = HKDF-Expand(PRK_e, "dash-forge/v2/tag" ‖ 0x00 ‖ u32(e), 32)      (§2.2 label "tag")
tagName = base64url(HMAC-SHA256(K_tag,e, tag))                              (RFC 4648 §5, unpadded: 43 characters)
```

`tag` is the release's tag as UTF-8, and `e` is the epoch the revision is sealed under, the document's `epoch`. The tag must be 1–63 bytes of the contract's `tagName` grammar (`rules::is_legal_tag_name`). The writer checks it before sealing, and the reader checks it again after decrypting, so a sealed tag never escapes the public grammar.

- **It fits the contract.** The result is 43 characters of `[A-Za-z0-9_-]`, which the `tagName` pattern admits at every position: no `.`, `/`, `@` or `{`, and a leading `-` is legal (RC1 vector `tagName '-Ab3_x9QkZ'`). Both reviews fuzzed the pattern against random HMAC outputs and against `is_legal_tag_name`, and found no disagreement.
- **It has its own subkey, not `K_ref,e`.** `K_tag,e` and `K_ref,e` are independent HKDF outputs, so the release-tag and ref-name hash domains are independent PRFs. A release's `tagName` never equals, and never derives from, any `refNameHash`, `baseRefNameHash` or `sourceRefNameHash`, whatever the tag is called. For example, the tag `refs/heads/main` gives `365b9_MPzBqkrDwjvQNRk03R0LJ96TexlyGFYJkoUbY`, while the branch's `refNameHash` under `K_ref,0` is `e729d18b…` (`private_release_seal__tag_named_like_a_branch`). So an outsider cannot link a release to its `refs/tags/<tag>` update by equal hashes. That link is also why `HMAC(K_ref,e, "refs/tags/" ‖ tag)` was not used. A writer that hashes under `K_ref` produces a document readers refuse (`private_release_open__tag_name_under_ref_key`). `K_tag,e` is only ever an HMAC key. In the browser it is derived as a non-extractable HMAC key, like `K_ref,e` (§10).
- **It is per epoch, like ref names (§4.5).** A removed member cannot use a dictionary to confirm that a tag exists in an epoch created after their removal. The cost is that one tag's revisions carry a different `tagName` in each epoch, so readers group revisions by the decrypted tag (§16.3).
- **Readers compare strings, never decode.** The 43rd character carries 2 unused bits, so four spellings decode to the same 32 bytes. A reader computes the canonical encoding and compares it with the document's `tagName` as bytes, in constant time. Any other spelling is `Malformed` (`…__tag_name_noncanonical_base64`). The AD binds the string itself, not its decoding (§16.2).
- Values (inputs of §11): `K_tag,0 = c0fde38636cc9f84810a94cd882035292ca5891c5884563869b17b5231bf91ee`. The tag `v1.0.0` gives `A0TK3ZkbqTL94-CbAhgvnnKHPpCVVjvXTNKOyh6BhlM` under epoch 0 and `RIgIOsyi-3hmGZTqr75wHSm48J_2WLR3WawK5CVj4Qg` under `K_1`, epoch 1.

### 16.2 `enc`: framing, associated data and TLV

`enc` is version `0x01` (§4.1) under `K_doc,e`, with a hedged random nonce (§3.6). The AD is §4.4's with `docType = "release"` and **`bind` = the document's `tagName` string** (its 43 ASCII bytes):

```
AD = "dash-forge/v2/doc" ‖ 0x00 ‖ 0x01 ‖ repoId(32) ‖ $ownerId(32) ‖ u32(epoch) ‖ "release" ‖ 0x00 ‖ tagName
```

The prefix up to `u32(epoch)` has a fixed length, and no `docType` contains `0x00`, so no release AD equals another type's. The AD binds the repository, `$ownerId`, the epoch, the type and the `tagName`, so a revision's `enc` cannot be:

- moved under another tag (`…__enc_moved_to_other_tag` → `BadTag`);
- moved into another repository or epoch;
- re-posted as another maintainer's (`…__other_owner` → `BadTag`).

`release` is not transferable, so binding `$ownerId` is safe (§4.4). What the AD cannot stop is a copy of one of a maintainer's own earlier `enc`s, posted under their identity. That needs only their signing key, not the content key, and §16.3 ignores such copies.

Maximum plaintext: forge-core's `enc.maxItems` 1536 − 29 = **1507 bytes**. The collab types get 5091.

TLV (§4.3 strictness unchanged), for kind `release`:

| tag | field | type | reader cap | writer |
|---|---|---|---|---|
| 2 | `notes` (the `body` tag) | UTF-8 | ≤ 5120 chars and bytes (in practice ≤ 1504 − the other records) | never written empty; a prefix when the notes continue in the manifest (flag `0x10`) |
| 13 | `importedAuthor` | UTF-8 | 1–120 chars, ≤ 480 B (as §4.3) | the release schema's `imported.author` cap: ≤ 64 chars, ≤ 256 B |
| 14 | `importedUrl` | UTF-8 | 1–300 B | same |
| 16 | `tag` | UTF-8, **required** | 1–63 B, the `tagName` grammar | same |
| 17 | `name` | UTF-8 | 1–120 chars, ≤ 480 B | same |
| 18 | `targetOid` | bytes | exactly 20 or 32 B | the commit the tag named at publish, when the writer knows it |
| 19 | flags | u8, **required** | exactly 1 B; `0x01` prerelease, `0x02` draft, `0x04` yanked, `0x08` unpublished, `0x10` notes continue in the manifest; any other bit is malformed | always written, `0x00` when no flag is set |
| 20 | `importedCreatedAt` | u64 | exactly 8 B, ≤ 2⁵³ − 1 | `imported.createdAt` (ms) |
| 21 | `assetManifest` | bytes | exactly 32 B | the `packHash` of the sealed kind-4 manifest (§16.5) |
| 64 | padding | zero bytes | skipped, as every extension tag | see below |

The rules for these records:

- Tags 16–21 are release-only. In every other kind they are malformed, as "not listed for the kind" (§4.3), so no reader of an existing kind changes. Tags 22–63 stay reserved. Tags 2, 13 and 14 keep their meaning and reader caps. Tags 1, 3–12 and 15 are malformed in a release (`…__tlv_title_in_release`).
- Tags 16 and 19 are required. Flag `0x10` requires tag 21. Provenance needs its URL, as the public `imported` object does: tag 13 or 20 without tag 14 is malformed (`…__tlv_imported_without_url`).
- **Flags are always written.** An edit, a yank and an unpublish then differ in length only by what they change, never by a flag appearing.
- **Padding.** After the records, the writer appends one tag-64 record of zero bytes that brings the TLV to the next multiple of 32 bytes. It never takes the TLV past 1507 bytes, and is left out when not even its 3-byte header fits. Readers skip it like any extension record (§4.3). It costs at most 34 bytes (about 0.9 M credits) and hides the exact length of short revisions, a tag-only one included.
- **Draft and pre-release are sealed-only flags.** The public `release` has no draft, and it derives pre-release from the tag's suffix (`is_prerelease`). A sealed release is a pre-release if flag `0x01` is set **or** its tag has a pre-release suffix, so it is never less of a pre-release than the public rule makes it. Draft is a label, not access control (§16.3). `dg release list` prints both. Adding them to public releases would be a platform-parity item (`docs/design/platform-parity-spec.md`), not part of this section.
- **Budget.** The records, without the padding, must fit 1507 bytes; the TLV sealer refuses anything larger with `TooLarge` (vectors `…__at_enc_cap`, `…__over_enc_cap`). The release writer does not hit that refusal with a manifest available. If the notes do not fit whole, it puts the full notes in the manifest's `notes` (§16.5), keeps in tag 2 a prefix cut on a character boundary, and sets `0x10`. The prefix is left out when it would be empty. With the schema's caps every other record totals at most 1,196 bytes, so the prefix always has room for at least a few hundred bytes. The CLI says "a private release holds 1507 bytes of tag, name, notes preview and provenance". The web composer shows the budget as it does for issues.

**The document.** A writer's release carries exactly `repoId`, `tagName` (§16.1), `vis = "private"`, `delta = 0`, `epoch` and `enc`, plus the `$createdAt` every document has. The seal vectors' `props` list all of these but `repoId` and `$createdAt`. A writer never puts on a sealed release:

- `name`, `notes`, `assets` or `assetManifest`, which `noPlain` refuses;
- `yanked` or `imported`. The contract admits both next to `enc`, so this is a client rule: a sealed release carrying either, `yanked: false` included, is `Malformed` and hidden (`…__plaintext_yanked_next_to_enc`, `…__plaintext_imported_next_to_enc`). `imported` requires a plaintext `url`, which would publish the source.

Rules v2 `is_well_formed` gains `ContentKind::Release`, whose plaintext content fields are `name`, `notes`, `assets`, `assetManifest`, `yanked` and `imported`. A release of a private repository without `enc` and `epoch` is malformed, like every other private content type (`…__private_without_enc`). A release that carries `enc` in a public repository is malformed too: public readers hold no keys (`…__public_with_enc`). A public release with `epoch` and no `enc` has its `epoch` ignored.

### 16.3 Revisions, `delta` and `oneLive`: the ledger moves to the reader

Every sealed release has `delta = 0`. For a private repository that means:

- `perTag` sums to 0 for every tag. The proved release count (forge-web `readReleaseCount`, the "Releases N" of a public repository) is not a count here, and clients neither call it nor show it for a private repository.
- Consensus no longer keeps one live release per tag. Two maintainers may publish the same tag at the same time, and both revisions land.

**The fold** (`private_release_fold__*`) runs over the revisions a reader opened (§16.4):

1. **Order.** Revisions are ordered by `($createdAt, $id)`, with `$id` compared as its **raw 32 bytes**, as §5.3 orders anchors, never as base58 strings (`…__tie_by_raw_id_bytes`).
2. **Replays are ignored.** An honest writer never produces the same `enc` twice: the hedged nonce is fresh every time. A `Readable` revision whose `enc` equals an earlier revision's is a copy, and the fold ignores it. Such a copy needs only the maintainer's signing key: a spend-capped AUTH key, which never holds the content key (§5.2). Without this rule the copy would become the newest revision and could reverse a yank or an unpublish (`…__replay_ignored`).
3. **Group by the decrypted tag** (tag 16), compared as bytes, across all epochs (`…__across_epochs`).
4. **The newest revision of a tag is the release**, and the others are its history, newest first.
5. **Unpublish.** The tag is live unless its newest revision has flag `0x08`. Every revision of an unpublished tag is history. A later revision without the flag publishes the tag again (`…__unpublish_and_republish`).
6. **A revision is a complete statement.** The writer carries forward every field it does not change: name, notes, target, provenance, manifest. This holds for an edit, a yank **and an unpublish**. A reader never merges fields across revisions.

**What readers show:**

- **Count**: the live tags whose newest revision is not a draft. A yanked release is still live and counts, as on a public repository (`…__draft_not_counted`).
- **Latest release**: each client's public rule (`latest_release`, `latestRelease`) over the live releases that are not drafts, with pre-release as in §16.2 and yanked from the flag.
- **Order**: each client's public order: `dg` by version, the web by publish date (`importedCreatedAt`, else `$createdAt`).
- **Drafts** are shown to every member, marked "draft". Every member holds the key, so a draft is a label, not access control.
- **Unreadable revisions** (`NoEpoch`, `NoKey`, `BadTag`, `Late`, `Malformed`) are hidden and counted, as §8.1 counts them: "n release revisions could not be read".
- **A tag in doubt.** A revision that does not open (`BadTag`, `Malformed`) but shares an epoch and a `tagName` with one of a tag's readable revisions, and is newer than the tag's newest readable revision, puts the tag in the fold's `unknownTags`. The tag is shown with its newest readable revision, marked "a newer revision of this release could not be read; its state is unknown" (`…__newer_unopenable_same_tag_name`).
- **A stale list.** A `NoKey` revision has no tag the reader can compute. When one is newer than every readable revision, the fold sets `stale`, and the list says "releases may be out of date: newer revisions are under a key you don't hold yet". This is typically a member whose wrap for the current epoch lags (§5.4) (`…__newer_revision_under_missing_key`).
- **EarlierUse.** A revision sealed under an earlier use of an epoch number (§8.1 step 7) cannot be told from tampering by height, because a release has none. Readers compare its `$createdAt` with the block time of `stated(e)`, best-effort (`$createdAt` is set by the client). A `BadTag` revision before that time is reported as "sealed under a key this repository no longer uses", not as tampering.
  - **How the time is taken.** The time of `stated(e)` is the earliest `$createdAt` of epoch `e`'s configs at the block height where its current key was first stated; a later re-anchor does not move it.
  - **Counting.** Such a revision is counted among the hidden ones, and does not put its tag in doubt (it is not `BadTag`).
  - **Where it is shown.** `dg release list` shows "n release revision(s) could not be read (m sealed under a key this repository no longer uses)" (JSON `earlierUse`), and so does the web releases page.

  (forge-core `Keyring::open_release`, forge-web `releaseStatusOf`.)
- **A non-member** sees no tags, names or count. The repository page is already locked (§9), and its Releases tab says the releases are encrypted.

**Lookups.** Every read, including `dg release download <tag>`, lists the repository's revisions through `created (repoId, $createdAt)` and filters locally. Clients never query `tag` or `perTag` with a keyed `tagName`. A burst of one query per epoch would show the node that answers which `tagName`s across epochs are one tag. Releases are few, so listing costs little.

**Writers.** Before writing, a writer:

1. re-reads the anchors (§5.3) and every revision of the tag (to carry fields forward);
2. seals with fresh randomness (§3.6), so it never repeats an `enc`.

After the write it reads the tag's revisions again, at a height at or above the write, and warns when its revision is not the newest. "Your revision is older than X's": either a concurrent revision (a lost update: the writer carried forward fields that another maintainer changed meanwhile) or a clock behind the other writer's, since `$createdAt` is set by the client. Consensus no longer refuses the race, so the warning is the guard. The CLI prints it, and the web shows it with the other revision.

### 16.4 Epochs, keys and reading

**Which key seals a revision.** A revision is sealed under the writer's write epoch (§5.3): the current epoch, not burned, with the repair check passing. Writers re-read the anchors before every write. The document's `epoch` names that epoch, and the `tagName` and the AD use the same one. An edit, a yank or an unpublish is a new revision under the **current** epoch. Unlike a PR (§4.5), nothing ties a release to its first epoch, because revisions are grouped by the decrypted tag. Rotation re-seals nothing: revisions written before a removal stay readable to the removed member, as issues do (§5.5).

**How readers find the key.** As for every sealed document: an accepted wrap for `epoch` (§5.4), or the chain walk from a later anchor (§5.3). A member added later reads older revisions through the chain.

**`open`**, in the order of §8.1:

0. **Well-formedness, before any key is used.** The document has `enc` and `epoch`, no plaintext content field (§16.2), `vis = "private"` and `delta = 0`, and its `tagName` is 43 base64url characters (`…__tag_name_not_43_base64url`). The contract guarantees `delta = 0` when `enc` is present; readers check it anyway.
1. **Framing.** `len(enc) ≥ 29` and `enc[0] = 0x01`, else `Malformed` (`…__enc_version_2`).
2. **Epoch and key.** The epoch exists, else `Unreadable(NoEpoch)`. The reader holds its key, else `Unreadable(NoKey)`.
3. (Config only in §8.1; releases carry no commitment.)
4. **AES-GCM** under `K_doc,epoch` with the §16.2 AD, else `Unreadable(BadTag)`.
5. **TLV.** The TLV parses per §16.2, else `Malformed`.
6. **The `tagName` check.** This is §4.5's H3 check for releases. The reader recomputes `base64url(HMAC(K_tag,epoch, tag))` from tag 16 and compares it with the document's `tagName` as bytes. A mismatch is `Malformed` (`…__tag_name_hash_mismatch`). Without the check, one revision could be indexed under one tag and name another, and a lookup by tag would disagree with the list.
7. **Late content, burned clause only.** A revision under a **burned** epoch is `Unreadable(Late)` unless its `$ownerId` is a current member (§8.2), and this needs no height. It closes a plant: a maintainer is wrapped `K_{n+1}` by a rotation that crashes, writes a release under `n+1` that no one else can see yet, and is then removed. The resumed rotation burns `n+1`, which anchors it, and without the clause the planted revision would open for everyone (`…__under_burned_epoch_by_removed_owner`, `…__under_burned_epoch_by_current_maintainer`).

The height clause of §8.2 does not apply. Like a member `event` (§8.1 step 7), a release carries no `$createdAtBlockHeight`, and it does not need the clause: consensus admits a release only from a current maintainer (`ownerRefersTo`), and releases are immutable and undeletable, so a removed maintainer cannot write one under any key (`…__late_rule_not_applied`). A contract change that relaxed any of the three would need the clause back, and `$createdAtBlockHeight` in `release.required` (§15).

**The `tagName` check also commits to the key.** AES-GCM does not commit to its key, so a maintainer could in principle craft one `enc` that opens under two keys (a split view, §5.4). Such a revision is `Readable` only where `HMAC(K_tag, tag)` matches the one `tagName` on the document, for both keys and both decrypted tags. That needs a cross-key HMAC-SHA256 collision, which is infeasible. A sealed release therefore cannot read as two different releases to two members. §5.4's `KeyMismatch` detects the split view itself.

### 16.5 Assets: a sealed kind-4 manifest and sealed files

A sealed release never lists assets in `enc`: at about 255 bytes per entry, 1507 bytes hold a handful at most. Its asset list is always a `packManifest` of **kind 4** (`releaseAssets`, `docs/design/release-asset-manifest.md` §1.2), stored **sealed** like every artifact of a private repository (§3): same header, per-file key and segments; `packHash = SHA-256(sealed bytes)`; `sizeBytes` is the sealed length. Tag 21 holds that `packHash`.

**The `packManifest` document publishes nothing about the list.** On a private repository, a kind-4 manifest has `objectCount = 0`, no `tips` and no `supersedes`. `chunkCount`, `storage` and `uris` are as for any artifact. Otherwise `objectCount` would publish the asset count, `tips` the target commit, and `supersedes` a link between two revisions' manifests across epochs. Readers ignore the three fields on kind 4. The RC1 vector "sealed release asset manifest (kind 4, §16.5)" is accepted by the registered schema.

**The plaintext** is canonical JSON: UTF-8, keys sorted by code point, no insignificant whitespace, non-ASCII characters not escaped, integers without a fraction or exponent. It uses the v1 format of release-asset-manifest.md §1.2 with these keys, and no others:

- `v` is `1`.
- `tag` is the plaintext tag (tag 16). A reader refuses a manifest whose `tag` differs (`…__manifest_for_another_tag`). The `tag` ties the manifest to one tag, and tag 21, inside a maintainer's `enc`, ties it to one revision.
- `total` equals the number of `assets` (`…__manifest_total_mismatch`).
- `notes` (new, sealed-only; 1–5120 chars and bytes, the public notes cap) holds the full notes. It is present **exactly** when the release sets flag `0x10`, and the reader then shows it in place of tag 2's prefix (`…__manifest_notes_without_flag`).
- `source` is as in §1.2, for imports. If present, it is non-empty.
- `assets` is a list of `{name, sha256, sizeBytes, uris, sealedSha256, sealedSizeBytes}`:
  - `name` is non-empty. `uris` holds 1–8 non-empty strings.
  - `sha256` and `sizeBytes` describe the **plaintext** file: what the user downloads and checks against a `SHA256SUMS`, with the same meaning as on a public release.
  - `sealedSha256` (64 lowercase hex) and `sealedSizeBytes` describe the sealed object that `uris` point at. That object is a §3 artifact of its own, with its own hedged `fileId`, sealed under the revision's epoch. A sealed entry always has a 64-hex `sha256` (the writer hashed the file it sealed), and `sealedSizeBytes ≥ 36 + sizeBytes + 16` (`…__manifest_sealed_entry_without_sha256`, `…__manifest_sealed_size_too_small`).
  - An entry without `sealedSha256` and `sealedSizeBytes` is an **external link**: an import whose source file could not be fetched and sealed. Its `sha256` may be `""`, as on a public release. Its URL is inside the sealed manifest, so it is not published. Readers show it as external and "not verified", warn before opening it (it contacts the source's host), and never try to open it as sealed.

**A reader:**

1. refuses a manifest whose `sizeBytes` is over **1 MiB**, before fetching anything (`…__manifest_over_size_cap`);
2. fetches the manifest by `(repoId, packHash)`, and checks `SHA-256(copy)` against tag 21 before any decryption. A mismatch is a failed copy, and the reader tries the next (`…__manifest_hash_mismatch`);
3. runs the §3.5 checks with the key of the header's epoch, which may be older than the revision's;
4. parses the JSON and requires the plaintext to be **its own canonical re-encoding, byte for byte**. This refuses whitespace, duplicate keys, other escapes and number spellings such as `1.0`, which two JSON parsers could read differently and so show two different lists (`…__manifest_not_canonical`, `…__manifest_version_float`);
5. checks the keys above: `v`, `tag`, `total`, `notes` against flag `0x10`, and every entry.

Any failure is `manifestMismatch` or `SealedPackCorrupt`. The revision is then shown without assets ("asset list unavailable") and without the continued notes (tag 2's prefix, marked incomplete).

A kind-4 manifest is only ever reached through tag 21 of a readable revision. One that no readable revision names is ignored, never listed. §8.2's "uploaded under an old key" flag never makes one that is named unreadable: the maintainer's `enc` commits to its exact bytes. Maintainers are still warned of a late upload (below). A later revision may keep naming an unchanged older manifest: anyone who can open it could before.

**Upload before sign, same epoch.** A writer uploads the sealed assets and the manifest first, then writes the release. Every artifact it newly writes for a revision must carry, in its sealed header, the revision's `epoch`. After the final anchor re-read before signing (§5.3), if the write epoch has changed, the writer re-seals and re-uploads under the new epoch (or aborts) before it signs. Otherwise a rotation that lands during a long upload would leave the new assets readable to the member it removed. Readers also warn maintainers when a named kind-4 `packManifest`, which carries a `$createdAtBlockHeight`, was written after `H + GRACE_BLOCKS` for its header epoch `e`, `H` being the height of `stated(next(e))` (§8.2). How the warning is judged and shown:

- **The first upload decides.** The height is the list's first upload, the lowest `$createdAtBlockHeight` among its kind-4 copies. A later copy, such as a `dg reseed` of the same bytes, does not count.
- **Burned epochs.** A list whose header names a burned epoch is always late, as §8.2's burned clause makes any content under one.
- **No member exception.** The list stays readable, because the revision's `enc` commits to it. The warning is what a member removed by the rotation may read, whoever uploaded it.
- **What it says.** `dg release list` (JSON `assetListUploadedLate`) and the web release page say, to maintainers only: "uploaded under an old key, after the key was rotated: a member removed since may be able to read it; publish the release again with its files to seal a new list".
- **No verdict.** A list whose header no copy serves is not judged.

(forge-core `Collab::late_asset_lists`, forge-web `assetListUploadedLate`.)

**Storage.**

- **External storage only.** A writer stores a sealed release's asset objects and its kind-4 manifest on the external targets of the repository's storage policy (S3, R2, IPFS and the like). It never stores them as Platform `chunk` documents, even when the policy also names Platform. The kind-4 `packManifest` it records has `storage = 1` and `chunkCount = 0`.
  - Under a policy with no external target, a revision with new files is refused before anything is sealed or stored: `dg release create` says "no storage for the assets", and the web says it needs storage of your own. A revision that needs a new list only for notes that continue in it is refused when the list is to be stored, before anything is uploaded or written.
  - An edit that keeps the list as it is needs no storage.
  - Readers follow a kind-4 `packManifest` to wherever it says the list is, Platform chunks included, so a list another client stored on Platform still opens.
  - This matches forge-core (`dg release create`'s asset targets are the policy's external ones), forge-web (`NO_EXTERNAL_STORAGE`) and forge-import (the policy's non-Platform profiles).
- An object stored under a content name uses `sealedSha256`, **never** the plaintext `sha256`. A plaintext-hash name would tell an outsider which public binaries a private repository ships (§3.4's reasoning for `packHash`).
- A sealed manifest is not content-addressed across runs: a re-seal gives a new `packHash`. So a retried release reuses the manifest it already uploaded (it is on chain under its `packManifest`) instead of sealing a new one (release-asset-manifest.md §1.3). Before it seals a new list, a writer looks among its own kind-4 manifests (the same `$ownerId`) that no readable revision names and that were recorded after the revision it carries forward, newest first, opening at most four. It reuses one only when all of these hold:
  - it opens under exactly the write key;
  - it states exactly the list the writer would build: the same tag, the kept entries unchanged, then each new file with the same name, `sha256` and size (sealed, so its URIs and sealed hash are the earlier attempt's), the same continued notes and the same `source`;
  - each new file it names is still stored, sealed under the write epoch at its recorded sealed size (the writer reads the header of the file's first copy that answers).

  Nothing is sealed or uploaded again: not the list, not the files. A list under any other key (the epoch moved since) is not reused, and the writer seals anew. If the key moves after a reuse and before signing, the reused list is reported with what is left named by nothing. The search is best-effort: a candidate that cannot be read or checked is skipped, and the worst case is the old behaviour, a new list. The web lists the newest 100 kind-4 manifests of every uploader (no index narrows by `$ownerId`). It never bounds that query by the carried revision's `$createdAt`, which would show the node which revision the next one belongs to (§16.3). (forge-core `stored_asset_list`, forge-web `storedAssetList`.)
- `dg reseed` and mirrors copy the sealed bytes verbatim.

**Padding (optional).** A writer MAY pad a sealed asset's plaintext with zero bytes (for example to a multiple of 64 KiB). The manifest's `sizeBytes` and `sha256` stay the file's own. Readers MUST truncate the decrypted plaintext to `sizeBytes` before checking `sha256`. The reader rule is mandatory, so writers can adopt padding later without a format change (§16.6).

Vector `private_release_seal__manifest_kind4` pins the canonical JSON and its sealed bytes (830 B, `packHash = 4a3f5093cd8d639b3f998ec93e3ebb5628c53b819f12895a4a54c62f6e8746fa`). Its first asset is the 40,000-byte file of the §11 pack vector, sealed exactly as that vector seals it (`sealedSha256 = 7e7e4e4e…`, `sha256 = 8f272ca6…`).

### 16.6 What an outsider learns

Anyone with the chain and the storage learns:

- **The revisions.** That a release revision exists, when (`$createdAt`), which maintainer wrote it, and its epoch; so the number of revisions.
- **Revisions of one tag, within an epoch.** Which revisions share a tag (equal `tagName`), and so the number of distinct tags in that epoch and how often each was revised. Equal `tagName`s link nothing across epochs.
- **Lengths.** The `enc` length is the padded TLV length plus 29 bytes, so revision lengths come in 32-byte buckets. A flag change never changes the length (the flags record is always written), and an unpublish carries every field forward, so a yank or an unpublish is as long as the edit it follows. A change to the name, notes or target can move a revision to another bucket. Revisions of similar length by the same maintainer around a rotation can be guessed to be one tag: length and timing are a weak link across epochs, never a proof. The tag-only revision `v0.1` is 61 bytes of `enc`, like every other TLV of up to 32 bytes.
- **The manifest.** The kind-4 manifest's `packManifest`: uploader, time, sealed size (about the canonical JSON's size, so roughly the number of assets and the length of the continued notes), chunk count and storage URIs. Its `objectCount`, `tips` and `supersedes` carry nothing (§16.5). Timing likely links it to its release, even though the link itself is inside `enc`. The `kind` index lets anyone count a repository's kind-4 manifests, which is roughly the number of revisions with assets.
- **The asset objects** in storage: how many, their upload times and download patterns, and their sizes. The sealed header carries each object's exact `plaintextLen` (§3.2). Unless a writer pads (§16.5), those exact sizes can match an imported release to the public source release it mirrors, even with the source URL sealed. The importer warns about this on a private destination.
- **The likely target commit, by timing.** A `refs/tags/*` ref update just before a release names its commit in plaintext `newOid` (§7's commit-equality oracle). Sealing `targetOid` hides nothing the ref update shows; it adds nothing either.
- **Nothing from `delta` or `perTag`**, which are always 0.
- **Queries.** What a DAPI node sees of a reader's queries is traffic analysis, which is out of scope (§6). Clients never look up a tag by its keyed name (§16.3), so no query links a tag across epochs.

Hidden: the tag, the name, the notes, the flags (draft, pre-release, yanked, unpublished), the target commit, the provenance, the asset names, hashes and URIs, and which manifest a revision names.

A **removed member** keeps every revision, manifest and asset sealed under an epoch they held, forever, as for all content (§6). After the rotation they read nothing new: a writer re-seals the artifacts of a revision that straddles the rotation (§16.5). They cannot test tag names by dictionary in the new epochs.

**Keys and nonces.** A release's `enc` nonce is a hedged 96-bit random value under `K_doc,e`, shared with the epoch's other documents. The §15 bound is unchanged; releases only add to the per-epoch count. Manifests and asset files use per-file keys with counter nonces (§3.3), so no nonce repeats under any key. `K_tag,e` is used only as an HMAC key, and no subkey serves two purposes. The vectors use a fixed nonce and fixed file ids through the test-only constructors of §3.6, with a distinct file id per test manifest.

### 16.7 Vectors

**Where they come from.** The vectors are written by `tools/private-repos-vectors/gen.py`, the independent Python reference. `gen.py` also asserts §16.1's values and the `v1_0_0` TLV and `enc` against this document. forge-core's `private::release` (`crates/forge-core/src/private/release.rs`) and forge-web's `lib/private/release.ts` reproduce every file byte for byte in their conformance tests. The fixed inputs are §11's (`repoId = 0x11×32`, `$ownerId = 0x22×32`, `K_0`, `K_1`, nonce `000102…0b`).

**`private_release_seal__*`.** The input is the key, epoch, owner, nonce and release fields. The output is `tagHash`, `tagName`, the AD, the padded TLV, `enc` and the document's plaintext properties (`props`); or the writer's refusal (`malformed`, `tooLarge`).

- Accepted:
  - `v1_0_0` (125 B `enc`);
  - `v1_0_0_epoch1`, with a different `tagName` under epoch 1;
  - `tag_only`;
  - `prerelease_draft`;
  - `yanked` and `unpublished`, both carrying every field forward, and both as long as `v1_0_0`;
  - `imported_with_manifest`, with every tag and a 32-byte target;
  - `tag_named_like_a_branch`;
  - `at_enc_cap`, a 1536-byte `enc` with no room for padding.
- Refused:
  - `over_enc_cap`;
  - `illegal_tag`, `tag_64_bytes` and `empty_tag`;
  - `name_121_chars`;
  - `notes_continue_without_manifest`;
  - `target_oid_21_bytes`;
  - `imported_author_65_chars`, the writer's release cap;
  - `imported_author_without_url`.
- Also `manifest_kind4`, the sealed manifest.

**`private_release_open__*`.** The input is the reader's context (§11's shape) and a stored document, or a sealed manifest with the release's `tag`, tag 21 and flag `0x10`. The output is `readable` with the fields, `unreadable` with its reason, `malformed`, a readable manifest or `manifestMismatch`. Covered:

- opens: `v1_0_0`, `v1_0_0_epoch1`, `imported_with_manifest` and `late_rule_not_applied`;
- the burned clause: `under_burned_epoch_by_removed_owner` (`late`) and `under_burned_epoch_by_current_maintainer`;
- unreadable: `no_key`, `no_epoch`, `other_owner` and `enc_moved_to_other_tag`;
- step 0 and framing: `enc_version_2`, `tag_name_not_43_base64url`, `private_without_enc` and `public_with_enc`;
- the `tagName` check: `tag_name_hash_mismatch`, `tag_name_noncanonical_base64` and `tag_name_under_ref_key`;
- plaintext next to `enc`: `plaintext_yanked_next_to_enc` and `plaintext_imported_next_to_enc`;
- TLV:
  - the required tag and flags: `tlv_without_tag`, `tlv_without_flags` and `tlv_flags_zero` (readable);
  - bad flags: `tlv_flags_unknown_bit`, `tlv_flags_two_bytes` and `tlv_notes_continue_without_manifest`;
  - field values: `tlv_notes_empty` (readable, empty notes), `tlv_target_oid_21_bytes`, `tlv_illegal_tag_grammar`, `tlv_created_at_over_2_53` and `tlv_manifest_31_bytes`;
  - tags and framing: `tlv_title_in_release`, `tlv_tag_twice`, `tlv_extension_before_tag`, `tlv_truncated`, `tlv_extension_skipped` (readable) and `tlv_reserved_tag_22`;
  - provenance: `tlv_imported_without_url`, and `tlv_imported_author_100_chars` (readable: the reader's cap is §4.3's);
- the manifest:
  - `manifest_kind4` (readable);
  - binding to the release: `manifest_for_another_tag`, `manifest_notes_without_flag`, `manifest_over_size_cap` and `manifest_hash_mismatch`;
  - contents: `manifest_total_mismatch`, `manifest_not_canonical`, `manifest_version_float`, `manifest_sealed_size_too_small` and `manifest_sealed_entry_without_sha256`.

**`private_release_fold__*`** (§16.3, a pure function). The input is opened revisions: `id`, `createdAt`, `epoch`, `tagName`, status, `enc` and fields. The output is the live tags, the history, the count, the replays, `unknownTags`, `stale` and the hidden count. Cases:

- `publish_edit_publish`;
- `across_epochs`;
- `unpublish_and_republish`;
- `draft_not_counted`;
- `replay_ignored`;
- `tie_by_raw_id_bytes`, using the ids of `private_epoch__anchor_tie_by_raw_id_bytes_not_base58`;
- `newer_unopenable_same_tag_name`;
- `newer_revision_under_missing_key` and `older_revision_under_missing_key`;
- `late_and_malformed_hidden`.

**RC1 contract vectors** (`forge-contracts/schema/vectors.py`). These use the real `tagName` and `enc` of the `v1_0_0`, `v1_0_0_epoch1`, `imported_with_manifest` and `at_enc_cap` seal vectors, signed by `0x22×32`.

- Accepted, item R-02: those four documents.
- Refused, item R-02: the imported one with its manifest hash also in plaintext (`noPlain`), and the cap one with one more `enc` byte (`maxItems`).
- Accepted, item R-11: the sealed kind-4 `packManifest`, with `objectCount = 0` and no `tips`.

### 16.8 What the implementation changes (non-normative)

- **Readers first.** Today's readers (forge-core `newest_per_tag`, forge-web `newestPerTag`) would list a sealed revision as a release named by a 43-character hash. The first step, before or with any writer, is readers that open and fold per §16.3, and that hide every release carrying `enc` until they do.
- **forge-core.**
  - `private::keys` gains `K_tag,e` and `tag_name`.
  - `private` gains a `release` codec (`private::release`, promoted from the vectors' test-only reference): the TLV and its padding (§16.2), the AD, the open of §16.4, the manifest reader of §16.5 and the fold of §16.3. Its seal draws a hedged nonce and takes no nonce parameter (§3.6).
  - `rules::v2` gains `ContentKind::Release`, and `keyring::header_of` handles `release`.
  - `collab::v2::create_release` seals when the repository is private. It resolves the write epoch and reads the tag's revisions (from the `created` listing) to carry fields forward. It uploads the sealed assets and manifest under the write epoch, re-seals if a final anchor re-read moved the epoch, writes the release with `delta = 0` and no `oneLive` retry, then re-reads and warns (§16.3).
  - `releases()` opens and folds per §16.3.
- **`dg release`.**
  - `create` drops `require_public`. It seals every `--asset` with `PackCipher::seal` before upload and records `sealedSha256` and `sealedSizeBytes`. It writes the manifest (`packManifest` kind 4, `objectCount = 0`, no `tips`) through the push path, and states the 1507-byte budget.
  - `list` and `download` fold per §16.3. `download` checks `sealedSha256`, decrypts, truncates to `sizeBytes`, then checks `sha256`.
- **forge-import** writes a private destination's releases through `create_release_stored`: provenance in TLV 13, 14 and 20 and the manifest's `source`; every source asset it can download within its per-run budget, checked against the source's size and digest, sealed; the others as external links. A re-run compares the folded, decrypted current revision and writes only what changed. It warns that exact asset sizes can identify a mirrored public release.
- **forge-web.**
  - `lib/repo/releases.ts`: `readReleases` opens and folds sealed revisions, shows `unknownTags` and `stale`, and never calls `readReleaseCount` for a private repository.
  - `lib/repo/writes.ts` `createRelease` seals: `PRIVATE_RELEASE_REFUSED` goes.
  - `lib/repo/new-release.ts` seals the files and writes the manifest.
  - The new-release dialog shows the budget and the draft and pre-release switches.
  - `lib/private/conformance.test.ts` drops its skip of `private_release_*`.

### 16.9 Review (revision 2)

Two independent security reviews read revision 1 of this section: a Fable reviewer and a code-review validator. Both found no critical or high issue and no key or nonce reuse. Both confirmed the `K_tag`/`K_ref` separation, the injective AD, the canonical `tagName` comparison, the key-commitment argument and the contract fit. The Fable reviewer's verdict was "sound, with changes needed"; the validator's was "requires changes". Revision 2 applies every finding within the registered contract:

- **Replay by a signing key alone** (validator; the Fable reviewer raised the clock and tie side). The fold ignores a revision whose `enc` repeats an earlier one's. `$id` ties are broken on raw bytes. Writers re-read after the write and warn when they are not the newest (§16.3).
- **Length channel** (both). The flags record is always written, TLV padding goes to 32-byte buckets, and an unpublish carries every field forward. §16.6 was rewritten to match.
- **Kind-4 `packManifest` fields** (both). `objectCount = 0`, no `tips`, no `supersedes`, with an RC1 vector (§16.5).
- **Rotation during a long upload** (validator). The new artifacts carry the revision's epoch, and the writer re-seals if the epoch moved (§16.5).
- **Burned-epoch plant** (validator). The burned clause of §8.2 applies to releases, with vectors (§16.4 step 7).
- **Cross-epoch linkage by queries** (both). Clients never query by keyed `tagName` (§16.3).
- **Unreadable newest revisions and EarlierUse** (both). `unknownTags` and `stale` define exactly what can be known; EarlierUse is judged best-effort by `$createdAt` (§16.3).
- **Manifest parsing** (both). Canonical bytes, a 1 MiB cap, the entry shape, `notes` tied to flag `0x10`, and a non-empty `sha256` on sealed entries (§16.5).
- **Asset-size fingerprint** (both). Documented, with an optional writer padding that readers must support (§16.5, §16.6).
- **Coverage and consistency.** Fold vectors; step 0 now covers `delta`, the `tagName` shape and documents without `enc`; provenance needs its URL; distinct file ids for the test manifests; the nits in §4.3, §10, §11 and forge-v2.md.
- **Draft and pre-release flags** (Fable). Kept, because the owner asked for them, and marked sealed-only (§16.2).
