'use client'

/**
 * Query-param routing helpers (static export: no dynamic segments — every address is
 * `?owner=&name=&path=` etc.). Thin wrappers over Next's `useSearchParams` that must be used
 * under a `<Suspense>` boundary (the pages wrap themselves).
 */

import { useSearchParams } from 'next/navigation'

import { openParam, sealParams } from '@/lib/view/private-nav'

/**
 * Read a single query param (or a fallback). A private repo's `path` / `ref` / `oid` travel as
 * per-tab tokens (`lib/view/private-nav.ts`); they are resolved here.
 */
export function useParam(name: string, fallback = ''): string {
  const params = useSearchParams()
  const raw = params.get(name)
  return raw === null ? fallback : openParam(raw)
}

/**
 * How a route addresses a repo: `(owner, name)` — owner an identity id or DPNS name — plus an
 * optional pin, `repo` (the `repo` document id).
 */
export interface RepoAddress {
  readonly owner: string
  readonly name: string
  /** `?repo=` — pins the repo by id. */
  readonly repoId?: string
}

/** Read the repo address from the URL. */
export function useRepoAddress(): RepoAddress {
  const params = useSearchParams()
  return addressFromParams(params)
}

/** The {@link RepoAddress} a query string names. */
export function addressFromParams(params: { get(name: string): string | null }): RepoAddress {
  const repoId = params.get('repo') ?? ''
  return {
    owner: params.get('owner') ?? '',
    name: params.get('name') ?? '',
    ...(repoId !== '' ? { repoId } : {}),
  }
}

/** Build a repo route href, preserving the addressing params (and any pin). */
export function repoHref(
  path: string,
  addr: RepoAddress,
  extra: Record<string, string> = {},
): string {
  const q = new URLSearchParams({ owner: addr.owner, name: addr.name })
  if (addr.repoId) q.set('repo', addr.repoId)
  // A private repo's decrypted names never go into a URL (`private-nav.ts`).
  for (const [k, v] of Object.entries(sealParams(addr, extra))) q.set(k, v)
  return `${path}?${q.toString()}`
}
