'use client'

/**
 * An issue's "Development" backlinks (review-parity P8, QW-015): the pull requests whose
 * description says they close it ("Fixes #12"), with their state, as GitHub's issue sidebar lists
 * them. Read from the pull index the PR list shares (`pullsLinking`: the newest few hundred PRs at
 * most, and said when that is not all of them).
 */

import Link from 'next/link'
import { pullStateView } from '@/components/repo/pull-state'
import { pullsLinking, readTransitions, repoContractIds, repoKey, type LinkingPulls, type PullRow } from '@/lib/repo'
import { PR_MERGE } from '@/lib/rules/transition'
import type { ClosingMerge } from '@/lib/view/cross-refs'
import type { RepoHome } from '@/lib/view'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import type { RepoAddress } from '@/hooks/use-query-param'
import { mirrorRepo, pullHref } from '@/components/repo/target-href'
import { importedHost } from '@/lib/view/ref-targets'
import { closedByPr } from '@/lib/rules/transition'

function stateOf(p: PullRow): { label: string; icon: JSX.Element } {
  const { label, Icon, klass } = pullStateView(p.state)
  return { label: label.toLowerCase(), icon: <Icon className={`h-3.5 w-3.5 shrink-0 ${klass}`} aria-hidden /> }
}

/** An issue's backlinks, and the merges of those that close it (for "closed this in #3"). */
export interface IssueBacklinks {
  readonly linking: AsyncState<LinkingPulls>
  /** Read after `linking`, so the Development box never waits for them; empty until then. */
  readonly merges: readonly ClosingMerge<PullRow>[]
}

const NO_MERGES: readonly ClosingMerge<PullRow>[] = []

/** How many merged closing PRs' transitions are read, newest first (one small read each). */
const MERGES_READ = 5

/**
 * The PRs whose description closes or mentions issue `number` (`pullsLinking`), and for the merged
 * ones that close it, the transition that merged each (QW2-048). `upstream`: the source forge's
 * number of this issue a trusted mirror recorded, or null. An imported PR's "Fixes #N" is the
 * source's N (as its description renders), so it links this issue only through `upstream`.
 */
export function useIssueBacklinks(home: RepoHome, number: number, upstream: number | null, enabled = true): IssueBacklinks {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const generation = useRepoWriteGeneration(home.repo)
  const description = home.description
  const linking = useAsync(
    () => {
      const source = mirrorRepo(description)
      return pullsLinking(sdk!, home.repo, { number, upstream }, (r) => importedHost(r.importedUrl, source) !== null, network)
    },
    [ready, repoKey(home.repo), number, upstream, description, network, generation],
    { enabled: enabled && ready && sdk !== null },
  )
  const merged = (linking.data?.pulls ?? []).filter((p) => p.state.merged).slice(0, MERGES_READ)
  const merges = useAsync(
    async () => {
      // A failed read loses only the "in #3" (the close still shows).
      const found = await Promise.all(
        merged.map(async (pull) => {
          const merge = (await readTransitions(sdk!, home.repo, pull.id).catch(() => [])).filter((t) => t.kind === PR_MERGE).pop()
          return merge === undefined ? [] : [{ pull, merge }]
        }),
      )
      return found.flat()
    },
    [ready, repoKey(home.repo), merged.map((p) => p.id).join(','), network, generation],
    { enabled: enabled && ready && sdk !== null && merged.length > 0 },
  )
  return { linking, merges: merges.data ?? NO_MERGES }
}

/** An issue's "Development" box: the PRs that close it (`backlinks`: {@link useIssueBacklinks}). */
export function LinkedPulls({ addr, number, backlinks }: { addr: RepoAddress | undefined; number: number; backlinks: AsyncState<LinkingPulls> }): JSX.Element {
  const { data, error } = backlinks
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

/**
 * The PR a close names as its cause (`closedByPr`), when it holds (the shared `closedByPr` rule):
 * among the PRs whose description closes issue `issue`, merged and not imported. Null otherwise
 * (not read yet, not merged, or naming another PR): the close shows as a plain one.
 */
export function namedClosingPull(backlinks: IssueBacklinks, issue: number, pr: number): PullRow | null {
  const p = backlinks.linking.data?.pulls.find((x) => x.number === pr)
  if (p === undefined) return null
  const ok = closedByPr(issue, pr, { number: p.number, merged: p.state.merged, body: p.body, imported: p.imported })
  return ok === null ? null : p
}
