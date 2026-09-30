'use client'

/**
 * TreeContent — a directory listing at an arbitrary path (browse plane, ranged reads), with the
 * last-commit column the repo home has (from the history index, else a walk), and Go to file.
 */

import { useCallback, useMemo } from 'react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import { readTree, selectedTip, selectRef, treeAtPath, type TreeEntry } from '@/lib/view'
import { rootTreeOf, type PeeledTip } from '@/lib/view/tip'
import { repoKey, type RepoRef } from '@/lib/repo'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { ReadErrorState, ResolvedTip } from '@/components/repo/resolved-tip'
import { FileList } from '@/components/repo/file-list'
import { GoToFile } from '@/components/repo/go-to-file'
import { CommitCell, SearchOlderHistory, useLastCommits } from '@/components/repo/commit-column'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
import { PathActions } from '@/components/repo/path-actions'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { EmptyState, LoadingBlock } from '@/components/ui/states'
import type { RepoAddress } from '@/hooks/use-query-param'
import { pinnedHref, usePermalinkKey } from '@/components/repo/permalink'
import { FolderOpen } from 'lucide-react'

async function loadDir(reader: BrowseReader, tip: PeeledTip, path: string): Promise<TreeEntry[]> {
  const tree = await rootTreeOf(reader, tip)
  return path ? treeAtPath(reader, tree, path) : readTree(reader, tree)
}

export function TreeContent({
  home,
  addr,
  path,
  refParam = '',
}: {
  home: RepoHome
  addr: RepoAddress
  path: string
  refParam?: string
}): JSX.Element {
  const selected = selectRef(home.branches, home.tags, home.defaultBranch, refParam)
  const tipOid = selectedTip(selected)
  if (refParam && !selected.ref && !selected.pinned) {
    return <RefNotFoundState addr={addr} refParam={refParam} defaultBranch={home.defaultBranch} />
  }
  // An enumerated ref with no tip was deleted; only a ref with no entry at all is "empty".
  if (!tipOid && selected.ref) {
    return <RefDeletedState addr={addr} name={selected.name} defaultBranch={home.defaultBranch} />
  }
  if (!tipOid) {
    return <EmptyState icon={FolderOpen} title="Empty repo" body={`No commits on ${selected.name}, so no tree to browse.`} />
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher home={home} addr={addr} current={selected} path={path} />
        <PathBreadcrumb addr={addr} path={path} refParam={refParam} />
        {path ? <PathActions addr={addr} path={path} refParam={refParam} show={['history']} /> : null}
      </div>
      <BrowseBoundary repo={home.repo} addr={addr}>
        {(reader, retry) => (
          <ResolvedTip reader={reader} retry={retry} repo={home.repo} tip={tipOid} pinned={selected.pinned !== undefined} name={selected.name} addr={addr} refParam={refParam} accepts="tree" label="Reading tree">
            {(tip) => <DirBody reader={reader} retry={retry} tip={tip} path={path} addr={addr} refParam={refParam} repo={home.repo} />}
          </ResolvedTip>
        )}
      </BrowseBoundary>
    </div>
  )
}

function DirBody({
  reader,
  retry,
  tip,
  path,
  addr,
  refParam,
  repo,
}: {
  reader: BrowseReader
  retry: () => void
  tip: PeeledTip
  path: string
  addr: RepoAddress
  refParam: string
  repo: RepoRef
}): JSX.Element {
  const { data, loading, error, cause } = useAsync(() => loadDir(reader, tip, path), [tip.oid, path])
  // A tag of a tree pins to the tree itself: `?ref=` takes commits only, so it keeps its name.
  usePermalinkKey(tip.type === 'commit' ? pinnedHref(addr, 'tree', tip.oid, path, repo.visibility === 'private') : null)
  // The commit column needs a commit's history: a tag of a tree has none, so it has no column.
  const names = useMemo(() => (data === null || tip.type !== 'commit' ? null : data.map((e) => e.name)), [data, tip.type])
  const lastCommits = useLastCommits(reader, tip.oid, path, names)
  const rootTree = useCallback(() => rootTreeOf(reader, tip), [reader, tip])
  if (loading) return <LoadingBlock label="Reading tree" />
  // A missing path is deterministic (common right after a ref switch) — no point retrying.
  if (error?.includes('path not found')) {
    return <EmptyState icon={FolderOpen} title="Directory not found on this ref" body={`${path} does not exist here. Pick another branch or tag, or browse from the repo root.`} />
  }
  if (error) return <ReadErrorState cause={cause} retry={retry} addr={addr} repo={repo} />
  if (!data) return <LoadingBlock />
  return (
    <div className="space-y-4">
      {/* GitHub offers Go to file on every directory, not only the root (QW-028). */}
      <div className="flex justify-end">
        <GoToFile reader={reader} repoKey={repoKey(repo)} tipOid={tip.oid} rootTree={rootTree} addr={addr} refParam={refParam} />
      </div>
      <FileList
        entries={data}
        addr={addr}
        basePath={path}
        refParam={refParam}
        {...(tip.type === 'commit'
          ? { commitColumn: (name: string) => <CommitCell commit={lastCommits.found.get(name)} column={lastCommits} addr={addr} /> }
          : {})}
      />
      {tip.type === 'commit' ? <SearchOlderHistory column={lastCommits} /> : null}
    </div>
  )
}
