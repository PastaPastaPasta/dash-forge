'use client'

import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import { repoContractIds, repoKey, sharedRepoCounts, type RepoRef } from '@/lib/repo'
import { sessionCached } from '@/lib/view/session-cache'

/**
 * The repo's issue (or PR) total (the countable `issue.number` / `patch.number` index), from the
 * one counts read the header's tab counts and the list's index share (`sharedRepoCounts`), so
 * the Issues and Pull requests lists cost no count of their own. Null until read, or when any of
 * that read's three counts failed (the list then shows no total; the next render asks again).
 */
export function useRepoTotals(repo: RepoRef, type: 'issues' | 'pulls' = 'issues'): number | null {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const generation = useRepoWriteGeneration(repo)
  const { data } = useAsync(
    () =>
      sessionCached(`counts:${network}:${repo.repoId}:${generation}`, 60_000, async () => {
        const c = await sharedRepoCounts(sdk!, repo)
        return { issues: c.issues, pulls: c.patches }
      }),
    [ready, repoKey(repo), network, generation],
    { enabled: ready && sdk !== null },
  )
  return data?.[type] ?? null
}
