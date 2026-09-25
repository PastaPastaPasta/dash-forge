/**
 * Repo-contract shape constants + on-chain-document → FORGE_RULES conversions.
 *
 * The document type names and field names mirror the repo-v1 template (data-contracts
 * §2.2/§2.3), which forge-v2 kept (`docs/contracts/forge-v2.md` §2). Platform stores
 * oids/hashes as byteArray (returned base64 in wasm queries); the rules layer works in hex,
 * so conversions normalize base64 → hex here.
 */

import type { ForgeIds } from '../deployments'
import type { Event, EventKind, RefUpdate, TokenKind } from '../rules'
import { isWellFormed, type ContentKind, type Visibility } from '../rules/v2'
import { base58Decode, base58Encode } from '../auth/base58'
import { base64ToBytes, base64ToHex, type PlainDocument } from '../sdk'

/** Repo-contract document type names (data-contracts §2.2; forge-v2 keeps them). */
export const DOC = {
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
  review: 'review',
  label: 'label',
  release: 'release',
  checkRun: 'checkRun',
  webhook: 'webhook',
} as const

/** The forge-v2-only document types (`forge-v2.md` §2). */
export const V2_DOC = {
  repo: 'repo',
  maintainer: 'maintainer',
  writer: 'writer',
  authorEvent: 'authorEvent',
  star: 'star',
  follow: 'follow',
  profile: 'profile',
} as const

/** Registry-contract document type names (data-contracts §1). */
export const REGISTRY_DOC = {
  repoListing: 'repoListing',
  profile: 'profile',
  star: 'star',
  follow: 'follow',
} as const

/** Repo token positions (§2.1). Position 0 = WRITE, 1 = MAINTAIN. */
export const TOKEN_POSITION: Record<TokenKind, number> = { write: 0, maintain: 1 }

/** `event.kind` integer → FORGE_RULES {@link EventKind} (data-contracts §2.3). */
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
 * A v1 repository: its own repo contract (template `repo-v1.json`, token ACL). Readable on
 * the networks that have them (testnet); the web app's v1 writes are unchanged.
 */
export interface V1RepoRef {
  readonly kind: 'v1'
  readonly contractId: string
  readonly ownerId: string
  /** The listing's name (`''` when the repo was addressed by contract id alone). */
  readonly name: string
}

/**
 * A forge-v2 repository: a `repo` document in the network's shared forge-core contract,
 * with everything else keyed by its id (`forge-v2.md` §2).
 */
export interface V2RepoRef {
  readonly kind: 'v2'
  readonly forge: ForgeIds
  /** The `repo` document id (base58). */
  readonly repoId: string
  readonly ownerId: string
  readonly name: string
  readonly visibility: Visibility
}

/** A repo reference: a v1 repo contract, or a forge-v2 `repo` document. */
export type RepoRef = V1RepoRef | V2RepoRef

/** The contracts a repo's reads touch, for the SDK's contract preload (none for `null`). */
export function repoContractIds(repo: RepoRef | null): string[] {
  if (repo === null) return []
  return repo.kind === 'v1' ? [repo.contractId] : [repo.forge.core, repo.forge.collab]
}

/**
 * The stable identity of a repo within a network — the v1 contract id or the v2 `repoId`.
 * Session caches (browse context, content checks, fallback clones) key by it.
 */
export function repoKey(repo: RepoRef): string {
  return repo.kind === 'v1' ? repo.contractId : repo.repoId
}

function str(doc: PlainDocument, field: string): string {
  const v = doc[field]
  return typeof v === 'string' ? v : ''
}

function num(doc: PlainDocument, field: string): number {
  const v = doc[field]
  // Content integer fields (e.g. event `kind`) return as bigint; system fields are normalized.
  if (typeof v === 'bigint') return Number(v)
  return typeof v === 'number' ? v : 0
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
 * plaintext xor `enc`, the visibility says which). v1 has no such rule, so every v1 document
 * passes. Every forge-v2 reader skips a malformed document before any other rule sees it.
 */
export function wellFormed(repo: RepoRef, kind: ContentKind, doc: PlainDocument): boolean {
  if (repo.kind === 'v1') return true
  const text = (field: string): string | null => {
    const v = doc[field]
    return typeof v === 'string' ? v : null
  }
  const patterns = doc['protectedPatterns']
  const epoch = doc['epoch']
  return isWellFormed(
    {
      kind,
      title: text('title'),
      body: text('body'),
      refName: text('refName'),
      baseRefName: text('baseRefName'),
      sourceRefName: text('sourceRefName'),
      defaultBranch: text('defaultBranch'),
      protectedPatterns: Array.isArray(patterns)
        ? patterns.filter((x): x is string => typeof x === 'string')
        : null,
      enc: byteFieldToHex(doc, 'enc') || null,
      epoch: typeof epoch === 'number' ? epoch : typeof epoch === 'bigint' ? Number(epoch) : null,
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
    targetId: str(doc, 'targetId'),
    kind,
    actor: str(doc, '$ownerId'),
    value: typeof value === 'string' ? value : null,
    oid: oidHex.length > 0 ? oidHex : null,
    createdAt: num(doc, '$createdAt'),
  }
}

/**
 * Normalize a document field that holds a 32-byte identifier (e.g. a repo listing's
 * `repoContractId`) to its **base58** string — the form Platform contract/document APIs
 * require. A CONTENT identifier stored as a `byteArray` comes back from the SDK's `toJSON`
 * as **base64**, and feeding that straight to `contracts.fetch()` / a query's
 * `dataContractId` throws "Invalid data contract ID: … invalid character … at byte 9" (a
 * browser-only failure the Playwright suite caught — `resolveRepo` fetched the repo contract
 * with a base64 id and every downstream read died). Accepts an already-base58 id unchanged;
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

/** Parse a JSON-in-string list field (data-contracts §0: no native arrays on v12). */
export function parseJsonList(doc: PlainDocument, field: string): string[] {
  const v = doc[field]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string' && v.length > 0) {
    try {
      const parsed: unknown = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      return []
    }
  }
  return []
}
