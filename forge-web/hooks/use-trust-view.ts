'use client'

/**
 * useTrustView — the Verification card's current view of a repo (L-18): one number per route and
 * query (another file, ref or tab is a new view). The page reads through a reader for this view
 * ({@link BrowseReader.forView}); the rail starts it, so the summary names the places that
 * served THIS page, and reads a view the viewer left are still running are not counted.
 */

import { usePathname, useSearchParams } from 'next/navigation'

import { viewSeq } from '@/lib/view'

export function useTrustView(repoKey: string): number {
  const view = `${usePathname()}?${useSearchParams().toString()}`
  return viewSeq(repoKey, view)
}
