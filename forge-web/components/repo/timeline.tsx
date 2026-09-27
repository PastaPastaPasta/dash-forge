'use client'

/**
 * Timeline — the interleaved comment + event + review stream of an issue/PR. Comments render
 * the author pill + markdown body; events render a compact, git-native one-liner ("closed
 * this", "added the bug label"); reviews render their verdict and the commit they were made
 * against. An `authorEvent` the fold ignores (not a close/reopen by the author) still appears
 * here as the audit trail it is.
 */

import { Check, CheckCircle2, Eye, GitCommit, GitMerge, Lock, LockOpen, Milestone, MessageSquare, Tag, UserPlus, X } from 'lucide-react'
import type { TimelineItem } from '@/lib/view'
import { timeAgo } from '@/lib/view'
import { anchorLabel } from '@/lib/view/inline-threads'
import { VERDICT_LABEL, type VerdictName } from '@/lib/repo'
import type { Event } from '@/lib/rules'
import { Author } from '@/components/author'
import { MarkdownView } from '@/components/markdown-view'
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
      return { text: 'assigned this', icon: <UserPlus className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> }
    case 'unassign':
      return { text: 'unassigned this', icon: <UserPlus className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> }
    case 'retarget':
      return { text: `retargeted to ${value ?? ''}`, icon: <GitMerge className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> }
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
    default:
      return { text: String(kind), icon: <Tag className={muted} aria-hidden /> }
  }
}

export function Timeline({ items }: { items: readonly TimelineItem[] }): JSX.Element {
  return (
    <div className="space-y-3">
      {items.map((item, i) => {
        if (item.kind === 'comment') {
          return (
            <div key={`c-${item.comment.id}-${i}`} className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
              <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
                <Author identityId={item.comment.author} />
                <span className="text-anvil-500 dark:text-anvil-400">commented {timeAgo(item.comment.createdAt)}</span>
              </div>
              <div className="px-4 py-3">
                <MarkdownView source={item.comment.body} />
              </div>
            </div>
          )
        }
        if (item.kind === 'review') {
          const { review } = item
          return (
            <div key={`r-${review.id}-${i}`} className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
              <div className="flex flex-wrap items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-anvil-100 dark:bg-anvil-800">
                  {verdictIcon(review.verdict)}
                </span>
                <Author identityId={review.reviewer} />
                <span className="text-anvil-500 dark:text-anvil-400">{VERDICT_LABEL[review.verdict]} {timeAgo(review.createdAt)}</span>
                {/* Which commit was reviewed: a verdict on an older head is not a verdict on
                    the current one, and only the oid says which. */}
                {review.commitOid ? (
                  <span className="flex items-center gap-1 text-anvil-500 dark:text-anvil-400">on <Oid value={review.commitOid} chars={9} /></span>
                ) : null}
              </div>
              {review.body ? (
                <div className="px-4 py-3">
                  <MarkdownView source={review.body} />
                </div>
              ) : null}
              {item.comments.length > 0 || item.expected > 0 ? (
                <div className="space-y-2 border-t border-anvil-200 px-4 py-3 dark:border-anvil-800" data-testid="review-comments">
                  {item.comments.map((c) => (
                    <div key={c.id}>
                      {c.anchor ? <p className="mb-1 font-mono text-[12px] text-anvil-600 dark:text-anvil-400">{anchorLabel(c.anchor)}</p> : null}
                      <MarkdownView source={c.body} />
                    </div>
                  ))}
                  {/* A submit writes the review first, then its comments: say when some have not landed (yet). */}
                  {item.expected > item.comments.length ? (
                    <p className="text-[12px] text-anvil-600 dark:text-anvil-400">
                      {item.comments.length} of {item.expected} comments have landed.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        }
        const phrase = eventPhrase(item.event)
        return (
          <div key={`e-${item.event.id}-${i}`} className="flex items-center gap-2 px-2 text-dense text-anvil-500 dark:text-anvil-400">
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
