'use client'

/**
 * useBrowse — load a repo's browse availability (objectLocator + pack source) once, so
 * tree/blob/commit views can reconstruct any object by oid. Data is a {@link BrowseState}:
 * `ready` with a context, `unindexed` with the live pack set the fallback clone needs, or
 * `no-packs` when nothing is stored.
 *
 * Served through the session browse cache: a warm navigation seeds the state synchronously
 * (no "Loading browse index" shell) and the underlying context — locator, reader, chunk
 * caches — is shared across every repo page.
 *
 * Keyed by the repo AND its browse generation: when the cache drops the repo's context (a
 * write this tab made, "Try again") or replaces it with one resolved from a newer pack list (a
 * push seen by a revalidation or by a read that missed), every view of the repo reads again
 * without a reload (L-08, L-09).
 */

import { useSyncExternalStore } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { browseGeneration, loadBrowseContextCached, peekBrowseState, subscribeBrowseGeneration, type BrowseState } from '@/lib/view'
import { repoContractIds, repoKey, type RepoRef } from '@/lib/repo'

export function useBrowse(repo: RepoRef | null): AsyncState<BrowseState> {
  const { sdk, ready } = useSdk(repoContractIds(repo))
  const key = repo === null ? '' : repoKey(repo)
  const generation = useSyncExternalStore(
    subscribeBrowseGeneration,
    () => browseGeneration(key),
    () => 0,
  )
  const enabled = ready && sdk !== null && repo !== null
  return useAsync<BrowseState>(
    () => loadBrowseContextCached(sdk!, repo!),
    [ready, key, generation],
    { enabled, initial: () => (repo === null ? undefined : peekBrowseState(key)) },
  )
}
