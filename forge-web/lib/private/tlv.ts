/**
 * The plaintext of an encrypted document field: TLV records `tag(u8) ‖ len(u16) ‖ value`
 * (`docs/security/private-repos.md` §4.3). {@link parseTlv} is the single validator: a writer
 * runs its own output through it before sealing, so it never seals what a reader refuses.
 */

import { concat, u16, u32, type Bytes } from './bytes'

/** The contract types whose content is encrypted (§4.4 `docType`). */
export type PrivateDocType =
  | 'issue'
  | 'patch'
  | 'comment'
  | 'review'
  | 'refUpdate'
  | 'protectedRefUpdate'
  | 'config'
  | 'event'

/** The decrypted content of a private document; only present fields are set. */
export interface DocFields {
  readonly title?: string
  readonly body?: string
  readonly refName?: string
  readonly baseRefName?: string
  readonly sourceRefName?: string
  readonly defaultBranch?: string
  /** Tag 7 records in order, zero-length ones dropped; absent when none is non-empty. */
  readonly protectedPatterns?: readonly string[]
  /** Tag 8 (config anchor, `e ≥ 1`). */
  readonly prevEpoch?: number
  /** Tag 9 (config anchor, `e ≥ 1`): the previous epoch's 32-byte key. Secret: wipe after import. */
  readonly prevEpochKey?: Uint8Array
  /** Tag 10 (inline review comment). */
  readonly path?: string
  /**
   * Tag 11 (config, `e >= 1`): the epoch is burned (§5.3): its key reached someone it must not,
   * so it is chain-only, never a write epoch. Only the anchor's flag decides.
   */
  readonly burned?: true
  /**
   * Tag 12 (config, `e >= 1`, not burned): `skipEpochKey`, the key of the nearest epoch below a
   * burned run that is not burned, so the chain steps over the run (§5.3). Secret: wipe after import.
   */
  readonly skipEpochKey?: Uint8Array
  /** Tag 13 (issue, patch, comment, review): an imported document's `imported.author` (§7). */
  readonly importedAuthor?: string
  /** Tag 14 (issue, patch, comment, review): an imported document's `imported.url` (§7). */
  readonly importedUrl?: string
  /**
   * Tag 15 (event): the event's `value` (a label or milestone name, a dismiss reason, an
   * assignee, a retarget base), sealed in a private repo (§7).
   */
  readonly eventValue?: string
}

/** A §4.3 violation. */
export class MalformedError extends Error {
  constructor(message: string) {
    super(`malformed: ${message}`)
    this.name = 'MalformedError'
  }
}

export const TAG = {
  title: 1,
  body: 2,
  refName: 3,
  baseRefName: 4,
  sourceRefName: 5,
  defaultBranch: 6,
  protectedPattern: 7,
  prevEpoch: 8,
  prevEpochKey: 9,
  path: 10,
  burned: 11,
  skipEpochKey: 12,
  importedAuthor: 13,
  importedUrl: 14,
  eventValue: 15,
} as const

type TextField =
  | 'title'
  | 'body'
  | 'refName'
  | 'baseRefName'
  | 'sourceRefName'
  | 'defaultBranch'
  | 'path'
  | 'importedAuthor'
  | 'importedUrl'
  | 'eventValue'

interface TextSpec {
  readonly field: TextField | 'protectedPattern'
  /** A zero-length record counts as absent (the public schema's `minLength 1`). */
  readonly minOne: boolean
  readonly maxChars?: number
  readonly maxBytes?: number
}

const TEXT: Readonly<Record<number, TextSpec>> = {
  1: { field: 'title', minOne: true, maxChars: 256, maxBytes: 1024 },
  2: { field: 'body', minOne: false, maxChars: 5120, maxBytes: 5120 },
  3: { field: 'refName', minOne: true, maxBytes: 255 },
  4: { field: 'baseRefName', minOne: true, maxBytes: 255 },
  5: { field: 'sourceRefName', minOne: true, maxBytes: 255 },
  6: { field: 'defaultBranch', minOne: true, maxBytes: 255 },
  7: { field: 'protectedPattern', minOne: true, maxChars: 100 },
  10: { field: 'path', minOne: false, maxChars: 500, maxBytes: 1000 },
  13: { field: 'importedAuthor', minOne: true, maxChars: 120, maxBytes: 480 },
  14: { field: 'importedUrl', minOne: true, maxChars: 300, maxBytes: 300 },
  15: { field: 'eventValue', minOne: true, maxChars: 120, maxBytes: 480 },
}

const TAGS_OF: Readonly<Record<PrivateDocType, readonly number[]>> = {
  issue: [1, 2, 13, 14],
  patch: [1, 2, 4, 5, 13, 14],
  comment: [2, 10, 13, 14],
  review: [2, 13, 14],
  refUpdate: [3],
  protectedRefUpdate: [3],
  config: [6, 7, 8, 9, 11, 12],
  event: [15],
}

/**
 * The document property a sealed field is written from and opened back into: the field's own
 * name, except an event's `value` (TLV `eventValue`, tag 15).
 */
export function propOf(field: keyof DocFields): string {
  return field === 'eventValue' ? 'value' : field
}

const MAX_PATTERNS = 8
const FIRST_RESERVED = 16
const FIRST_EXTENSION = 64

/**
 * Tag 25 (`enc` v0x04 only, repeatable): a specific-people letter's recipient identity ids, 32
 * bytes each, in slot order. In every other envelope it stays reserved, so malformed.
 */
export const RECIPIENT_TAG = 25
/** Tag 64, the first extension tag: the padding record of a members or specific-people document (§4.3). */
export const PAD_TAG = FIRST_EXTENSION
/** Members and specific-people documents pad their TLV to a multiple of this many bytes (D28). */
export const PAD_BUCKET = 64

/** The kinds a specific-people letter (`enc` v0x04) may carry: the discussion types and an event. */
export function letterKind(type: PrivateDocType): boolean {
  return type === 'issue' || type === 'patch' || type === 'comment' || type === 'review' || type === 'event'
}

/** What the parser needs to know about the document besides its bytes. */
export interface TlvContext {
  readonly type: PrivateDocType
  readonly epoch: number
  /** Config only: whether this document is its epoch's anchor (§5.3). */
  readonly anchor?: boolean
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function decodeText(value: Uint8Array, spec: TextSpec): string {
  let s: string
  try {
    s = decoder.decode(value)
  } catch {
    throw new MalformedError(`tag ${spec.field}: invalid UTF-8`)
  }
  if (spec.maxBytes !== undefined && value.length > spec.maxBytes) {
    throw new MalformedError(`${spec.field} over ${spec.maxBytes} bytes`)
  }
  if (spec.maxChars !== undefined && [...s].length > spec.maxChars) {
    throw new MalformedError(`${spec.field} over ${spec.maxChars} characters`)
  }
  return s
}

/**
 * Parse and validate a TLV plaintext for a document of `ctx.type` (§4.3). Tag 25 is refused: it
 * belongs to `enc` v0x04 only ({@link parseLetterTlv}).
 */
export function parseTlv(pt: Uint8Array, ctx: TlvContext): DocFields {
  return parseWith(pt, ctx, undefined)
}

/**
 * Parse the TLV of a specific-people letter (`enc` v0x04): the content records of `type`, one
 * tag-25 record per recipient (32 bytes each, consecutive, in slot order), then extension
 * records. Throws {@link MalformedError}.
 */
export function parseLetterTlv(pt: Uint8Array, type: PrivateDocType): { fields: DocFields; recipients: Uint8Array[] } {
  const recipients: Uint8Array[] = []
  const fields = parseWith(pt, { type, epoch: 0 }, recipients)
  return { fields, recipients }
}

function parseWith(pt: Uint8Array, ctx: TlvContext, recipients: Uint8Array[] | undefined): DocFields {
  const allowed = TAGS_OF[ctx.type]
  // Every config of an epoch e >= 1 carries prevEpoch/prevEpochKey, anchor or not (§4.3): any
  // of them may become the anchor once an earlier one's author stops being a maintainer.
  const anchorWithPrev = ctx.type === 'config' && ctx.epoch >= 1
  const view = new DataView(pt.buffer, pt.byteOffset, pt.byteLength)
  const out: {
    -readonly [K in keyof DocFields]: DocFields[K]
  } = {}
  const patterns: string[] = []
  let patternRecords = 0
  let lastTag = -1
  let pos = 0
  while (pos < pt.length) {
    if (pt.length - pos < 3) throw new MalformedError('trailing bytes')
    const tag = pt[pos] as number
    const len = view.getUint16(pos + 1)
    const start = pos + 3
    const end = start + len
    if (end > pt.length) throw new MalformedError(`tag ${tag}: length past the end`)
    pos = end
    if (tag < lastTag || (tag === lastTag && tag !== TAG.protectedPattern && tag !== RECIPIENT_TAG)) {
      throw new MalformedError(`tag ${tag}: out of order or repeated`)
    }
    lastTag = tag
    if (tag >= FIRST_EXTENSION) continue
    if (tag === RECIPIENT_TAG && recipients !== undefined && letterKind(ctx.type)) {
      if (len !== 32) throw new MalformedError('a recipient id is not 32 bytes')
      recipients.push(pt.slice(start, end))
      continue
    }
    if (tag >= FIRST_RESERVED) throw new MalformedError(`reserved tag ${tag}`)
    if (!allowed.includes(tag)) throw new MalformedError(`tag ${tag} is not a ${ctx.type} field`)
    const value = pt.subarray(start, end)
    if (tag === TAG.burned) {
      if (!anchorWithPrev) throw new MalformedError('burned outside a config for epoch >= 1')
      if (len !== 1 || value[0] !== 0x01) throw new MalformedError('burned is not the single byte 0x01')
      out.burned = true
      continue
    }
    if (tag === TAG.prevEpoch || tag === TAG.prevEpochKey || tag === TAG.skipEpochKey) {
      if (!anchorWithPrev) throw new MalformedError(`tag ${tag} outside a config for epoch >= 1`)
      if (tag === TAG.prevEpoch) {
        if (len !== 4) throw new MalformedError('prevEpoch is not 4 bytes')
        out.prevEpoch = view.getUint32(start)
      } else {
        if (len !== 32) throw new MalformedError(`tag ${tag} is not 32 bytes`)
        if (tag === TAG.prevEpochKey) out.prevEpochKey = value.slice()
        else out.skipEpochKey = value.slice()
      }
      continue
    }
    const spec = TEXT[tag] as TextSpec
    if (tag === TAG.protectedPattern && ++patternRecords > MAX_PATTERNS) {
      throw new MalformedError(`more than ${MAX_PATTERNS} protectedPattern records`)
    }
    const text = decodeText(value, spec)
    if (spec.minOne && text.length === 0) continue
    if (spec.field === 'protectedPattern') patterns.push(text)
    else out[spec.field] = text
  }
  if (patterns.length > 0) out.protectedPatterns = patterns
  requireFields(out, ctx, anchorWithPrev)
  return out
}

function requireFields(f: DocFields, ctx: TlvContext, anchorWithPrev: boolean): void {
  switch (ctx.type) {
    case 'issue':
    case 'patch':
      if (f.title === undefined) throw new MalformedError(`${ctx.type} without a title`)
      return
    case 'comment':
      if (f.body === undefined || f.body.length === 0) throw new MalformedError('comment without a body')
      return
    case 'refUpdate':
    case 'protectedRefUpdate':
      if (f.refName === undefined) throw new MalformedError(`${ctx.type} without a refName`)
      return
    case 'config':
      if (!anchorWithPrev) return
      if (f.prevEpoch === undefined) throw new MalformedError('a config for epoch >= 1 needs prevEpoch')
      if (f.burned === true) {
        // the burned key may sit with someone who never held the key below (§5.3)
        if (f.prevEpochKey !== undefined || f.skipEpochKey !== undefined) {
          throw new MalformedError('a burned config carries neither prevEpochKey nor skipEpochKey')
        }
      } else if (f.prevEpochKey === undefined) {
        throw new MalformedError('a config for epoch >= 1 needs prevEpochKey')
      }
      return
    case 'event':
      if (f.eventValue === undefined) throw new MalformedError('event without a value')
      return
    case 'review':
      return
  }
}

function record(tag: number, value: Uint8Array): Bytes {
  if (value.length > 0xffff) throw new MalformedError(`tag ${tag}: value over 65535 bytes`)
  return concat(new Uint8Array([tag]), u16(value.length), value)
}

/**
 * Encode `fields` as TLV in ascending tag order, `protectedPatterns` as repeated tag-7
 * records. No validation: {@link buildTlv} validates.
 */
export function encodeTlv(fields: DocFields): Bytes {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const text = (tag: number, v: string | undefined) => {
    if (v !== undefined) parts.push(record(tag, enc.encode(v)))
  }
  text(TAG.title, fields.title)
  text(TAG.body, fields.body)
  text(TAG.refName, fields.refName)
  text(TAG.baseRefName, fields.baseRefName)
  text(TAG.sourceRefName, fields.sourceRefName)
  text(TAG.defaultBranch, fields.defaultBranch)
  for (const p of fields.protectedPatterns ?? []) text(TAG.protectedPattern, p)
  if (fields.prevEpoch !== undefined) parts.push(record(TAG.prevEpoch, u32(fields.prevEpoch)))
  if (fields.prevEpochKey !== undefined) parts.push(record(TAG.prevEpochKey, fields.prevEpochKey))
  text(TAG.path, fields.path)
  if (fields.burned === true) parts.push(record(TAG.burned, new Uint8Array([0x01])))
  if (fields.skipEpochKey !== undefined) parts.push(record(TAG.skipEpochKey, fields.skipEpochKey))
  text(TAG.importedAuthor, fields.importedAuthor)
  text(TAG.importedUrl, fields.importedUrl)
  text(TAG.eventValue, fields.eventValue)
  return concat(...parts)
}

/**
 * The padding record (§4.3, D28) a TLV of `n` bytes gets so that it ends on a multiple of
 * {@link PAD_BUCKET}: one tag-64 record of zero bytes, never taking the TLV past `room`, and
 * empty when not even its 3-byte header fits. Like a sealed release's (§16.2), it is always
 * written when it fits, so an exact multiple gains a whole bucket.
 */
export function padRecord(n: number, room: number): Bytes {
  if (n + 3 > room) return new Uint8Array(0)
  const fill = Math.min((PAD_BUCKET - ((n + 3) % PAD_BUCKET)) % PAD_BUCKET, room - 3 - n)
  return record(PAD_TAG, new Uint8Array(fill))
}

/** One tag-25 record per recipient id, in slot order: a letter's TLV tail before its padding. */
export function encodeRecipients(ids: readonly Uint8Array[]): Bytes {
  return concat(...ids.map((id) => record(RECIPIENT_TAG, id)))
}

/** {@link encodeTlv}, then {@link parseTlv} with the same context; throws {@link MalformedError}. */
export function buildTlv(fields: DocFields, ctx: TlvContext): Bytes {
  const pt = encodeTlv(fields)
  parseTlv(pt, ctx)
  return pt
}
