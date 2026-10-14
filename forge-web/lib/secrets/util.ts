/** Small encodings the rules need, written to follow `crates/forge-secrets/src/util.rs` line by line. */

import { sha256 } from '@noble/hashes/sha2.js'

/** The base58 (Bitcoin alphabet) digits. */
export const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Whether `c` (a UTF-16 code unit) is Unicode White_Space, as Rust's `char::is_whitespace` (not JS's). */
export function isRustWhitespace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  )
}

/** `s` without leading characters whose code unit satisfies `pred`. */
export function trimStartBy(s: string, pred: (c: number) => boolean): string {
  let i = 0
  while (i < s.length && pred(s.charCodeAt(i))) i++
  return s.slice(i)
}

/** `s` without trailing characters whose code unit satisfies `pred`. */
export function trimEndBy(s: string, pred: (c: number) => boolean): string {
  let j = s.length
  while (j > 0 && pred(s.charCodeAt(j - 1))) j--
  return s.slice(0, j)
}

/** Rust's `str::trim_start`. */
export function trimStart(s: string): string {
  return trimStartBy(s, isRustWhitespace)
}

/** Rust's `str::trim_end`. */
export function trimEnd(s: string): string {
  return trimEndBy(s, isRustWhitespace)
}

/** Rust's `str::trim`. */
export function trim(s: string): string {
  return trimEnd(trimStart(s))
}

/** Rust's `str::lines`: split on `\n`, a `\r` before it dropped, no empty last line. */
export function lines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  const last = parts.length - 1
  if (parts[last] === '') parts.pop()
  return parts.map((l, i) => (i < last && l.endsWith('\r') ? l.slice(0, -1) : l))
}

/** `s` with `A-Z` lower-cased and nothing else touched (Rust's `to_ascii_lowercase`). */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
}

/** Whether code unit `c` is `A-Za-z0-9`. */
export function isAsciiAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
}

/** Whether code unit `c` is `0-9`. */
export function isAsciiDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39
}

/** Whether code unit `c` is `A-Z`. */
export function isAsciiUpper(c: number): boolean {
  return c >= 0x41 && c <= 0x5a
}

/** Whether code unit `c` is `a-z`. */
export function isAsciiLower(c: number): boolean {
  return c >= 0x61 && c <= 0x7a
}

/** The offsets where each line of `text` starts (`\n` ends a line), for {@link lineAt}. */
export function lineStarts(text: string): number[] {
  const out = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1)
  return out
}

/** The 1-based line of `offset`, given the text's {@link lineStarts}. */
export function lineAt(starts: readonly number[], offset: number): number {
  // Binary search for the count of starts <= offset.
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((starts[mid] as number) <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

const CRC_TABLE: readonly number[] = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    t.push(c >>> 0)
  }
  return t
})()

/** CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320), as zlib's `crc32`; of the UTF-8 bytes of a string. */
export function crc32(data: Uint8Array | string): number {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  let crc = 0xffffffff
  for (const b of bytes) crc = (CRC_TABLE[(crc ^ b) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** `n` in the base of `alphabet`, most significant digit first, left-padded with its zero digit to `width`. */
export function encodeBase(n: number, alphabet: string, width: number): string {
  const base = alphabet.length
  let digits = ''
  let rest = n
  while (rest > 0) {
    digits = alphabet.charAt(rest % base) + digits
    rest = Math.floor(rest / base)
  }
  return digits.padStart(width, alphabet.charAt(0))
}

/** Decode a base58 string (Bitcoin alphabet; each leading `1` is a zero byte); `null` on a character outside it. */
export function base58Decode(s: string): Uint8Array | null {
  // Little-endian base-256 accumulator.
  const acc: number[] = []
  for (let i = 0; i < s.length; i++) {
    const digit = BASE58.indexOf(s.charAt(i))
    if (digit < 0) return null
    let carry = digit
    for (let j = 0; j < acc.length; j++) {
      carry += (acc[j] as number) * 58
      acc[j] = carry & 0xff
      carry >>>= 8
    }
    while (carry > 0) {
      acc.push(carry & 0xff)
      carry >>>= 8
    }
  }
  let zeros = 0
  while (zeros < s.length && s.charAt(zeros) === '1') zeros++
  const out = new Uint8Array(zeros + acc.length)
  for (let i = 0; i < acc.length; i++) out[zeros + i] = acc[acc.length - 1 - i] as number
  return out
}

/** Double SHA-256. */
export function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data))
}

/** Shannon entropy of `s` in bits per character: `-Σ p·log2(p)`, summed in code point order. */
export function shannonEntropy(s: string): number {
  const chars = Array.from(s)
  if (chars.length === 0) return 0
  const counts = new Map<number, number>()
  for (const c of chars) {
    const cp = c.codePointAt(0) as number
    counts.set(cp, (counts.get(cp) ?? 0) + 1)
  }
  const n = chars.length
  let sum = 0
  for (const cp of [...counts.keys()].sort((a, b) => a - b)) {
    const p = (counts.get(cp) as number) / n
    sum += -p * Math.log2(p)
  }
  return sum
}
