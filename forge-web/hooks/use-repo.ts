'use client'

/**
 * useRepoHome — resolve + compose a repo's home view-model from its route address.
 *
 * Connects the SDK (DPNS and the forge-v2 contracts preloaded), resolves the repo — its
 * forge-core `repo` document by `($ownerId, name)` or `?repo=` — and loads config + refs +
 * star count. Returns the async
 * state the repo chrome renders. `notFound` distinguishes an unresolved repo from a read error.
 *
 * Resolution is cached per `(network, owner, name, ?repo=)` with the settled value kept alongside the
 * promise, so navigating between a repo's pages (code → issues → commits …) renders the
 * composed home on the first paint — no "Resolving…" shell on warm navigations. Hits older
 * than {@link HOME_REVALIDATE_MS} serve the cached value and refresh in the background
 * (stale-while-revalidate); entries older than {@link HOME_CACHE_TTL_MS} resolve cold.
 * `reload()` bypasses the cache (and drops the repo's browse-plane cache with it).
 */

import { useCallback, useRef } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { invalidateBrowseContext, loadRepoHome, type RepoHome } from '@/lib/view'
import { awaitingOwnRefMoves, forgetOwnRefMoves, showsOwnRefMoves } from '@/lib/view/own-ref-moves'
import { retryUntil, retryWhileMissing } from '@/lib/view/retry'
import { useParam } from '@/hooks/use-query-param'
import { forgetPrivateHome } from '@/hooks/use-private-home'
import { onRepoContentWritten, repoKey } from '@/lib/repo'
import type { Network } from '@/lib/constants'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { evoSdkService, isUnreachableError, type SdkStatus } from '@/lib/sdk'
import type { RepoAddress } from '@/hooks/use-query-param'

export interface UseRepoResult extends AsyncState<RepoHome | null> {
  readonly ready: boolean
  readonly network: Network
}

// NOTE for future write flows: anything that mutates what RepoHome composes (refs, config,
// stars, the repo document) must call the hook's `reload()` — or delete the cache key — after the
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
  return `${network}/${addr.owner}/${addr.name}/${addr.repoId ?? ''}`
}

/**
 * The last home each address resolved to in this tab, whatever its age: shown under the
 * "can't reach Platform" banner when a revalidation fails (D-058). It was proof-checked when
 * it was read; the banner says it is not being re-checked.
 */
const lastGood = new Map<string, { value: RepoHome | null }>()

/**
 * Whether a failed read may show the last home this tab read instead of the error: only while
 * the service reports Platform unreachable (the banner says the page is not re-checked), and
 * only for an unreachable error. A one-off timeout while connected surfaces, as does a proof
 * or decode failure, so stale content never sits under a "Verified" card.
 */
export function keepLastGood(e: unknown, status: SdkStatus): boolean {
  return status.phase === 'error' && isUnreachableError(e)
}

// This tab moved a ref, stored a pack or published a release: every cached home of the repo
// (any address form) is out of date.
// A home still loading was started before the write and would settle on the old refs: it goes
// too (its caller keeps its own promise).
onRepoContentWritten((repo) => {
  for (const [k, entry] of homeCache) {
    if (entry.settled === undefined || entry.settled.value?.repo.repoId === repo.repoId) homeCache.delete(k)
  }
})

/** Read attempts (1.5 s apart) a home read gets to show a ref this tab just moved (L-09). */
const OWN_MOVE_ATTEMPTS = 8

function startLoad(sdk: EvoSDK, key: string, network: Network, addr: RepoAddress): HomeCacheEntry {
  const load = (): Promise<RepoHome | null> => loadRepoHome(sdk, { network, ...addr })
  // Zero extra reads unless this tab is waiting for its own ref move to show.
  const shows = (home: RepoHome | null): boolean => home === null || showsOwnRefMoves(home.repo, [...home.branches, ...home.tags])
  const read = retryUntil(load, shows, awaitingOwnRefMoves() ? OWN_MOVE_ATTEMPTS : 0).then((home) => {
    // One full run of re-reads is all a move gets: the next load takes the refs as they are.
    if (home !== null && !shows(home)) forgetOwnRefMoves(home.repo)
    return home
  })
  const entry: HomeCacheEntry = { at: Date.now(), promise: read }
  homeCache.set(key, entry)
  entry.promise
    .then((value) => {
      entry.settled = { value }
      lastGood.set(key, entry.settled)
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
  const { sdk, ready, network, status: sdkStatus, recoveries } = useSdk()
  const enabled = ready && sdk !== null && addr.owner !== '' && (addr.name !== '' || !!addr.repoId)
  const key = homeCacheKey(network, addr)
  // Just created in this tab (`/new` adds `created=1`): ride out a node one block behind.
  const justCreated = useParam('created') === '1'
  // The recovery count the last seed saw: only the re-read right after an outage seeds from
  // what this tab read before it, not every later navigation this session.
  const seededRecoveries = useRef(recoveries)
  const state = useAsync<RepoHome | null>(
    () =>
      retryWhileMissing(async () => {
        const home = await loadRepoHomeCached(sdk!, network, addr)
        if (home === null && justCreated) homeCache.delete(key)
        return home
      }, justCreated ? 8 : 0).catch((e: unknown) => {
        // Platform unreachable: keep what this tab already read (under the banner). Only an
        // unreachable Platform qualifies; a proof or decode failure is surfaced, never hidden
        // behind earlier content.
        const kept = lastGood.get(key)
        if (kept !== undefined && keepLastGood(e, evoSdkService.getStatus())) return kept.value
        throw e
      }),
    [ready, key, recoveries],
    {
      enabled,
      // A cached not-found seeds `null` as a REAL settled value (instant "Repo not found");
      // only a cache miss returns undefined (no seed → loading shell).
      // During an outage, and on the re-read after one (`recoveries`), seed from what this tab
      // already read so the page does not drop to a spinner.
      initial: () => {
        const recovered = recoveries !== seededRecoveries.current
        seededRecoveries.current = recoveries
        const settled = peekRepoHome(network, addr) ?? (sdkStatus.phase === 'error' || recovered ? lastGood.get(key) : undefined)
        return settled === undefined ? undefined : settled.value
      },
    },
  )
  const { data, reload: rerun } = state
  const reload = useCallback(() => {
    homeCache.delete(key)
    if (data !== null) {
      invalidateBrowseContext(repoKey(data.repo))
      if (data.repo.visibility === 'private') forgetPrivateHome(data.repo)
    }
    rerun()
  }, [key, data, rerun])
  return { ...state, reload, ready, network }
}
