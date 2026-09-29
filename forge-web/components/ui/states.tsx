'use client'

/**
 * Loading / empty / error states — real, in-voice states (never a blank screen).
 *   - Spinner: quiet post-paint indicator (no shimmer > 1s per the style guide).
 *   - EmptyState: an invitation to act, with an optional primary action.
 *   - ErrorState: what went wrong + how to fix it, in the app's plain voice. A read that failed
 *     because nothing answered (offline, Platform or storage unreachable) gets a plain offline
 *     state that retries by itself once the connection is back, with the raw error behind
 *     Details (L-56).
 */

import { AlertTriangle, Loader2, WifiOff, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { isUnreachableError } from '@/lib/sdk/unreachable'
import { scheduleReconnect } from '@/lib/view/reconnect'
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

/** Whether the browser reports no network connection now (and follows it). */
function useOffline(): boolean {
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    const update = (): void => setOffline(navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return offline
}

/**
 * Error state — what went wrong + how to recover. `cause` (or `message`) that says nothing
 * answered renders {@link UnreachableState} instead, which retries by itself.
 */
export function ErrorState({
  title = 'That read did not land',
  message,
  cause,
  onRetry,
}: {
  title?: string
  message: string
  /** The thrown value, when the caller has it (classified along with `message`). */
  cause?: unknown
  onRetry?: () => void
}): JSX.Element {
  if (onRetry && (isUnreachableError(cause) || isUnreachableError(message))) {
    return <UnreachableState message={message} onRetry={onRetry} />
  }
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-danger/30 bg-danger/5 px-6 py-10 text-center">
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger/10 text-danger-700 dark:text-danger-400">
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

/**
 * Nothing answered the read: offline, or Platform or the repo's storage did not respond. Says
 * so in plain words, retries by itself once the connection is back (backing off while it
 * stays down), and keeps the raw error behind Details.
 */
export function UnreachableState({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  const offline = useOffline()
  // The latest callback, so a caller's inline arrow does not restart the wait on every render.
  const retry = useRef(onRetry)
  retry.current = onRetry
  // Retry while this state is on screen (a read that lands replaces it), backing off between
  // attempts; offline, the next attempt waits for the connection.
  useEffect(() => {
    let cancel = (): void => undefined
    const arm = (): void => {
      cancel = scheduleReconnect(() => {
        retry.current()
        arm()
      })
    }
    arm()
    return () => cancel()
  }, [])
  return (
    <div
      data-testid="read-unreachable"
      className="flex flex-col items-center justify-center rounded-lg border border-caution/40 bg-caution/5 px-6 py-10 text-center"
    >
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-caution/10 text-caution-700 dark:text-caution-400">
        <WifiOff className="h-5 w-5" aria-hidden />
      </span>
      <h3 role="status" className="text-prose text-anvil-900 dark:text-anvil-50">
        {offline ? "You're offline" : "Couldn't reach Dash Platform"}
      </h3>
      <p className="mt-1.5 max-w-md text-dense text-anvil-600 dark:text-anvil-300">
        {offline
          ? 'This page will load as soon as your connection is back.'
          : 'Nothing answered this read. It will try again by itself in a few seconds.'}
      </p>
      <button
        onClick={onRetry}
        className="mt-4 rounded-md border border-anvil-300 px-3 py-1.5 text-dense hover:bg-anvil-100 coarse:min-h-11 dark:border-anvil-700 dark:hover:bg-anvil-800"
      >
        Try now
      </button>
      <details className="mt-3 max-w-md text-dense text-anvil-500 dark:text-anvil-400">
        <summary className="cursor-pointer coarse:min-h-11">Details</summary>
        <p className="mt-1 break-words font-mono text-[12px]">{message}</p>
      </details>
    </div>
  )
}
