'use client'

/**
 * useBrowse — load a repo's browse availability (objectLocator + pack source) once, so
 * tree/blob/commit views can reconstruct any object by oid. Data is a {@link BrowseState}:
 * `ready` with a context, `unindexed` with the live pack set the fallback clone needs, or
 * `no-packs` when nothing is stored.
 */

import { useSdk } from '@/hooks/use-sdk'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { loadBrowseContext, type BrowseState } from '@/lib/view'
import type { RepoRef } from '@/lib/repo'

export function useBrowse(repo: RepoRef | null): AsyncState<BrowseState> {
  const { sdk, ready } = useSdk(repo ? [repo.contractId] : [])
  const enabled = ready && sdk !== null && repo !== null
  return useAsync<BrowseState>(
    () => loadBrowseContext(sdk!, repo!),
    [ready, repo?.contractId ?? ''],
    { enabled },
  )
}
