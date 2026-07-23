'use client'

/**
 * BrowseBoundary — resolves a repo's browse context and renders the honest degraded state when
 * a repo has not published browse artifacts (locator/pack). On success it hands the caller a
 * ready {@link BrowseReader}. When only the locator is missing, the raw kind-0 packs are still
 * fully readable, so the boundary offers (or, for small repos, auto-runs) the in-browser
 * fallback clone: download the live packs, index them client-side, browse from local memory.
 */

import type { ReactNode } from 'react'
import { HardDriveDownload, PackageOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock, Spinner } from '@/components/ui/states'
import { useBrowse } from '@/hooks/use-browse'
import { AUTO_LOAD_MAX_BYTES, useFallbackBrowse } from '@/hooks/use-fallback-browse'
import type { BrowseReader } from '@/lib/browse'
import type { RepoRef } from '@/lib/repo'
import { formatBytes, type FallbackProgress } from '@/lib/view'

function progressLabel(p: FallbackProgress | null): string {
  if (p === null) return 'Preparing in-browser clone'
  if (p.phase === 'download') {
    return `Downloading packs — ${formatBytes(p.bytesFetched)} of ${formatBytes(p.bytesTotal)}`
  }
  return `Indexing objects — ${p.objectsIndexed} of ${p.objectsTotal}`
}

export function BrowseBoundary({
  repo,
  children,
}: {
  repo: RepoRef
  children: (reader: BrowseReader) => ReactNode
}): JSX.Element {
  const { data, loading, error, settled, reload } = useBrowse(repo)
  const unindexed = data?.kind === 'unindexed' ? data : null
  const fallback = useFallbackBrowse(repo, unindexed?.livePacks ?? null)

  // A warm navigation has `data` seeded from the session browse cache — render it
  // immediately; the loading shell is only for a cold (no-cache) resolve.
  if (loading && !settled) return <LoadingBlock label="Loading browse index" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === null || data.kind === 'no-packs') {
    return (
      <EmptyState
        icon={PackageOpen}
        title="Nothing stored to browse yet"
        body="This repo has no stored packs. Push with the helper or via dash:// to populate it."
      />
    )
  }
  if (data.kind === 'ready') return <>{children(data.context.reader)}</>

  // No published locator — the in-browser fallback clone takes over.
  if (fallback.status === 'ready' && fallback.context !== null) {
    return (
      <div>
        <p className="mb-3 text-dense text-anvil-500 dark:text-anvil-400">
          Browsing from a locally built index — this repo has not published a browse plane.
        </p>
        {children(fallback.context.reader)}
      </div>
    )
  }
  if (fallback.status === 'error') {
    return (
      <ErrorState
        title="In-browser clone failed"
        message={fallback.error ?? 'unknown error'}
        onRetry={fallback.start}
      />
    )
  }
  if (fallback.status === 'working' || data.totalSizeBytes <= AUTO_LOAD_MAX_BYTES) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label={progressLabel(fallback.progress)} />
      </div>
    )
  }
  return (
    <EmptyState
      icon={PackageOpen}
      title="Not indexed for browsing yet"
      body={`This repo has not published an objectLocator, but its raw packs are fully readable. Load them here to browse in your browser (about ${formatBytes(data.totalSizeBytes)}), or clone via dash:// to read it locally.`}
      action={
        <Button variant="primary" onClick={fallback.start}>
          <HardDriveDownload className="h-4 w-4" aria-hidden />
          Load repo in browser ({formatBytes(data.totalSizeBytes)})
        </Button>
      }
    />
  )
}
