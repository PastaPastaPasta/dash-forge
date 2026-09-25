'use client'

/**
 * useRepoHome — resolve + compose a repo's home view-model from its route address.
 *
 * Connects the SDK (registry, DPNS and the forge-v2 contracts preloaded), resolves the repo —
 * a forge-v2 `repo` document by `($ownerId, name)`, else the v1 registry with
 * listing-authenticity verification — and loads config + refs + star count. Returns the async
 * state the repo chrome renders. `notFound` distinguishes an unresolved repo from a read error.
 *
 * Resolution is cached per `(network, owner, name)` with the settled value kept alongside the
 * promise, so navigating between a repo's pages (code → issues → commits …) renders the
 * composed home on the first paint — no "Resolving…" shell on warm navigations. Hits older
 * than {@link HOME_REVALIDATE_MS} serve the cached value and refresh in the background
 * (stale-while-revalidate); entries older than {@link HOME_CACHE_TTL_MS} resolve cold.
 * `reload()` bypasses the cache (and drops the repo's browse-plane cache with it).
 */

import { useCallback } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { invalidateBrowseContext, loadRepoHome, type RepoHome } from '@/lib/view'
import { repoKey } from '@/lib/repo'
import type { Network } from '@/lib/constants'
import type { EvoSDK } from '@dashevo/evo-sdk'
import type { RepoAddress } from '@/hooks/use-query-param'

export interface UseRepoResult extends AsyncState<RepoHome | null> {
  readonly ready: boolean
  readonly sdkError: string | null
  readonly network: Network
}

// NOTE for future write flows: anything that mutates what RepoHome composes (refs, config,
// stars, the listing) must call the hook's `reload()` — or delete the cache key — after the
// write lands, or the page can serve up-to-TTL-stale data on the next navigation.
const HOME_CACHE_TTL_MS = 5 * 60_000
/** Age beyond which a hit is served stale and refreshed in the background. */
const HOME_REVALIDATE_MS = 30_000

interface HomeCacheEntry {
  at: number
  promise: Promise<RepoHome | null>
  /** Present once the promise resolved — `value` may be null (an authentic not-found). */
  settled?: { value: RepoHome | null }
}
const homeCache = new Map<string, HomeCacheEntry>()

function homeCacheKey(network: Network, addr: RepoAddress): string {
  return `${network}/${addr.owner}/${addr.name}/${addr.repoId ?? ''}/${addr.contractId ?? ''}`
}

function startLoad(sdk: EvoSDK, key: string, network: Network, addr: RepoAddress): HomeCacheEntry {
  const entry: HomeCacheEntry = { at: Date.now(), promise: loadRepoHome(sdk, { network, ...addr }) }
  homeCache.set(key, entry)
  entry.promise
    .then((value) => {
      entry.settled = { value }
    })
    .catch(() => {
      // Never cache a failed resolve — the next mount should retry against Platform.
      if (homeCache.get(key) === entry) homeCache.delete(key)
    })
  return entry
}

function loadRepoHomeCached(sdk: EvoSDK, network: Network, addr: RepoAddress): Promise<RepoHome | null> {
  const key = homeCacheKey(network, addr)
  const hit = homeCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < HOME_CACHE_TTL_MS) {
    const fresh = Date.now() - hit.at < HOME_REVALIDATE_MS
    // Join a fresh or still-in-flight load; a settled-but-stale hit revalidates — the
    // caller's data was already seeded synchronously from the stale value.
    if (fresh || hit.settled === undefined) return hit.promise
  }
  return startLoad(sdk, key, network, addr).promise
}

/** The cached settled home for an address, if any — wrapper disambiguates a cached
 *  not-found (`{ value: null }`) from "no cache" (`undefined`). */
function peekRepoHome(network: Network, addr: RepoAddress): { value: RepoHome | null } | undefined {
  const hit = homeCache.get(homeCacheKey(network, addr))
  if (hit === undefined || hit.settled === undefined) return undefined
  if (Date.now() - hit.at >= HOME_CACHE_TTL_MS) return undefined
  return hit.settled
}

export function useRepoHome(addr: RepoAddress): UseRepoResult {
  const { sdk, ready, error: sdkError, network } = useSdk()
  const enabled = ready && sdk !== null && addr.owner !== '' && addr.name !== ''
  const key = homeCacheKey(network, addr)
  const state = useAsync<RepoHome | null>(
    () => loadRepoHomeCached(sdk!, network, addr),
    [ready, key],
    {
      enabled,
      // A cached not-found seeds `null` as a REAL settled value (instant "Repo not found");
      // only a cache miss returns undefined (no seed → loading shell).
      initial: () => {
        const settled = peekRepoHome(network, addr)
        return settled === undefined ? undefined : settled.value
      },
    },
  )
  const { data, reload: rerun } = state
  const reload = useCallback(() => {
    homeCache.delete(key)
    if (data !== null) invalidateBrowseContext(repoKey(data.repo))
    rerun()
  }, [key, data, rerun])
  return { ...state, reload, ready, sdkError, network }
}
