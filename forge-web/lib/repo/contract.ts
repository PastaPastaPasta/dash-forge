/**
 * Repo-contract shape constants + on-chain-document → FORGE_RULES conversions.
 *
 * The document type names and field names mirror the repo-v1 template (data-contracts
 * §2.2/§2.3). Platform stores oids/hashes as byteArray (returned base64 in wasm queries);
 * the rules layer works in hex, so conversions normalize base64 → hex here.
 */

import type { Event, EventKind, RefUpdate, TokenKind } from '../rules'
import { base58Decode, base58Encode } from '../auth/base58'
import { base64ToBytes, base64ToHex, type PlainDocument } from '../sdk'

/** Repo-contract document type names (data-contracts §2.2). */
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

/** A repo reference: which contract, on which network. */
export interface RepoRef {
  readonly contractId: string
  readonly ownerId: string
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
function byteFieldToHex(doc: PlainDocument, field: string): string {
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
