/**
 * Key letters (kind 10; mixed-visibility DESIGN §4.3 "Branch keys for CI and people", §4.9 "Key
 * letters", `docs/security/private-repos.md` §20): keys handed to specific people, sealed to them
 * as a DFPK 0x02 artifact ({@link sealLetterArtifact}) and stored as a kind-10 `packManifest`. The
 * Rust twin is `crates/forge-core/src/private/key_letter/mod.rs`; the `key_letter__*` vectors hold
 * the two byte for byte (`key-letter.conformance.test.ts`).
 *
 * The plaintext is a typed JSON object in an environment snapshot's canonical form: keys sorted by
 * code point, no whitespace, JSON.stringify's string escapes (which are exactly the Rust twin's),
 * integers 0..2^53 - 1, true, false and null; padded with spaces to a multiple of 512 bytes. A
 * reader takes only those exact bytes. `type` and `v` are always there; each type has its own
 * reader and writer, and a reader skips a type or version it does not know.
 *
 * The `branch` type (v 1) shares one members-only branch as it is now:
 *
 * ```text
 * {"asOf":ms,"checkNameKey":hex32,"head":[blind,oid,salt],"name":"refs/heads/…",
 *  "packs":[[packHash,key],…],"refNameHash":hex32,"type":"branch","v":1}
 * ```
 */

import { isGitRefName } from '../rules/oid'
import { blind as blindOf, isNull, isOidWidth } from './blind'
import { bytes, bytesToHex, constantTimeEqual, sha256, utf8, type Bytes } from './bytes'
import { compareBytes } from './ids'
import { ArtifactError, openLetterArtifact, sealLetterArtifact, type LetterReader, type LetterRecipient, type OwnerKey } from './named'

/** The plaintext is padded with spaces to a multiple of this many bytes. */
export const LETTER_BUCKET = 512
/** The largest letter plaintext, padded. */
export const MAX_KEY_LETTER = 64 * 1024
/** `packManifest.kind` of a key letter. */
export const KIND_KEY_LETTER = 10
/** The deepest nesting of arrays and objects a letter has (the top-level object is depth 1). */
export const MAX_KEY_LETTER_DEPTH = 16

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [k: string]: JsonValue }

/** A key letter's typed body: `type`, `v` and every other field. */
export interface TypedLetter {
  readonly type: string
  readonly v: number
  readonly fields: { readonly [k: string]: JsonValue }
}

export class KeyLetterError extends Error {
  constructor(readonly code: 'tooLarge' | 'invalid') {
    super(code === 'tooLarge' ? `a key letter holds at most ${MAX_KEY_LETTER} bytes` : 'a key letter value has no canonical form')
    this.name = 'KeyLetterError'
  }
}

/** No lone surrogate (the canonical bytes are UTF-8; Rust and Python cannot hold one). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

/** Code point order (UTF-8 byte order), as the Rust twin sorts. */
function byCodePoint(a: string, b: string): number {
  return compareBytes(utf8(a), utf8(b))
}

function depth(v: unknown): number {
  if (typeof v !== 'object' || v === null) return 0
  const items: unknown[] = Array.isArray(v) ? v : Object.values(v)
  return 1 + items.reduce<number>((d, x) => Math.max(d, depth(x)), 0)
}

function canonical(v: JsonValue): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) throw new KeyLetterError('invalid')
    return String(v)
  }
  if (typeof v === 'string') {
    if (!wellFormed(v)) throw new KeyLetterError('invalid')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const obj = v as { readonly [k: string]: JsonValue }
  const keys = Object.keys(obj).sort(byCodePoint)
  return `{${keys.map((k) => `${canonical(k)}:${canonical(obj[k] as JsonValue)}`).join(',')}}`
}

/** The padded plaintext of `letter`. Throws {@link KeyLetterError}. */
export function encodeKeyLetter(letter: TypedLetter): Bytes {
  if ('type' in letter.fields || 'v' in letter.fields) throw new KeyLetterError('invalid')
  if (depth(letter.fields) > MAX_KEY_LETTER_DEPTH) throw new KeyLetterError('invalid')
  const raw = utf8(canonical({ ...letter.fields, type: letter.type, v: letter.v }))
  const size = Math.max(LETTER_BUCKET, Math.ceil(raw.length / LETTER_BUCKET) * LETTER_BUCKET)
  if (size > MAX_KEY_LETTER) throw new KeyLetterError('tooLarge')
  const out = new Uint8Array(size).fill(0x20)
  out.set(raw)
  return out
}

/** The typed letter of an exactly canonical plaintext, or `null` (malformed). */
export function decodeKeyLetter(pt: Uint8Array): TypedLetter | null {
  if (pt.length === 0 || pt.length > MAX_KEY_LETTER || pt.length % LETTER_BUCKET !== 0) return null
  let end = pt.length
  while (end > 0 && pt[end - 1] === 0x20) end--
  let obj: unknown
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pt.subarray(0, end)))
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj) || depth(obj) > MAX_KEY_LETTER_DEPTH) return null
  const { type, v, ...fields } = obj as Record<string, JsonValue>
  if (typeof type !== 'string' || typeof v !== 'number') return null
  const letter: TypedLetter = { type, v, fields }
  try {
    return constantTimeEqual(encodeKeyLetter(letter), pt) ? letter : null
  } catch {
    return null
  }
}

/** Seal `letter` for `recipients` (the sender first, at most 64) as a DFPK 0x02 artifact. */
export async function sealKeyLetter(
  repoId: Uint8Array,
  senderSecret: Uint8Array,
  senderKeyId: number,
  ownerId: Uint8Array,
  recipients: readonly LetterRecipient[],
  letter: TypedLetter,
): Promise<Bytes> {
  const plain = encodeKeyLetter(letter)
  try {
    return await sealLetterArtifact(repoId, senderSecret, senderKeyId, ownerId, recipients, plain)
  } finally {
    plain.fill(0)
  }
}

export type KeyLetterOpenError = 'packHashMismatch' | 'sizeMismatch' | 'sealedPackCorrupt' | 'malformed' | 'notARecipient'

export type KeyLetterOpenResult = { readonly letter: TypedLetter; readonly recipients: number } | { readonly error: KeyLetterOpenError }

/**
 * Open one copy of a kind-10 artifact for its manifest: the bytes must hash to the owner-signed
 * `packHash` first, then match `sizeBytes`, then open with the manifest owner's keys, then decode.
 */
export async function openKeyLetter(
  repoId: Uint8Array,
  manifest: { readonly packHash: Uint8Array; readonly sizeBytes: number },
  sealed: Uint8Array,
  ownerKeys: readonly OwnerKey[],
  reader: LetterReader,
): Promise<KeyLetterOpenResult> {
  if (!constantTimeEqual(await sha256(sealed), manifest.packHash)) return { error: 'packHashMismatch' }
  let plain: Bytes
  try {
    plain = await openLetterArtifact(repoId, sealed, manifest.sizeBytes, ownerKeys, reader)
  } catch (e) {
    if (e instanceof ArtifactError) return { error: e.code }
    throw e
  }
  try {
    const letter = decodeKeyLetter(plain)
    return letter === null ? { error: 'malformed' } : { letter, recipients: sealed[8] as number }
  } finally {
    plain.fill(0)
  }
}

// --- the branch type ------------------------------------------------------------------------------

const CHECK_NAME_LABEL = utf8('dash-forge/v2/check-name')
const BRANCH_FIELDS = ['asOf', 'checkNameKey', 'head', 'name', 'packs', 'refNameHash']

/** `HMAC-SHA256(salt, "dash-forge/v2/check-name")`: names a members-only commit's check runs. */
export async function checkNameKey(salt: Uint8Array): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', bytes(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, CHECK_NAME_LABEL))
}

/** A `branch` letter (v 1): one members-only branch as it was when shared. */
export interface BranchLetter {
  readonly name: string
  readonly refNameHash: Uint8Array
  readonly head: {
    readonly blind: Uint8Array
    readonly oid: Uint8Array
    readonly salt: Uint8Array
  }
  /** Sorted by `packHash`, each once, at least one. */
  readonly packs: readonly {
    readonly packHash: Uint8Array
    readonly key: Uint8Array
  }[]
  /** `$createdAt` (ms) of the ref update that set the head. */
  readonly asOf: number
}

const LOWER_HEX = /^(?:[0-9a-f]{2})*$/

function hexExact(v: JsonValue | undefined, n: number): Bytes | null {
  if (typeof v !== 'string' || v.length !== 2 * n || !LOWER_HEX.test(v)) return null
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = parseInt(v.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** A ref git could create (forge-core `is_git_ref_name`) under `refs/heads/`, not `refs/heads/HEAD`, no control character. */
function validBranchName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return isGitRefName(name) && name.startsWith('refs/heads/') && name !== 'refs/heads/HEAD' && !/[\u0000-\u001f\u007f-\u009f]/.test(name)
}

async function branchWellFormed(b: BranchLetter): Promise<boolean> {
  const { oid, salt } = b.head
  if (!isOidWidth(oid.length) || isNull(oid) || salt.length !== 32) return false
  const expected = await blindOf(salt, oid)
  const sorted = b.packs.length > 0 && b.packs.every((p, i) => i === 0 || compareBytes(b.packs[i - 1]!.packHash, p.packHash) < 0)
  return (
    expected !== null && constantTimeEqual(expected, b.head.blind) && sorted && validBranchName(b.name) && Number.isSafeInteger(b.asOf) && b.asOf >= 0
  )
}

/** The typed letter of `b`, or `null` when it is not well formed. */
export async function branchLetterToTyped(b: BranchLetter): Promise<TypedLetter | null> {
  if (!(await branchWellFormed(b))) return null
  return {
    type: 'branch',
    v: 1,
    fields: {
      asOf: b.asOf,
      checkNameKey: bytesToHex(await checkNameKey(b.head.salt)),
      head: [bytesToHex(b.head.blind), bytesToHex(b.head.oid), bytesToHex(b.head.salt)],
      name: b.name,
      packs: b.packs.map((p) => [bytesToHex(p.packHash), bytesToHex(p.key)]),
      refNameHash: bytesToHex(b.refNameHash),
    },
  }
}

/** The `branch` letter (v 1) of `t`, or `null`: another type or version, or anything malformed. */
export async function branchLetterFromTyped(t: TypedLetter): Promise<BranchLetter | null> {
  const f = t.fields
  const keys = Object.keys(f).sort()
  if (t.type !== 'branch' || t.v !== 1 || keys.length !== BRANCH_FIELDS.length || !keys.every((k, i) => k === BRANCH_FIELDS[i])) return null
  const head = f.head
  if (!Array.isArray(head) || head.length !== 3 || typeof head[1] !== 'string') return null
  const oid = hexExact(head[1], Math.floor((head[1] as string).length / 2))
  const blind = oid === null ? null : hexExact(head[0], oid.length)
  const salt = hexExact(head[2], 32)
  if (!Array.isArray(f.packs)) return null
  const packs: { packHash: Uint8Array; key: Uint8Array }[] = []
  for (const p of f.packs as readonly JsonValue[]) {
    if (!Array.isArray(p) || p.length !== 2) return null
    const packHash = hexExact(p[0], 32)
    const key = hexExact(p[1], 32)
    if (packHash === null || key === null) return null
    packs.push({ packHash, key })
  }
  const refNameHash = hexExact(f.refNameHash, 32)
  const cnk = hexExact(f.checkNameKey, 32)
  if (oid === null || blind === null || salt === null || refNameHash === null || cnk === null) return null
  if (typeof f.asOf !== 'number' || typeof f.name !== 'string') return null
  const b: BranchLetter = {
    name: f.name,
    refNameHash,
    head: { blind, oid, salt },
    packs,
    asOf: f.asOf,
  }
  if (!(await branchWellFormed(b)) || !constantTimeEqual(cnk, await checkNameKey(salt))) return null
  return b
}
