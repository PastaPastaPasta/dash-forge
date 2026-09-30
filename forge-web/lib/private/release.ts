/**
 * Sealed releases on a private repository (`docs/security/private-repos.md` §16): the TLV and
 * its padding (§16.2), the AD, the seal and the §16.4 open, the kind-4 asset manifest (§16.5)
 * and the per-tag fold (§16.3). The Rust twin is forge-core's `private::release`; the
 * `private_release_*` vectors hold the two byte for byte (`conformance.test.ts`).
 */

import { isRc1TagName } from '../rules/oid'
import { bytes, bytesToHex, concat, constantTimeEqual, hexToBytes, isU32, randomBytes, sha256, u16, u32, u64, utf8, type Bytes } from './bytes'
import { TooLargeError, type OpenContext, type UnreadableReason } from './doc'
import { compareBytes } from './ids'
import { hedgeNonce, releaseTagHash, releaseTagName, type EpochKeyring, type EpochKeys } from './keys'
import { openPack, sealPack } from './pack'
import { MalformedError } from './tlv'

/** forge-core `$defs.enc.maxItems` (1536) minus the v0x01 framing (§16.2). */
export const RELEASE_MAX_PLAINTEXT = 1536 - 29
/** A reader refuses a kind-4 manifest whose `sizeBytes` is larger (§16.5). */
export const RELEASE_MANIFEST_MAX_BYTES = 1 << 20

const V1 = 0x01
const NONCE_LEN = 12
const MIN_ENC = 1 + NONCE_LEN + 16

/** The TLV tags of a release (§16.2). */
const T = {
  notes: 2,
  importedAuthor: 13,
  importedUrl: 14,
  tag: 16,
  name: 17,
  targetOid: 18,
  flags: 19,
  importedCreatedAt: 20,
  assetManifest: 21,
  /** The first extension tag; the writer's padding record uses it. */
  padding: 64,
} as const
const PAD_BUCKET = 32

/** The bits of TLV 19 (§16.2). */
const FLAG = {
  prerelease: 0x01,
  draft: 0x02,
  yanked: 0x04,
  unpublished: 0x08,
  notesContinue: 0x10,
} as const
const ALL_FLAGS = 0x1f

/**
 * A release's sealed fields (§16.2), in the vectors' JSON shape: a `false` flag and an absent
 * option are left out, so a parsed value equals the vectors' `fields`.
 */
export interface ReleaseFields {
  /** TLV 16: the tag, 1–63 bytes of the `tagName` grammar. */
  readonly tag: string
  /** TLV 17. */
  readonly name?: string
  /** TLV 2; with `notesContinue`, a prefix of the manifest's `notes`. */
  readonly notes?: string
  /** TLV 18: 20 or 32 bytes, lowercase hex. */
  readonly targetOid?: string
  /** TLV 19 bit 0x01. */
  readonly prerelease?: boolean
  /** TLV 19 bit 0x02. */
  readonly draft?: boolean
  /** TLV 19 bit 0x04. */
  readonly yanked?: boolean
  /** TLV 19 bit 0x08. */
  readonly unpublished?: boolean
  /** TLV 19 bit 0x10: the full notes are the manifest's (requires `assetManifest`). */
  readonly notesContinue?: boolean
  /** TLV 13. */
  readonly importedAuthor?: string
  /** TLV 14. */
  readonly importedUrl?: string
  /** TLV 20: `imported.createdAt` (ms). */
  readonly importedCreatedAt?: number
  /** TLV 21: the `packHash` of the sealed kind-4 manifest (§16.5), lowercase hex. */
  readonly assetManifest?: string
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const FLAG_FIELDS = ['prerelease', 'draft', 'yanked', 'unpublished', 'notesContinue'] as const

function flagsOf(f: ReleaseFields): number {
  return FLAG_FIELDS.reduce((acc, k) => (f[k] === true ? acc | FLAG[k] : acc), 0)
}

function record(tag: number, value: Uint8Array): Bytes {
  return concat(new Uint8Array([tag]), u16(value.length), value)
}

/** The TLV records of `f`, ascending, without padding (§16.2). Assumes {@link buildReleaseTlv}'s checks. */
export function encodeReleaseTlv(f: ReleaseFields): Bytes {
  const out: Uint8Array[] = []
  if (f.notes !== undefined) out.push(record(T.notes, utf8(f.notes)))
  if (f.importedAuthor !== undefined) out.push(record(T.importedAuthor, utf8(f.importedAuthor)))
  if (f.importedUrl !== undefined) out.push(record(T.importedUrl, utf8(f.importedUrl)))
  out.push(record(T.tag, utf8(f.tag)))
  if (f.name !== undefined) out.push(record(T.name, utf8(f.name)))
  if (f.targetOid !== undefined) out.push(record(T.targetOid, hexToBytes(f.targetOid)))
  // Always written, 0x00 included: a flag change never changes the length.
  out.push(record(T.flags, new Uint8Array([flagsOf(f)])))
  if (f.importedCreatedAt !== undefined) out.push(record(T.importedCreatedAt, u64(f.importedCreatedAt)))
  if (f.assetManifest !== undefined) out.push(record(T.assetManifest, hexToBytes(f.assetManifest)))
  return concat(...out)
}

/**
 * The tag-64 record that pads a TLV of `n` bytes to a multiple of 32 within
 * {@link RELEASE_MAX_PLAINTEXT}; nothing when not even an empty record fits (§16.2).
 */
function padding(n: number): Bytes {
  if (n + 3 > RELEASE_MAX_PLAINTEXT) return new Uint8Array(0)
  const r = Math.min((PAD_BUCKET - ((n + 3) % PAD_BUCKET)) % PAD_BUCKET, RELEASE_MAX_PLAINTEXT - 3 - n)
  return record(T.padding, new Uint8Array(r))
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Code points, as Rust's `chars().count()`. */
const charCount = (s: string): number => [...s].length

/** Thrown inside {@link parseReleaseTlv} only. */
class Refused extends Error {}

/**
 * A text record: at most `chars` characters and `bytes` bytes, else malformed; shorter than
 * `min` bytes (a zero-length record of a minLength-1 field) counts as absent.
 */
function text(v: Uint8Array, min: number, chars: number, maxBytes: number): string | undefined {
  let s: string
  try {
    s = decoder.decode(v)
  } catch {
    throw new Refused()
  }
  if (v.length > maxBytes || charCount(s) > chars) throw new Refused()
  return v.length >= min ? s : undefined
}

/**
 * Parse a release TLV with §4.3's strictness and §16.2's table: records strictly ascending,
 * extensions (≥ 64) skipped, any other tag malformed, tags 16 and 19 required, flag 0x10 needs
 * tag 21, and provenance (13 or 20) needs its URL (14). `null` is malformed.
 */
export function parseReleaseTlv(pt: Uint8Array): ReleaseFields | null {
  try {
    return parseOrThrow(pt)
  } catch (e) {
    if (e instanceof Refused) return null
    throw e
  }
}

function parseOrThrow(pt: Uint8Array): ReleaseFields | null {
  const f: Mutable<ReleaseFields> = { tag: '' }
  let tagSeen = false
  let flagsSeen = false
  let last = -1
  let o = 0
  while (o < pt.length) {
    if (o + 3 > pt.length) return null
    const t = pt[o] as number
    const len = ((pt[o + 1] as number) << 8) | (pt[o + 2] as number)
    if (o + 3 + len > pt.length) return null
    const v = pt.subarray(o + 3, o + 3 + len)
    o += 3 + len
    if (t <= last) return null
    last = t
    if (t >= T.padding) continue
    switch (t) {
      case T.notes:
        f.notes = text(v, 0, 5120, 5120)
        break
      case T.importedAuthor:
        f.importedAuthor = text(v, 1, 120, 480)
        break
      case T.importedUrl:
        f.importedUrl = text(v, 1, 300, 300)
        break
      case T.tag: {
        const s = text(v, 1, 63, 63)
        if (s !== undefined) {
          if (!isLegalTagName(s)) return null
          f.tag = s
          tagSeen = true
        }
        break
      }
      case T.name:
        f.name = text(v, 1, 120, 480)
        break
      case T.targetOid:
        if (v.length !== 20 && v.length !== 32) return null
        f.targetOid = bytesToHex(v)
        break
      case T.flags: {
        if (v.length !== 1) return null
        const b = v[0] as number
        if ((b & ~ALL_FLAGS) !== 0) return null
        flagsSeen = true
        for (const k of FLAG_FIELDS) if ((b & FLAG[k]) !== 0) f[k] = true
        break
      }
      case T.importedCreatedAt: {
        if (v.length !== 8) return null
        const n = new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0)
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) return null
        f.importedCreatedAt = Number(n)
        break
      }
      case T.assetManifest:
        if (v.length !== 32) return null
        f.assetManifest = bytesToHex(v)
        break
      default:
        return null // reserved, or a tag that is not a release field
    }
  }
  const provenanceWithoutUrl =
    (f.importedAuthor !== undefined || f.importedCreatedAt !== undefined) && f.importedUrl === undefined
  if (!tagSeen || !flagsSeen || (f.notesContinue === true && f.assetManifest === undefined) || provenanceWithoutUrl) {
    return null
  }
  return clean(f)
}

/** `f` without absent options or `false` flags, keys in TLV order: the vectors' JSON form. */
function clean(f: ReleaseFields): ReleaseFields {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== false) out[k] = v
  return out as unknown as ReleaseFields
}

/** The contract's `tagName` grammar, 1–63 bytes (forge-core `rules::is_legal_tag_name`). */
function isLegalTagName(tag: string): boolean {
  return isRc1TagName(tag)
}

const HEX = /^[0-9a-fA-F]*$/

function textOk(s: string, min: number, chars: number, maxBytes: number): boolean {
  const n = utf8(s).length
  return n >= min && n <= maxBytes && charCount(s) <= chars
}

function sameFields(a: ReleaseFields, b: ReleaseFields): boolean {
  const key = (f: ReleaseFields) =>
    JSON.stringify(Object.entries(clean(f)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
  return key(a) === key(b)
}

/**
 * The writer's TLV (§16.2): the writer caps ({@link MalformedError}), the records within
 * {@link RELEASE_MAX_PLAINTEXT} ({@link TooLargeError}), the 32-byte padding, and a parse
 * round trip, so a writer never seals what a reader refuses.
 */
export function buildReleaseTlv(f: ReleaseFields): Bytes {
  const bad =
    !isLegalTagName(f.tag) ||
    (f.name !== undefined && !textOk(f.name, 1, 120, 480)) ||
    (f.notes !== undefined && !textOk(f.notes, 1, 5120, 5120)) ||
    (f.targetOid !== undefined && !(HEX.test(f.targetOid) && (f.targetOid.length === 40 || f.targetOid.length === 64))) ||
    // the release schema's imported caps, tighter than TLV 13's reader cap
    (f.importedAuthor !== undefined && !textOk(f.importedAuthor, 1, 64, 256)) ||
    (f.importedUrl !== undefined && !textOk(f.importedUrl, 1, 300, 300)) ||
    (f.importedCreatedAt !== undefined && !(Number.isSafeInteger(f.importedCreatedAt) && f.importedCreatedAt >= 0)) ||
    (f.assetManifest !== undefined && !(HEX.test(f.assetManifest) && f.assetManifest.length === 64)) ||
    (f.notesContinue === true && f.assetManifest === undefined) ||
    ((f.importedAuthor !== undefined || f.importedCreatedAt !== undefined) && f.importedUrl === undefined)
  if (bad) throw new MalformedError('release fields a reader would refuse')
  const records = encodeReleaseTlv(f)
  if (records.length > RELEASE_MAX_PLAINTEXT) throw new TooLargeError(RELEASE_MAX_PLAINTEXT)
  const pt = concat(records, padding(records.length))
  const back = parseReleaseTlv(pt)
  if (back === null || !sameFields(back, f)) throw new MalformedError('release fields do not round-trip')
  return pt
}

/**
 * The §4.4 AD of a release: `docType = "release"` and `bind` = the document's `tagName` string
 * (§16.2).
 */
export function releaseAd(keys: EpochKeys, ownerId: Uint8Array, tagName: string): Bytes {
  if (ownerId.length !== 32) throw new MalformedError('ownerId must be 32 bytes')
  return concat(
    utf8('dash-forge/v2/doc'),
    new Uint8Array([0, V1]),
    keys.repoId,
    ownerId,
    u32(keys.epoch),
    utf8('release'),
    new Uint8Array([0]),
    utf8(tagName),
  )
}

/** A sealed release with the intermediate values the vectors pin. */
interface SealedRelease {
  readonly tagName: string
  readonly tagHash: Bytes
  readonly ad: Bytes
  readonly tlv: Bytes
  readonly enc: Bytes
}

type NonceOf = (ad: Bytes, tlv: Bytes) => Promise<Bytes>

/** The seal pipeline. Not exported: see {@link sealRelease}. */
async function sealReleaseWith(keys: EpochKeys, ownerId: Uint8Array, f: ReleaseFields, nonceOf: NonceOf): Promise<SealedRelease> {
  const tlv = buildReleaseTlv(f)
  const [tagHash, tagName] = await Promise.all([releaseTagHash(keys, f.tag), releaseTagName(keys, f.tag)])
  const ad = releaseAd(keys, ownerId, tagName)
  const nonce = await nonceOf(ad, tlv)
  if (nonce.length !== NONCE_LEN) throw new RangeError('a nonce is 12 bytes')
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: ad }, keys.docKey, tlv)
  return { tagName, tagHash, ad, tlv, enc: concat(new Uint8Array([V1]), nonce, new Uint8Array(ct)) }
}

/**
 * Seal `f` as a release revision of `ownerId` under `keys` (§16.2), with a hedged random nonce
 * (§3.6). The document is `{tagName, vis: "private", delta: 0, epoch: keys.epoch, enc}`.
 * Throws {@link MalformedError} for fields a reader would refuse and {@link TooLargeError} over
 * {@link RELEASE_MAX_PLAINTEXT}.
 */
export async function sealRelease(
  keys: EpochKeys,
  ownerId: Uint8Array,
  f: ReleaseFields,
): Promise<{ readonly tagName: string; readonly enc: Bytes }> {
  const hedged: NonceOf = async (ad, tlv) => hedgeNonce(keys, randomBytes(32), ad, await sha256(tlv))
  const sealed = await sealReleaseWith(keys, ownerId, f, hedged)
  sealed.tlv.fill(0)
  return { tagName: sealed.tagName, enc: sealed.enc }
}

/**
 * INTERNAL, TEST-ONLY: {@link sealRelease} with a caller-chosen nonce, for the §16.7 vectors.
 * Only `lib/private/testing.ts` may import it (ESLint `no-restricted-imports` enforces that); it
 * is not re-exported from `index.ts`.
 */
export function __unsafeSealReleaseWithNonce(
  keys: EpochKeys,
  ownerId: Uint8Array,
  f: ReleaseFields,
  nonce: Uint8Array,
): Promise<SealedRelease> {
  return sealReleaseWith(keys, ownerId, f, async () => new Uint8Array(nonce))
}

/** A stored release document, as the §16.4 open sees it. */
export interface StoredRelease {
  /** `$ownerId`, 32 bytes. */
  readonly ownerId: Uint8Array
  readonly epoch?: number
  readonly tagName: string
  readonly vis: string
  readonly delta: number
  readonly enc?: Uint8Array
  /**
   * Whether the document carries any plaintext content field: `name`, `notes`, `assets`,
   * `assetManifest`, `yanked` or `imported` (`yanked: false` included). A sealed release with
   * one is malformed (§16.2).
   */
  readonly hasPlaintextContent: boolean
}

export type ReleaseOpenResult =
  | { readonly status: 'readable'; readonly fields: ReleaseFields }
  | { readonly status: 'unreadable'; readonly reason: UnreadableReason }
  | { readonly status: 'malformed' }

const MALFORMED: ReleaseOpenResult = { status: 'malformed' }
const unreadable = (reason: UnreadableReason): ReleaseOpenResult => ({ status: 'unreadable', reason })

/** 43 characters of the base64url alphabet: the shape of a sealed `tagName` (§16.1). */
const TAG_NAME_SHAPE = /^[A-Za-z0-9_-]{43}$/

/**
 * Open a sealed release (§16.4, in order): step 0's key-independent checks, the framing, the
 * epoch and key, AES-GCM, the TLV, the `tagName` check (the canonical encoding compared as
 * bytes, never decoded), then the burned clause of the late-content rule.
 */
export async function openRelease(ctx: OpenContext, d: StoredRelease): Promise<ReleaseOpenResult> {
  const { enc, epoch } = d
  if (d.ownerId.length !== 32 || enc === undefined || epoch === undefined || !isU32(epoch)) return MALFORMED
  if (d.hasPlaintextContent || d.vis !== 'private' || d.delta !== 0 || !TAG_NAME_SHAPE.test(d.tagName)) return MALFORMED
  if (enc.length < MIN_ENC || enc[0] !== V1) return MALFORMED
  if (!ctx.anchors.has(epoch)) return unreadable('noEpoch')
  const keys = ctx.keys.get(epoch)
  if (keys === undefined) return unreadable('noKey')
  const ad = releaseAd(keys, d.ownerId, d.tagName)
  let pt: Bytes
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes(enc.slice(1, 1 + NONCE_LEN)), additionalData: ad },
        keys.docKey,
        bytes(enc.slice(1 + NONCE_LEN)),
      ),
    )
  } catch {
    return unreadable('badTag')
  }
  let fields: ReleaseFields | null
  try {
    fields = parseReleaseTlv(pt)
  } finally {
    pt.fill(0)
  }
  if (fields === null) return MALFORMED
  if (!constantTimeEqual(utf8(await releaseTagName(keys, fields.tag)), utf8(d.tagName))) return MALFORMED
  // §8.2's burned clause needs no height: nothing is written under a burned epoch except by
  // someone its key leaked to.
  if (ctx.burned?.has(epoch) === true && !ctx.members.has(d.ownerId)) return unreadable('late')
  return { status: 'readable', fields }
}

// ---------------------------------------------------------------------------------------------
// The kind-4 asset manifest (§16.5)
// ---------------------------------------------------------------------------------------------

/** A kind-4 manifest does not belong to the release that names it (§16.5). */
export class ManifestMismatchError extends Error {
  constructor(message: string) {
    super(`manifestMismatch: ${message}`)
    this.name = 'ManifestMismatchError'
  }
}

/** One asset of a sealed release (§16.5). */
export interface ReleaseAsset {
  readonly name: string
  /** The plaintext file's SHA-256 (64 lowercase hex), or `""` on an external link. */
  readonly sha256: string
  /** The plaintext file's size. */
  readonly sizeBytes: number
  /** 1–8 locations of the sealed object (or of the external file). */
  readonly uris: readonly string[]
  /** The sealed object's SHA-256; absent on an external link. */
  readonly sealedSha256?: string
  /** The sealed object's size; absent on an external link. */
  readonly sealedSizeBytes?: number
}

/** The plaintext of a kind-4 manifest (§16.5). */
export interface ReleaseManifest {
  readonly v: 1
  readonly tag: string
  readonly total: number
  readonly source?: string
  /** The full notes, present exactly when the release sets flag 0x10. */
  readonly notes?: string
  readonly assets: readonly ReleaseAsset[]
}

function compareCodePoints(a: string, b: string): number {
  return compareBytes(utf8(a), utf8(b))
}

/**
 * Canonical JSON (§16.5): keys sorted by code point, no insignificant whitespace, non-ASCII
 * unescaped. Keys whose value is `undefined` are left out, as `JSON.stringify` does.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('canonical JSON has no non-finite numbers')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort(compareCodePoints)
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
  }
  throw new TypeError(`not JSON: ${typeof v}`)
}

type JsonObject = { readonly [k: string]: unknown }

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** An own property only: a parsed manifest never reaches the prototype chain. */
function own(o: JsonObject, k: string): unknown {
  return Object.hasOwn(o, k) ? o[k] : undefined
}

const HEX64 = /^[0-9a-f]{64}$/
const isHex64 = (v: unknown): boolean => typeof v === 'string' && HEX64.test(v)
const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.length > 0
/**
 * A `u64` of the manifest. Integers above 2^53 − 1 are refused (forge-core reads up to 2^64 − 1):
 * no real file is that large, and a JS number cannot hold them exactly.
 */
const isU64 = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

const MANIFEST_KEYS = new Set(['v', 'tag', 'total', 'source', 'notes', 'assets'])
const ENTRY_KEYS = new Set(['name', 'sha256', 'sizeBytes', 'uris', 'sealedSha256', 'sealedSizeBytes'])

/**
 * One asset entry: `{name, sha256, sizeBytes, uris}` plus, for a sealed object, `sealedSha256`
 * and `sealedSizeBytes`, whose `sha256` is then real and whose size holds the header and a tag.
 */
function entryOk(e: unknown): boolean {
  if (!isObject(e)) return false
  const size = own(e, 'sizeBytes')
  if (!isU64(size)) return false
  const uris = own(e, 'uris')
  const sha = own(e, 'sha256')
  const sealedSha = own(e, 'sealedSha256')
  const sealedSize = own(e, 'sealedSizeBytes')
  let sealedOk: boolean
  if (sealedSha === undefined && sealedSize === undefined) sealedOk = true
  else if (sealedSha === undefined || sealedSize === undefined) sealedOk = false
  else sealedOk = isHex64(sealedSha) && isHex64(sha) && isU64(sealedSize) && sealedSize >= 36 + size + 16
  return (
    Object.keys(e).every((k) => ENTRY_KEYS.has(k)) &&
    nonEmpty(own(e, 'name')) &&
    Array.isArray(uris) &&
    uris.length >= 1 &&
    uris.length <= 8 &&
    uris.every(nonEmpty) &&
    (isHex64(sha) || sha === '') &&
    sealedOk
  )
}

/** Whether a manifest's keys and entries are §16.5's, before binding it to a release. */
function manifestShapeOk(m: unknown): m is ReleaseManifest {
  if (!isObject(m) || !Object.keys(m).every((k) => MANIFEST_KEYS.has(k))) return false
  const assets = own(m, 'assets')
  const source = own(m, 'source')
  const notes = own(m, 'notes')
  return (
    own(m, 'v') === 1 &&
    typeof own(m, 'tag') === 'string' &&
    Array.isArray(assets) &&
    own(m, 'total') === assets.length &&
    assets.every(entryOk) &&
    (source === undefined || nonEmpty(source)) &&
    (notes === undefined || (nonEmpty(notes) && textOk(notes as string, 1, 5120, 5120)))
  )
}

// With `u`, a surrogate code unit only matches when it is unpaired: not encodable as UTF-8.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

/** Whether any key or string of `v` holds an unpaired surrogate (serde_json refuses its escape). */
function hasLoneSurrogate(v: unknown): boolean {
  if (typeof v === 'string') return LONE_SURROGATE.test(v)
  if (Array.isArray(v)) return v.some(hasLoneSurrogate)
  if (isObject(v)) return Object.entries(v).some(([k, x]) => LONE_SURROGATE.test(k) || hasLoneSurrogate(x))
  return false
}

/**
 * The canonical plaintext of a kind-4 manifest (§16.5). Throws {@link MalformedError} for a
 * manifest a reader would refuse whatever release names it.
 */
export function encodeReleaseManifest(manifest: ReleaseManifest): string {
  const canonical = canonicalJson(manifest)
  const back: unknown = JSON.parse(canonical)
  if (hasLoneSurrogate(back) || !manifestShapeOk(back)) throw new MalformedError('a release manifest a reader would refuse')
  return canonical
}

/**
 * Seal a kind-4 manifest (§16.5) under `keys` with a hedged `fileId` (§3.6). `sealed` is what is
 * uploaded; its `packHash` is the release's `assetManifest`.
 */
export async function sealReleaseManifest(
  keys: EpochKeys,
  manifest: ReleaseManifest,
): Promise<{ readonly canonical: string; readonly sealed: Bytes }> {
  const canonical = encodeReleaseManifest(manifest)
  return { canonical, sealed: await sealPack(keys, utf8(canonical)) }
}

/**
 * Open the kind-4 manifest a release names (§16.5): the 1 MiB cap and `SHA-256(sealed)` against
 * tag 21 before any decryption, §3.5 ({@link PackError} propagates), then the canonical
 * encoding byte for byte, the keys, the tag, the total, the entries and `notes` against flag
 * 0x10. Throws {@link ManifestMismatchError} for everything but a §3.5 failure.
 */
export async function openReleaseManifest(
  sealed: Uint8Array,
  sizeBytes: number,
  assetManifest: Uint8Array,
  tag: string,
  notesContinue: boolean,
  keys: EpochKeyring,
): Promise<ReleaseManifest> {
  if (sizeBytes > RELEASE_MANIFEST_MAX_BYTES) throw new ManifestMismatchError('over the size cap')
  if (!constantTimeEqual(await sha256(sealed), assetManifest)) throw new ManifestMismatchError('hash mismatch')
  const pt = await openPack(sealed, sizeBytes, keys)
  let m: unknown
  try {
    m = JSON.parse(decoder.decode(pt))
  } catch {
    throw new ManifestMismatchError('not JSON')
  }
  // Its own canonical re-encoding, byte for byte: whitespace, duplicate keys, escapes and number
  // spellings that two parsers could read differently are all refused.
  if (hasLoneSurrogate(m) || !constantTimeEqual(utf8(canonicalJson(m)), pt)) {
    throw new ManifestMismatchError('not canonical')
  }
  if (!manifestShapeOk(m) || m.tag !== tag || (m.notes !== undefined) !== notesContinue) {
    throw new ManifestMismatchError('does not match the release')
  }
  return m
}

// ---------------------------------------------------------------------------------------------
// The fold (§16.3)
// ---------------------------------------------------------------------------------------------

/** What {@link openRelease} made of a revision. */
export type ReleaseStatus = 'readable' | UnreadableReason | 'malformed'

/** One revision as the fold sees it, after {@link openRelease}. */
export interface FoldRevision {
  /** `$id`, the raw 32 bytes. */
  readonly id: Uint8Array
  /** `$createdAt`. */
  readonly createdAt: number
  readonly epoch: number
  readonly tagName: string
  readonly status: ReleaseStatus
  /** `enc` as any equality key (hex, say): only equality matters. */
  readonly enc: string
  /** The opened fields of a readable revision. */
  readonly fields?: ReleaseFields
}

/** The §16.3 fold. */
export interface ReleaseFold<T extends FoldRevision> {
  /** The newest revision of every live tag, in tag byte order. */
  readonly live: T[]
  /** Every other grouped revision, newest first. */
  readonly history: T[]
  /** The live tags whose newest revision is not a draft. */
  readonly count: number
  /** Readable revisions whose `enc` repeats an earlier one's, ignored. */
  readonly replays: T[]
  /** Tags with a newer revision that shares an (epoch, tagName) but does not open. */
  readonly unknownTags: string[]
  /** A `noKey` revision is newer than every readable one. */
  readonly stale: boolean
  /** Revisions that are not readable. */
  readonly hidden: number
}

/** `($createdAt, $id)`, with `$id` as raw bytes. */
function byAge(a: FoldRevision, b: FoldRevision): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return compareBytes(a.id, b.id)
}

/**
 * Fold a repository's opened release revisions (§16.3): order by `($createdAt, $id)`, ignore
 * replayed `enc`s, group by the decrypted tag, and take each tag's newest revision unless it
 * unpublishes.
 */
export function foldReleases<T extends FoldRevision>(rows: readonly T[]): ReleaseFold<T> {
  const sorted = [...rows].sort(byAge)
  const seenEnc = new Set<string>()
  const replays: T[] = []
  const byTag = new Map<string, T[]>()
  for (const r of sorted) {
    if (r.status !== 'readable' || r.fields === undefined) continue
    // Honest writers never repeat a hedged nonce, so an equal enc is a copy.
    if (seenEnc.has(r.enc)) {
      replays.push(r)
      continue
    }
    seenEnc.add(r.enc)
    const group = byTag.get(r.fields.tag)
    if (group === undefined) byTag.set(r.fields.tag, [r])
    else group.push(r)
  }
  const hidden = sorted.filter((r) => r.status !== 'readable').length

  const live: T[] = []
  const history: T[] = []
  const unknownTags: string[] = []
  let count = 0
  for (const tag of [...byTag.keys()].sort(compareCodePoints)) {
    const revs = byTag.get(tag) as T[]
    const newest = revs[revs.length - 1] as T
    if (newest.fields?.unpublished === true) {
      history.push(...revs)
    } else {
      live.push(newest)
      if (newest.fields?.draft !== true) count++
      history.push(...revs.slice(0, -1))
    }
    // A newer revision that shares an (epoch, tagName) with this tag but does not open.
    const shadowed = sorted.some(
      (u) =>
        (u.status === 'badTag' || u.status === 'malformed') &&
        revs.some((r) => r.epoch === u.epoch && r.tagName === u.tagName) &&
        byAge(u, newest) > 0,
    )
    if (shadowed) unknownTags.push(tag)
  }
  history.sort((a, b) => byAge(b, a))
  let newestReadable: T | undefined
  for (const r of sorted) if (r.status === 'readable') newestReadable = r
  const stale = sorted.some(
    (r) => r.status === 'noKey' && (newestReadable === undefined || byAge(r, newestReadable) > 0),
  )
  return { live, history, count, replays, unknownTags, stale, hidden }
}
