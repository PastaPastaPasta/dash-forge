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
 * (members), `authorEvent` (the author's review kinds) and `transition` (state changes) live in
 * forge-collab, and consensus
 * enforces every gate. `star` and `follow` are `indexOnly`: a delete carries the document's
 * values (the SDK's index-only delete). Issue and PR numbers are dense (§6): the contract's `dense`
 * rule requires the next number to be the repo's issue and PR totals plus one.
 *
 * RC1 (`forge-contracts/schema/build.py`): every stamped type carries `vis` ({@link withVis});
 * a member proves membership with `asMember` (= the signer) where a rule needs it (approve and
 * request-changes, posts to a locked thread); a member is added only with their `consent`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { hexToBytes } from '@noble/hashes/utils.js'

import type { Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { base58Encode, decodeIdentifier } from '../auth/base58'
import { idbDelete, idbEntries, idbGet, idbPut } from '../idb'
import { isGitRefName, type EventKind } from '../rules'
import { denseNumber, isAuthorKind, namesDenseRule, normalizeRepoName as normalizeV2RepoName, type ClosedAs, type Role, type StateAction, type Visibility } from '../rules/v2'
import { fetchIdentityKeys, usableEncryptionKey, type EncryptionOps } from '../auth/encryption-key'
import {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  RULE_REFUSED_CODE,
  UnconfirmedWriteError,
  contentHash,
  countDocuments,
  createDocumentIdempotent,
  deleteDocumentIdempotent,
  previewCredits,
  queryAllDocuments,
  queryDocumentsWithProof,
  retryOnStaleContract,
  sumDocumentsGrouped,
  type DeleteResult,
  type PlainDocument,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { DOC, asIdentifierString, withVis, type RepoRef } from './contract'
import { isRc1BranchName, isRc1OidHex, isRc1TagName } from '../rules'
import { invalidateMembers, memberDocOf, readMemberships, roleOfMemberDoc } from './members'
import { contractHasProperty } from './contract-shape'
import { refNameHash, repoContentWritten } from './push'
import type { PrivateDocType } from '../private'
import { isSealedKind, privateWriter, sealForRepo, sealedIntent, sealedTextUse, PrivateWriteError, type PrivateWriter } from './private-writes'
import { invalidateRepoFeed } from './issues'
import { longBodyField } from './long-body'
import { createSealedRelease, sealedReleaseEnv, type SealedReleaseOptions, type SealedReleaseWritten } from './sealed-release'
import { noteTargetCreated } from './social'
import { refreshRoleOnRefusal, roleClaim } from './role-claim'
import { WRITER_ROLE_CODE, grantableRoles } from '../rules/roles'
import { repoSource } from './source'
import { starShape } from './star-shape'
import { writeLock, writeTransition, type StateTarget } from './transitions'
import { LAG_RETRY_MS, retryAfterLag } from './lag-retry'
import { sleep } from '../sdk/facade'
import { retryWhileMissing } from '../view/retry'
import { noteParticipation } from '../view/participation'

/** The release rule that reads the tag's live total (RC1 O-04). */
const ONE_LIVE_RULE: ReadonlySet<string> = new Set(['oneLive'])

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
  policyBypass: 23,
  hide: 24,
  unhide: 25,
}

/** Review verdicts (`review.verdict`) a member writes: approve and request changes carry `asMember`. */
export const VERDICT_INT = { approve: 1, requestChanges: 2, comment: 3 } as const
export type VerdictInput = keyof typeof VERDICT_INT

/**
 * A non-member's approve and request-changes (RC1 R-16): recorded, never counted (consensus
 * refuses 1/2 without a membership proof, and 4/5 with one).
 */
export const OUTSIDER_VERDICT_INT = { approve: 4, requestChanges: 5 } as const

/** Where a comment or review is posted from: whether the signer is a member, and whether the thread is locked. */
export interface PostContext {
  /** The signer holds a maintainer or writer document of the repo (as last read). */
  readonly isMember: boolean
  /** The target's conversation is locked (its transition sum is 16 or more). */
  readonly locked?: boolean
}

/** Why a non-member cannot comment on or review a locked thread. */
export const LOCKED_REASON = "This conversation is locked: only the repo's members can comment."

/** A non-member's post to a locked thread: consensus refuses it (`lockGate`). */
export function lockedOut(post: PostContext | undefined): boolean {
  return post?.locked === true && !post.isMember
}

/**
 * The `verdict` and membership proof of a review (RC1 R-15, R-16): a member's approve or request
 * changes proves membership (1/2 + `asMember`), a non-member's is 4/5; a comment verdict proves
 * it only on a locked thread (where consensus refuses a non-member's review).
 */
export function reviewVerdictFields(verdict: VerdictInput, signer: string, post: PostContext): Record<string, unknown> {
  if (verdict === 'comment') return { verdict: VERDICT_INT.comment, ...commentProof(signer, post) }
  if (!post.isMember) return { verdict: OUTSIDER_VERDICT_INT[verdict] }
  return { verdict: VERDICT_INT[verdict], asMember: decodeIdentifier(signer) }
}

/**
 * The membership proof a comment carries (RC1 R-15): a member's post to a locked thread proves it,
 * or consensus refuses it (`lockGate`). A post that needs none carries none: the proof is an
 * extra read at consensus, and a stale membership read would get it refused.
 */
export function commentProof(signer: string, post: PostContext | undefined): Record<string, unknown> {
  return post?.isMember === true && post.locked === true ? { asMember: decodeIdentifier(signer) } : {}
}

/**
 * `post` with its membership settled for a review of `verdict`: a non-member's approve or request
 * changes is recorded as 4/5, which never counts, and a non-member's post to a locked thread is
 * refused, so a "not a member" read (still loading, failed, or cached from before they were
 * added) is read again, uncached, before it decides either.
 */
export async function settledPost(sdk: EvoSDK, repo: RepoRef, signer: string, post: PostContext, verdict: VerdictInput): Promise<PostContext> {
  if (post.isMember || (verdict === 'comment' && post.locked !== true)) return post
  const members = await readMemberships(sdk, repo)
  return members.some((m) => m.identity === signer) ? { ...post, isMember: true } : post
}

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

/** The contract (forge-core, forge-collab or forge-community) a write of `documentType` targets. */
export function contractFor(repo: RepoRef, documentType: string): string {
  return repoSource(repo).repoQuery(documentType).dataContractId
}

/** `data` plus the `repoId` every repo-scoped type carries. */
function scoped(repo: RepoRef, data: Record<string, unknown>): Record<string, unknown> {
  return { repoId: decodeIdentifier(repo.repoId), ...data }
}

/** The document types whose writes can change an open issue or PR count. */
const COUNTED_TYPES: ReadonlySet<string> = new Set([DOC.issue, DOC.patch, DOC.transition])

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
  // `noPlain`'s fields, and `yanked` / `imported`, which a sealed release never carries (§16.2)
  release: ['name', 'notes', 'assets', 'assetManifest', 'yanked', 'imported'],
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
  /**
   * What the action says, for a document the caller sealed itself (a sealed release): the retry
   * cache compares this instead of `data`, which is encrypted afresh on every attempt.
   */
  sealedContentKey?: string,
): Promise<WriteResult> {
  // What the action says, before sealing: the retry cache compares this (sealed fields are
  // encrypted afresh on every attempt, so the sealed data never matches itself).
  let contentKey: string | undefined = sealedContentKey
  // A review's PR, read before sealing: the inbox follows a PR its reviewer reviewed (QW2-009).
  const patchId = data['patchId']
  const reviewed = documentType !== DOC.review ? '' : patchId instanceof Uint8Array ? base58Encode(patchId) : asIdentifierString(patchId)
  // The claimed role (`r`) of a gated type, and the refusal of a write the signer's role cannot
  // make, before anything is sealed or signed. `r` is plaintext: it goes on beside `enc`.
  const claim = await roleClaim(sdk, auth, repo, documentType, data)
  const sealedType = repo.visibility === 'private' ? sealedTypeOf(documentType, data) : null
  if (sealedType !== null) {
    contentKey = contentHash(documentType, scoped(repo, data))
    const w = writer ?? (await privateWriter(sdk, auth, repo))
    data = await sealForRepo(sdk, auth, repo, sealedType, data, w)
    intent = sealedIntent(intent, w.keys)
  }
  assertNoPlaintext(repo, documentType, data)
  let result: WriteResult | undefined
  try {
    const signed = data
    result = await refreshRoleOnRefusal(repo, auth, documentType, () =>
      createDocumentIdempotent(sdk, auth, {
        contractId: contractFor(repo, documentType),
        documentType,
        // The stamp goes on after sealing: it is plaintext on chain, never part of `enc`.
        data: scoped(repo, withVis(repo.visibility, documentType, { ...signed, ...claim })),
        ...(intent ? { intent } : {}),
        ...(contentKey ? { contentKey } : {}),
      }),
    )
    return result
  } finally {
    // A new issue or PR raises its total's floor BEFORE the caches drop: dropping them tells the
    // repo header to re-read its counts at once, and that read must wait out a node a block
    // behind rather than cache the old total for the new write generation (QW-064).
    if (result?.confirmed && (documentType === DOC.issue || documentType === DOC.patch)) noteTargetCreated(repo, documentType === DOC.issue ? 'issue' : 'patch')
    if (result?.confirmed && reviewed !== '') void noteParticipation(auth.network, auth.identityId, reviewed, 'reviewed')
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
// Issue numbering (forge-v2.md §6: dense, one sequence for issues and PRs)
// ---------------------------------------------------------------------------

/**
 * The number the next issue or PR of a repo must carry: the proved `issue` and `patch` totals
 * (`perRepo`) plus one (the contract's `dense` rule counts the new document). Null when no u32
 * number is left.
 */
export async function nextNumber(sdk: EvoSDK, repo: RepoRef): Promise<number | null> {
  const source = repoSource(repo)
  const [issues, patches] = await Promise.all([countDocuments(sdk, source.repoQuery(DOC.issue)), countDocuments(sdk, source.repoQuery(DOC.patch))])
  return denseNumber(issues, patches)
}

/** Whether a refusal says the number was not the dense next one (another create landed first). */
function isDenseRefusal(e: unknown): boolean {
  return e instanceof ConsensusRefusal && e.code === RULE_REFUSED_CODE && namesDenseRule(e.message)
}

// ---------------------------------------------------------------------------
// Issues / comments / events / reviews
// ---------------------------------------------------------------------------

/** A created issue: the write result plus the allocated issue number. */
export interface CreateIssueResult extends WriteResult {
  readonly number: number
}

/**
 * Create an `issue` (ungated; anyone). The number is the dense next one ({@link nextNumber});
 * when consensus refuses it (another issue or PR landed between the read and the write: a
 * `dense` refusal, or the unique index), the totals are read again and `onRetry` is told, so
 * the UI can say "Someone took #42 a moment ago; retrying as #43" (`ux-dx-spec.md` §1d).
 */
export async function createIssue(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { title: string; body: string; intent?: string },
  onRetry?: (taken: number, next: number) => void,
): Promise<CreateIssueResult> {
  const data: Record<string, unknown> = { title: input.title }
  // A body longer than its field: its full text stored first (forge-v2.md §6.3), once for
  // every renumbered attempt.
  const body = await longBodyField(sdk, auth, repo, 'issue', input.body, { title: input.title }, input.intent)
  if (body.length > 0) data['body'] = body
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
  /** Open as a draft (review-parity P6): the patch, then a draft `transition` (kind 14). */
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
    if (!isGitRefName(name)) {
      throw new Error(`illegal ref name ${JSON.stringify(name)}`)
    }
  }
  if (!isRc1OidHex(input.headOid)) throw new Error('the PR head must be a 20- or 32-byte oid (SHA-1 or SHA-256)')
  const head = hexToBytes(input.headOid)
  const data: Record<string, unknown> = { title: input.title }
  if (input.body.length > 0) data['body'] = input.body
  data['baseRefNameHash'] = refNameHash(input.baseRefName)
  data['baseRefName'] = input.baseRefName
  data['sourceRepoId'] = decodeIdentifier(input.sourceRepoId)
  data['sourceRefNameHash'] = refNameHash(input.sourceRefName)
  data['sourceRefName'] = input.sourceRefName
  data['headOid'] = head
  return data
}

/**
 * Open a PR (`patch`, ungated), numbered in the issues' sequence. A draft is the patch and then
 * its author's draft `transition`; when that second write fails the PR is open and ready, and the
 * error says so (the author can convert it from the PR page).
 */
export async function createPatch(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: PatchInput & { intent?: string },
  onRetry?: (taken: number, next: number) => void,
): Promise<CreateIssueResult> {
  // A body longer than its field: its full text stored first (forge-v2.md §6.3).
  const others = { title: input.title, baseRefName: input.baseRefName, sourceRefName: input.sourceRefName }
  const body = await longBodyField(sdk, auth, repo, 'patch', input.body, others, input.intent)
  const created = await createNumbered(sdk, auth, repo, 'patch', patchData({ ...input, body }), input.intent, onRetry)
  if (input.draft !== true) return created
  const target: StateTarget = { id: created.documentId, number: created.number, type: 'patch', author: auth.identityId }
  try {
    await setTargetState(sdk, auth, repo, { target, action: 'draft', isMember: false, ...(input.intent ? { intent: `${input.intent}:draft` } : {}) })
  } catch (e) {
    throw new DraftMarkError(created, e)
  }
  return created
}

/**
 * The PR was opened, but marking it a draft did not confirm: it is open and ready for review, or
 * (an unconfirmed write) may still become a draft. Never create the PR again on this error.
 */
export class DraftMarkError extends Error {
  constructor(
    readonly created: CreateIssueResult,
    readonly cause: unknown,
  ) {
    super(
      cause instanceof UnconfirmedWriteError
        ? `PR #${created.number} was opened; marking it a draft was sent but is not confirmed yet. Check the PR page`
        : `PR #${created.number} was opened, but marking it a draft failed (${cause instanceof Error ? cause.message : String(cause)}); convert it to a draft from the PR page`,
    )
    this.name = 'DraftMarkError'
  }
}

/** Create a numbered `issue` / `patch`, taking the next dense number again when another landed first. */
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
  // A private repo: refuse over-long text before numbering, and seal every renumbered retry
  // under the one writer of this action (the AD binds each new number).
  let writer: PrivateWriter | undefined
  if (repo.visibility === 'private') {
    const { used, limit } = sealedTextUse(type, fields)
    if (limit !== null && used > limit) {
      throw new PrivateWriteError(`the text is too long for a private repo: an encrypted ${type} holds at most ${limit} bytes of text (this one has ${used})`)
    }
    writer = await privateWriter(sdk, auth, repo)
  }
  const next = (): Promise<number | null> => nextNumber(sdk, repo)
  // A retry of this action first finishes the number its last attempt signed: once that
  // attempt is visible, the totals would give the next number, a new cache key, and a second
  // issue (the pending write under the old number would never be looked at).
  const triedKey = intentBase ? `forge:numbered:${auth.network}:${repo.repoId}:${type}:${intentBase}` : null
  let number = readTriedNumber(triedKey) ?? (await next())
  for (let attempt = 0; attempt < 4; attempt++) {
    if (number === null) throw new Error(`this repo has no ${noun} numbers left`)
    try {
      // Each number is its own write: a renumbered retry must not reuse the earlier bytes.
      const intent = intentBase ? `${intentBase}#${number}` : undefined
      writeTriedNumber(triedKey, number)
      const result = await writeRepoDoc(sdk, auth, repo, DOC[type], { number, tk: type === 'issue' ? 0 : 1, ...fields }, intent, writer)
      writeTriedNumber(triedKey, null)
      return { ...result, number }
    } catch (e) {
      // Refused for good (not a numbering race, which is renumbered below): nothing under this
      // number is pending, so the action does not pin it any more. After a SupersededWriteError
      // the number stays pinned on purpose: its intent `base#N` holds the tombstone, so every
      // later retry of this action lands there and is answered the same way, never given a
      // fresh number and posted as a second document.
      const race = isDuplicate(e) || isDenseRefusal(e)
      if (e instanceof ConsensusRefusal && !race) writeTriedNumber(triedKey, null)
      if (e instanceof UnconfirmedWriteError) {
        // Not seen yet. If someone else holds the number, ours was refused: renumber.
        const holder = await numberHolder(sdk, repo, number).catch(() => undefined)
        if (holder === undefined || holder === null || holder === auth.identityId) throw e
      } else if (!race) throw e
      const taken: number = number
      if (isDenseRefusal(e)) {
        // `dense` judges the totals the validating node holds: after about a block they are
        // current, and the fresh read is the number to use (a node a block behind may have
        // refused one that was right, so it is not skipped).
        await sleep(LAG_RETRY_MS[0] as number)
        number = await next()
        // A read from a node further behind still never goes below the refused number.
        if (number !== null && number < taken) number = taken
      } else {
        // The number is held (the unique index): the next one, even if a read still lags.
        number = await next()
        if (number !== null && number <= taken) number = taken + 1
      }
      if (number !== null && number !== taken) onRetry?.(taken, number)
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

/** Who holds `number` (its `$ownerId`) among the repo's issues and PRs (one sequence), or null. */
async function numberHolder(sdk: EvoSDK, repo: RepoRef, number: number): Promise<string | null> {
  const source = repoSource(repo)
  const held = await Promise.all(
    [DOC.issue, DOC.patch].map((t) => queryDocumentsWithProof(sdk, source.repoQuery(t, { where: [['number', '==', number]], limit: 1 }))),
  )
  const owner = held.flatMap((r) => r.documents)[0]?.['$ownerId']
  return typeof owner === 'string' ? owner : null
}

/**
 * Create a `comment` on an issue or PR (ungated; author-owned). `replyTo` must name a thread's
 * root comment (RC1 R-14: consensus refuses a reply to a reply). On a locked thread only a
 * member can post, with the proof ({@link commentProof}); a non-member is refused here.
 */
export async function createComment(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { targetId: string; body: string; replyTo?: string; intent?: string; post?: PostContext },
): Promise<WriteResult> {
  if (lockedOut(input.post)) throw new Error(LOCKED_REASON)
  // A body longer than its field: its full text stored first (forge-v2.md §6.3).
  const body = await longBodyField(sdk, auth, repo, 'comment', input.body, {}, input.intent)
  const data: Record<string, unknown> = { targetId: decodeIdentifier(input.targetId), body }
  if (input.replyTo) data['replyTo'] = decodeIdentifier(input.replyTo)
  return writeRepoDoc(sdk, auth, repo, DOC.comment, { ...data, ...commentProof(auth.identityId, input.post) }, input.intent)
}

/**
 * The event kinds RC1 refuses as a member `event` (`kind` ≥ 4, `noState`): close, reopen and
 * merge, draft and ready, lock and unlock are transitions.
 */
export const TRANSITION_EVENT_KINDS: ReadonlySet<EventKindName> = new Set<EventKindName>(['close', 'reopen', 'merge', 'draft', 'ready', 'lock', 'unlock'])

/** The document data of an event on `target`. */
function eventData(
  target: WriteTarget,
  kind: EventKindName,
  extra: { value?: string; oidHex?: string } = {},
): Record<string, unknown> {
  if (TRANSITION_EVENT_KINDS.has(kind)) throw new Error(`${kind} is a transition, not an event`)
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
 * Append a member `event` (a label, an assignee, a milestone, a pin, …). Consensus admits it only
 * from a current maintainer or writer (40120 otherwise).
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

/**
 * Close, reopen, merge, draft or ready an issue or PR: one `transition`, the legal move from its
 * current state, by a member or by its author ({@link writeTransition}).
 */
export async function setTargetState(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: StateTarget; action: StateAction; isMember: boolean; oidHex?: string; intent?: string; closed?: ClosedAs },
): Promise<WriteResult> {
  return writeTransition(sdk, auth, repo, (type, data, intent) => writeRepoDoc(sdk, auth, repo, type, data, intent), input)
}

/**
 * Lock or unlock the conversation on an issue or PR: one member `transition` (kinds 3/4 or 18/19;
 * {@link writeLock}). Once locked, consensus refuses comments and reviews from non-members.
 */
export async function setLock(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: StateTarget; lock: boolean; isMember: boolean; intent?: string },
): Promise<WriteResult> {
  return writeLock(sdk, auth, repo, (type, data, intent) => writeRepoDoc(sdk, auth, repo, type, data, intent), input)
}

/**
 * Submit a PR review: a verdict on `commitOid` (the head it was made against). A member's approve
 * or request changes proves membership; a non-member's is recorded as 4/5
 * ({@link reviewVerdictFields}); on a locked PR a non-member is refused here.
 */
export async function createReview(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { patchId: string; verdict: VerdictInput; commitOid: string; body?: string; intent?: string; post: PostContext },
): Promise<WriteResult> {
  if (!isRc1OidHex(input.commitOid)) throw new Error('a review names a 20- or 32-byte commit')
  const post = await settledPost(sdk, repo, auth.identityId, input.post, input.verdict)
  if (lockedOut(post)) throw new Error(LOCKED_REASON)
  const data: Record<string, unknown> = {
    patchId: decodeIdentifier(input.patchId),
    ...reviewVerdictFields(input.verdict, auth.identityId, post),
    commitOid: hexToBytes(input.commitOid),
  }
  // A body longer than its field: its full text stored first (forge-v2.md §6.3).
  if (input.body && input.body.length > 0) data['body'] = await longBodyField(sdk, auth, repo, 'review', input.body, {}, input.intent)
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

/**
 * The live-release total of `tagName` (`release.perTag`, summable `delta`): 1 when a release of the
 * tag is published, 0 when none is (never published, or unpublished).
 */
export async function readTagLive(sdk: EvoSDK, repo: RepoRef, tagName: string): Promise<number> {
  const sums = await sumDocumentsGrouped(
    sdk,
    { ...repoSource(repo).repoQuery(DOC.release, { where: [['tagName', 'in', [tagName]]], orderBy: [['tagName', 'asc']] }), groupBy: ['tagName'] },
    'delta',
  )
  return [...sums.values()].reduce((a, b) => a + b, 0)
}

/**
 * The `release.delta` of a publish, an edit or a yank (RC1 O-04 `oneLive`): +1 when the tag has no
 * live release, 0 when it has one (the new document supersedes it). Releases are never deleted;
 * an unpublish (-1) is not offered here.
 */
export function publishDelta(live: number): 1 | 0 {
  return live >= 1 ? 0 : 1
}

/** The fields of a release revision a writer states (the sealed-only ones on a private repo). */
export interface ReleaseInput {
  readonly tagName: string
  readonly name?: string
  readonly notes?: string
  /** A public release states it (absent: false); a sealed revision carries it when absent. */
  readonly yanked?: boolean
  /** A public release's asset list; a private repo's assets are sealed files ({@link SealedReleaseOptions}). */
  readonly assets?: readonly ReleaseAsset[]
  readonly intent?: string
  /** Sealed only (§16.2): absent carries the tag's newest revision's flag. */
  readonly prerelease?: boolean
  /** Sealed only (§16.2): absent carries the tag's newest revision's flag. */
  readonly draft?: boolean
  /** Sealed only (§16.3): this revision unpublishes the tag. */
  readonly unpublished?: boolean
}

/**
 * Create a `release`: newest per tag wins. Maintainers only (consensus-gated). Refused before
 * signing for a tag name the contract refuses. A public release's `delta` is read from the tag's
 * live total ({@link publishDelta}); a private repo's is a sealed revision
 * ({@link createSealedRelease}: `delta` 0, its files and asset list sealed and stored first).
 */
export async function createRelease(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: ReleaseInput,
  sealed: SealedReleaseOptions = {},
): Promise<WriteResult & { readonly sealed?: SealedReleaseWritten }> {
  if (repo.visibility === 'private') {
    if (input.assets !== undefined && input.assets.length > 0) throw new Error("a private repo's assets are sealed files, never plaintext entries")
    const env = sealed.env ?? sealedReleaseEnv(sdk, auth, repo, sealed.storage ?? null)
    const written = await createSealedRelease(sdk, auth, repo, { ...input, files: sealed.files, resolved: sealed.resolved }, env, sealed.onEvent)
    return { ...written.release, sealed: written }
  }
  if (input.prerelease !== undefined || input.draft !== undefined || input.unpublished === true || sealed.files !== undefined) {
    throw new Error("draft, pre-release, unpublish and sealed files are for a private repo's sealed release")
  }
  if (!isRc1TagName(input.tagName)) throw new Error(`${JSON.stringify(input.tagName)} is not a tag name git accepts`)
  const fields: Record<string, unknown> = { tagName: input.tagName, yanked: input.yanked ?? false }
  if (input.name && input.name.length > 0) fields['name'] = input.name
  if (input.notes && input.notes.length > 0) fields['notes'] = input.notes
  if (input.assets && input.assets.length > 0) fields['assets'] = releaseAssetsJson(input.assets)
  const attempt = async (): Promise<WriteResult> =>
    writeRepoDoc(sdk, auth, repo, DOC.release, { ...fields, delta: publishDelta(await readTagLive(sdk, repo, input.tagName)) }, input.intent)
  try {
    // The live total was read from (or judged by) a node a block behind a publish that just
    // landed: `oneLive` refuses the delta and nothing is stored. Read it again after about a
    // block and retry, bounded.
    return await retryAfterLag(attempt, ONE_LIVE_RULE, LAG_RETRY_MS.slice(0, 2))
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
  const rows = await retryOnStaleContract(forge.community, () =>
    (sdk as unknown as { documents: RawDocumentsFacade }).documents.query({
      dataContractId: forge.community,
      documentTypeName: type,
      where: [
        ['$ownerId', '==', ownerId],
        [field, '==', targetId],
      ],
      orderBy: [['$ownerId', 'asc']],
      limit: 1,
    }),
  )
  for (const doc of rows.values()) if (doc) return doc
  return null
}

/** Whether `ownerId` stars `repoId` now (its `star` on `byOwner`; Trending's owner check reads it too). */
export async function hasStar(sdk: EvoSDK, forge: ForgeIds, ownerId: string, repoId: string): Promise<boolean> {
  return (await findOwnIndexOnly(sdk, forge, 'star', ownerId, repoId)) !== null
}

/** Create the signer's `star` / `follow` (indexOnly), with `payload` besides the target. Idempotent: a duplicate is success. */
function createIndexOnly(sdk: EvoSDK, auth: WriteAuth, forge: ForgeIds, type: IndexOnlyType, targetId: string, payload: Record<string, unknown> = {}): Promise<WriteResult> {
  const field = targetField(type)
  return createOrExisting(() =>
    createDocumentIdempotent(sdk, auth, {
      contractId: forge.community,
      documentType: type,
      data: { [field]: decodeIdentifier(targetId), ...payload },
      probe: async () => (await findOwnIndexOnly(sdk, forge, type, auth.identityId, targetId)) !== null,
    }),
  )
}

/** Delete the signer's `star` / `follow`: an index-only delete carrying its values. */
async function deleteIndexOnly(sdk: EvoSDK, auth: WriteAuth, forge: ForgeIds, type: IndexOnlyType, targetId: string): Promise<DeleteResult> {
  const own = await findOwnIndexOnly(sdk, forge, type, auth.identityId, targetId)
  if (own === null) return ALREADY_GONE
  return deleteDocumentIdempotent(sdk, auth, {
    contractId: forge.community,
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
 * Whether the signer may write a `starBeat` for `repo` (RC1 O-08): only on a public repo, and
 * never on their own (`repoOwner` must differ from the signer, `distinctFrom`).
 */
export function beatAllowed(repo: RepoRef, signer: string): boolean {
  return repo.visibility === 'public' && repo.ownerId !== signer
}

/**
 * Write the signer's `starBeat` for `repo` (trending, platform-parity-spec §4.3) unless one
 * exists: one per identity and repo, ever, carrying `{repoId, vis: "public", repoOwner}`.
 * Nothing is written where consensus would refuse it ({@link beatAllowed}).
 */
export async function writeStarBeat(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef): Promise<void> {
  if (!beatAllowed(repo, auth.identityId)) return
  if ((await findOwnIndexOnly(sdk, repo.forge, 'starBeat', auth.identityId, repo.repoId)) !== null) return
  await createIndexOnly(sdk, auth, repo.forge, 'starBeat', repo.repoId, { vis: 'public', repoOwner: decodeIdentifier(repo.ownerId) })
}

/**
 * The viewer's star on a repo (forge-community `star`). With `trending` (the viewer's "Count my
 * stars toward Trending", on by default), a new star also writes its `starBeat`. On a fused-star
 * contract ({@link starShape}, RC2 C1) the star is its own Trending entry: no beat, whatever
 * `trending` says.
 */
export function starRelation(sdk: EvoSDK, auth: WriteAuth | null, viewer: string, repo: RepoRef, trending = false): Relation {
  return {
    read: () => hasStar(sdk, repo.forge, viewer, repo.repoId),
    add: async () => {
      const a = need(auth)
      const confirmed = (await createIndexOnly(sdk, a, repo.forge, 'star', repo.repoId)).confirmed
      if (confirmed && trending) {
        // Best effort: the star stands without its beat, which only feeds a ranking.
        const beat = async (): Promise<void> => {
          if ((await starShape(sdk, repo.forge)) === 'beat') await writeStarBeat(sdk, a, repo)
        }
        // eslint-disable-next-line no-console
        await beat().catch((e: unknown) => console.warn('the star landed; its Trending beat did not', e))
      }
      return confirmed
    },
    remove: async () => (await deleteIndexOnly(sdk, need(auth), repo.forge, 'star', repo.repoId)).deleted,
  }
}

/** The viewer's watch of a repo (forge-community `watch`, C-1): the inbox follows it on every device. */
export function watchRelation(sdk: EvoSDK, auth: WriteAuth | null, viewer: string, repo: RepoRef): Relation {
  return {
    read: async () => (await findOwnIndexOnly(sdk, repo.forge, 'watch', viewer, repo.repoId)) !== null,
    add: async () => (await createIndexOnly(sdk, need(auth), repo.forge, 'watch', repo.repoId)).confirmed,
    remove: async () => (await deleteIndexOnly(sdk, need(auth), repo.forge, 'watch', repo.repoId)).deleted,
  }
}

/**
 * The viewer's follow of `target` (forge-community `follow`). `forge` null (not deployed): every
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

/**
 * The membership document `(repoId, memberId)` of the type that holds `role` (a `writer` document
 * for writer, triage and reader), with the role it grants, or null.
 */
async function findMembership(sdk: EvoSDK, repo: RepoRef, role: Role, memberId: string): Promise<{ readonly id: string; readonly role: Role | null } | null> {
  const type = memberDocOf(role)
  const { documents } = await queryDocumentsWithProof(
    sdk,
    repoSource(repo).repoQuery(type, { where: [['memberId', '==', memberId]], limit: 1 }),
  )
  const id = firstId(documents)
  return id === null ? null : { id, role: roleOfMemberDoc(type, documents[0] as PlainDocument) }
}

/**
 * A member already holds a `writer` document of another role. A `writer` document is immutable:
 * a role change is a removal and a new add (their consent still stands).
 */
export class MemberRoleTakenError extends Error {
  constructor(
    readonly memberId: string,
    readonly held: Role | null,
  ) {
    super(`they are already a ${held ?? 'member'} here: to change their role, remove them and add them again as the new role`)
    this.name = 'MemberRoleTakenError'
  }
}

/** Refuse a role the owner cannot grant on `repo` (a reader on a public repo: everyone can read it). */
function assertGrantable(repo: RepoRef, role: Role): void {
  if (!grantableRoles(repo.visibility).includes(role)) throw new Error('a reader role is only for private repos: everyone can read a public one')
}

/**
 * The `role` a `writer` document of `role` carries, where the registered forge-core declares it
 * (RC2 member roles); a contract without it has writers only, so a triage or reader grant is
 * refused there before signing.
 */
async function writerRoleData(sdk: EvoSDK, repo: RepoRef, role: Role): Promise<Record<string, unknown>> {
  if (role === 'maintainer') return {}
  if (await contractHasProperty(sdk, repo.forge.core, DOC.writer, 'role')) return { role: WRITER_ROLE_CODE[role] }
  if (role !== 'writer') throw new Error(`this network's forge-core predates member roles: it has no ${role} role, only writers and maintainers`)
  return {}
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

// ---------------------------------------------------------------------------
// Consent (RC1 R-06: nobody is made a member without their own `consent`)
// ---------------------------------------------------------------------------

/**
 * The member has not accepted yet: consensus refuses a `maintainer` or `writer` document without
 * the member's `consent` for the repo. Nothing was written; the invite is pending on them.
 */
export class ConsentMissingError extends Error {
  constructor(readonly memberId: string) {
    super("they haven't accepted the invitation yet: send them this repo's invite link (Settings → Collaborators) to accept, then add them")
    this.name = 'ConsentMissingError'
  }
}

/** The signer's `consent` document for `repo` (`byRepoOwner`, unique), or null. */
export async function findConsent(sdk: EvoSDK, repo: RepoRef, identityId: string): Promise<string | null> {
  const { documents } = await queryDocumentsWithProof(
    sdk,
    repoSource(repo).repoQuery(DOC.consent, { where: [['$ownerId', '==', identityId]], orderBy: [['$ownerId', 'asc']], limit: 1 }),
  )
  return firstId(documents)
}

/**
 * How many more times an add re-reads a consent it did not find (1.5 s apart) before refusing:
 * the member may have accepted moments ago, on a node the owner's has not caught up with (D-10).
 */
export const CONSENT_LAG_RETRIES = 2

/**
 * Every identity that consented to join `repo` (their `consent` documents), in id order: the
 * owner's pending invitations are the consents of identities that are not members yet.
 */
export async function readConsents(sdk: EvoSDK, repo: RepoRef): Promise<string[]> {
  const docs = await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.consent, { orderBy: [['$ownerId', 'asc']] }))
  return docs.map((d) => d['$ownerId']).filter((id): id is string => typeof id === 'string')
}

/**
 * Accept an invitation to collaborate on `repo`: the signer's `consent` document, which lets the
 * owner make them a maintainer or writer. Idempotent: an existing consent is success. A consent
 * stands until deleted, so a later re-add needs no new one.
 */
export async function acceptInvite(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, intent?: string): Promise<WriteResult> {
  if (auth.identityId === repo.ownerId) throw new Error('the owner is a member already')
  const existing = await findConsent(sdk, repo, auth.identityId)
  if (existing !== null) return alreadyThere(existing)
  return createOrExisting(
    () => createDocumentIdempotent(sdk, auth, { contractId: repo.forge.core, documentType: DOC.consent, data: { repoId: decodeIdentifier(repo.repoId) }, ...(intent ? { intent } : {}) }),
    () => findConsent(sdk, repo, auth.identityId),
  )
}

/**
 * The `maintainer` / `writer` document data (RC1): the repo's `vis`, and `consentBy` = the member
 * (their `consent` document must exist) unless the owner enrols itself; `extra` adds a writer's
 * `role` (RC2).
 */
export function membershipData(repo: RepoRef, memberId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const member = decodeIdentifier(memberId)
  return {
    repoId: decodeIdentifier(repo.repoId),
    memberId: member,
    vis: repo.visibility,
    ...(memberId === repo.ownerId ? {} : { consentBy: member }),
    ...extra,
  }
}

/**
 * Grant `memberId` a role on a public repo: the owner creates a `maintainer` or `writer`
 * document (consensus refuses anyone else). Idempotent: an existing membership is success.
 * Refused on a private repo ({@link PrivateMembershipError}), and while the member has not
 * accepted ({@link ConsentMissingError}).
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
 * private repo, inside the add flow (after its checks, before the key wrap). Throws
 * {@link ConsentMissingError} before signing when the member has not accepted.
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
  assertGrantable(repo, role)
  const roleData = await writerRoleData(sdk, repo, role)
  const held = await findMembership(sdk, repo, role, memberId)
  if (held !== null) {
    if (held.role === role) return alreadyThere(held.id)
    throw new MemberRoleTakenError(memberId, held.role)
  }
  if (memberId !== repo.ownerId && (await retryWhileMissing(() => findConsent(sdk, repo, memberId), CONSENT_LAG_RETRIES)) === null) {
    throw new ConsentMissingError(memberId)
  }
  const result = await createOrExisting(
    () =>
      createDocumentIdempotent(sdk, auth, {
        contractId: repo.forge.core,
        documentType: memberDocOf(role),
        data: membershipData(repo, memberId, roleData),
        ...(intent ? { intent } : {}),
      }),
    async () => (await findMembership(sdk, repo, role, memberId))?.id ?? null,
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
 * Change a public repo member's role `from` → `to` (RC2: a `writer` document is immutable, so a
 * change is the owner deleting the membership and adding the new one; the member's `consent`
 * still stands). Everything that would refuse the add is checked before the delete: the role is
 * grantable here, the contract has it, their consent is present, and they hold no other document
 * of the new role's type. Refused on a private repo (there a removal rotates the key: remove and
 * add again through the private-repo flow).
 */
export async function changeMemberRole(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  memberId: string,
  from: Role,
  to: Role,
  intent?: string,
): Promise<WriteResult> {
  if (repo.visibility === 'private') throw new PrivateMembershipError('remove')
  if (auth.identityId !== repo.ownerId) throw new Error('only the repo owner can change roles')
  if (memberId === repo.ownerId) throw new Error("the owner's own role does not change")
  if (from === to) throw new Error(`they are already a ${to}`)
  assertGrantable(repo, to)
  await writerRoleData(sdk, repo, to)
  if (memberDocOf(from) !== memberDocOf(to)) {
    const other = await findMembership(sdk, repo, to, memberId)
    if (other !== null) throw new MemberRoleTakenError(memberId, other.role)
  }
  if ((await findConsent(sdk, repo, memberId)) === null) throw new ConsentMissingError(memberId)
  // The document being replaced must still hold `from` (another tab may have changed it already).
  const current = await findMembership(sdk, repo, from, memberId)
  if (current === null || current.role !== from) {
    throw new Error(`they are no longer a ${from} here (their role changed meanwhile); reload the members and try again`)
  }
  await revokeMembershipDoc(sdk, auth, repo, memberId, from)
  try {
    // A node a block behind may still list the deleted document: wait until it is gone before the
    // add, which would otherwise read it as a membership they already hold.
    if (memberDocOf(from) === memberDocOf(to)) {
      await retryWhileMissing(async () => {
        const held = await findMembership(sdk, repo, to, memberId)
        return held === null || held.id !== current.id ? true : null
      }, CONSENT_LAG_RETRIES + 2)
    }
    return await grantMembershipDoc(sdk, auth, repo, memberId, to, intent)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(`their ${from} role was removed, but adding them as ${to} failed (${reason}); add them again as ${to}`)
  }
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
  // A writer-document role (writer, triage, reader) deletes the member's `writer` document,
  // whichever of them it grants: a member holds at most one.
  const existing = await findMembership(sdk, repo, role, memberId)
  if (existing === null) return ALREADY_GONE
  const result = await deleteDocumentIdempotent(sdk, auth, {
    contractId: repo.forge.core,
    documentType: memberDocOf(role),
    documentId: existing.id,
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
  if (input.defaultBranch !== undefined && input.defaultBranch !== '' && !isRc1BranchName(input.defaultBranch)) {
    throw new Error(`${JSON.stringify(input.defaultBranch)} is not a branch name git accepts.`)
  }
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

/**
 * The name a typed repo name becomes, as GitHub converts one ("QA3 Bad Name!" → `qa3-bad-name`):
 * lowercased, each run of characters a name cannot hold made one `-`, then trimmed to start with
 * a letter or digit, end without a dash, and fit 63 characters. Null when nothing valid is left
 * (QW3-036: the form answered with the parser's own message instead).
 */
export function suggestRepoName(input: string): string | null {
  const exact = normalizeV2RepoName(input.trim())
  if (exact !== null) return exact
  const converted = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63)
    .replace(/-+$/, '')
  return normalizeV2RepoName(converted)
}

/** Sentence-case: why a repo name is refused (what a name can hold). */
export const REPO_NAME_RULE = "A repository name uses a–z, 0–9, '.', '_' and '-' (up to 63 characters) and starts with a letter or digit."

/** A valid forge-v2 repo name for `input` (ASCII lowercased), or an error saying why not. */
export function normalizeRepoName(input: string): string {
  const name = normalizeV2RepoName(input.trim())
  if (name === null) {
    throw new Error(`"${input.trim()}" is not a valid repository name. ${REPO_NAME_RULE}`)
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
    if (privateCreate === undefined) throw new Error('cannot create a private repository: add your encryption key to this browser first (Settings → Private repos)')
  }
  if (visibility === 'private' && !resumed && privateCreate !== undefined) {
    const current = usableEncryptionKey((await fetchIdentityKeys(sdk, ownerId)) ?? [], forge.core)
    if (current === null) throw new Error('cannot create a private repository: your identity has no encryption key')
    if (current.keyId !== privateCreate.ops.keyId) {
      throw new Error(
        `cannot create a private repository: your identity's current encryption key is key ${current.keyId}, but this browser holds key ${privateCreate.ops.keyId}; add key ${current.keyId} here (Settings → Private repos)`,
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
        data: membershipData(repo, ownerId),
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
      data: withVis(visibility, DOC.config, { repoId: R, defaultBranch: input.defaultBranch ?? 'main', backend: { mode: 0 } }),
      intent: `${key}:config`,
    })
  })

  await idbDelete('journal', key)
  invalidateMembers(repo, auth.network)
  return { repoId, name }
}
