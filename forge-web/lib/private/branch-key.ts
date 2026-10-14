/**
 * Narrower branches (mixed-visibility DESIGN §4.3 "Narrower branches (phase 3F)", D34, D39;
 * `docs/security/private-repos.md` §20): a branch whose audience is narrower than All members
 * (Maintainers, Writers and maintainers, a group plus people, or people) has its own **branch
 * key**, in generations chained like the epoch chain. The Rust twin is
 * `crates/forge-core/src/private/branch_key.rs`; the `branch_key__*` vectors hold the two byte for
 * byte (`branch-key.conformance.test.ts`).
 *
 * ```text
 * K_br,g      = 32 random bytes, generation g = 0, 1, …
 * PRK_br,g    = HKDF-Extract(salt = repoId, IKM = K_br,g)
 * KCV_br,g    = HKDF-Expand(PRK_br,g, "dash-forge/v2/br-kcv" ‖ 0x00, 14)
 * refNameHash = HMAC-SHA256(HKDF-Expand(PRK_br,g, "dash-forge/v2/br-ref" ‖ 0x00, 32), name)
 * ref update  = enc v0x06 = 0x06 ‖ KCV_br,g[0..4] ‖ nonce(12) ‖ COMMIT_obj(32) ‖ AES-256-GCM(…) ‖ tag(16)
 *               (v0x03's framing with PRK_br,g for PRK_e and u32(g) for u32(e) in the `K_obj`
 *               info and the AD's epoch field; the document's `epoch` is g)            (65 B)
 * packs       = DFPK header 0x03: as 0x01, with KCV_br,g[0..4] where 0x01 carries the epoch,
 *               K_pack = HKDF-Expand(PRK_br,g, "dash-forge/v2/pack" ‖ 0x00 ‖ 0x03 ‖ fileId, 32)
 * ```
 *
 * A branch's keys reach its audience in **`branchKey` letters** (a kind-10 key letter, `./key-letter`):
 * `{"type":"branchKey","v":1,"name","gen","keys":[K_br,0 … K_br,g],"group","people","to"}`. A letter
 * carries every generation: a joiner never received the earlier letters. Readers fold the letters
 * they open ({@link foldBranchLetters}) into a {@link BranchRing}: per name, the first letter starts
 * the chain and a later one counts only when it agrees with it on every generation both carry, so a
 * writer outside the audience cannot redirect a branch by sending its members a letter for a new
 * generation of its own. A write under an older generation after the newer one was issued (plus
 * {@link GRACE_BLOCKS}) by someone outside the current audience is late and never folded.
 *
 * Keys never show in `toString` or `util.inspect`: a {@link BranchKey} keeps its bytes in a private
 * field, and every subkey of {@link BranchKeys} is a non-extractable WebCrypto key.
 */

import { base58Encode, decodeIdentifier } from '../auth/base58'
import type { Audience, Group } from '../env/format'
import { freshSalt } from './blind'
import { bytes, bytesToHex, concat, constantTimeEqual, isU32, randomBytes, sha256, u32, u64, utf8, type Bytes } from './bytes'
import { GRACE_BLOCKS, TooLargeError, docAdIn, maxEnc, type OpenResult, type PrivateDoc } from './doc'
import { IdSet, bytesEqual, compareBytes, type PrivateId } from './ids'
import type { JsonValue, TypedLetter } from './key-letter'
import { objKeys } from './keys'
import { realValues, refDocAndFields, sealedRefOf, type RefUpdateIn, type SealedRefUpdate } from './members-ref'
import { MAX_ARTIFACT_RECIPIENTS } from './named'
import { HEADER_LEN, MAGIC, MAX_SEG_LOG2, MIN_SEG_LOG2, PackError, WRITER_SEG_LOG2, segmentCount, segmentNonce, sealedLength } from './pack'
import { MalformedError, encodeTlv, parseMembersTlv, type DocFields } from './tlv'

/** `enc` version of a narrower branch's ref update. */
export const V6 = 0x06
/** Smallest v0x06 `enc`: version, KCV prefix, nonce, `COMMIT_obj` and tag. */
export const MIN_V6 = 1 + 4 + 12 + 32 + 16
/** The DFPK header version of an artifact sealed under a branch key. */
export const BRANCH_PACK_VERSION = 0x03
/** The kind-10 key letter type that carries a branch's keys. */
export const BRANCH_KEY_LETTER_TYPE = 'branchKey'
/** The most generations a letter carries (a branch whose audience shrank this often is re-made). */
export const MAX_BRANCH_GENERATIONS = 256
/** The most people a letter lists (DFPK 0x02 holds 64 slots, the writer's among them). */
export const MAX_BRANCH_PEOPLE = 63

const NONCE_LEN = 12
const TAG_LEN = 16
const INSPECT = Symbol.for('nodejs.util.inspect.custom')
const HMAC_256 = { name: 'HMAC', hash: 'SHA-256', length: 256 } as const
const AES_256 = { name: 'AES-GCM', length: 256 } as const
const LOWER_HEX_64 = /^[0-9a-f]{64}$/

/** `"dash-forge/v2/" ‖ label ‖ 0x00 ‖ x` (no generation: each generation is a fresh key). */
function info(label: string, x: Uint8Array = new Uint8Array(0)): Bytes {
  return concat(utf8(`dash-forge/v2/${label}`), new Uint8Array([0]), x)
}

/** Code point order (UTF-8 byte order), as the Rust twin orders strings. */
function byCodePoint(a: string, b: string): number {
  return compareBytes(utf8(a), utf8(b))
}

/** A 32-byte branch key `K_br,g`. Its bytes are private: `toString` and `inspect` never show them; equality is constant-time. */
export class BranchKey {
  readonly #bytes: Bytes

  private constructor(raw: Uint8Array) {
    this.#bytes = new Uint8Array(raw)
  }

  /** A fresh key from the CSPRNG: a new branch, or a new generation of one. */
  static generate(): BranchKey {
    const raw = randomBytes(32)
    try {
      return new BranchKey(raw)
    } finally {
      raw.fill(0)
    }
  }

  /** A copy of 32 raw key bytes (a letter's). */
  static fromBytes(raw: Uint8Array): BranchKey {
    if (raw.length !== 32) throw new RangeError('a branch key is 32 bytes')
    return new BranchKey(raw)
  }

  /** A key from 64 lower-case hex characters (a letter's spelling); `null` otherwise. */
  static fromHex(s: string): BranchKey | null {
    if (!LOWER_HEX_64.test(s)) return null
    const raw = new Uint8Array(32)
    for (let i = 0; i < 32; i++) raw[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16)
    try {
      return new BranchKey(raw)
    } finally {
      raw.fill(0)
    }
  }

  /** A copy of the raw bytes, for a letter's body or a derivation only; the caller wipes it. */
  expose(): Bytes {
    return new Uint8Array(this.#bytes)
  }

  /** The letter's spelling (lower-case hex). */
  toHex(): string {
    return bytesToHex(this.#bytes)
  }

  /** Constant-time equality. */
  equals(other: BranchKey): boolean {
    return constantTimeEqual(this.#bytes, other.#bytes)
  }

  /** Erase the bytes (best effort); the key is unusable afterwards. */
  wipe(): void {
    this.#bytes.fill(0)
  }

  toString(): string {
    return 'BranchKey(<redacted>)'
  }

  [INSPECT](): string {
    return this.toString()
  }
}

/**
 * The subkeys of one generation of one branch key of one repository. `K_br,g` is imported once as
 * a non-extractable WebCrypto HKDF key with `salt = repoId` (WebCrypto's HKDF, Extract then Expand,
 * is the spec's `HKDF-Expand(PRK_br,g, info)`); `KCV_br,g` is the only subkey kept as bytes.
 */
export class BranchKeys {
  private constructor(
    readonly repoId: Bytes,
    /** The generation. */
    readonly gen: number,
    private readonly base: CryptoKey,
    /** `K_brref,g`: HMAC-SHA256 for the branch's name hash. */
    private readonly refKey: CryptoKey,
    /** The nonce and `fileId` hedge (§3.6); a writer's choice, never checked by a reader. */
    private readonly hedgeKey: CryptoKey,
    /** `KCV_br,g` (14 bytes): error detection and key selection, never authorization. */
    readonly kcv: Bytes,
  ) {}

  /** Derive the subkeys of `key`, generation `gen` of a branch of repository `repoId`. */
  static async derive(repoId: Uint8Array, gen: number, key: BranchKey): Promise<BranchKeys> {
    if (repoId.length !== 32) throw new RangeError('repoId must be 32 bytes')
    if (!isU32(gen)) throw new RangeError('a generation is a u32')
    const salt = new Uint8Array(repoId)
    const raw = key.expose()
    let base: CryptoKey
    try {
      base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits'])
    } finally {
      raw.fill(0)
    }
    const params = (label: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt, info: info(label) })
    const [refKey, hedgeKey, kcvBits] = await Promise.all([
      crypto.subtle.deriveKey(params('br-ref'), base, HMAC_256, false, ['sign']),
      crypto.subtle.deriveKey(params('br-hedge'), base, HMAC_256, false, ['sign']),
      crypto.subtle.deriveBits(params('br-kcv'), base, 256),
    ])
    return new BranchKeys(salt, gen, base, refKey, hedgeKey, new Uint8Array(kcvBits, 0, 14).slice())
  }

  /** `KCV_br,g[0..4]`, what an `enc` v0x06 and a DFPK 0x03 header carry. */
  get kcv4(): Bytes {
    return this.kcv.slice(0, 4)
  }

  /** `refNameHash = HMAC-SHA256(K_brref,g, name)`. */
  async refNameHash(name: string): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.sign('HMAC', this.refKey, utf8(name)))
  }

  /**
   * `K_obj = HKDF-Expand(PRK_br,g, "dash-forge/v2/obj" ‖ 0x00 ‖ u32(g) ‖ nonce ‖ SHA-256(AD), 32)`,
   * raw because the next step re-imports it (`objKeys`); the caller wipes it.
   */
  async objKey(nonce: Uint8Array, ad: Uint8Array): Promise<Bytes> {
    if (nonce.length !== NONCE_LEN) throw new RangeError('a nonce is 12 bytes')
    const i = info('obj', concat(u32(this.gen), nonce, await sha256(ad)))
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: this.repoId, info: i }, this.base, 256))
  }

  /** `K_pack = HKDF-Expand(PRK_br,g, "dash-forge/v2/pack" ‖ 0x00 ‖ 0x03 ‖ fileId, 32)`. */
  packKey(fileId: Uint8Array): Promise<CryptoKey> {
    if (fileId.length !== 16) throw new RangeError('fileId must be 16 bytes')
    const i = info('pack', concat(new Uint8Array([BRANCH_PACK_VERSION]), fileId))
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: this.repoId, info: i }, this.base, AES_256, false, ['encrypt', 'decrypt'])
  }

  /** `nonce = HMAC-SHA256(K_brhedge,g, 0x02 ‖ rnd ‖ AD ‖ SHA-256(plaintext))[0..12]` (§3.6). */
  async hedgeNonce(rnd: Uint8Array, ad: Uint8Array, plaintextSha256: Uint8Array): Promise<Bytes> {
    return (await this.hedged(0x02, rnd, ad, plaintextSha256)).slice(0, NONCE_LEN)
  }

  /** `fileId = HMAC-SHA256(K_brhedge,g, 0x01 ‖ rnd ‖ SHA-256(plaintext))[0..16]` (§3.6). */
  async hedgeFileId(rnd: Uint8Array, plaintextSha256: Uint8Array): Promise<Bytes> {
    return (await this.hedged(0x01, rnd, plaintextSha256)).slice(0, 16)
  }

  private async hedged(label: number, ...parts: Uint8Array[]): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.sign('HMAC', this.hedgeKey, concat(new Uint8Array([label]), ...parts)))
  }

  toString(): string {
    return `BranchKeys { gen: ${this.gen}, kcv: ${bytesToHex(this.kcv4)}, .. }`
  }

  [INSPECT](): string {
    return this.toString()
  }
}

// --- ref updates (enc v0x06) ---------------------------------------------------------------------

/** Whether `name` may be a narrower branch: a branch (`refs/heads/…`), not a tag or another ref. */
export function isBranchName(name: string): boolean {
  return name.startsWith('refs/heads/') && name.length > 'refs/heads/'.length
}

type NonceOf = (ad: Bytes, tlv: Bytes) => Promise<Bytes>

/**
 * The v0x06 seal: the header and fields of a members-only update (`./members-ref`) with the branch
 * key's name hash and `epoch = g`, the members TLV parser (a writer never emits what a reader
 * refuses), the cap, then `K_obj` from the AD (version byte 0x06) and nonce, the commitment and
 * AES-GCM under `K_doc,obj` with `AD' = AD ‖ COMMIT_obj`.
 */
async function sealBranchRefWith(keys: BranchKeys, ownerId: PrivateId, input: RefUpdateIn, salt: Uint8Array, nonceOf: NonceOf): Promise<SealedRefUpdate> {
  if (!isBranchName(input.name)) throw new MalformedError('a narrower branch is a branch (refs/heads/…)')
  const { doc, fields } = await refDocAndFields(await keys.refNameHash(input.name), keys.gen, ownerId, input, salt)
  const records = encodeTlv(fields)
  try {
    if (parseMembersTlv(records, doc.type).refName !== input.name) throw new MalformedError('the ref name does not survive the TLV')
    const max = maxEnc(doc.type) - MIN_V6
    if (records.length > max) throw new TooLargeError(max)
    const ad = docAdIn(doc, keys.repoId, V6)
    const nonce = await nonceOf(ad, records)
    if (nonce.length !== NONCE_LEN) throw new RangeError('a nonce is 12 bytes')
    const kObj = await keys.objKey(nonce, ad)
    let obj
    try {
      obj = await objKeys(keys.repoId, kObj)
    } finally {
      kObj.fill(0)
    }
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: concat(ad, obj.commit) }, obj.docKey, records)
    return sealedRefOf(doc, salt, concat(new Uint8Array([V6]), keys.kcv4, nonce, obj.commit, new Uint8Array(ct)))
  } finally {
    records.fill(0)
  }
}

/**
 * Seal a narrower branch's ref update under `keys` (the branch's current generation), with a fresh
 * salt and a hedged nonce. `SealedRefUpdate.epoch` is the generation. Throws {@link MalformedError}
 * for a name outside `refs/heads/` and the refusals of a members-only update, {@link TooLargeError}
 * for one that does not fit.
 */
export function sealBranchRef(keys: BranchKeys, ownerId: PrivateId, input: RefUpdateIn): Promise<SealedRefUpdate> {
  const rnd = randomBytes(32)
  return sealBranchRefWith(keys, ownerId, input, freshSalt(), async (ad, tlv) => keys.hedgeNonce(rnd, ad, await sha256(tlv)))
}

/**
 * INTERNAL, TEST-ONLY: {@link sealBranchRef} with a caller-chosen salt and nonce. Only
 * `lib/private/testing.ts` may import it; it is not re-exported from `index.ts`.
 */
export function __unsafeSealBranchRefWith(keys: BranchKeys, ownerId: PrivateId, input: RefUpdateIn, salt: Uint8Array, nonce: Uint8Array): Promise<SealedRefUpdate> {
  return sealBranchRefWith(keys, ownerId, input, salt, async () => new Uint8Array(nonce))
}

// --- packs (DFPK 0x03) ---------------------------------------------------------------------------

/**
 * The KCV prefix of a DFPK 0x03 artifact from its first bytes (12 or more); `null` for anything
 * else (a git pack, the members key's 0x01, a letter's 0x02, a short read).
 */
export function sniffBranchKcv(head: Uint8Array): Bytes | null {
  const ok = head.length >= 12 && MAGIC.every((b, i) => head[i] === b) && head[4] === BRANCH_PACK_VERSION
  return ok ? head.slice(8, 12) : null
}

async function sealBranchPackWith(keys: BranchKeys, plain: Uint8Array, fileId: Uint8Array, segLog2: number): Promise<Bytes> {
  if (!Number.isInteger(segLog2) || segLog2 < MIN_SEG_LOG2 || segLog2 > MAX_SEG_LOG2) throw new RangeError('bad segLog2')
  if (fileId.length !== 16) throw new RangeError('fileId must be 16 bytes')
  const header = concat(new Uint8Array([...MAGIC, BRANCH_PACK_VERSION, segLog2, 0, 0]), keys.kcv4, u64(plain.length), fileId)
  const key = await keys.packKey(fileId)
  const S = 2 ** segLog2
  const n = segmentCount(plain.length, segLog2)
  const out = new Uint8Array(sealedLength(plain.length, segLog2))
  out.set(header)
  let o = HEADER_LEN
  for (let i = 0; i < n; i++) {
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: segmentNonce(i, i === n - 1), additionalData: header },
      key,
      bytes(plain.subarray(i * S, (i + 1) * S)),
    )
    out.set(new Uint8Array(ct), o)
    o += ct.byteLength
  }
  return out
}

/** Seal `plain` (a narrower branch's git pack) under `keys`, with a hedged random `fileId` and `L = 14`. */
export async function sealBranchPack(keys: BranchKeys, plain: Uint8Array): Promise<Bytes> {
  const fileId = await keys.hedgeFileId(randomBytes(32), await sha256(plain))
  return sealBranchPackWith(keys, plain, fileId, WRITER_SEG_LOG2)
}

/**
 * INTERNAL, TEST-ONLY: {@link sealBranchPack} with a caller-chosen `fileId` and segment size. Only
 * `lib/private/testing.ts` may import it; it is not re-exported from `index.ts`.
 */
export function __unsafeSealBranchPackWith(keys: BranchKeys, plain: Uint8Array, fileId: Uint8Array, segLog2: number): Promise<Bytes> {
  return sealBranchPackWith(keys, plain, fileId, segLog2)
}

/**
 * Open a whole DFPK 0x03 artifact: `sizeBytes` (the manifest's) first, then the header, then the key
 * the KCV prefix selects among `keys` (every generation of every branch the reader holds), then
 * every tag. Throws {@link PackError}: `sizeMismatch`, `sealedPackCorrupt` (any other DFPK version
 * included), or `noKey` when no key of the reader's matches, which readers skip, never treat as
 * corrupt.
 */
export async function openBranchPack(sealed: Uint8Array, sizeBytes: number, keys: Iterable<BranchKeys>): Promise<Bytes> {
  if (sealed.length !== sizeBytes) throw new PackError('sizeMismatch')
  if (sealed.length < HEADER_LEN) throw new PackError('sealedPackCorrupt')
  const h = sealed.slice(0, HEADER_LEN)
  const segLog2 = h[5] as number
  if (!MAGIC.every((b, i) => h[i] === b) || h[4] !== BRANCH_PACK_VERSION || h[6] !== 0 || h[7] !== 0 || segLog2 < MIN_SEG_LOG2 || segLog2 > MAX_SEG_LOG2) {
    throw new PackError('sealedPackCorrupt')
  }
  // the header's length is a u64: checked in BigInt before it becomes a number
  const plainLenBig = new DataView(h.buffer).getBigUint64(12)
  const segBig = 1n << BigInt(segLog2)
  const segmentsBig = plainLenBig === 0n ? 1n : (plainLenBig + segBig - 1n) / segBig
  if (BigInt(HEADER_LEN) + plainLenBig + BigInt(TAG_LEN) * segmentsBig !== BigInt(sealed.length)) throw new PackError('sealedPackCorrupt')
  const plainLen = Number(plainLenBig)
  const segments = Number(segmentsBig)
  const seg = 2 ** segLog2
  const fileId = h.slice(20, 36)
  const candidates = [...keys].filter((k) => bytesEqual(k.kcv4, h.subarray(8, 12)))
  if (candidates.length === 0) throw new PackError('noKey')
  candidate: for (const k of candidates) {
    const key = await k.packKey(fileId)
    const chunks: Bytes[] = []
    let at = HEADER_LEN
    for (let i = 0; i < segments; i++) {
      const len = Math.min(plainLen - i * seg, seg) + TAG_LEN
      if (at + len > sealed.length) throw new PackError('sealedPackCorrupt')
      try {
        chunks.push(
          new Uint8Array(
            await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: segmentNonce(i, i + 1 === segments), additionalData: h },
              key,
              bytes(sealed.slice(at, at + len)),
            ),
          ),
        )
      } catch {
        for (const c of chunks) c.fill(0)
        continue candidate
      }
      at += len
    }
    try {
      return concat(...chunks)
    } finally {
      for (const c of chunks) c.fill(0)
    }
  }
  throw new PackError('sealedPackCorrupt')
}

// --- the branchKey letter ------------------------------------------------------------------------

/** A `branchKey` letter's body: every generation of one branch's key, its audience, and who the writer sealed it to. */
export interface BranchKeyLetter {
  /** The full ref name (`refs/heads/sec/embargo`). */
  readonly name: string
  /** `K_br,0 … K_br,g`. */
  readonly keys: readonly BranchKey[]
  /** Who the branch is for (a group, a group plus people, or people; base58). */
  readonly audience: Audience
  /**
   * Every recipient (the writer among them; base58, ascending): what the next re-lettering compares
   * with the audience as it is then (D34).
   */
  readonly to: readonly string[]
}

/** Why a letter was not folded: a `branchKey` v1 body that breaks a rule, or one naming a branch already keyed by another chain. */
export type BranchLetterIgnored = 'malformed' | 'otherChain'

const LETTER_FIELDS = new Set(['type', 'v', 'name', 'gen', 'keys', 'group', 'people', 'to'])
const GROUPS: readonly Group[] = ['maintainers', 'writers', 'members']

function isCanonicalId(id: string): boolean {
  try {
    return base58Encode(decodeIdentifier(id)) === id
  } catch {
    return false
  }
}

/** Whether `ids` are canonical base58 identity ids in ascending order, none twice, at most `max`. */
function idsOk(ids: readonly string[], max: number): boolean {
  return ids.length <= max && ids.every((id, i) => (i === 0 || byCodePoint(ids[i - 1] as string, id) < 0) && isCanonicalId(id))
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** The generation a letter carries the key of (`keys.length − 1`). */
export function branchKeyLetterGen(letter: BranchKeyLetter): number {
  return Math.max(0, letter.keys.length - 1)
}

/**
 * Parse a body: `null` for another letter type or version (skipped, never fatal), `'malformed'` for
 * a `branchKey` v1 body that breaks a rule: a name outside `refs/heads/`, `gen` not the last index of
 * 1..=256 distinct lower-case hex keys, an unknown group, people that are not canonical base58
 * identity ids in ascending order, none twice and fewer than 64, no audience at all, `to` not
 * 1..=64 such ids, or any other field. Every field is required, `group` too (null for people only).
 */
export function parseBranchKeyLetter(body: unknown): BranchKeyLetter | 'malformed' | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const b = body as { readonly [k: string]: unknown }
  if (b['type'] !== BRANCH_KEY_LETTER_TYPE || b['v'] !== 1) return null
  // every field, and no other
  const present = Object.keys(b)
  if (present.length !== LETTER_FIELDS.size || !present.every((k) => LETTER_FIELDS.has(k))) return 'malformed'
  const { name, gen, keys: hexKeys, group, people, to } = b
  if (typeof name !== 'string' || typeof gen !== 'number' || !isStrings(hexKeys) || !isStrings(people) || !isStrings(to)) return 'malformed'
  if (group !== null && typeof group !== 'string') return 'malformed'
  const keys: BranchKey[] = []
  for (const h of hexKeys) {
    const k = BranchKey.fromHex(h)
    if (k === null) return 'malformed'
    keys.push(k)
  }
  const distinct = keys.every((k, i) => !keys.slice(0, i).some((e) => e.equals(k)))
  if (group !== null && !GROUPS.includes(group as Group)) return 'malformed'
  const peopleOk = idsOk(people, MAX_BRANCH_PEOPLE) && to.length > 0 && idsOk(to, MAX_ARTIFACT_RECIPIENTS)
  if (
    !isBranchName(name) ||
    keys.length === 0 ||
    keys.length > MAX_BRANCH_GENERATIONS ||
    !distinct ||
    gen !== keys.length - 1 ||
    !peopleOk ||
    (group === null && people.length === 0)
  ) {
    return 'malformed'
  }
  return { name, keys, audience: { group: group as Group | null, also: [...people] }, to: [...to] }
}

/** The typed letter (kind 10) carrying `letter`. */
export function branchKeyLetterToTyped(letter: BranchKeyLetter): TypedLetter {
  const fields: { [k: string]: JsonValue } = {
    name: letter.name,
    gen: branchKeyLetterGen(letter),
    keys: letter.keys.map((k) => k.toHex()),
    group: letter.audience.group,
    people: [...letter.audience.also],
    to: [...letter.to],
  }
  return { type: BRANCH_KEY_LETTER_TYPE, v: 1, fields }
}

/** {@link parseBranchKeyLetter} of a typed letter (its `type` and `v` over any of its fields so named). */
export function branchKeyLetterFromTyped(t: TypedLetter): BranchKeyLetter | 'malformed' | null {
  return parseBranchKeyLetter({ ...t.fields, type: t.type, v: t.v })
}

// --- the fold ------------------------------------------------------------------------------------

/** One opened letter, as the fold takes it. */
export interface BranchLetterIn {
  /** The kind-10 manifest's `$id` (the fold's tie-break and what an ignored entry names). */
  readonly id: string
  /** Its `$createdAtBlockHeight`. */
  readonly height: number
  /** The opened body. */
  readonly letter: BranchKeyLetter
}

/** One branch a reader holds keys for. */
export interface Branch {
  /** The full ref name. */
  readonly name: string
  /** The current generation (`keys.length − 1`). */
  readonly gen: number
  /** Every generation's key, `K_br,0` first (what a letter re-sends). */
  readonly keys: readonly BranchKey[]
  /** Who the newest counted letter says it is for. */
  readonly audience: Audience
  /** The height of the first letter carrying each generation. */
  readonly issuedAt: readonly number[]
  /** Who holds the current generation: every recipient of the letters carrying it (ascending). */
  readonly holders: readonly string[]
  /** The letters counted, in fold order. */
  readonly letters: readonly string[]
}

/** The letter that adds generation `gen + 1` of `branch` with `next` as its key, for `audience`, sealed to `to`. */
export function nextGenerationLetter(branch: Branch, next: BranchKey, audience: Audience, to: readonly string[]): BranchKeyLetter {
  return { name: branch.name, keys: [...branch.keys, next], audience, to }
}

/** The letter of `branch`'s current generation, for `audience`, sealed to `to` (joiners, or a re-send). */
export function currentGenerationLetter(branch: Branch, audience: Audience, to: readonly string[]): BranchKeyLetter {
  return { name: branch.name, keys: [...branch.keys], audience, to }
}

/** The fold: branches by name (in code point order), and the letters left out with why, in fold order. */
export interface BranchFold {
  readonly branches: ReadonlyMap<string, Branch>
  readonly ignored: readonly { readonly id: string; readonly reason: BranchLetterIgnored }[]
}

/**
 * Fold opened `branchKey` letters: taken in (height, id) order; per name the first letter starts the
 * chain and a later one counts only when it agrees on every generation both carry, extending the
 * chain when it carries more. Each generation is issued at the height of the first letter carrying
 * it; the audience is the newest counted letter's at the highest generation, and the current
 * generation's holders the union of its letters' `to`.
 */
export function foldBranchLetters(letters: readonly BranchLetterIn[]): BranchFold {
  const sorted = [...letters].sort((a, b) => a.height - b.height || byCodePoint(a.id, b.id))
  type Cur = { name: string; keys: readonly BranchKey[]; audience: Audience; issuedAt: number[]; holders: Set<string>; letters: string[] }
  const out = new Map<string, Cur>()
  const ignored: { id: string; reason: BranchLetterIgnored }[] = []
  for (const { id, height, letter } of sorted) {
    const cur = out.get(letter.name)
    if (cur === undefined) {
      out.set(letter.name, {
        name: letter.name,
        keys: letter.keys,
        audience: letter.audience,
        issuedAt: letter.keys.map(() => height),
        holders: new Set(letter.to),
        letters: [id],
      })
      continue
    }
    const common = Math.min(cur.keys.length, letter.keys.length)
    let agree = true
    for (let g = 0; g < common; g++) agree = (cur.keys[g] as BranchKey).equals(letter.keys[g] as BranchKey) && agree
    if (!agree) {
      ignored.push({ id, reason: 'otherChain' })
      continue
    }
    const have = cur.keys.length
    if (letter.keys.length > have) cur.holders = new Set(letter.to)
    else if (letter.keys.length === have) for (const t of letter.to) cur.holders.add(t)
    if (letter.keys.length >= have) {
      for (let g = have; g < letter.keys.length; g++) cur.issuedAt.push(height)
      cur.keys = letter.keys
      cur.audience = letter.audience
    }
    cur.letters.push(id)
  }
  const branches = new Map<string, Branch>()
  for (const name of [...out.keys()].sort(byCodePoint)) {
    const c = out.get(name) as Cur
    branches.set(name, {
      name,
      gen: c.keys.length - 1,
      keys: c.keys,
      audience: c.audience,
      issuedAt: c.issuedAt,
      holders: [...c.holders].sort(byCodePoint),
      letters: c.letters,
    })
  }
  return { branches, ignored }
}

// --- the ring ------------------------------------------------------------------------------------

const MALFORMED: OpenResult = { status: 'malformed' }

/**
 * The branches a reader holds keys for, with each generation's subkeys and who each branch's current
 * audience is now (resolved by the caller from the member documents): what opens a narrower branch's
 * ref updates and packs.
 */
export class BranchRing {
  private constructor(
    private readonly repoId: Bytes,
    /** The branches held, by name. */
    readonly branches: ReadonlyMap<string, Branch>,
    private readonly derived: readonly (readonly [string, BranchKeys])[],
    private readonly audienceNow: ReadonlyMap<string, IdSet>,
    /** Letters left out of the fold. */
    readonly ignored: BranchFold['ignored'],
  ) {}

  /**
   * A ring over the folded branches of repository `repoId`; `audienceNow` resolves a branch's
   * audience to identity ids (32 bytes) as of now (the late rule's "current audience").
   */
  static async create(repoId: Uint8Array, fold: BranchFold, audienceNow: (b: Branch) => Iterable<Uint8Array>): Promise<BranchRing> {
    if (repoId.length !== 32) throw new RangeError('repoId must be 32 bytes')
    const derived: (readonly [string, BranchKeys])[] = []
    const now = new Map<string, IdSet>()
    for (const [name, b] of fold.branches) {
      for (const [g, k] of b.keys.entries()) derived.push([name, await BranchKeys.derive(repoId, g, k)])
      now.set(name, new IdSet(audienceNow(b)))
    }
    return new BranchRing(new Uint8Array(repoId), fold.branches, derived, now, fold.ignored)
  }

  /** The branch `name`, when held. */
  get(name: string): Branch | undefined {
    return this.branches.get(name)
  }

  /** Whether the ring holds no branch. */
  get isEmpty(): boolean {
    return this.branches.size === 0
  }

  /** Branch `name`'s current generation's keys, to write under. */
  writeKeys(name: string): BranchKeys | undefined {
    const b = this.branches.get(name)
    if (b === undefined) return undefined
    return this.derived.find(([n, k]) => n === name && k.gen === b.gen)?.[1]
  }

  /** Every generation's keys of every branch held (what opens a DFPK 0x03 pack). */
  allKeys(): BranchKeys[] {
    return this.derived.map(([, k]) => k)
  }

  /** The branch whose keys open a DFPK 0x03 artifact with this KCV prefix, if any. */
  branchOfKcv(kcv4: Uint8Array): string | undefined {
    return this.derived.find(([, k]) => bytesEqual(k.kcv4, kcv4))?.[0]
  }

  /**
   * Open a narrower branch's ref update (`enc` v0x06) of `doc` (a public `refUpdate` or
   * `protectedRefUpdate`, its `epoch` the generation): framing, the keys of that generation whose
   * KCV prefix `enc` carries (none: `noKey`, a branch the reader doesn't have access to), the
   * commitment (`commitMismatch` before GCM), GCM, the members TLV, the name hash, the branch's own
   * name (a branch key opens only its branch), the real values, and the late rule across
   * generations. Take the real values of a readable update with `./members-ref`'s `realValues`.
   */
  async open(doc: PrivateDoc & { readonly createdAtBlockHeight?: number }, enc: Uint8Array): Promise<OpenResult> {
    if (enc.length < MIN_V6 || enc[0] !== V6 || doc.vis !== 'public' || (doc.type !== 'refUpdate' && doc.type !== 'protectedRefUpdate')) return MALFORMED
    let ad: Bytes
    try {
      ad = docAdIn(doc, this.repoId, V6)
    } catch (e) {
      if (e instanceof MalformedError) return MALFORMED
      throw e
    }
    const nonce = enc.slice(5, 5 + NONCE_LEN)
    const commit = enc.subarray(5 + NONCE_LEN, 5 + NONCE_LEN + 32)
    let any = false
    let hit: { name: string; keys: BranchKeys; docKey: CryptoKey } | undefined
    for (const [name, k] of this.derived) {
      if (k.gen !== doc.epoch || !bytesEqual(k.kcv4, enc.subarray(1, 5))) continue
      any = true
      const kObj = await k.objKey(nonce, ad)
      let obj
      try {
        obj = await objKeys(this.repoId, kObj)
      } finally {
        kObj.fill(0)
      }
      if (constantTimeEqual(obj.commit, commit)) {
        hit = { name, keys: k, docKey: obj.docKey }
        break
      }
    }
    if (!any) return { status: 'unreadable', reason: 'noKey' }
    if (hit === undefined) return { status: 'unreadable', reason: 'commitMismatch' }
    let pt: Bytes
    try {
      pt = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: concat(ad, commit) }, hit.docKey, enc.slice(5 + NONCE_LEN + 32)),
      )
    } catch {
      return { status: 'unreadable', reason: 'badTag' }
    }
    let fields: DocFields
    try {
      fields = parseMembersTlv(pt, doc.type)
    } catch (e) {
      if (e instanceof MalformedError) return MALFORMED
      throw e
    } finally {
      pt.fill(0)
    }
    if (fields.refName !== hit.name || doc.refNameHash === undefined || !constantTimeEqual(doc.refNameHash, await hit.keys.refNameHash(hit.name))) {
      return MALFORMED
    }
    if ((await realValues(doc, fields)) === null) return MALFORMED
    if (this.isLate(hit.name, doc)) return { status: 'unreadable', reason: 'late' }
    return { status: 'readable', fields }
  }

  /** Written under generation g after generation g+1 was issued plus the grace period, by someone outside the branch's current audience. */
  private isLate(name: string, doc: PrivateDoc & { readonly createdAtBlockHeight?: number }): boolean {
    const b = this.branches.get(name)
    if (b === undefined) return true
    const next = b.issuedAt[doc.epoch + 1]
    const height = doc.createdAtBlockHeight ?? Number.POSITIVE_INFINITY
    const inAudience = this.audienceNow.get(name)?.has(doc.ownerId) === true
    return next !== undefined && height > next + GRACE_BLOCKS && !inAudience
  }

  toString(): string {
    return `BranchRing { branches: ${this.branches.size}, ignored: ${this.ignored.length}, .. }`
  }

  [INSPECT](): string {
    return this.toString()
  }
}
