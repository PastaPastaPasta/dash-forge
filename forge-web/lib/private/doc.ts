/**
 * Encrypted document fields (`docs/security/private-repos.md` §4) and the key-dependent read
 * path `open_content` (§8.1, §8.2).
 *
 * Identities and ids are raw 32-byte values ({@link PrivateId}); convert at the boundary with
 * `privateId`.
 */

import { bytes, concat, constantTimeEqual, isU32, randomBytes, sha256, u32, utf8, type Bytes } from './bytes'
import { bytesEqual, type PrivateId } from './ids'
import { hedgeNonce, objKeys, refNameHash, type EpochKeyring, type EpochKeys } from './keys'
import { MalformedError, buildTlv, letterKind, padRecord, parseTlv, type DocFields, type PrivateDocType } from './tlv'

/** Blocks after the next epoch's key was first stated (stated(e), §5.3) during which late content is still shown (§8.2). */
export const GRACE_BLOCKS = 240

/** `enc` version of a private repository's content (§4.1). */
export const V1 = 0x01
/** `enc` version of `config`, which carries `COMMIT_e` (§4.2). */
export const V2 = 0x02
/** `enc` version of members-only content in a public repository: AD-bound per-object key, key commitment (§4.1). */
export const V3 = 0x03
/** `enc` version of a specific-people letter (§4.1, `./named`), in either kind of repository, under `epoch = 0`. */
export const V4 = 0x04
const NONCE_LEN = 12
const TAG_LEN = 16
/** Smallest `enc`: version, nonce, tag (§4.1). */
export const MIN_ENC = 1 + NONCE_LEN + TAG_LEN
/** Smallest config `enc`: version, COMMIT, nonce, tag (§4.2). */
export const MIN_CONFIG_ENC = MIN_ENC + 32
/** Smallest members (v0x03) `enc`, and its framing: version, nonce, `COMMIT_obj`, tag (§4.1). */
export const MIN_MEMBERS_ENC = MIN_ENC + 32
/** At most this many recipients in a letter, the sender included. */
export const MAX_LETTER_RECIPIENTS = 16
/** One letter slot: an IV and three AES-CBC blocks. */
export const LETTER_SLOT_LEN = 64

/** The framing of a letter to `n` recipients: everything but the TLV (`66 + 64·n`). */
export function letterFraming(n: number): number {
  return 1 + 1 + 4 + 32 + LETTER_SLOT_LEN * n + NONCE_LEN + TAG_LEN
}

/** Each type's `enc` `maxItems` in the contracts (forge-collab 5120, forge-core 1536). */
const MAX_ENC: Readonly<Record<PrivateDocType, number>> = {
  issue: 5120,
  patch: 5120,
  comment: 5120,
  review: 5120,
  refUpdate: 1536,
  protectedRefUpdate: 1536,
  config: 1536,
  event: 5120,
}

/** The largest TLV plaintext a document of `type` can carry. */
export function maxPlaintext(type: PrivateDocType): number {
  return MAX_ENC[type] - (type === 'config' ? MIN_CONFIG_ENC : MIN_ENC)
}

/** The largest TLV a members-only (v0x03) document of `type` holds. */
export function maxMembersPlaintext(type: PrivateDocType): number {
  return MAX_ENC[type] - MIN_MEMBERS_ENC
}

/** The largest TLV (content, recipients, padding) a `type` letter to `n` recipients holds. */
export function maxLetterPlaintext(type: PrivateDocType, n: number): number {
  return Math.max(0, MAX_ENC[type] - letterFraming(n))
}

/**
 * Whether a members or specific-people document of `type` pads its TLV (D28): on for issues,
 * PRs, comments and reviews; off for ref updates, events and configs.
 */
export function pads(type: PrivateDocType): boolean {
  return type === 'issue' || type === 'patch' || type === 'comment' || type === 'review'
}

/** `records`, then the padding record when `type` pads and it fits `room`. */
export function padded(type: PrivateDocType, records: Uint8Array, room: number): Bytes {
  return pads(type) ? concat(records, padRecord(records.length, room)) : bytes(records.slice())
}

/** The plaintext (non-`enc`) fields of a private document that the AD and checks use. */
export interface PrivateDoc {
  readonly type: PrivateDocType
  /**
   * The document's `vis`, which consensus holds equal to its repository's visibility. It decides
   * which content envelopes a reader admits: v0x01 only in a private repository, v0x03 only in a
   * public one (v0x04 in either; config is v0x02 in both). Absent means private, so a caller that
   * never sets it refuses members-only content rather than misreading it.
   */
  readonly vis?: 'public' | 'private'
  /** `$ownerId`. */
  readonly ownerId: PrivateId
  /** u32. */
  readonly epoch: number
  /** issue, patch: u32. */
  readonly number?: number
  /** comment. */
  readonly targetId?: PrivateId
  /** review. */
  readonly patchId?: PrivateId
  /** refUpdate, protectedRefUpdate. */
  readonly refNameHash?: Uint8Array
  readonly newOid?: Uint8Array
  readonly prevOid?: Uint8Array
  readonly force?: boolean
  /** patch. */
  readonly baseRefNameHash?: Uint8Array
  readonly sourceRefNameHash?: Uint8Array
}

/** A stored private document, as the read path sees it. */
export interface StoredPrivateDoc extends PrivateDoc {
  /** `$id` (compared with the epoch's anchor id for a config). */
  readonly id?: PrivateId
  /** `$createdAtBlockHeight`; a document without it is malformed (§8.1 step 7). */
  readonly createdAtBlockHeight?: number
  /**
   * `$updatedAtBlockHeight` of a replaceable document (issue, patch, comment): an edit is judged
   * by the late-content rule too (§8.2 "edits are judged too").
   */
  readonly updatedAtBlockHeight?: number
  readonly enc: Uint8Array
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new MalformedError(`${what} is required`)
  return v
}

function fixed(v: Uint8Array | undefined, len: number, what: string): Uint8Array {
  const b = need(v, what)
  if (b.length !== len) throw new MalformedError(`${what} must be ${len} bytes`)
  return b
}

function u32Field(v: number | undefined, what: string): Bytes {
  const n = need(v, what)
  if (!isU32(n)) throw new MalformedError(`${what} must be a u32`)
  return u32(n)
}

function oidf(oid: Uint8Array): Bytes {
  if (oid.length > 0xff) throw new MalformedError('oid over 255 bytes')
  return concat(new Uint8Array([oid.length]), oid)
}

function bind(doc: PrivateDoc, keys: EpochKeys | undefined): Bytes {
  switch (doc.type) {
    case 'issue':
    case 'patch':
      return u32Field(doc.number, 'number')
    case 'comment':
    case 'event':
      return bytes(fixed(doc.targetId, 32, 'targetId'))
    case 'review':
      return bytes(fixed(doc.patchId, 32, 'patchId'))
    case 'refUpdate':
    case 'protectedRefUpdate':
      return concat(
        fixed(doc.refNameHash, 32, 'refNameHash'),
        oidf(need(doc.newOid, 'newOid')),
        oidf(doc.prevOid ?? new Uint8Array(0)),
        new Uint8Array([doc.force === true ? 1 : 0]),
      )
    case 'config':
      // a config binds COMMIT_e: no AD without epoch keys
      if (keys === undefined) throw new MalformedError('a config has no AD without epoch keys')
      return keys.commit
  }
}

/**
 * The §4.4 associated data of `doc` under `keys` for `enc` version `version` (default: v0x02 for
 * a config, v0x01 otherwise). Throws {@link MalformedError} for a document whose bind fields are
 * missing or out of range, and `RangeError` when `keys` is for another epoch.
 */
export function docAd(doc: PrivateDoc, keys: EpochKeys, version: number = doc.type === 'config' ? V2 : V1): Bytes {
  const epoch = u32Field(doc.epoch, 'epoch')
  // copy-lint-ignore: an invariant the caller checks first; never shown on its own
  if (keys.epoch !== doc.epoch) throw new RangeError('the key is not for the document epoch')
  return adOf(doc, keys.repoId, epoch, version, bind(doc, keys))
}

/**
 * The §4.4 associated data with no epoch keys: `repoId` only and the literal `epoch = 0`, as a
 * specific-people letter (`enc` v0x04) binds it (§4.1). Throws {@link MalformedError} for a
 * config (its bind is `COMMIT_e`) or a missing bind field.
 */
export function docAdWithoutKeys(doc: PrivateDoc, repoId: Uint8Array, version: number): Bytes {
  if (repoId.length !== 32) throw new RangeError('repoId must be 32 bytes')
  return adOf(doc, repoId, u32(0), version, bind(doc, undefined))
}

function adOf(doc: PrivateDoc, repoId: Uint8Array, epoch: Uint8Array, version: number, b: Uint8Array): Bytes {
  return concat(
    utf8('dash-forge/v2/doc'),
    new Uint8Array([0, version]),
    repoId,
    fixed(doc.ownerId, 32, 'ownerId'),
    epoch,
    utf8(doc.type),
    new Uint8Array([0]),
    b,
  )
}

/**
 * The §4.5 check: every hash field the document carries names a ref in `fields` that hashes to
 * it. A present hash with the name missing fails, like a mismatch. A members (v0x03) patch may
 * instead carry the public `sha256(name)` of a public branch; a ref update is always keyed.
 */
async function refHashesMatch(doc: PrivateDoc, fields: DocFields, keys: EpochKeys, version: number = V1): Promise<boolean> {
  const pairs: [Uint8Array | undefined, string | undefined][] =
    doc.type === 'patch'
      ? [
          [doc.baseRefNameHash, fields.baseRefName],
          [doc.sourceRefNameHash, fields.sourceRefName],
        ]
      : doc.type === 'refUpdate' || doc.type === 'protectedRefUpdate'
        ? [[doc.refNameHash, fields.refName]]
        : []
  const publicOk = version === V3 && doc.type === 'patch'
  for (const [hash, name] of pairs) {
    if (hash === undefined) continue
    if (name === undefined) return false
    if (constantTimeEqual(await refNameHash(keys, name), hash)) continue
    if (publicOk && constantTimeEqual(await sha256(utf8(name)), hash)) continue
    return false
  }
  return true
}

/** Options of a seal. */
export interface SealDocOptions {
  /** Config only: whether this config is (to be) its epoch's anchor. */
  readonly anchor?: boolean
}

/** The TLV is valid but does not fit the type's `enc` (`maxItems` minus the framing). */
export class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`plaintext over ${limit} bytes`)
    this.name = 'TooLargeError'
  }
}

/** Chooses the nonce of a seal from its AD and TLV. */
type NonceOf = (ad: Bytes, tlv: Bytes) => Promise<Bytes>

/**
 * The seal pipeline: the AD (bind fields), the §4.3 parser ({@link MalformedError}), the
 * per-type size cap ({@link TooLargeError}), the §4.5 hash check ({@link MalformedError}),
 * then AES-GCM under the nonce `nonceOf` picks. Not exported: production seals go through
 * {@link sealDoc}; the deterministic variant is `testing.ts`'s, through
 * {@link __unsafeSealDocWithNonce}.
 */
async function sealDocWith(
  keys: EpochKeys,
  doc: PrivateDoc,
  fields: DocFields,
  options: SealDocOptions,
  nonceOf: NonceOf,
): Promise<{ ad: Bytes; tlv: Bytes; enc: Bytes }> {
  // a public repository's content is never v0x01 (its configs are v0x02 in both)
  if (doc.vis === 'public' && doc.type !== 'config') throw new MalformedError('a public repository seals members-only content as v0x03')
  const ad = docAd(doc, keys)
  const tlv = buildTlv(fields, { type: doc.type, epoch: doc.epoch, anchor: options.anchor === true })
  if (tlv.length > maxPlaintext(doc.type)) throw new TooLargeError(maxPlaintext(doc.type))
  if (!(await refHashesMatch(doc, fields, keys))) throw new MalformedError('a ref name does not match its hash')
  const prefix = doc.type === 'config' ? concat(new Uint8Array([V2]), keys.commit) : new Uint8Array([V1])
  const nonce = await nonceOf(ad, tlv)
  if (nonce.length !== NONCE_LEN) throw new RangeError('a nonce is 12 bytes')
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: ad }, keys.docKey, tlv)
  return { ad, tlv, enc: concat(prefix, nonce, new Uint8Array(ct)) }
}

/**
 * Encrypt `fields` into the `enc` of `doc` under `keys` (§4.1, §4.2), with a hedged random
 * nonce (§3.6). Throws {@link MalformedError} for content a reader would refuse and
 * {@link TooLargeError} for content that does not fit.
 */
export async function sealDoc(
  keys: EpochKeys,
  doc: PrivateDoc,
  fields: DocFields,
  options: SealDocOptions = {},
): Promise<Bytes> {
  const hedged: NonceOf = async (ad, tlv) => hedgeNonce(keys, randomBytes(32), ad, await sha256(tlv))
  const sealed = await sealDocWith(keys, doc, fields, options, hedged)
  // The plaintext may hold a raw key (an anchor's prevEpochKey).
  sealed.tlv.fill(0)
  return sealed.enc
}

/**
 * INTERNAL, TEST-ONLY: {@link sealDoc} with a caller-chosen nonce, for the §11 vectors. Only
 * `lib/private/testing.ts` may import it (ESLint `no-restricted-imports` enforces that); it is
 * not re-exported from `index.ts`.
 */
export function __unsafeSealDocWithNonce(
  keys: EpochKeys,
  doc: PrivateDoc,
  fields: DocFields,
  nonce: Uint8Array,
  options: SealDocOptions = {},
): Promise<{ ad: Bytes; tlv: Bytes; enc: Bytes }> {
  return sealDocWith(keys, doc, fields, options, async () => new Uint8Array(nonce))
}

/** What a members-only (v0x03) seal produced; `kObj` is the raw per-object key, wiped by production seals. */
interface MembersSealed {
  readonly ad: Bytes
  readonly kObj: Bytes
  readonly commit: Bytes
  readonly tlv: Bytes
  readonly enc: Bytes
}

/**
 * The v0x03 seal pipeline (§4.1): parse the records as a reader would, the cap, the ref-name
 * hashes, the padding, then `K_obj` from the AD and nonce, the commitment and AES-GCM under
 * `K_doc,obj` with `AD' = AD ‖ COMMIT_obj`.
 */
async function sealMembersWith(keys: EpochKeys, doc: PrivateDoc, fields: DocFields, nonceOf: NonceOf): Promise<MembersSealed> {
  if (doc.vis !== 'public') throw new MalformedError('members-only content exists only in a public repository')
  if (doc.type === 'config') throw new MalformedError('a config is always v0x02')
  const ad = docAd(doc, keys, V3)
  const records = buildTlv(fields, { type: doc.type, epoch: doc.epoch })
  const room = maxMembersPlaintext(doc.type)
  if (records.length > room) throw new TooLargeError(room)
  if (!(await refHashesMatch(doc, fields, keys, V3))) throw new MalformedError('a ref name does not match its hash')
  const tlv = padded(doc.type, records, room)
  records.fill(0)
  const nonce = await nonceOf(ad, tlv)
  if (nonce.length !== NONCE_LEN) throw new RangeError('a nonce is 12 bytes')
  const kObj = await keys.objKey(nonce, ad)
  const obj = await objKeys(keys.repoId, kObj)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: concat(ad, obj.commit) }, obj.docKey, tlv)
  return { ad, kObj, commit: obj.commit, tlv, enc: concat(new Uint8Array([V3]), nonce, obj.commit, new Uint8Array(ct)) }
}

/**
 * Encrypt `fields` as members-only content of a public repository (`enc` v0x03, §4.1) under the
 * members lane's epoch keys, with a hedged random nonce (§3.6) and the padding of {@link pads}.
 * `doc.vis` must be `public`; a config is refused (always v0x02). Throws {@link MalformedError}
 * and {@link TooLargeError} like {@link sealDoc}.
 */
export async function sealMembersDoc(keys: EpochKeys, doc: PrivateDoc, fields: DocFields): Promise<Bytes> {
  const hedged: NonceOf = async (ad, tlv) => hedgeNonce(keys, randomBytes(32), ad, await sha256(tlv))
  const sealed = await sealMembersWith(keys, doc, fields, hedged)
  sealed.tlv.fill(0)
  sealed.kObj.fill(0)
  return sealed.enc
}

/**
 * INTERNAL, TEST-ONLY: {@link sealMembersDoc} with a caller-chosen nonce, returning every
 * intermediate the vectors pin. Only `lib/private/testing.ts` may import it.
 */
export function __unsafeSealMembersDocWithNonce(keys: EpochKeys, doc: PrivateDoc, fields: DocFields, nonce: Uint8Array): Promise<MembersSealed> {
  return sealMembersWith(keys, doc, fields, async () => new Uint8Array(nonce))
}

export type UnreadableReason = 'noEpoch' | 'noKey' | 'commitMismatch' | 'badTag' | 'late' | 'lateEdit'

export type OpenResult =
  | { readonly status: 'readable'; readonly fields: DocFields }
  | { readonly status: 'unreadable'; readonly reason: UnreadableReason }
  | { readonly status: 'malformed' }

const MALFORMED: OpenResult = { status: 'malformed' }
const unreadable = (reason: UnreadableReason): OpenResult => ({ status: 'unreadable', reason })

/** An existing epoch's anchor, as the read path needs it. */
export interface AnchorRef {
  readonly id: PrivateId
  /** The anchor's `$createdAtBlockHeight`. */
  readonly height: number
  /**
   * The block height of stated(e) (§5.3): the first config, by anyone, carrying this anchor's
   * commitment, i.e. when the epoch's key was first stated on chain. Never above `height`, and a
   * re-anchor (same commitment, later height) does not move it. The late-content cut-off of the
   * epoch below counts from it (§8.2), never from `height`.
   */
  readonly statedHeight: number
  /**
   * The `$createdAt` (ms) of stated(e), when the epoch's current key was first stated on chain
   * (§5.3; a re-anchor does not move it), when known. A sealed release has no block height, so a
   * `badTag` revision created before it is an earlier use of the epoch number (§16.3).
   */
  readonly statedAt?: number
}

/** A set of identities, by bytes (`IdSet`). */
export interface IdentitySet {
  has(id: PrivateId): boolean
}

/** What a reader knows about a private repo: its keys, its epochs and its members. */
export interface OpenContext {
  readonly keys: EpochKeyring
  /** Existing epochs (§5.3) and their anchors. */
  readonly anchors: ReadonlyMap<number, AnchorRef>
  /** Current members. */
  readonly members: IdentitySet
  /** Burned epochs (§5.3): their content is late unless its author is a current member. */
  readonly burned?: ReadonlySet<number>
}

/**
 * Step 1 of §8.1 for a letter (`enc` v0x04): a kind a letter may carry, `epoch = 0` (D20),
 * `1 ≤ n ≤ 16` and room for the framing.
 */
export function letterFramed(doc: PrivateDoc, enc: Uint8Array): boolean {
  if (doc.epoch !== 0 || !letterKind(doc.type) || enc.length < 38 || enc[0] !== V4) return false
  const n = enc[1] as number
  return n >= 1 && n <= MAX_LETTER_RECIPIENTS && enc.length >= letterFraming(n)
}

/**
 * Whether `enc` has the shape its type and `vis` demand (§8.1 step 1): a private repository's
 * content is v0x01, a public repository's members-only content v0x03; a v0x01 `enc` in a public
 * repository or a v0x03 one in a private repository is malformed. A letter (v0x04) is framed
 * by {@link letterFramed}.
 */
function encShapeOk(doc: PrivateDoc, enc: Uint8Array): boolean {
  if (doc.type === 'config') return enc.length >= MIN_CONFIG_ENC && enc[0] === V2
  const pub = doc.vis === 'public'
  switch (enc[0]) {
    case V1:
      return !pub && enc.length >= MIN_ENC
    case V3:
      return pub && enc.length >= MIN_MEMBERS_ENC
    case V4:
      return letterFramed(doc, enc)
    default:
      return false
  }
}

/**
 * §8.1 steps 1 and 3–6 with a given key: shape, commitment, AES-GCM, TLV, ref-name hashes.
 * `anchor` says whether a config is its epoch's anchor.
 */
export async function openWithKey(doc: StoredPrivateDoc, keys: EpochKeys, anchor: boolean): Promise<OpenResult> {
  const enc = doc.enc
  if (!encShapeOk(doc, enc) || !isU32(doc.epoch)) return MALFORMED
  if (enc[0] === V4) return unreadable('noKey')
  if (enc[0] === V3) return openMembers(doc, keys)
  let body = enc.subarray(1)
  if (doc.type === 'config') {
    if (!constantTimeEqual(keys.commit, enc.subarray(1, 33))) return unreadable('commitMismatch')
    body = enc.subarray(33)
  }
  let ad: Bytes
  try {
    ad = docAd(doc, keys)
  } catch (e) {
    if (e instanceof MalformedError) return MALFORMED
    throw e
  }
  let pt: Bytes
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes(body.slice(0, NONCE_LEN)), additionalData: ad },
        keys.docKey,
        bytes(body.slice(NONCE_LEN)),
      ),
    )
  } catch {
    return unreadable('badTag')
  }
  let fields: DocFields
  try {
    fields = parseTlv(pt, { type: doc.type, epoch: doc.epoch, anchor })
  } catch (e) {
    if (e instanceof MalformedError) return MALFORMED
    throw e
  } finally {
    pt.fill(0)
  }
  if (!(await refHashesMatch(doc, fields, keys))) return MALFORMED
  return { status: 'readable', fields }
}

/**
 * Open a v0x03 `enc` (§4.1): derive `K_obj` from the nonce and the AD, compare the commitment
 * before GCM runs (a mismatch is `commitMismatch`, never `badTag`), then GCM under `K_doc,obj`
 * with `AD' = AD ‖ COMMIT_obj`, the TLV (padding skipped) and the ref-name hashes.
 */
async function openMembers(doc: StoredPrivateDoc, keys: EpochKeys): Promise<OpenResult> {
  const enc = doc.enc
  let ad: Bytes
  try {
    ad = docAd(doc, keys, V3)
  } catch (e) {
    if (e instanceof MalformedError) return MALFORMED
    throw e
  }
  const nonce = bytes(enc.slice(1, 1 + NONCE_LEN))
  const commit = enc.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + 32)
  const kObj = await keys.objKey(nonce, ad)
  let obj
  try {
    obj = await objKeys(keys.repoId, kObj)
  } finally {
    kObj.fill(0)
  }
  if (!constantTimeEqual(obj.commit, commit)) return unreadable('commitMismatch')
  let pt: Bytes
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: concat(ad, commit) },
        obj.docKey,
        bytes(enc.slice(1 + NONCE_LEN + 32)),
      ),
    )
  } catch {
    return unreadable('badTag')
  }
  let fields: DocFields
  try {
    fields = parseTlv(pt, { type: doc.type, epoch: doc.epoch })
  } catch (e) {
    if (e instanceof MalformedError) return MALFORMED
    throw e
  } finally {
    pt.fill(0)
  }
  if (!(await refHashesMatch(doc, fields, keys, V3))) return MALFORMED
  return { status: 'readable', fields }
}

/** The smallest existing epoch above `epoch`, with its anchor. */
function nextAnchor(anchors: ReadonlyMap<number, AnchorRef>, epoch: number): AnchorRef | undefined {
  let best: [number, AnchorRef] | undefined
  for (const [e, a] of anchors) if (e > epoch && (best === undefined || e < best[0])) best = [e, a]
  return best?.[1]
}

/**
 * The late-content rule (§8.2): content under `epoch` written at `height` by `owner` is late
 * when the next existing epoch's key was first stated on chain (its anchor's
 * {@link AnchorRef.statedHeight}) more than {@link GRACE_BLOCKS} blocks earlier and `owner` is
 * not a current member. Never the selected anchor's own height: a re-anchor of that epoch after
 * its first anchor's author left repeats the commitment later, and must not reopen the window.
 */
export function isLate(
  anchors: ReadonlyMap<number, AnchorRef>,
  members: IdentitySet,
  epoch: number,
  height: number,
  owner: PrivateId,
  burned?: ReadonlySet<number>,
): boolean {
  if (members.has(owner)) return false
  // Nothing is ever sealed under a burned epoch (§5.3): whatever is, whenever, is late.
  if (burned?.has(epoch) === true) return true
  const next = nextAnchor(anchors, epoch)
  return next !== undefined && height > next.statedHeight + GRACE_BLOCKS
}

function isHeight(h: number | undefined): h is number {
  return h !== undefined && Number.isSafeInteger(h) && h >= 0
}

/**
 * `open_content` (§8.1): decrypt and check a private or members-only document, in the normative
 * order, dispatching on `enc[0]` and `doc.vis`. A specific-people letter (v0x04) needs the
 * reader's encryption key and the sender's public key, which an {@link OpenContext} does not
 * hold: a well-framed one is `noKey` here and opens through `./named`'s `openLetter`.
 */
export async function openContent(doc: StoredPrivateDoc, ctx: OpenContext): Promise<OpenResult> {
  if (!encShapeOk(doc, doc.enc) || !isU32(doc.epoch)) return MALFORMED
  if (doc.enc[0] === V4) return unreadable('noKey')
  const anchor = ctx.anchors.get(doc.epoch)
  if (anchor === undefined) return unreadable('noEpoch')
  const keys = ctx.keys.get(doc.epoch)
  if (keys === undefined) return unreadable('noKey')
  const isAnchor = doc.type === 'config' && doc.id !== undefined && bytesEqual(doc.id, anchor.id)
  const result = await openWithKey(doc, keys, isAnchor)
  if (result.status !== 'readable') return result
  // A member `event` is gated at consensus (a removed member cannot write one), so the late rule,
  // about un-gated writes under a superseded key, does not apply; its schema carries no
  // `$createdAtBlockHeight` either (§8.1 step 7).
  if (doc.type === 'event') return result
  if (!isHeight(doc.createdAtBlockHeight)) return MALFORMED
  if (isLate(ctx.anchors, ctx.members, doc.epoch, doc.createdAtBlockHeight, doc.ownerId, ctx.burned)) return unreadable('late')
  // An edit re-seals the text: a late one (by a non-member, past the grace period) replaced the
  // original, which is gone (§8.2 "edits are judged too").
  if (isHeight(doc.updatedAtBlockHeight) && doc.updatedAtBlockHeight > doc.createdAtBlockHeight) {
    if (isLate(ctx.anchors, ctx.members, doc.epoch, doc.updatedAtBlockHeight, doc.ownerId, ctx.burned)) return unreadable('lateEdit')
  }
  return result
}
