'use client'

import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { repoContractIds, repoKey, type RepoRef } from '@/lib/repo'
import { readMilestones } from '@/lib/repo/milestones'
import type { Milestone } from '@/lib/rules/parity'
import { sessionCached } from '@/lib/view/session-cache'

/**
 * The repo's milestones (newest definition per title), for the lists' milestone filter: one
 * read, shared for a minute across the Issues and Pull requests lists.
 */
export function useMilestones(repo: RepoRef): AsyncState<Milestone[]> {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  return useAsync(
    () => sessionCached(`milestones:${network}:${repoKey(repo)}`, 60_000, () => readMilestones(sdk!, repo)),
    [ready, repoKey(repo), network],
    { enabled: ready && sdk !== null },
  )
}
