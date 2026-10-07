'use client'

/**
 * useTrustView — the Verification card's current view of a repo (L-18): the route and its query
 * (another file, ref or tab is a new view). The page reads through a reader for this view
 * ({@link BrowseReader.forView}); the rail starts it, so the summary names the places that
 * served THIS page, and reads a view the viewer left are still running are not counted.
 */

import { usePathname, useSearchParams } from '@/hooks/use-route'

/** The view on screen: its route and query (pure; the rail's layout effect makes it current). */
export function useTrustView(): string {
  return `${usePathname()}?${useSearchParams().toString()}`
}
