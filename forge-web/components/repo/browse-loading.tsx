'use client'

/**
 * What a code page shows while the repo's browse index resolves (QW3-001): the bytes read so far
 * when the index is read whole (a private repo's, or one whose rows do not add up), and after
 * {@link SLOW_AFTER_MS} a plain note that the network is slow, rather than a bare spinner that
 * could as well be stuck.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Spinner } from '@/components/ui/states'
import { formatBytes } from '@/lib/view/format'
import { indexProgress, subscribeIndexProgress } from '@/lib/view/index-progress'

/** When the slow-network note appears. */
export const SLOW_AFTER_MS = 10_000

export function BrowseLoading({ repoKey, label }: { repoKey: string; label: string }): JSX.Element {
  const progress = useSyncExternalStore(subscribeIndexProgress, () => indexProgress(repoKey), () => undefined)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS)
    return () => clearTimeout(t)
  }, [repoKey])
  const pct = progress !== undefined && progress.total > 0 ? Math.min(100, Math.round((progress.fetched / progress.total) * 100)) : null
  const bytes = progress === undefined ? null : `${formatBytes(progress.fetched)} of ${formatBytes(progress.total)}`
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-4" data-testid="browse-loading">
      <div className="w-full max-w-sm space-y-2 text-center">
        {progress === undefined ? (
          <Spinner label={label} />
        ) : (
          <>
            <p className="text-dense text-anvil-600 dark:text-anvil-300">Reading the browse index</p>
            <div
              role="progressbar"
              aria-label="Browse index download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
              aria-valuetext={bytes ?? undefined}
              className="h-1.5 w-full overflow-hidden rounded-full bg-anvil-200 dark:bg-anvil-800"
            >
              {/* The fill is a non-text graphic (WCAG 1.4.11): the same colours as the SDK download bar. */}
              <div className="h-full bg-forge-700 transition-[width] duration-300 dark:bg-forge-500" style={{ width: `${pct ?? 5}%` }} />
            </div>
            <p className="text-dense tabular-nums text-anvil-500 dark:text-anvil-400">
              {bytes}
              {pct !== null ? ` · ${pct}%` : ''}
            </p>
          </>
        )}
        {slow ? (
          <p role="status" className="text-dense text-anvil-500 dark:text-anvil-400" data-testid="browse-loading-slow">
            This is taking longer than usual: the network is slow. Still reading…
          </p>
        ) : null}
      </div>
    </div>
  )
}
