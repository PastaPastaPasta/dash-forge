'use client'

/**
 * BrowseBoundary — resolves a repo's browse context and renders the honest degraded state when
 * a repo's published browse index does not cover what is stored. On success it hands the caller
 * a ready {@link BrowseReader}. When only the index is missing or behind, the raw kind-0 packs
 * are still fully readable, so the boundary offers (or, for small repos, auto-runs) the
 * in-browser fallback clone: download the live packs, index them client-side, browse from
 * local memory. The state machine itself is {@link useBrowseReader}.
 */

import type { ReactNode } from 'react'
import { HardDriveDownload, PackageOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { useBrowseReader } from '@/hooks/use-browse-reader'
import type { BrowseReader } from '@/lib/browse'
import type { RepoRef } from '@/lib/repo'
import { formatBytes } from '@/lib/view'

export function BrowseBoundary({
  repo,
  children,
}: {
  repo: RepoRef
  children: (reader: BrowseReader) => ReactNode
}): JSX.Element {
  const state = useBrowseReader(repo)

  switch (state.kind) {
    case 'loading':
      return <LoadingBlock label={state.label} />
    case 'error':
      return <ErrorState title={state.title} message={state.message} onRetry={state.retry} />
    case 'no-packs':
      return (
        <EmptyState
          icon={PackageOpen}
          title="Nothing stored to browse yet"
          body="This repo has no stored packs. Push with the helper or via dash:// to populate it."
        />
      )
    case 'ready':
      if (!state.local) return <>{children(state.reader)}</>
      return (
        <div>
          <p className="mb-3 text-dense text-anvil-500 dark:text-anvil-400">
            Viewing a copy loaded into your browser — this repo&apos;s browse index{' '}
            {state.behind ? "doesn't cover everything stored" : "hasn't been published"} yet.
          </p>
          {children(state.reader)}
        </div>
      )
    case 'offer':
      return (
        <EmptyState
          icon={PackageOpen}
          title={state.behind ? 'Browse index is behind' : 'Not indexed for browsing yet'}
          body={`${
            state.behind
              ? "This repo's published index does not cover every stored pack, so reading through it would miss recent objects."
              : 'This repo has not published an objectLocator.'
          } Its raw packs are fully readable. Load them here to browse in your browser (about ${formatBytes(state.sizeBytes)}), or clone via dash:// to read it locally.`}
          action={
            <Button variant="primary" onClick={state.start}>
              <HardDriveDownload className="h-4 w-4" aria-hidden />
              Load repo in browser ({formatBytes(state.sizeBytes)})
            </Button>
          }
        />
      )
  }
}
