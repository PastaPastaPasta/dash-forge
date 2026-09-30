'use client'

/**
 * ResolvedTip — the object a browse view reads, resolved before the view starts (L-01, L-32): a
 * short commit id through the locator, and an annotated tag (most release tags) through to the
 * commit it names. Warm views paint at once from the session cache. A tag of a tree or a blob, or
 * an id that names no single commit, gets a plain state instead of a raw error; a failure no retry
 * can fix gets no "Try again" (L-63); storage that stopped answering gets its card.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { GitCommit, Tag } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import { repoKey, type RepoRef } from '@/lib/repo'
import { CommitIdError, shortOid } from '@/lib/view'
import { PackUnavailableError, unavailableOf } from '@/lib/view/browse-source'
import { isPermanentReadError, peekTip, resolveTip, type PeeledTip } from '@/lib/view/tip'
import { useAsync } from '@/hooks/use-async'
import { StorageUnreachableCard } from '@/components/repo/storage-unreachable'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { errorMessage } from '@/lib/utils'

const COMMIT_ID_TITLES: Record<CommitIdError['kind'], string> = {
  invalid: 'Not a commit id',
  'not-found': 'Commit not found',
  'not-a-commit': 'Not a commit',
  ambiguous: 'Ambiguous commit id',
}

/** A {@link CommitIdError} as a state: the matching commits when ambiguous, "Try again" when not found (a push may bring it). */
function CommitIdState({ cause, addr, retry }: { cause: CommitIdError; addr: RepoAddress; retry: () => void }): JSX.Element {
  return (
    <EmptyState
      icon={GitCommit}
      title={COMMIT_ID_TITLES[cause.kind]}
      body={cause.message}
      action={
        cause.candidates.length > 0 ? (
          <ul className="space-y-1 text-left font-mono text-dense">
            {cause.candidates.map((c) => (
              <li key={c}>
                <Link href={repoHref('/repo/commit', addr, { oid: c })} className="hover:text-forge-800 dark:hover:text-forge-400">
                  {c}
                </Link>
              </li>
            ))}
          </ul>
        ) : cause.kind === 'not-found' ? (
          // GitHub's 404 for a commit: the way back is the commit list (QW2-037). Try again stays
          // second, for a push that may bring the commit.
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link
              href={repoHref('/repo/commits', addr)}
              data-testid="commit-not-found-commits"
              className="inline-flex h-9 items-center rounded-md bg-forge-700 px-3.5 text-dense font-medium text-white hover:bg-forge-800 coarse:h-auto coarse:min-h-11"
            >
              View commits
            </Link>
            <Button onClick={retry}>Try again</Button>
          </div>
        ) : undefined
      }
    />
  )
}

/**
 * A read failure: the storage card when a pack's storage stopped answering, its own state for a
 * bad id, and "Try again" only where trying again can help.
 */
export function ReadErrorState({ cause, retry, addr, repo }: { cause: unknown; retry: () => void; addr: RepoAddress; repo?: RepoRef }): JSX.Element {
  if (cause instanceof PackUnavailableError && repo !== undefined) {
    return <StorageUnreachableCard repo={repo} addr={addr} packs={[unavailableOf(cause)]} retry={retry} />
  }
  if (cause instanceof CommitIdError) return <CommitIdState cause={cause} addr={addr} retry={retry} />
  return <ErrorState message={errorMessage(cause)} onRetry={isPermanentReadError(cause) ? undefined : retry} />
}

/** The state for a tag whose target the view cannot show: history and blame need a commit, a listing a tree. */
function TagTargetState({ peeled, name, addr, refParam }: { peeled: PeeledTip; name: string; addr: RepoAddress; refParam: string }): JSX.Element {
  const isTree = peeled.type === 'tree'
  // The file view shows a tag of a blob whatever the path, so any path opens it.
  const target = isTree ? repoHref('/repo/tree', addr, { ref: refParam }) : repoHref('/repo/blob', addr, { ref: refParam, path: name })
  return (
    <EmptyState
      icon={Tag}
      title={`${name} is not a commit`}
      body={`${name} is a tag of ${isTree ? 'a directory tree' : 'a single file'} (${shortOid(peeled.oid)}), not of a commit, so it has no history.`}
      action={
        refParam ? (
          <Link href={target}>
            <Button variant="primary">{isTree ? 'Browse its files' : 'View the file'}</Button>
          </Link>
        ) : undefined
      }
    />
  )
}

/** What a view can show: a commit's history, a tree (a listing), or anything (a file view). */
export type TipAccepts = 'commit' | 'tree' | 'any'

const ACCEPTED: Record<TipAccepts, readonly PeeledTip['type'][]> = {
  commit: ['commit'],
  tree: ['commit', 'tree'],
  any: ['commit', 'tree', 'blob'],
}

export function ResolvedTip({
  reader,
  retry,
  repo,
  tip,
  pinned,
  name,
  addr,
  refParam,
  accepts,
  label,
  children,
}: {
  reader: BrowseReader
  retry: () => void
  repo: RepoRef
  /** The selection's tip ({@link selectedTip}): a commit or tag id, full or short. */
  tip: string
  /** The tip came from the URL (`?ref=<id>`), not from a ref. */
  pinned: boolean
  /** The selection's name, for the states. */
  name: string
  addr: RepoAddress
  refParam: string
  accepts: TipAccepts
  label: string
  children: (peeled: PeeledTip) => ReactNode
}): JSX.Element {
  const key = repoKey(repo)
  const { data, error, cause } = useAsync(() => resolveTip(reader, tip, { repoKey: key, pinned }), [tip, key], {
    initial: () => peekTip(reader, tip),
  })
  if (error !== null) return <ReadErrorState cause={cause} retry={retry} addr={addr} repo={repo} />
  if (data === null) return <LoadingBlock label={label} />
  if (!ACCEPTED[accepts].includes(data.type)) return <TagTargetState peeled={data} name={name} addr={addr} refParam={refParam} />
  return <>{children(data)}</>
}
