'use client'

/**
 * An issue's "Development" backlinks (review-parity P8, QW-015): the pull requests whose
 * description says they close it ("Fixes #12"), with their state, as GitHub's issue sidebar lists
 * them. Read from the pull index the PR list shares (`pullsLinking`: the newest few hundred PRs at
 * most, and said when that is not all of them).
 */

import Link from 'next/link'
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react'
import { pullsLinking, repoContractIds, repoKey, type PullRow } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import type { RepoAddress } from '@/hooks/use-query-param'
import { mirrorRepo, pullHref } from '@/components/repo/target-href'
import { importedHost } from '@/lib/view/ref-targets'

function stateOf(p: PullRow): { label: string; icon: JSX.Element } {
  if (p.state.merged) return { label: 'merged', icon: <GitMerge className="h-3.5 w-3.5 shrink-0 text-dash-600 dark:text-dash-400" aria-hidden /> }
  if (!p.state.open) return { label: 'closed', icon: <GitPullRequestClosed className="h-3.5 w-3.5 shrink-0 text-danger-700 dark:text-danger-400" aria-hidden /> }
  if (p.state.draft) return { label: 'draft', icon: <GitPullRequestDraft className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden /> }
  return { label: 'open', icon: <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-verify-700 dark:text-verify-400" aria-hidden /> }
}

/**
 * `upstream`: the source forge's number of this issue a trusted mirror recorded, or null. An
 * imported PR's "Fixes #N" is the source's N (as its description renders), so it links this
 * issue only through `upstream`.
 */
export function LinkedPulls({ home, addr, number, upstream }: { home: RepoHome; addr: RepoAddress | undefined; number: number; upstream: number | null }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const generation = useRepoWriteGeneration(home.repo)
  const description = home.description
  const { data, error } = useAsync(
    () => {
      const source = mirrorRepo(description)
      return pullsLinking(sdk!, home.repo, { number, upstream }, (r) => importedHost(r.importedUrl, source) !== null, network)
    },
    [ready, repoKey(home.repo), number, upstream, description, network, generation],
    { enabled: ready && sdk !== null },
  )
  if (error !== null) return <p className="text-anvil-500 dark:text-anvil-400">Couldn&apos;t read the pull requests.</p>
  if (data === null) return <p className="text-anvil-500 dark:text-anvil-400">Reading pull requests…</p>
  return (
    <div data-testid="linked-pulls">
      {data.pulls.length === 0 ? (
        <p className="text-anvil-500 dark:text-anvil-400">No pull request closes this yet. &ldquo;Fixes #{number}&rdquo; in a PR&apos;s description links it here.</p>
      ) : (
        <ul className="space-y-1.5">
          {data.pulls.map((p) => {
            const st = stateOf(p)
            const text = (
              <>
                <span className="font-mono">#{p.number}</span> {p.title || '(untitled)'}
              </>
            )
            return (
              <li key={p.id} className="flex items-start gap-1.5" data-testid="linked-pull" data-number={p.number} data-state={st.label}>
                <span className="mt-0.5">{st.icon}</span>
                <span className="min-w-0">
                  {addr !== undefined ? (
                    <Link href={pullHref(addr, p.number)} className="hit-area break-words text-anvil-800 hover:text-forge-700 hover:underline dark:text-anvil-100 dark:hover:text-forge-400">
                      {text}
                    </Link>
                  ) : (
                    <span className="break-words">{text}</span>
                  )}
                  <span className="block text-[11px] text-anvil-500 dark:text-anvil-400">{st.label}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {data.searched !== null ? <p className="mt-1.5 text-[11px] text-anvil-500 dark:text-anvil-400">Searched the newest {data.searched} pull requests.</p> : null}
    </div>
  )
}
