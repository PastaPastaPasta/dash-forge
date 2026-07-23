'use client'

/**
 * Timeline — the interleaved comment + event stream of an issue/PR. Comments render the author
 * pill + markdown body; events render a compact, git-native one-liner ("closed this", "added
 * the bug label"). Spam events from non-holders are already folded out of state, but appear
 * here as the audit trail they are.
 */

import { GitMerge, Lock, LockOpen, Tag, UserPlus } from 'lucide-react'
import type { TimelineItem } from '@/lib/view'
import { timeAgo } from '@/lib/view'
import type { EventKind } from '@/lib/rules'
import { Author } from '@/components/author'
import { MarkdownView } from '@/components/markdown-view'

function eventPhrase(kind: EventKind, value?: string | null): { text: string; icon: JSX.Element } {
  switch (kind) {
    case 'close':
      return { text: 'closed this', icon: <Lock className="h-3.5 w-3.5 text-forge-500" aria-hidden /> }
    case 'reopen':
      return { text: 'reopened this', icon: <LockOpen className="h-3.5 w-3.5 text-verify" aria-hidden /> }
    case 'merge':
      return { text: 'merged this', icon: <GitMerge className="h-3.5 w-3.5 text-dash" aria-hidden /> }
    case 'labelAdd':
      return { text: `added the ${value ?? ''} label`, icon: <Tag className="h-3.5 w-3.5 text-anvil-400" aria-hidden /> }
    case 'labelRemove':
      return { text: `removed the ${value ?? ''} label`, icon: <Tag className="h-3.5 w-3.5 text-anvil-400" aria-hidden /> }
    case 'assign':
      return { text: 'assigned this', icon: <UserPlus className="h-3.5 w-3.5 text-anvil-400" aria-hidden /> }
    case 'unassign':
      return { text: 'unassigned this', icon: <UserPlus className="h-3.5 w-3.5 text-anvil-400" aria-hidden /> }
    case 'retarget':
      return { text: `retargeted to ${value ?? ''}`, icon: <GitMerge className="h-3.5 w-3.5 text-anvil-400" aria-hidden /> }
    case 'draft':
      return { text: 'marked as draft', icon: <Lock className="h-3.5 w-3.5 text-anvil-400" aria-hidden /> }
    case 'ready':
      return { text: 'marked ready for review', icon: <LockOpen className="h-3.5 w-3.5 text-anvil-400" aria-hidden /> }
    default:
      return { text: String(kind), icon: <Tag className="h-3.5 w-3.5 text-anvil-400" aria-hidden /> }
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
                <span className="text-anvil-400">commented {timeAgo(item.comment.createdAt)}</span>
              </div>
              <div className="px-4 py-3">
                <MarkdownView source={item.comment.body} />
              </div>
            </div>
          )
        }
        const phrase = eventPhrase(item.event.kind, item.event.value)
        return (
          <div key={`e-${item.event.id}-${i}`} className="flex items-center gap-2 px-2 text-dense text-anvil-500 dark:text-anvil-400">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-anvil-100 dark:bg-anvil-800">
              {phrase.icon}
            </span>
            <Author identityId={item.event.actor} link={false} />
            <span>{phrase.text}</span>
            <span className="text-anvil-400">· {timeAgo(item.event.createdAt)}</span>
          </div>
        )
      })}
    </div>
  )
}
