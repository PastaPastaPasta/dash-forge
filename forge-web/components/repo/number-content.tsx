'use client'

/**
 * `/repo/number?…&number=N` — where a `#N` autolink goes (FG-2 L-39). GitHub numbers issues
 * and PRs in one sequence and Markdown cannot tell which a `#N` means, so this page reads
 * both (a `(repoId, number)` lookup each) and opens whichever exists. With `upstream=1` (a
 * `#N` in content copied from the forge this repo mirrors) N is the source's number: the item a
 * trusted writer recorded with `upstreamNumber` N (D-2, `resolveUpstreamNumber`) is opened at
 * its own native number; otherwise, and when nothing is here, the page links to the item on the
 * source forge rather than dead-ending.
 */

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ExternalLink, Hash, type LucideIcon } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { readMembershipsCached, repoContractIds, repoKey } from '@/lib/repo'
import { numberTargets } from '@/lib/view/jump'
import { upstreamItemUrl } from '@/lib/view/ref-targets'
import { resolveUpstreamNumber } from '@/lib/view/upstream'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import type { RepoAddress } from '@/hooks/use-query-param'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { issueHref, mirrorRepo, pullHref } from '@/components/repo/target-href'

export function NumberContent({ home, addr, number, upstream }: { home: RepoHome; addr: RepoAddress; number: number; upstream: boolean }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const router = useRouter()
  const valid = Number.isSafeInteger(number) && number > 0
  const source = mirrorRepo(home.description)
  // Imported content's `#N` is the source's number: the native item a trusted writer recorded
  // with that `upstreamNumber` (whatever the description says). Elsewhere any row at N is.
  const checkUpstream = upstream
  const { data, error, reload } = useAsync(
    async (): Promise<{ issue: number | null; pull: number | null }> => {
      if (checkUpstream) {
        const hit = await resolveUpstreamNumber(sdk!, home.repo, number, await readMembershipsCached(sdk!, home.repo, network))
        return { issue: hit?.type === 'issue' ? hit.number : null, pull: hit?.type === 'patch' ? hit.number : null }
      }
      const found = await numberTargets(sdk!, home.repo, number)
      return { issue: found.issue ? number : null, pull: found.pull ? number : null }
    },
    [ready, repoKey(home.repo), number, checkUpstream, network],
    { enabled: ready && sdk !== null && valid },
  )
  const issue = data?.issue ?? null
  const pull = data?.pull ?? null
  const only = issue !== null && pull === null ? issueHref(addr, issue) : pull !== null && issue === null ? pullHref(addr, pull) : null
  useEffect(() => {
    if (only !== null) router.replace(only)
  }, [only, router])

  if (!valid) return <EmptyState icon={Hash} title="No number addressed" body="Add &number= to the URL." />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === null || only !== null) return <LoadingBlock label={`Finding #${number}`} />
  // The source's own page, only for a source number (a native #N has nothing to do with it)
  const upstreamUrl = checkUpstream ? upstreamItemUrl(source, number) : null
  if (issue !== null && pull !== null) {
    return (
      <EmptyState
        icon={Hash}
        title={`#${number} is both an issue and a PR here`}
        action={
          <span className="flex gap-3">
            <Link className="text-forge-700 underline dark:text-forge-400" href={issueHref(addr, issue)}>Issue #{issue}</Link>
            <Link className="text-forge-700 underline dark:text-forge-400" href={pullHref(addr, pull)}>PR #{pull}</Link>
          </span>
        }
      />
    )
  }
  return (
    <EmptyState
      icon={Hash}
      title={`#${number} is not in this repo`}
      body={upstreamUrl !== null ? `Its import did not copy #${number}.` : `No issue or PR has number ${number} here.`}
      action={
        upstreamUrl !== null ? (
          <a href={upstreamUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-forge-700 underline dark:text-forge-400" data-testid="upstream-link">
            Open #{number} on {source?.host} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : undefined
      }
    />
  )
}

/**
 * An issue or PR page's "not found" (QW-063). Issues and PRs share one number sequence, so an
 * issue URL for #N may name a PR (and the reverse), as a hand-edited link or a `#N` typed on the
 * wrong page does: the other kind is looked up and, when it holds N, the URL is replaced with its
 * page, as GitHub redirects `/issues/N` to `/pull/N`. Only when neither holds N does it say so.
 */
export function TargetNotFound({
  home,
  addr,
  number,
  kind,
  title,
  body,
  icon,
}: {
  home: RepoHome
  addr: RepoAddress | undefined
  number: number
  kind: 'issue' | 'pull'
  title: string
  body: string
  icon: LucideIcon
}): JSX.Element {
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  const router = useRouter()
  const { data, error } = useAsync(() => numberTargets(sdk!, home.repo, number), [ready, repoKey(home.repo), number], {
    enabled: ready && sdk !== null && addr !== undefined,
  })
  const other = data === null || addr === undefined ? null : kind === 'issue' ? (data.pull ? pullHref(addr, number) : null) : data.issue ? issueHref(addr, number) : null
  useEffect(() => {
    if (other !== null) router.replace(other)
  }, [other, router])
  if (other !== null) return <LoadingBlock label={kind === 'issue' ? `#${number} is a pull request; opening it` : `#${number} is an issue; opening it`} />
  if (addr !== undefined && data === null && error === null) return <LoadingBlock label={`Looking for #${number}`} />
  return <EmptyState icon={icon} title={title} body={body} />
}
