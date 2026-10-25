'use client'

/**
 * One option on the sign-in sheet's list (`login-modal.tsx`): an icon, a title and a line of help,
 * as a button. Shared with the passkey sign-in, which keeps its progress and errors beside it.
 */

import type { Wallet } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Tile({
  icon: Icon,
  title,
  body,
  onClick,
  testId,
  muted = false,
  highlight = false,
  pausedReason = null,
}: {
  icon: typeof Wallet
  title: string
  body: string
  onClick: () => void
  testId: string
  /**
   * An option most people cannot use here: dashed, with a grey icon, still reachable (L-62).
   * Not faded: it is an enabled button, so its text keeps the 4.5:1 contrast (QW4-041: the
   * opacity took its helper text to 3.36:1).
   */
  muted?: boolean
  /** Something this browser has in progress: outlined in the accent colour. */
  highlight?: boolean
  /** Why this option cannot be used now (the devnet is moving): disabled, with the reason as its text. */
  pausedReason?: string | null
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-muted={muted || undefined}
      disabled={pausedReason !== null}
      onClick={onClick}
      className={cn(
        'disabled:pointer-events-none disabled:opacity-60',
        'flex w-full items-start gap-3 rounded-lg border border-anvil-200 px-3 py-3 text-left transition-colors hover:border-forge-400 hover:bg-anvil-50 dark:border-anvil-750 dark:hover:bg-anvil-850',
        muted && 'border-dashed',
        highlight && 'border-forge-500/60 bg-forge-500/5 dark:border-forge-500/50',
      )}
    >
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', muted ? 'text-anvil-500 dark:text-anvil-400' : 'text-forge-500')} aria-hidden />
      <span>
        <span className="block text-dense font-medium text-anvil-900 dark:text-anvil-50">{title}</span>
        <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">{pausedReason ?? body}</span>
      </span>
    </button>
  )
}
