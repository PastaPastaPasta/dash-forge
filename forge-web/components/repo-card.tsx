'use client'

/** RepoCard — a discovery/profile row for a registry repo listing. */

import Link from 'next/link'
import { GitBranch } from 'lucide-react'
import type { DiscoveredRepo } from '@/lib/view'
import { timeAgo } from '@/lib/view'
import { Author } from '@/components/author'

export function RepoCard({ repo }: { repo: DiscoveredRepo }): JSX.Element {
  const href = `/repo?owner=${encodeURIComponent(repo.ownerId)}&name=${encodeURIComponent(repo.normalizedName || repo.name)}`
  return (
    <div className="group rounded-lg border border-anvil-200 bg-white p-4 transition-colors hover:border-forge-400/60 dark:border-anvil-800 dark:bg-anvil-900">
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 shrink-0 text-anvil-400" aria-hidden />
        <Link href={href} className="truncate font-mono text-prose text-anvil-900 hover:text-forge-600 dark:text-anvil-50 dark:hover:text-forge-400">
          {repo.name}
        </Link>
      </div>
      {repo.description ? (
        <p className="mt-2 line-clamp-2 text-anvil-600 dark:text-anvil-400">{repo.description}</p>
      ) : (
        <p className="mt-2 italic text-anvil-400 dark:text-anvil-500">No description</p>
      )}
      <div className="mt-3 flex items-center gap-2 text-[12px] text-anvil-400">
        <Author identityId={repo.ownerId} />
        {repo.createdAt ? <span>· {timeAgo(repo.createdAt)}</span> : null}
      </div>
    </div>
  )
}
