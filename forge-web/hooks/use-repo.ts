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
 *
 * A page that shows no ref but the default branch (the issue and PR lists) asks for `refs:
 * 'default'`: a home with that branch alone, cached apart, so a page that lists refs never takes
 * it. Such a page takes a full home when one is cached, since that answers it too.
 */

import { useCallback, useRef } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { invalidateBrowseContext, loadBrowseContextCached, loadRepoHome, type RepoHome, type RepoHomeRefs } from '@/lib/view'
import { awaitingOwnRefMoves, forgetOwnRefMoves, showsOwnRefMoves } from '@/lib/view/own-ref-moves'
import { retryUntil, retryWhileMissing } from '@/lib/view/retry'
import { useParam } from '@/hooks/use-query-param'
import { forgetPrivateHome } from '@/hooks/use-private-home'
import { onRepoContentWritten, repoKey, type RepoRef } from '@/lib/repo'
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

/** What a home of the default branch alone adds to its address's key. */
const DEFAULT_REFS_SUFFIX = '\u0000refs=default'

/** @internal Exported for tests. */
export function homeCacheKey(network: Network, addr: RepoAddress, refs: RepoHomeRefs = 'all'): string {
  return `${network}/${addr.owner}/${addr.name}/${addr.repoId ?? ''}${refs === 'all' ? '' : DEFAULT_REFS_SUFFIX}`
}

/** @internal The cache keys a home under `key` may come from, best first: a full home answers every page. */
export function homeCacheKeys(key: string): readonly string[] {
  return key.endsWith(DEFAULT_REFS_SUFFIX) ? [key.slice(0, -DEFAULT_REFS_SUFFIX.length), key] : [key]
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

/**
 * Start a public repo's browse context the moment its document is read, alongside the refs
 * (L-15): a code page needs both, and one after the other was the cold home's longest chain.
 * The session browse cache keeps it for the page's reader. A private repo's needs its session.
 */
function prefetchBrowse(sdk: EvoSDK): (repo: RepoRef) => void {
  return (repo) => {
    if (repo.visibility !== 'private') loadBrowseContextCached(sdk, repo).catch(() => undefined)
  }
}

function startLoad(sdk: EvoSDK, key: string, network: Network, addr: RepoAddress, browse: boolean, refs: RepoHomeRefs): HomeCacheEntry {
  const load = (): Promise<RepoHome | null> => loadRepoHome(sdk, { network, ...addr }, browse ? prefetchBrowse(sdk) : undefined, { refs })
  // Zero extra reads unless this tab is waiting for its own ref move to show. A home of the
  // default branch alone judges only that branch's moves, and leaves the others to a full home.
  const scope = (home: RepoHome): ReadonlySet<string> | undefined => (home.refsPartial ? new Set(home.branches.map((b) => b.refName)) : undefined)
  const shows = (home: RepoHome | null): boolean => home === null || showsOwnRefMoves(home.repo, [...home.branches, ...home.tags], scope(home))
  const attempts = awaitingOwnRefMoves() ? OWN_MOVE_ATTEMPTS : 0
  const read = retryUntil(load, shows, attempts).then((home) => {
    // One full run of re-reads is all a move gets: the next load takes the refs as they are. A
    // load that started before the move (no re-reads) leaves the expectation to the next one.
    if (attempts > 0 && home !== null && !shows(home) && !home.refsPartial) forgetOwnRefMoves(home.repo)
    return home
  })
  const entry: HomeCacheEntry = { at: Date.now(), promise: read }
  homeCache.set(key, entry)
  entry.promise
    .then((value) => {
      entry.settled = { value }
      lastGood.set(key, entry.settled)
      // A home asked for the default branch alone that came out whole (the repo's refs fit the
      // chrome read), or a not-found, answers every page: the repo's other pages take it too.
      // Only the current load of its key: one a write invalidated, or a reload superseded, was
      // read before that and must not come back under the full key.
      const [full] = homeCacheKeys(key)
      if (full !== undefined && full !== key && value?.refsPartial !== true && homeCache.get(key) === entry) {
        const held = homeCache.get(full)
        if (held === undefined || held.at < entry.at) {
          homeCache.set(full, entry)
          lastGood.set(full, entry.settled)
        }
      }
    })
    .catch(() => {
      // Never cache a failed resolve — the next mount should retry against Platform.
      if (homeCache.get(key) === entry) homeCache.delete(key)
    })
  return entry
}

function loadRepoHomeCached(sdk: EvoSDK, network: Network, addr: RepoAddress, browse: boolean, refs: RepoHomeRefs): Promise<RepoHome | null> {
  for (const key of homeCacheKeys(homeCacheKey(network, addr, refs))) {
    const hit = homeCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < HOME_CACHE_TTL_MS) {
      const fresh = Date.now() - hit.at < HOME_REVALIDATE_MS
      // Join a fresh or still-in-flight load; a settled-but-stale hit revalidates — the
      // caller's data was already seeded synchronously from the stale value.
      if (fresh || hit.settled === undefined) return hit.promise
    }
  }
  return startLoad(sdk, homeCacheKey(network, addr, refs), network, addr, browse, refs).promise
}

/** The cached settled home for an address, if any — wrapper disambiguates a cached
 *  not-found (`{ value: null }`) from "no cache" (`undefined`). */
function peekRepoHome(network: Network, addr: RepoAddress, refs: RepoHomeRefs): { value: RepoHome | null } | undefined {
  for (const key of homeCacheKeys(homeCacheKey(network, addr, refs))) {
    const hit = homeCache.get(key)
    if (hit !== undefined && hit.settled !== undefined && Date.now() - hit.at < HOME_CACHE_TTL_MS) return hit.settled
  }
  return undefined
}

/** The last home any of `keys` resolved to (see {@link lastGood}). */
function lastGoodOf(keys: readonly string[]): { value: RepoHome | null } | undefined {
  for (const key of keys) {
    const kept = lastGood.get(key)
    if (kept !== undefined) return kept
  }
  return undefined
}

/**
 * `browse`: the page reads code, so the repo's browse index starts loading with the refs. `refs`:
 * which refs the home resolves ({@link RepoHomeRefs}).
 */
export function useRepoHome(
  addr: RepoAddress,
  { browse = false, refs = 'all' }: { readonly browse?: boolean; readonly refs?: RepoHomeRefs } = {},
): UseRepoResult {
  const { sdk, ready, network, status: sdkStatus, recoveries } = useSdk()
  const enabled = ready && sdk !== null && addr.owner !== '' && (addr.name !== '' || !!addr.repoId)
  const key = homeCacheKey(network, addr, refs)
  // Just created in this tab (`/new` adds `created=1`): ride out a node one block behind.
  const justCreated = useParam('created') === '1'
  // The recovery count the last seed saw: only the re-read right after an outage seeds from
  // what this tab read before it, not every later navigation this session.
  const seededRecoveries = useRef(recoveries)
  const state = useAsync<RepoHome | null>(
    () =>
      retryWhileMissing(async () => {
        const home = await loadRepoHomeCached(sdk!, network, addr, browse, refs)
        if (home === null && justCreated) for (const k of homeCacheKeys(key)) homeCache.delete(k)
        return home
      }, justCreated ? 8 : 0).catch((e: unknown) => {
        // Platform unreachable: keep what this tab already read (under the banner). Only an
        // unreachable Platform qualifies; a proof or decode failure is surfaced, never hidden
        // behind earlier content.
        const kept = lastGoodOf(homeCacheKeys(key))
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
        const settled = peekRepoHome(network, addr, refs) ?? (sdkStatus.phase === 'error' || recovered ? lastGoodOf(homeCacheKeys(key)) : undefined)
        return settled === undefined ? undefined : settled.value
      },
    },
  )
  const { data, reload: rerun } = state
  const reload = useCallback(() => {
    for (const k of homeCacheKeys(key)) homeCache.delete(k)
    if (data !== null) {
      invalidateBrowseContext(repoKey(data.repo))
      if (data.repo.visibility === 'private') forgetPrivateHome(data.repo)
    }
    rerun()
  }, [key, data, rerun])
  return { ...state, reload, ready, network }
}
