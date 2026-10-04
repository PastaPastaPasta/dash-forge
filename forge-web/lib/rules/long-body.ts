/**
 * Long bodies (`docs/contracts/forge-v2.md` §6.3): a body, comment or set of release notes longer
 * than its field holds is stored as a content-addressed artifact (a `packManifest` of kind 6,
 * `PACK_KIND.LONG_BODY`), and the field keeps a prefix of the text and a last line naming it:
 *
 *     <the first few KB of the text>
 *
 *     <!-- forge:body sha256=<64 lowercase hex> bytes=<the full text's UTF-8 length> -->
 *
 * The pure half, shared with forge-core `rules::long_body` through the `long_body__*`
 * conformance vectors: reading a field ({@link parseLongBody}), checking a fetched text
 * ({@link openLongBodyText}, {@link openPublicLongBody}) and cutting a writer's prefix
 * ({@link fitPrefix}, {@link longBodyStoredText}). Fetching and storing the artifact is
 * `lib/repo/long-body.ts`.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** The longest full text a trailer may name, in UTF-8 bytes (256 KiB). */
export const LONG_BODY_MAX_BYTES = 262_144

/** What the trailer line starts with (the trailing space included). */
export const LONG_BODY_OPEN = '<!-- forge:body '
const CLOSE = ' -->'
/** Between the prefix and the trailer. */
export const LONG_BODY_SEPARATOR = '\n\n'

/** What a stored field says about its text. Parity: forge-core `rules::long_body::LongBody`. */
export type LongBody =
  /** No trailer: the field is the whole text. */
  | { readonly kind: 'plain' }
  /**
   * The text continues in a kind-6 artifact: `sha256` is its `packHash` (of the stored bytes:
   * sealed, in a private repo), `bytes` the full text's UTF-8 length.
   */
  | { readonly kind: 'continued'; readonly prefix: string; readonly sha256: string; readonly bytes: number }
  /** A trailer this version does not read: show `prefix`, say the rest cannot be read, fetch nothing. */
  | { readonly kind: 'unsupported'; readonly prefix: string }

const encoder = new TextEncoder()

/** The UTF-8 length of `s`. */
export function utf8Bytes(s: string): number {
  return encoder.encode(s).length
}

/**
 * Read a stored field: its last line (after the last `\n`, or the whole field) is a trailer when
 * it starts with {@link LONG_BODY_OPEN}, and then must be exactly `<!-- forge:body ` + single-space
 * separated `sha256=<64 lowercase hex>` and `bytes=<1..262144, no leading zero>`, each once, in
 * any order, + ` -->`; anything else starting so is `unsupported`.
 */
export function parseLongBody(stored: string): LongBody {
  const nl = stored.lastIndexOf('\n')
  const head = nl < 0 ? '' : stored.slice(0, nl)
  const line = nl < 0 ? stored : stored.slice(nl + 1)
  if (!line.startsWith(LONG_BODY_OPEN)) return { kind: 'plain' }
  const prefix = head.replace(/\n+$/, '')
  const attrs = attributes(line)
  return attrs === null ? { kind: 'unsupported', prefix } : { kind: 'continued', prefix, ...attrs }
}

function attributes(line: string): { sha256: string; bytes: number } | null {
  const rest = line.slice(LONG_BODY_OPEN.length)
  if (!rest.endsWith(CLOSE)) return null
  let sha: string | null = null
  let bytes: number | null = null
  for (const token of rest.slice(0, rest.length - CLOSE.length).split(' ')) {
    const eq = token.indexOf('=')
    if (eq < 0) return null
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (key === 'sha256' && sha === null) {
      if (!/^[0-9a-f]{64}$/.test(value)) return null
      sha = value
    } else if (key === 'bytes' && bytes === null) {
      if (!/^[1-9][0-9]{0,6}$/.test(value)) return null
      const n = Number(value)
      if (n > LONG_BODY_MAX_BYTES) return null
      bytes = n
    } else {
      return null
    }
  }
  return sha === null || bytes === null ? null : { sha256: sha, bytes }
}

/** The trailer line for an artifact of `packHash` `sha256Hex` holding `bytes` of text. */
export function longBodyTrailer(sha256Hex: string, bytes: number): string {
  return `${LONG_BODY_OPEN}sha256=${sha256Hex} bytes=${bytes}${CLOSE}`
}

/**
 * Whether `full` must be stored as an artifact to fit `room` bytes of field: it is longer, or its
 * own last line would read as a trailer (an artifact's text is never parsed, so it shows as written).
 */
export function needsLongBodyArtifact(full: string, room: number): boolean {
  return utf8Bytes(full) > room || parseLongBody(full).kind !== 'plain'
}

/**
 * The field that stores `full` in the artifact `sha256Hex`: {@link fitPrefix} of `full` within what
 * `room` leaves after the separator and the trailer, then the separator and the trailer (the
 * trailer alone when no prefix fits). Null when `room` cannot hold the trailer, or `full` is empty
 * or over {@link LONG_BODY_MAX_BYTES}.
 */
export function longBodyStoredText(full: string, room: number, sha256Hex: string): string | null {
  const bytes = utf8Bytes(full)
  if (bytes === 0 || bytes > LONG_BODY_MAX_BYTES) return null
  return withTrailer(full, longBodyTrailer(sha256Hex, bytes), room)
}

/**
 * A stored long body's field (`stored`, a continued one) within `room` bytes, naming the same
 * artifact: its prefix cut again by {@link fitPrefix} (the trailer alone when none fits). What an
 * edit of a private document's other text (a longer title) writes when that text leaves the field
 * less room than it took. `stored` itself when it fits or is not continued; null when `room` cannot
 * hold the trailer. Parity: forge-core `rules::long_body::refit`.
 */
export function refitLongBodyField(stored: string, room: number): string | null {
  const parsed = parseLongBody(stored)
  if (parsed.kind !== 'continued' || utf8Bytes(stored) <= room) return stored
  return withTrailer(parsed.prefix, longBodyTrailer(parsed.sha256, parsed.bytes), room)
}

/** {@link fitPrefix} of `text` within what `room` leaves after the separator and `line`, then both (`line` alone when no prefix fits); null when `room` cannot hold `line`. */
function withTrailer(text: string, line: string, room: number): string | null {
  // The trailer is ASCII: its length is its byte length.
  const budget = room - line.length
  if (budget < 0) return null
  const prefix = budget >= LONG_BODY_SEPARATOR.length ? fitPrefix(text, budget - LONG_BODY_SEPARATOR.length) : ''
  return prefix === '' ? line : `${prefix}${LONG_BODY_SEPARATOR}${line}`
}

/** A long body's state, on a view whose `body` (or notes) is the text to show. */
export interface LongBodyState {
  /** The full text's length (the trailer's `bytes`), or null for a trailer this version cannot read. */
  readonly bytes: number | null
  /** Why only the first part is shown, or null when the whole text is. */
  readonly incomplete: string | null
  /** The field as stored (the prefix and the trailer): what an edit of the other fields keeps. */
  readonly field: string
}

/** Why a fetched full text is refused (the vectors' names). */
export type LongBodyError = 'notContinued' | 'hash' | 'size' | 'utf8'

export type LongBodyOpened = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: LongBodyError }

/** The full text from an artifact's plaintext: exactly `bytes` long and UTF-8 (a BOM kept). */
export function openLongBodyText(bytes: number, plain: Uint8Array): LongBodyOpened {
  if (plain.length !== bytes) return { ok: false, error: 'size' }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain) }
  } catch {
    return { ok: false, error: 'utf8' }
  }
}

/** The full text a public field continues in, from the artifact's stored bytes: hash, then {@link openLongBodyText}. */
export function openPublicLongBody(stored: string, blob: Uint8Array): LongBodyOpened {
  const parsed = parseLongBody(stored)
  if (parsed.kind !== 'continued') return { ok: false, error: 'notContinued' }
  if (bytesToHex(sha256(blob)) !== parsed.sha256) return { ok: false, error: 'hash' }
  return openLongBodyText(parsed.bytes, blob)
}

/**
 * `text` within `max` UTF-8 bytes: unchanged when it fits, else cut at a character boundary, back
 * to the last paragraph break, else line break, else space, in the cut's second half, ASCII
 * whitespace trimmed from the end, and an open code fence or span closed. Parity: forge-core
 * `fit_prefix` (worked on bytes here too, so the halves and boundaries are the same).
 */
export function fitPrefix(text: string, max: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return text
  // A leading U+FEFF is text, as Rust keeps it (the default decoder would drop it).
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  let room = max
  for (;;) {
    const closed = closeCode(decoder.decode(boundaryCut(clipBytes(bytes, room))))
    const len = utf8Bytes(closed)
    if (len <= max || room === 0) return closed
    room = Math.max(0, room - (len - max))
  }
}

/** The longest prefix of `b` within `max` bytes ending on a UTF-8 character boundary. */
function clipBytes(b: Uint8Array, max: number): Uint8Array {
  if (b.length <= max) return b
  let end = max
  while (end > 0 && ((b[end] as number) & 0xc0) === 0x80) end--
  return b.subarray(0, end)
}

const PARAGRAPH = [0x0a, 0x0a]
const LINE = [0x0a]
const SPACE = [0x20]

function lastIndexOfBytes(b: Uint8Array, sep: readonly number[]): number {
  for (let i = b.length - sep.length; i >= 0; i--) {
    if (sep.every((x, j) => b[i + j] === x)) return i
  }
  return -1
}

/** `b` shortened to its last paragraph break, else line break, else space, when one falls in its second half. */
function boundaryCut(b: Uint8Array): Uint8Array {
  const half = Math.floor(b.length / 2)
  for (const sep of [PARAGRAPH, LINE, SPACE]) {
    const i = lastIndexOfBytes(b, sep)
    if (i >= half) {
      let end = i
      // ASCII whitespace only (space, tab, LF, CR), as the Rust port trims.
      while (end > 0 && [0x20, 0x09, 0x0a, 0x0d].includes(b[end - 1] as number)) end--
      return b.subarray(0, end)
    }
    // Only the last occurrence of a separator is looked at (forge-core `rfind`).
  }
  return b
}

function leadingRun(t: string, c: string): number {
  let n = 0
  while (n < t.length && t[n] === c) n++
  return n
}

/** `s` with a code fence or inline code span left open at its end closed again. */
function closeCode(s: string): string {
  let fence: { c: string; n: number } | null = null
  let span: number | null = null
  for (const raw of s.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const t = line.replace(/^[ \t]+/, '')
    if (fence !== null) {
      const { c, n } = fence
      if (leadingRun(t, c) >= n && [...t.replace(/[ \t]+$/, '')].every((x) => x === c)) fence = null
      continue
    }
    if (span === null) {
      const c = ['`', '~'].find((ch) => leadingRun(t, ch) >= 3)
      if (c !== undefined) {
        fence = { c, n: leadingRun(t, c) }
        continue
      }
    }
    span = backtickSpans(line, span)
  }
  if (fence !== null) return `${s}\n${fence.c.repeat(fence.n)}`
  if (span !== null) return `${s}${'`'.repeat(span)}`
  return s
}

/** The inline code span still open after `line` (its opening run's length), given the one open before it. */
function backtickSpans(line: string, open: number | null): number | null {
  let i = 0
  while (i < line.length) {
    if (open === null && line[i] === '\\') {
      i += 2
      continue
    }
    if (line[i] === '`') {
      const start = i
      while (i < line.length && line[i] === '`') i++
      const n = i - start
      if (open === null) open = n
      else if (open === n) open = null
      continue
    }
    i++
  }
  return open
}
