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
} as const

type TextField = 'title' | 'body' | 'refName' | 'baseRefName' | 'sourceRefName' | 'defaultBranch' | 'path'

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
}

const TAGS_OF: Readonly<Record<PrivateDocType, readonly number[]>> = {
  issue: [1, 2],
  patch: [1, 2, 4, 5],
  comment: [2, 10],
  review: [2],
  refUpdate: [3],
  protectedRefUpdate: [3],
  config: [6, 7, 8, 9],
}

const MAX_PATTERNS = 8
const FIRST_RESERVED = 11
const FIRST_EXTENSION = 64

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

/** Parse and validate a TLV plaintext for a document of `ctx.type` (§4.3). */
export function parseTlv(pt: Uint8Array, ctx: TlvContext): DocFields {
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
    if (tag < lastTag || (tag === lastTag && tag !== TAG.protectedPattern)) {
      throw new MalformedError(`tag ${tag}: out of order or repeated`)
    }
    lastTag = tag
    if (tag >= FIRST_EXTENSION) continue
    if (tag >= FIRST_RESERVED) throw new MalformedError(`reserved tag ${tag}`)
    if (!allowed.includes(tag)) throw new MalformedError(`tag ${tag} is not a ${ctx.type} field`)
    const value = pt.subarray(start, end)
    if (tag === TAG.prevEpoch || tag === TAG.prevEpochKey) {
      if (!anchorWithPrev) throw new MalformedError(`tag ${tag} outside a config for epoch >= 1`)
      if (tag === TAG.prevEpoch) {
        if (len !== 4) throw new MalformedError('prevEpoch is not 4 bytes')
        out.prevEpoch = view.getUint32(start)
      } else {
        if (len !== 32) throw new MalformedError('prevEpochKey is not 32 bytes')
        out.prevEpochKey = value.slice()
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
      if (anchorWithPrev && (f.prevEpoch === undefined || f.prevEpochKey === undefined)) {
        throw new MalformedError('a config for epoch >= 1 needs prevEpoch and prevEpochKey')
      }
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
  return concat(...parts)
}

/** {@link encodeTlv}, then {@link parseTlv} with the same context; throws {@link MalformedError}. */
export function buildTlv(fields: DocFields, ctx: TlvContext): Bytes {
  const pt = encodeTlv(fields)
  parseTlv(pt, ctx)
  return pt
}
