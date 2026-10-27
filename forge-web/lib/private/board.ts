/**
 * Sealed boards and cards on a private repository (`docs/security/private-repos.md` §4.6,
 * `docs/design/boards.md` §3.3): a `board`'s `name` and `spec`, and a `card`'s `col`, `rank` and
 * `f`, sealed together into `enc` (v0x01) under the repository's current epoch, with the §4.4
 * framing (`docType` `board` bound to `u32(key)`, `card` bound to `u32(board) ‖ item`), so a
 * sealed payload cannot be moved to another board or item. The TLV, its padding and the open are
 * this module's; the `sealed_board__*` vectors (`tools/private-repos-vectors/boards.py`) pin them
 * byte for byte. forge-core has no reader yet: `dg board` implements the same against the vectors.
 */

import { bytes, concat, isU32, randomBytes, sha256, u16, u32, utf8, type Bytes } from './bytes'
import { TooLargeError, type OpenContext, type UnreadableReason } from './doc'
import { hedgeNonce, type EpochKeys } from './keys'
import { MalformedError } from './tlv'

/** The two sealed kinds (§4.4 `docType`). */
export type BoardDocType = 'board' | 'card'

const V1 = 0x01
const NONCE_LEN = 12
const MIN_ENC = 1 + NONCE_LEN + 16

/** The `enc` caps of the two types (forge-meta `board.enc` / `card.enc` `maxItems`). */
export const BOARD_MAX_ENC = 5120
export const CARD_MAX_ENC = 2560
/** The largest TLV each type seals: its `enc` cap less the v0x01 framing (29 bytes). */
export const BOARD_MAX_PLAINTEXT = BOARD_MAX_ENC - MIN_ENC
export const CARD_MAX_PLAINTEXT = CARD_MAX_ENC - MIN_ENC

/** The TLV tags of a board and a card (§4.6). Tags 32-36 are these types' only; 64 pads. */
export const BOARD_TAG = {
  name: 32,
  spec: 33,
  col: 34,
  rank: 35,
  fields: 36,
  padding: 64,
} as const

/** A sealed TLV is padded to a multiple of this many bytes (a release's bucket, §16.2). */
const PAD_BUCKET = 32

/** The tags each kind carries. */
const TAGS_OF: Readonly<Record<BoardDocType, readonly number[]>> = {
  board: [BOARD_TAG.name, BOARD_TAG.spec],
  card: [BOARD_TAG.col, BOARD_TAG.rank, BOARD_TAG.fields],
}

/** A board's sealed fields: its name and its definition (the spec JSON, judged by the board rules, not here). */
export interface BoardFields {
  readonly name: string
  readonly spec: string
}

/** A card's sealed fields, each absent when the card has none. */
export interface CardFields {
  readonly col?: number
  readonly rank?: string
  /** The field values' JSON (`card.f`). */
  readonly f?: string
}

/** The plaintext identity a sealed board or card is bound to (§4.4 `bind`). */
export type BoardBind = { readonly type: 'board'; readonly key: number } | { readonly type: 'card'; readonly board: number; readonly item: Uint8Array }

const NAME_MAX_CHARS = 63
const NAME_MAX_BYTES = 252
const SPEC_MAX_BYTES = 4096
const FIELDS_MAX_BYTES = 2048
const RANK = /^[0-9A-Za-z]{0,62}[1-9A-Za-z]$/
/** The `board.name` schema pattern: no control character, and at least one that is not white space. */
const NAME = /^[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]*$/u

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Thrown inside the parser only. */
class Refused extends Error {}

function record(tag: number, value: Uint8Array): Bytes {
  return concat(new Uint8Array([tag]), u16(value.length), value)
}

function maxPlaintext(type: BoardDocType): number {
  return type === 'board' ? BOARD_MAX_PLAINTEXT : CARD_MAX_PLAINTEXT
}

/** Why `f` may not be sealed as a board (a reader would refuse it), or null. */
function boardProblem(f: BoardFields): string | null {
  const name = utf8(f.name)
  if (f.name === '' || [...f.name].length > NAME_MAX_CHARS || name.length > NAME_MAX_BYTES || !NAME.test(f.name)) return 'a board name is 1-63 characters with no control character'
  const spec = utf8(f.spec)
  if (spec.length < 1 || spec.length > SPEC_MAX_BYTES) return 'a board definition is 1-4096 bytes'
  return null
}

/** Why `f` may not be sealed as a card, or null. */
function cardProblem(f: CardFields): string | null {
  if (f.col !== undefined && (!Number.isInteger(f.col) || f.col < 0 || f.col > 255)) return 'a card column is 0-255'
  if (f.rank !== undefined && !RANK.test(f.rank)) return 'a card rank is 1-63 rank digits, not ending in 0'
  if (f.f !== undefined) {
    const n = utf8(f.f).length
    if (n < 1 || n > FIELDS_MAX_BYTES) return 'card field values are 1-2048 bytes'
  }
  return null
}

/** The TLV records of `f`, ascending, without padding (§4.6). */
export function encodeBoardTlv(f: BoardFields): Bytes {
  return concat(record(BOARD_TAG.name, utf8(f.name)), record(BOARD_TAG.spec, utf8(f.spec)))
}

/** The TLV records of `f`, ascending, without padding; an empty card is no records. */
export function encodeCardTlv(f: CardFields): Bytes {
  const out: Uint8Array[] = []
  if (f.col !== undefined) out.push(record(BOARD_TAG.col, new Uint8Array([f.col])))
  if (f.rank !== undefined) out.push(record(BOARD_TAG.rank, utf8(f.rank)))
  if (f.f !== undefined) out.push(record(BOARD_TAG.fields, utf8(f.f)))
  return concat(...out)
}

/**
 * The tag-64 record that pads `n` bytes of TLV to a multiple of 32 within the type's cap (a
 * release's rule, §16.2); nothing when not even an empty record fits.
 */
function padding(n: number, cap: number): Bytes {
  if (n + 3 > cap) return new Uint8Array(0)
  const r = Math.min((PAD_BUCKET - ((n + 3) % PAD_BUCKET)) % PAD_BUCKET, cap - 3 - n)
  return record(BOARD_TAG.padding, new Uint8Array(r))
}

/** The padded TLV a writer seals, refused ({@link MalformedError}) where a reader would refuse it. */
function buildTlv(type: BoardDocType, f: BoardFields | CardFields): Bytes {
  const problem = type === 'board' ? boardProblem(f as BoardFields) : cardProblem(f as CardFields)
  if (problem !== null) throw new MalformedError(problem)
  const body = type === 'board' ? encodeBoardTlv(f as BoardFields) : encodeCardTlv(f as CardFields)
  const cap = maxPlaintext(type)
  // never above the cap: every field is bounded well below it (§4.6)
  if (body.length > cap) throw new TooLargeError(cap)
  return concat(body, padding(body.length, cap))
}

function text(value: Uint8Array): string {
  try {
    return decoder.decode(value)
  } catch {
    throw new Refused('invalid UTF-8')
  }
}

/**
 * Parse a board's or a card's TLV (§4.6): records strictly ascending, none repeated; tags 1-63
 * other than the kind's own are malformed, 64-255 skipped (64 pads); every value valid and
 * within its cap; a zero-length text record counts as absent; a board needs its name and spec.
 * Null when malformed.
 */
export function parseBoardTlv(type: 'board', pt: Uint8Array): BoardFields | null
export function parseBoardTlv(type: 'card', pt: Uint8Array): CardFields | null
export function parseBoardTlv(type: BoardDocType, pt: Uint8Array): BoardFields | CardFields | null
export function parseBoardTlv(type: BoardDocType, pt: Uint8Array): BoardFields | CardFields | null {
  const allowed = TAGS_OF[type]
  const out: { name?: string; spec?: string; col?: number; rank?: string; f?: string } = {}
  try {
    let i = 0
    let last = 0
    while (i < pt.length) {
      if (pt.length - i < 3) throw new Refused('truncated record')
      const tag = pt[i] as number
      const len = ((pt[i + 1] as number) << 8) | (pt[i + 2] as number)
      if (i + 3 + len > pt.length) throw new Refused('record runs past the end')
      const value = pt.subarray(i + 3, i + 3 + len)
      i += 3 + len
      if (tag <= last) throw new Refused('records out of order or repeated')
      last = tag
      if (tag >= BOARD_TAG.padding) continue
      if (!allowed.includes(tag)) throw new Refused(`tag ${tag} in a ${type}`)
      switch (tag) {
        case BOARD_TAG.name:
          if (len > 0) out.name = text(value)
          break
        case BOARD_TAG.spec:
          if (len > 0) out.spec = text(value)
          break
        case BOARD_TAG.col:
          if (len !== 1) throw new Refused('a column is one byte')
          out.col = value[0] as number
          break
        case BOARD_TAG.rank:
          if (len > 0) out.rank = text(value)
          break
        case BOARD_TAG.fields:
          if (len > 0) out.f = text(value)
          break
      }
    }
  } catch (e) {
    if (e instanceof Refused) return null
    throw e
  }
  if (type === 'board') {
    if (out.name === undefined || out.spec === undefined) return null
    const f: BoardFields = { name: out.name, spec: out.spec }
    return boardProblem(f) === null ? f : null
  }
  const f: CardFields = { ...(out.col !== undefined ? { col: out.col } : {}), ...(out.rank !== undefined ? { rank: out.rank } : {}), ...(out.f !== undefined ? { f: out.f } : {}) }
  return cardProblem(f) === null ? f : null
}

/** `bind` (§4.4): `u32(key)` for a board, `u32(board) ‖ item` for a card. */
function bindOf(b: BoardBind): Bytes {
  if (b.type === 'board') {
    if (!isU32(b.key) || b.key === 0) throw new MalformedError('a board key is 1-4294967295')
    return u32(b.key)
  }
  if (!isU32(b.board) || b.board === 0) throw new MalformedError('a board key is 1-4294967295')
  if (b.item.length !== 32) throw new MalformedError('an item id is 32 bytes')
  return concat(u32(b.board), b.item)
}

/** The §4.4 AD of a board or card: `docType` its type, `bind` its immutable keys. */
export function boardAd(keys: EpochKeys, ownerId: Uint8Array, b: BoardBind): Bytes {
  if (ownerId.length !== 32) throw new MalformedError('ownerId must be 32 bytes')
  return concat(utf8('dash-forge/v2/doc'), new Uint8Array([0, V1]), keys.repoId, ownerId, u32(keys.epoch), utf8(b.type), new Uint8Array([0]), bindOf(b))
}

/** A sealed board or card with the intermediate values the vectors pin. */
interface SealedBoard {
  readonly ad: Bytes
  readonly tlv: Bytes
  readonly enc: Bytes
}

type NonceOf = (ad: Bytes, tlv: Bytes) => Promise<Bytes>

async function sealWith(keys: EpochKeys, ownerId: Uint8Array, b: BoardBind, f: BoardFields | CardFields, nonceOf: NonceOf): Promise<SealedBoard> {
  const tlv = buildTlv(b.type, f)
  const ad = boardAd(keys, ownerId, b)
  const nonce = await nonceOf(ad, tlv)
  if (nonce.length !== NONCE_LEN) throw new RangeError('a nonce is 12 bytes')
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: ad }, keys.docKey, tlv)
  return { ad, tlv, enc: concat(new Uint8Array([V1]), nonce, new Uint8Array(ct)) }
}

/**
 * Seal a board's or a card's fields as `ownerId`'s document under `keys` (the repository's
 * current write epoch), with a hedged random nonce (§3.6). The document is then
 * `{repoId, key | (board, item), state, epoch: keys.epoch, enc, r}`, with no plaintext name,
 * spec, col, rank or f. Throws {@link MalformedError} for fields a reader would refuse.
 */
export async function sealBoardDoc(keys: EpochKeys, ownerId: Uint8Array, b: { readonly type: 'board'; readonly key: number }, f: BoardFields): Promise<Bytes>
export async function sealBoardDoc(keys: EpochKeys, ownerId: Uint8Array, b: { readonly type: 'card'; readonly board: number; readonly item: Uint8Array }, f: CardFields): Promise<Bytes>
export async function sealBoardDoc(keys: EpochKeys, ownerId: Uint8Array, b: BoardBind, f: BoardFields | CardFields): Promise<Bytes> {
  const hedged: NonceOf = async (ad, tlv) => hedgeNonce(keys, randomBytes(32), ad, await sha256(tlv))
  const sealed = await sealWith(keys, ownerId, b, f, hedged)
  sealed.tlv.fill(0)
  return sealed.enc
}

/**
 * INTERNAL, TEST-ONLY: {@link sealBoardDoc} with a caller-chosen nonce, for the `sealed_board`
 * vectors. Only `lib/private/testing.ts` may import it; it is not re-exported from `index.ts`.
 */
export function __unsafeSealBoardDocWithNonce(keys: EpochKeys, ownerId: Uint8Array, b: BoardBind, f: BoardFields | CardFields, nonce: Uint8Array): Promise<SealedBoard> {
  return sealWith(keys, ownerId, b, f, async () => new Uint8Array(nonce))
}

/** A stored board or card, as the open sees it. */
export interface StoredBoardDoc {
  readonly bind: BoardBind
  /** `$ownerId`, 32 bytes. */
  readonly ownerId: Uint8Array
  readonly epoch?: number
  readonly enc?: Uint8Array
  /** Whether it also carries a plaintext content field (a board's `name` / `spec`; a card's `col` / `rank` / `f`): malformed. */
  readonly hasPlaintextContent: boolean
}

export type BoardOpenResult =
  | { readonly status: 'readable'; readonly fields: BoardFields | CardFields }
  | { readonly status: 'unreadable'; readonly reason: UnreadableReason }
  | { readonly status: 'malformed' }

const MALFORMED: BoardOpenResult = { status: 'malformed' }
const unreadable = (reason: UnreadableReason): BoardOpenResult => ({ status: 'unreadable', reason })

/**
 * Open a sealed board or card (§4.6, in order): the key-independent checks (an `enc`, a u32
 * `epoch`, no plaintext content), the framing (a version other than 0x01, a later client's
 * members-only board, is `unknownVersion`, never malformed), the epoch and key, AES-GCM, the
 * TLV, then the burned clause of the late-content rule. Both types are member-gated at
 * consensus on every replace (boards.md §3), so the height part of §8.2 does not apply, as for
 * a member `event`.
 */
export async function openBoardDoc(ctx: OpenContext, d: StoredBoardDoc): Promise<BoardOpenResult> {
  const { enc, epoch } = d
  if (d.ownerId.length !== 32 || enc === undefined || epoch === undefined || !isU32(epoch) || d.hasPlaintextContent) return MALFORMED
  if (enc.length < MIN_ENC) return MALFORMED
  if (enc[0] !== V1) return unreadable('unknownVersion')
  if (!ctx.anchors.has(epoch)) return unreadable('noEpoch')
  const keys = ctx.keys.get(epoch)
  if (keys === undefined) return unreadable('noKey')
  let ad: Bytes
  try {
    ad = boardAd(keys, d.ownerId, d.bind)
  } catch (e) {
    if (e instanceof MalformedError) return MALFORMED
    throw e
  }
  let pt: Bytes
  try {
    pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(enc.slice(1, 1 + NONCE_LEN)), additionalData: ad }, keys.docKey, bytes(enc.slice(1 + NONCE_LEN))))
  } catch {
    return unreadable('badTag')
  }
  let fields: BoardFields | CardFields | null
  try {
    fields = parseBoardTlv(d.bind.type, pt)
  } finally {
    pt.fill(0)
  }
  if (fields === null) return MALFORMED
  if (ctx.burned?.has(epoch) === true && !ctx.members.has(d.ownerId)) return unreadable('late')
  return { status: 'readable', fields }
}
