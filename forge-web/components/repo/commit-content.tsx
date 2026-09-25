'use client'

/**
 * CommitContent — a single commit: metadata + its patch against its first parent (browse-plane
 * tree diff, then per-file line diffs through the shared {@link DiffView}). A root commit shows
 * every file as added. Each changed path links to its blob on the default branch — the blob
 * route addresses branches and tags, not commits.
 */

import Link from 'next/link'
import { useMemo } from 'react'
import { GitCommit } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { DiffSides, RepoHome } from '@/lib/view'
import { commitSubject, formatDate, loadCommitChanges, timeAgo } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { DiffView } from '@/components/repo/diff-view'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

export function CommitContent({ home, addr, oid }: { home: RepoHome; addr: RepoAddress; oid: string }): JSX.Element {
  if (!oid) return <EmptyState icon={GitCommit} title="No commit addressed" body="Add &oid= to the URL." />
  return (
    <BrowseBoundary repo={home.repo}>
      {(reader) => <Body reader={reader} oid={oid} addr={addr} />}
    </BrowseBoundary>
  )
}

function Body({ reader, oid, addr }: { reader: BrowseReader; oid: string; addr: RepoAddress }): JSX.Element {
  const { data, loading, error, reload } = useAsync(() => loadCommitChanges(reader, oid), [oid])
  const sides = useMemo<DiffSides>(() => ({ base: reader, head: reader }), [reader])
  if (loading) return <LoadingBlock label="Reconstructing commit" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />

  const { commit, changes, truncated } = data
  const body = commit.message.split('\n').slice(1).join('\n').trim()

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-750 dark:bg-anvil-900">
        <h1 className="text-prose font-semibold">{commitSubject(commit.message) || '(no message)'}</h1>
        {body ? <pre className="mt-2 whitespace-pre-wrap font-sans text-dense text-anvil-600 dark:text-anvil-300">{body}</pre> : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400">
          <span className="font-medium text-anvil-700 dark:text-anvil-200">{commit.author.name || 'unknown'}</span>
          <span>committed {timeAgo(commit.committer.when)} · {formatDate(commit.committer.when)}</span>
          <span className="flex items-center gap-1">commit <Oid value={oid} chars={9} /></span>
          {commit.parents.map((p) => (
            <Link key={p} href={repoHref('/repo/commit', addr, { oid: p })} className="flex items-center gap-1 hover:text-forge-600">
              parent <Oid value={p} chars={7} copyable={false} />
            </Link>
          ))}
        </div>
        {commit.parents.length > 1 ? (
          <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
            Merge commit — changes are shown against the first parent.
          </p>
        ) : null}
      </div>

      {changes.length === 0 && !truncated ? (
        <EmptyState title="No file changes" body="This commit touches no tree paths (e.g. a merge with no diff to its first parent)." />
      ) : (
        <DiffView
          key={oid}
          sides={sides}
          changes={changes}
          truncated={truncated}
          fileHref={(path) => repoHref('/repo/blob', addr, { path })}
        />
      )}
    </div>
  )
}
