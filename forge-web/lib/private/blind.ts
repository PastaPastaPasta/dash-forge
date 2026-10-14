/**
 * Blinded OIDs (`docs/security/private-repos.md` §19.1, mixed-visibility DESIGN D4, rule C).
 *
 * A members-only ref update, a members-only pull request and its head updates carry their commit
 * ids in plaintext fields the contracts index and fold (`newOid`, `prevOid`, `headOid`, the
 * kind-16 event's `oid`), so those fields hold a **blind** instead, a salted commitment
 *
 *     blind(salt, oid) = SHA-256("dash-forge/v2/oid-blind" ‖ 0x00 ‖ salt(32) ‖ oid)[0 .. len(oid)]
 *
 * with a fresh 32-byte salt sealed inside the introducing document's `enc` (TLV 27) beside the
 * real value (TLV 22, 23 or 24). Rule C: a blind is computed once, by the document that
 * introduces the commit; every later field naming that commit copies those bytes.
 *
 * A null OID is never blinded: an all-zero `newOid` (a delete) stays all-zero and an absent
 * `prevOid` (a create) stays absent. Readers check every blind against its real value
 * ({@link check}): a mismatch, or a blind whose width is not the real OID's, keeps the document
 * and raises an {@link Alert}. The Rust twin is `forge-core::private::blind`; the `oid_blind`
 * vectors hold the two byte for byte (`members-git.conformance.test.ts`).
 */

import { bytesToHex, concat, constantTimeEqual, randomBytes, sha256, utf8, type Bytes } from './bytes'

const DOMAIN = concat(utf8('dash-forge/v2/oid-blind'), new Uint8Array([0]))

/** The length of a blind's salt (TLV 27). */
export const SALT_LEN = 32

/** A fresh salt from the platform CSPRNG. */
export function freshSalt(): Bytes {
  return randomBytes(SALT_LEN)
}

/** Whether `len` is a git OID width (SHA-1 or SHA-256). */
export function isOidWidth(len: number): boolean {
  return len === 20 || len === 32
}

/** Whether `oid` is the null OID: empty, or all zero bytes. */
export function isNull(oid: Uint8Array): boolean {
  return oid.every((b) => b === 0)
}

/**
 * The blind of the real `oid` (20 or 32 bytes) under `salt` (32 bytes). `null` for any other OID
 * width; a salt of another length is a caller error (`RangeError`).
 */
export async function blind(salt: Uint8Array, oid: Uint8Array): Promise<Bytes | null> {
  if (salt.length !== SALT_LEN) throw new RangeError('a blind salt is 32 bytes')
  if (!isOidWidth(oid.length)) return null
  return (await sha256(concat(DOMAIN, salt, oid))).slice(0, oid.length)
}

/** The plaintext a writer puts in an OID field for the real `oid`: the null OID as it is, else its blind. */
export async function plaintextOf(salt: Uint8Array, oid: Uint8Array): Promise<Bytes | null> {
  return isNull(oid) ? new Uint8Array(oid) : blind(salt, oid)
}

/**
 * How one plaintext OID field reads against the real value and salt sealed beside it:
 * `ok` the blind of the real value; `null` a null OID with no real value; `mismatch` / `width`
 * not the blind (or not the real value's width): alert, keep the document; `malformed` a blind
 * without its real value or salt, or a real value for a null OID.
 */
export type CheckStatus = 'ok' | 'null' | 'mismatch' | 'width' | 'malformed'

/** Judge the plaintext OID `plain` against the `real` value and `salt` sealed beside it. */
export async function check(plain: Uint8Array, real?: Uint8Array, salt?: Uint8Array): Promise<CheckStatus> {
  if (isNull(plain)) return real === undefined ? 'null' : 'malformed'
  if (real === undefined || salt === undefined || salt.length !== SALT_LEN) return 'malformed'
  if (real.length !== plain.length) return 'width'
  const b = await blind(salt, real)
  if (b === null) return 'malformed'
  return constantTimeEqual(b, plain) ? 'ok' : 'mismatch'
}

/** Which plaintext field an {@link Alert} is about (`headOid`: a PR's head or a head update's `oid`). */
export type OidField = 'newOid' | 'prevOid' | 'headOid'

/** A blind that does not match the real value sealed beside it: the document is kept and the alert shown. */
export interface Alert {
  readonly field: OidField
  readonly kind: 'mismatch' | 'width'
}

/** The alert {@link check}'s result raises, if any. */
export function alertOf(field: OidField, c: CheckStatus): Alert | null {
  return c === 'mismatch' || c === 'width' ? { field, kind: c } : null
}

/**
 * What the plaintext head of a members-only PR (`headOid`) or head update (`oid`) reads as, given
 * the real head and salt its `enc` carries (TLV 24, 27): `plain` nothing sealed (a PR from a
 * public branch); `real` the verified real head and its salt; `alert` a blind that does not check
 * (everyone folds the plaintext as written, and no real value is trusted for it).
 */
export type Head =
  | { readonly kind: 'plain' }
  | { readonly kind: 'real'; readonly real: Uint8Array; readonly salt: Uint8Array }
  | { readonly kind: 'alert'; readonly alert: Alert }

/** Judge a plaintext head against the real head and salt opened beside it. `null` is malformed. */
export async function headOf(plain: Uint8Array, real?: Uint8Array, salt?: Uint8Array): Promise<Head | null> {
  if (real === undefined) return { kind: 'plain' }
  const c = await check(plain, real, salt)
  if (c === 'ok' && salt !== undefined) return { kind: 'real', real, salt }
  const alert = alertOf('headOid', c)
  return alert === null ? null : { kind: 'alert', alert }
}

/**
 * A members reader's map from a blind (lowercase hex, as the folds compare OIDs) to the real
 * commit it hides. Only verified pairs go in: a blind whose check failed has no trusted real
 * value, and the fold keeps folding the blind as written. Members never put a real value into a
 * folded field (a PR's head, review and check-run lookups); the real value is for git.
 */
export class BlindMap {
  private readonly real = new Map<string, string>()

  /**
   * Learn the pair (`plain`, `real`) when `plain` checks as the blind of `real` under `salt`;
   * otherwise return the alert it raises (`null` when nothing was blinded or it was learned).
   */
  async learn(field: OidField, plain: Uint8Array, real?: Uint8Array, salt?: Uint8Array): Promise<Alert | null> {
    const c = await check(plain, real, salt)
    if (c === 'ok' && real !== undefined) this.real.set(bytesToHex(plain), bytesToHex(real))
    return alertOf(field, c)
  }

  /** The real commit (hex) behind the blind `plainHex`, if a verified document named it. */
  realOf(plainHex: string): string | undefined {
    return this.real.get(plainHex.toLowerCase())
  }

  /** The real commit behind `oidHex`, or `oidHex` itself when it is no known blind (a public source's plain OID). */
  realOrPlain(oidHex: string): string {
    return this.realOf(oidHex) ?? oidHex
  }

  /** How many blinds are known. */
  get size(): number {
    return this.real.size
  }
}
