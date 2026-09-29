/**
 * Review-parity writes (`docs/design/review-parity-spec.md` §3, §4): the review event kinds
 * (thread resolution, review requests and dismissals, head updates, draft/ready, milestones),
 * a pending review submitted as one `review` plus its `reviewId` comments (resumable), a
 * branch `policy`, and edits (title/body of an issue or PR, a comment's body) through
 * {@link replaceDocumentIdempotent}. Parity: forge-core `collab::v2` (`post_target_event`,
 * `review`, `comment`, `set_policy`).
 *
 * Consensus enforces every gate (forge-v2.md §2, §3): an `event` needs a maintainer or writer,
 * an `authorEvent` needs the target's author and an author kind, a `policy` a maintainer, a
 * `reviewId` comment the reviewer, an edit the document's owner. These helpers pick the route
 * and refuse what would certainly be refused, before anything is signed.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { hexToBytes } from '@noble/hashes/utils.js'

import { decodeIdentifier } from '../auth/base58'
import { idbDelete, idbGet, idbPut } from '../idb'
import { isLegalRefName, isRc1OidHex } from '../rules'
import { anchorOf, groupReviewComments, isAuthorKind, type AnchorFields, type Policy } from '../rules/v2'
import type { EventKind } from '../rules'
import {
  ConsensusRefusal,
  precheckEdit,
  deleteDocumentIdempotent,
  type DeleteResult,
  GATE_REFUSED_CODE,
  queryAllDocuments,
  replaceDocumentIdempotent,
  type ReplaceResult,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { DOC, asIdentifierString, byteFieldToHex, num, str, type RepoRef } from './contract'
import { invalidateRepoFeed, readReviews } from './issues'
import { sealEdit } from './private-writes'
import { repoSource } from './source'
import { admitAll, gateFor } from './private-content'
import { privateWriterWithSession, type PrivateWriter } from './private-writes'
import type { PrivateSession } from './private-session'
import {
  EVENT_KIND_CODE,
  LOCKED_REASON,
  TRANSITION_EVENT_KINDS,
  VERDICT_INT,
  commentProof,
  contractFor,
  eventRoute,
  refusePlaintextInPrivate,
  reviewVerdictFields,
  writeRepoDoc,
  type PostContext,
  type VerdictInput,
  type WriteTarget,
} from './writes'

export { EVENT_KIND_CODE, eventRoute }

/** The payload of a state event (forge-v2.md §3). */
export interface EventPayload {
  /** A label, an assignee, a retarget base, a dismissal reason, a milestone. */
  readonly value?: string
  /** A merge commit or a new head, hex. */
  readonly oidHex?: string
  /** A thread root comment, a reviewer identity or a review, base58. */
  readonly refId?: string
}

const REF_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['threadResolve', 'threadUnresolve', 'reviewRequest', 'reviewRequestRemove', 'reviewDismiss'])

/** Kinds that carry an identity in `value` and, from F-1 on, the same identity in `refId`. */
const ASSIGN_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['assign', 'unassign'])

/**
 * The document data of an event of `kind` on `target`, refusing a payload the kind needs but
 * lacks (the folds would ignore such a document): 11–15 a `refId`, 16 a 20–32 byte oid, 17 a
 * value. Parity: forge-core `event_payload_props`.
 */
export function targetEventData(target: WriteTarget, kind: EventKind, payload: EventPayload = {}): Record<string, unknown> {
  // RC1: state changes and locks are transitions; the contract refuses them as events (`noState`, kind ≥ 4).
  if (TRANSITION_EVENT_KINDS.has(kind)) throw new Error(`${kind} is a transition, not an event`)
  if (REF_KINDS.has(kind) && !payload.refId) throw new Error(`a ${kind} event needs a refId`)
  const oid = payload.oidHex ? hexToBytes(payload.oidHex) : null
  // The folds read only 40- or 64-hex heads (SHA-1 or SHA-256): anything else would be inert.
  if (kind === 'headUpdate' && oid?.length !== 20 && oid?.length !== 32) throw new Error('a head update needs a 20- or 32-byte commit oid')
  if (kind === 'milestoneSet' && !payload.value) throw new Error('a milestone needs a name')
  if ((kind === 'labelAdd' || kind === 'labelRemove') && !payload.value?.trim()) throw new Error('a label event needs a label name')
  // An assignee is `value` (what the fold reads, forge-v2.md §3) and `refId` (so the sparse
  // `addressee (refId)` index answers "assigned to me", platform-parity-spec §1.2): both the
  // same identity.
  if (ASSIGN_KINDS.has(kind) && (!payload.value || payload.refId !== payload.value)) {
    throw new Error(`an ${kind} event names the assignee in both value and refId`)
  }
  if (kind === 'retarget' && !(payload.value !== undefined && isLegalRefName(payload.value))) {
    throw new Error(`illegal retarget base ref name ${JSON.stringify(payload.value ?? null)}`)
  }
  // The schema's bounds on `value`: 120 characters and 480 bytes (forge-core `check_text`).
  if (payload.value !== undefined && ([...payload.value].length > 120 || new TextEncoder().encode(payload.value).length > 480)) {
    throw new Error('an event value is at most 120 characters and 480 bytes')
  }
  const data: Record<string, unknown> = {
    targetId: decodeIdentifier(target.id),
    targetNumber: target.number,
    kind: EVENT_KIND_CODE[kind],
  }
  if (payload.value) data['value'] = payload.value
  if (oid !== null) data['oid'] = oid
  if (payload.refId) data['refId'] = decodeIdentifier(payload.refId)
  return data
}

/** Create one repo-scoped document, dropping the caches it invalidates. */
const write = writeRepoDoc

/**
 * Post an event of any kind by whichever route the viewer holds ({@link eventRoute}). When the
 * membership read was stale (a member event refused at the gate) and the viewer is the author
 * of an author kind, it retries as an `authorEvent`.
 */
export async function postTargetEvent(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; kind: EventKind; author: string; isMember: boolean; payload?: EventPayload; intent?: string },
): Promise<WriteResult & { readonly route: 'event' | 'authorEvent' }> {
  const route = eventRoute({ viewer: auth.identityId, author: input.author, isMember: input.isMember, kind: input.kind })
  if (route === null) {
    throw new Error(isAuthorKind(input.kind) ? 'only the author or a maintainer or writer can do that' : 'only a maintainer or writer can do that')
  }
  const data = targetEventData(input.target, input.kind, input.payload)
  if (route === 'authorEvent') return { ...(await write(sdk, auth, repo, DOC.authorEvent, data, input.intent)), route }
  try {
    return { ...(await write(sdk, auth, repo, DOC.event, data, input.intent)), route }
  } catch (e) {
    const gateRefused = e instanceof ConsensusRefusal && e.code === GATE_REFUSED_CODE
    if (gateRefused && auth.identityId === input.author && isAuthorKind(input.kind)) {
      const intent = input.intent ? `${input.intent}:author` : undefined
      return { ...(await write(sdk, auth, repo, DOC.authorEvent, data, intent)), route: 'authorEvent' }
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Comments with anchors, reviews with comment counts
// ---------------------------------------------------------------------------

/** An inline comment's anchor to write (a file-level comment has only `path`). */
export interface AnchorInput {
  readonly path: string
  readonly line?: number
  readonly startLine?: number
  /** 0 old, 1 new. */
  readonly side?: 0 | 1
  /** hex. */
  readonly commitOid?: string
}

/** The anchor fields of a `comment`, refusing what `anchorOf` would read as malformed. */
export function anchorData(a: AnchorInput): Record<string, unknown> {
  if (a.path === '' || new TextEncoder().encode(a.path).length > 1000) throw new Error('an inline comment needs a path of at most 1000 bytes')
  if (a.line === undefined && (a.side !== undefined || a.startLine !== undefined)) throw new Error('a side or start line needs a line')
  if (a.line !== undefined && a.side === undefined) throw new Error('a line needs a side')
  if (a.startLine !== undefined && a.line !== undefined && a.startLine > a.line) throw new Error('a range must start at or before its last line')
  if (a.commitOid && !isRc1OidHex(a.commitOid)) throw new Error('an inline comment names a 20- or 32-byte commit')
  const data: Record<string, unknown> = { path: a.path }
  if (a.line !== undefined) data['line'] = a.line
  if (a.side !== undefined) data['side'] = a.side
  if (a.startLine !== undefined && a.startLine !== a.line) data['startLine'] = a.startLine
  if (a.commitOid) data['commitOid'] = hexToBytes(a.commitOid)
  return data
}

/** A comment (general, inline, a reply, or a review's). */
export interface CommentInput {
  readonly targetId: string
  readonly body: string
  readonly replyTo?: string
  readonly anchor?: AnchorInput
  /** The review this comment belongs to (the signer's, on the same PR: consensus). */
  readonly reviewId?: string
  readonly intent?: string
  /** Whether the signer is a member and the thread locked (a member's post to a locked thread proves membership). */
  readonly post?: PostContext
}

/**
 * The document data of a comment signed by `signer`. `replyTo` must be a thread's root (RC1
 * R-14); a member's comment on a locked thread carries the membership proof ({@link commentProof}).
 */
export function commentData(input: CommentInput, signer: string): Record<string, unknown> {
  if (input.body.trim() === '') throw new Error('a comment needs a body')
  if (input.post?.locked === true && !input.post.isMember) throw new Error(LOCKED_REASON)
  const data: Record<string, unknown> = { targetId: decodeIdentifier(input.targetId), body: input.body }
  if (input.replyTo) data['replyTo'] = decodeIdentifier(input.replyTo)
  if (input.anchor) Object.assign(data, anchorData(input.anchor))
  if (input.reviewId) data['reviewId'] = decodeIdentifier(input.reviewId)
  return { ...data, ...commentProof(signer, input.post) }
}

/** Post one comment (a "single comment", review-parity R2). */
export function postComment(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, input: CommentInput): Promise<WriteResult> {
  return write(sdk, auth, repo, DOC.comment, commentData(input, auth.identityId), input.intent)
}

/** A review verdict with the number of comments the submit will attach. */
export interface ReviewInput {
  readonly patchId: string
  readonly verdict: VerdictInput
  /** The PR's current (folded) head, hex. */
  readonly commitOid: string
  readonly body?: string
  readonly commentCount?: number
  readonly intent?: string
  /** Whether the signer is a member and the PR locked: picks 1/2 with a proof or 4/5 ({@link reviewVerdictFields}). */
  readonly post: PostContext
}

/** The document data of a review signed by `signer`. */
export function reviewData(input: ReviewInput, signer: string): Record<string, unknown> {
  if (input.post.locked === true && !input.post.isMember) throw new Error(LOCKED_REASON)
  if (!isRc1OidHex(input.commitOid)) throw new Error('a review names a 20- or 32-byte commit')
  const data: Record<string, unknown> = {
    patchId: decodeIdentifier(input.patchId),
    ...reviewVerdictFields(input.verdict, signer, input.post),
    commitOid: hexToBytes(input.commitOid),
  }
  if (input.body) data['body'] = input.body
  if (input.commentCount !== undefined) {
    if (!Number.isInteger(input.commentCount) || input.commentCount < 0 || input.commentCount > 65535) throw new Error('a review holds 0-65535 comments')
    data['commentCount'] = input.commentCount
  }
  return data
}

// ---------------------------------------------------------------------------
// Pending review, submitted as one review + N comments (resumable)
// ---------------------------------------------------------------------------

/** One pending inline comment of a draft review. */
export interface DraftComment {
  /** Stable within the draft (the intent of its write). */
  readonly localId: string
  readonly anchor: AnchorInput
  readonly body: string
  /** Set once the comment landed. */
  readonly landedId?: string
}

/**
 * A pending review, kept in IndexedDB (`journal`) until it is submitted: nothing is on chain
 * before the submit (review-parity spec §4.1). `reviewId` is set once the review document
 * landed, `landedId` per comment once each comment did, so a failed submit resumes where it
 * stopped with the same intents (the write engine re-broadcasts the same bytes).
 */
export interface ReviewDraft {
  readonly draftId: string
  /**
   * A private repo's draft: its summary and comments are the repo's plaintext, so it is kept in
   * this page's memory only (never IndexedDB, which outlives a locked vault).
   */
  readonly private?: boolean
  readonly network: string
  readonly identity: string
  readonly repoId: string
  readonly prId: string
  /** The head the comments are anchored to, hex. */
  readonly headOid: string
  readonly verdict: VerdictInput
  readonly summary: string
  readonly comments: readonly DraftComment[]
  readonly reviewId?: string
  readonly startedAt: number
  /**
   * When the first submit attempt began (client ms), saved before anything is written. Only a
   * draft with an attempt on record can have writes on chain that it does not know about, so
   * only such a draft is reconciled ({@link reconcileReviewDraft}).
   */
  readonly attemptedAt?: number
}

/** The journal key of a draft: one per network, identity and PR. */
export function reviewDraftKey(network: string, identity: string, prId: string): string {
  return `review:${network}:${identity}:${prId}`
}

/** Private repos' drafts: this page's memory only (see {@link ReviewDraft.private}). */
const memoryDrafts = new Map<string, ReviewDraft>()

export async function loadReviewDraft(network: string, identity: string, prId: string): Promise<ReviewDraft | undefined> {
  const key = reviewDraftKey(network, identity, prId)
  const memory = memoryDrafts.get(key)
  if (memory !== undefined) return memory
  const stored = await idbGet<ReviewDraft>('journal', key)
  // A private draft never belongs in IndexedDB (one from an earlier build is dropped).
  if (stored?.private === true) {
    await idbDelete('journal', key)
    return undefined
  }
  return stored
}

/** Keep a draft: in memory for a private repo (`repo`, or the draft's own flag), else IndexedDB. */
export function saveReviewDraft(draft: ReviewDraft, repo?: RepoRef): Promise<void> {
  const key = reviewDraftKey(draft.network, draft.identity, draft.prId)
  if (draft.private === true || repo?.visibility === 'private') {
    memoryDrafts.set(key, { ...draft, private: true })
    return idbDelete('journal', key)
  }
  return idbPut('journal', key, draft)
}

export function discardReviewDraft(network: string, identity: string, prId: string): Promise<void> {
  const key = reviewDraftKey(network, identity, prId)
  memoryDrafts.delete(key)
  return idbDelete('journal', key)
}

/** Progress of a submit: `done` of `total` documents written. */
export interface SubmitProgress {
  readonly done: number
  readonly total: number
}

/** The outcome of a finished submit. */
export interface SubmittedReview {
  readonly reviewId: string
  readonly commentIds: readonly string[]
}

/** A review on the PR, as the reconcile step reads it. */
export interface ChainReview {
  readonly id: string
  readonly reviewer: string
  /** 1 approve, 2 request changes, 3 comment. */
  readonly verdict: number
  /** hex. */
  readonly commitOid: string
  readonly body: string
  readonly commentCount: number | null
  readonly createdAt: number
}

/** A comment on the PR, as the reconcile step reads it. */
export interface ChainComment {
  readonly id: string
  readonly owner: string
  readonly reviewId: string | null
  readonly body: string
  readonly anchor: AnchorFields
  readonly createdAt: number
}

/** What a submit reads from chain to reconcile a resumed draft (injectable for tests). */
export interface SubmitReads {
  readonly reviews: () => Promise<readonly ChainReview[]>
  readonly comments: () => Promise<readonly ChainComment[]>
}

/** The chain reads of {@link SubmitReads} for a PR, through the proof-checked readers. */
export function chainReads(sdk: EvoSDK, repo: RepoRef, prId: string): SubmitReads {
  return {
    reviews: async () =>
      (await readReviews(sdk, repo, prId)).map((r) => ({
        id: r.id,
        reviewer: r.reviewer,
        verdict: r.verdictCode,
        commitOid: r.commitOid,
        body: r.body,
        commentCount: r.commentCount,
        createdAt: r.createdAt,
      })),
    comments: async () => {
      const raw = await queryAllDocuments(
        sdk,
        repoSource(repo).targetQuery(DOC.comment, {
          where: [['targetId', '==', prId]],
          orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']],
        }),
      )
      // A private repo's comments are compared decrypted (the gate opens them with the reader's keys).
      const { docs } = await admitAll(gateFor(repo), 'comment', raw)
      return docs.map((d) => ({
        id: str(d, '$id'),
        owner: str(d, '$ownerId'),
        reviewId: asIdentifierString(d['reviewId']) || null,
        body: str(d, 'body'),
        anchor: {
          path: typeof d['path'] === 'string' ? d['path'] : null,
          line: typeof d['line'] === 'number' ? d['line'] : null,
          startLine: typeof d['startLine'] === 'number' ? d['startLine'] : null,
          side: typeof d['side'] === 'number' ? d['side'] : null,
          commitOid: byteFieldToHex(d, 'commitOid'),
        },
        createdAt: num(d, '$createdAt'),
      }))
    },
  }
}

/** Whether a stored comment is the draft comment `c` (same anchor and body). */
function sameComment(stored: ChainComment, c: DraftComment, headOid: string): boolean {
  const a = anchorOf(stored.anchor)
  const want = anchorOf({ ...c.anchor, commitOid: c.anchor.commitOid ?? headOid })
  return a !== null && want !== null && stored.body === c.body && JSON.stringify(a) === JSON.stringify(want)
}

/** Whether a landed verdict code is `verdict`, as a member (1/2/3) or a non-member (4/5) wrote it. */
function sameVerdict(code: number, verdict: VerdictInput): boolean {
  return code === VERDICT_INT[verdict] || (verdict === 'approve' && code === 4) || (verdict === 'requestChanges' && code === 5)
}

/** How far the client clock may be ahead of block time when matching a landed review. */
const CLOCK_SKEW_MS = 10 * 60 * 1000

/**
 * Reconcile a resumed draft with the chain: a write that landed but whose save did not (a
 * crash, a closed tab) must not be written again. Only a draft with an attempt on record
 * (`attemptedAt`) is reconciled: before its first submit nothing of it can be on chain. The
 * review is this identity's review on the PR with the draft's verdict, head, summary and
 * `commentCount`, created no earlier than the attempt (less {@link CLOCK_SKEW_MS}: `attemptedAt`
 * is the client's clock, `$createdAt` the block's), the earliest such when the draft has no
 * `reviewId`; its landed comments are the review's group (`groupReviewComments`) matched to
 * the draft by anchor and body.
 */
export async function reconcileReviewDraft(draft: ReviewDraft, reads: SubmitReads): Promise<ReviewDraft> {
  if (draft.attemptedAt === undefined) return draft
  const since = draft.attemptedAt - CLOCK_SKEW_MS
  let reviewId = draft.reviewId
  if (reviewId === undefined) {
    const mine = (await reads.reviews())
      .filter(
        (r) =>
          r.reviewer === draft.identity &&
          sameVerdict(r.verdict, draft.verdict) &&
          r.commitOid === draft.headOid &&
          r.body === draft.summary &&
          r.commentCount === draft.comments.length &&
          r.createdAt >= since,
      )
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    reviewId = mine[0]?.id
  }
  if (reviewId === undefined) return draft
  if (draft.comments.every((c) => c.landedId)) return { ...draft, reviewId }
  const stored = await reads.comments()
  const group = new Set(groupReviewComments(reviewId, draft.identity, draft.comments.length, stored).comments)
  const claimed = new Set(draft.comments.flatMap((c) => (c.landedId ? [c.landedId] : [])))
  const comments = draft.comments.map((c) => {
    if (c.landedId) return c
    const match = stored.find((s) => group.has(s.id) && !claimed.has(s.id) && sameComment(s, c, draft.headOid))
    if (match === undefined) return c
    claimed.add(match.id)
    return { ...c, landedId: match.id }
  })
  return { ...draft, reviewId, comments }
}

/**
 * Submit a pending review: the `review` first (its comments name it), with `commentCount` =
 * the draft's comments, then each comment with `reviewId`, in draft order. The draft is saved
 * after every landed document and removed at the end. A resumed draft is first reconciled with
 * the chain ({@link reconcileReviewDraft}), so a write that landed without its save is adopted,
 * never written twice. Throws the write's error; the caller reports "recorded with n of m
 * comments" from the saved draft.
 */
export async function submitReviewDraft(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  draft: ReviewDraft,
  post: PostContext,
  onProgress?: (p: SubmitProgress) => void,
  reads?: SubmitReads,
): Promise<SubmittedReview> {
  if (draft.identity !== auth.identityId) throw new Error('this pending review belongs to another identity')
  // A private repo: the reconcile reads the draft's landed comments decrypted, which needs the
  // reader's session (without it none would match and each would be posted again).
  if (repo.visibility === 'private' && repo.session === undefined) throw new Error("a private repo's review is submitted by a member reading it with their key")
  // One writer (one fresh key read) for the review and all its comments.
  const fresh = repo.visibility === 'private' ? await privateWriterWithSession(sdk, auth, repo) : undefined
  try {
    return await submitWith(sdk, auth, repo, draft, post, fresh, onProgress, reads)
  } finally {
    fresh?.session.close()
  }
}

async function submitWith(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  draft: ReviewDraft,
  post: PostContext,
  fresh: { writer: PrivateWriter; session: PrivateSession } | undefined,
  onProgress?: (p: SubmitProgress) => void,
  reads?: SubmitReads,
): Promise<SubmittedReview> {
  const writer = fresh?.writer
  if (repo.visibility === 'private' && draft.private !== true) draft = { ...draft, private: true }
  // The reconcile reads through the writer's fresh session: a comment an earlier attempt sealed
  // under a newer epoch than the page's session knows still opens, and is not posted again.
  const chain = reads ?? chainReads(sdk, fresh ? { ...repo, session: fresh.session } : repo, draft.prId)
  let current: ReviewDraft = await reconcileReviewDraft(draft, chain)
  if (current.attemptedAt === undefined) current = { ...current, attemptedAt: Date.now() }
  // Saved before the first write, so a crash after it leaves a draft that reconciles.
  if (current !== draft) await saveReviewDraft(current)
  const total = 1 + draft.comments.length
  const done = () => (current.reviewId ? 1 : 0) + current.comments.filter((c) => c.landedId).length
  onProgress?.({ done: done(), total })
  let reviewId = current.reviewId
  if (reviewId === undefined) {
    const r = await write(sdk, auth, repo, DOC.review, reviewData({
      patchId: draft.prId,
      verdict: draft.verdict,
      commitOid: draft.headOid,
      body: draft.summary,
      commentCount: draft.comments.length,
      post,
    }, auth.identityId), `review:${draft.draftId}:review`, writer)
    reviewId = r.documentId
    current = { ...current, reviewId }
    await saveReviewDraft(current)
    onProgress?.({ done: done(), total })
  }
  const ids: string[] = []
  for (const [i, c] of current.comments.entries()) {
    if (c.landedId) {
      ids.push(c.landedId)
      continue
    }
    const r = await write(sdk, auth, repo, DOC.comment, commentData({
      targetId: draft.prId,
      body: c.body,
      anchor: { ...c.anchor, commitOid: c.anchor.commitOid ?? draft.headOid },
      reviewId,
      post,
    }, auth.identityId), `review:${draft.draftId}:comment:${c.localId}`, writer)
    ids.push(r.documentId)
    const comments = [...current.comments]
    comments[i] = { ...c, landedId: r.documentId }
    current = { ...current, comments }
    await saveReviewDraft(current)
    onProgress?.({ done: done(), total })
  }
  await discardReviewDraft(draft.network, draft.identity, draft.prId)
  return { reviewId, commentIds: ids }
}

// ---------------------------------------------------------------------------
// Policy and edits
// ---------------------------------------------------------------------------

/**
 * The `policy` document data for `policy`, refusing what the contract refuses (RC1 R-08): 0-10
 * approvals, `mergeMethods` 0-15, at most 10 distinct required checks, and `requiredCheckSources`
 * either empty or one source (a runner or maintainer id) per required check, in the same order.
 * A policy read with required checks keeps them (and their sources) on a rewrite.
 */
export function policyData(policy: Policy): Record<string, unknown> {
  if (!Number.isInteger(policy.requiredApprovals) || policy.requiredApprovals < 0 || policy.requiredApprovals > 10) throw new Error('a policy requires 0-10 approvals')
  const role = policy.approverRole ?? 0
  if (role !== 0 && role !== 1) throw new Error('approverRole is 0 (any member) or 1 (maintainers)')
  const methods = policy.mergeMethods ?? 0
  if (!Number.isInteger(methods) || methods < 0 || methods > 15) throw new Error('mergeMethods is a 4-bit set (0-15)')
  const checks = policy.requiredChecks ?? []
  const sources = policy.requiredCheckSources ?? []
  if (checks.length > 10 || new Set(checks).size !== checks.length || checks.some((c) => c === '')) throw new Error('a policy names at most 10 distinct required checks')
  if (sources.length !== 0 && sources.length !== checks.length) throw new Error('each required check needs its source (or none has one)')
  return {
    requiredApprovals: policy.requiredApprovals,
    approverRole: role,
    requireChecks: policy.requireChecks ?? false,
    mergeMethods: methods,
    ...(checks.length > 0 ? { requiredChecks: [...checks] } : {}),
    ...(sources.length > 0 ? { requiredCheckSources: sources.map((id) => decodeIdentifier(id)) } : {}),
  }
}

/** Set the branch policy (maintainers only at consensus). */
export function setPolicy(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, policy: Policy, intent?: string): Promise<WriteResult> {
  return write(sdk, auth, repo, DOC.policy, policyData(policy), intent)
}

/**
 * Assign or unassign `assignee` on an issue or PR (members only at consensus: an `authorEvent`
 * cannot carry these kinds). The identity is both `value` and `refId`.
 */
export async function setAssignee(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; assignee: string; assign: boolean; intent?: string },
): Promise<WriteResult> {
  const data = targetEventData(input.target, input.assign ? 'assign' : 'unassign', { value: input.assignee, refId: input.assignee })
  return write(sdk, auth, repo, DOC.event, data, input.intent)
}

/**
 * Pin / unpin an issue or PR (event kinds 19/20, members only at consensus). Lock and unlock are
 * transitions in RC1 (`setLock` in `writes.ts`); the retired lock events 21/22 are refused.
 */
export async function setThreadFlag(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; flag: 'pin'; on: boolean; intent?: string },
): Promise<WriteResult> {
  return write(sdk, auth, repo, DOC.event, targetEventData(input.target, input.on ? 'pin' : 'unpin'), input.intent)
}

/** Put an issue or PR in milestone `title` (null: take it out). Members only at consensus. */
export async function setMilestone(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; title: string | null; intent?: string },
): Promise<WriteResult> {
  const data = input.title === null ? targetEventData(input.target, 'milestoneClear') : targetEventData(input.target, 'milestoneSet', { value: input.title })
  return write(sdk, auth, repo, DOC.event, data, input.intent)
}

/** Apply or remove a label on an issue or PR (members only at consensus). */
export async function setLabel(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; label: string; add: boolean; intent?: string },
): Promise<WriteResult> {
  const data = targetEventData(input.target, input.add ? 'labelAdd' : 'labelRemove', { value: input.label.trim() })
  return write(sdk, auth, repo, DOC.event, data, input.intent)
}

/**
 * What a private repo's edit needs to re-seal it (`sealEdit`, `private-writes.ts`): the
 * decrypted content now (`current`, e.g. the issue's title and body as the page shows them),
 * the plaintext bind fields the seal covers (`bind`: an issue's `number`, a comment's
 * `targetId`), and for a PR its own epoch.
 */
export interface SealContext {
  readonly current: Readonly<Record<string, unknown>>
  readonly bind: Readonly<Record<string, unknown>>
  readonly patchEpoch?: number
  /** An imported document's provenance as read (decrypted): kept in the re-sealed content. */
  readonly imported?: Readonly<Record<string, unknown>> | null
}

/** The content fields a sealed replace clears when a legacy plaintext copy sits next to `enc`. */
const PLAINTEXT_OF: Readonly<Record<'issue' | 'patch' | 'comment', readonly string[]>> = { issue: ['title', 'body'], patch: ['title', 'body'], comment: ['body'] }

/**
 * Replace one of the signer's documents of `repo`, dropping the caches the edit invalidates.
 * In a private repo the content is re-sealed as a whole (`sealEdit`) and the replace sets only
 * `enc` / `epoch`: a plaintext replace would publish the edit next to the sealed `enc`.
 */
async function replace(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  documentType: 'issue' | 'patch' | 'comment',
  documentId: string,
  changes: Record<string, unknown>,
  expectedRevision: bigint | undefined,
  seal: SealContext | undefined,
): Promise<ReplaceResult> {
  let replaced = changes
  if (repo.visibility === 'private') {
    if (seal === undefined) refusePlaintextInPrivate(repo, documentType)
    // A private edit re-seals the whole text: without the revision it was read at, a concurrent
    // edit would be overwritten, not refused (the CLI guards every sealed edit the same way).
    if (expectedRevision === undefined) throw new Error(`a private ${documentType} edit needs the revision it was read at`)
    // The author, the repo and the revision are checked before any key is opened.
    await precheckEdit(sdk, auth, { contractId: contractFor(repo, documentType), documentType, documentId, expectRepoId: repo.repoId, expectedRevision })
    const sealed = await sealEdit(sdk, auth, repo, documentType, { ...seal!.bind }, seal!.current, changes, seal!.patchEpoch, seal!.imported)
    // Legacy plaintext stored next to `enc` goes in the same replace (as the CLI's re-seal does):
    // `undefined` removes a field from the stored document.
    replaced = { ...sealed, ...Object.fromEntries(PLAINTEXT_OF[documentType].map((f) => [f, undefined])) }
  }
  try {
    return await replaceDocumentIdempotent(sdk, auth, {
      contractId: contractFor(repo, documentType),
      documentType,
      documentId,
      changes: replaced,
      repo: repo.repoId,
      expectRepoId: repo.repoId,
      expectedRevision,
    })
  } finally {
    // An edited title or body changes list rows and the index's text search, not open counts.
    invalidateRepoFeed(repo, { counts: false })
  }
}

/** Edit an issue's or PR's title and/or body (its author only; `number` and the PR's head, refs and draft flag are immutable). */
export function updateTarget(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { type: 'issue' | 'patch'; id: string; title?: string; body?: string; expectedRevision?: bigint; seal?: SealContext },
): Promise<ReplaceResult> {
  const changes: Record<string, unknown> = {}
  if (input.title !== undefined) {
    if (input.title.trim() === '') throw new Error('a title is required')
    changes['title'] = input.title
  }
  if (input.body !== undefined) changes['body'] = input.body === '' ? undefined : input.body
  if (Object.keys(changes).length === 0) throw new Error('nothing to change')
  return replace(sdk, auth, repo, input.type, input.id, changes, input.expectedRevision, input.seal)
}

/**
 * Edit a comment's body (its author only; the anchor, thread and review are immutable). Every
 * replace re-validates the comment's references, and removing one is the change consensus allows
 * on a dead reference: pass `dropReviewId` when its review was deleted, `dropReplyTo` when the
 * comment it replies to was (RC1 R-14; the replace would carry the dead `replyTo` over), and
 * `dropProof` when it carries `asMember` but the signer is no longer a member (the proof is
 * re-checked too). An imported comment keeps its proof (`i_provenance`): it cannot be edited then.
 */
export function updateComment(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { id: string; body: string; dropReviewId?: boolean; dropReplyTo?: boolean; dropProof?: boolean; expectedRevision?: bigint; seal?: SealContext },
): Promise<ReplaceResult> {
  if (input.body.trim() === '') throw new Error('a comment needs a body')
  const changes: Record<string, unknown> = { body: input.body }
  if (input.dropReviewId) changes['reviewId'] = undefined
  if (input.dropReplyTo) changes['replyTo'] = undefined
  if (input.dropProof) changes['asMember'] = undefined
  return replace(sdk, auth, repo, 'comment', input.id, changes, input.expectedRevision, input.seal)
}

/**
 * Delete one of the signer's comments (its author only at consensus: the document is
 * owner-deletable). Replies to it stay, and read as replies to a deleted comment. A private repo's
 * comment is deleted the same way (a delete carries no content).
 */
export async function deleteComment(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, id: string): Promise<DeleteResult> {
  try {
    return await deleteDocumentIdempotent(sdk, auth, { contractId: contractFor(repo, DOC.comment), documentType: DOC.comment, documentId: id, repo: repo.repoId })
  } finally {
    invalidateRepoFeed(repo, { counts: false })
  }
}
