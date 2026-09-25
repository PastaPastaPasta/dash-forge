'use client'

/**
 * RepoCard — a discovery/profile row: a forge-v2 repo (with its provable star and issue
 * counts when read) or a v1 registry listing (marked, since v1 repos are read-only here).
 */

import Link from 'next/link'
import { CircleDot, GitBranch, Lock, Star } from 'lucide-react'
import type { DiscoveredRepo } from '@/lib/view'
import { timeAgo } from '@/lib/view'
import { repoHref } from '@/hooks/use-query-param'
import { Author } from '@/components/author'
import { V1Badge } from '@/components/ui/v1-badge'

export function RepoCard({ repo }: { repo: DiscoveredRepo }): JSX.Element {
  // Every card pins the repo it shows (v1 its contract, v2 its repo id), so another repo
  // answering to the same owner and name can never stand in for it.
  const href = repoHref('/repo', {
    owner: repo.ownerId,
    name: repo.slug,
    ...(repo.kind === 'v2' ? { repoId: repo.key } : repo.contractId ? { contractId: repo.contractId } : {}),
  })
  return (
    <div className="group rounded-lg border border-anvil-200 bg-white p-4 transition-colors hover:border-forge-400/60 dark:border-anvil-800 dark:bg-anvil-900">
      <div className="flex items-center gap-2">
        {repo.visibility === 'private' ? (
          <Lock className="h-4 w-4 shrink-0 text-anvil-400" aria-label="private" />
        ) : (
          <GitBranch className="h-4 w-4 shrink-0 text-anvil-400" aria-hidden />
        )}
        <Link href={href} className="truncate font-mono text-prose text-anvil-900 hover:text-forge-600 dark:text-anvil-50 dark:hover:text-forge-400">
          {repo.name}
        </Link>
        {repo.kind === 'v1' ? (
          <V1Badge className="ml-auto" />
        ) : repo.role ? (
          <span className="ml-auto shrink-0 rounded bg-forge-500/10 px-1.5 py-0.5 text-[11px] text-forge-700 dark:text-forge-300">
            {repo.role}
          </span>
        ) : null}
      </div>
      {repo.description ? (
        <p className="mt-2 line-clamp-2 text-anvil-600 dark:text-anvil-400">{repo.description}</p>
      ) : (
        <p className="mt-2 italic text-anvil-500 dark:text-anvil-400">No description</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
        <Author identityId={repo.ownerId} />
        {repo.createdAt ? <span>· {timeAgo(repo.createdAt)}</span> : null}
        {typeof repo.stars === 'number' ? (
          <span className="inline-flex items-center gap-1" title="Stars (provable count)">
            <Star className="h-3 w-3" aria-hidden /> {repo.stars}
            <span className="sr-only">stars</span>
          </span>
        ) : null}
        {typeof repo.issues === 'number' ? (
          <span className="inline-flex items-center gap-1" title="Issues ever opened, open or closed (provable count)">
            <CircleDot className="h-3 w-3" aria-hidden /> {repo.issues}
            <span className="sr-only">issues in total</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}
