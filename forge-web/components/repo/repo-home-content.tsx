'use client'

/**
 * RepoHomeContent — the code tab landing: the root tree (browse plane) + the rendered README.
 * Reads are size-independent (locator ranged object reads). An unborn default branch shows the
 * empty-repo invitation; a repo without browse artifacts degrades via {@link BrowseBoundary}.
 */

import { FileText, Rocket } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome, SelectedRef } from '@/lib/view'
import {
  commitRootTree,
  decodeTextBlob,
  pickReadme,
  readBlob,
  readTree,
  selectRef,
  tipOidOf,
  type TreeEntry,
} from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { FileList } from '@/components/repo/file-list'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { MarkdownView } from '@/components/markdown-view'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { Oid } from '@/components/ui/oid'
import type { RepoAddress } from '@/hooks/use-query-param'

interface RootView {
  readonly entries: TreeEntry[]
  readonly readme: string | null
  readonly readmeName: string | null
}

async function loadRoot(reader: BrowseReader, tipOid: string): Promise<RootView> {
  const { tree } = await commitRootTree(reader, tipOid)
  const entries = await readTree(reader, tree)
  const readmeEntry = pickReadme(entries)
  let readme: string | null = null
  let readmeName: string | null = null
  if (readmeEntry) {
    try {
      const bytes = await readBlob(reader, readmeEntry.oid)
      readme = decodeTextBlob(bytes)
      readmeName = readmeEntry.name
    } catch {
      readme = null
    }
  }
  return { entries, readme, readmeName }
}

export function RepoHomeContent({
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
  // An enumerated ref with no tip was deleted (null-oid update) — even the default branch.
  // Only a ref with no entry at all (fresh repo) gets the empty-repo invitation below.
  if (!tipOid && selected.ref) {
    return <RefDeletedState addr={addr} name={selected.name} defaultBranch={home.defaultBranch} />
  }

  if (!tipOid) {
    return (
      <EmptyState
        icon={Rocket}
        title="This repo has no commits yet"
        body={`Nothing on ${selected.name}. Push your first commit with the git-remote-dash helper to bring it to life.`}
      />
    )
  }

  return (
    <BrowseBoundary repo={home.repo}>
      {(reader) => (
        <RootBody reader={reader} tipOid={tipOid} home={home} addr={addr} selected={selected} refParam={refParam} />
      )}
    </BrowseBoundary>
  )
}

function RootBody({
  reader,
  tipOid,
  home,
  addr,
  selected,
  refParam,
}: {
  reader: BrowseReader
  tipOid: string
  home: RepoHome
  addr: RepoAddress
  selected: SelectedRef
  refParam: string
}): JSX.Element {
  const { data, loading, error, reload } = useAsync(() => loadRoot(reader, tipOid), [tipOid])

  if (loading) return <LoadingBlock label="Reading root tree" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-dense text-anvil-500 dark:text-anvil-400">
        <RefSwitcher home={home} addr={addr} current={selected} />
        <span aria-hidden>·</span>
        <Oid value={tipOid} />
      </div>

      <FileList entries={data.entries} addr={addr} basePath="" refParam={refParam} />

      {data.readme ? (
        <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense font-medium dark:border-anvil-800 dark:bg-anvil-900">
            <FileText className="h-3.5 w-3.5 text-anvil-400" aria-hidden />
            {data.readmeName}
          </div>
          <div className="px-5 py-4">
            {/\.(md|markdown)$/i.test(data.readmeName ?? '') ? (
              <MarkdownView source={data.readme} />
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-anvil-700 dark:text-anvil-200">
                {data.readme}
              </pre>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
