/**
 * OID / ref-name primitives shared by the FORGE_RULES_V1 fold paths.
 *
 * Ports the free functions at the top of `crates/forge-core/src/rules.rs`
 * (`is_null_oid`, `is_legal_ref_name`, `is_content_hash`, `ref_name_hash_matches`).
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** True for the git null oid — all-zero hex, or empty (create prevOid / delete newOid). */
export function isNullOid(oid: string | undefined): boolean {
  if (oid === undefined || oid.length === 0) return true
  for (let i = 0; i < oid.length; i++) {
    if (oid.charCodeAt(i) !== 0x30 /* '0' */) return false
  }
  return true
}

/**
 * Whether a ref name is legal to advertise on the git wire protocol.
 *
 * Security-critical (parity with the write guard, fold side, helper emission): non-empty,
 * no leading `-`, and no ASCII whitespace or control byte (`b <= 0x20`, plus DEL 0x7f).
 * This makes newline/NUL/space ref-advertisement injection inert on read/fold.
 */
export function isLegalRefName(name: string): boolean {
  if (name.length === 0) return false
  if (name.charCodeAt(0) === 0x2d /* '-' */) return false
  // Inspect UTF-8 bytes: a multi-byte scalar's continuation bytes are all >= 0x80, so a
  // per-code-unit check on the string's char codes is insufficient — encode first.
  const bytes = new TextEncoder().encode(name)
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    if (b <= 0x20 || b === 0x7f) return false
  }
  return true
}

/** Whether `h` is a real 32-byte content hash rendered as 64 hex chars. */
export function isContentHash(h: string): boolean {
  if (h.length !== 64) return false
  for (let i = 0; i < h.length; i++) {
    const c = h.charCodeAt(i)
    const isHex =
      (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)
    if (!isHex) return false
  }
  return true
}

/** Whether `refNameHash` is exactly `sha256(refName)` (case-insensitive hex compare). */
export function refNameHashMatches(refName: string, refNameHash: string): boolean {
  const digest = bytesToHex(sha256(new TextEncoder().encode(refName)))
  return digest.toLowerCase() === refNameHash.toLowerCase()
}

/**
 * Compare two strings by Unicode code point, which is UTF-8 byte order: the order Rust's
 * `String`/`str` `Ord` uses. JavaScript's `<` compares UTF-16 code units instead, which puts
 * an astral character (a surrogate pair, 0xD800–0xDFFF) before U+E000–U+FFFF, so it disagrees
 * with Rust on strings such as "！" (U+FF01) and "😀" (U+1F600). Every string ordering in the
 * rules goes through this. Returns <0, 0, >0.
 */
export function compareStrings(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ca = a.codePointAt(i) as number
    const cb = b.codePointAt(i) as number
    if (ca !== cb) return ca - cb
    // Equal code points have equal lengths; step over the low surrogate of a pair
    if (ca > 0xffff) i++
  }
  return a.length - b.length
}

/**
 * Total-order comparison on the `(createdAt, id)` key used everywhere in the module.
 * Numeric `createdAt` ascending, then `id` by code point ({@link compareStrings}).
 */
export function compareKey(
  a: { createdAt: number; id?: string },
  b: { createdAt: number; id?: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return compareStrings(a.id ?? '', b.id ?? '')
}
