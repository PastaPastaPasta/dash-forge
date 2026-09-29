'use client'

/**
 * Timeline — the interleaved comment + event + review stream of an issue/PR. Comments render
 * the author pill + markdown body; events render a compact, git-native one-liner ("closed
 * this", "added the bug label"); reviews render their verdict and the commit they were made
 * against; state changes (`transition`) render as "closed this", "merged this". An event the
 * folds ignore still appears here as the audit trail it is.
 */

import { Byline } from '@/components/repo/byline'
import { importedVerdictOf, trustedOrigin } from '@/lib/repo/provenance'
import { Check, CheckCircle2, Eye, GitCommit, GitMerge, GitPullRequestDraft, Lock, LockOpen, Milestone, MessageSquare, Pin, Tag, UserPlus, X } from 'lucide-react'
import type { TimelineItem } from '@/lib/view'
import { branchName, plural, timeAgo } from '@/lib/view'
import { anchorLabel } from '@/lib/view/inline-threads'
import { VERDICT_LABEL, type VerdictName } from '@/lib/repo'
import type { Event } from '@/lib/rules'
import { ISSUE_CLOSE, PR_CLOSE, PR_DRAFT, PR_DRAFT_CLOSE, PR_MERGE, PR_READY, transitionPhrase } from '@/lib/rules/transition'
import type { TransitionView } from '@/lib/repo'
import { Author } from '@/components/author'
import type { ReactNode } from 'react'
import { MarkdownView, type MarkdownLinks } from '@/components/markdown-view'
import { EditedMarker } from '@/components/repo/issue-bits'
import { Oid } from '@/components/ui/oid'

function verdictIcon(verdict: VerdictName): JSX.Element {
  switch (verdict) {
    case 'approve':
      return <Check className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden />
    case 'requestChanges':
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
    case 'close':
      return { text: 'closed this', icon: <Lock className="h-3.5 w-3.5 text-forge-500" aria-hidden /> }
    case 'reopen':
      return { text: 'reopened this', icon: <LockOpen className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden /> }
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
      return { text: 'converted this to a draft', icon: <Lock className={muted} aria-hidden /> }
    case 'ready':
      return { text: 'marked this ready for review', icon: <LockOpen className={muted} aria-hidden /> }
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
    default:
      return { text: String(kind), icon: <Tag className={muted} aria-hidden /> }
  }
}

/** The icon of a state change. */
function transitionIcon(t: TransitionView): JSX.Element {
  const muted = 'h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400'
  if (t.kind === PR_MERGE) return <GitMerge className="h-3.5 w-3.5 text-dash" aria-hidden />
  if (t.kind === ISSUE_CLOSE || t.kind === PR_CLOSE || t.kind === PR_DRAFT_CLOSE) return <Lock className="h-3.5 w-3.5 text-forge-500" aria-hidden />
  if (t.kind === PR_DRAFT || t.kind === PR_READY) return <GitPullRequestDraft className={muted} aria-hidden />
  return <LockOpen className={muted} aria-hidden />
}

/** What a page adds to a comment card: header actions, or a body that replaces the rendered one (an editor). */
export interface CommentSlots {
  readonly header?: ReactNode
  readonly body?: ReactNode
}

/** What a comment's header says it did. */
function commentVerb(item: Extract<TimelineItem, { kind: 'comment' }>): string {
  let verb = 'commented'
  if (item.orphaned === 'deleted') verb = 'replied to a deleted comment'
  else if (item.orphaned === 'hidden') verb = 'replied to a comment you cannot read'
  return item.comment.anchor ? `${verb} on ${anchorLabel(item.comment.anchor)}` : verb
}

export function Timeline({
  items,
  links,
  renderComment,
  eventText,
  commentLinks,
  trust = null,
}: {
  items: readonly TimelineItem[]
  /** Where `#n` / `@name` in bodies link (omit: plain text). Keep it referentially stable. */
  links?: MarkdownLinks
  /** A comment's additions: the author's Edit in the header, the inline editor as its body. */
  renderComment?: (item: Extract<TimelineItem, { kind: 'comment' }>) => CommentSlots
  /** A page's own wording for an event (the PR page counts the commits a head update pushed), or null. */
  eventText?: (e: Event) => string | null
  /** A comment's own link targets (a mirrored comment's `#n` names the source's item), else `links`. */
  commentLinks?: (comment: Extract<TimelineItem, { kind: 'comment' }>['comment']) => MarkdownLinks | undefined
  /** Who may mirror (`useMirrorTrust`): their imported comments and reviews show the original author and date. */
  trust?: ReadonlySet<string> | null
}): JSX.Element {
  return (
    <div className="space-y-3">
      {items.map((item, i) => {
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
                  <MarkdownView source={item.comment.body} links={commentLinks?.(item.comment) ?? links} />
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
              {review.body ? (
                <div className="px-4 py-3">
                  <MarkdownView source={review.body} links={links} />
                </div>
              ) : null}
              {item.comments.length > 0 || item.expected > 0 ? (
                <div className="space-y-2 border-t border-anvil-200 px-4 py-3 dark:border-anvil-800" data-testid="review-comments">
                  {item.comments.map((c) => (
                    <div key={c.id}>
                      {c.anchor ? <p className="mb-1 font-mono text-[12px] text-anvil-600 dark:text-anvil-400">{anchorLabel(c.anchor)}</p> : null}
                      <MarkdownView source={c.body} links={links} />
                    </div>
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
          return (
            <div key={`t-${t.id}-${i}`} className="flex flex-wrap items-center gap-2 px-2 text-dense text-anvil-500 dark:text-anvil-400" data-testid="timeline-event" data-kind={`transition-${t.kind}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-anvil-100 dark:bg-anvil-800">{transitionIcon(t)}</span>
              <Author identityId={t.actor} link={false} />
              <span>{transitionPhrase(t.kind)}</span>
              {t.kind === PR_MERGE && t.oid ? <span className="flex items-center gap-1">at <Oid value={t.oid} chars={9} /></span> : null}
              <span className="text-anvil-500 dark:text-anvil-400">· {timeAgo(t.createdAt)}</span>
            </div>
          )
        }
        const own = eventText?.(item.event) ?? null
        const base = eventPhrase(item.event)
        const phrase = own === null ? base : { ...base, text: own }
        return (
          <div key={`e-${item.event.id}-${i}`} className="flex flex-wrap items-center gap-2 px-2 text-dense text-anvil-500 dark:text-anvil-400" data-testid="timeline-event" data-kind={item.event.kind}>
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-anvil-100 dark:bg-anvil-800">
              {phrase.icon}
            </span>
            <Author identityId={item.event.actor} link={false} />
            <span>{phrase.text}</span>
            {phrase.who ? <Author identityId={phrase.who} link={false} /> : null}
            <span className="text-anvil-500 dark:text-anvil-400">· {timeAgo(item.event.createdAt)}</span>
          </div>
        )
      })}
    </div>
  )
}
