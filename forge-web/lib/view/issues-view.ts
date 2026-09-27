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
  issueViewOf,
  membershipsFromDocs,
  newestLabels,
  num,
  readLabels,
  readMembershipsCached,
  readPull,
  seedMemberships,
  toEvents,
  updatedAtOf,
  readReviews,
  readRoleOracle,
  readTargetLog,
  repoSource,
  str,
  wellFormed,
  type IssueView,
  type PullView,
  type LabelDef,
  type RepoRef,
  type ReviewView,
} from '../repo'
import { DEFAULT_NETWORK, type Network } from '../constants'
import { compositeOf, docsAt, queryComposite, siblingOf } from '../sdk/composite'
import { prefetchDpnsNames } from './dpns'
import type { Membership } from '../rules/v2'
import { HiddenTally, admitAll, gateFor, type HiddenCounts } from '../repo/private-content'
import { queryAllDocuments, queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { compareKey, type Event } from '../rules'
import { anchorOf, countApprovals, groupReviewComments, type Anchor, type Approvals, type Role } from '../rules/v2'
import { summarizeReviews, type ReviewSummary } from './review-fold'

/** One comment on an issue/PR. */
export interface CommentView {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly createdAt: number
  /** The parent comment of a threaded reply (`replyTo`), or null. */
  readonly replyTo: string | null
  /**
   * Where an inline comment points (`anchorOf` over the `path`/`line`/`startLine`/`side`/
   * `commitOid` fields), or null for a general comment (a malformed anchor is null too).
   */
  readonly anchor: Anchor | null
  /** The review this comment was submitted with (`reviewId`), or null. */
  readonly reviewId: string | null
  /** The last edit's time; equal to `createdAt` when never edited ("edited" marker). */
  readonly updatedAt?: number
}

/** A comment document as a {@link CommentView}. */
export function toCommentView(d: PlainDocument): CommentView {
  const n = (f: string): number | null => {
    const v = d[f]
    return typeof v === 'number' ? v : null
  }
  const id = (f: string): string | null => asIdentifierString(d[f]) || null
  return {
    id: str(d, '$id'),
    author: str(d, '$ownerId'),
    body: str(d, 'body'),
    createdAt: num(d, '$createdAt'),
    replyTo: id('replyTo'),
    anchor: anchorOf({
      path: typeof d['path'] === 'string' ? d['path'] : null,
      line: n('line'),
      startLine: n('startLine'),
      side: n('side'),
      commitOid: byteFieldToHex(d, 'commitOid'),
    }),
    reviewId: id('reviewId'),
    updatedAt: updatedAtOf(d),
  }
}


/**
 * Read **every** comment on a target (issue/PR), oldest first.
 *
 * Paged rather than capped: `readThread` interleaves these with the event log, which is
 * itself read to completion, and a thread that silently stopped at comment 100 would show a
 * materially different conversation than any paging client — with no marker saying so.
 */
export async function readComments(
  sdk: EvoSDK,
  repo: RepoRef,
  targetId: string,
  tally: HiddenTally = new HiddenTally(),
): Promise<CommentView[]> {
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
  // Private repo: only comments that open with the reader's keys, decrypted (§8), which also
  // covers well-formedness and a stranger's ciphertext; the rest are counted, never shown.
  if (repo.visibility === 'private') {
    const { docs } = await admitAll(gateFor(repo), 'comment', documents, tally)
    return docs.map(toCommentView)
  }
  return documents.filter((d) => wellFormed(repo, 'comment', d)).map(toCommentView)
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
  | {
      readonly kind: 'review'
      readonly at: number
      readonly review: ReviewView
      /**
       * The comments submitted with the review (`groupReviewComments`: its `reviewId`, by its
       * reviewer), oldest first. They show under the review, not on their own.
       */
      readonly comments: readonly CommentView[]
      /** How many the review announced (`commentCount`, 0 when absent). */
      readonly expected: number
    }

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
  if (doc === undefined) return null
  const a = await gateFor(repo).admit(type, doc)
  return a.ok ? a.doc : null
}

/** A full issue detail: the folded issue + its merged timeline. */
export interface IssueThread {
  readonly issue: IssueView
  readonly timeline: TimelineItem[]
  /** Comments (and reviews) left out as unreadable, by reason (private repos). */
  readonly hidden: HiddenCounts
  /** The repo's label definitions (newest per name). */
  readonly labels: readonly LabelDef[]
  /** The repo's current members (the assignee picker's choices). */
  readonly members: readonly Membership[]
}

/**
 * Load an issue (folded state) + its comment/event timeline by number, in ONE composite read
 * (`platform-parity-spec.md` §3.3): the issue by `(repoId, number)`, its comments, events and
 * author events (bound `$id → targetId`), and the repo's label definitions and members
 * (siblings); then one batched DPNS read for every name shown. A target with more than 100
 * comments or events continues with complete paged reads of that type only. The issue and
 * comments pass the repo's content gate (a private repo's decrypt with the session keys).
 * Null if not found.
 */
export async function loadIssueThread(sdk: EvoSDK, repo: RepoRef, number: number, network: Network = DEFAULT_NETWORK): Promise<IssueThread | null> {
  const source = repoSource(repo)
  const page = source.repoQuery(DOC.issue, { where: [['number', '==', number]] })
  const bound = { sourceProperty: '$id', field: 'targetId' }
  const labelQuery = source.repoQuery(DOC.label, { orderBy: [['name', 'asc'], ['$createdAt', 'asc']] })
  const memberQuery = (type: string) => source.repoQuery(type, { orderBy: [['memberId', 'asc']] })
  const res = await queryComposite(
    sdk,
    compositeOf(page, 1, [
      { documentType: DOC.comment, bind: bound, limit: 100 },
      { documentType: DOC.event, bind: bound, limit: 100 },
      { documentType: DOC.authorEvent, bind: bound, limit: 100 },
      siblingOf(labelQuery),
      siblingOf(memberQuery(DOC.maintainer)),
      siblingOf(memberQuery(DOC.writer)),
    ]),
  )
  const raw = res.page[0]
  if (raw === undefined) return null
  // A private repo's issue opens with the reader's session keys (the gate decrypts it).
  const gate = gateFor(repo)
  const admitted = await gate.admit('issue', raw)
  if (!admitted.ok) return null
  const doc = admitted.doc
  const id = str(doc, '$id')
  const docs = (i: number): PlainDocument[] => docsAt(res, i)
  // A full sub-result page may have more rows: finish that type with a complete read.
  const complete = async (i: number, type: string): Promise<PlainDocument[]> =>
    docs(i).length < 100
      ? docs(i)
      : queryAllDocuments(sdk, source.targetQuery(type, { where: [['targetId', '==', id]], orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']] }))
  const [commentDocs, eventDocs, authorEventDocs] = await Promise.all([
    complete(0, DOC.comment),
    complete(1, DOC.event),
    complete(2, DOC.authorEvent),
  ])
  const byTime = (a: PlainDocument, b: PlainDocument) => num(a, '$createdAt') - num(b, '$createdAt')
  const log = { events: toEvents([...eventDocs].sort(byTime)), authorEvents: toEvents([...authorEventDocs].sort(byTime)) }

  // Members: complete when both sibling pages were short; recorded for the permission checks.
  const memberships = membershipsFromDocs(docs(4).length < 100 ? docs(4) : null, docs(5).length < 100 ? docs(5) : null)
  if (memberships !== null) seedMemberships(repo, network, memberships)
  // Every name the page shows (the author, commenters, event actors, assignees, members) in one
  // batched DPNS read. Two bound DPNS lookups in the composite would walk the same index path,
  // which the node refuses when either carries a limit (verified on moutai).
  const shownIds = [
    str(doc, '$ownerId'),
    ...commentDocs.map((c) => str(c, '$ownerId')),
    ...[...log.events, ...log.authorEvents].flatMap((e) => [e.actor, ...(e.kind === 'assign' || e.kind === 'unassign' ? [e.value ?? ''] : []), e.refId ?? '']),
    ...(memberships ?? []).map((m) => m.identity),
  ]
  await prefetchDpnsNames(sdk, shownIds.filter((id) => id !== ''), network)

  // Private repo: only comments that open with the reader's keys (§8); the rest are counted.
  const tally = new HiddenTally()
  const comments = (await admitAll(gate, 'comment', [...commentDocs].sort(byTime), tally)).docs.map(toCommentView)
  const labels = docs(3).length < 100 ? newestLabels(docs(3)) : await readLabels(sdk, repo)
  return {
    issue: issueViewOf(doc, log),
    timeline: mergeTimeline(comments, log.events, log.authorEvents, []),
    hidden: tally.value,
    labels,
    members: memberships ?? (await readMembershipsCached(sdk, repo, network)),
  }
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
  /** Comments and reviews left out as unreadable, by reason (private repos). */
  readonly hidden: HiddenCounts
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
  const tally = new HiddenTally()
  const [log, comments, reviews] = await Promise.all([
    readTargetLog(sdk, repo, id),
    readComments(sdk, repo, id, tally),
    readReviews(sdk, repo, id, tally),
  ])
  const pull = await readPull(sdk, repo, doc, log)
  const dismissed = new Set(pull.review.dismissedReviews.map((d) => d.reviewId))
  const approvals = await readApprovals(sdk, repo, reviews, pull.headOid, dismissed, pull.author)
  return { pull, timeline: mergeTimeline(comments, log.events, log.authorEvents, reviews), comments, approvals, hidden: tally.value }
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
      summary: summarizeReviews(input, oracle, headOid, author, dismissed),
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

/**
 * Interleave a thread's parts by `($createdAt, $id)`. A review's own comments
 * (`groupReviewComments`) are nested under it; every other comment stands alone.
 */
export function mergeTimeline(
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
  const byId = new Map(comments.map((c) => [c.id, c]))
  const asReviewComments = comments.map((c) => ({ id: c.id, owner: c.author, reviewId: c.reviewId, createdAt: c.createdAt }))
  const grouped = new Set<string>()
  const reviewItems = reviews.map((r) => {
    const group = groupReviewComments(r.id, r.reviewer, r.commentCount, asReviewComments)
    for (const id of group.comments) grouped.add(id)
    return { kind: 'review' as const, at: r.createdAt, id: r.id, review: r, comments: group.comments.flatMap((id) => byId.get(id) ?? []), expected: group.expected }
  })
  const items: (TimelineItem & { readonly id: string })[] = [
    ...comments.filter((c) => !grouped.has(c.id)).map((c) => ({ kind: 'comment' as const, at: c.createdAt, id: c.id, comment: c })),
    ...events.map((e) => eventItem(e, false)),
    ...authorEvents.map((e) => eventItem(e, true)),
    ...reviewItems,
  ]
  items.sort((a, b) => compareKey({ id: a.id, createdAt: a.at }, { id: b.id, createdAt: b.at }))
  return items
}
