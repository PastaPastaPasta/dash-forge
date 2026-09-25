'use client'

/**
 * StargazersContent — who starred this repo: v1 registry `star` docs (newest first), or
 * forge-v2 forge-collab `star` docs (index order; `star` is indexOnly and carries no time).
 */

import { Star } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { timeAgo } from '@/lib/view'
import { readStargazers, readV2Stargazers, type Stargazer } from '@/lib/repo'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { Author } from '@/components/author'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'

export function StargazersContent({ home }: { home: RepoHome }): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const listingId = home.listingId
  const v2 = home.repo.kind === 'v2' ? home.repo : null

  const { data, loading, error, reload } = useAsync<Stargazer[]>(
    async () =>
      v2 !== null
        ? (await readV2Stargazers(sdk!, v2.forge, v2.repoId)).map((identity) => ({ identity, starredAt: 0 }))
        : readStargazers(sdk!, listingId!, { network }),
    [ready, listingId, v2?.repoId ?? '', network],
    { enabled: ready && sdk !== null && (listingId !== null || v2 !== null) },
  )

  if (!listingId && v2 === null) {
    return <EmptyState icon={Star} title="No stargazers" body="This repo has no registry listing, so it cannot be starred." />
  }
  if (loading) return <LoadingBlock label="Reading stargazers" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />
  if (data.length === 0) {
    return <EmptyState icon={Star} title="No stargazers yet" body="Be the first to star this repo." />
  }

  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      {data.map((s) => (
        <div
          key={s.identity}
          className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850"
        >
          <div className="min-w-0 flex-1">
            <Author identityId={s.identity} link />
          </div>
          {s.starredAt > 0 ? <span className="text-[12px] text-anvil-400">starred {timeAgo(s.starredAt)}</span> : null}
        </div>
      ))}
    </div>
  )
}
