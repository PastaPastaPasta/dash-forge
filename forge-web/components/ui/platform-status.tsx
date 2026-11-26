'use client'

/**
 * The Platform connection's loading and unreachable states (D-025, D-058).
 *
 *   - {@link DownloadProgressBar}: while the SDK's WebAssembly downloads (seconds on a fast link,
 *     minutes on a slow one) a progress bar with bytes (the repo loading view shows it). Offline,
 *     or with nothing arriving for {@link STALL_HINT_MS}, it says so; the download starts again
 *     by itself (`lib/sdk/wasm-fetch.ts`).
 *   - {@link UnreachableBanner}: the connect failed. Plain words, the next automatic retry,
 *     a "Try again" that really reconnects, and the underlying error behind a disclosure.
 *     With `cached`, it heads cached content rather than replacing the page.
 */

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { SdkStatus } from '@/lib/sdk'
import { useOffline } from '@/components/ui/states'
import { useUiStore } from '@/hooks/use-ui-store'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { connectFailureCopy } from '@/lib/view/platform-failure'
import { isQuorumServiceError } from '@/lib/sdk/unreachable'

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** A thin determinate bar (`pct` null: a sliver, the size not known yet). */
export function ProgressBar({ label, pct, valueText }: { label: string; pct: number | null; valueText: string }): JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={valueText}
      className="h-1.5 w-full overflow-hidden rounded-full bg-anvil-200 dark:bg-anvil-800"
    >
      {/* The fill is a non-text graphic (WCAG 1.4.11, 3:1 against the track and the page):
          forge-700 on light, forge-500 on dark; lib/design/contrast.test.ts pins both. */}
      <div className="h-full bg-forge-700 transition-[width] duration-300 dark:bg-forge-500" style={{ width: `${pct ?? 5}%` }} />
    </div>
  )
}

/** No new bytes for this long: the download view says it has stalled. */
export const STALL_HINT_MS = 15_000

/** Whether `loaded` has stayed the same for {@link STALL_HINT_MS} while online. */
function useStalled(loaded: number, offline: boolean): boolean {
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    setStalled(false)
    const id = setTimeout(() => setStalled(true), STALL_HINT_MS)
    return () => clearTimeout(id)
  }, [loaded, offline])
  return stalled
}

/** Bytes of the SDK download, with a determinate bar when the size is known. */
export function DownloadProgressBar({ status }: { status: Extract<SdkStatus, { phase: 'downloading' }> }): JSX.Element {
  const { loaded, total } = status.progress
  const offline = useOffline()
  const stalled = useStalled(loaded, offline)
  const note = offline
    ? "You're offline. The download starts again when you're back."
    : stalled
      ? 'The download has stalled. Check your connection. It starts again by itself.'
      : null
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null
  const bytes = total > 0 ? `${mb(loaded)} of ${mb(total)}` : mb(loaded)
  return (
    <div className="w-full max-w-sm space-y-2 text-center" data-testid="sdk-download">
      <p className="text-dense text-anvil-600 dark:text-anvil-300">Downloading the Platform verifier</p>
      <ProgressBar label="Platform verifier download" pct={pct} valueText={bytes} />
      <p className="text-dense tabular-nums text-anvil-500 dark:text-anvil-400">
        {bytes}
        {pct !== null ? ` · ${pct}%` : ''}
      </p>
      {note === null ? (
        <p className="text-dense text-anvil-500 dark:text-anvil-400">Once per browser: it is cached after this.</p>
      ) : null}
      <p role="status" className="text-dense font-medium text-anvil-800 empty:hidden dark:text-anvil-100" data-testid="sdk-download-note">
        {note}
      </p>
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
 * content below is from earlier in this session and is not being re-checked right now. A connect
 * that failed on the quorum key service says so, not that Platform is down
 * ({@link connectFailureCopy}).
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
  // Names the part that failed: the quorum key service is not Platform (QW-056).
  const offline = useOffline()
  const copy = connectFailureCopy(status.message, { network: DEFAULT_NETWORK, cached, offline })
  const quorumService = isQuorumServiceError(status.message)
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
            <p className="text-prose font-medium text-anvil-900 dark:text-anvil-50">{copy.title}</p>
            <p className="mt-0.5 text-dense text-anvil-700 dark:text-anvil-200">{copy.body}</p>
          </div>
          <p className="text-dense text-anvil-700 empty:hidden dark:text-anvil-200" data-testid="platform-retry-countdown">
            {offline ? null : status.stopped === true ? (
              <>
                It stopped retrying on its own. Check your connection, then choose Try again
                {quorumService ? (
                  <>
                    , or pick another quorum service in{' '}
                    <Link href="/settings/" className="underline underline-offset-2">
                      Settings
                    </Link>
                  </>
                ) : null}
                .
              </>
            ) : seconds !== null ? (
              `Trying again in ${seconds} s.`
            ) : (
              'This page will try again when it is visible.'
            )}
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
