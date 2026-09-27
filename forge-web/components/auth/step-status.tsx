'use client'

/**
 * The sign-in sheet's two in-between states: a named wait with its elapsed time (never a bare
 * spinner), and a named failure with "Try again".
 */

import { useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorBox } from '@/components/auth/protection-fields'
import { PHASE_TEXT } from '@/lib/auth/connect'
import { onWasmProgress, type DownloadProgress } from '@/lib/sdk/wasm-fetch'

const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(1)

/**
 * What is being waited for, and for how long so far. While the Platform library downloads, how
 * much of it has arrived, and why the first sign-in takes a while.
 */
export function Waiting({ label }: { label: string }): JSX.Element {
  const [secs, setSecs] = useState(0)
  const [download, setDownload] = useState<DownloadProgress | null>(null)
  const library = label === PHASE_TEXT.downloading
  useEffect(() => (library ? onWasmProgress(setDownload) : undefined), [library])
  // A new step restarts the clock.
  useEffect(() => {
    setSecs(0)
    const start = Date.now()
    const t = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(t)
  }, [label])
  return (
    <div className="space-y-1" data-testid="signin-waiting">
      <div className="flex items-center gap-2 text-dense text-anvil-600 dark:text-anvil-300">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
        <span role="status" aria-live="polite">
          {label}…
        </span>
        {/* Not announced: a screen reader would read it every second. */}
        {secs >= 3 ? (
          <span className="font-mono text-[12px] text-anvil-500 dark:text-anvil-400" aria-hidden>
            {secs} s
          </span>
        ) : null}
      </div>
      {library && download !== null && download.loaded > 0 ? (
        <div className="space-y-1" data-testid="signin-download">
          {download.total > 0 ? (
            <progress className="h-1 w-full accent-forge-500" max={download.total} value={download.loaded} aria-label="Platform library download" />
          ) : null}
          <p className="font-mono text-[12px] text-anvil-500 dark:text-anvil-400">
            {mb(download.loaded)}
            {download.total > 0 ? ` of ${mb(download.total)}` : ''} MB of the library
          </p>
        </div>
      ) : null}
      {library && secs >= 5 ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          The first sign-in downloads the Dash Platform library once; on a slow connection this takes a minute or more.
        </p>
      ) : null}
    </div>
  )
}

/** A step that failed or timed out: what, and a way to try again. */
export function StepFailed({ error, onRetry, retryLabel = 'Try again' }: { error: string; onRetry: () => void; retryLabel?: string }): JSX.Element {
  return (
    <div className="space-y-3" data-testid="signin-failed">
      <ErrorBox error={error} />
      <Button variant="outline" className="w-full" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden /> {retryLabel}
      </Button>
    </div>
  )
}
