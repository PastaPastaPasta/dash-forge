/**
 * Issue/PR thread composition (view glue) — read comments and interleave them with the folded
 * event log into a single chronological timeline for the detail view.
 *
 * State itself (open/closed, labels) is the deterministic fold done by the core `readIssue` /
 * `readPull` (v1 `foldIssueState`, forge-v2 `foldIssueStateV2` over `event` + `authorEvent`);
 * this module only adds the human thread (comments + rendered events + reviews) and, on
 * forge-v2, the PR's counted approvals (`countApprovals`, `forge-v2.md` §6).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import {
  DOC,
  num,
  readIssue,
  readPull,
  readReviews,
  readRoleOracle,
  readTargetLog,
  repoSource,
  str,
  wellFormed,
  type IssueView,
  type PullView,
  type RepoRef,
  type ReviewView,
  type V2RepoRef,
} from '../repo'
import { queryAllDocuments, queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { compareKey, type Event } from '../rules'
import { countApprovals, type Approvals, type Role } from '../rules/v2'

/** One comment on an issue/PR. */
export interface CommentView {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly createdAt: number
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
  // Private forge-v2 repo: a stranger's ciphertext is shown to no one (`forge-v2.md` §5),
  // as in the lists.
  const oracle = repo.kind === 'v2' && repo.visibility === 'private' ? await readRoleOracle(sdk, repo) : null
  return documents
    .filter((d) => wellFormed(repo, 'comment', d))
    .filter((d) => oracle === null || oracle.currentRole(str(d, '$ownerId')) !== null)
    .map((d) => ({
      id: str(d, '$id'),
      author: str(d, '$ownerId'),
      body: str(d, 'body'),
      createdAt: num(d, '$createdAt'),
    }))
}

/** A merged timeline item: a comment or a state event. */
export type TimelineItem =
  | { readonly kind: 'comment'; readonly at: number; readonly comment: CommentView }
  | {
      readonly kind: 'event'
      readonly at: number
      readonly event: Event
      /** forge-v2 `authorEvent`: the author's own close/reopen (`forge-v2.md` §3). */
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
      // v1 keeps the query shape it always sent; forge-v2's unique (repoId, number) needs none.
      ...(repo.kind === 'v1' ? { orderBy: [['number', 'desc']] as const } : {}),
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
  const issue = await readIssue(sdk, repo, doc, undefined, log)
  return { issue, timeline: mergeTimeline(comments, log.events, log.authorEvents, []) }
}

/** The counted approvals of a forge-v2 PR, and what each reviewer's role is now. */
export interface PullApprovals extends Approvals {
  /** Each counted reviewer's current role (null once revoked — then they do not count). */
  readonly roles: ReadonlyMap<string, Role | null>
}

/** A full PR detail: the folded pull + its merged timeline. */
export interface PullThread {
  readonly pull: PullView
  readonly timeline: TimelineItem[]
  /**
   * forge-v2 only: the reviews that count on the current head (`countApprovals`). Null on
   * v1, which has no approval rule, or when the membership could not be read.
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
  const pull = await readPull(sdk, repo, doc, undefined, log)
  const approvals = repo.kind === 'v2' ? await readApprovals(sdk, repo, reviews, pull.headOid) : null
  return { pull, timeline: mergeTimeline(comments, log.events, log.authorEvents, reviews), approvals }
}

/** A forge-v2 PR's counted approvals, or null when the membership could not be read. */
async function readApprovals(
  sdk: EvoSDK,
  repo: V2RepoRef,
  reviews: readonly ReviewView[],
  headOid: string,
): Promise<PullApprovals | null> {
  try {
    const oracle = await readRoleOracle(sdk, repo)
    const counted = countApprovals(
      reviews.map((r) => ({
        id: r.id,
        reviewer: r.reviewer,
        verdict: r.verdictCode,
        commitOid: r.commitOid,
        createdAt: r.createdAt,
      })),
      oracle,
      headOid,
    )
    const reviewers = [...counted.approvers, ...counted.changesRequested]
    return { ...counted, roles: new Map(reviewers.map((who) => [who, oracle.currentRole(who)])) }
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
