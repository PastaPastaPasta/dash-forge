'use client'

/**
 * Repo-chrome reads shared by the header, rail and tabs, each through the session cache so a
 * navigation between a repo's pages repeats none of them:
 *
 *  - {@link useViewerRole}: what the signed-in viewer is on this repo (maintainer / writer /
 *    none), which decides the Settings tab and the member-only hints.
 *  - {@link useTargetCounts}: the Issues / Pull requests tab counts — the open ones, folded
 *    from the same cached list pages those tabs show.
 *  - {@link useReleases}: the repo's releases, newest per tag.
 */

import { useRef, useSyncExternalStore } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import {
  foldOpenCounts,
  openCounts,
  readReleases,
  readTargetCounts,
  readViewerPermissions,
  repoContractIds,
  repoKey,
  repoListVersion,
  repoWriteGeneration,
  subscribeRepoLists,
  type ReleaseList,
  type RepoRef,
  type TargetTotals,
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

/**
 * The OPEN issue and PR counts for the tabs (null: not proven, so no number is shown). The
 * countable indexes only give totals — open or closed — so they pick the strategy
 * (`foldsForCount`) and the numbers come from the same folded list pages the Issues and Pull
 * requests pages show, through their shared session cache. A write drops those lists and
 * bumps the repo's write generation, which re-reads the totals and refolds here.
 */
export function useTargetCounts(repo: RepoRef): TargetTotals {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  // Re-render whenever a list page settles or a write drops them, on this page or another.
  useSyncExternalStore(subscribeRepoLists, () => repoListVersion(repo), () => 0)
  const generation = repoWriteGeneration(repo)
  // The last totals this repo resolved: shown while a write's generation re-reads them, so the
  // badge keeps its number instead of blanking (a mismatched total refolds, never misleads).
  const lastTotals = useRef<{ key: string; totals: TargetTotals } | null>(null)
  const { data } = useAsync(
    async () => {
      const totals = await sessionCached(`counts:${network}:${repo.repoId}:${generation}`, MINUTE, () =>
        readTargetCounts(sdk!, repo.forge, repo.repoId),
      )
      await foldOpenCounts(sdk!, repo, totals)
      return totals
    },
    [ready, repoKey(repo), network, generation],
    { enabled: ready && sdk !== null },
  )
  const key = `${network}:${repoKey(repo)}`
  if (data !== null) lastTotals.current = { key, totals: data }
  const totals = data ?? (lastTotals.current?.key === key ? lastTotals.current.totals : null)
  return openCounts(repo, totals)
}

export function useReleases(repo: RepoRef): AsyncState<ReleaseList> {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  return useAsync(
    () => sessionCached(`releases:${network}:${repoKey(repo)}`, MINUTE, () => readReleases(sdk!, repo)),
    [ready, repoKey(repo), network],
    { enabled: ready && sdk !== null },
  )
}
