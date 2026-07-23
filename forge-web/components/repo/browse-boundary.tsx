'use client'

/**
 * BrowseBoundary — resolves a repo's browse context and renders the honest degraded state when
 * a repo has not published browse artifacts (locator/pack). On success it hands the caller a
 * ready {@link BrowseReader}. This is where the "size-independent browse or graceful degrade"
 * promise is kept in the UI.
 */

import type { ReactNode } from 'react'
import { PackageOpen } from 'lucide-react'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { useBrowse } from '@/hooks/use-browse'
import type { BrowseReader } from '@/lib/browse'
import type { RepoRef } from '@/lib/repo'

export function BrowseBoundary({
  repo,
  children,
}: {
  repo: RepoRef
  children: (reader: BrowseReader) => ReactNode
}): JSX.Element {
  const { data, loading, error, reload } = useBrowse(repo)

  if (loading) return <LoadingBlock label="Loading browse index" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === null) {
    return (
      <EmptyState
        icon={PackageOpen}
        title="Not indexed for browsing yet"
        body="This repo has not published an objectLocator, so in-browser object reads aren't available. Push with the helper (which repacks + publishes the browse plane), or clone via dash:// to read it locally."
      />
    )
  }
  return <>{children(data.reader)}</>
}
