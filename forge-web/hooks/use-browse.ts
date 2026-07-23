'use client'

/**
 * useBrowse — load a repo's browse context (objectLocator + pack source) once, so tree/blob/
 * commit views can reconstruct any object by oid. Returns `null` data when the repo has not
 * published browse artifacts yet (the UI then shows a clear "not indexed" state).
 */

import { useSdk } from '@/hooks/use-sdk'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { loadBrowseContext, type BrowseContext } from '@/lib/view'
import type { RepoRef } from '@/lib/repo'

export function useBrowse(repo: RepoRef | null): AsyncState<BrowseContext | null> {
  const { sdk, ready } = useSdk(repo ? [repo.contractId] : [])
  const enabled = ready && sdk !== null && repo !== null
  return useAsync<BrowseContext | null>(
    () => loadBrowseContext(sdk!, repo!),
    [ready, repo?.contractId ?? ''],
    { enabled },
  )
}
