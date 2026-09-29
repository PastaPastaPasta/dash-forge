'use client'

import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import { readTargetCounts, repoContractIds, repoKey, type RepoRef } from '@/lib/repo'
import { sessionCached } from '@/lib/view/session-cache'

/**
 * The repo's issue (or PR) total (the countable `issue.number` / `patch.number` index), through
 * the same session-cache key the header's tab counts read, so the Issues and Pull requests tabs
 * cost no second count. Null until read, or when the read failed.
 */
export function useRepoTotals(repo: RepoRef, type: 'issues' | 'pulls' = 'issues'): number | null {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const generation = useRepoWriteGeneration(repo)
  const { data } = useAsync(
    () => sessionCached(`counts:${network}:${repo.repoId}:${generation}`, 60_000, () => readTargetCounts(sdk!, repo.forge, repo.repoId)),
    [ready, repoKey(repo), network, generation],
    { enabled: ready && sdk !== null },
  )
  return data?.[type] ?? null
}
