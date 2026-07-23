'use client'

/**
 * CommitContent — a single commit: metadata + the file-level change set (browse-plane tree diff
 * vs first parent). Each changed path links to its blob. Line-level diffs are a follow-up; the
 * change set + verified blob content is the M3 surface.
 */

import Link from 'next/link'
import { FileDiff, GitCommit } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { CommitObject, FileChange, RepoHome } from '@/lib/view'
import { commitSubject, diffTrees, formatDate, parseCommit, timeAgo } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

interface CommitView {
  readonly commit: CommitObject
  readonly changes: FileChange[]
}

async function loadCommit(reader: BrowseReader, oid: string): Promise<CommitView> {
  const obj = await reader.readObject(oid)
  if (obj.type !== 'commit') throw new Error(`${oid.slice(0, 8)} is not a commit`)
  const commit = parseCommit(obj.bytes)
  let parentTree: string | null = null
  if (commit.parents[0]) {
    const p = await reader.readObject(commit.parents[0])
    if (p.type === 'commit') parentTree = parseCommit(p.bytes).tree
  }
  const changes = await diffTrees(reader, parentTree, commit.tree)
  return { commit, changes }
}

const STATUS_META: Record<FileChange['status'], { label: string; klass: string }> = {
  added: { label: 'A', klass: 'text-verify' },
  modified: { label: 'M', klass: 'text-caution' },
  deleted: { label: 'D', klass: 'text-danger' },
}

export function CommitContent({ home, addr, oid }: { home: RepoHome; addr: RepoAddress; oid: string }): JSX.Element {
  if (!oid) return <EmptyState icon={GitCommit} title="No commit addressed" body="Add &oid= to the URL." />
  return (
    <BrowseBoundary repo={home.repo}>
      {(reader) => <Body reader={reader} oid={oid} addr={addr} />}
    </BrowseBoundary>
  )
}

function Body({ reader, oid, addr }: { reader: BrowseReader; oid: string; addr: RepoAddress }): JSX.Element {
  const { data, loading, error, reload } = useAsync(() => loadCommit(reader, oid), [oid])
  if (loading) return <LoadingBlock label="Reconstructing commit" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />

  const { commit, changes } = data
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
      </div>

      <div className="flex items-center gap-2 text-dense text-anvil-500 dark:text-anvil-400">
        <FileDiff className="h-3.5 w-3.5" aria-hidden />
        {changes.length} file{changes.length === 1 ? '' : 's'} changed
      </div>

      {changes.length === 0 ? (
        <EmptyState title="No file changes" body="This commit touches no tree paths (e.g. a merge with no diff to its first parent)." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          {changes.map((c) => {
            const meta = STATUS_META[c.status]
            return (
              <div key={c.path} className="flex items-center gap-3 border-b border-anvil-100 px-3 py-2 text-dense last:border-b-0 dark:border-anvil-850">
                <span className={cn('w-4 shrink-0 text-center font-mono font-semibold', meta.klass)} title={c.status}>
                  {meta.label}
                </span>
                {c.status === 'deleted' ? (
                  <span className="min-w-0 flex-1 truncate font-mono text-anvil-500 line-through dark:text-anvil-400">{c.path}</span>
                ) : (
                  <Link href={repoHref('/repo/blob', addr, { path: c.path })} className="min-w-0 flex-1 truncate font-mono hover:text-forge-600 dark:hover:text-forge-400">
                    {c.path}
                  </Link>
                )}
                <Oid value={c.oid} chars={7} copyable={false} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
