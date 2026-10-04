'use client'

/**
 * Timeline — the interleaved comment + event + review stream of an issue/PR. Comments render
 * the author pill + markdown body; events render a compact, git-native one-liner ("closed
 * this", "added the bug label"); reviews render their verdict and the commit they were made
 * against; state changes (`transition`) render as "closed this", "merged this". An event the
 * folds ignore still appears here as the audit trail it is.
 */

import { Byline, Time } from '@/components/repo/byline'
import { importedVerdictOf, searchableBody, trustedOrigin, type Origin } from '@/lib/repo/provenance'
import { Check, CheckCircle2, CircleDot, CircleSlash, Eye, EyeOff, GitBranch, GitCommit, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Lock, LockOpen, Milestone, MessageSquare, Pencil, Pin, ShieldAlert, Tag, Trash2, UserPlus, X } from 'lucide-react'
import { STATE_TEXT } from '@/lib/design/state'
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
import { LongBodyNote } from '@/components/repo/long-body'
import { importedUrlOf } from '@/lib/view/ref-targets'
import { EditedMarker } from '@/components/repo/issue-bits'
import { Oid } from '@/components/ui/oid'
import { WithAge } from '@/components/ui/with-age'
import { HiddenRow, RevealedNote, reasonWords } from '@/components/repo/moderation'
import { isHideReason, isModerationKind, type HiddenItems } from '@/lib/rules/moderation'

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
      return { text: 'marked this as merged', icon: <GitMerge className={MERGED_ICON} aria-hidden /> }
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
      // Who posted the update need not be who pushed the commits (QW3-048): the page says who did when it knows.
      return { text: e.oid ? `updated the head to ${e.oid.slice(0, 9)}` : 'updated the head', icon: <GitCommit className={muted} aria-hidden /> }
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
    // RC2 MOD: a maintainer's hide is the audit trail of what readers see collapsed.
    case 'hide':
      return { text: `hid ${e.refId ? 'an item' : 'this'}${reasonWords(value && isHideReason(value) ? value : null)}`, icon: <EyeOff className={muted} aria-hidden /> }
    case 'unhide':
      return { text: `unhid ${e.refId ? 'an item' : 'this'}`, icon: <Eye className={muted} aria-hidden /> }
    default:
      return { text: String(kind), icon: <Tag className={muted} aria-hidden /> }
  }
}

/**
 * A hide's or unhide's line naming what it hid (RC2 MOD): "hid a comment by bob as spam". Null
 * for any other event, or a hide of the whole thread (its own phrase says "hid this").
 */
export function moderationNamed(
  e: Event,
  refs: ReadonlyMap<string, { readonly kind: 'comment' | 'review'; readonly author: string }>,
): { text: string; who: string; after: string } | null {
  if ((e.kind !== 'hide' && e.kind !== 'unhide') || !e.refId) return null
  const ref = refs.get(e.refId)
  if (ref === undefined) return null
  const verb = e.kind === 'hide' ? 'hid' : 'unhid'
  const reason = e.kind === 'hide' && e.value && isHideReason(e.value) ? reasonWords(e.value) : ''
  return { text: `${verb} a ${ref.kind} by`, who: ref.author, after: reason }
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

/** Open, closed and merged, in the colours of the issue and PR state badges. */
const OPEN_ICON = `h-3.5 w-3.5 ${STATE_TEXT.open}`
const CLOSED_ICON = `h-3.5 w-3.5 ${STATE_TEXT.done}`
const PR_CLOSED_ICON = `h-3.5 w-3.5 ${STATE_TEXT.closed}`
const MERGED_ICON = `h-3.5 w-3.5 ${STATE_TEXT.done}`

/**
 * The icon of a state change, as GitHub draws them (QW2-045): an issue closes with a check circle
 * and reopens with an open circle, a PR closes and reopens with its own pull-request glyphs, and
 * only a lock or unlock of the conversation shows a padlock.
 */
export function transitionIcon(kind: number): JSX.Element {
  const muted = 'h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400'
  switch (kind) {
    case PR_MERGE:
      return <GitMerge className={MERGED_ICON} aria-hidden />
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

/**
 * "bob marked #2 as a duplicate of this issue" (QW4-024): another issue of the repo closed as a
 * duplicate of this one, the back-reference GitHub adds to the canonical issue.
 */
export interface DuplicateRefItem extends TimelineRef {
  readonly id: string
  readonly actor: string
  readonly at: number
  /** The close was recorded by an import (`readDuplicatesOf`): the source's, when its signer is this thread's mirror. */
  readonly imported?: boolean
}

/** "bob deleted the feature branch" / "restored" (QW4-025): the PR's source branch, after the PR. */
export interface BranchEventItem {
  readonly id: string
  readonly actor: string
  readonly at: number
  readonly kind: 'deleted' | 'restored'
  /** The branch's short name. */
  readonly branch: string
}

/** A row placed among the items by time: a mention, a duplicate's back-reference, a branch event. */
type ExtraRow =
  | { readonly kind: 'ref'; readonly at: number; readonly ref: CrossRefItem }
  | { readonly kind: 'dup'; readonly at: number; readonly dup: DuplicateRefItem }
  | { readonly kind: 'branch'; readonly at: number; readonly branch: BranchEventItem }

function crossRefIcon(state: CrossRefItem['state']): JSX.Element {
  switch (state) {
    case 'merged':
      return <GitMerge className={MERGED_ICON} aria-hidden />
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

/** An imported thread: its trusted source (`trustedOrigin`), the identity that signed it, and when. */
export interface ImportedThread {
  readonly origin: Origin
  readonly signer: string
  /** The thread document's chain time (when the import wrote it). */
  readonly createdAt: number
}

/** How near one of the thread's imported documents a signer's state change counts as the import's (ms). */
export const IMPORT_WINDOW_MS = 30 * 60_000

/**
 * The chain times of what the thread's signer wrote as imported (the thread itself, and its
 * imported comments and reviews): a state change the same identity made within
 * {@link IMPORT_WINDOW_MS} of one of them was the import recording the source's state (QW4-006).
 * The signer is the repo owner or a maintainer, who may also act here: a change of theirs away
 * from any import is theirs, credited as usual.
 */
function importTimes(imported: ImportedThread | null, items: readonly TimelineItem[]): readonly number[] {
  if (imported === null) return []
  const out = [imported.createdAt]
  for (const x of items) {
    if (x.kind === 'comment' && x.comment.author === imported.signer && x.comment.origin) out.push(x.comment.createdAt)
    if (x.kind === 'review') {
      if (x.review.reviewer === imported.signer && x.review.origin) out.push(x.review.createdAt)
      for (const c of x.comments) if (c.author === imported.signer && c.origin) out.push(c.createdAt)
    }
  }
  return out
}

/**
 * Where an imported state change happened, after its phrase: "on github.com" (the source page,
 * which says who and when: a `transition` has no provenance field, so the import records only the
 * state) and when it was mirrored. Never the mirror identity, nor the import time as when it happened.
 */
function OnSource({ origin, at }: { origin: Origin; at: number }): JSX.Element {
  const host = origin.host || 'the source'
  return (
    <>
      {' '}on{' '}
      {origin.url ? (
        <a href={origin.url} target="_blank" rel="noopener noreferrer" className="font-medium text-anvil-800 hover:text-forge-700 hover:underline dark:text-anvil-100 dark:hover:text-forge-400" title="Who did it, and when, is on the source page">
          {host}
        </a>
      ) : (
        host
      )}{' '}
      <span className="whitespace-nowrap rounded bg-anvil-100 px-1.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300" data-testid="imported-transition">
        <Time ms={at} prefix="mirrored " />
      </span>
    </>
  )
}

/** "closed this as not planned" as a sentence with no actor: "Closed as not planned". */
export function sourcePhrase(phrase: string): string {
  const s = phrase.replace(/^(\S+) this\b ?/, '$1 ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
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
          <LongBodyNote long={c.long} />
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
  items: allItems,
  links,
  renderComment,
  eventText,
  anchorContext,
  trust = null,
  closedIn,
  closeWhy,
  crossRefs = [],
  duplicateRefs = [],
  branchEvents = [],
  imported = null,
  moderation,
  moderate,
}: {
  items: readonly TimelineItem[]
  /** Where `#n` / `@name` in bodies link (omit: plain text). Keep it referentially stable. */
  links?: MarkdownLinks
  /** A comment's additions: the author's Edit in the header, the inline editor as its body. */
  renderComment?: (item: Extract<TimelineItem, { kind: 'comment' }>) => CommentSlots
  /**
   * A page's own wording for an event (the PR page counts the commits a head update pushed, and
   * names who pushed them when that is not who posted it: `who`), or null.
   */
  eventText?: (e: Event) => string | { readonly text: string; readonly who?: string } | null
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
  /** Issues closed as a duplicate of this one (QW4-024), in time order among the items. */
  duplicateRefs?: readonly DuplicateRefItem[]
  /** The PR's source branch deleted or restored (QW4-025), in time order among the items. */
  branchEvents?: readonly BranchEventItem[]
  /**
   * The thread's own trusted import (`trustedOrigin` of the issue or PR) and who signed it: a state
   * change the same mirror identity recorded is the source's, shown as such (QW4-006).
   */
  imported?: ImportedThread | null
  /** What maintainers hid (RC2 MOD): those comments and reviews show collapsed, with Show. */
  moderation?: HiddenItems
  /** A maintainer's Hide / Unhide for a comment or review (omit: the viewer is no maintainer). */
  moderate?: (item: { readonly kind: 'comment' | 'review'; readonly id: string }) => ReactNode
}): JSX.Element {
  // A hide or unhide the reader rule did not count (a writer's without the contract's proof, a
  // refId of another thread) is noise anyone could write, not the moderation record: left out.
  const items = allItems.some((x) => x.kind === 'event' && isModerationKind(x.event))
    ? allItems.filter((x) => x.kind !== 'event' || !isModerationKind(x.event) || (moderation?.counted.includes(x.event.id ?? '') ?? false))
    : allItems
  // The hidden items this reader expanded (nothing is deleted: anyone may read them).
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const reveal = (id: string, on: boolean): void =>
    setRevealed((cur) => {
      const next = new Set(cur)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const imports = importTimes(imported, items)
  const hiddenOf = (id: string) => (revealed.has(id) ? null : moderation?.items[id] ?? null)
  // What a hide's refId names, for its timeline line ("hid a comment by bob").
  const refs = new Map<string, { kind: 'comment' | 'review'; author: string }>()
  for (const x of items) {
    if (x.kind === 'comment') refs.set(x.comment.id, { kind: 'comment', author: x.comment.author })
    if (x.kind === 'review') {
      refs.set(x.review.id, { kind: 'review', author: x.review.reviewer })
      for (const c of x.comments) refs.set(c.id, { kind: 'comment', author: c.author })
    }
  }
  // The merge commits of this thread's merge transitions: a policy-bypass event is the record of
  // one of them only when it names it.
  const mergeOids = new Set(items.flatMap((x) => (x.kind === 'transition' && x.transition.kind === PR_MERGE && x.transition.oid ? [x.transition.oid.toLowerCase()] : [])))
  // Items and the rows placed among them by time (mentions, duplicates, branch events).
  const extras: ExtraRow[] = [
    ...crossRefs.map((ref): ExtraRow => ({ kind: 'ref', at: ref.at, ref })),
    ...duplicateRefs.map((dup): ExtraRow => ({ kind: 'dup', at: dup.at, dup })),
    ...branchEvents.map((branch): ExtraRow => ({ kind: 'branch', at: branch.at, branch })),
  ].sort((a, b) => a.at - b.at)
  const merged: ({ kind: 'item'; item: TimelineItem; i: number; at: number } | ExtraRow)[] = items.map((item, i) => ({ kind: 'item', item, i, at: item.at }))
  for (const extra of extras) {
    // After every row at or before it (the items are oldest first).
    let at = merged.length
    while (at > 0 && merged[at - 1]!.at > extra.at) at--
    merged.splice(at, 0, extra)
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
    } else if (row.kind === 'dup') {
      const d = row.dup
      // A duplicate close an import recorded, by this thread's own mirror, is the source's (QW4-006).
      const sourced = imported !== null && d.imported === true && d.actor === imported.signer
      rows.push(
        <div key={`d-${d.id}`} className={EVENT_ROW} data-testid="timeline-event" data-kind="marked-duplicate">
          <span className={EVENT_ICON}><CircleSlash className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /></span>
          <p className={EVENT_TEXT}>
            {sourced ? 'Marked' : <><Author identityId={d.actor} link={false} className="align-middle" /> marked</>} <RefLink to={d} /> as a duplicate of this issue
            {sourced ? <> on {imported.origin.host || 'the source'}</> : <span className="whitespace-nowrap"> · {timeAgo(d.at)}</span>}
          </p>
        </div>,
      )
    } else if (row.kind === 'branch') {
      const b = row.branch
      rows.push(
        <div key={`b-${b.id}`} className={EVENT_ROW} data-testid="timeline-event" data-kind={`branch-${b.kind}`}>
          <span className={EVENT_ICON}>{b.kind === 'deleted' ? <Trash2 className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> : <GitBranch className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />}</span>
          <p className={EVENT_TEXT}>
            <Author identityId={b.actor} link={false} className="align-middle" /> {b.kind} the <span className="break-all font-mono text-[12px]">{b.branch}</span>{' '}
            <span className="whitespace-nowrap">branch · {timeAgo(b.at)}</span>
          </p>
        </div>,
      )
    } else rows.push(renderItem(row.item, row.i))
  })
  return <div className="space-y-3">{rows}</div>

  function renderItem(item: TimelineItem, i: number): ReactNode {
        if (item.kind === 'comment') {
          const slot = renderComment?.(item) ?? {}
          const cid = item.comment.id
          const actions = moderate?.({ kind: 'comment', id: cid })
          const hidden = hiddenOf(cid)
          if (hidden !== null) {
            return <HiddenRow key={`c-${cid}-${i}`} hidden={hidden} what="comment" author={item.comment.author} onShow={() => reveal(cid, true)} actions={actions} />
          }
          const shownHidden = moderation?.items[cid]
          return (
            <div key={`c-${cid}-${i}`} className="space-y-1">
            {shownHidden ? <RevealedNote hidden={shownHidden} onCollapse={() => reveal(cid, false)} /> : null}
            <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="timeline-comment">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense coarse:min-h-12 dark:border-anvil-800 dark:bg-anvil-900">
                <Byline
                  author={item.comment.author}
                  createdAt={item.comment.createdAt}
                  origin={trustedOrigin(item.comment.origin, item.comment.author, trust)}
                  verb={commentVerb(item)}
                />
                <EditedMarker createdAt={item.comment.createdAt} updatedAt={item.comment.updatedAt} />
                {slot.header}
                {actions ? <span className={slot.header ? '' : 'ml-auto'}>{actions}</span> : null}
              </div>
              {slot.body ?? (
                <div className="px-4 py-3">
                  <MarkdownView source={item.comment.body} links={links} imported={importedUrlOf(item.comment.importedRaw)} />
                  <LongBodyNote long={item.comment.long} />
                </div>
              )}
            </div>
            </div>
          )
        }
        if (item.kind === 'review') {
          const { review } = item
          const actions = moderate?.({ kind: 'review', id: review.id })
          const hidden = hiddenOf(review.id)
          if (hidden !== null) {
            // Display only: a hidden review's verdict still counts until it is dismissed.
            const counts = review.verdict === 'approve' || review.verdict === 'requestChanges'
            const note = counts ? (
              <span className="rounded-full border border-anvil-300 px-2 py-0.5 text-[11px] text-anvil-500 opacity-70 dark:border-anvil-700" data-testid="hidden-verdict">
                {VERDICT_LABEL[review.verdict]} · still counts unless dismissed
              </span>
            ) : null
            return <HiddenRow key={`r-${review.id}-${i}`} hidden={hidden} what="review" author={review.reviewer} onShow={() => reveal(review.id, true)} note={note} actions={actions} />
          }
          const shownHidden = moderation?.items[review.id]
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
            <div key={`r-${review.id}-${i}`} className="space-y-1">
            {shownHidden ? <RevealedNote hidden={shownHidden} onCollapse={() => reveal(review.id, false)} /> : null}
            <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
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
                {actions ? <span className="ml-auto">{actions}</span> : null}
              </div>
              {/* A mirrored review with no text of its own: its header already says who and when. */}
              {review.body && !(origin !== null && searchableBody(review.body).trim() === '') ? (
                <div className="px-4 py-3">
                  <MarkdownView source={review.body} links={links} imported={review.origin?.url ?? null} />
                  <LongBodyNote long={review.long} />
                </div>
              ) : null}
              {item.comments.length > 0 || item.expected > 0 ? (
                <div className="space-y-2 border-t border-anvil-200 px-4 py-3 dark:border-anvil-800" data-testid="review-comments">
                  {item.comments.map((c) => {
                    // An inline comment hidden on its own (one hidden with its review shows once the review is shown)
                    const own = moderation?.items[c.id]
                    const ownActions = moderate?.({ kind: 'comment', id: c.id })
                    if (own?.via === 'item' && !revealed.has(c.id)) {
                      return <HiddenRow key={c.id} hidden={own} what="comment" author={c.author} onShow={() => reveal(c.id, true)} actions={ownActions} />
                    }
                    const slot = renderComment?.({ kind: 'comment', at: c.createdAt, comment: c }) ?? {}
                    const header = ownActions ? <>{slot.header}<span className={slot.header ? '' : 'ml-auto'}>{ownActions}</span></> : slot.header
                    return <ReviewComment key={c.id} comment={c} links={links} trust={trust} anchorContext={anchorContext} slot={{ ...slot, header }} />
                  })}
                  {/* A submit writes the review first, then its comments: say when some have not landed (yet). */}
                  {item.expected > item.comments.length ? (
                    <p className="text-[12px] text-anvil-600 dark:text-anvil-400">
                      {item.comments.length} of {plural(item.expected, 'comment')} shown: the rest are still landing or were deleted.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            </div>
          )
        }
        if (item.kind === 'transition') {
          const t = item.transition
          // A close that says it was not done (not planned, a duplicate) says so, whatever PR
          // mentioned the issue; a completed one names the PR whose merge closed it.
          const said = closeWhy?.(t) ?? null
          // Recorded by the import (QW4-006): the source's change, said without an actor.
          const source = imported !== null && t.actor === imported.signer && imports.some((at) => Math.abs(at - t.createdAt) <= IMPORT_WINDOW_MS) ? imported.origin : null
          const cause = said?.skipped || source !== null ? null : closedIn?.(t) ?? null
          const why = cause === null ? said : null
          const words = (text: string): string => (source !== null ? sourcePhrase(text) : text)
          const age = source !== null ? <OnSource origin={source} at={t.createdAt} /> : <span className="whitespace-nowrap"> · {timeAgo(t.createdAt)}</span>
          return (
            <div key={`t-${t.id}-${i}`} className={EVENT_ROW} data-testid="timeline-event" data-kind={`transition-${t.kind}`} {...(source !== null ? { 'data-imported': 'true' } : {})}>
              <span className={EVENT_ICON}>{why?.skipped ? <CircleSlash className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden data-icon="closed-skipped" /> : transitionIcon(t.kind)}</span>
              {/* One sentence that wraps as text (QW-070): the age never breaks onto a line of its own. */}
              <p className={EVENT_TEXT}>
                {source === null ? <><Author identityId={t.actor} link={false} className="align-middle" />{' '}</> : null}
                {cause !== null ? (
                  <>
                    closed this as completed in <RefLink to={cause} />
                    {age}
                  </>
                ) : why?.duplicate ? (
                  <>
                    {words('closed this as a duplicate of')} <RefLink to={why.duplicate} />
                    {age}
                  </>
                ) : t.kind === PR_MERGE && t.oid ? (
                  <>
                    {words(transitionPhrase(t.kind))} at{' '}
                    <span className="whitespace-nowrap">
                      <Oid value={t.oid} chars={9} />
                      {source === null ? ` · ${timeAgo(t.createdAt)}` : null}
                    </span>
                    {source !== null ? age : null}
                  </>
                ) : source !== null ? (
                  <>
                    {words(why?.phrase ?? transitionPhrase(t.kind))}
                    {age}
                  </>
                ) : (
                  <WithAge text={why?.phrase ?? transitionPhrase(t.kind)} age={timeAgo(t.createdAt)} />
                )}
              </p>
            </div>
          )
        }
        const own = eventText?.(item.event) ?? (item.event.kind === 'policyBypass' ? bypassPhrase(item.event.value, mergeOids.has((item.event.oid ?? '').toLowerCase())) : null)
        const base = eventPhrase(item.event)
        const named = moderationNamed(item.event, refs)
        const phrase =
          own !== null
            ? typeof own === 'string' ? { ...base, text: own } : { ...base, text: own.text, who: own.who }
            : named !== null ? { ...base, ...named } : base
        return (
          <div key={`e-${item.event.id}-${i}`} className={EVENT_ROW} data-testid="timeline-event" data-kind={item.event.kind}>
            <span className={EVENT_ICON}>{phrase.icon}</span>
            <p className={EVENT_TEXT}>
              <Author identityId={item.event.actor} link={false} className="align-middle" />{' '}
              {phrase.who ? (
                <>
                  {phrase.text}{' '}
                  <span className="whitespace-nowrap">
                    <Author identityId={phrase.who} link={false} className="align-middle" />
                    {phrase.after ?? ''} · {timeAgo(item.event.createdAt)}
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
