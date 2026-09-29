/**
 * OID / ref-name primitives shared by the FORGE_RULES fold paths.
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

// ---------------------------------------------------------------------------
// RC1 write pre-checks: the contract's own ref-name grammar (R-01 `ref_grammar`)
// ---------------------------------------------------------------------------

/**
 * One ref-name component as RC1 spells it: no control byte, space, DEL or `~ ^ : ? * [ \ /`,
 * no leading `.`, and no `@{` (a `{` never directly follows an `@`). Copied from
 * `forge-contracts/contracts/forge-core.json`; `rc1-ref-names.test.ts` holds the strings equal.
 */
const COMPONENT = '(?:(?:@*[^\\x00- \\x7f~^:?*\\[\\\\/.@{]|\\{)+@*|@+)'
/** The separator between components: `/` or `./` (a component may end in `.`) or `.` (inside one). */
const REST = `(?:(?:\\.?/|\\.)${COMPONENT})*$`

/** forge-core `$defs.refName` (refUpdate / protectedRefUpdate `refName`, patch base/source refs). */
export const RC1_REF_NAME_PATTERN = `^refs/${COMPONENT}${REST}`
/**
 * forge-core `$defs.branch` (`repo.defaultBranch`, `config.defaultBranch`): a short name, no
 * leading `-`, and not `@` alone (git's `HEAD` shorthand).
 */
export const RC1_BRANCH_PATTERN =
  '^(?:@+[^\\x00- \\x7f~^:?*\\[\\\\/.@{]|\\{|[^\\x00- \\x7f~^:?*\\[\\\\/.@{\\-])(?:@*[^\\x00- \\x7f~^:?*\\[\\\\/.@{]|\\{)*@*' + REST
/** forge-core `release.tagName` (a leading `-` is allowed: a private repo's keyed-hash tag starts with one). */
export const RC1_TAG_PATTERN = `^${COMPONENT}${REST}`

// `u`: match code points, as the contract's Rust regex matches scalar values.
const REF_NAME_RE = new RegExp(RC1_REF_NAME_PATTERN, 'u')
const BRANCH_RE = new RegExp(RC1_BRANCH_PATTERN, 'u')
const TAG_RE = new RegExp(RC1_TAG_PATTERN, 'u')
// With `u`, a surrogate code unit only matches when it is unpaired: not encodable as UTF-8.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

/** `minLength`/`maxLength` (code points) and `maxBytes` (UTF-8), then the pattern. */
function fitsString(s: string, min: number, max: number, re: RegExp): boolean {
  const chars = [...s].length
  if (chars < min || chars > max || LONE_SURROGATE.test(s)) return false
  return new TextEncoder().encode(s).length <= max && re.test(s)
}

/**
 * Whether consensus accepts `name` as an RC1 `refUpdate` / `protectedRefUpdate` `refName`:
 * `$defs.refName` (6–255 characters and bytes, the pattern) plus the `noLock` rule (not ending
 * in `.lock`). Every write pre-checks with it so nothing is signed that consensus refuses.
 *
 * Two parts of `git check-ref-format` stay reader rules ({@link isCheckRefFormat}): a `.lock`
 * component that is not the last one (`refs/heads/x.lock/y` is accepted on chain; the Rust regex
 * has no lookaround), and the one-level and `@`-alone forms the `refs/` anchor makes moot.
 * {@link isLegalRefName} stays the fold's and the ref advertisement's (much weaker) guard.
 */
export function isRc1RefName(name: string): boolean {
  return fitsString(name, 6, 255, REF_NAME_RE) && !name.endsWith('.lock')
}

/** Whether consensus accepts `name` as a `defaultBranch` (`$defs.branch`: 1–255 characters and bytes). */
export function isRc1BranchName(name: string): boolean {
  return fitsString(name, 1, 255, BRANCH_RE)
}

/** Whether consensus accepts `name` as a `release.tagName` (1–63 characters and bytes, the pattern). */
export function isRc1TagName(name: string): boolean {
  return fitsString(name, 1, 63, TAG_RE)
}

/** The oid widths RC1 accepts (`oidWidth`): SHA-1 or SHA-256, in bytes. */
export const OID_WIDTHS: readonly number[] = [20, 32]

/**
 * Whether `hex` is an oid of an RC1 width (40 or 64 hex digits), as `refUpdate.newOid`,
 * `patch.headOid` and `review.commitOid` must be. An optional oid (`prevOid`,
 * `transition.oid`, `comment.commitOid`) is simply left out when absent.
 */
export function isRc1OidHex(hex: string): boolean {
  return /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(hex)
}

/**
 * `git check-ref-format` for a full ref name (the rules of `refs.c` `check_refname_format`,
 * without `--allow-onelevel` or `--refspec-pattern`): at least two `/`-separated components;
 * no component empty, starting with `.`, or ending with `.lock`; no `..`, no `@{`; not `@`
 * alone; no control bytes, space, DEL, or any of `~ ^ : ? * [ \`; no trailing `/` or `.`.
 */
export function isCheckRefFormat(name: string): boolean {
  if (name === '@' || name.endsWith('/') || name.endsWith('.') || name.includes('..') || name.includes('@{')) return false
  const bytes = new TextEncoder().encode(name)
  for (const b of bytes) {
    if (b < 0x20 || b === 0x7f || b === 0x20) return false
    if (b === 0x7e || b === 0x5e || b === 0x3a || b === 0x3f || b === 0x2a || b === 0x5b || b === 0x5c) return false
  }
  const parts = name.split('/')
  if (parts.length < 2) return false
  return parts.every((p) => p.length > 0 && !p.startsWith('.') && !p.endsWith('.lock'))
}

/**
 * A plain branch a merge may move: `refs/heads/<name>` that {@link isCheckRefFormat} accepts,
 * with no refspec or glob syntax (`+`). Parity: `dg` `require_branch_ref`.
 */
export function isPlainBranchRef(name: string): boolean {
  return name.startsWith('refs/heads/') && name.length > 'refs/heads/'.length && !name.includes('+') && isCheckRefFormat(name)
}

/** A full 40-hex lowercase git object id. */
export function isOidHex(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s)
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
