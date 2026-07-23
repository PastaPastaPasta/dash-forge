/**
 * Loading / empty / error states — real, in-voice states (never a blank screen).
 *   - Spinner: quiet post-paint indicator (no shimmer > 1s per the style guide).
 *   - EmptyState: an invitation to act, with an optional primary action.
 *   - ErrorState: what went wrong + how to fix it, in the app's plain voice.
 */

import { AlertTriangle, Loader2, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Inline spinner with an accessible label. */
export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }): JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-2 text-anvil-500 dark:text-anvil-400', className)}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span className="text-dense">{label}</span>
      <span className="sr-only">{label}…</span>
    </span>
  )
}

/** A centered loading block for whole-view fetches. */
export function LoadingBlock({ label = 'Reading from Platform' }: { label?: string }): JSX.Element {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner label={label} />
    </div>
  )
}

/** Empty state — the invitation to act. */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon?: LucideIcon
  title: string
  body?: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-anvil-300 px-6 py-12 text-center dark:border-anvil-700">
      {Icon ? (
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-forge-500/10 text-forge-500">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      ) : null}
      <h3 className="text-prose">{title}</h3>
      {body ? <p className="mt-1.5 max-w-sm text-anvil-500 dark:text-anvil-400">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/** Error state — what went wrong + how to recover. */
export function ErrorState({
  title = 'That read did not land',
  message,
  onRetry,
}: {
  title?: string
  message: string
  onRetry?: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-danger/30 bg-danger/5 px-6 py-10 text-center">
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger/10 text-danger">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </span>
      <h3 className="text-prose text-anvil-900 dark:text-anvil-50">{title}</h3>
      <p className="mt-1.5 max-w-md break-words text-dense text-anvil-600 dark:text-anvil-300">{message}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-4 rounded-md border border-anvil-300 px-3 py-1.5 text-dense hover:bg-anvil-100 dark:border-anvil-700 dark:hover:bg-anvil-800"
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}
