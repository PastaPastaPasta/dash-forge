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

export type PermalinkRoute = 'blob' | 'tree' | 'blame'

/**
 * The in-app route (no base path) of `path` at commit `commitOid`, or null for a private repo
 * whose URLs are not sealed (a vault just locked): its decrypted names never go in an address.
 */
export function pinnedHref(addr: RepoAddress, route: PermalinkRoute | 'home', commitOid: string, path: string, privateRepo: boolean): string | null {
  if (privateRepo && !isSealedRepo(addr)) return null
  if (route === 'home') return repoHref('/repo', addr, { ref: commitOid })
  return repoHref(`/repo/${route}`, addr, { ...(path ? { path } : {}), ref: commitOid })
}

/**
 * A path a browser would rewrite before the shim sees it: `.` and `..` segments (also as
 * `%2e%2e`) are resolved in the URL path, so `/o/n/blob/<oid>/../../x/y` would open another repo.
 */
const hasDotSegment = (path: string): boolean => path.split('/').some((s) => s === '.' || s === '..')

/**
 * The shareable link to `path` at commit `commitOid` (with the base path, no origin): the short
 * form when the repo and path have one, else the canonical route (a private repo's, whose path and
 * ref are sealed tokens). Null when {@link pinnedHref} is.
 */
export function permalinkPath(addr: RepoAddress, route: PermalinkRoute, commitOid: string, path: string, privateRepo: boolean): string | null {
  const short = !privateRepo && hasShortUrl(addr) && !hasDotSegment(path)
  const href = short ? shortRepoPath(addr, { kind: route, ref: commitOid, path }) : pinnedHref(addr, route, commitOid, path, privateRepo)
  return href === null ? null : `${BASE_PATH}${href}`
}

/** `y`: pin the address bar to `target` (GitHub's "expand URL to its permalink"), keeping the `#L` selection. */
export function usePermalinkKey(target: string | null): void {
  const router = useRouter()
  useEffect(() => {
    if (target === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (!isPageShortcut(e, 'y')) return
      e.preventDefault()
      // The same commit, so the view keeps what it read.
      router.replace(`${target}${window.location.hash}`, { scroll: false })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [router, target])
}
