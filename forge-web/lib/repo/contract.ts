/**
 * Repo-contract shape constants + on-chain-document → FORGE_RULES conversions.
 *
 * The document type names and field names are forge-v2's (`docs/contracts/forge-v2.md` §2,
 * `forge-contracts/contracts/forge-core.json` / `forge-collab.json`). Platform stores
 * oids/hashes as byteArray (returned base64 in wasm queries); the rules layer works in hex,
 * so conversions normalize base64 → hex here.
 */

import type { ForgeIds } from '../deployments'
import type { Event, EventKind, RefUpdate } from '../rules'
import { isWellFormed, type ContentKind, type Visibility } from '../rules/v2'
import { base58Decode, base58Encode } from '../auth/base58'
import { base64ToBytes, base64ToHex, type PlainDocument } from '../sdk'

/** The forge-core and forge-collab document type names (`forge-v2.md` §2). */
export const DOC = {
  repo: 'repo',
  maintainer: 'maintainer',
  writer: 'writer',
  config: 'config',
  refUpdate: 'refUpdate',
  protectedRefUpdate: 'protectedRefUpdate',
  packManifest: 'packManifest',
  manifestPart: 'manifestPart',
  chunk: 'chunk',
  issue: 'issue',
  patch: 'patch',
  comment: 'comment',
  event: 'event',
  authorEvent: 'authorEvent',
  review: 'review',
  label: 'label',
  release: 'release',
  checkRun: 'checkRun',
  webhook: 'webhook',
  star: 'star',
  follow: 'follow',
} as const

/** `event.kind` integer → FORGE_RULES {@link EventKind} (`forge-v2.md` §3). */
const EVENT_KIND_BY_INT: Readonly<Record<number, EventKind>> = {
  1: 'close',
  2: 'reopen',
  3: 'merge',
  4: 'labelAdd',
  5: 'labelRemove',
  6: 'assign',
  7: 'unassign',
  8: 'retarget',
  9: 'draft',
  10: 'ready',
}

/**
 * A repo reference: a `repo` document in the network's shared forge-core contract, with
 * everything else keyed by its id (`forge-v2.md` §2).
 */
export interface RepoRef {
  readonly forge: ForgeIds
  /** The `repo` document id (base58). */
  readonly repoId: string
  readonly ownerId: string
  readonly name: string
  readonly visibility: Visibility
}

/** The contracts a repo's reads touch, for the SDK's contract preload (none for `null`). */
export function repoContractIds(repo: RepoRef | null): string[] {
  return repo === null ? [] : [repo.forge.core, repo.forge.collab]
}

/**
 * The stable identity of a repo within a network — its `repoId`. Session caches (browse
 * context, content checks, fallback clones) key by it.
 */
export function repoKey(repo: RepoRef): string {
  return repo.repoId
}

/** A string field, or `''` when absent or not a string. */
export function str(doc: PlainDocument, field: string): string {
  const v = doc[field]
  return typeof v === 'string' ? v : ''
}

/** A numeric field, or 0. Content integers (e.g. `kind`, `number`) return as bigint. */
export function num(doc: PlainDocument, field: string): number {
  const v = doc[field]
  if (typeof v === 'bigint') return Number(v)
  return typeof v === 'number' ? v : 0
}

/** A native string-array field (forge-v2 typed arrays), or null when absent or not an array. */
export function stringArray(doc: PlainDocument, field: string): string[] | null {
  const v = doc[field]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
}

/** A byteArray field returns base64; normalize to hex (empty string when absent/null). */
export function byteFieldToHex(doc: PlainDocument, field: string): string {
  const v = doc[field]
  if (typeof v === 'string' && v.length > 0) {
    try {
      return base64ToHex(v)
    } catch {
      return v
    }
  }
  if (v instanceof Uint8Array) {
    return Array.from(v)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  return ''
}

/**
 * Whether a raw document is well-formed for its repo (`isWellFormed`, `forge-v2.md` §5:
 * plaintext xor `enc`, the visibility says which, and a patch's or ref update's names hash
 * to their indexed keys). Every reader skips a malformed document before any other rule sees
 * it.
 */
export function wellFormed(repo: RepoRef, kind: ContentKind, doc: PlainDocument): boolean {
  const text = (field: string): string | null => (typeof doc[field] === 'string' ? str(doc, field) : null)
  const hex = (field: string): string | null => byteFieldToHex(doc, field) || null
  return isWellFormed(
    {
      kind,
      title: text('title'),
      body: text('body'),
      refName: text('refName'),
      baseRefName: text('baseRefName'),
      sourceRefName: text('sourceRefName'),
      refNameHash: hex('refNameHash'),
      baseRefNameHash: hex('baseRefNameHash'),
      sourceRefNameHash: hex('sourceRefNameHash'),
      defaultBranch: text('defaultBranch'),
      protectedPatterns: stringArray(doc, 'protectedPatterns'),
      path: text('path'),
      enc: hex('enc'),
      epoch: doc['epoch'] == null ? null : num(doc, 'epoch'),
    },
    repo.visibility,
  )
}

/**
 * Convert a `refUpdate` / `protectedRefUpdate` document to a {@link RefUpdate} rules input.
 * `isProtectedType` reflects which document type it came from (the MAINTAIN-gated one).
 */
export function toRefUpdate(doc: PlainDocument, isProtectedType: boolean): RefUpdate {
  return {
    id: str(doc, '$id'),
    refNameHash: byteFieldToHex(doc, 'refNameHash'),
    refName: str(doc, 'refName'),
    prevOid: byteFieldToHex(doc, 'prevOid'),
    newOid: byteFieldToHex(doc, 'newOid'),
    force: doc['force'] === true,
    protected: isProtectedType,
    author: str(doc, '$ownerId'),
    createdAt: num(doc, '$createdAt'),
  }
}

/** Convert an `event` document to a FORGE_RULES {@link Event} (or null if kind is unknown). */
export function toEvent(doc: PlainDocument): Event | null {
  const kindInt = num(doc, 'kind')
  const kind = EVENT_KIND_BY_INT[kindInt]
  if (kind === undefined) return null
  const oidHex = byteFieldToHex(doc, 'oid')
  const value = doc['value']
  return {
    id: str(doc, '$id'),
    // An identifier-typed byteArray: base58 from 4.2's toJSON, base64 from others. The repo
    // feed groups events by it, so it must match the target's base58 `$id` either way.
    targetId: asIdentifierString(doc['targetId']),
    kind,
    actor: str(doc, '$ownerId'),
    value: typeof value === 'string' ? value : null,
    oid: oidHex.length > 0 ? oidHex : null,
    createdAt: num(doc, '$createdAt'),
  }
}

/**
 * Normalize a document field that holds a 32-byte identifier (e.g. a membership's
 * `memberId`) to its **base58** string — the form Platform contract/document APIs
 * require. A CONTENT identifier stored as a `byteArray` comes back from the SDK's `toJSON`
 * as **base64**, and feeding that straight to `contracts.fetch()` / a query's
 * `dataContractId` throws "Invalid data contract ID: … invalid character … at byte 9" (a
 * browser-only failure the Playwright suite caught). Accepts an already-base58 id unchanged;
 * re-encodes a base64 32-byte value to base58; otherwise returns the raw string.
 */
export function asIdentifierString(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) return ''
  try {
    if (base58Decode(v).length === 32) return v
  } catch {
    /* not base58 — try base64 below */
  }
  try {
    const bytes = base64ToBytes(v)
    if (bytes.length === 32) return base58Encode(bytes)
  } catch {
    /* not base64 either */
  }
  return v
}
