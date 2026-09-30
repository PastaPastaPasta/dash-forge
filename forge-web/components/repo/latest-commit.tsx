'use client'

/**
 * The latest-commit bar above a repo's (or a directory's) file list (QW-061a; GitHub's box
 * header): the tip commit's author, subject, short id and age. The commit object is one read the
 * list has already made (its tree), so it costs nothing new; until it is in, the bar holds its
 * height with a placeholder.
 */

import Link from 'next/link'
import type { ObjectReader } from '@/lib/view'
import { parseCommit } from '@/lib/view/git-objects'
import { commitSubject, timeAgo } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Oid } from '@/components/ui/oid'

export function LatestCommit({ reader, tipOid, addr }: { reader: ObjectReader; tipOid: string; addr: RepoAddress }): JSX.Element {
  const commit = useAsync(async () => parseCommit((await reader.readObject(tipOid)).bytes), [tipOid], {})
  const c = commit.data
  return (
    <div className="flex min-h-11 items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900" data-testid="latest-commit">
      {c === null ? (
        <span className="text-anvil-500 dark:text-anvil-400">{commit.error ? 'The latest commit could not be read' : 'Reading the latest commit…'}</span>
      ) : (
        <>
          <span className="max-w-[40%] shrink-0 truncate font-medium text-anvil-800 dark:text-anvil-100" title={c.author.email ? `${c.author.name} <${c.author.email}>` : c.author.name}>
            {c.author.name || 'unknown'}
          </span>
          <Link
            href={repoHref('/repo/commit', addr, { oid: tipOid })}
            className="min-w-0 flex-1 truncate text-anvil-600 hover:text-forge-800 hover:underline coarse:py-3 dark:text-anvil-300 dark:hover:text-forge-400"
            data-testid="latest-commit-subject"
          >
            {commitSubject(c.message) || '(no message)'}
          </Link>
          <span className="hidden shrink-0 sm:inline">
            <Oid value={tipOid} chars={7} copyable={false} />
          </span>
          <span className="shrink-0 whitespace-nowrap text-[12px] text-anvil-500 dark:text-anvil-400">{timeAgo(c.author.when)}</span>
        </>
      )}
    </div>
  )
}
