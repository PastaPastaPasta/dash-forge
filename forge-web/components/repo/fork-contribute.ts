'use client'

/**
 * Proposing a fork's branch to its parent (QW3-012), as GitHub's "Contribute → Open pull request"
 * and a fork's "New pull request" do: the pull request lives in the parent (its `patch` names
 * the fork as the source repo), so the form to open is the parent's, with the fork's branch as
 * the head (`?head=<forkRepoId>:<branch>`, which the parent's form lists even when the fork is
 * someone else's).
 */

import { readForkParent, repoKey, type RepoRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { repoHref } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'

/** The parent's New pull request form, with `fork`'s `branch` as the head. */
export function contributeHref(parent: Pick<RepoRef, 'ownerId' | 'name'>, fork: Pick<RepoRef, 'repoId'>, branch: string): string {
  return repoHref('/repo/pulls/new', { owner: parent.ownerId, name: parent.name }, { head: `${fork.repoId}:${branch}` })
}

/**
 * The public repository `home` was forked from, or null (not a fork, not public, or still being
 * read). One cached read per repo (`readForkParent`).
 */
export function useForkParent(home: RepoHome): RepoRef | null {
  const { sdk, ready } = useSdk()
  const fork = home.v2.forkOf !== null && home.repo.visibility === 'public'
  const { data } = useAsync(() => readForkParent(sdk!, home.repo), [ready, repoKey(home.repo)], { enabled: ready && sdk !== null && fork })
  return fork ? (data ?? null) : null
}
