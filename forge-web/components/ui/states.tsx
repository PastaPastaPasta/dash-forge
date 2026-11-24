'use client'

/**
 * Loading / empty / error states — real, in-voice states (never a blank screen).
 *   - Spinner: quiet post-paint indicator (no shimmer > 1s per the style guide).
 *   - EmptyState: an invitation to act, with an optional primary action.
 *   - ErrorState: what went wrong + how to fix it, in the app's plain voice. A read that failed
 *     because nothing answered (offline, Platform or storage unreachable) gets a plain offline
 *     state that retries by itself once the connection is back, with the raw error behind
 *     Details (L-56). An answer that failed its proof check is a verification failure, said in
 *     plain words, never the raw verifier message (QW-057).
 */

import { AlertTriangle, Clock, Loader2, ShieldX, WifiOff, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { isUnreachableError } from '@/lib/sdk/unreachable'
import { clockSkewErrorCopy } from '@/lib/sdk/clock-skew'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { proofFailureCopy, unreachableReadCopy, type FailureCopy } from '@/lib/view/platform-failure'
import { scheduleReconnect } from '@/lib/view/reconnect'
import { isOffline, subscribeOnlineStatus } from '@/lib/online'
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

/** When a loading state adds that the network is slow (and offers Try again where it can). */
export const SLOW_AFTER_MS = 10_000

/** Whole seconds since mount, or since `resetKey` last changed; ticks once a second. */
export function useElapsed(resetKey: string = ''): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    setElapsed(0)
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(t)
  }, [resetKey])
  return elapsed
}

/** Whether `resetKey` has stayed the same for {@link SLOW_AFTER_MS} (one timer, no ticking). */
export function useSlow(resetKey: string = ''): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS)
    return () => clearTimeout(t)
  }, [resetKey])
  return slow
}

/** A retry that also restarts the caller's slow-read clock: the attempt count keys it. */
export function useRetryAttempt(onRetry: (() => void) | undefined): [attempt: number, retry: (() => void) | undefined] {
  const [attempt, setAttempt] = useState(0)
  if (onRetry === undefined) return [attempt, undefined]
  return [
    attempt,
    () => {
      setAttempt((n) => n + 1)
      onRetry()
    },
  ]
}

/**
 * A centered loading block for whole-view fetches. Past {@link SLOW_AFTER_MS} it says the
 * network is slow, with Try again when the caller passes `onRetry`, so a long read never looks
 * stuck.
 */
export function LoadingBlock({ label = 'Reading from Platform', onRetry }: { label?: string; onRetry?: () => void }): JSX.Element {
  const [attempt, retry] = useRetryAttempt(onRetry)
  const slow = useSlow(String(attempt))
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <Spinner label={label} />
      {slow ? <SlowNote onRetry={retry} /> : null}
    </div>
  )
}

/** "Taking longer than usual", with Try again when the read can be restarted. */
export function SlowNote({ onRetry }: { onRetry?: (() => void) | undefined }): JSX.Element {
  return (
    <div className="flex flex-col items-center" data-testid="loading-slow">
      <p role="status" className="max-w-sm text-dense text-anvil-500 dark:text-anvil-400">
        This is taking longer than usual: the network is slow. Still trying…
      </p>
      {onRetry ? <RetryButton onClick={onRetry} className="mt-2" /> : null}
    </div>
  )
}

/**
 * A list's loading state inside its frame (issues, pull requests): what is read, rows shaped like
 * the list under it, and past {@link SLOW_AFTER_MS} the slow note with Try again.
 */
export function ListLoading({ label, onRetry, rows = 5 }: { label: string; onRetry?: () => void; rows?: number }): JSX.Element {
  const [attempt, retry] = useRetryAttempt(onRetry)
  const slow = useSlow(String(attempt))
  return (
    <div className="space-y-3 px-4 py-4" data-testid="list-loading">
      <Spinner label={label} />
      {slow ? <SlowNote onRetry={retry} /> : null}
      <ListSkeleton rows={rows} className="border-0" />
    </div>
  )
}

/**
 * The shape of a list (files, issues, pull requests) while it loads: static blocks, no shimmer
 * (style guide). Hidden from assistive tech: the loading label beside it says what is read.
 */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }): JSX.Element {
  return (
    <div aria-hidden className={cn('overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800', className)} data-testid="list-skeleton">
      <div className="flex items-center gap-3 border-b border-anvil-200 bg-anvil-50 px-4 py-2.5 dark:border-anvil-800 dark:bg-anvil-900">
        <span className="h-3 w-24 rounded bg-anvil-200 dark:bg-anvil-800" />
        <span className="h-3 w-16 rounded bg-anvil-200 dark:bg-anvil-800" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-3 last:border-b-0 dark:border-anvil-850">
          <span className="h-4 w-4 shrink-0 rounded-full bg-anvil-200 dark:bg-anvil-800" />
          <span className="h-3 rounded bg-anvil-200 dark:bg-anvil-800" style={{ width: `${40 + ((i * 37) % 45)}%` }} />
          <span className="ml-auto h-3 w-12 shrink-0 rounded bg-anvil-100 dark:bg-anvil-850" />
        </div>
      ))}
    </div>
  )
}

/** Empty state — the invitation to act. */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  heading: Heading = 'h3',
}: {
  icon?: LucideIcon
  title: string
  body?: string
  action?: ReactNode
  /** The title's level: `h1` when the state is the whole page (a sign-in gate, QW4-044). */
  heading?: 'h1' | 'h2' | 'h3'
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-anvil-300 px-6 py-9 text-center dark:border-anvil-700">
      {Icon ? (
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-raised text-fg-muted ring-1 ring-inset ring-anvil-200 dark:ring-anvil-700">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      ) : null}
      <Heading className="text-prose">{title}</Heading>
      {body ? <p className="mt-1.5 max-w-sm text-anvil-500 dark:text-anvil-400">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/** Whether the browser reports no network connection now (and follows it). */
export function useOffline(): boolean {
  return useSyncExternalStore(subscribeOnlineStatus, isOffline, () => false)
}

/** "Try again" for an offline or unreachable state (the words the Platform banner uses). */
export function RetryButton({ onClick, className = 'mt-4' }: { onClick: () => void; className?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(className, 'rounded-md border border-anvil-300 px-3 py-1.5 text-dense hover:bg-anvil-100 coarse:min-h-11 dark:border-anvil-700 dark:hover:bg-anvil-800')}
    >
      Try again
    </button>
  )
}

/** The raw error, behind a collapsed Details: there for a bug report, not in the reader's face. */
export function ErrorDetails({ message }: { message: string }): JSX.Element {
  return (
    <details className="mt-3 max-w-md text-dense text-anvil-500 dark:text-anvil-400">
      <summary className="cursor-pointer coarse:min-h-11">Details</summary>
      <p className="mt-1 break-words font-mono text-[12px]">{message}</p>
    </details>
  )
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
  // A proof that failed is an answer, and the data was wrong: say so, and keep the raw hashes
  // behind Details (QW-057). Never the retrying offline state.
  const proof = proofFailureCopy(message) ?? proofFailureCopy(cause)
  if (proof !== null) return <ProofFailedState copy={proof} message={message} onRetry={onRetry} />
  // The device clock, not the network: say that, not "did not land · try another server" (QW2-018).
  const clock = clockSkewErrorCopy(message, { short: true }) ?? clockSkewErrorCopy(cause, { short: true })
  if (clock !== null) return <ClockSkewState copy={clock} message={message} onRetry={onRetry} />
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
 * A read refused because this device's clock is too far off the network's: what to fix, with
 * the SDK's raw timestamps behind Details. Try again stays: it works once the clock is set.
 */
function ClockSkewState({ copy, message, onRetry }: { copy: FailureCopy; message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div
      data-testid="read-clock-skew"
      className="flex flex-col items-center justify-center rounded-lg border border-danger/30 bg-danger/5 px-6 py-10 text-center"
    >
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger/10 text-danger-700 dark:text-danger-400">
        <Clock className="h-5 w-5" aria-hidden />
      </span>
      <h3 role="alert" className="text-prose text-anvil-900 dark:text-anvil-50">
        {copy.title}
      </h3>
      <p className="mt-1.5 max-w-md text-dense text-anvil-600 dark:text-anvil-300">{copy.body}</p>
      {onRetry ? <RetryButton onClick={onRetry} /> : null}
      <ErrorDetails message={message} />
    </div>
  )
}

/**
 * A read's answer failed its proof check: a verification failure, in the danger colour, with
 * what it means and what to do, and the verifier's raw message (GroveDB hashes) behind Details.
 */
function ProofFailedState({ copy, message, onRetry }: { copy: FailureCopy; message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div
      data-testid="read-proof-failed"
      className="flex flex-col items-center justify-center rounded-lg border border-danger/40 bg-danger/5 px-6 py-10 text-center"
    >
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger/10 text-danger-700 dark:text-danger-400">
        <ShieldX className="h-5 w-5" aria-hidden />
      </span>
      <h3 role="alert" className="text-prose text-anvil-900 dark:text-anvil-50">
        {copy.title}
      </h3>
      <p className="mt-1.5 max-w-md text-dense text-anvil-600 dark:text-anvil-300">{copy.body}</p>
      {onRetry ? <RetryButton onClick={onRetry} /> : null}
      <ErrorDetails message={message} />
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
  // A proof signed by a quorum whose key the app lacks is the key service lagging (#212), not
  // an outage: named as such (QW-056).
  const copy = unreachableReadCopy(message, { network: DEFAULT_NETWORK, offline })
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
        {copy.title}
      </h3>
      <p className="mt-1.5 max-w-md text-dense text-anvil-600 dark:text-anvil-300">{copy.body}</p>
      <RetryButton onClick={onRetry} />
      <ErrorDetails message={message} />
    </div>
  )
}
