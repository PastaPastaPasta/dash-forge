'use client'

/**
 * StargazersContent — who starred this repo: its forge-collab `star` docs (index order; `star`
 * is indexOnly and carries no time). Like GitHub's, the page sits under no repo tab, so it
 * carries its own heading with the provable star count.
 */

import { Star } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RepoHome } from '@/lib/view'
import { readStargazers } from '@/lib/repo'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { Author } from '@/components/author'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import type { RepoAddress } from '@/hooks/use-query-param'

/** `readStargazers` reads one page of this many. */
const STARGAZERS_READ = 100

export function StargazersContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const { repo } = home

  const { data, loading, error, reload } = useAsync<string[]>(
    () => readStargazers(sdk!, repo.forge, repo.repoId),
    [ready, repo.repoId, network],
    { enabled: ready && sdk !== null },
  )

  let body: ReactNode
  if (loading) body = <LoadingBlock label="Reading stargazers" />
  else if (error) body = <ErrorState message={error} onRetry={reload} />
  else if (!data) body = <LoadingBlock />
  else if (data.length === 0) body = <EmptyState icon={Star} title="No stargazers yet" body="Be the first to star this repo." />
  else {
    const capped = typeof home.starCount === 'number' && home.starCount > data.length && data.length >= STARGAZERS_READ
    body = (
      <>
      {capped ? (
        <p role="note" className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="stargazers-capped">
          Showing the first {data.length} of {home.starCount} stargazers (index order).
        </p>
      ) : null}
      <ul className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        {data.map((identity) => (
          <li key={identity} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850">
            <div className="min-w-0 flex-1">
              <Author identityId={identity} link />
            </div>
          </li>
        ))}
      </ul>
      </>
    )
  }

  const count = home.starCount
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-xl">
          <Star className="h-5 w-5 text-anvil-500 dark:text-anvil-400" aria-hidden /> Stargazers
          {typeof count === 'number' ? (
            <span className="rounded-full bg-anvil-100 px-2 text-dense tabular-nums text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200" title="Stars (provable count)">
              {count}
            </span>
          ) : null}
        </h1>
        <CopyLinkButton repo={addr} target={{ kind: 'stargazers' }} className="ml-auto" />
      </div>
      {body}
    </div>
  )
}
