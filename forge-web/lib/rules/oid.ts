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
 * Total-order comparison on the `(createdAt, id)` key used everywhere in the module.
 * Numeric `createdAt` ascending, then `id` (byte/scalar) ascending. Returns <0, 0, >0.
 */
export function compareKey(
  a: { createdAt: number; id?: string },
  b: { createdAt: number; id?: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  const ai = a.id ?? ''
  const bi = b.id ?? ''
  if (ai < bi) return -1
  if (ai > bi) return 1
  return 0
}
