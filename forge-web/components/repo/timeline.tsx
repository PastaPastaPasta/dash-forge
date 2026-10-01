'use client'

/**
 * Timeline — the interleaved comment + event + review stream of an issue/PR. Comments render
 * the author pill + markdown body; events render a compact, git-native one-liner ("closed
 * this", "added the bug label"); reviews render their verdict and the commit they were made
 * against; state changes (`transition`) render as "closed this", "merged this". An event the
 * folds ignore still appears here as the audit trail it is.
 */

import { Byline } from '@/components/repo/byline'
import { importedVerdictOf, searchableBody, trustedOrigin } from '@/lib/repo/provenance'
import { Check, CheckCircle2, CircleDot, CircleSlash, Eye, GitCommit, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Lock, LockOpen, Milestone, MessageSquare, Pencil, Pin, ShieldAlert, Tag, Trash2, UserPlus, X } from 'lucide-react'
import type { CommentView, TimelineItem } from '@/lib/view'
import { branchName, plural, timeAgo } from '@/lib/view'
import { anchorLabel } from '@/lib/view/inline-threads'
import { VERDICT_LABEL, type VerdictName } from '@/lib/repo'
import type { Event } from '@/lib/rules'
import { ISSUE_CLOSE, ISSUE_LOCK, ISSUE_REOPEN, ISSUE_UNLOCK, PR_CLOSE, PR_DRAFT, PR_DRAFT_CLOSE, PR_DRAFT_REOPEN, PR_LOCK, PR_MERGE, PR_READY, PR_REOPEN, PR_UNLOCK, transitionPhrase } from '@/lib/rules/transition'
import type { TransitionView } from '@/lib/repo'
import { Author } from '@/components/author'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { isEmptyMirroredReview, mirroredCommentText } from '@/lib/view/mirror-review-fold'
import type { CloseWhy } from '@/lib/view/close-reason'
import { MarkdownView, type MarkdownLinks } from '@/components/markdown-view'
import { importedUrlOf } from '@/lib/view/ref-targets'
import { EditedMarker } from '@/components/repo/issue-bits'
import { Oid } from '@/components/ui/oid'
import { WithAge } from '@/components/ui/with-age'

function verdictIcon(verdict: VerdictName): JSX.Element {
  switch (verdict) {
    case 'approve':
    case 'approveNonMember':
      return <Check className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden />
    case 'requestChanges':
    case 'requestChangesNonMember':
      return <X className="h-3.5 w-3.5 text-danger-700 dark:text-danger-400" aria-hidden />
    default:
      return <MessageSquare className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
  }
}

/**
 * The one-line phrase of an event. `who` is an identity the phrase names (a requested
 * reviewer), rendered after `text`; `after` follows it.
 */
function eventPhrase(e: Event): { text: string; icon: JSX.Element; who?: string; after?: string } {
  const { kind, value } = e
  const muted = 'h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400'
  switch (kind) {
    // A padlock means the conversation was locked, never a state change (QW2-045).
    case 'close':
      return { text: 'closed this', icon: <CheckCircle2 className={CLOSED_ICON} aria-hidden /> }
    case 'reopen':
      return { text: 'reopened this', icon: <CircleDot className={OPEN_ICON} aria-hidden /> }
    case 'merge':
      // The event records a claim; whether the PR folds as merged depends on who signed it
      // and whether the oid reached the base branch, so say what the event is.
      return { text: 'marked this as merged', icon: <GitMerge className="h-3.5 w-3.5 text-dash" aria-hidden /> }
    case 'labelAdd':
      return { text: `added the ${value ?? ''} label`, icon: <Tag className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> }
    case 'labelRemove':
      return { text: `removed the ${value ?? ''} label`, icon: <Tag className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> }
    case 'assign':
      return value ? { text: 'assigned', who: value, icon: <UserPlus className={muted} aria-hidden /> } : { text: 'assigned this', icon: <UserPlus className={muted} aria-hidden /> }
    case 'unassign':
      return value ? { text: 'unassigned', who: value, icon: <UserPlus className={muted} aria-hidden /> } : { text: 'unassigned this', icon: <UserPlus className={muted} aria-hidden /> }
    case 'retarget':
      return { text: `retargeted to ${branchName(value ?? '')}`, icon: <GitMerge className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> }
    case 'draft':
      return { text: 'converted this to a draft', icon: <GitPullRequestDraft className={muted} aria-hidden /> }
    case 'ready':
      return { text: 'marked this ready for review', icon: <Eye className={muted} aria-hidden /> }
    case 'headUpdate':
      return { text: e.oid ? `pushed new commits (head ${e.oid.slice(0, 9)})` : 'pushed new commits', icon: <GitCommit className={muted} aria-hidden /> }
    case 'threadResolve':
      return { text: 'resolved a conversation', icon: <CheckCircle2 className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden /> }
    case 'threadUnresolve':
      return { text: 'unresolved a conversation', icon: <MessageSquare className={muted} aria-hidden /> }
    case 'reviewRequest':
      return e.refId ? { text: 'requested a review from', who: e.refId, icon: <Eye className={muted} aria-hidden /> } : { text: 'requested a review', icon: <Eye className={muted} aria-hidden /> }
    case 'reviewRequestRemove':
      return e.refId ? { text: 'removed the review request for', who: e.refId, icon: <Eye className={muted} aria-hidden /> } : { text: 'removed a review request', icon: <Eye className={muted} aria-hidden /> }
    case 'reviewDismiss':
      return { text: value ? `dismissed a review: ${value}` : 'dismissed a review', icon: <X className={muted} aria-hidden /> }
    case 'milestoneSet':
      return { text: `set the milestone to ${value ?? ''}`, icon: <Milestone className={muted} aria-hidden /> }
    case 'milestoneClear':
      return { text: 'cleared the milestone', icon: <Milestone className={muted} aria-hidden /> }
    case 'pin':
      return { text: 'pinned this', icon: <Pin className={muted} aria-hidden /> }
    case 'unpin':
      return { text: 'unpinned this', icon: <Pin className={muted} aria-hidden /> }
    case 'lock':
      return { text: 'locked the conversation', icon: <Lock className={muted} aria-hidden /> }
    case 'unlock':
      return { text: 'unlocked the conversation', icon: <LockOpen className={muted} aria-hidden /> }
    case 'policyBypass':
      // The immutable record of a maintainer's bypass (QW2-003): what was not met at the merge.
      return { text: bypassPhrase(value, true), icon: <ShieldAlert className="h-3.5 w-3.5 text-caution-700 dark:text-caution-400" aria-hidden /> }
    default:
      return { text: String(kind), icon: <Tag className={muted} aria-hidden /> }
  }
}

/**
 * A policy-bypass event's words. `ofMerge`: it names a merge of this PR (any member can write the
 * event, so one that names no merge here is a claim, not the record of this PR's merge).
 */
export function bypassPhrase(value: string | null | undefined, ofMerge: boolean): string {
  // The value names checks in `backticks` (dg's words); the timeline is plain text.
  const rules = value ? ` (${value.replace(/`/g, '')})` : ''
  return ofMerge ? `merged by bypassing the branch rules${rules}` : `recorded a branch-rules bypass${rules} naming a commit this PR was not merged at`
}

/** Open and closed, in the colours of the issue and PR state badges. */
const OPEN_ICON = 'h-3.5 w-3.5 text-verify-700 dark:text-verify-400'
const CLOSED_ICON = 'h-3.5 w-3.5 text-forge-700 dark:text-forge-400'
const PR_CLOSED_ICON = 'h-3.5 w-3.5 text-danger-700 dark:text-danger-400'

/**
 * The icon of a state change, as GitHub draws them (QW2-045): an issue closes with a check circle
 * and reopens with an open circle, a PR closes and reopens with its own pull-request glyphs, and
 * only a lock or unlock of the conversation shows a padlock.
 */
export function transitionIcon(kind: number): JSX.Element {
  const muted = 'h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400'
  switch (kind) {
    case PR_MERGE:
      return <GitMerge className="h-3.5 w-3.5 text-dash" aria-hidden />
    case ISSUE_CLOSE:
      return <CheckCircle2 className={CLOSED_ICON} aria-hidden data-icon="closed" />
    case ISSUE_REOPEN:
      return <CircleDot className={OPEN_ICON} aria-hidden data-icon="reopened" />
    case PR_CLOSE:
    case PR_DRAFT_CLOSE:
      return <GitPullRequestClosed className={PR_CLOSED_ICON} aria-hidden data-icon="closed" />
    case PR_REOPEN:
    case PR_DRAFT_REOPEN:
      return <GitPullRequest className={OPEN_ICON} aria-hidden data-icon="reopened" />
    case PR_DRAFT:
      return <GitPullRequestDraft className={muted} aria-hidden data-icon="draft" />
    case PR_READY:
      return <Eye className={muted} aria-hidden data-icon="ready" />
    case ISSUE_LOCK:
    case PR_LOCK:
      return <Lock className={muted} aria-hidden data-icon="locked" />
    case ISSUE_UNLOCK:
    case PR_UNLOCK:
      return <LockOpen className={muted} aria-hidden data-icon="unlocked" />
    default:
      return <Tag className={muted} aria-hidden />
  }
}

/** What a page adds to a comment card: header actions, or a body that replaces the rendered one (an editor). */
export interface CommentSlots {
  readonly header?: ReactNode
  readonly body?: ReactNode
}

/** A timeline event: its icon, then one sentence (actor, what, age) that wraps as text. */
const EVENT_ROW = 'flex items-start gap-2 px-2 text-dense text-anvil-500 dark:text-anvil-400'
const EVENT_ICON = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-anvil-100 dark:bg-anvil-800'
const EVENT_TEXT = 'min-w-0 flex-1 leading-6'

/**
 * A comment author's own actions in its header: Edit, and Delete (QW-016). Only the author sees
 * them: consensus admits a comment's replace or delete from its author alone. `deleteDisabled`
 * (default `disabled`): a delete carries no content, so what blocks composing (a lock the author is
 * not a member past, a private repo's missing key) need not block it.
 */
export function CommentOwnActions({
  onEdit,
  onDelete,
  disabled,
  deleteDisabled = disabled,
}: {
  onEdit: () => void
  onDelete: () => void
  disabled: boolean
  deleteDisabled?: boolean
}): JSX.Element {
  const button = 'inline-flex items-center gap-1 text-[12px] text-anvil-500 disabled:opacity-50 dark:text-anvil-400 coarse:min-h-11 coarse:px-1'
  return (
    <span className="ml-auto flex items-center gap-3">
      <button type="button" onClick={onEdit} disabled={disabled} className={`${button} hover:text-forge-700 dark:hover:text-forge-400`} aria-label="Edit comment">
        <Pencil className="h-3 w-3" aria-hidden /> Edit
      </button>
      <button type="button" onClick={onDelete} disabled={deleteDisabled} className={`${button} hover:text-danger-700 dark:hover:text-danger-400`} aria-label="Delete comment">
        <Trash2 className="h-3 w-3" aria-hidden /> Delete
      </button>
    </span>
  )
}

/** A pull request elsewhere in the repo that names this issue (QW2-048). */
export interface TimelineRef {
  readonly number: number
  readonly title: string
  readonly href: string
}

/** "mentioned this issue in #4": a PR whose description references the issue without closing it. */
export interface CrossRefItem extends TimelineRef {
  readonly id: string
  readonly actor: string
  readonly at: number
  /** The PR's state, for its icon. */
  readonly state: 'open' | 'merged' | 'closed' | 'draft'
}

function crossRefIcon(state: CrossRefItem['state']): JSX.Element {
  switch (state) {
    case 'merged':
      return <GitMerge className="h-3.5 w-3.5 text-dash" aria-hidden />
    case 'closed':
      return <GitPullRequestClosed className={PR_CLOSED_ICON} aria-hidden />
    case 'draft':
      return <GitPullRequestDraft className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
    default:
      return <GitPullRequest className={OPEN_ICON} aria-hidden />
  }
}

/** `#4 title`, linked, as the timeline names another thread. */
function RefLink({ to }: { to: TimelineRef }): JSX.Element {
  return (
    <Link href={to.href} className="font-medium text-anvil-800 hover:text-forge-700 hover:underline dark:text-anvil-100 dark:hover:text-forge-400">
      <span className="font-mono">#{to.number}</span>
      {to.title ? <span className="break-words"> {to.title}</span> : null}
    </Link>
  )
}

/** A timeline item's stable key. */
function itemKey(item: TimelineItem): string {
  switch (item.kind) {
    case 'comment':
      return `c-${item.comment.id}`
    case 'review':
      return `r-${item.review.id}`
    case 'transition':
      return `t-${item.transition.id}`
    default:
      return `e-${item.event.id ?? item.at}`
  }
}

/**
 * A comment under its review, as a thread box: the file, who wrote it (the source author for a
 * mirrored one), the page's slots (resolved and outdated tags, the author's actions; a thread's
 * replies and "View in Files changed", or the inline editor, as its body).
 */
function ReviewComment({
  comment: c,
  links,
  trust,
  slot,
  anchorContext,
}: {
  comment: CommentView
  links?: MarkdownLinks
  trust: ReadonlySet<string> | null
  slot: CommentSlots
  anchorContext?: ((c: CommentView) => ReactNode) | undefined
}): JSX.Element {
  const origin = trustedOrigin(c.origin, c.author, trust)
  const mirrored = origin !== null ? mirroredCommentText(c.body, c.anchor) : null
  const file = c.anchor ? anchorLabel(c.anchor) : mirrored?.file ?? null
  return (
    <div className="overflow-hidden rounded-md border border-anvil-200 dark:border-anvil-800" data-testid="review-comment">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-anvil-200 bg-anvil-50 px-3 py-1.5 text-[12px] dark:border-anvil-800 dark:bg-anvil-900">
        {file !== null ? <span className="break-all font-mono text-anvil-700 dark:text-anvil-300">{file}</span> : null}
        {origin !== null ? <Byline author={c.author} createdAt={c.createdAt} origin={origin} link={false} /> : null}
        {slot.header}
      </div>
      {slot.body ?? (
        <div className="space-y-2 px-3 py-2">
          {c.anchor ? anchorContext?.(c) : null}
          <MarkdownView source={mirrored?.text ?? c.body} links={links} imported={importedUrlOf(c.importedRaw)} />
        </div>
      )}
    </div>
  )
}

/** What a comment's header says it did. */
function commentVerb(item: Extract<TimelineItem, { kind: 'comment' }>): string {
  let verb = 'commented'
  if (item.orphaned === 'deleted') verb = 'replied to a deleted comment'
  else if (item.orphaned === 'hidden') verb = 'replied to a comment you cannot read'
  return item.comment.anchor ? `${verb} on ${anchorLabel(item.comment.anchor)}` : verb
}

/** Past this many items the middle of a timeline is hidden, as GitHub hides it (QW2-010). */
export const TIMELINE_FOLD_AT = 60
/** Items shown at each end of a folded timeline. */
export const TIMELINE_EDGE = 20
/** Items each "Load more" reveals. */
export const TIMELINE_PAGE = 50

/**
 * Which items a timeline of `n` shows: every one, or the first and last {@link TIMELINE_EDGE} plus
 * the `revealed` after the first, and how many stay hidden between them.
 */
export function timelineWindow(n: number, revealed: number): { head: number; tail: number; hidden: number } {
  if (n <= TIMELINE_FOLD_AT) return { head: n, tail: 0, hidden: 0 }
  const head = Math.min(n - TIMELINE_EDGE, TIMELINE_EDGE + revealed)
  return { head, tail: TIMELINE_EDGE, hidden: n - TIMELINE_EDGE - head }
}

export function Timeline({
  items,
  links,
  renderComment,
  eventText,
  anchorContext,
  trust = null,
  closedIn,
  closeWhy,
  crossRefs = [],
}: {
  items: readonly TimelineItem[]
  /** Where `#n` / `@name` in bodies link (omit: plain text). Keep it referentially stable. */
  links?: MarkdownLinks
  /** A comment's additions: the author's Edit in the header, the inline editor as its body. */
  renderComment?: (item: Extract<TimelineItem, { kind: 'comment' }>) => CommentSlots
  /** A page's own wording for an event (the PR page counts the commits a head update pushed), or null. */
  eventText?: (e: Event) => string | null
  /**
   * A review's inline comment's heading: where it points, whether it is outdated or applied, and
   * the code it was left on (the PR page, QW2-049). Omitted: the anchor's label alone.
   */
  anchorContext?: (c: CommentView) => ReactNode
  /** Who may mirror (`useMirrorTrust`): their imported comments and reviews show the original author and date. */
  trust?: ReadonlySet<string> | null
  /** The pull request whose merge made a close ("closed this as completed in #3"), or null. */
  closedIn?: (t: TransitionView) => TimelineRef | null
  /** Why an issue close happened (its `reason`, QW-069), or null for a plain close. */
  closeWhy?: (t: TransitionView) => CloseWhy | null
  /** PRs that mention this issue, placed in time order among the items. */
  crossRefs?: readonly CrossRefItem[]
}): JSX.Element {
  // The merge commits of this thread's merge transitions: a policy-bypass event is the record of
  // one of them only when it names it.
  const mergeOids = new Set(items.flatMap((x) => (x.kind === 'transition' && x.transition.kind === PR_MERGE && x.transition.oid ? [x.transition.oid.toLowerCase()] : [])))
  // Items and the PRs that mention this issue, in time order.
  const merged: ({ kind: 'item'; item: TimelineItem; i: number } | { kind: 'ref'; ref: CrossRefItem })[] = items.map((item, i) => ({ kind: 'item', item, i }))
  for (const ref of [...crossRefs].sort((a, b) => a.at - b.at)) {
    // After every row at or before it (the items are oldest first).
    let at = merged.length
    while (at > 0) {
      const prev = merged[at - 1]!
      if ((prev.kind === 'item' ? prev.item.at : prev.ref.at) <= ref.at) break
      at--
    }
    merged.splice(at, 0, { kind: 'ref', ref })
  }
  // A long timeline shows its ends; "Load more" reveals the middle in pages (QW2-010). Rows that
  // arrive after the first render join the shown end; another thread starts folded afresh.
  const first = items[0] === undefined ? '' : itemKey(items[0])
  const [fold, setFold] = useState({ first, base: merged.length, revealed: 0 })
  if (fold.first !== first) setFold({ first, base: merged.length, revealed: 0 })
  const grown = Math.max(0, merged.length - fold.base)
  const win = timelineWindow(merged.length - grown, fold.revealed)
  const tail = win.tail + (win.hidden > 0 ? grown : 0)
  const head = win.hidden > 0 ? win.head : merged.length
  const cut = merged.length - tail
  const rows: ReactNode[] = []
  merged.forEach((row, k) => {
    if (k >= head && k < cut) return
    if (k === cut && head < cut) {
      rows.push(
        <div key="fold" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-anvil-300 px-4 py-3 text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="timeline-fold">
          <span>{plural(cut - head, 'hidden item')}</span>
          <button type="button" onClick={() => setFold((f) => ({ ...f, revealed: f.revealed + TIMELINE_PAGE }))} className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400">
            Load more…
          </button>
        </div>,
      )
    }
    if (row.kind === 'ref') {
      const r = row.ref
      rows.push(
        <div key={`x-${r.id}`} className={EVENT_ROW} data-testid="timeline-event" data-kind="cross-reference">
          <span className={EVENT_ICON}>{crossRefIcon(r.state)}</span>
          <p className={EVENT_TEXT}>
            <Author identityId={r.actor} link={false} className="align-middle" /> mentioned this issue in <RefLink to={r} />
            <span className="whitespace-nowrap"> · {timeAgo(r.at)}</span>
          </p>
        </div>,
      )
    } else rows.push(renderItem(row.item, row.i))
  })
  return <div className="space-y-3">{rows}</div>

  function renderItem(item: TimelineItem, i: number): ReactNode {
        if (item.kind === 'comment') {
          const slot = renderComment?.(item) ?? {}
          return (
            <div key={`c-${item.comment.id}-${i}`} className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="timeline-comment">
              <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense coarse:min-h-12 dark:border-anvil-800 dark:bg-anvil-900">
                <Byline
                  author={item.comment.author}
                  createdAt={item.comment.createdAt}
                  origin={trustedOrigin(item.comment.origin, item.comment.author, trust)}
                  verb={commentVerb(item)}
                />
                <EditedMarker createdAt={item.comment.createdAt} updatedAt={item.comment.updatedAt} />
                {slot.header}
              </div>
              {slot.body ?? (
                <div className="px-4 py-3">
                  <MarkdownView source={item.comment.body} links={links} imported={importedUrlOf(item.comment.importedRaw)} />
                </div>
              )}
            </div>
          )
        }
        if (item.kind === 'review') {
          const { review } = item
          // A mirrored review records its source verdict in its provenance line; the document's
          // own verdict is a comment (a mirror identity's approval would count as a maintainer's).
          // Shown as what the source reviewer did, never as counted.
          const origin = trustedOrigin(review.origin, review.reviewer, trust)
          const source = origin !== null ? importedVerdictOf(review.body) : null
          // A mirrored "commented" review with nothing of its own (a reply's wrapper at the
          // source): one line, as GitHub shows no card for it (QW2-010).
          if (origin !== null && isEmptyMirroredReview(item)) {
            return (
              <div key={`r-${review.id}-${i}`} className={EVENT_ROW} data-testid="timeline-event" data-kind="mirrored-review">
                <span className={EVENT_ICON}>{verdictIcon(review.verdict)}</span>
                <p className={`${EVENT_TEXT} flex flex-wrap items-center gap-x-1.5`}>
                  <Byline author={review.reviewer} createdAt={review.createdAt} origin={origin} verb="reviewed" link={false} />
                </p>
              </div>
            )
          }
          return (
            <div key={`r-${review.id}-${i}`} className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
              <div className="flex flex-wrap items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense coarse:min-h-12 coarse:gap-y-3 coarse:py-3 dark:border-anvil-800 dark:bg-anvil-900">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-anvil-100 dark:bg-anvil-800">
                  {verdictIcon(review.verdict)}
                </span>
                <Byline author={review.reviewer} createdAt={review.createdAt} origin={origin} verb={source ?? VERDICT_LABEL[review.verdict]} />
                {source !== null && source !== 'commented' ? (
                  <span
                    data-testid="imported-verdict"
                    className="rounded-full border border-anvil-300 px-2 py-0.5 text-[11px] text-anvil-700 dark:border-anvil-700 dark:text-anvil-200"
                    title="The verdict on the source forge. It does not count toward approvals here: only reviews by this repo's maintainers and writers do."
                  >
                    {source} on {origin?.host || 'the source'} · not counted here
                  </span>
                ) : null}
                {/* Which commit was reviewed: a verdict on an older head is not a verdict on
                    the current one, and only the oid says which. */}
                {review.commitOid ? (
                  <span className="flex items-center gap-1 text-anvil-500 dark:text-anvil-400">on <Oid value={review.commitOid} chars={9} /></span>
                ) : null}
              </div>
              {/* A mirrored review with no text of its own: its header already says who and when. */}
              {review.body && !(origin !== null && searchableBody(review.body).trim() === '') ? (
                <div className="px-4 py-3">
                  <MarkdownView source={review.body} links={links} imported={review.origin?.url ?? null} />
                </div>
              ) : null}
              {item.comments.length > 0 || item.expected > 0 ? (
                <div className="space-y-2 border-t border-anvil-200 px-4 py-3 dark:border-anvil-800" data-testid="review-comments">
                  {item.comments.map((c) => (
                    <ReviewComment key={c.id} comment={c} links={links} trust={trust} anchorContext={anchorContext} slot={renderComment?.({ kind: 'comment', at: c.createdAt, comment: c }) ?? {}} />
                  ))}
                  {/* A submit writes the review first, then its comments: say when some have not landed (yet). */}
                  {item.expected > item.comments.length ? (
                    <p className="text-[12px] text-anvil-600 dark:text-anvil-400">
                      {item.comments.length} of {plural(item.expected, 'comment')} shown: the rest are still landing or were deleted.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        }
        if (item.kind === 'transition') {
          const t = item.transition
          // A close that says it was not done (not planned, a duplicate) says so, whatever PR
          // mentioned the issue; a completed one names the PR whose merge closed it.
          const said = closeWhy?.(t) ?? null
          const cause = said?.skipped ? null : closedIn?.(t) ?? null
          const why = cause === null ? said : null
          return (
            <div key={`t-${t.id}-${i}`} className={EVENT_ROW} data-testid="timeline-event" data-kind={`transition-${t.kind}`}>
              <span className={EVENT_ICON}>{why?.skipped ? <CircleSlash className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden data-icon="closed-skipped" /> : transitionIcon(t.kind)}</span>
              {/* One sentence that wraps as text (QW-070): the age never breaks onto a line of its own. */}
              <p className={EVENT_TEXT}>
                <Author identityId={t.actor} link={false} className="align-middle" />{' '}
                {cause !== null ? (
                  <>
                    closed this as completed in <RefLink to={cause} />
                    <span className="whitespace-nowrap"> · {timeAgo(t.createdAt)}</span>
                  </>
                ) : why?.duplicate ? (
                  <>
                    closed this as a duplicate of <RefLink to={why.duplicate} />
                    <span className="whitespace-nowrap"> · {timeAgo(t.createdAt)}</span>
                  </>
                ) : why !== null ? (
                  <WithAge text={why.phrase} age={timeAgo(t.createdAt)} />
                ) : t.kind === PR_MERGE && t.oid ? (
                  <>
                    {transitionPhrase(t.kind)} at{' '}
                    <span className="whitespace-nowrap">
                      <Oid value={t.oid} chars={9} /> · {timeAgo(t.createdAt)}
                    </span>
                  </>
                ) : (
                  <WithAge text={transitionPhrase(t.kind)} age={timeAgo(t.createdAt)} />
                )}
              </p>
            </div>
          )
        }
        const own = eventText?.(item.event) ?? (item.event.kind === 'policyBypass' ? bypassPhrase(item.event.value, mergeOids.has((item.event.oid ?? '').toLowerCase())) : null)
        const base = eventPhrase(item.event)
        const phrase = own === null ? base : { ...base, text: own }
        return (
          <div key={`e-${item.event.id}-${i}`} className={EVENT_ROW} data-testid="timeline-event" data-kind={item.event.kind}>
            <span className={EVENT_ICON}>{phrase.icon}</span>
            <p className={EVENT_TEXT}>
              <Author identityId={item.event.actor} link={false} className="align-middle" />{' '}
              {phrase.who ? (
                <>
                  {phrase.text}{' '}
                  <span className="whitespace-nowrap">
                    <Author identityId={phrase.who} link={false} className="align-middle" /> · {timeAgo(item.event.createdAt)}
                  </span>
                </>
              ) : (
                <WithAge text={phrase.text} age={timeAgo(item.event.createdAt)} />
              )}
            </p>
          </div>
        )
  }
}
