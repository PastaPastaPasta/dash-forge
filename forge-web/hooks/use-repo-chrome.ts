'use client'

/**
 * Repo-chrome reads shared by the header, rail and tabs, each through the session cache so a
 * navigation between a repo's pages repeats none of them:
 *
 *  - {@link useViewerRole}: what the signed-in viewer is on this repo (maintainer / writer /
 *    none), which decides the Settings tab and the member-only hints.
 *  - {@link useTargetCounts}: the Issues / Pull requests tab counts, from the countable
 *    `number` indexes.
 *  - {@link useReleases}: the repo's releases, newest per tag.
 */

import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import {
  readReleases,
  readTargetCounts,
  readViewerPermissions,
  repoContractIds,
  repoKey,
  type ReleaseList,
  type RepoRef,
} from '@/lib/repo'
import { sessionCached } from '@/lib/view/session-cache'

export type ViewerRole = 'maintainer' | 'writer' | null

const MINUTE = 60_000

/**
 * The viewer's role; `known` once it is read (signed out resolves to null at once). A read
 * that failed is `failed`, never "not a member": `readViewerPermissions` answers null then.
 */
export function useViewerRole(repo: RepoRef): {
  readonly role: ViewerRole
  readonly known: boolean
  readonly failed: boolean
  readonly retry: () => void
} {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity } = useAuth()
  const state = useAsync<ViewerRole>(
    () =>
      sessionCached(`role:${network}:${repoKey(repo)}:${identity}`, 5 * MINUTE, async () => {
        const holdings = await readViewerPermissions(sdk!, repo, identity!, network)
        if (holdings === null) throw new Error("couldn't read this repo's members")
        return holdings.maintain ? 'maintainer' : holdings.write ? 'writer' : null
      }),
    [ready, repoKey(repo), identity ?? '', network],
    { enabled: ready && sdk !== null && identity !== null },
  )
  if (identity === null) return { role: null, known: true, failed: false, retry: state.reload }
  return { role: state.data ?? null, known: state.settled && state.error === null, failed: state.error !== null, retry: state.reload }
}

export function useTargetCounts(repo: RepoRef): { readonly issues: number | null; readonly pulls: number | null } {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { data } = useAsync(
    () => sessionCached(`counts:${network}:${repo.repoId}`, MINUTE, () => readTargetCounts(sdk!, repo.forge, repo.repoId)),
    [ready, repoKey(repo), network],
    { enabled: ready && sdk !== null },
  )
  return data ?? { issues: null, pulls: null }
}

export function useReleases(repo: RepoRef): AsyncState<ReleaseList> {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  return useAsync(
    () => sessionCached(`releases:${network}:${repoKey(repo)}`, MINUTE, () => readReleases(sdk!, repo)),
    [ready, repoKey(repo), network],
    { enabled: ready && sdk !== null },
  )
}
