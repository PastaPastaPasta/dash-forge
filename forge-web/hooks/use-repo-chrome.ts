'use client'

/**
 * Repo-chrome reads shared by the header, rail and tabs, each through the session cache so a
 * navigation between a repo's pages repeats none of them:
 *
 *  - {@link useViewerRole}: what the signed-in viewer is on this repo (maintainer / writer /
 *    none), which decides the Settings tab and the member-only hints.
 *  - {@link useTargetCounts}: the Issues / Pull requests tab counts, from the countable
 *    `number` indexes (forge-v2; v1 repos have no countable index and show no number).
 *  - {@link useReleases}: the repo's releases, newest per tag.
 */

import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import {
  readReleases,
  readV2TargetCounts,
  readViewerPermissions,
  repoContractIds,
  repoKey,
  type ReleaseList,
  type RepoRef,
} from '@/lib/repo'
import { sessionCached } from '@/lib/view/session-cache'

export type ViewerRole = 'maintainer' | 'writer' | null

const MINUTE = 60_000

/** The viewer's role; `unknown` until it is read (signed out resolves to null at once). */
export function useViewerRole(repo: RepoRef): { readonly role: ViewerRole; readonly known: boolean } {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { identity } = useAuth()
  const state = useAsync<ViewerRole>(
    () =>
      sessionCached(`role:${network}:${repoKey(repo)}:${identity}`, 5 * MINUTE, async () => {
        const holdings = await readViewerPermissions(sdk!, repo, identity!, network)
        return holdings?.maintain ? 'maintainer' : holdings?.write ? 'writer' : null
      }),
    [ready, repoKey(repo), identity ?? '', network],
    { enabled: ready && sdk !== null && identity !== null },
  )
  if (identity === null) return { role: null, known: true }
  return { role: state.data ?? null, known: state.settled }
}

export function useTargetCounts(repo: RepoRef): { readonly issues: number | null; readonly pulls: number | null } {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { data } = useAsync(
    () =>
      repo.kind === 'v2'
        ? sessionCached(`counts:${network}:${repo.repoId}`, MINUTE, () => readV2TargetCounts(sdk!, repo.forge, repo.repoId))
        : Promise.resolve({ issues: null, pulls: null }),
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
