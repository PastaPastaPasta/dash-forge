/**
 * Issue/PR thread composition (view glue) — read comments and interleave them with the event
 * and transition logs into a single chronological timeline for the detail view.
 *
 * State (open, closed, merged, draft) is the target's `transition` sum; labels and assignees
 * the fold of its member events (`issueStateV2` / `prStateV2`, via `issueViewOf` / `readPull`).
 * This module adds the human thread (comments + rendered events, state changes and reviews) and
 * the PR's counted approvals (`countApprovals`, `forge-v2.md` §6).
 */

import { originOf, type Origin } from '../repo/provenance'
import type { EvoSDK } from '@dashevo/evo-sdk'

import {
  DOC,
  baseRefReaders,
  asIdentifierString,
  byteFieldToHex,
  issueViewOf,
  revisionOf,
  membersGeneration,
  membershipsFromDocs,
  newestLabels,
  num,
  readLabels,
  readMembershipsCached,
  policyFromDocs,
  readPolicy,
  readPull,
  reviewViewOf,
  seedMemberships,
  toLog,
  updatedAtOf,
  readTargetLog,
  readTransitions,
  repoSource,
  str,
  titleOf,
  wellFormed,
  type IssueView,
  type PullView,
  type LabelDef,
  type RepoRef,
  type ReviewView,
  type TargetLog,
  type TransitionView,
} from '../repo'
import { sortTransitions, transitionOf } from '../repo/transitions'
import { readProvedVerdicts, type ProvedVerdicts } from '../repo/verdicts'
import { closeReasonOf, currentCloseReason, isLocked, stateCode, type ClosedAs } from '../rules/transition'
import { DEFAULT_NETWORK, type Network } from '../constants'
import { compositeOf, docsAt, queryComposite, siblingOf } from '../sdk/composite'
import { prefetchDpnsNames } from './dpns'
import type { Membership } from '../rules/v2'
import { HiddenTally, admitAll, gateFor, type HiddenCounts } from '../repo/private-content'
import { queryAllDocuments, type PlainDocument } from '../sdk'
import { compareKey, type Event } from '../rules'
import { foldThreadMetaV2, type ThreadMeta } from '../rules/parity'
import type { HiddenItems } from '../rules/moderation'
import { hidesProved } from '../repo/moderation'
import { foldModeration, hasHides, moderationInput, type ModerationInput } from '../repo/moderation-fold'
import { anchorOf, countApprovals, foldPrReviewV2, groupReviewComments, meetsPolicy, RoleOracle, type Anchor, type Approvals, type Policy, type PolicyStatus, type PrReviewState, type Review, type Role } from '../rules/v2'
import { reviewerRows, sinceYourReview, summarizeReviews, type ReviewerCardRow, type ReviewSummary, type SinceYourReview } from './review-fold'

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
  /** The document revision: an edit names it, so a concurrent edit is refused, not overwritten. */
  readonly revision?: number
  /** An imported comment's provenance as read, for re-sealing an edit. */
  readonly importedRaw?: Readonly<Record<string, unknown>> | null
  /** Copied from another forge (`imported` provenance present). */
  readonly imported: boolean
  /** See `IssueView.origin`. */
  readonly origin?: Origin | null
  /** It carries a membership proof (`asMember`, RC1): consensus re-checks it on every edit. */
  readonly proved?: boolean
  /**
   * A mirrored review comment's source diff hunk (QW2-010, `diffHunk`): only on an imported comment
   * on a file. Untrusted text: shown as text, and only when its provenance is trusted
   * (`trustedOrigin`), which the component decides.
   */
  readonly diffHunk?: string | null
}

/**
 * What an edit of `comment` must remove so consensus takes the replace (RC1): `replyTo` when the
 * comment it replies to is gone (a replace re-validates the reference; only when every comment of
 * the thread was readable, so a hidden parent is never taken for a deleted one), and the
 * membership proof when the editor is no longer a member (an imported comment keeps it: its
 * provenance needs it, so such an edit is refused).
 */
export function commentEditDrops(
  comment: CommentView,
  thread: readonly CommentView[],
  opts: { readonly isMember: boolean; readonly allReadable: boolean },
): { dropReplyTo?: true; dropProof?: true } {
  const parentGone = comment.replyTo !== null && opts.allReadable && !thread.some((c) => c.id === comment.replyTo)
  const proofStale = comment.proved === true && !opts.isMember && !comment.imported
  return { ...(parentGone ? { dropReplyTo: true } : {}), ...(proofStale ? { dropProof: true } : {}) }
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
    revision: revisionOf(d),
    importedRaw: typeof d['imported'] === 'object' && d['imported'] !== null ? (d['imported'] as Readonly<Record<string, unknown>>) : null,
    imported: typeof d['imported'] === 'object' && d['imported'] !== null,
    origin: originOf(d),
    proved: asIdentifierString(d['asMember']) !== '',
    diffHunk: hunkOf(d),
  }
}

/** A comment's `diffHunk` when it may be shown: an imported comment on a file (QW2-010). */
function hunkOf(d: PlainDocument): string | null {
  const h = d['diffHunk']
  const imported = typeof d['imported'] === 'object' && d['imported'] !== null
  return typeof h === 'string' && h !== '' && imported && typeof d['path'] === 'string' ? h : null
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
  | {
      readonly kind: 'comment'
      readonly at: number
      readonly comment: CommentView
      /**
       * It replies to a comment that is not shown: `'deleted'` when every comment was read (its
       * author deleted it), `'hidden'` when some could not be opened here (a private repo).
       */
      readonly orphaned?: 'deleted' | 'hidden'
    }
  | {
      /** A state change (`transition`): closed, reopened, merged, draft, ready. */
      readonly kind: 'transition'
      readonly at: number
      readonly transition: TransitionView
    }
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
  /** Private repos: the target's event values not readable here, and those not encrypted. */
  readonly eventValues: EventValueCounts
  /**
   * Milestone and pinned (the member events, folded: kinds 17-20), and locked: the lock bit of the
   * issue's transitions (RC1 R-15; sum ≥ 16), which consensus enforces on every comment.
   */
  readonly meta: ThreadMeta
  /** Why it is closed (QW-069; `currentCloseReason`), null while open or for a plain close. */
  readonly closedAs?: ClosedAs | null
  /**
   * The canonical issues its duplicate closes name that are issues of this repo, by number (with
   * their titles; '' when unreadable): only these link. Any other `dupNumber` shows unlinked.
   */
  readonly duplicates?: ReadonlyMap<number, { readonly number: number; readonly title: string }>
  /** What maintainers hid (RC2 MOD; `hiddenItems`): collapsed rows, or the whole issue. */
  readonly moderation?: HiddenItems
  /** What the reader rule read, for a maintainer's Hide / Unhide (`moderationBlocked`). */
  readonly moderationInput?: ModerationInput
}

/** A write the issue page made, for {@link issueWriteShows}. */
export type IssueWrite =
  | { readonly kind: 'comment'; readonly id: string }
  | { readonly kind: 'state'; readonly open: boolean }
  | { readonly kind: 'label'; readonly label: string; readonly remove: boolean }
  | { readonly kind: 'assign'; readonly who: string; readonly remove: boolean }
  | { readonly kind: 'flag'; readonly flag: 'pin' | 'lock'; readonly on: boolean }
  | { readonly kind: 'milestone'; readonly title: string | null }
  | { readonly kind: 'defineLabel'; readonly name: string; readonly apply: boolean }
  | { readonly kind: 'editIssue'; readonly title: string; readonly body: string }
  | { readonly kind: 'editComment'; readonly id: string; readonly body: string }
  | { readonly kind: 'deleteComment'; readonly id: string }
  | { readonly kind: 'hide'; readonly item: string | null; readonly hide: boolean }

/**
 * Whether a read of the thread already shows `w`: the page re-reads after a write until it does,
 * so a node a block behind cannot hide the write it just made (L-77, as on the PR page).
 */
export function issueWriteShows(t: IssueThread, w: IssueWrite): boolean {
  const comment = (id: string): CommentView | undefined => {
    for (const it of t.timeline) if (it.kind === 'comment' && it.comment.id === id) return it.comment
    return undefined
  }
  const { state } = t.issue
  switch (w.kind) {
    case 'comment':
      return comment(w.id) !== undefined
    case 'state':
      return state.open === w.open
    case 'label':
      return state.labels.includes(w.label) !== w.remove
    case 'assign':
      return state.assignees.includes(w.who) !== w.remove
    case 'flag':
      return (w.flag === 'pin' ? t.meta.pinned : t.meta.locked) === w.on
    case 'milestone':
      return t.meta.milestone === w.title
    case 'defineLabel':
      return t.labels.some((l) => l.name === w.name) && (!w.apply || state.labels.includes(w.name))
    case 'editIssue':
      return t.issue.title === w.title && t.issue.body === w.body
    case 'editComment':
      return comment(w.id)?.body === w.body
    case 'deleteComment':
      return comment(w.id) === undefined
    case 'hide':
      return isHidden(t.moderation, w.item) === w.hide
  }
}

/** Whether `item` (null: the thread) is hidden in `m` (RC2 MOD). */
export function isHidden(m: HiddenItems | undefined, item: string | null): boolean {
  if (m === undefined) return false
  return item === null ? m.thread !== null : m.items[item] !== undefined
}

/** How a private repo's event values were read ({@link TargetLog}). */
export interface EventValueCounts {
  readonly hidden: number
  readonly plaintext: number
}

function eventValues(log: TargetLog): EventValueCounts {
  return { hidden: log.hiddenValues ?? 0, plaintext: log.plaintextValues ?? 0 }
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
  const membersAtStart = membersGeneration()
  const res = await queryComposite(
    sdk,
    compositeOf(page, 1, [
      { documentType: DOC.comment, bind: bound, limit: 100 },
      { documentType: DOC.event, dataContractId: repo.forge.community, bind: bound, limit: 100 },
      { documentType: DOC.transition, bind: bound, limit: 100 },
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
  // `transition` is indexed by `targetId` alone (`perTarget`): its continuation cannot order by time.
  const completeTransitions = async (i: number): Promise<TransitionView[]> =>
    docs(i).length < 100 ? docs(i).map(transitionOf) : readTransitions(sdk, repo, id)
  const [commentDocs, eventDocs, transitionRows] = await Promise.all([
    complete(0, DOC.comment),
    complete(1, DOC.event),
    completeTransitions(2),
  ])
  const byTime = (a: PlainDocument, b: PlainDocument) => num(a, '$createdAt') - num(b, '$createdAt')
  // A private repo's member events are read through `readableEvents` (values opened, counted).
  const log = await toLog(repo, [...eventDocs].sort(byTime), [])
  const transitions = sortTransitions(transitionRows)

  // Members: complete when both sibling pages were short; recorded for the permission checks.
  const memberships = membershipsFromDocs(docs(4).length < 100 ? docs(4) : null, docs(5).length < 100 ? docs(5) : null)
  if (memberships !== null) seedMemberships(repo, network, memberships, membersAtStart)
  // Every name the page shows (the author, commenters, event actors, assignees, members) in one
  // batched DPNS read. Two bound DPNS lookups in the composite would walk the same index path,
  // which the node refuses when either carries a limit (verified on moutai).
  const shownIds = [
    str(doc, '$ownerId'),
    ...commentDocs.map((c) => str(c, '$ownerId')),
    ...[...log.events, ...log.authorEvents].flatMap((e) => [e.actor, ...(e.kind === 'assign' || e.kind === 'unassign' ? [e.value ?? ''] : []), e.refId ?? '']),
    ...transitions.map((t) => t.actor),
    ...(memberships ?? []).map((m) => m.identity),
  ]
  await prefetchDpnsNames(sdk, shownIds.filter((id) => id !== ''), network)

  // Private repo: only comments that open with the reader's keys (§8); the rest are counted.
  const tally = new HiddenTally()
  const comments = (await admitAll(gate, 'comment', [...commentDocs].sort(byTime), tally)).docs.map(toCommentView)
  const labels = docs(3).length < 100 ? newestLabels(docs(3)) : await readLabels(sdk, repo)
  const issueNumber = num(doc, 'number')
  // A duplicate's canonical, for its link only: a failed read shows it unlinked, never fails the page.
  const duplicates = await readDuplicateTargets(sdk, repo, transitions.flatMap((t) => closeReasonOf(t, issueNumber)?.duplicateOf ?? [])).catch(
    () => new Map<number, { readonly number: number; readonly title: string }>(),
  )
  // RC2 MOD: the contract's proof is read only when the issue has a hide, beside the members (a
  // failed read counts the owner's and current maintainers' hides alone, the stricter rule).
  const [members, proved] = await Promise.all([
    memberships ?? readMembershipsCached(sdk, repo, network),
    hasHides(log.events) ? hidesProved(sdk, repo).catch(() => false) : Promise.resolve(false),
  ])
  const modInput = moderationInput({ events: log.events, thread: { id, author: str(doc, '$ownerId') }, owner: repo.ownerId, members, proved, comments })
  return {
    closedAs: currentCloseReason(transitions, issueNumber),
    duplicates,
    moderation: foldModeration(modInput),
    moderationInput: modInput,
    issue: issueViewOf(doc, log, stateCode(transitions)),
    timeline: mergeTimeline(comments, log.events, log.authorEvents, [], tally.total > 0, transitions),
    hidden: tally.value,
    eventValues: eventValues(log),
    labels,
    members,
    // The lock is a transition since RC1 (kinds 3/4); the retired lock events 21/22 are refused.
    meta: { ...foldThreadMetaV2(log.events), locked: isLocked(transitions) },
  }
}

/**
 * The issues of `repo` among `numbers` (a duplicate close's canonicals), with their titles: one
 * read per distinct number (an issue rarely names more than one). A number that holds a PR, or
 * nothing, is absent: a reader links a duplicate only to an issue of the repo.
 */
export async function readDuplicateTargets(
  sdk: EvoSDK,
  repo: RepoRef,
  numbers: readonly number[],
): Promise<Map<number, { readonly number: number; readonly title: string }>> {
  const out = new Map<number, { readonly number: number; readonly title: string }>()
  const gate = gateFor(repo)
  await Promise.all(
    [...new Set(numbers)].map(async (n) => {
      const [doc] = await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.issue, { where: [['number', '==', n]] }))
      if (doc === undefined) return
      const admitted = await gate.admit('issue', doc)
      out.set(n, { number: n, title: admitted.ok ? titleOf(admitted.doc) : '' })
    }),
  )
  return out
}

/** The counted approvals of a PR, and what each reviewer's role is now. */
export interface PullApprovals extends Approvals {
  /** Each counted reviewer's current role (null once revoked — then they do not count). */
  readonly roles: ReadonlyMap<string, Role | null>
  /** Every reviewer's standing, counted or not, for the header (`summarizeReviews`). */
  readonly summary: ReviewSummary
  /**
   * The branch policy in force (null: none; `'unknown'`: it could not be read), and how these
   * approvals stand against it.
   */
  readonly policy: Policy | null | 'unknown'
  readonly policyStatus: PolicyStatus | null | 'unknown'
}

/** A full PR detail: the folded pull + its merged timeline. */
export interface PullThread {
  readonly pull: PullView
  readonly timeline: TimelineItem[]
  /** Every comment, for placing inline threads on the diff. */
  readonly comments: readonly CommentView[]
  /** Every readable review, oldest first. */
  readonly reviews: readonly ReviewView[]
  /**
   * The review fold with thread resolution (`foldPrReviewV2` over the PR's root comments):
   * head updates, requested reviewers, resolved threads, dismissals.
   */
  readonly review: PrReviewState
  /**
   * The reviews that count on the current head (`countApprovals`). Null when the membership
   * could not be read.
   */
  readonly approvals: PullApprovals | null
  /**
   * The member approvals and change requests on the head as consensus proves them (RC1 R-16, one
   * grouped count): shown in the merge box beside the fold, never a merge gate (`approvals` is).
   * Null when it could not be read or the PR records no head.
   */
  readonly verdicts: ProvedVerdicts | null
  /** The Reviewers card (requested reviewers and everyone who reviewed); empty when members are unknown. */
  readonly reviewers: readonly ReviewerCardRow[]
  /** The repo's current members (the reviewer and assignee pickers). */
  readonly members: readonly Membership[]
  /** The repo's label definitions (newest per name). */
  readonly labels: readonly LabelDef[]
  /** Comments and reviews left out as unreadable, by reason (private repos). */
  readonly hidden: HiddenCounts
  /** Private repos: the PR's event values not readable here, and those not encrypted. */
  readonly eventValues: EventValueCounts
  /**
   * The conversation is locked (RC1 R-15: the PR's transition sum is 16 or more): consensus
   * refuses a comment or review from anyone who does not prove membership.
   */
  readonly locked: boolean
  /**
   * What maintainers hid (RC2 MOD; `hiddenItems`). Display only: a hidden review's verdict still
   * counts in `approvals` until it is dismissed.
   */
  readonly moderation?: HiddenItems
  /** What the reader rule read, for a maintainer's Hide / Unhide (`moderationBlocked`). */
  readonly moderationInput?: ModerationInput
}

/**
 * Load a PR (folded state) + its timeline by number, in ONE composite read
 * (`platform-parity-spec.md` §3.3, review-parity §3.10): the patch by `(repoId, number)`; its
 * comments, events and author events (bound `$id → targetId`) and reviews (`$id → patchId`);
 * the repo's labels, members and branch policies (siblings). A type past 100 rows continues
 * with a complete paged read of that type only. The base ref's history is read by `readPull`.
 * Null if not found.
 *
 * A PR's timeline includes its `review` documents: an approve or a request for changes is a
 * paid-for record the contributor must see.
 */
export async function loadPullThread(
  sdk: EvoSDK,
  repo: RepoRef,
  number: number,
  network: Network = DEFAULT_NETWORK,
  /** A re-read after this page's own write: the base ref's history is read afresh (a delta), not the chrome's. */
  { fresh = false }: { readonly fresh?: boolean } = {},
): Promise<PullThread | null> {
  const source = repoSource(repo)
  const page = source.repoQuery(DOC.patch, { where: [['number', '==', number]] })
  const toTarget = { sourceProperty: '$id', field: 'targetId' }
  const memberQuery = (type: string) => source.repoQuery(type, { orderBy: [['memberId', 'asc']] })
  const membersAtStart = membersGeneration()
  const res = await queryComposite(
    sdk,
    compositeOf(page, 1, [
      { documentType: DOC.comment, bind: toTarget, limit: 100 },
      { documentType: DOC.event, dataContractId: repo.forge.community, bind: toTarget, limit: 100 },
      { documentType: DOC.authorEvent, dataContractId: repo.forge.community, bind: toTarget, limit: 100 },
      { documentType: DOC.review, bind: { sourceProperty: '$id', field: 'patchId' }, limit: 100 },
      siblingOf(source.repoQuery(DOC.label, { orderBy: [['name', 'asc'], ['$createdAt', 'asc']] })),
      siblingOf(memberQuery(DOC.maintainer)),
      siblingOf(memberQuery(DOC.writer)),
      siblingOf(source.repoQuery(DOC.policy, { orderBy: [['$createdAt', 'asc']] })),
      { documentType: DOC.transition, bind: toTarget, limit: 100 },
    ]),
  )
  const raw = res.page[0]
  if (raw === undefined) return null
  const gate = gateFor(repo)
  const admitted = await gate.admit('patch', raw)
  if (!admitted.ok) return null
  const doc = admitted.doc
  const id = str(doc, '$id')
  const docs = (i: number): PlainDocument[] => docsAt(res, i)
  const complete = async (i: number, type: string, field: 'targetId' | 'patchId' = 'targetId'): Promise<PlainDocument[]> =>
    docs(i).length < 100
      ? docs(i)
      : queryAllDocuments(sdk, source.targetQuery(type, { where: [[field, '==', id]], orderBy: [[field, 'asc'], ['$createdAt', 'asc']] }))
  const byTime = (a: PlainDocument, b: PlainDocument) => num(a, '$createdAt') - num(b, '$createdAt')
  const [commentDocs, eventDocs, authorEventDocs, reviewDocs, transitionRows] = await Promise.all([
    complete(0, DOC.comment),
    complete(1, DOC.event),
    complete(2, DOC.authorEvent),
    complete(3, DOC.review, 'patchId'),
    docs(8).length < 100 ? Promise.resolve(docs(8).map(transitionOf)) : readTransitions(sdk, repo, id),
  ])
  const transitions = sortTransitions(transitionRows)
  // A private repo's member events are read through `readableEvents` (values opened, counted).
  const log = await toLog(repo, [...eventDocs].sort(byTime), [...authorEventDocs].sort(byTime))

  const memberships = membershipsFromDocs(docs(5).length < 100 ? docs(5) : null, docs(6).length < 100 ? docs(6) : null)
  if (memberships !== null) seedMemberships(repo, network, memberships, membersAtStart)
  // Every name the page shows in one batched DPNS read (best effort: a pill falls back to its id).
  const shownIds = [
    str(doc, '$ownerId'),
    ...commentDocs.map((c) => str(c, '$ownerId')),
    ...reviewDocs.map((r) => str(r, '$ownerId')),
    ...transitions.map((t) => t.actor),
    ...[...log.events, ...log.authorEvents].flatMap((e) => [e.actor, ...(e.kind === 'assign' || e.kind === 'unassign' ? [e.value ?? ''] : []), e.refId ?? '']),
    ...(memberships ?? []).map((m) => m.identity),
  ]
  // The base ref's history and config from the repo chrome store (no request), afresh after this page's own write.
  const base = baseRefReaders(sdk, repo, fresh ? { maxAgeMs: 0 } : {})
  const [pull] = await Promise.all([
    readPull(sdk, repo, doc, log, base.configHistory, base.refUpdates, { transitions }),
    prefetchDpnsNames(sdk, shownIds.filter((x) => x !== ''), network).catch(() => undefined),
  ])
  // The proved verdict count needs the folded head: one grouped count, alongside what follows.
  // Display only, so a failed read shows nothing rather than failing the page.
  const verdictsRead = readProvedVerdicts(sdk, repo, id, pull.headOid).catch(() => null)

  const tally = new HiddenTally()
  const comments = (await admitAll(gate, 'comment', [...commentDocs].sort(byTime), tally)).docs.map(toCommentView)
  const reviews = (await admitAll(gate, 'review', [...reviewDocs].sort(byTime), tally)).docs.map(reviewViewOf)
  const roots = new Set(comments.filter((c) => c.replyTo === null).map((c) => c.id))
  const review = foldPrReviewV2(log.events, log.authorEvents, pull.author, pull.initialHeadOid, roots)
  const labels = docs(4).length < 100 ? newestLabels(docs(4)) : await readLabels(sdk, repo)
  const policyDocs = docs(7).length < 100 ? docs(7) : null
  const policy: Promise<Policy | null> = policyDocs === null ? readPolicy(sdk, repo) : Promise.resolve(policyFromDocs(policyDocs))
  const members = memberships ?? (await readMembershipsCached(sdk, repo, network).catch(() => null))
  const proved = hasHides(log.events) ? hidesProved(sdk, repo).catch(() => false) : Promise.resolve(false)
  const [approvals, verdicts, hidesAreProved] = await Promise.all([readApprovals(members, policy, reviews, review, pull.author), verdictsRead, proved])
  const modInput = moderationInput({ events: log.events, thread: { id, author: pull.author }, owner: repo.ownerId, members: members ?? [], proved: hidesAreProved, comments, reviews })
  return {
    moderation: foldModeration(modInput),
    moderationInput: modInput,
    pull,
    timeline: mergeTimeline(comments, log.events, log.authorEvents, reviews, tally.total > 0, transitions),
    comments,
    reviews,
    review,
    approvals: approvals?.approvals ?? null,
    verdicts,
    reviewers: approvals?.reviewers ?? [],
    members: members ?? [],
    labels,
    hidden: tally.value,
    eventValues: eventValues(log),
    locked: isLocked(transitions),
  }
}

/** The review inputs of the approval fold. */
function asReviews(reviews: readonly ReviewView[]): Review[] {
  return reviews.map((r) => ({ id: r.id, reviewer: r.reviewer, verdict: r.verdictCode, commitOid: r.commitOid, createdAt: r.createdAt }))
}

/** A PR's counted approvals and Reviewers card, or null when the membership could not be read. */
async function readApprovals(
  members: readonly Membership[] | null,
  policyRead: Promise<Policy | null>,
  reviews: readonly ReviewView[],
  review: PrReviewState,
  author: string,
): Promise<{ approvals: PullApprovals; reviewers: ReviewerCardRow[] } | null> {
  if (members === null) return null
  // A policy that cannot be read is "unknown" (the merge gate then fails closed), never a
  // reason to drop the approvals the page can still show.
  const policy = await policyRead.catch((): 'unknown' => 'unknown')
  const oracle = new RoleOracle([...members])
  const input = asReviews(reviews)
  const headOid = review.head
  const dismissed = new Set(review.dismissedReviews.map((d) => d.reviewId))
  const counted = countApprovals(input, oracle, headOid, dismissed, author)
  const counters = [...counted.approvers, ...counted.changesRequested]
  return {
    approvals: {
      ...counted,
      roles: new Map(counters.map((who) => [who, oracle.currentRole(who)])),
      summary: summarizeReviews(input, oracle, headOid, author, dismissed),
      policy,
      policyStatus: policy === null || policy === 'unknown' ? policy : meetsPolicy(counted, oracle, policy),
    },
    reviewers: reviewerRows(input, review.requestedReviewers, review.dismissedReviews, counted, oracle, headOid, author),
  }
}

/** "New commits since your review" for `viewer` on a loaded PR. */
export function pullSinceYourReview(thread: Pick<PullThread, 'reviews' | 'review'>, viewer: string | null): SinceYourReview | null {
  return sinceYourReview(asReviews(thread.reviews), thread.review.head, thread.review.headUpdates, viewer)
}

/** Read comments + events for a target and merge them into one chronological timeline. */
export async function readThread(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<TimelineItem[]> {
  const [comments, log, transitions] = await Promise.all([
    readComments(sdk, repo, targetId),
    readTargetLog(sdk, repo, targetId),
    readTransitions(sdk, repo, targetId),
  ])
  return mergeTimeline(comments, log.events, log.authorEvents, [], false, transitions)
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
  /** Some comments could not be opened by this reader (private repo): a missing parent may be one. */
  someHidden = false,
  transitions: readonly TransitionView[] = [],
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
    ...comments
      .filter((c) => !grouped.has(c.id))
      .map((c) => ({ kind: 'comment' as const, at: c.createdAt, id: c.id, comment: c, ...(c.replyTo !== null && !byId.has(c.replyTo) ? { orphaned: someHidden ? ('hidden' as const) : ('deleted' as const) } : {}) })),
    ...events.map((e) => eventItem(e, false)),
    ...authorEvents.map((e) => eventItem(e, true)),
    ...transitions.map((t) => ({ kind: 'transition' as const, at: t.createdAt, id: t.id, transition: t })),
    ...reviewItems,
  ]
  items.sort((a, b) => compareKey({ id: a.id, createdAt: a.at }, { id: b.id, createdAt: b.at }))
  return items
}
