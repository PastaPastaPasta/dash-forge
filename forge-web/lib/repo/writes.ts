/**
 * Write paths — the browser signing surface for forge-v2 repos.
 *
 * Every write builds a document whose on-chain encoding matches forge-core byte for byte
 * (identifier fields as raw 32-byte values, `refNameHash = sha256(refName)`, event `kind`
 * integers), signs it through the {@link createDocumentIdempotent} WriteEngine, and returns
 * the estimate shown before signing plus the balance change it caused.
 *
 * `docs/contracts/forge-v2.md`: a repo is three documents in forge-core (`repo`,
 * the owner's `maintainer`, the first `config`), created resumably; members are `maintainer` /
 * `writer` documents the owner creates and deletes; issues, comments, reviews, `event`
 * (members) and `authorEvent` (the author's close/reopen) live in forge-collab, and consensus
 * enforces every gate. `star` and `follow` are `indexOnly`: a delete carries the document's
 * values (the SDK's index-only delete). Issue numbers follow the `allocateNumber` rule (§6).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { hexToBytes } from '@noble/hashes/utils.js'

import type { Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { decodeIdentifier } from '../auth/base58'
import { idbDelete, idbEntries, idbGet, idbPut } from '../idb'
import { isLegalRefName, type EventKind } from '../rules'
import { allocateNumber, isAuthorKind, numberCeiling, normalizeRepoName as normalizeV2RepoName, type Role, type Visibility } from '../rules/v2'
import { fetchIdentityKeys, usableEncryptionKey, type EncryptionOps } from '../auth/encryption-key'
import {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  GATE_REFUSED_CODE,
  UnconfirmedWriteError,
  contentHash,
  countDocuments,
  createDocumentIdempotent,
  deleteDocumentIdempotent,
  previewCredits,
  queryDocumentsWithProof,
  type DeleteResult,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { DOC, num, str, type RepoRef } from './contract'
import { invalidateMembers } from './members'
import { refNameHash, repoContentWritten } from './push'
import type { PrivateDocType } from '../private'
import { isSealedKind, privateWriter, sealForRepo, sealedIntent, sealedTextUse, PrivateWriteError, type PrivateWriter } from './private-writes'
import { invalidateRepoFeed } from './issues'
import { noteTargetCreated } from './social'
import { repoSource } from './source'

// ---------------------------------------------------------------------------
// event kind name → integer (parity with forge-core `event_kind_to_u64`)
// ---------------------------------------------------------------------------

/** The event kinds a member `event` may carry. Kept for callers that name them. */
export type EventKindName = EventKind

/** `event.kind` integers (forge-v2.md §3), parity with forge-core `event_kind_to_u64`. */
export const EVENT_KIND_CODE: Readonly<Record<EventKind, number>> = {
  close: 1,
  reopen: 2,
  merge: 3,
  labelAdd: 4,
  labelRemove: 5,
  assign: 6,
  unassign: 7,
  retarget: 8,
  draft: 9,
  ready: 10,
  threadResolve: 11,
  threadUnresolve: 12,
  reviewRequest: 13,
  reviewRequestRemove: 14,
  reviewDismiss: 15,
  headUpdate: 16,
  milestoneSet: 17,
  milestoneClear: 18,
  pin: 19,
  unpin: 20,
  lock: 21,
  unlock: 22,
}

/** Review verdicts (`review.verdict`). */
export const VERDICT_INT = { approve: 1, requestChanges: 2, comment: 3 } as const
export type VerdictInput = keyof typeof VERDICT_INT

/** An issue or PR a write refers to: its document id and number. */
export interface WriteTarget {
  readonly id: string
  readonly number: number
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isDuplicate(e: unknown): boolean {
  return e instanceof ConsensusRefusal && e.code === DUPLICATE_UNIQUE_CODE
}

/** The contract (forge-core or forge-collab) a write of `documentType` targets. */
export function contractFor(repo: RepoRef, documentType: string): string {
  return repoSource(repo).repoQuery(documentType).dataContractId
}

/** `data` plus the `repoId` every repo-scoped type carries. */
function scoped(repo: RepoRef, data: Record<string, unknown>): Record<string, unknown> {
  return { repoId: decodeIdentifier(repo.repoId), ...data }
}

/** The document types whose writes can change an open issue or PR count. */
const COUNTED_TYPES: ReadonlySet<string> = new Set([DOC.issue, DOC.patch, DOC.event, DOC.authorEvent])

/**
 * Drop the caches a write of `documentType` to `repo` invalidates, so the next read shows it.
 * Only a write that can change an open count makes the repo header refold its counts; a
 * comment, review or release does not.
 */
function afterWrite(repo: RepoRef, network: Network, documentType: string): void {
  invalidateRepoFeed(repo, { counts: COUNTED_TYPES.has(documentType) })
  invalidateMembers(repo, network)
}

/**
 * The content fields each type encrypts in a private repo (`private-repos.md` §4.3). Written out
 * by hand on purpose, apart from the sealer's `SEALED_FIELDS`: the plaintext guard must not be
 * derived from the code it guards. What gets sealed is {@link sealedTypeOf}.
 */
const CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  issue: ['title', 'body'],
  patch: ['title', 'body', 'baseRefName', 'sourceRefName'],
  comment: ['body', 'path'],
  review: ['body'],
  refUpdate: ['refName'],
  protectedRefUpdate: ['refName'],
  config: ['defaultBranch', 'protectedPatterns'],
  event: ['value'],
}

/**
 * Refuse a write that would put a private repo's content in plaintext on chain (a sealed write
 * carries `enc` and no content field; an event without a value has nothing to seal). Every
 * private write goes through here.
 */
export function assertNoPlaintext(repo: RepoRef, documentType: string, data: Readonly<Record<string, unknown>>): void {
  if (repo.visibility !== 'private') return
  const fields = CONTENT_FIELDS[documentType] ?? []
  const leaked = fields.filter((f) => data[f] !== undefined && data[f] !== null && data[f] !== '')
  if (leaked.length > 0) {
    throw new Error(`refusing to write ${leaked.join(', ')} in plaintext to a private repo`)
  }
  if (fields.length > 0 && data['enc'] === undefined && documentType !== DOC.event) {
    throw new Error(`refusing to write an unencrypted ${documentType} to a private repo`)
  }
}

/**
 * The type a private repo's `documentType` write with `data` is sealed as, or null
 * (`docs/security/private-repos.md` §4): an `issue`, `patch`, `comment` or `review` always (in
 * plaintext it would publish its text and be malformed for members), an `event` when it carries
 * a `value`. Labels and releases are plaintext in this release.
 */
function sealedTypeOf(documentType: string, data: Readonly<Record<string, unknown>>): PrivateDocType | null {
  if (isSealedKind(documentType)) return documentType
  const value = data['value']
  return documentType === DOC.event && typeof value === 'string' && value !== '' ? 'event' : null
}

/**
 * Refuse a replace of sealed content in a private repo (a replace would publish plaintext next
 * to `enc`); private edits go through `sealEdit` (`private-writes.ts`), and {@link writeRepoDoc}
 * seals creates.
 */
export function refusePlaintextInPrivate(repo: RepoRef, documentType: string): void {
  if (repo.visibility === 'private' && isSealedKind(documentType)) {
    throw new Error(`this ${documentType} would be written in plaintext into a private repo; writing private content from here is not supported yet`)
  }
}

/**
 * Create one repo-scoped document: the right contract, `repoId` set, then drop the caches
 * the write invalidates. In a private repo an issue, PR, comment or review, or an event's
 * value, is sealed first ({@link sealedTypeOf}; `private-writes.ts`: into `enc` under the
 * current epoch), and nothing leaves here with plaintext content ({@link assertNoPlaintext}).
 */
export async function writeRepoDoc(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  documentType: string,
  data: Record<string, unknown>,
  intent?: string,
  /** A private repo's writer for this action (resolved here when not given; see `privateWriter`). */
  writer?: PrivateWriter,
): Promise<WriteResult> {
  // What the action says, before sealing: the retry cache compares this (sealed fields are
  // encrypted afresh on every attempt, so the sealed data never matches itself).
  let contentKey: string | undefined
  const sealedType = repo.visibility === 'private' ? sealedTypeOf(documentType, data) : null
  if (sealedType !== null) {
    contentKey = contentHash(documentType, scoped(repo, data))
    const w = writer ?? (await privateWriter(sdk, auth, repo))
    data = await sealForRepo(sdk, auth, repo, sealedType, data, w)
    intent = sealedIntent(intent, w.keys)
  }
  assertNoPlaintext(repo, documentType, data)
  try {
    return await createDocumentIdempotent(sdk, auth, {
      contractId: contractFor(repo, documentType),
      documentType,
      data: scoped(repo, data),
      ...(intent ? { intent } : {}),
      ...(contentKey ? { contentKey } : {}),
    })
  } finally {
    afterWrite(repo, auth.network, documentType)
  }
}

/** A write that found its unique slot already held by the signer: success, nothing spent. */
function alreadyThere(documentId: string | null): WriteResult {
  return { documentId: documentId ?? '', confirmed: true, cost: previewCredits(0), actualCredits: 0 }
}

/** A delete of something already gone. */
const ALREADY_GONE: DeleteResult = { deleted: true, actualCredits: 0 }

/** Run a create; a duplicate-unique refusal (the signer's own earlier write) is success. */
async function createOrExisting(create: () => Promise<WriteResult>, findExisting: () => Promise<string | null> = async () => null): Promise<WriteResult> {
  try {
    return await create()
  } catch (e) {
    if (!isDuplicate(e)) throw e
    return alreadyThere(await findExisting())
  }
}

/** The `$id` of the first row, or null. */
function firstId(documents: readonly Record<string, unknown>[]): string | null {
  const id = documents[0]?.['$id']
  return typeof id === 'string' ? id : null
}

// ---------------------------------------------------------------------------
// Issue numbering (forge-v2.md §6 `allocate_number`)
// ---------------------------------------------------------------------------

/** The `number` field of a result row, or null. */
function numberOf(doc: Record<string, unknown>): number | null {
  const n = num(doc, 'number')
  return n > 0 ? n : null
}

/**
 * The number the allocation rule gives the next issue (or PR) of a repo:
 * `n` = the provable count, `base` = the largest taken number at or below the ceiling, then
 * — only when `base` sits at the ceiling — the contiguous run of taken numbers above it,
 * paged to its end. Null when nothing is left to allocate.
 */
export async function nextNumber(sdk: EvoSDK, repo: RepoRef, type: 'issue' | 'patch'): Promise<number | null> {
  const source = repoSource(repo)
  const count = await countDocuments(sdk, source.repoQuery(DOC[type]))
  const ceiling = numberCeiling(count)
  const { documents } = await queryDocumentsWithProof(
    sdk,
    source.repoQuery(DOC[type], {
      where: [['number', '<=', ceiling]],
      orderBy: [['number', 'desc']],
      limit: 1,
    }),
  )
  const base = documents[0] ? numberOf(documents[0]) ?? 0 : 0
  const taken: number[] = base > 0 ? [base] : []
  if (base === ceiling) {
    // Squatters may sit right above the ceiling: walk the run to its first gap.
    let expect = base + 1
    let startAfter: string | undefined
    for (;;) {
      const page = await queryDocumentsWithProof(
        sdk,
        source.repoQuery(DOC[type], {
          where: [['number', '>', base]],
          orderBy: [['number', 'asc']],
          limit: 100,
          ...(startAfter ? { startAfter } : {}),
        }),
      )
      let gap = false
      for (const d of page.documents) {
        const n = numberOf(d)
        if (n !== expect) {
          gap = true
          break
        }
        taken.push(n)
        expect += 1
      }
      const last = page.documents[page.documents.length - 1]
      if (gap || page.documents.length < 100 || last === undefined) break
      startAfter = str(last, '$id')
    }
  }
  return allocateNumber(count, taken.sort((a, b) => b - a))
}

// ---------------------------------------------------------------------------
// Issues / comments / events / reviews
// ---------------------------------------------------------------------------

/** A created issue: the write result plus the allocated issue number. */
export interface CreateIssueResult extends WriteResult {
  readonly number: number
}

/**
 * Create an `issue` (ungated; anyone). The number comes from the repo's numbering rule; when
 * consensus refuses it as taken (someone claimed it between the read and the write), the
 * allocation runs again — the squatted number is now `base` — and `onRetry` is told, so the
 * UI can say "Someone claimed #42 a moment ago; retrying as #43" (`ux-dx-spec.md` §1d).
 */
export async function createIssue(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { title: string; body: string; intent?: string },
  onRetry?: (taken: number, next: number) => void,
): Promise<CreateIssueResult> {
  const data: Record<string, unknown> = { title: input.title }
  if (input.body.length > 0) data['body'] = input.body
  return createNumbered(sdk, auth, repo, 'issue', data, input.intent, onRetry)
}

/** A PR to open (forge-core `PatchInput`). */
export interface PatchInput {
  readonly title: string
  readonly body: string
  /** The branch to merge into, full name (`refs/heads/main`). */
  readonly baseRefName: string
  /** The repo holding the head (this repo, or a fork of it), base58. */
  readonly sourceRepoId: string
  /** The branch the head was pushed to in the source repo, full name. */
  readonly sourceRefName: string
  /** The head commit, hex. */
  readonly headOid: string
  /** Open as a draft (`patch.draft`, review-parity P6): not ready for review until marked so. */
  readonly draft?: boolean
}

/**
 * The `patch` document data (without `repoId` and `number`) forge-core `patch_props` writes:
 * `title`, `body` when non-empty, `baseRefNameHash = sha256(baseRefName)`, `baseRefName`,
 * `sourceRepoId`, `sourceRefNameHash = sha256(sourceRefName)`, `sourceRefName`, `headOid`.
 */
export function patchData(input: PatchInput): Record<string, unknown> {
  if (input.title.trim() === '') throw new Error('a title is required')
  for (const name of [input.baseRefName, input.sourceRefName]) {
    if (!isLegalRefName(name) || new TextEncoder().encode(name).length > 255) {
      throw new Error(`illegal ref name ${JSON.stringify(name)}`)
    }
  }
  const head = hexToBytes(input.headOid)
  if (head.length < 20 || head.length > 32) throw new Error('the PR head must be a 20-32 byte oid')
  const data: Record<string, unknown> = { title: input.title }
  if (input.body.length > 0) data['body'] = input.body
  data['baseRefNameHash'] = refNameHash(input.baseRefName)
  data['baseRefName'] = input.baseRefName
  data['sourceRepoId'] = decodeIdentifier(input.sourceRepoId)
  data['sourceRefNameHash'] = refNameHash(input.sourceRefName)
  data['sourceRefName'] = input.sourceRefName
  data['headOid'] = head
  if (input.draft === true) data['draft'] = true
  return data
}

/** Open a PR (`patch`, ungated), numbered like an issue (PRs number independently). */
export async function createPatch(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: PatchInput & { intent?: string },
  onRetry?: (taken: number, next: number) => void,
): Promise<CreateIssueResult> {
  return createNumbered(sdk, auth, repo, 'patch', patchData(input), input.intent, onRetry)
}

/** Create a numbered `issue` / `patch`, allocating again when the number is taken meanwhile. */
async function createNumbered(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  type: 'issue' | 'patch',
  fields: Record<string, unknown>,
  intentBase: string | undefined,
  onRetry?: (taken: number, next: number) => void,
): Promise<CreateIssueResult> {
  const noun = type === 'issue' ? 'issue' : 'PR'
  // A private repo: refuse over-long text before allocating, and seal every renumbered retry
  // under the one writer of this action (the AD binds each new number).
  let writer: PrivateWriter | undefined
  if (repo.visibility === 'private') {
    const { used, limit } = sealedTextUse(type, fields)
    if (limit !== null && used > limit) {
      throw new PrivateWriteError(`the text is too long for a private repo: an encrypted ${type} holds at most ${limit} bytes of text (this one has ${used})`)
    }
    writer = await privateWriter(sdk, auth, repo)
  }
  const next = (): Promise<number | null> => nextNumber(sdk, repo, type)
  // A retry of this action first finishes the number its last attempt signed: once that
  // attempt is visible, allocation would hand out the next number, a new cache key, and a
  // second issue (the pending write under the old number would never be looked at).
  const triedKey = intentBase ? `forge:numbered:${auth.network}:${repo.repoId}:${type}:${intentBase}` : null
  let number = readTriedNumber(triedKey) ?? (await next())
  for (let attempt = 0; attempt < 4; attempt++) {
    if (number === null) throw new Error(`this repo has no ${noun} numbers left to allocate`)
    try {
      // Each number is its own write: a renumbered retry must not reuse the earlier bytes.
      const intent = intentBase ? `${intentBase}#${number}` : undefined
      writeTriedNumber(triedKey, number)
      const result = await writeRepoDoc(sdk, auth, repo, DOC[type], { number, ...fields }, intent, writer)
      writeTriedNumber(triedKey, null)
      if (result.confirmed) noteTargetCreated(repo, type)
      return { ...result, number }
    } catch (e) {
      // Refused for good (not a duplicate, which is renumbered below): nothing under this
      // number is pending, so the action does not pin it any more. After a SupersededWriteError
      // the number stays pinned on purpose: its intent `base#N` holds the tombstone, so every
      // later retry of this action lands there and is answered the same way, never allocated a
      // fresh number and posted as a second document.
      if (e instanceof ConsensusRefusal && !isDuplicate(e)) writeTriedNumber(triedKey, null)
      if (e instanceof UnconfirmedWriteError) {
        // Not seen yet. If someone else holds the number, ours was refused: renumber.
        const holder = await numberHolder(sdk, repo, type, number).catch(() => undefined)
        if (holder === undefined || holder === null || holder === auth.identityId) throw e
      } else if (!isDuplicate(e)) throw e
      const taken: number = number
      number = await next()
      if (number !== null && number <= taken) number = taken + 1
      if (number !== null) onRetry?.(taken, number)
    }
  }
  throw new Error(`could not claim ${type === 'issue' ? 'an issue' : 'a PR'} number after several attempts; try again`)
}

/** How long a remembered number is kept: as long as the pending-write cache it points into. */
const TRIED_NUMBER_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The number the last attempt of a numbered action signed (null when none is pending). */
function readTriedNumber(key: string | null): number | null {
  if (key === null || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    const { n, at } = JSON.parse(raw) as { n?: unknown; at?: unknown }
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || typeof at !== 'number' || Date.now() - at > TRIED_NUMBER_MAX_AGE_MS) {
      window.localStorage.removeItem(key)
      return null
    }
    return n
  } catch {
    return null
  }
}

function writeTriedNumber(key: string | null, number: number | null): void {
  if (key === null || typeof window === 'undefined') return
  try {
    if (number === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify({ n: number, at: Date.now() }))
  } catch {
    // Best effort, like the pending-write cache it points into.
  }
}

/** Who holds issue / PR `number` (its `$ownerId`), or null when nobody does. */
async function numberHolder(sdk: EvoSDK, repo: RepoRef, type: 'issue' | 'patch', number: number): Promise<string | null> {
  const { documents } = await queryDocumentsWithProof(sdk, repoSource(repo).repoQuery(DOC[type], { where: [['number', '==', number]], limit: 1 }))
  const owner = documents[0]?.['$ownerId']
  return typeof owner === 'string' ? owner : null
}

/** Create a `comment` on an issue or PR (ungated; author-owned). */
export async function createComment(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { targetId: string; body: string; replyTo?: string; intent?: string },
): Promise<WriteResult> {
  const data: Record<string, unknown> = { targetId: decodeIdentifier(input.targetId), body: input.body }
  if (input.replyTo) data['replyTo'] = decodeIdentifier(input.replyTo)
  return writeRepoDoc(sdk, auth, repo, DOC.comment, data, input.intent)
}

/** The document data of a state event on `target`. */
function eventData(
  target: WriteTarget,
  kind: EventKindName,
  extra: { value?: string; oidHex?: string } = {},
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    targetId: decodeIdentifier(target.id),
    targetNumber: target.number,
    kind: EVENT_KIND_CODE[kind],
  }
  if (extra.value !== undefined && extra.value.length > 0) data['value'] = extra.value
  if (extra.oidHex !== undefined && extra.oidHex.length > 0) data['oid'] = hexToBytes(extra.oidHex)
  return data
}

/**
 * Append a member `event` (close / reopen / label / assign / merge mark, …). Consensus admits
 * it only from a current maintainer or writer (40120 otherwise).
 */
export async function addEvent(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; kind: EventKindName; value?: string; oidHex?: string; intent?: string },
): Promise<WriteResult> {
  return writeRepoDoc(sdk, auth, repo, DOC.event, eventData(input.target, input.kind, input), input.intent)
}

/**
 * The issue or PR author's own close / reopen: an `authorEvent`, gated to the target's author
 * (`forge-v2.md` §3).
 */
export async function addAuthorEvent(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; kind: 'close' | 'reopen'; intent?: string },
): Promise<WriteResult> {
  return writeRepoDoc(sdk, auth, repo, DOC.authorEvent, eventData(input.target, input.kind), input.intent)
}

/**
 * Which document an event of `kind` by the viewer must be: a member's `event` (every kind),
 * else the author's `authorEvent` for an author kind, else null (no gate admits it). Parity:
 * forge-core `kind_route`.
 */
export function eventRoute(params: {
  readonly viewer: string
  readonly author: string
  readonly isMember: boolean
  readonly kind: EventKind
}): 'event' | 'authorEvent' | null {
  // A member's event is cheaper and needs no authorship; the author path needs no membership.
  if (params.isMember) return 'event'
  return params.viewer === params.author && isAuthorKind(params.kind) ? 'authorEvent' : null
}

/** Which state-event type a close/reopen by the viewer should be. */
export function stateEventRoute(params: {
  readonly viewer: string
  readonly author: string
  readonly isMember: boolean
}): 'event' | 'authorEvent' | null {
  return eventRoute({ ...params, kind: 'close' })
}

/** Close or reopen an issue/PR by whichever route the viewer holds. */
export async function setTargetState(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; kind: 'close' | 'reopen'; author: string; isMember: boolean; intent?: string },
): Promise<WriteResult> {
  const route = stateEventRoute({ viewer: auth.identityId, author: input.author, isMember: input.isMember })
  if (route === null) throw new Error('only the author or a maintainer or writer can do that')
  if (route === 'authorEvent') return addAuthorEvent(sdk, auth, repo, input)
  try {
    return await addEvent(sdk, auth, repo, input)
  } catch (e) {
    // The membership read was stale (revoked meanwhile): the author path still holds.
    const gateRefused = e instanceof ConsensusRefusal && e.code === GATE_REFUSED_CODE
    if (gateRefused && auth.identityId === input.author) return addAuthorEvent(sdk, auth, repo, { ...input, intent: input.intent ? `${input.intent}:author` : undefined })
    throw e
  }
}

/** Submit a PR review: a verdict on `commitOid` (the head it was made against). */
export async function createReview(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { patchId: string; verdict: VerdictInput; commitOid: string; body?: string; intent?: string },
): Promise<WriteResult> {
  const data: Record<string, unknown> = {
    patchId: decodeIdentifier(input.patchId),
    verdict: VERDICT_INT[input.verdict],
    commitOid: hexToBytes(input.commitOid),
  }
  if (input.body && input.body.length > 0) data['body'] = input.body
  return writeRepoDoc(sdk, auth, repo, DOC.review, data, input.intent)
}

// ---------------------------------------------------------------------------
// Releases (maintainer-only)
// ---------------------------------------------------------------------------

/** A release asset (hash-verified download; stored as a JSON string). */
export interface ReleaseAsset {
  readonly name: string
  /** Hex SHA-256 of the file. */
  readonly sha256: string
  readonly sizeBytes: number
  /** Where it can be downloaded (≤ 4): public https first. The CLI's shape (`collab::ReleaseAsset`). */
  readonly uris: readonly string[]
}

/** The `assets` field's byte limit (the `release` schema's `maxBytes`). */
export const RELEASE_ASSETS_MAX_BYTES = 4096

/** Create a `release`: newest per tag wins. Maintainers only (consensus-gated). */
export async function createRelease(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { tagName: string; name?: string; notes?: string; yanked?: boolean; assets?: readonly ReleaseAsset[]; intent?: string },
): Promise<WriteResult> {
  const data: Record<string, unknown> = { tagName: input.tagName, yanked: input.yanked ?? false }
  if (input.name && input.name.length > 0) data['name'] = input.name
  if (input.notes && input.notes.length > 0) data['notes'] = input.notes
  if (input.assets && input.assets.length > 0) data['assets'] = releaseAssetsJson(input.assets)
  try {
    return await writeRepoDoc(sdk, auth, repo, DOC.release, data, input.intent)
  } finally {
    // A release names a tag just pushed, often from another client: browse it afresh.
    repoContentWritten(repo)
  }
}

/** The `assets` field for `assets`, refusing a list the document cannot hold (4096 bytes). */
export function releaseAssetsJson(assets: readonly ReleaseAsset[]): string {
  const json = JSON.stringify(assets)
  const bytes = new TextEncoder().encode(json).length
  if (bytes > RELEASE_ASSETS_MAX_BYTES) {
    throw new Error(`the asset list takes ${bytes} bytes and a release holds ${RELEASE_ASSETS_MAX_BYTES}: use fewer assets, or shorter names and URLs`)
  }
  return json
}

// ---------------------------------------------------------------------------
// Social: star / follow (indexOnly)
// ---------------------------------------------------------------------------

/** The indexOnly types a viewer writes one of per target: `repoId` for all but `follow`. */
type IndexOnlyType = 'star' | 'follow' | 'starBeat' | 'watch'

/** The property an indexOnly type's target is in. */
const targetField = (type: IndexOnlyType): 'repoId' | 'identityId' => (type === 'follow' ? 'identityId' : 'repoId')

interface RawDocumentsFacade {
  query(q: unknown): Promise<Map<string, unknown>>
}

/**
 * The viewer's own `star` / `follow` document for `targetId` as the wasm `Document` the query
 * returned — an index-only delete needs its values, not just an id. Null when there is none.
 * The `byOwner` index ends in the target, so `($ownerId, target)` selects at most one.
 */
async function findOwnIndexOnly(
  sdk: EvoSDK,
  forge: ForgeIds,
  type: IndexOnlyType,
  ownerId: string,
  targetId: string,
): Promise<unknown | null> {
  const field = targetField(type)
  const rows = await (sdk as unknown as { documents: RawDocumentsFacade }).documents.query({
    dataContractId: forge.collab,
    documentTypeName: type,
    where: [
      ['$ownerId', '==', ownerId],
      [field, '==', targetId],
    ],
    orderBy: [['$ownerId', 'asc']],
    limit: 1,
  })
  for (const doc of rows.values()) if (doc) return doc
  return null
}

/** Create the signer's `star` / `follow` (indexOnly). Idempotent: a duplicate is success. */
function createIndexOnly(sdk: EvoSDK, auth: WriteAuth, forge: ForgeIds, type: IndexOnlyType, targetId: string): Promise<WriteResult> {
  const field = targetField(type)
  return createOrExisting(() =>
    createDocumentIdempotent(sdk, auth, {
      contractId: forge.collab,
      documentType: type,
      data: { [field]: decodeIdentifier(targetId) },
      probe: async () => (await findOwnIndexOnly(sdk, forge, type, auth.identityId, targetId)) !== null,
    }),
  )
}

/** Delete the signer's `star` / `follow`: an index-only delete carrying its values. */
async function deleteIndexOnly(sdk: EvoSDK, auth: WriteAuth, forge: ForgeIds, type: IndexOnlyType, targetId: string): Promise<DeleteResult> {
  const own = await findOwnIndexOnly(sdk, forge, type, auth.identityId, targetId)
  if (own === null) return ALREADY_GONE
  return deleteDocumentIdempotent(sdk, auth, {
    contractId: forge.collab,
    documentType: type,
    documentId: targetId,
    repo: targetField(type) === 'repoId' ? targetId : null,
    document: own,
    probeGone: async () => (await findOwnIndexOnly(sdk, forge, type, auth.identityId, targetId)) === null,
  })
}

/** An on/off relation the viewer holds (a star, a follow), in the shape `useRelationToggle` drives. */
export interface Relation {
  read(): Promise<boolean>
  add(): Promise<boolean>
  remove(): Promise<boolean>
}

/**
 * Write the signer's `starBeat` for `repoId` (trending, platform-parity-spec §4.3) unless one
 * exists: one per identity and repo, ever.
 */
export async function writeStarBeat(sdk: EvoSDK, auth: WriteAuth, forge: ForgeIds, repoId: string): Promise<void> {
  if ((await findOwnIndexOnly(sdk, forge, 'starBeat', auth.identityId, repoId)) !== null) return
  await createIndexOnly(sdk, auth, forge, 'starBeat', repoId)
}

/**
 * The viewer's star on a repo (forge-collab `star`). With `trending` (the viewer's "Count my
 * stars toward Trending", on by default), a new star also writes its `starBeat`.
 */
export function starRelation(sdk: EvoSDK, auth: WriteAuth | null, viewer: string, repo: RepoRef, trending = false): Relation {
  return {
    read: async () => (await findOwnIndexOnly(sdk, repo.forge, 'star', viewer, repo.repoId)) !== null,
    add: async () => {
      const a = need(auth)
      const confirmed = (await createIndexOnly(sdk, a, repo.forge, 'star', repo.repoId)).confirmed
      if (confirmed && trending) {
        // Best effort: the star stands without its beat, which only feeds a ranking.
        // eslint-disable-next-line no-console
        await writeStarBeat(sdk, a, repo.forge, repo.repoId).catch((e: unknown) => console.warn('the star landed; its Trending beat did not', e))
      }
      return confirmed
    },
    remove: async () => (await deleteIndexOnly(sdk, need(auth), repo.forge, 'star', repo.repoId)).deleted,
  }
}

/**
 * The viewer's follow of `target` (forge-collab `follow`). `forge` null (not deployed): every
 * call refuses, so a caller can build the relation unconditionally and gate on deployment.
 */
export function followRelation(sdk: EvoSDK, auth: WriteAuth | null, viewer: string, forge: ForgeIds | null, target: string): Relation {
  const f = (): ForgeIds => {
    if (forge === null) throw new Error('Dash Forge is not deployed on this network')
    return forge
  }
  return {
    read: async () => (await findOwnIndexOnly(sdk, f(), 'follow', viewer, target)) !== null,
    add: async () => (await createIndexOnly(sdk, need(auth), f(), 'follow', target)).confirmed,
    remove: async () => (await deleteIndexOnly(sdk, need(auth), f(), 'follow', target)).deleted,
  }
}

function need(auth: WriteAuth | null): WriteAuth {
  if (auth === null) throw new Error('sign in first')
  return auth
}

// ---------------------------------------------------------------------------
// Membership (owner-only)
// ---------------------------------------------------------------------------

const ROLE_DOC: Readonly<Record<Role, string>> = { maintainer: DOC.maintainer, writer: DOC.writer }

/** The membership document `(repoId, memberId)` of `role`, or null. */
async function findMembership(sdk: EvoSDK, repo: RepoRef, role: Role, memberId: string): Promise<string | null> {
  const { documents } = await queryDocumentsWithProof(
    sdk,
    repoSource(repo).repoQuery(ROLE_DOC[role], { where: [['memberId', '==', memberId]], limit: 1 }),
  )
  return firstId(documents)
}

/**
 * A private repo's membership changes only through `lib/repo/private-members.ts`
 * (`addPrivateMember` / `removePrivateMember`): an add must hand out the key and a removal must
 * re-anchor and rotate (`private-repos.md` §5.3, §5.5). The plain writers refuse it.
 */
export class PrivateMembershipError extends Error {
  constructor(action: 'add' | 'remove') {
    super(
      `members of a private repo can only be ${action === 'add' ? 'added' : 'removed'} through the private-repo flow (it ${action === 'add' ? 'hands them the key' : 'rotates the key'}); add your encryption key to this browser to manage members`,
    )
    this.name = 'PrivateMembershipError'
  }
}

/**
 * Grant `memberId` a role on a public repo: the owner creates a `maintainer` or `writer`
 * document (consensus refuses anyone else). Idempotent: an existing membership is success.
 * Refused on a private repo ({@link PrivateMembershipError}).
 */
export async function grantMember(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  memberId: string,
  role: Role,
  intent?: string,
): Promise<WriteResult> {
  if (repo.visibility === 'private') throw new PrivateMembershipError('add')
  return grantMembershipDoc(sdk, auth, repo, memberId, role, intent)
}

/**
 * The membership document write alone, for any repo. Only `private-members.ts` calls it for a
 * private repo, inside the add flow (after its checks, before the key wrap).
 */
export async function grantMembershipDoc(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  memberId: string,
  role: Role,
  intent?: string,
): Promise<WriteResult> {
  if (auth.identityId !== repo.ownerId) throw new Error('only the repo owner can add members')
  const result = await createOrExisting(
    () =>
      createDocumentIdempotent(sdk, auth, {
        contractId: repo.forge.core,
        documentType: ROLE_DOC[role],
        data: { repoId: decodeIdentifier(repo.repoId), memberId: decodeIdentifier(memberId) },
        ...(intent ? { intent } : {}),
      }),
    () => findMembership(sdk, repo, role, memberId),
  )
  invalidateMembers(repo, auth.network)
  // Membership decides which rows a private repo shows (a stranger's ciphertext is hidden).
  invalidateRepoFeed(repo)
  return result
}

/**
 * Revoke a role on a public repo: the owner deletes the membership document. No-op when there
 * is none. Refused on a private repo ({@link PrivateMembershipError}).
 */
export async function revokeMember(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  memberId: string,
  role: Role,
): Promise<DeleteResult> {
  if (repo.visibility === 'private') throw new PrivateMembershipError('remove')
  return revokeMembershipDoc(sdk, auth, repo, memberId, role)
}

/**
 * The membership document delete alone, for any repo. Only `private-members.ts` calls it for a
 * private repo, inside the removal flow (after the re-anchors, before the rotation).
 */
export async function revokeMembershipDoc(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  memberId: string,
  role: Role,
): Promise<DeleteResult> {
  if (auth.identityId !== repo.ownerId) throw new Error('only the repo owner can remove members')
  const existing = await findMembership(sdk, repo, role, memberId)
  if (existing === null) return ALREADY_GONE
  const result = await deleteDocumentIdempotent(sdk, auth, {
    contractId: repo.forge.core,
    documentType: ROLE_DOC[role],
    documentId: existing,
    repo: repo.repoId,
  })
  invalidateMembers(repo, auth.network)
  // Membership decides which rows a private repo shows (a stranger's ciphertext is hidden).
  invalidateRepoFeed(repo)
  return result
}

// ---------------------------------------------------------------------------
// forge-v2 repo creation (three documents, resumable)
// ---------------------------------------------------------------------------

/** Options for {@link createRepo}. */
export interface CreateRepoInput {
  readonly name: string
  readonly description?: string
  readonly defaultBranch?: string
  /** The parent repo's id (`repo.forkOf`, immutable) when this is a fork. */
  readonly forkOf?: string
  /** Set at creation only (immutable). A private repo needs the owner's encryption key. */
  readonly visibility?: Visibility
}

/** The steps of a repo creation, in order. */
export type CreateRepoStep = 'repo' | 'maintainer' | 'config'

/**
 * What a private create (`private-repos.md` §5.3) needs to write its epoch 0: the vault's
 * encryption operations, and the writer of the key and anchor (`private-members.ts`
 * `createEpochZero`, passed in so this module stays below the key-rotation code).
 */
export interface PrivateCreate {
  readonly ops: EncryptionOps
  readonly epochZero: (c: { sdk: EvoSDK; auth: WriteAuth; repo: RepoRef; network: Network; ops: EncryptionOps }, defaultBranch: string, intent: string) => Promise<boolean>
}

/** A repo creation's journal entry (IndexedDB), kept until all three documents exist. */
export interface RepoCreationJournal {
  readonly network: Network
  readonly ownerId: string
  readonly input: CreateRepoInput
  readonly repoId: string | null
  readonly done: readonly CreateRepoStep[]
  readonly startedAt: number
}

/** A created (or completed) repo. What each step cost reaches the ledger through `onSpend`. */
export interface CreateRepoResult {
  readonly repoId: string
  readonly name: string
}

/** The byte limits the `repo` schema sets (maxBytes counts UTF-8 bytes, not characters). */
export const REPO_LIMITS = { description: 1000, defaultBranch: 255 } as const

/** Refuse input the contract would refuse, with a readable reason, before anything is signed. */
export function checkRepoInput(input: CreateRepoInput): void {
  const bytes = (s: string | undefined): number => (s ? new TextEncoder().encode(s).length : 0)
  if (bytes(input.description) > REPO_LIMITS.description) {
    throw new Error(`The description is ${bytes(input.description)} bytes; the limit is ${REPO_LIMITS.description} (accented letters and emoji take more than one byte).`)
  }
  if (bytes(input.defaultBranch) > REPO_LIMITS.defaultBranch) throw new Error('The default branch name is too long.')
  if (input.visibility === 'private' && input.forkOf !== undefined) throw new Error('a fork is public: a private repository cannot be a fork')
}

function journalKey(network: Network, ownerId: string, name: string): string {
  return `create-repo:${network}:${ownerId}:${name}`
}

/** Unfinished repo creations of `ownerId` (a tab closed mid-way), oldest first. */
export async function pendingRepoCreations(network: Network, ownerId: string): Promise<RepoCreationJournal[]> {
  const rows = await idbEntries<RepoCreationJournal>('journal', `create-repo:${network}:${ownerId}:`)
  return rows.map(([, v]) => v).sort((a, b) => a.startedAt - b.startedAt)
}

/** Forget an unfinished creation (the user abandoned it). */
export function discardRepoCreation(network: Network, ownerId: string, name: string): Promise<void> {
  return idbDelete('journal', journalKey(network, ownerId, name))
}

/** A valid forge-v2 repo name for `input` (ASCII lowercased), or an error saying why not. */
export function normalizeRepoName(input: string): string {
  const name = normalizeV2RepoName(input.trim())
  if (name === null) {
    throw new Error(`invalid repo name '${input}': use a-z, 0-9, '.', '_' and '-' (max 63), starting with a letter or digit`)
  }
  return name
}

/**
 * Create a forge-v2 repository: its `repo` document, the owner's `maintainer` document (the
 * owner self-enrols, `forge-v2.md` §6, or nobody could push) and its first `config`. Each step
 * checks the chain first, so a rerun after an interruption completes what is missing instead
 * of failing on the unique `($ownerId, name)` index; the IndexedDB journal lets the UI offer
 * that rerun. `onStep` reports progress.
 */
export async function createRepo(
  sdk: EvoSDK,
  auth: WriteAuth,
  forge: ForgeIds,
  input: CreateRepoInput,
  onStep?: (step: CreateRepoStep, state: 'start' | 'done') => void,
  /** Required for a private repo (its epoch-0 key and anchor). */
  privateCreate?: PrivateCreate,
): Promise<CreateRepoResult> {
  const name = normalizeRepoName(input.name)
  const ownerId = auth.identityId
  const key = journalKey(auth.network, ownerId, name)
  checkRepoInput(input)
  const visibility: Visibility = input.visibility ?? 'public'
  // Refused before anything is written: a private repo nobody can hold a key for, or whose
  // epoch-0 key would be wrapped to a key this browser does not hold (§5.2: writers use the
  // identity's highest usable encryption key). A resumed create is settled by its epoch-0
  // step instead (it resumes with its own standing self-wrap, whatever key that went to).
  const resumed = (await idbGet<RepoCreationJournal>('journal', key))?.repoId != null
  if (visibility === 'private') {
    if (privateCreate === undefined) throw new Error('cannot create a private repository: add your encryption key to this browser first (Settings → Keys)')
  }
  if (visibility === 'private' && !resumed && privateCreate !== undefined) {
    const current = usableEncryptionKey((await fetchIdentityKeys(sdk, ownerId)) ?? [], forge.core)
    if (current === null) throw new Error('cannot create a private repository: your identity has no encryption key')
    if (current.keyId !== privateCreate.ops.keyId) {
      throw new Error(
        `cannot create a private repository: your identity's current encryption key is key ${current.keyId}, but this browser holds key ${privateCreate.ops.keyId}; add key ${current.keyId} here (Settings → Keys)`,
      )
    }
  }
  // A resumed creation keeps the values it started with, so the repo and config documents
  // agree (the form may have been edited since; the page warns about that).
  const previous = await idbGet<RepoCreationJournal>('journal', key)
  // A fork and a plain repo of the same name are different creations: resuming one as the
  // other would write (or drop) `forkOf`, and a fork's packs and refs would land in a repo
  // that is not a fork of their parent. Refuse rather than guess.
  if (previous && (previous.input.visibility ?? 'public') !== visibility) {
    throw new Error(`an unfinished ${previous.input.visibility ?? 'public'} repository named ${name} is pending in this browser; finish or dismiss it on the New repository page first (visibility is immutable)`)
  }
  if (previous && (previous.input.forkOf ?? null) !== (input.forkOf ?? null)) {
    throw new Error(
      previous.input.forkOf
        ? `an unfinished fork named ${name} is pending in this browser; finish it (Fork again) or dismiss it on the New repository page`
        : `an unfinished repository named ${name} is pending in this browser; finish or dismiss it on the New repository page first`,
    )
  }
  const journal: { -readonly [K in keyof RepoCreationJournal]: RepoCreationJournal[K] } = previous
    ? { ...previous }
    : { network: auth.network, ownerId, input: { ...input, name }, repoId: null, done: [], startedAt: Date.now() }
  input = journal.input
  const save = (): Promise<void> => idbPut('journal', key, journal)
  await save()
  const step = async (s: CreateRepoStep, run: () => Promise<void>): Promise<void> => {
    onStep?.(s, 'start')
    await run()
    journal.done = [...journal.done, s]
    await save()
    onStep?.(s, 'done')
  }

  // 1. repo (unique per owner + name)
  const existingRepo = async (): Promise<string | null> => {
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: forge.core,
      documentTypeName: DOC.repo,
      where: [
        ['$ownerId', '==', ownerId],
        ['name', '==', name],
      ],
      limit: 1,
    })
    // A repo of this name exists: resume only one of the same visibility (it is immutable; a
    // document without one is not a repo this client made, so it is never adopted).
    if (documents[0] !== undefined) {
      const existing = documents[0]['visibility']
      if (existing !== 'public' && existing !== 'private') throw new Error(`${name} already exists without a readable visibility; pick another name`)
      if (existing !== visibility) throw new Error(`${name} already exists with the other visibility (visibility is immutable)`)
    }
    return firstId(documents)
  }
  let repoId = await existingRepo()
  await step('repo', async () => {
    if (repoId !== null) return
    const data: Record<string, unknown> = { name, visibility }
    if (input.description) data['description'] = input.description
    // A private repo's default branch lives only in its sealed config (§7).
    if (input.defaultBranch && visibility === 'public') data['defaultBranch'] = input.defaultBranch
    if (input.forkOf) data['forkOf'] = decodeIdentifier(input.forkOf)
    try {
      const r = await createDocumentIdempotent(sdk, auth, { contractId: forge.core, documentType: DOC.repo, data, intent: `${key}:repo` })
      repoId = r.documentId
    } catch (e) {
      if (!isDuplicate(e)) throw e
      repoId = await existingRepo()
      if (repoId === null) throw e
    }
  })
  if (repoId === null) throw new Error('the repo document did not land; try again')
  journal.repoId = repoId
  await save()
  const R = decodeIdentifier(repoId)
  const repo: RepoRef = { forge, repoId, ownerId, name, visibility }

  // 2. the owner's maintainer document (unique per repo + member)
  await step('maintainer', async () => {
    if ((await findMembership(sdk, repo, 'maintainer', ownerId)) !== null) return
    try {
      await createDocumentIdempotent(sdk, auth, {
        contractId: forge.core,
        documentType: DOC.maintainer,
        data: { repoId: R, memberId: decodeIdentifier(ownerId) },
        intent: `${key}:maintainer`,
      })
    } catch (e) {
      if (!isDuplicate(e)) throw e
    }
  })

  // 3. the first config (append-only; one is enough). A private repo's is its epoch-0 anchor,
  // after the owner's self-wrap of a fresh key (§5.3).
  await step('config', async () => {
    if (visibility === 'private') {
      const p = privateCreate as PrivateCreate
      await p.epochZero({ sdk, auth, repo, network: auth.network, ops: p.ops }, input.defaultBranch ?? 'main', key)
      return
    }
    const { documents } = await queryDocumentsWithProof(sdk, repoSource(repo).repoQuery(DOC.config, { limit: 1 }))
    if (documents.length > 0) return
    await createDocumentIdempotent(sdk, auth, {
      contractId: forge.core,
      documentType: DOC.config,
      data: { repoId: R, defaultBranch: input.defaultBranch ?? 'main', backend: { mode: 0 } },
      intent: `${key}:config`,
    })
  })

  await idbDelete('journal', key)
  invalidateMembers(repo, auth.network)
  return { repoId, name }
}
