'use client'

/**
 * "This repository moved to owner/name": shown on a public repo a maintainer marked as moved
 * (`config.movedTo`). Readers follow a move on public repos only; nothing is redirected, so the
 * old repo stays readable and writable. The new repo is read once (by id) to name it; one that
 * cannot be found is said so rather than linked.
 */

import Link from 'next/link'
import { MoveRight } from 'lucide-react'
import { Author } from '@/components/author'
import { repoHref } from '@/hooks/use-query-param'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { readRepoById } from '@/lib/repo/resolveRepo'
import type { RepoHome } from '@/lib/view'

export function MovedBanner({ home }: { home: RepoHome }): JSX.Element | null {
  const { sdk, ready } = useSdk()
  const target = home.repo.visibility === 'public' ? home.config?.movedTo : undefined
  const moved = target !== undefined && target !== home.repo.repoId
  const { data, error, settled } = useAsync(() => readRepoById(sdk!, home.repo.forge, target as string), [ready, home.repo.forge.core, target], {
    enabled: ready && sdk !== null && moved,
  })
  if (!moved) return null
  const box = 'mt-3 flex flex-wrap items-center gap-1.5 rounded-md border border-forge-500/40 bg-forge-500/5 px-3 py-1.5 text-dense text-anvil-800 dark:text-anvil-100'
  // A read that failed says nothing (the next load asks again); a proved absence is said.
  if (!settled || error !== null) return null
  if (data === null) {
    return (
      <div className={box} role="status" data-testid="repo-moved">
        <MoveRight className="h-3.5 w-3.5 shrink-0 text-forge-700 dark:text-forge-400" aria-hidden />
        A maintainer marked this repository as moved, but the new repository could not be found.
      </div>
    )
  }
  return (
    <div className={box} role="status" data-testid="repo-moved">
      <MoveRight className="h-3.5 w-3.5 shrink-0 text-forge-700 dark:text-forge-400" aria-hidden />
      This repository moved to
      <Author identityId={data.ownerId} link={false} />
      <span aria-hidden>/</span>
      <span>
        <Link
          href={repoHref('/repo', { owner: data.ownerId, name: data.name })}
          className="font-mono font-medium text-forge-700 underline-offset-2 hover:underline dark:text-forge-400"
          data-testid="repo-moved-link"
        >
          {data.name}
        </Link>
        .
      </span>
    </div>
  )
}
