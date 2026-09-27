/**
 * Issue/PR thread composition (view glue) — read comments and interleave them with the folded
 * event log into a single chronological timeline for the detail view.
 *
 * State itself (open/closed, labels) is the deterministic fold done by the core `readIssue` /
 * `readPull` (`foldIssueStateV2` / `foldPrStateV2` over `event` + `authorEvent`); this module
 * only adds the human thread (comments + rendered events + reviews) and the PR's counted
 * approvals (`countApprovals`, `forge-v2.md` §6).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import {
  DOC,
  asIdentifierString,
  byteFieldToHex,
  num,
  readAnchor,
  readIssue,
  readPull,
  readReviews,
  readRoleOracle,
  readTargetLog,
  repoSource,
  str,
  wellFormed,
  type CommentAnchor,
  type IssueView,
  type PullView,
  type RepoRef,
  type ReviewView,
} from '../repo'
import { queryAllDocuments, queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { compareKey, type Event } from '../rules'
import { countApprovals, type Approvals, type Role } from '../rules/v2'
import { summarizeReviews, type ReviewSummary } from './review-fold'

/** One comment on an issue/PR. */
export interface CommentView {
  readonly id: string
  readonly author: string
  /** The body to render: an anchor block, when there was one, is stripped. */
  readonly body: string
  readonly createdAt: number
  /** The parent comment of a threaded reply (`replyTo`), or null. */
  readonly replyTo: string | null
  /** Where an inline comment points (the contract fields, else the body block), or null. */
  readonly anchor: CommentAnchor | null
}

/** A comment document as a {@link CommentView} (anchor fields first, then the body block). */
export function toCommentView(d: PlainDocument): CommentView {
  const n = (f: string): number | undefined => (d[f] === undefined || d[f] === null ? undefined : num(d, f))
  const { anchor, body } = readAnchor({
    ...(typeof d['path'] === 'string' ? { path: d['path'] } : {}),
    ...(n('line') !== undefined ? { line: n('line') } : {}),
    ...(n('side') !== undefined ? { side: n('side') } : {}),
    commitOid: byteFieldToHex(d, 'commitOid'),
    body: str(d, 'body'),
  })
  const replyTo = asIdentifierString(d['replyTo'])
  return {
    id: str(d, '$id'),
    author: str(d, '$ownerId'),
    body,
    createdAt: num(d, '$createdAt'),
    replyTo: replyTo === '' ? null : replyTo,
    anchor,
  }
}


/**
 * Read **every** comment on a target (issue/PR), oldest first.
 *
 * Paged rather than capped: `readThread` interleaves these with the event log, which is
 * itself read to completion, and a thread that silently stopped at comment 100 would show a
 * materially different conversation than any paging client — with no marker saying so.
 */
export async function readComments(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<CommentView[]> {
  const documents = await queryAllDocuments(
    sdk,
    repoSource(repo).targetQuery(DOC.comment, {
      where: [['targetId', '==', targetId]],
      orderBy: [
        ['targetId', 'asc'],
        ['$createdAt', 'asc'],
      ],
    }),
  )
  // Private repo: a stranger's ciphertext is shown to no one (`forge-v2.md` §5), as in the
  // lists.
  const oracle = repo.visibility === 'private' ? await readRoleOracle(sdk, repo) : null
  return documents
    .filter((d) => wellFormed(repo, 'comment', d))
    .filter((d) => oracle === null || oracle.currentRole(str(d, '$ownerId')) !== null)
    .map(toCommentView)
}

/** A merged timeline item: a comment or a state event. */
export type TimelineItem =
  | { readonly kind: 'comment'; readonly at: number; readonly comment: CommentView }
  | {
      readonly kind: 'event'
      readonly at: number
      readonly event: Event
      /** An `authorEvent`: the author's own close/reopen (`forge-v2.md` §3). */
      readonly byAuthor?: boolean
    }
  | { readonly kind: 'review'; readonly at: number; readonly review: ReviewView }

/** Find an issue or patch document by its `number` field, or null. */
async function docByNumber(
  sdk: EvoSDK,
  repo: RepoRef,
  type: 'issue' | 'patch',
  number: number,
): Promise<PlainDocument | null> {
  const { documents } = await queryDocumentsWithProof(
    sdk,
    repoSource(repo).repoQuery(DOC[type], {
      where: [['number', '==', number]],
      limit: 1,
    }),
  )
  const doc = documents[0]
  return doc !== undefined && wellFormed(repo, type, doc) ? doc : null
}

/** A full issue detail: the folded issue + its merged timeline. */
export interface IssueThread {
  readonly issue: IssueView
  readonly timeline: TimelineItem[]
}

/** Load an issue (folded state) + its comment/event timeline by number. Null if not found. */
export async function loadIssueThread(sdk: EvoSDK, repo: RepoRef, number: number): Promise<IssueThread | null> {
  const doc = await docByNumber(sdk, repo, 'issue', number)
  if (!doc) return null
  const id = str(doc, '$id')
  // One read of the target's log serves both the fold and the timeline.
  const [log, comments] = await Promise.all([
    readTargetLog(sdk, repo, id),
    readComments(sdk, repo, id),
  ])
  const issue = await readIssue(sdk, repo, doc, log)
  return { issue, timeline: mergeTimeline(comments, log.events, log.authorEvents, []) }
}

/** The counted approvals of a PR, and what each reviewer's role is now. */
export interface PullApprovals extends Approvals {
  /** Each counted reviewer's current role (null once revoked — then they do not count). */
  readonly roles: ReadonlyMap<string, Role | null>
  /** Every reviewer's standing, counted or not, for the header (`summarizeReviews`). */
  readonly summary: ReviewSummary
}

/** A full PR detail: the folded pull + its merged timeline. */
export interface PullThread {
  readonly pull: PullView
  readonly timeline: TimelineItem[]
  /** Every comment, for placing inline threads on the diff. */
  readonly comments: readonly CommentView[]
  /**
   * The reviews that count on the current head (`countApprovals`). Null when the membership
   * could not be read.
   */
  readonly approvals: PullApprovals | null
}

/**
 * Load a PR (folded state) + its timeline by number. Null if not found.
 *
 * A PR's timeline includes its `review` documents, which nothing read until now — an
 * approve or a request-for-changes was a paid-for record the contributor could not see.
 * Reviews are keyed by `patchId`, so unlike comments and events they are a PR-only read.
 */
export async function loadPullThread(sdk: EvoSDK, repo: RepoRef, number: number): Promise<PullThread | null> {
  const doc = await docByNumber(sdk, repo, 'patch', number)
  if (!doc) return null
  const id = str(doc, '$id')
  const [log, comments, reviews] = await Promise.all([
    readTargetLog(sdk, repo, id),
    readComments(sdk, repo, id),
    readReviews(sdk, repo, id),
  ])
  const pull = await readPull(sdk, repo, doc, log)
  const dismissed = new Set(pull.review.dismissedReviews.map((d) => d.reviewId))
  const approvals = await readApprovals(sdk, repo, reviews, pull.headOid, dismissed, pull.author)
  return { pull, timeline: mergeTimeline(comments, log.events, log.authorEvents, reviews), comments, approvals }
}

/** A PR's counted approvals, or null when the membership could not be read. */
async function readApprovals(
  sdk: EvoSDK,
  repo: RepoRef,
  reviews: readonly ReviewView[],
  headOid: string,
  dismissed: ReadonlySet<string>,
  author: string,
): Promise<PullApprovals | null> {
  try {
    const oracle = await readRoleOracle(sdk, repo)
    const input = reviews.map((r) => ({
      id: r.id,
      reviewer: r.reviewer,
      verdict: r.verdictCode,
      commitOid: r.commitOid,
      createdAt: r.createdAt,
    }))
    const counted = countApprovals(input, oracle, headOid, dismissed)
    const reviewers = [...counted.approvers, ...counted.changesRequested]
    return {
      ...counted,
      roles: new Map(reviewers.map((who) => [who, oracle.currentRole(who)])),
      summary: summarizeReviews(input, oracle, headOid, author),
    }
  } catch {
    return null
  }
}

/** Read comments + events for a target and merge them into one chronological timeline. */
export async function readThread(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<TimelineItem[]> {
  const [comments, log] = await Promise.all([
    readComments(sdk, repo, targetId),
    readTargetLog(sdk, repo, targetId),
  ])
  return mergeTimeline(comments, log.events, log.authorEvents, [])
}

/** Interleave a thread's parts by `($createdAt, $id)`. */
function mergeTimeline(
  comments: readonly CommentView[],
  events: readonly Event[],
  authorEvents: readonly Event[],
  reviews: readonly ReviewView[],
): TimelineItem[] {
  const eventItem = (e: Event, byAuthor: boolean) => ({
    kind: 'event' as const,
    at: e.createdAt,
    id: e.id ?? '',
    event: e,
    ...(byAuthor ? { byAuthor } : {}),
  })
  const items: (TimelineItem & { readonly id: string })[] = [
    ...comments.map((c) => ({ kind: 'comment' as const, at: c.createdAt, id: c.id, comment: c })),
    ...events.map((e) => eventItem(e, false)),
    ...authorEvents.map((e) => eventItem(e, true)),
    ...reviews.map((r) => ({ kind: 'review' as const, at: r.createdAt, id: r.id, review: r })),
  ]
  items.sort((a, b) => compareKey({ id: a.id, createdAt: a.at }, { id: b.id, createdAt: b.at }))
  return items
}
