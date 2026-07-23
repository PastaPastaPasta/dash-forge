'use client'

/**
 * Query-param routing helpers (static export: no dynamic segments — every address is
 * `?owner=&name=&path=` etc.). Thin wrappers over Next's `useSearchParams` that must be used
 * under a `<Suspense>` boundary (the pages wrap themselves).
 */

import { useSearchParams } from 'next/navigation'

/** Read a single query param (or a fallback). */
export function useParam(name: string, fallback = ''): string {
  const params = useSearchParams()
  return params.get(name) ?? fallback
}

/** The `(owner, name)` pair that addresses a repo. */
export interface RepoAddress {
  readonly owner: string
  readonly name: string
}

/** Read the repo address from the URL. */
export function useRepoAddress(): RepoAddress {
  const params = useSearchParams()
  return { owner: params.get('owner') ?? '', name: params.get('name') ?? '' }
}

/** Build a repo route href, preserving the addressing params. */
export function repoHref(
  path: string,
  addr: RepoAddress,
  extra: Record<string, string> = {},
): string {
  const q = new URLSearchParams({ owner: addr.owner, name: addr.name, ...extra })
  return `${path}?${q.toString()}`
}
