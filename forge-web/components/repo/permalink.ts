'use client'

/**
 * Permalinks for the browse views: the file or directory at the commit the page shows, not at the
 * branch (which moves). "Copy permalink" copies the short form (`/owner/name/blob/<oid>/path#L10`),
 * which the 404 shim expands; `y` rewrites the address bar to the canonical route at that commit,
 * as GitHub does, keeping the `#L` selection.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { isPageShortcut } from '@/lib/focus'
import { BASE_PATH, hasShortUrl, shortRepoPath } from '@/lib/short-url'
import { isSealedRepo } from '@/lib/view/private-nav'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

export type PermalinkRoute = 'blob' | 'tree'

/** The in-app route (no base path) of `path` at commit `commitOid`. */
export function pinnedHref(addr: RepoAddress, route: PermalinkRoute, commitOid: string, path: string): string {
  return repoHref(`/repo/${route}`, addr, { ...(path ? { path } : {}), ref: commitOid })
}

/**
 * The shareable link to `path` at commit `commitOid` (with the base path, no origin). The short
 * form when the repo has one; a private repo's link stays the canonical route, whose path and ref
 * are sealed tokens (a short URL would put the decrypted file name in the address).
 */
export function permalinkPath(addr: RepoAddress, route: PermalinkRoute, commitOid: string, path: string): string {
  if (!isSealedRepo(addr) && hasShortUrl(addr)) return `${BASE_PATH}${shortRepoPath(addr, { kind: route, ref: commitOid, path })}`
  return `${BASE_PATH}${pinnedHref(addr, route, commitOid, path)}`
}

/** {@link permalinkPath} as an absolute URL, with the `#L` fragment (browser only). */
export function permalinkUrl(addr: RepoAddress, route: PermalinkRoute, commitOid: string, path: string, fragment = ''): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}${permalinkPath(addr, route, commitOid, path)}${fragment ? `#${fragment}` : ''}`
}

/** `y`: pin the address bar to the commit the page shows (GitHub's "expand URL to its permalink"). */
export function usePermalinkKey(addr: RepoAddress, route: PermalinkRoute, commitOid: string, path: string): void {
  const router = useRouter()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isPageShortcut(e, 'y')) return
      e.preventDefault()
      // The same commit, so the view keeps what it read; the selection rides in the fragment.
      router.replace(`${pinnedHref(addr, route, commitOid, path)}${window.location.hash}`, { scroll: false })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [router, addr, route, commitOid, path])
}
