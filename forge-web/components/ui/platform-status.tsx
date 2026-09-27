'use client'

/**
 * The Platform connection's loading and unreachable states (D-025, D-058).
 *
 *   - {@link ConnectingBlock}: while the SDK's WebAssembly downloads (seconds on a fast link,
 *     minutes on a slow one) a progress bar with bytes, then "Connecting".
 *   - {@link UnreachableBanner}: the connect failed. Plain words, the next automatic retry,
 *     a "Try again" that really reconnects, and the underlying error behind a disclosure.
 *     With `cached`, it heads cached content rather than replacing the page.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

import { Spinner } from '@/components/ui/states'
import { Button } from '@/components/ui/button'
import type { SdkStatus } from '@/lib/sdk'
import { useUiStore } from '@/hooks/use-ui-store'

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** The download/connect indicator for a view waiting on the SDK. */
export function ConnectingBlock({ status }: { status: SdkStatus }): JSX.Element {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      {status.phase === 'downloading' ? <DownloadProgressBar status={status} /> : <Spinner label="Connecting to Platform" />}
    </div>
  )
}

/** Bytes of the SDK download, with a determinate bar when the size is known. */
export function DownloadProgressBar({ status }: { status: Extract<SdkStatus, { phase: 'downloading' }> }): JSX.Element {
  const { loaded, total } = status.progress
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null
  const bytes = total > 0 ? `${mb(loaded)} of ${mb(total)}` : mb(loaded)
  return (
    <div className="w-full max-w-sm space-y-2 text-center" data-testid="sdk-download">
      <p className="text-dense text-anvil-600 dark:text-anvil-300">Downloading the Platform verifier</p>
      <div
        role="progressbar"
        aria-label="Platform verifier download"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={bytes}
        className="h-1.5 w-full overflow-hidden rounded-full bg-anvil-200 dark:bg-anvil-800"
      >
        {/* The fill is a non-text graphic (WCAG 1.4.11, 3:1 against the track and the page):
            forge-700 on light, forge-500 on dark; lib/design/contrast.test.ts pins both. */}
        <div className="h-full bg-forge-700 transition-[width] duration-300 dark:bg-forge-500" style={{ width: `${pct ?? 5}%` }} />
      </div>
      <p className="text-dense tabular-nums text-anvil-500 dark:text-anvil-400">
        {bytes}
        {pct !== null ? ` · ${pct}%` : ''}
      </p>
      <p className="text-dense text-anvil-500 dark:text-anvil-400">Once per browser: it is cached after this.</p>
    </div>
  )
}

/** Seconds until `at`, updated each second (null when there is no scheduled time). */
function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (at === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [at])
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000))
}

/**
 * Platform could not be reached. Never claims the page is verified: with `cached`, it says the
 * content below is from earlier in this session and is not being re-checked right now.
 *
 * The alert (`role="alert"`, announced when it appears even though it mounts filled) holds
 * only the state sentence, so a screen reader hears the outage once, not the countdown every
 * second; the countdown sits outside it.
 */
export function UnreachableBanner({
  status,
  onRetry,
  cached = false,
}: {
  status: Extract<SdkStatus, { phase: 'error' }>
  onRetry: () => void
  cached?: boolean
}): JSX.Element {
  const seconds = useCountdown(status.retryAt)
  // The sign-in sheet has its own "Try again" for the same connection: one at a time (L-30).
  const sheetOpen = useUiStore((s) => s.loginOpen)
  return (
    <div
      data-testid="platform-unreachable"
      className="mb-4 rounded-lg border border-caution/40 bg-caution/10 px-4 py-3"
    >
      <div className="flex flex-wrap items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <div role="alert">
            <p className="text-prose font-medium text-anvil-900 dark:text-anvil-50">Can&apos;t reach Dash Platform right now</p>
            <p className="mt-0.5 text-dense text-anvil-700 dark:text-anvil-200">
              {cached
                ? 'Showing what this tab already read and checked. It is not being re-checked until the connection comes back.'
                : 'Nothing can be read or checked until the connection comes back.'}
            </p>
          </div>
          <p className="text-dense text-anvil-700 dark:text-anvil-200" data-testid="platform-retry-countdown">
            {seconds !== null ? `Trying again in ${seconds} s.` : 'This page will try again when it is visible.'}
          </p>
          <details className="mt-1 text-dense text-anvil-600 dark:text-anvil-300">
            <summary className="w-fit cursor-pointer coarse:-mx-2 coarse:flex coarse:min-h-11 coarse:min-w-11 coarse:items-center coarse:px-2">Details</summary>
            <p className="mt-1 break-words font-mono text-[12px]">{status.message}</p>
          </details>
        </div>
        {sheetOpen ? null : (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden /> Try again
          </Button>
        )}
      </div>
    </div>
  )
}
