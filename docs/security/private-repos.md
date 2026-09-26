# Private repositories: key model, framing and rules

Status: design for roadmap Phase 3, revision 2 after an independent cryptographic review ("sound, with changes needed"; every finding is addressed, see §14). Implementers: `crates/forge-core/src/private.rs` (the `RepoCodec`, `RefNameHasher`, `PackCipher`, `RepoKeyReader` seams), `git-remote-dash`, `dg`, and `forge-web/lib/private/`. The contract fields this design writes into are fixed in `docs/contracts/forge-v2.md` §5 and `forge-contracts/contracts/forge-core.json` (`repoKey`, `enc`/`epoch` on `refUpdate`, `protectedRefUpdate`, `config`) and `forge-collab.json` (`enc`/`epoch` on `issue`, `patch`, `comment`, `review`). §13 lists the schema changes this design needs before mainnet registration. Where this document and §5 differ, this document wins and §5 is to be updated with it.

Everything below is normative unless marked as a note. Byte layouts are exact; all integers are big-endian; `‖` is concatenation; `u8`/`u16`/`u32`/`u64` are 1, 2, 4 and 8 bytes.

## 1. Goal and non-goals

Consensus cannot hide data, so privacy is client-side: a private repo's content (pack bytes, ref names, issue/PR/comment/review text, config) is encrypted under a per-repo key that only members hold. The gate the contract enforces (`repoKey` and `config` are maintainer-only) is what stops a non-maintainer from *distributing* keys or *declaring* epochs through the contract; the encryption is what stops everyone else from *reading*; the reader rules in §5 are what stop a former maintainer from doing either after removal.

Phase 3 gate (roadmap): an outsider with full bucket and chain access learns nothing but sizes and timing. §7 lists exactly what "nothing but" means. We do **not** aim for forward secrecy against a removed member for anything they could already read, deniability, hiding the repo's existence, or protecting content from a maintainer who is a maintainer *now* (who by construction can hand the key to anyone).

## 2. Key hierarchy

### 2.1 Epoch key

One repo has a sequence of **epochs** `e = 0, 1, 2, …` (`u32`, strictly increasing, not necessarily contiguous). Each epoch has a 32-byte **epoch key** `K_e`, drawn from the OS CSPRNG (`getrandom` / `crypto.getRandomValues`) by the maintainer who creates the epoch. Nothing is derived from a password or from an identity key; `K_e` is independent of every other epoch's key.

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

The salt binds every subkey to the repo, so a key accidentally wrapped into two repos still yields different subkeys, and the label/epoch in `info` separates purposes and epochs. There are no commit- or tree-level keys: the unit of pack encryption is the whole artifact, as the browse plane already reads packs by byte range.

### 2.3 Key identifiers

An epoch number identifies a key everywhere the contract needs one (`epoch` on documents, `epoch` on `repoKey`, `epoch` in the pack header). `KCV_e` is an *error-detection* code (it tells "wrong key" from "corrupt data" and lets the UI name a key: "epoch 3 · `7cab1ab7…`"); it is not an authentication tag and never authorizes anything. `COMMIT_e` is the *key commitment* an anchor carries; it is what a reader checks a wrap against. No other key id exists.

## 3. Sealed artifacts (packs, locators, flat indexes)

Every `packManifest` artifact of a private repo, whatever its `kind` (0 git pack, 1 objectLocator, 2 flatIndex), is stored **sealed**. The plaintext is the exact bytes a public repo would store, so `git index-pack`, `ObjectLocator::parse` and the flatIndex reader are unchanged after decryption.

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
- `offsetIndexParts` is 0 (it is 0 on every kind already; `manifestPart` is never written).

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

A ranged reader **fetches the header first** (one 36-byte read, or the first segment's range extended to start at 0) and caches it per `packHash` for the session; it never derives a key or nonce from a header it has not read. It decrypts segments `s0..=s1`, concatenates, slices `[a − s0·S, b − s0·S)`, inflates, applies deltas, and **checks the reconstructed object's git OID against the OID it looked up** before returning it; an OID mismatch is `SealedPackCorrupt` for that copy. Over Platform chunks, the sealed range maps to `chunk.seq` by the existing 14,700-byte payload arithmetic; over HTTP/S3/IPFS it is an HTTP `Range`. A blob's `deltaChainSpan ≤ 64 KiB` read costs at most five 16 KiB segments, so the "3–5 requests, O(view) bytes" cold-load budget in `docs/architecture.md` holds with roughly 1.1× the bytes.

### 3.6 Randomness: hedged file ids and nonces

`fileId` (§3.2) and every document nonce (§4.1) are drawn through an RNG hedge, so a weak or repeating CSPRNG cannot repeat a nonce under a key:

```
fileId     = HMAC-SHA256(K_hedge,e, 0x01 ‖ rnd(32) ‖ SHA-256(plaintext))[0..16]
doc nonce  = HMAC-SHA256(K_hedge,e, 0x02 ‖ rnd(32) ‖ AD ‖ SHA-256(plaintext))[0..12]
```

`rnd(32)` is fresh CSPRNG output. Production `seal` APIs (`PackCipher::seal`, `RepoCodec::seal`, and their TypeScript equivalents) take **no** caller-supplied `fileId` or nonce; the deterministic variants used to produce the §11 vectors live behind a test-only constructor (`#[cfg(test)]` / a `vectors` build flag that release builds do not set).

## 4. Encrypted document fields

### 4.1 `enc` layout, version 0x01 (issue, patch, comment, review, refUpdate, protectedRefUpdate)

```
enc = 0x01 ‖ nonce(12) ‖ AES-256-GCM(K_doc,e, nonce, plaintext, AD) ‖ tag(16)
```

Minimum length 29 bytes (schema `minItems` 28 admits it). Maximum plaintext per type is `maxItems − 29`: **5091 bytes** for collab types, **995 bytes** for `refUpdate`/`protectedRefUpdate` under the current forge-core schema.

### 4.2 `enc` layout, version 0x02 (config, always)

Every private `config` is a candidate anchor (§5.3), and AES-GCM does not commit to its key, so `config` carries an explicit commitment:

```
enc = 0x02 ‖ COMMIT_e(32) ‖ nonce(12) ‖ AES-256-GCM(K_doc,e, nonce, plaintext, AD) ‖ tag(16)
COMMIT_e = HKDF-Expand(PRK_e, "dash-forge/v2/commit" ‖ 0x00 ‖ u32(e), 32)
```

A reader **compares `COMMIT_e` against the commitment derived from its own key before running GCM**; a mismatch is `CommitMismatch`, not `BadTag`, and is surfaced as in §5.4. Overhead is 61 bytes; the maximum config plaintext under the current 1024-byte cap is 963 bytes (§13 raises the cap).

### 4.3 Plaintext: TLV

The plaintext is a sequence of records `tag(u8) ‖ len(u16) ‖ value`. No JSON: key order, escaping and number formatting differ across Rust and TypeScript, and a deterministic encoding keeps the conformance vectors byte-exact.

| tag | field | type | in | cap (from the public schema) |
|---|---|---|---|---|
| 1 | `title` | UTF-8 | issue, patch | 1–256 chars, ≤ 1024 B |
| 2 | `body` | UTF-8 | issue, patch, comment, review | ≤ 5120 chars and bytes |
| 3 | `refName` | UTF-8 | refUpdate, protectedRefUpdate | 1–255 B |
| 4 | `baseRefName` | UTF-8 | patch | 1–255 B |
| 5 | `sourceRefName` | UTF-8 | patch | 1–255 B |
| 6 | `defaultBranch` | UTF-8 | config | 1–255 B |
| 7 | `protectedPattern` | UTF-8, **repeatable**, order kept | config | 1–100 chars each, ≤ 8 records |
| 8 | `prevEpoch` | u32 | config anchor, `e ≥ 1` | exactly 4 B |
| 9 | `prevEpochKey` | bytes | config anchor, `e ≥ 1` | exactly 32 B |
| 10 | `path` | UTF-8 | comment (inline review comment) | ≤ 500 chars, ≤ 1000 B |

**Strictness** (any violation is `Malformed`):

- Records are in strictly ascending tag order, except that consecutive tag-7 records repeat; any other repeated tag is malformed.
- A record whose declared `len` runs past the end of the plaintext, or fewer than 3 trailing bytes after the last complete record, is malformed. There are no padding bytes.
- Tags 11–63 are **reserved**: a record with one is malformed. Tags 64–255 are **extension** tags: a reader skips them (forward compatibility) and never interprets them.
- A tag not listed for the document's kind (tag 3 in an issue, say) is malformed.
- Every UTF-8 value must be valid UTF-8, within the cap above, and non-empty unless the cap says otherwise; a zero-length record for a field with `minLength 1` counts as absent. Fixed-size tags must be exactly their size.
- Required fields by kind: issue/patch `title`; comment `body`; refUpdate/protectedRefUpdate `refName`; config anchor with `e ≥ 1` both `prevEpoch` and `prevEpochKey` (and neither is allowed when `e = 0` or in a non-anchor config); review and non-anchor config have none. An empty plaintext is therefore valid only for a review or a non-anchor config.
- Combined size: title + body ≤ 5085 bytes for issues and PRs; comment `body` + `path` ≤ 5085; review body ≤ 5088. The web app and `dg` enforce them before encrypting and say so in the composer.

### 4.4 Associated data

```
AD = "dash-forge/v2/doc" ‖ 0x00 ‖ enc[0] ‖ repoId(32) ‖ $ownerId(32) ‖ u32(epoch) ‖ docType(ASCII) ‖ 0x00 ‖ bind
```

`enc[0]` is the version byte (`0x01` or `0x02`), so a ciphertext cannot be re-framed under another version. `docType` is the contract's type name (`issue`, `patch`, `comment`, `review`, `refUpdate`, `protectedRefUpdate`, `config`). `bind` is the type's immutable plaintext identity:

| type | bind |
|---|---|
| issue, patch | `u32(number)` |
| comment | `targetId` (32) |
| review | `patchId` (32) |
| refUpdate, protectedRefUpdate | `refNameHash` (32) ‖ `oidf(newOid)` ‖ `oidf(prevOid or empty)` ‖ `force` (0x00/0x01) |
| config | `COMMIT_e` (32) |

`oidf(x) = u8(len(x)) ‖ x`. Binding `repoId`, `$ownerId`, `epoch` and the type means a ciphertext lifted from one document cannot be replayed as another: not by an outsider into a new comment in the same repo (different `$ownerId`), not into another repo, not under another type or epoch. `$ownerId` is safe to bind because these seven types are not transferable; making one transferable would be a breaking change to this design. The ref-update binding ties the hidden name to the visible tip, so a stored `enc` cannot be re-used to name a different ref for the same OID. The document's `$id`, `$createdAt` and `$createdAtBlockHeight` are not bound (unknown at encryption time).

### 4.5 Ref-name hashing, and the hash check on read

Private: `refNameHash = HMAC-SHA256(K_ref,e, refName)` with `e` the epoch the update is written under; `patch.baseRefNameHash` and `sourceRefNameHash` likewise under the patch's epoch. Public: `sha256(refName)` (unchanged).

On read, after decryption, `open_content` **recomputes the hash from the decrypted name and compares it with the document's plaintext hash field**: `refNameHash` against tag 3 for ref updates; `baseRefNameHash` against tag 4 and `sourceRefNameHash` against tag 5 for a patch (each only when the hash field is present). A mismatch is `Malformed`. Without this check a writer could index an update under one branch's hash while naming another inside `enc`, and a reader resolving refs from `enc` and a reader resolving from the `refState` index would disagree.

The hash is **per epoch**, so a removed member cannot confirm by dictionary that a branch created after their removal exists. The cost: one ref's history spans several hash values across epochs. Readers resolve ref state from the decrypted `refName` over the reflog index `(repoId, $createdAt)`, as the v2 reader does today; a targeted lookup of one ref (`refState` index) is one query per epoch the reader holds, and rotations are rare.

## 5. Wrapping, anchoring and membership

### 5.1 The `repoKey` wrap

`wrapped` uses `encryptedFor` exactly as the contract declares (`ecdh-secp256k1-aes256-cbc`): shared key `SHA-256(parity ‖ x)` of `senderPriv · recipientPub`, random 16-byte IV, AES-256-CBC with PKCS#7. Implementations call the SDK helpers rather than re-implementing it: Rust `dash_sdk::platform::encrypted_for::{encrypt_property, decrypt_property, EncryptedPropertyEnvelope::read}`; TypeScript `sdk.encryptedFor.encrypt / decrypt / envelope` (evo-sdk `4.2.0-beta.4`, `WasmSdk.encryptDocumentProperty` etc.). They read the declaration from the contract, write `recipientKeyId`/`senderKeyId`, and refuse a wrong-shaped ciphertext.

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

The **anchor** of epoch `e` is the first `config` document, by **`($createdAtBlockHeight, $id)`**, with `epoch = e` **whose `$ownerId` is a current maintainer** (`RoleOracle::current_role == Maintainer`), whether or not the reader can open it. `$createdAt` is written by the client (within a consensus tolerance) and is never used to order anchors; `$createdAtBlockHeight` is set by the network. `config` is maintainer-gated and non-deletable, so an anchor is a maintainer's durable statement "epoch `e` uses the key committed here"; the current-maintainer condition means that statement lapses with the maintainer's membership.

An epoch **exists** when it has an anchor. The **current epoch** is the highest existing epoch. The anchor of epoch `e ≥ 1` carries tag 8 `prevEpoch` and tag 9 `prevEpochKey`: an older epoch's key encrypted under the new one, with `prevEpoch < e` required. Because `config` is newest-wins, an anchor also repeats the current `defaultBranch` and `protectedPatterns`. Epoch 0's anchor is the repo's first `config`, written in the same session as `repo` and the owner's `maintainer` document.

**Chain walk.** Older epochs are reached **only** through the `prevEpochKey` chain starting from an existing (current-maintainer) anchor the reader can open: from `e`, decrypt the anchor, take `(prevEpoch, prevEpochKey)`, require `prevEpoch < e`, derive `COMMIT_prevEpoch` from `prevEpochKey`, and require that it equals the commitment in **the anchor of `prevEpoch`** (again the first current-maintainer config for that epoch). If `prevEpoch` has no anchor, or the commitment differs, the walk stops there with a `ChainBroken` alert naming the anchor's author; nothing below is readable through that chain. An epoch with no anchor (all its configs were written by since-removed maintainers) is not an epoch: its documents and packs are `Unreadable(NoKey)` to everyone and the UI shows maintainers "n documents under an unrecognised epoch".

Writers **never write under an epoch without an anchor**, and re-read the repo's anchors (a proof-verified read of all `config` documents for the repo; they are few) **before every write**, so a rotation that landed since the last write is picked up. Readers **never accept a wrap whose key does not match an anchor** (§5.4).

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

1. Re-read the anchors; let `n` be the current epoch. Draw `K_{n+1}`; journal `(repoId, n+1, K_{n+1})` locally before any write.
2. Post `repoKey` wraps for `n+1` to every **remaining** member's highest enabled encryption key, **self first**.
3. Post the anchor `config` for `n+1` (current config fields + `prevEpoch = n`, `prevEpochKey = K_n`, `enc` version `0x02` with `COMMIT_{n+1}`). This is the commit point.
4. Wait for a proof-verified read at a block height ≥ the anchor's `$createdAtBlockHeight` that lists the repo's configs with `epoch = n+1`; confirm yours is first by `($createdAtBlockHeight, $id)` among those written by current maintainers. Only then does this client write content under `n+1`. (Anything committed at or before that height is visible in that read, so an earlier anchor cannot appear later.)

Cost: `members + 1` transitions, one per state transition (batch cap 1), shown before confirming. Nothing already written is re-encrypted: the removed member could already read it, and rewriting refs would only churn the reflog. The product says so in the words of ux-dx-spec §9.

**Concurrent rotations.** Two maintainers both rotate to `n+1` with different keys. The unique index `(repoId, memberId, epoch, $ownerId)` lets both post wraps. Step 4 decides: the earlier `($createdAtBlockHeight, $id)` anchor **by a current maintainer** is the anchor; the other maintainer sees in step 4 that they lost, checks that the winner's `$ownerId` is a current maintainer (if not, the "winner" is no anchor at all and the loser is in fact first), discards its journal entry and posts nothing more. Its wraps for `n+1` remain on chain and fail check (5) for their recipients, who see a `KeyMismatch` alert naming the loser; the loser's client, on its next visit, sees the same and shows "you posted a superseded key; nothing to do". The winner wrapped for every remaining member, the loser included. Whether the two removals composed correctly is then settled by the repair check below.

**Crash between steps 2 and 3**: `n+1` has wraps and no anchor, so it does not exist and no one writes under it. The journal resumes it; without the journal, the maintainer rotates to the next epoch number that has neither an anchor nor any wrap of its own (epoch numbers need not be contiguous; `prevEpoch` says which epoch precedes).

**Orphan hazard.** A maintainer who posts an anchor for `e` and then loses the key before wrapping anyone leaves `e` unreadable to all but themselves. Self-first wrapping in step 2, before the anchor in step 3, makes this require two independent failures; the repair check makes it visible.

### 5.6 The repair check (every maintainer client, on every visit)

After loading a private repo's membership, `repoKey` and `config` documents, a client whose identity is a current maintainer computes, for the current epoch `n`:

- `wrapped(n)` = the set of `memberId`s with an accepted-shape wrap for `n` from a current maintainer (checks 2–3 of §5.4, no decryption needed; for other members the client cannot open the wrap, and does not need to);
- `members` = current `maintainer` ∪ `writer` holders;
- `enabledKeyOf(m)` = whether the `recipientKeyId` used for `m`'s wrap is still an enabled key on `m`'s identity.

The check passes iff `wrapped(n) ⊆ members` **and** every `m ∈ members` has a wrap for `n` to an enabled key. Otherwise:

- a wrapped identity that is not a member (a removed member who slipped through concurrent rotations, or a wrap posted by a maintainer to an outsider) → **rotate automatically** (§5.5 steps 1–4), with the cost shown; `dg` does it on the next command that touches the repo and prints what it did; the web app does it on the next visit and shows "rotating the repo key: bob still had the current key";
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
| Epoch numbers, when each rotation happened, who rotated, who was wrapped and to which key id | `repoKey`, anchor `config` |
| Number and timing (ms and block height) of ref updates, pushes, issues, PRs, comments, reviews; who wrote each (`$ownerId`) | every document |
| **Commit-level equality oracles**: `refUpdate.newOid`/`prevOid`, `packManifest.tips`, `patch.headOid`, `review.commitOid`, `comment.commitOid`. Anyone who already knows a commit hash can confirm the repo contains it (and roughly when). Commit *contents* stay hidden; git commit ids are not preimage-resistant hiding of content that is public elsewhere | plaintext fields the rules need |
| `force`; event kinds (close, merge, label…) and `event.value` (label names, assignee ids, retarget names are **plaintext**) | `event`, `authorEvent` |
| Which updates share a ref name within an epoch (equal `refNameHash`); which PRs target the same base within an epoch | `refNameHash`, `baseRefNameHash`, `sourceRefNameHash` |
| `patch.sourceRepoId` (which fork a PR comes from, so the fork's membership and activity); `patch.patchManifestHash` (a pointer to a sealed manifest in the fork: a ciphertext hash, not a content oracle) | `patch` |
| Sealed artifact sizes (`sizeBytes`), object counts (`objectCount`), chunk counts, `supersedes`, storage URIs; inside the sealed file, the header's `epoch` and exact `plaintextLen` | `packManifest`, sealed header |
| Approximate plaintext length of every encrypted field (ciphertext − 29, or − 61 for config) | `enc` length |
| Issue/PR numbers, comment targets, `replyTo`, review `verdict`, inline comment `line`/`side` (the `path` is encrypted, §4.3) | plaintext fields |
| `release` (`tagName`, `name`, `notes`, `assets`), `label`, `checkRun` (`name`, `summary`, `detailsUrl`), `webhook.url` | **not encrypted in this release** (§13) |

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
7. The late-content rule of §8.2 applies → `Unreadable(Late)`.

Every other rule (folds, approvals, ref resolution) runs over `Readable` documents only. The UI hides `Unreadable` and `Malformed` documents and shows maintainers the count (ux-dx-spec §9). A `review` whose `enc` is unreadable still has a plaintext `verdict` and `commitOid`; it is **not** counted, which keeps a non-member's approval from ever being tallied by accident, in line with `count_approvals` taking well-formed input.

For sealed artifacts the equivalent is §3.5; a `SealedPackCorrupt` copy is a copy that failed verification in `select_pack_copy` / `v2_pack_list` (`verified = Some(false)`).

### 8.2 Late content under a superseded epoch

A removed member keeps `K_n` and may keep writing documents under `n` (un-gated types), or may have queued packs. Let `next(n)` be the smallest existing epoch greater than `n`, and `H` the block height of `next(n)`'s anchor. A document or manifest with `epoch = n` (for a manifest: the sealed header's `epoch`) and `$createdAtBlockHeight > H + GRACE_BLOCKS` is `Unreadable(Late)` **unless its `$ownerId` is a current member** (`RoleOracle::current_role` is `Some`). `GRACE_BLOCKS = 240` (`FORGE_RULES_V2`; roughly a quarter of an hour of Platform blocks, enough for a client whose last anchor read predates the rotation to finish a push). Content under `n` from before `H + GRACE_BLOCKS` is shown to everyone who can decrypt it, as before.

Writers re-read anchors before every write (§5.3), so an honest client rarely writes late; if it does (a long push straddling a rotation), its content is still shown because it is a current member. A reader that sees a **sealed pack whose header epoch is older than the epoch that was current at the manifest's block height** flags the manifest as suspect: the UI shows it to maintainers as "uploaded under an old key", and it is read only if its uploader is a current member.

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

**TypeScript** (`forge-web`): `crypto.subtle` for AES-GCM, HKDF, HMAC and SHA-256 (the app is served over HTTPS/localhost, so a secure context is guaranteed). `K_e` is imported once as a **non-extractable** HKDF base key; `K_doc,e`, `K_pack,e,f`, `K_ref,e` and `K_hedge,e` are derived with `deriveKey` as non-extractable `AES-GCM`/`HMAC` keys, and only `KCV_e`, `COMMIT_e` (which must be compared as bytes) and `prevEpochKey` (which must be re-imported) go through `deriveBits`/raw bytes. `@noble/hashes` (present) for HMAC/HKDF in tests and for parity checks; it must produce identical bytes. Wrapping through `@dashevo/evo-sdk` pinned to the exact version `4.2.0-beta.4` (no range specifier) via `sdk.encryptedFor.encrypt/decrypt/envelope`. No `@noble/ciphers`, no `@noble/curves` in the app path.

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
- negative cases: the issue `enc` opened with `number = 8` → `Unreadable(BadTag)`; with `$ownerId = 0x23×32` → `BadTag`; with `epoch = 1` → `BadTag`; with `enc[0]` rewritten to `0x02` (and 32 bytes inserted) → `Malformed` for a non-config kind; a config with `enc[0] = 0x01` → `Malformed`; a TLV with tag 1 twice → `Malformed`; tags out of order (2 then 1) → `Malformed`; reserved tag 11 → `Malformed`; extension tag 200 → skipped, `Readable`; two trailing bytes → `Malformed`; tag 8 with length 3 → `Malformed`; tag 3 in an issue → `Malformed`; tag 8/9 in an epoch-0 config → `Malformed`; a title of 257 characters → `Malformed`.

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
`accept_wrap_from_current_maintainer`, `reject_wrap_from_non_maintainer`, **`revoked_maintainer_wrap_not_current`** (a wrap whose author has no current `maintainer` document is ignored even though it predates the revocation), **`removed_maintainer_preposted_anchor_ignored`** (a config for `n+1` by a since-removed maintainer, earlier by block height than the real one, is not the anchor; the current maintainer's later config is), `anchor_first_by_block_height_then_id_among_current_maintainers`, `anchor_created_at_ms_not_used_for_order`, **`anchor_does_not_open_alert_no_skip`** (the first current-maintainer config for `e` has a commitment the reader's key does not match → `KeyMismatch`, and a later config for `e` that does match is *not* used), `unanchored_epoch_not_writable_and_unreadable`, `current_epoch_is_highest_anchored`, `chain_walk_reaches_epoch_0_from_one_wrap`, `chain_with_skipped_epoch_number`, **`chain_prev_epoch_must_be_smaller`** (`prevEpoch ≥ e` → `ChainBroken`), **`chain_key_must_open_first_anchor_of_prev`** (`prevEpochKey` commits to a config for `prevEpoch` that is not its anchor → `ChainBroken`), **`rotation_required_when_wrapped_non_member`** (H2: `wrapped(n)` contains a removed member → the repair check returns `Rotate`), `missing_wrap_repaired_without_rotation`, `wrap_to_disabled_key_requires_repair`, **`late_content_hidden_after_next_anchor_plus_grace`** (document under `n` at height `H + 241` by a removed member → `Unreadable(Late)`), `late_content_within_grace_shown`, `late_content_from_current_member_shown`, `manifest_under_old_epoch_flagged_suspect`.

## 12. Changes this design asks of other documents and code

1. **forge-v2.md §5**: the key-check value is the 14-byte `KCV_e` inside the wrap (error detection) and the key is authenticated by the anchor's commitment; anchors, wraps and the current epoch count only from current maintainers; `refNameHash` is under `K_ref,e`, a subkey, not the raw epoch key; `enc` layouts, TLV and AD as §4; the late-content rule of §8.2. Update the "Phase 3 fixes the exact field" sentence to point here. State in §6's rule table: `open_content`, `select_anchor`, `current_epoch`, `chain_walk`, `repair_check`, `is_late`, with the vectors of §11.
2. **rules v2 `is_well_formed`**: `comment.path` joins `ContentKind::Comment`'s plaintext fields (vector `well_formed__private_comment_plaintext_path`).
3. **errors.md**: new codes for "no encryption key", "no usable repoKey (not a member, or removed)", "key mismatch (a maintainer gave you the wrong key)", "key chain broken", "rotation pending / repair running", "sealed pack corrupt", "written after the key was rotated".
4. **private.rs**: `RepoKeyReader` grows `current_epoch() -> Result<u32>`, `epoch_key(e)` walks the chain, `repair_check()`; `PackCipher` gets streaming and ranged forms with the header cache; `RefNameHasher` takes the epoch; `RepoCodec` grows `open_content`. Production seal APIs take no nonce/fileId (§3.6).
5. **Not encrypted in this release** and to be stated in the UI: `release.notes`/`assets`, `label`, `checkRun.summary`/`detailsUrl`, `webhook.url`, `event.value`, `repo.description`. Adding `enc`/`epoch` to `release`, `label` and `event` is an additive contract update (optional properties) and is the natural follow-up; `repo.description` should be left empty by private-repo creators and the create flow says so.

## 13. Contract changes required before mainnet registration

These are schema changes to `forge-core.json` / `forge-collab.json`; they must land before the mainnet registration (roadmap D-J) and should be re-registered on moutai first. Adding a required system field or raising `maxItems` is fine for a fresh registration; on the existing moutai contracts, raising a byte array's `maxItems` is a compatible update, while adding to `required` is not, so moutai needs a `--force-new` re-registration.

| # | Contract | Change | Why |
|---|---|---|---|
| 1 | forge-core `schemaDefs.enc.maxItems` | 1024 → **1536** | a v0x02 config anchor is 61 bytes of overhead plus up to 1124 bytes of TLV (8 patterns × 103 + `defaultBranch` 258 + `prevEpoch` 7 + `prevEpochKey` 35); the current cap leaves 963 bytes |
| 2 | forge-core `config.required` | add **`$createdAtBlockHeight`** | anchor ordering (§5.3) and the late-content rule (§8.2) must use a network-set order, not the client-set `$createdAt` |
| 3 | forge-core `repoKey`, `refUpdate`, `protectedRefUpdate`, `packManifest`; forge-collab `issue`, `patch`, `comment`, `review` — `required` | add **`$createdAtBlockHeight`** | the late-content rule compares every private document's and manifest's block height with the next anchor's |
| 4 | forge-core `config` | no new index | anchors are found by reading all of a repo's `config` documents (append-only, rarely written) over the existing `(repoId, $createdAt)` index and ordering client-side; a `(repoId, epoch, $createdAtBlockHeight)` index is optional and can be added later, since indexes are additive on a fresh registration only |
| 5 | forge-collab `comment.path` | none (stays optional plaintext-capable) | it becomes content by client rule (§8.1); the schema does not change |
| 6 | (follow-up, not required) `release`, `label`, `event` | add optional `enc` + `epoch` with `dependentRequired` | to close the §7 plaintext list in a later release; additive |

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
- **L1** `KCV` widened to 14 bytes (wrap stays 64 B), described as error detection. **L2** chain walk requires `prevEpoch < e` and the key must open the *anchor* of `prevEpoch`; `ChainBroken`. **L3** `enc[0]` in the doc AD; header version in the pack key's domain string. **L4** hedged `fileId`/nonces via `K_hedge,e`; reseed copies sealed bytes; production APIs take no nonce/fileId. **L5** `sizeBytes` check before allocation, `reserved = 0`, header fetched/cached before ranged reads, OID check after inflate. **L6** TLV strictness table (§4.3). **L7** epoch-1 anchor vector description lists tag 6. **L8** hand-rolled segment nonce (not `aead::stream`), WebCrypto HKDF with non-extractable keys, evo-sdk pinned exactly.
- New §13 lists every contract change; all §11 vectors regenerated and cross-checked for the new layouts.

## 15. Open risks for the reviewer

- **Availability cost of C1.** A member whose only wraps came from since-removed maintainers reads nothing until a current maintainer's client runs the repair check. Acceptable given removal always rotates; confirm.
- **Random 96-bit GCM nonces for documents** across many writers, hedged: the collision bound is 2⁻³² at 2³² documents per epoch. Acceptable for a repo; confirm.
- **`GRACE_BLOCKS = 240`** is a judgement call between hiding a removed member's late writes and hiding an honest slow push; the current-member exception covers the honest case.
- **`$ownerId` in AD** assumes the seven content types stay non-transferable (they are).
- **Encryption-key custody in the browser** widens the vault's blast radius to "read every private repo, and every key handed out as a maintainer". Passkey PRF must be the default where available.
- **Un-encrypted release notes, labels and event values** in the first release may surprise users; the UI must say so.
