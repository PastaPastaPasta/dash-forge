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

/**
 * How a route addresses a repo: `(owner, name)` — owner an identity id or DPNS name — plus an
 * optional pin: `repo` (a forge-v2 `repo` document id) or `contract` (a v1 repo contract).
 */
export interface RepoAddress {
  readonly owner: string
  readonly name: string
  /** `?repo=` — pins a forge-v2 repo. */
  readonly repoId?: string
  /** `?contract=` — pins a v1 repo contract. */
  readonly contractId?: string
}

/** Read the repo address from the URL. */
export function useRepoAddress(): RepoAddress {
  const params = useSearchParams()
  return addressFromParams(params)
}

/** The {@link RepoAddress} a query string names. */
export function addressFromParams(params: { get(name: string): string | null }): RepoAddress {
  const repoId = params.get('repo') ?? ''
  const contractId = params.get('contract') ?? ''
  return {
    owner: params.get('owner') ?? '',
    name: params.get('name') ?? '',
    ...(repoId !== '' ? { repoId } : {}),
    ...(contractId !== '' ? { contractId } : {}),
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
  if (addr.contractId) q.set('contract', addr.contractId)
  for (const [k, v] of Object.entries(extra)) q.set(k, v)
  return `${path}?${q.toString()}`
}
