'use client'

/** CommitsContent — the first-parent commit log (browse plane), newest first. */

import Link from 'next/link'
import { GitCommit } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import { selectRef, tipOidOf, timeAgo, walkLog, type LogEntry } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

export function CommitsContent({
  home,
  addr,
  refParam = '',
}: {
  home: RepoHome
  addr: RepoAddress
  refParam?: string
}): JSX.Element {
  const selected = selectRef(home.branches, home.tags, home.defaultBranch, refParam)
  if (refParam && !selected.ref) {
    return <RefNotFoundState addr={addr} refParam={refParam} defaultBranch={home.defaultBranch} />
  }
  const tipOid = tipOidOf(selected.ref)
  // An enumerated ref with no tip was deleted; only a ref with no entry at all is "empty".
  if (!tipOid && selected.ref) {
    return <RefDeletedState addr={addr} name={selected.name} defaultBranch={home.defaultBranch} />
  }
  if (!tipOid) return <EmptyState icon={GitCommit} title="No commits yet" body={`History appears once the first commit is pushed to ${selected.name}.`} />
  return (
    <div className="space-y-4">
      <RefSwitcher home={home} addr={addr} current={selected} />
      <BrowseBoundary repo={home.repo}>
        {(reader) => <LogBody reader={reader} tipOid={tipOid} addr={addr} />}
      </BrowseBoundary>
    </div>
  )
}

function LogBody({ reader, tipOid, addr }: { reader: BrowseReader; tipOid: string; addr: RepoAddress }): JSX.Element {
  const { data, loading, error, reload } = useAsync(() => walkLog(reader, tipOid, 40), [tipOid])
  if (loading) return <LoadingBlock label="Walking history" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />
  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      {data.map((entry: LogEntry) => (
        <div key={entry.oid} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850">
          <div className="min-w-0 flex-1">
            <Link href={repoHref('/repo/commit', addr, { oid: entry.oid })} className="block truncate text-dense font-medium text-anvil-900 hover:text-forge-600 dark:text-anvil-50 dark:hover:text-forge-400">
              {entry.subject || '(no message)'}
            </Link>
            <div className="mt-0.5 flex items-center gap-2 text-[12px] text-anvil-400">
              <span>{entry.commit.author.name || 'unknown'}</span>
              <span>· {timeAgo(entry.commit.author.when)}</span>
            </div>
          </div>
          <Oid value={entry.oid} chars={7} />
        </div>
      ))}
    </div>
  )
}
