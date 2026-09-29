'use client'

/**
 * `/repo/number?…&number=N` — where a `#N` autolink goes (FG-2 L-39). GitHub numbers issues
 * and PRs in one sequence and Markdown cannot tell which a `#N` means, so this page reads
 * both (a `(repoId, number)` lookup each) and opens whichever exists. With `upstream=1` (a
 * `#N` in content copied from the forge this repo mirrors) a row counts only when the import
 * wrote it for that upstream number; otherwise, and when nothing is here, the page links to the
 * item on the source forge rather than dead-ending.
 */

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ExternalLink, Hash } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { repoContractIds, repoKey } from '@/lib/repo'
import { isUpstreamItem, numberRows, type NumberRow } from '@/lib/view/jump'
import { upstreamItemUrl } from '@/lib/view/ref-targets'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import type { RepoAddress } from '@/hooks/use-query-param'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { issueHref, mirrorRepo, pullHref } from '@/components/repo/target-href'

export function NumberContent({ home, addr, number, upstream }: { home: RepoHome; addr: RepoAddress; number: number; upstream: boolean }): JSX.Element {
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  const router = useRouter()
  const valid = Number.isSafeInteger(number) && number > 0
  const { data, error, reload } = useAsync(() => numberRows(sdk!, home.repo, number), [ready, repoKey(home.repo), number], {
    enabled: ready && sdk !== null && valid,
  })
  // Imported content's `#N` is the source's number: only the row its import wrote for N is it.
  const counts = (row: NumberRow | null): boolean => row !== null && (!upstream || isUpstreamItem(row.importedUrl, number))
  const issue = data !== null && counts(data.issue)
  const pull = data !== null && counts(data.pull)
  const only = issue !== pull ? (issue ? issueHref(addr, number) : pullHref(addr, number)) : null
  useEffect(() => {
    if (only !== null) router.replace(only)
  }, [only, router])

  if (!valid) return <EmptyState icon={Hash} title="No number addressed" body="Add &number= to the URL." />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === null || only !== null) return <LoadingBlock label={`Finding #${number}`} />
  const source = mirrorRepo(home.description)
  const upstreamUrl = upstreamItemUrl(source, number)
  if (issue && pull) {
    return (
      <EmptyState
        icon={Hash}
        title={`#${number} is both an issue and a PR here`}
        action={
          <span className="flex gap-3">
            <Link className="text-forge-700 underline dark:text-forge-400" href={issueHref(addr, number)}>Issue #{number}</Link>
            <Link className="text-forge-700 underline dark:text-forge-400" href={pullHref(addr, number)}>PR #{number}</Link>
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
