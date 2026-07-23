'use client'

/**
 * useRepoHome — resolve + compose a repo's home view-model from `(owner, name)`.
 *
 * Connects the SDK (registry + DPNS preloaded), resolves the repo through the registry with
 * listing-authenticity verification, and loads config + refs + star count. Returns the async
 * state the repo chrome renders. `notFound` distinguishes an unresolved repo from a read error.
 *
 * Resolution is cached per `(network, owner, name)` for a short TTL so navigating between a
 * repo's pages (code → issues → commits …) reuses the composed home instead of re-running
 * the full resolve pipeline against Platform on every route. `reload()` bypasses the cache.
 */

import { useCallback } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { loadRepoHome, type RepoHome } from '@/lib/view'
import type { Network } from '@/lib/constants'
import type { EvoSDK } from '@dashevo/evo-sdk'

export interface UseRepoResult extends AsyncState<RepoHome | null> {
  readonly ready: boolean
  readonly sdkError: string | null
  readonly network: Network
}

// NOTE for future write flows: anything that mutates what RepoHome composes (refs, config,
// stars, the listing) must call the hook's `reload()` — or delete the cache key — after the
// write lands, or the page can serve up-to-TTL-stale data on the next navigation.
const HOME_CACHE_TTL_MS = 30_000
const homeCache = new Map<string, { at: number; promise: Promise<RepoHome | null> }>()

function loadRepoHomeCached(
  sdk: EvoSDK,
  params: { network: Network; ownerId: string; name: string },
): Promise<RepoHome | null> {
  const key = `${params.network}/${params.ownerId}/${params.name}`
  const hit = homeCache.get(key)
  if (hit && Date.now() - hit.at < HOME_CACHE_TTL_MS) return hit.promise
  const promise = loadRepoHome(sdk, params)
  homeCache.set(key, { at: Date.now(), promise })
  // Never cache a failed resolve — the next mount should retry against Platform.
  promise.catch(() => homeCache.delete(key))
  return promise
}

export function useRepoHome(owner: string, name: string): UseRepoResult {
  const { sdk, ready, error: sdkError, network } = useSdk()
  const enabled = ready && sdk !== null && owner !== '' && name !== ''
  const state = useAsync<RepoHome | null>(
    () => loadRepoHomeCached(sdk!, { network, ownerId: owner, name }),
    [ready, owner, name, network],
    { enabled },
  )
  const { reload: rerun } = state
  const reload = useCallback(() => {
    homeCache.delete(`${network}/${owner}/${name}`)
    rerun()
  }, [network, owner, name, rerun])
  return { ...state, reload, ready, sdkError, network }
}
