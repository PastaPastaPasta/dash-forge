/**
 * The `read` key letter (kind 10, `type` "read", v 1; mixed-visibility DESIGN §4.9 "Key letters",
 * `docs/security/private-repos.md` §22.3): one pull request, issue or branch as it was when a
 * member asked a bot to work on it, for that one job. The Rust twin is
 * `crates/forge-core/src/private/key_letter/read.rs`; the `key_letter__read_*` vectors hold the two
 * byte for byte (`key-letter.conformance.test.ts`).
 *
 * ```text
 * {"asOf":ms,"checkNameKey":hex32|null,"docs":[[id,revision,kObj],…],"heads":[[blind,oid,salt],…],
 *  "job":hex32,"packs":[[packHash,key],…],"target":{"pr":n}|{"issue":n}|{"branch":hex32},
 *  "type":"read","v":1}
 * ```
 *
 * - `job` is the request's `event` id (kind 27, `lib/rules/agent-request.ts`): a letter counts for
 *   that request only.
 * - `docs` are the members-only revisions of the thread the asker opened when asking (the thread
 *   itself, its comments and reviews, the request event), each with its per-object key `K_obj`
 *   (`./doc` {@link readObjKey}): a key opens that one revision and nothing else. Sorted by
 *   (id, revision), each once.
 * - `packs` are members-only packs with their file keys, sorted by `packHash`, each once; `heads`
 *   the members-only commits the letter covers (the head first); `checkNameKey` the check-name key
 *   of the first head's salt, or null with no head. The web writes neither (code sharing needs a
 *   clone: `dg bot ask`).
 */

import { blind as blindOf, isNull, isOidWidth } from './blind'
import { bytesToHex, constantTimeEqual, type Bytes } from './bytes'
import { compareBytes } from './ids'
import { checkNameKey, hexExact, type JsonValue, type TypedLetter } from './key-letter'

/** `"type": "read"`. */
export const TYPE_READ = 'read'

/** What a `read` letter covers: a pull request or an issue by number, or a members-only branch by its `refNameHash`. */
export type ReadTarget = { readonly pr: number } | { readonly issue: number } | { readonly branch: Uint8Array }

/** One members-only document revision a `read` letter opens. */
export interface LetterDoc {
  /** The document `$id` (32 bytes). */
  readonly id: Uint8Array
  /** Its `$revision` when the letter was written. */
  readonly revision: number
  /** That revision's per-object key `K_obj`. */
  readonly key: Uint8Array
}

/** A members-only pack and its file key. */
export interface LetterPack {
  readonly packHash: Uint8Array
  readonly key: Uint8Array
}

/** A members-only commit: its blind, the real commit and the salt. */
export interface LetterHead {
  readonly blind: Uint8Array
  readonly oid: Uint8Array
  readonly salt: Uint8Array
}

/** A `read` letter (version 1): see the module documentation. */
export interface ReadLetter {
  /** The request event's id (32 bytes). */
  readonly job: Uint8Array
  /** When the letter was written (ms). */
  readonly asOf: number
  readonly target: ReadTarget
  /** Sorted by (id, revision), each once. */
  readonly docs: readonly LetterDoc[]
  /** Sorted by `packHash`, each once. */
  readonly packs: readonly LetterPack[]
  /** The head first. */
  readonly heads: readonly LetterHead[]
}

/** The fields of a `read` letter v 1, sorted. */
const FIELDS = ['asOf', 'checkNameKey', 'docs', 'heads', 'job', 'packs', 'target']

const U32_MAX = 0xffff_ffff

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** The order of `docs`: by id, then revision. */
export function compareDocs(a: LetterDoc, b: LetterDoc): number {
  return compareBytes(a.id, b.id) || a.revision - b.revision
}

async function headChecks(h: LetterHead): Promise<boolean> {
  if (!isOidWidth(h.oid.length) || isNull(h.oid) || h.salt.length !== 32) return false
  const expected = await blindOf(h.salt, h.oid)
  return expected !== null && constantTimeEqual(expected, h.blind)
}

/** What a writer never makes: unsorted or repeated docs or packs, a revision 0, a target 0, a head whose blind does not check. */
async function wellFormed(r: ReadLetter): Promise<boolean> {
  const docs =
    r.docs.every((d) => d.id.length === 32 && d.key.length === 32 && isCount(d.revision) && d.revision >= 1) &&
    r.docs.every((d, i) => i === 0 || compareDocs(r.docs[i - 1] as LetterDoc, d) < 0)
  const packs = r.packs.every((p, i) => i === 0 || compareBytes((r.packs[i - 1] as LetterPack).packHash, p.packHash) < 0)
  const n = 'branch' in r.target ? null : 'pr' in r.target ? r.target.pr : r.target.issue
  const target = n === null ? 'branch' in r.target && r.target.branch.length === 32 : isCount(n) && n >= 1 && n <= U32_MAX
  if (!docs || !packs || !target || r.job.length !== 32 || !isCount(r.asOf)) return false
  for (const h of r.heads) if (!(await headChecks(h))) return false
  return true
}

function targetJson(t: ReadTarget): JsonValue {
  if ('branch' in t) return { branch: bytesToHex(t.branch) }
  return 'pr' in t ? { pr: t.pr } : { issue: t.issue }
}

function targetOf(v: JsonValue | undefined): ReadTarget | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const keys = Object.keys(v)
  if (keys.length !== 1) return null
  const k = keys[0] as string
  const n = (v as { readonly [k: string]: JsonValue })[k]
  const number = isCount(n) && n >= 1 && n <= U32_MAX ? n : null
  switch (k) {
    case 'pr':
      return number === null ? null : { pr: number }
    case 'issue':
      return number === null ? null : { issue: number }
    case 'branch': {
      const h = hexExact(n, 32)
      return h === null ? null : { branch: h }
    }
    default:
      return null
  }
}

/** The check-name key of the first head's salt, or null with no head. */
async function checkNameKeyOf(r: ReadLetter): Promise<Bytes | null> {
  const first = r.heads[0]
  return first === undefined ? null : checkNameKey(first.salt)
}

/** The key of document revision (`id`, `revision`), if the letter opens it. */
export function readLetterDocKey(r: ReadLetter, id: Uint8Array, revision: number): Uint8Array | null {
  return r.docs.find((d) => d.revision === revision && compareBytes(d.id, id) === 0)?.key ?? null
}

/** The typed letter of `r`, or `null` for what a writer never makes (forge-core `ReadLetter::to_typed`). */
export async function readLetterToTyped(r: ReadLetter): Promise<TypedLetter | null> {
  if (!(await wellFormed(r))) return null
  const cnk = await checkNameKeyOf(r)
  return {
    type: TYPE_READ,
    v: 1,
    fields: {
      asOf: r.asOf,
      checkNameKey: cnk === null ? null : bytesToHex(cnk),
      docs: r.docs.map((d) => [bytesToHex(d.id), d.revision, bytesToHex(d.key)]),
      heads: r.heads.map((h) => [bytesToHex(h.blind), bytesToHex(h.oid), bytesToHex(h.salt)]),
      job: bytesToHex(r.job),
      packs: r.packs.map((p) => [bytesToHex(p.packHash), bytesToHex(p.key)]),
      target: targetJson(r.target),
    },
  }
}

/**
 * The `read` letter of version 1 in `t`, or `null`: another type or version, an unknown or missing
 * field, or anything {@link readLetterToTyped} refuses (a `checkNameKey` that is not the first
 * head's, a target with another key or a number 0). forge-core `ReadLetter::from_typed`.
 */
export async function readLetterFromTyped(t: TypedLetter): Promise<ReadLetter | null> {
  const f = t.fields
  const keys = Object.keys(f).sort()
  if (t.type !== TYPE_READ || t.v !== 1 || keys.length !== FIELDS.length || !keys.every((k, i) => k === FIELDS[i])) return null
  if (!Array.isArray(f.docs) || !Array.isArray(f.packs) || !Array.isArray(f.heads)) return null
  const docs: LetterDoc[] = []
  for (const d of f.docs as readonly JsonValue[]) {
    if (!Array.isArray(d) || d.length !== 3) return null
    const id = hexExact(d[0], 32)
    const key = hexExact(d[2], 32)
    const revision = d[1]
    if (id === null || key === null || !isCount(revision)) return null
    docs.push({ id, revision, key })
  }
  const packs: LetterPack[] = []
  for (const p of f.packs as readonly JsonValue[]) {
    if (!Array.isArray(p) || p.length !== 2) return null
    const packHash = hexExact(p[0], 32)
    const key = hexExact(p[1], 32)
    if (packHash === null || key === null) return null
    packs.push({ packHash, key })
  }
  const heads: LetterHead[] = []
  for (const h of f.heads as readonly JsonValue[]) {
    if (!Array.isArray(h) || h.length !== 3 || typeof h[1] !== 'string') return null
    const oid = hexExact(h[1], Math.floor((h[1] as string).length / 2))
    const blind = oid === null ? null : hexExact(h[0], oid.length)
    const salt = hexExact(h[2], 32)
    if (oid === null || blind === null || salt === null) return null
    heads.push({ blind, oid, salt })
  }
  const job = hexExact(f.job, 32)
  const target = targetOf(f.target)
  if (job === null || target === null || !isCount(f.asOf)) return null
  const letter: ReadLetter = { job, asOf: f.asOf, target, docs, packs, heads }
  const cnk = await checkNameKeyOf(letter)
  const keyOk = cnk === null ? f.checkNameKey === null : constantTimeEqual(hexExact(f.checkNameKey, 32) ?? new Uint8Array(0), cnk)
  return keyOk && (await wellFormed(letter)) ? letter : null
}
