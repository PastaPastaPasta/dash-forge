/**
 * A bot's members-only posts (`enc` v0x05; mixed-visibility DESIGN §4.9 "Envelope v0x05",
 * `docs/security/private-repos.md` §23) and the `postKey` key letter that carries a bot's post
 * key. The Rust twin is `crates/forge-core/src/private/bot_post.rs`; the `bot_post__*` vectors
 * hold the two byte for byte (`bot-post.conformance.test.ts`).
 *
 * A bot (a role-4 `writer` row) never holds the members key (L4). A maintainer gives it a post
 * key per epoch instead, derived from the epoch key and the bot's identity:
 *
 * ```text
 * W_{e,b}  = HKDF-Expand(PRK_e, "dash-forge/v2/bot-post" ‖ 0x00 ‖ u32(e) ‖ botId(32), 32)
 * PRK_b    = HKDF-Extract(salt = repoId, IKM = W_{e,b})
 * K_obj    = HKDF-Expand(PRK_b, "dash-forge/v2/obj" ‖ 0x00 ‖ u32(e) ‖ nonce ‖ SHA-256(AD), 32)
 * enc      = 0x05 ‖ nonce(12) ‖ COMMIT_obj(32) ‖ AES-256-GCM(K_doc,obj, nonce, TLV, AD') ‖ tag(16)
 * ```
 *
 * `PRK_obj`, `K_doc,obj`, `COMMIT_obj`, `AD' = AD(enc[0] = 0x05) ‖ COMMIT_obj`, the TLV and its
 * padding are exactly v0x03's. Members derive `W_{e,b}` from the epoch key and the document's
 * `$ownerId`; a reader opens a v0x05 document only when that `$ownerId` holds a Bot row of the
 * repository now (`OpenContext.bots`, `./doc` `openContent`). The AD binds the owner, so a post
 * key opens, and mints, only its own bot's documents. The writer's nonce is hedged under the
 * bot's own `K_hedge,b = HKDF-Expand(PRK_b, "dash-forge/v2/hedge" ‖ 0x00 ‖ u32(e), 32)`.
 *
 * The web never writes as a bot (bots post through `dg` and the runner): {@link sealBotPost}
 * exists for parity and tests; what the web uses is the read side and the letter a maintainer
 * sends.
 */

import { bytes, bytesToHex, concat, constantTimeEqual, isU32, randomBytes, sha256, type Bytes } from './bytes'
import { MIN_MEMBERS_ENC, TooLargeError, V5, docAdIn, maxMembersPlaintext, padded, type OpenResult, type PrivateDoc } from './doc'
import { bytesEqual } from './ids'
import { hexExact, type TypedLetter } from './key-letter'
import { objKeys, subkeyInfo, type EpochKeys } from './keys'
import { MalformedError, buildTlv, parseMembersTlv, parseTlv, type DocFields, type PrivateDocType } from './tlv'

export { V5 }

/** `"type": "postKey"`: a bot's post key for one epoch. */
export const TYPE_POST_KEY = 'postKey'

const NONCE_LEN = 12
const MALFORMED: OpenResult = { status: 'malformed' }

/**
 * The kinds a bot posts members-only: issues, comments and reviews. A pull request names its
 * branches by keys of the epoch (a bot holds none); an event or a ref update is never a bot's
 * members-only write.
 */
export function postsKind(type: PrivateDocType): boolean {
  return type === 'issue' || type === 'comment' || type === 'review'
}

/**
 * The post key `W_{e,b}` of one bot for one epoch of one repository, with the keys it derives
 * (non-extractable). The raw `W` stays in a private field; {@link PostKey.wipe} erases it.
 */
export class PostKey {
  readonly #w: Bytes
  readonly #base: CryptoKey
  readonly #hedge: CryptoKey

  private constructor(
    readonly repoId: Bytes,
    readonly epoch: number,
    readonly bot: Bytes,
    w: Bytes,
    base: CryptoKey,
    hedge: CryptoKey,
  ) {
    this.#w = w
    this.#base = base
    this.#hedge = hedge
  }

  /** The keys of `w`, the post key of `bot` for `epoch` of `repoId` (what a `postKey` letter carries). The caller keeps `w`. */
  static async of(repoId: Uint8Array, epoch: number, bot: Uint8Array, w: Uint8Array): Promise<PostKey> {
    if (repoId.length !== 32 || bot.length !== 32 || w.length !== 32) throw new RangeError('repoId, bot and post key are 32 bytes')
    if (!isU32(epoch)) throw new RangeError('epoch must be a u32')
    const salt = new Uint8Array(repoId)
    const base = await crypto.subtle.importKey('raw', bytes(w), 'HKDF', false, ['deriveKey', 'deriveBits'])
    const hedge = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: subkeyInfo('hedge', epoch) },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    )
    return new PostKey(salt, epoch, new Uint8Array(bot), new Uint8Array(w), base, hedge)
  }

  /** The post key of `bot` under the epoch keys `keys`: what members derive to open the bot's posts, and what a maintainer sends it. */
  static async derive(keys: EpochKeys, bot: Uint8Array): Promise<PostKey> {
    const w = await keys.botPostKey(bot)
    try {
      return await PostKey.of(keys.repoId, keys.epoch, bot, w)
    } finally {
      w.fill(0)
    }
  }

  /** A copy of `W_{e,b}` itself: what a `postKey` letter carries. The caller wipes it. */
  key(): Bytes {
    return new Uint8Array(this.#w)
  }

  /** Erase the raw post key (best effort; the derived keys are non-extractable). */
  wipe(): void {
    this.#w.fill(0)
  }

  /** `K_obj = HKDF-Expand(PRK_b, "dash-forge/v2/obj" ‖ 0x00 ‖ u32(e) ‖ nonce ‖ SHA-256(AD), 32)`, raw; the caller wipes it. */
  async objKey(nonce: Uint8Array, ad: Uint8Array): Promise<Bytes> {
    if (nonce.length !== NONCE_LEN) throw new RangeError('a nonce is 12 bytes')
    const info = subkeyInfo('obj', this.epoch, concat(nonce, await sha256(ad)))
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: this.repoId, info }, this.#base, 256))
  }

  /** `nonce = HMAC(K_hedge,b, 0x02 ‖ rnd ‖ AD ‖ SHA-256(TLV))[0..12]`. */
  async hedgedNonce(rnd: Uint8Array, ad: Uint8Array, pt: Uint8Array): Promise<Bytes> {
    const mac = await crypto.subtle.sign('HMAC', this.#hedge, concat(new Uint8Array([0x02]), rnd, ad, await sha256(pt)))
    return new Uint8Array(mac).slice(0, NONCE_LEN)
  }

  /** Whether this key is the one `doc` is sealed under: its bot and its epoch. */
  fits(doc: PrivateDoc): boolean {
    return doc.epoch === this.epoch && bytesEqual(doc.ownerId, this.bot)
  }
}

/** Step 1 of §8.1 for v0x05: the version byte, at least v0x03's 61 bytes, and a kind bots post. */
export function botPostFramed(doc: PrivateDoc, enc: Uint8Array): boolean {
  return enc[0] === V5 && enc.length >= MIN_MEMBERS_ENC && postsKind(doc.type)
}

/** The TLV parse a bot's post gets: a public repository's members-only form, else a private repository's. */
function parseOf(doc: PrivateDoc, pt: Uint8Array): DocFields {
  return doc.vis === 'public' ? parseMembersTlv(pt, doc.type) : parseTlv(pt, { type: doc.type, epoch: doc.epoch })
}

interface BotSealed {
  readonly ad: Bytes
  readonly kObj: Bytes
  readonly commit: Bytes
  readonly tlv: Bytes
  readonly enc: Bytes
}

type NonceOf = (ad: Bytes, tlv: Bytes) => Promise<Uint8Array>

async function sealWith(post: PostKey, doc: PrivateDoc, fields: DocFields, nonceOf: NonceOf): Promise<BotSealed> {
  if (!post.fits(doc) || !postsKind(doc.type)) throw new MalformedError("a post key seals only its own bot's issues, comments and reviews")
  // a writer never emits what a reader refuses
  const records = buildTlv(fields, { type: doc.type, epoch: doc.epoch, blinds: doc.vis === 'public' })
  const room = maxMembersPlaintext(doc.type)
  if (records.length > room) throw new TooLargeError(room)
  const tlv = padded(doc.type, records, room)
  records.fill(0)
  const ad = docAdIn(doc, post.repoId, V5)
  const nonce = await nonceOf(ad, tlv)
  if (nonce.length !== NONCE_LEN) throw new RangeError('a nonce is 12 bytes')
  const kObj = await post.objKey(nonce, ad)
  try {
    const obj = await objKeys(post.repoId, kObj)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytes(nonce), additionalData: concat(ad, obj.commit) }, obj.docKey, tlv)
    return { ad, kObj, commit: obj.commit, tlv, enc: concat(new Uint8Array([V5]), nonce, obj.commit, new Uint8Array(ct)) }
  } catch (e) {
    kObj.fill(0)
    tlv.fill(0)
    throw e
  }
}

/**
 * Seal `fields` as the bot's members-only post `doc` (`enc` v0x05) under its post key `post`,
 * with a hedged random nonce. Throws {@link MalformedError} when `doc` is not the bot's own
 * document under the key's epoch, or not an issue, comment or review; {@link TooLargeError} past
 * v0x03's room.
 */
export async function sealBotPost(post: PostKey, doc: PrivateDoc, fields: DocFields): Promise<Bytes> {
  const rnd = randomBytes(32)
  const sealed = await sealWith(post, doc, fields, (ad, tlv) => post.hedgedNonce(rnd, ad, tlv))
  sealed.tlv.fill(0)
  sealed.kObj.fill(0)
  return sealed.enc
}

/** INTERNAL, TEST-ONLY: {@link sealBotPost} with a caller-chosen nonce. Only `lib/private/testing.ts` may import it. */
export function __unsafeSealBotPostWithNonce(post: PostKey, doc: PrivateDoc, fields: DocFields, nonce: Uint8Array): Promise<BotSealed> {
  return sealWith(post, doc, fields, async () => new Uint8Array(nonce))
}

/** `K_obj` of a well-framed v0x05 `enc` of `doc` under `post`, checked against its commitment (`null`: another key made it). */
async function checkedObjKey(post: PostKey, doc: PrivateDoc, enc: Uint8Array): Promise<{ kObj: Bytes; ad: Bytes } | null> {
  let ad: Bytes
  try {
    ad = docAdIn(doc, post.repoId, V5)
  } catch (e) {
    if (e instanceof MalformedError) return null
    throw e
  }
  const kObj = await post.objKey(enc.subarray(1, 1 + NONCE_LEN), ad)
  if (constantTimeEqual((await objKeys(post.repoId, kObj)).commit, enc.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + 32))) return { kObj, ad }
  kObj.fill(0)
  return null
}

/**
 * Open the bot's post `doc` with its post key `post` (the bot reading its own posts, or a member
 * with {@link PostKey.derive}): the framing, the key's bot and epoch (another bot's or epoch's
 * post is `noKey`), `COMMIT_obj` compared before GCM runs (`commitMismatch`), GCM (`badTag`), then
 * the TLV. Who may post v0x05 at all (a Bot row of the repository) is `openContent`'s check.
 */
export async function openBotPost(post: PostKey, doc: PrivateDoc, enc: Uint8Array): Promise<OpenResult> {
  if (!botPostFramed(doc, enc)) return MALFORMED
  if (!post.fits(doc)) return { status: 'unreadable', reason: 'noKey' }
  const checked = await checkedObjKey(post, doc, enc)
  if (checked === null) return { status: 'unreadable', reason: 'commitMismatch' }
  const nonce = bytes(enc.slice(1, 1 + NONCE_LEN))
  const commit = enc.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + 32)
  let obj
  try {
    obj = await objKeys(post.repoId, checked.kObj)
  } finally {
    checked.kObj.fill(0)
  }
  let pt: Bytes
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: concat(checked.ad, commit) }, obj.docKey, bytes(enc.slice(1 + NONCE_LEN + 32))),
    )
  } catch {
    return { status: 'unreadable', reason: 'badTag' }
  }
  try {
    return { status: 'readable', fields: parseOf(doc, pt) }
  } catch (e) {
    if (e instanceof MalformedError) return MALFORMED
    throw e
  } finally {
    pt.fill(0)
  }
}

/**
 * `K_obj` of the bot's post `doc` under `post`, checked against its commitment: what a
 * maintainer's bundle or a read letter shares. Null when it is not a well-framed v0x05 document
 * of `post`'s bot and epoch, or the key does not commit. The caller wipes it.
 */
export async function botObjKey(post: PostKey, doc: PrivateDoc, enc: Uint8Array): Promise<Bytes | null> {
  if (!botPostFramed(doc, enc) || !post.fits(doc)) return null
  return (await checkedObjKey(post, doc, enc))?.kObj ?? null
}

/** A `postKey` letter (`private-repos.md` §23.2): a bot's post key for one epoch, from a maintainer. */
export interface PostKeyLetter {
  /** The epoch the key is for. */
  readonly epoch: number
  /** `W_{e,b}`. */
  readonly key: Uint8Array
}

/** `{"epoch":e,"key":"<64 hex>","type":"postKey","v":1}`. */
export function postKeyLetterToTyped(l: PostKeyLetter): TypedLetter {
  if (!isU32(l.epoch) || l.key.length !== 32) throw new RangeError('a post key letter carries a u32 epoch and a 32-byte key')
  return { type: TYPE_POST_KEY, v: 1, fields: { epoch: l.epoch, key: bytesToHex(l.key) } }
}

/**
 * A `postKey` letter of version 1, or `null`: another type or version, a missing or unknown
 * field, an epoch past u32, a key that is not 64 lowercase hex characters.
 */
export function postKeyLetterFromTyped(t: TypedLetter): PostKeyLetter | null {
  if (t.type !== TYPE_POST_KEY || t.v !== 1 || Object.keys(t.fields).length !== 2) return null
  const epoch = t.fields.epoch
  if (typeof epoch !== 'number' || !isU32(epoch)) return null
  const key = hexExact(t.fields.key, 32)
  return key === null ? null : { epoch, key }
}
