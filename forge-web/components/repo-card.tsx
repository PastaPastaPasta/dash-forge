'use client'

/**
 * RepoCard — a discovery/profile row: a repo with its provable star count and issue total
 * (open and closed) when read.
 */

import Link from 'next/link'
import { GitBranch, Lock, MessageSquare, Star } from 'lucide-react'
import type { DiscoveredRepo } from '@/lib/view'
import { plural, timeAgo } from '@/lib/view'
import { repoHref } from '@/hooks/use-query-param'
import { Author } from '@/components/author'

export function RepoCard({
  repo,
  showOwner = true,
}: {
  repo: DiscoveredRepo
  /** False on the owner's own profile, where every card's owner is the page's (L-86). */
  showOwner?: boolean
}): JSX.Element {
  // Every card pins the repo it shows by its repo id, so another repo answering to the same
  // owner and name can never stand in for it.
  const href = repoHref('/repo', { owner: repo.ownerId, name: repo.slug, repoId: repo.key })
  return (
    <div className="group rounded-lg border border-anvil-200 bg-white p-4 transition-colors hover:border-forge-400/60 dark:border-anvil-800 dark:bg-anvil-900">
      <div className="flex items-center gap-2">
        {repo.visibility === 'private' ? (
          <Lock className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-label="private" />
        ) : (
          <GitBranch className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
        )}
        <Link href={href} className="truncate font-mono text-prose text-anvil-900 hover:text-forge-800 coarse:-my-3 coarse:py-3 dark:text-anvil-50 dark:hover:text-forge-400">
          {repo.name}
        </Link>
        {repo.role ? (
          <span className="ml-auto shrink-0 rounded bg-forge-500/10 px-1.5 py-0.5 text-[11px] text-forge-800 dark:text-forge-300">
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
        {showOwner ? <Author identityId={repo.ownerId} /> : null}
        {typeof repo.pushedAt === 'number' ? (
          <span title="Newest push">{showOwner ? '· ' : ''}pushed {timeAgo(repo.pushedAt)}</span>
        ) : repo.createdAt ? (
          <span title="Created">{showOwner ? '· ' : ''}created {timeAgo(repo.createdAt)}</span>
        ) : null}
        {typeof repo.stars === 'number' ? (
          <span className="inline-flex items-center gap-1" title="Stars (provable count)" data-testid="repo-stars" data-stars={repo.stars}>
            <Star className="h-3 w-3" aria-hidden /> {repo.stars}
            <span className="sr-only">stars</span>
          </span>
        ) : null}
        {/* A total (the countable index), open and closed alike: so the Issues tab's neutral
            icon and the word "issues", never the open-state dot beside a number that is not
            the open count. */}
        {typeof repo.issues === 'number' ? (
          <span className="inline-flex items-center gap-1" title="Issues ever opened, open or closed (provable count)">
            {/* Visibly a total (L-85): the Issues tab counts open ones, so a bare "15 issues"
                beside a tab reading 13 looked wrong. */}
            <MessageSquare className="h-3 w-3" aria-hidden /> {plural(repo.issues, 'issue')} total
          </span>
        ) : null}
      </div>
    </div>
  )
}
