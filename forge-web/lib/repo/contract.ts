/**
 * Repo-contract shape constants + on-chain-document → FORGE_RULES conversions.
 *
 * The document type names and field names are forge-v2's (`docs/contracts/forge-v2.md` §2,
 * `forge-contracts/contracts/forge-core.json` / `forge-collab.json`). Platform stores
 * oids/hashes as byteArray (returned base64 in wasm queries); the rules layer works in hex,
 * so conversions normalize base64 → hex here.
 */

import type { ForgeIds } from '../deployments'
import type { PrivateSession } from './private-session'
import type { Event, EventKind, RefUpdate } from '../rules'
import { contentWellFormed, docVisibility, gitPlaneWellFormed, type ContentDoc, type ContentKind, type Visibility } from '../rules/v2'
import type { RerunEvent } from '../rules/ci-rerun'
import { base58Decode, base58Encode } from '../auth/base58'
import { base64ToBytes, base64ToHex, type PlainDocument } from '../sdk'

/**
 * The forge-core, forge-collab and forge-community document type names (`forge-v2.md` §2).
 * Which contract holds each is `source.ts` {@link contractOf} (the RC1 layout).
 */
export const DOC = {
  repo: 'repo',
  maintainer: 'maintainer',
  writer: 'writer',
  consent: 'consent',
  config: 'config',
  repoKey: 'repoKey',
  refUpdate: 'refUpdate',
  protectedRefUpdate: 'protectedRefUpdate',
  packManifest: 'packManifest',
  chunk: 'chunk',
  issue: 'issue',
  patch: 'patch',
  comment: 'comment',
  event: 'event',
  authorEvent: 'authorEvent',
  transition: 'transition',
  review: 'review',
  label: 'label',
  release: 'release',
  checkRun: 'checkRun',
  policy: 'policy',
  webhook: 'webhook',
  star: 'star',
  follow: 'follow',
  starBeat: 'starBeat',
  watch: 'watch',
  milestone: 'milestone',
  profile: 'profile',
  runner: 'runner',
  topic: 'topic',
} as const

export { withVis } from '../layout'

/** `event.kind` integer → FORGE_RULES {@link EventKind} (`forge-v2.md` §3). */
export const EVENT_KIND_BY_INT: Readonly<Record<number, EventKind>> = {
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
  11: 'threadResolve',
  12: 'threadUnresolve',
  13: 'reviewRequest',
  14: 'reviewRequestRemove',
  15: 'reviewDismiss',
  16: 'headUpdate',
  17: 'milestoneSet',
  18: 'milestoneClear',
  19: 'pin',
  20: 'unpin',
  21: 'lock',
  22: 'unlock',
  23: 'policyBypass',
  24: 'hide',
  25: 'unhide',
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
  /**
   * A private repo read by a member: the reader's decryption session. Every read of this
   * `RepoRef` then decrypts through it (`private-session.ts`); without it a private repo's
   * content is hidden. Never set on a public repo.
   */
  readonly session?: PrivateSession
  /**
   * A public repo with members-only content, read by a member who holds its members key: the
   * reader's members-key session. Only the content gate reads it (`gateFor`: members-only issues,
   * comments, reviews and event values open through it). It is NOT a private session: the public
   * config, refs, packs and browse plane never look at it (they read `session` only), so a member
   * sees the repo's settings and branches exactly as everyone does (DESIGN §4.1). Never set on a
   * private repo.
   */
  readonly lane?: PrivateSession
  /**
   * A repository made public (`private-repos.md` §18) whose owner published keys of its earlier
   * history: the session holding only those keys, which every reader holds alike. Its browse plane
   * opens the artifacts stored while the repo was private with them (a member's own keys never
   * stand in: nothing this opens is anyone's secret). Never set on a private repo.
   */
  readonly published?: PrivateSession
}

/** `repo` as everyone reads it: without a reader's sessions or published keys. */
export function withoutSessions(repo: RepoRef): RepoRef {
  const { session: _s, lane: _l, published: _p, ...plain } = repo
  void _s
  void _l
  void _p
  return plain
}

/** The contracts a repo's reads touch, for the SDK's contract preload (none for `null`). */
export function repoContractIds(repo: RepoRef | null): string[] {
  return repo === null ? [] : [...new Set([repo.forge.core, repo.forge.collab, repo.forge.community])]
}

/**
 * The stable identity of a repo within a network — its `repoId`, plus the decryption session
 * of a private repo read by a member, or the published keys of a repository made public. Session
 * caches (browse context, content checks, fallback clones) key by it, so decrypted state never
 * outlives its session.
 */
export function repoKey(repo: RepoRef): string {
  const session = repo.session ?? repo.published
  return session === undefined ? repo.repoId : `${repo.repoId}#${session.id}`
}

/**
 * The identity of a repo's **discussion** reads (issues, PRs, comments, reviews): {@link repoKey}
 * plus the members-key session of a public repo read by a member. Caches and page reads of
 * content key by it, so a member's decrypted members-only content never outlives the session
 * that opened it, and a page re-reads once the session is ready. The git plane keeps
 * {@link repoKey}: a members-key session changes nothing there.
 */
export function contentKey(repo: RepoRef): string {
  return repo.lane === undefined ? repoKey(repo) : `${repoKey(repo)}#${repo.lane.id}`
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

/** A raw document's content fields as the well-formedness rules read them. */
export function contentDocOf(kind: ContentKind, doc: PlainDocument): ContentDoc {
  const text = (field: string): string | null => (typeof doc[field] === 'string' ? str(doc, field) : null)
  const hex = (field: string): string | null => byteFieldToHex(doc, field) || null
  return {
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
  }
}

/**
 * Whether a raw **content** document (issue, patch, comment, review; a private repo's ref
 * updates) is well-formed for its repo (`contentWellFormed`, `forge-v2.md` §5: plaintext xor
 * `enc`; a public repo also admits members-only and specific-people `enc`). The document's own
 * `vis` decides, when it carries one: a repository made public keeps its earlier documents
 * private (`private-repos.md` §18.1). Every reader skips a malformed document before any other
 * rule sees it.
 */
export function wellFormed(repo: RepoRef, kind: ContentKind, doc: PlainDocument): boolean {
  return contentWellFormed(contentDocOf(kind, doc), docVisibility(doc['vis'], repo.visibility))
}

/**
 * Whether a raw public **git-plane** document (a settings `config`, a ref update) is well-formed:
 * plaintext only (`gitPlaneWellFormed`). The members-key anchor, a sealed `config` of a public
 * repo, is never a settings row (DESIGN D1).
 */
export function gitPlaneDocWellFormed(kind: ContentKind, doc: PlainDocument): boolean {
  return gitPlaneWellFormed(contentDocOf(kind, doc))
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
  const refId = asIdentifierString(doc['refId'])
  return {
    id: str(doc, '$id'),
    // An identifier-typed byteArray: base58 from 4.2's toJSON, base64 from others. The repo
    // feed groups events by it, so it must match the target's base58 `$id` either way.
    targetId: asIdentifierString(doc['targetId']),
    kind,
    actor: str(doc, '$ownerId'),
    value: typeof value === 'string' ? value : null,
    oid: oidHex.length > 0 ? oidHex : null,
    ...(refId !== '' ? { refId } : {}),
    createdAt: num(doc, '$createdAt'),
  }
}

/**
 * An `event` document as the CI re-run rule reads it (`rules/ci-rerun.ts`; parity: forge-core
 * `rerun_event_of`). `sealed`: the document carried `enc` before it was opened.
 */
export function toRerunEvent(doc: PlainDocument, sealed = false): RerunEvent {
  const oid = byteFieldToHex(doc, 'oid')
  const refId = asIdentifierString(doc['refId'])
  const value = doc['value']
  return {
    id: str(doc, '$id'),
    repoId: asIdentifierString(doc['repoId']),
    targetId: asIdentifierString(doc['targetId']),
    targetNumber: num(doc, 'targetNumber'),
    kind: num(doc, 'kind'),
    refId: refId === '' ? null : refId,
    oid: oid === '' ? null : oid,
    value: typeof value === 'string' ? value : null,
    valueHidden: sealed && typeof value !== 'string',
    actor: str(doc, '$ownerId'),
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
