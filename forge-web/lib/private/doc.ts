/**
 * Encrypted document fields (`docs/security/private-repos.md` §4) and the key-dependent read
 * path `open_content` (§8.1, §8.2).
 *
 * Identities and ids are raw 32-byte values ({@link PrivateId}); convert at the boundary with
 * `privateId`.
 */

import { bytes, concat, constantTimeEqual, isU32, randomBytes, sha256, u32, utf8, type Bytes } from './bytes'
import { bytesEqual, type PrivateId } from './ids'
import { hedgeNonce, refNameHash, type EpochKeyring, type EpochKeys } from './keys'
import { MalformedError, buildTlv, parseTlv, type DocFields, type PrivateDocType } from './tlv'

/** Blocks after the next epoch's anchor during which late content is still shown (§8.2). */
export const GRACE_BLOCKS = 240

const V1 = 0x01
const V2 = 0x02
const NONCE_LEN = 12
const TAG_LEN = 16
/** Smallest `enc`: version, nonce, tag (§4.1). */
export const MIN_ENC = 1 + NONCE_LEN + TAG_LEN
/** Smallest config `enc`: version, COMMIT, nonce, tag (§4.2). */
export const MIN_CONFIG_ENC = MIN_ENC + 32

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

/** The plaintext (non-`enc`) fields of a private document that the AD and checks use. */
export interface PrivateDoc {
  readonly type: PrivateDocType
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

function bind(doc: PrivateDoc, keys: EpochKeys): Bytes {
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
      return keys.commit
  }
}

/**
 * The §4.4 associated data of `doc` under `keys`. Throws {@link MalformedError} for a document
 * whose bind fields are missing or out of range, and `RangeError` when `keys` is for another
 * epoch.
 */
export function docAd(doc: PrivateDoc, keys: EpochKeys): Bytes {
  const epoch = u32Field(doc.epoch, 'epoch')
  if (keys.epoch !== doc.epoch) throw new RangeError('the key is not for the document epoch')
  return concat(
    utf8('dash-forge/v2/doc'),
    new Uint8Array([0, doc.type === 'config' ? V2 : V1]),
    keys.repoId,
    fixed(doc.ownerId, 32, 'ownerId'),
    epoch,
    utf8(doc.type),
    new Uint8Array([0]),
    bind(doc, keys),
  )
}

/**
 * The §4.5 check: every hash field the document carries names a ref in `fields` that hashes to
 * it. A present hash with the name missing fails, like a mismatch.
 */
async function refHashesMatch(doc: PrivateDoc, fields: DocFields, keys: EpochKeys): Promise<boolean> {
  const pairs: [Uint8Array | undefined, string | undefined][] =
    doc.type === 'patch'
      ? [
          [doc.baseRefNameHash, fields.baseRefName],
          [doc.sourceRefNameHash, fields.sourceRefName],
        ]
      : doc.type === 'refUpdate' || doc.type === 'protectedRefUpdate'
        ? [[doc.refNameHash, fields.refName]]
        : []
  for (const [hash, name] of pairs) {
    if (hash === undefined) continue
    if (name === undefined || !constantTimeEqual(await refNameHash(keys, name), hash)) return false
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

/** Whether `enc` has the shape its type demands (§8.1 step 1). */
function encShapeOk(type: PrivateDocType, enc: Uint8Array): boolean {
  if (type === 'config') return enc.length >= MIN_CONFIG_ENC && enc[0] === V2
  return enc.length >= MIN_ENC && enc[0] === V1
}

/**
 * §8.1 steps 1 and 3–6 with a given key: shape, commitment, AES-GCM, TLV, ref-name hashes.
 * `anchor` says whether a config is its epoch's anchor.
 */
export async function openWithKey(doc: StoredPrivateDoc, keys: EpochKeys, anchor: boolean): Promise<OpenResult> {
  const enc = doc.enc
  if (!encShapeOk(doc.type, enc) || !isU32(doc.epoch)) return MALFORMED
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

/** The smallest existing epoch above `epoch`, with its anchor. */
function nextAnchor(anchors: ReadonlyMap<number, AnchorRef>, epoch: number): AnchorRef | undefined {
  let best: [number, AnchorRef] | undefined
  for (const [e, a] of anchors) if (e > epoch && (best === undefined || e < best[0])) best = [e, a]
  return best?.[1]
}

/**
 * The late-content rule (§8.2): content under `epoch` written at `height` by `owner` is late
 * when the next existing epoch's anchor is more than {@link GRACE_BLOCKS} blocks older and
 * `owner` is not a current member.
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
  return next !== undefined && height > next.height + GRACE_BLOCKS
}

function isHeight(h: number | undefined): h is number {
  return h !== undefined && Number.isSafeInteger(h) && h >= 0
}

/** `open_content` (§8.1): decrypt and check a private document, in the normative order. */
export async function openContent(doc: StoredPrivateDoc, ctx: OpenContext): Promise<OpenResult> {
  if (!encShapeOk(doc.type, doc.enc) || !isU32(doc.epoch)) return MALFORMED
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
