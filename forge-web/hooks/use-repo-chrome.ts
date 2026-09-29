'use client'

/**
 * Repo-chrome reads shared by the header, rail and tabs, each through the session cache so a
 * navigation between a repo's pages repeats none of them:
 *
 *  - {@link useViewerRole}: what the signed-in viewer is on this repo (maintainer / writer /
 *    none), which decides the Settings tab and the member-only hints.
 *  - {@link useTargetCounts}: the Issues / Pull requests tab counts — the open ones, from
 *    three proved count requests (the two totals and the transitions by kind).
 *  - {@link useReleases}: the repo's releases, newest per tag.
 */

import { useRef, useSyncExternalStore } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import {
  latestRelease,
  readReleases,
  readRepoCounts,
  readViewerPermissions,
  repoContractIds,
  repoKey,
  repoWriteGeneration,
  subscribeRepoLists,
  type ReleaseList,
  type ReleaseView,
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
 * The OPEN issue and PR counts for the tabs (null: not read yet, so no number is shown), as
 * GitHub's tabs show them. Every state change is a legal `transition`, so the proved issue and
 * PR totals and one count of transitions by kind give them exactly, in three requests
 * (`readRepoCounts`). A write bumps the repo's write generation, which re-reads them; the last
 * numbers stay shown meanwhile, so the badge never blanks.
 */
export function useTargetCounts(repo: RepoRef): TargetTotals {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const generation = useRepoWriteGeneration(repo)
  const last = useRef<{ key: string; totals: TargetTotals } | null>(null)
  const { data } = useAsync(
    () =>
      sessionCached(`openCounts:${network}:${repo.repoId}:${generation}`, MINUTE, async (): Promise<TargetTotals> => {
        const c = await readRepoCounts(sdk!, repo)
        return { issues: c.issuesOpen, pulls: c.prsOpen }
      }),
    [ready, repoKey(repo), network, generation],
    { enabled: ready && sdk !== null },
  )
  const key = `${network}:${repoKey(repo)}`
  if (data !== null) last.current = { key, totals: data }
  return data ?? (last.current?.key === key ? last.current.totals : { issues: null, pulls: null })
}

/**
 * How many count-changing writes to `repo` landed this session, re-rendering on each. The
 * Issues and Pull requests lists put it in their read's deps, so they re-read after a write
 * alongside the header's counts, and the tab and the list keep agreeing.
 */
export function useRepoWriteGeneration(repo: RepoRef): number {
  return useSyncExternalStore(subscribeRepoLists, () => repoWriteGeneration(repo), () => 0)
}

export function useReleases(repo: RepoRef, { enabled = true }: { readonly enabled?: boolean } = {}): AsyncState<ReleaseList> {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  return useAsync(
    () => sessionCached(`releases:${network}:${repoKey(repo)}`, MINUTE, () => readReleases(sdk!, repo)),
    [ready, repoKey(repo), network],
    { enabled: enabled && ready && sdk !== null },
  )
}

/**
 * The rail's latest release (null: none), read only once `wanted` (the card came into view):
 * which release is latest is a version order over every tag, so it takes the whole list, and
 * the Releases tab reads the same cached list.
 */
export function useLatestRelease(repo: RepoRef, wanted: boolean): AsyncState<ReleaseView | null> {
  const releases = useReleases(repo, { enabled: wanted })
  return { ...releases, data: releases.data === null ? null : latestRelease(releases.data) ?? null }
}
