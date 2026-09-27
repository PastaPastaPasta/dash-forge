'use client'

/**
 * RepoHomeContent — the Code tab landing (`ux-dx-spec.md` §5.3): the ref bar (branch switcher,
 * `n commits`, Go to file), the root file list with a lazily loaded commit column, and the
 * README. Reads are size-independent (locator ranged object reads); `flatIndex` is never
 * loaded here. A repo with no refs shows the empty state (§5.5); a private repo the viewer
 * cannot decrypt never reaches here (the scaffold shows `PrivateRepoState`); unreadable storage degrades via
 * {@link BrowseBoundary}.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, FileText, GitCommit, Rocket, Search } from 'lucide-react'
import { CopyRow } from '@/components/ui/copy-row'
import type { BrowseReader } from '@/lib/browse'
import { walkFiles } from '@/lib/view/zip'
import type { RepoHome, SelectedRef } from '@/lib/view'
import {
  commitRootTree,
  decodeTextBlob,
  pickReadme,
  readBlob,
  readTree,
  selectRef,
  timeAgo,
  tipOidOf,
  type TreeEntry,
} from '@/lib/view'
import { countCommits, lastCommitsForDir, type LastCommit } from '@/lib/view/commit-log'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { StorageUnreachableCard } from '@/components/repo/storage-unreachable'
import { PackUnavailableError, unavailableOf } from '@/lib/view/browse-source'
import { FileList } from '@/components/repo/file-list'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { MarkdownView } from '@/components/markdown-view'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { Input } from '@/components/ui/input'
import { Oid } from '@/components/ui/oid'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

/** The ref bar counts at most this many commits (one read each), then shows `100+`. */
const HOME_COMMIT_COUNT_CAP = 100

interface RootView {
  readonly tree: string
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
      readme = decodeTextBlob(await readBlob(reader, readmeEntry.oid))
      readmeName = readmeEntry.name
    } catch {
      readme = null
    }
  }
  return { tree, entries, readme, readmeName }
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
  // An enumerated ref with no tip was deleted (null-oid update), even the default branch.
  // Only a ref with no entry at all (fresh repo) gets the empty-repo invitation below.
  if (!tipOid && selected.ref) {
    return <RefDeletedState addr={addr} name={selected.name} defaultBranch={home.defaultBranch} />
  }

  if (!tipOid) return <EmptyRepoState home={home} addr={addr} branch={selected.name} />

  return (
    <BrowseBoundary repo={home.repo} addr={addr}>
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
  const { data, loading, error, cause, reload } = useAsync(() => loadRoot(reader, tipOid), [tipOid])
  // Both load after the list paints and never block it.
  const names = useMemo(() => (data?.entries ?? []).map((e) => e.name), [data])
  const lastCommits = useAsync(() => lastCommitsForDir(reader, tipOid, '', names), [tipOid, names.join('\0')], {
    enabled: data !== null,
  })
  const commits = useAsync(() => countCommits(reader, tipOid, HOME_COMMIT_COUNT_CAP), [tipOid], { enabled: data !== null })

  if (loading && !data) return <LoadingBlock label="Reading root tree" />
  if (cause instanceof PackUnavailableError) {
    // An indexed repo whose storage stopped answering: the same card as the fallback clone's.
    return <StorageUnreachableCard repo={home.repo} addr={addr} packs={[unavailableOf(cause)]} retry={reload} />
  }
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />

  const commitsHref = repoHref('/repo/commits', addr, refParam ? { ref: refParam } : {})
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-dense text-anvil-500 dark:text-anvil-400">
        <RefSwitcher home={home} addr={addr} current={selected} />
        <Link
          href={commitsHref}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-anvil-700 hover:bg-anvil-100 dark:text-anvil-200 dark:hover:bg-anvil-800"
          data-testid="commit-count"
        >
          <GitCommit className="h-3.5 w-3.5" aria-hidden />
          {commits.data ? `${commits.data.count}${commits.data.capped ? '+' : ''} commits` : 'Commits'}
        </Link>
        <Oid value={tipOid} />
        <GoToFile reader={reader} rootTree={data.tree} addr={addr} refParam={refParam} />
      </div>

      <FileList
        entries={data.entries}
        addr={addr}
        basePath=""
        refParam={refParam}
        commitColumn={(name) => <CommitCell commit={lastCommits.data?.get(name)} loading={lastCommits.loading} addr={addr} />}
      />

      {data.readme ? (
        <section aria-label="README" className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense font-medium dark:border-anvil-800 dark:bg-anvil-900">
            <FileText className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
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
        </section>
      ) : null}
    </div>
  )
}

function CommitCell({ commit, loading, addr }: { commit: LastCommit | undefined; loading: boolean; addr: RepoAddress }): JSX.Element {
  if (commit === undefined) {
    return <span className="text-anvil-500 dark:text-anvil-400">{loading ? '…' : ''}</span>
  }
  return (
    <>
      <Link
        href={repoHref('/repo/commit', addr, { oid: commit.oid })}
        className="min-w-0 flex-1 truncate text-anvil-600 hover:text-forge-800 dark:text-anvil-300 dark:hover:text-forge-400"
      >
        {commit.subject || '(no message)'}
      </Link>
      <span className="shrink-0 tabular-nums text-anvil-500 dark:text-anvil-400">{timeAgo(commit.when)}</span>
    </>
  )
}

/**
 * Go to file: a filename filter over a walk of the shown tree (never `flatIndex`, which home
 * must not load). The walk starts on first focus and stops at {@link GO_TO_FILE_MAX} paths.
 */
const GO_TO_FILE_MAX = 5000

function GoToFile({
  reader,
  rootTree,
  addr,
  refParam,
}: {
  reader: BrowseReader
  rootTree: string
  addr: RepoAddress
  refParam: string
}): JSX.Element {
  const [started, setStarted] = useState(false)
  const [query, setQuery] = useState('')
  const walk = useAsync(() => walkFiles(reader, rootTree, GO_TO_FILE_MAX), [rootTree], { enabled: started })
  const q = query.trim().toLowerCase()
  const hits = q === '' ? [] : (walk.data?.files ?? []).map((f) => f.path).filter((p) => p.toLowerCase().includes(q)).slice(0, 12)
  return (
    <div className="relative ml-auto w-full sm:w-56">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-500 dark:text-anvil-400" aria-hidden />
      <label htmlFor="go-to-file" className="sr-only">
        Go to file
      </label>
      <Input
        id="go-to-file"
        value={query}
        onFocus={() => setStarted(true)}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Go to file"
        className="h-8 py-1 pl-8"
        role="combobox"
        aria-expanded={q !== ''}
        aria-controls="go-to-file-results"
        autoComplete="off"
      />
      {q !== '' ? (
        <ul
          id="go-to-file-results"
          role="listbox"
          className="absolute right-0 z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-anvil-200 bg-white py-1 shadow-lg dark:border-anvil-750 dark:bg-anvil-900 sm:w-80"
        >
          {walk.loading ? <li className="px-3 py-1.5 text-anvil-500 dark:text-anvil-400">Listing files…</li> : null}
          {walk.error ? <li className="px-3 py-1.5 text-danger-700 dark:text-danger-400">{walk.error}</li> : null}
          {!walk.loading && hits.length === 0 ? <li className="px-3 py-1.5 text-anvil-500 dark:text-anvil-400">No matching file.</li> : null}
          {hits.map((p) => (
            <li key={p} role="option" aria-selected={false}>
              <Link
                href={repoHref('/repo/blob', addr, { path: p, ...(refParam ? { ref: refParam } : {}) })}
                className="block truncate px-3 py-1.5 font-mono text-[12px] text-anvil-700 hover:bg-anvil-50 dark:text-anvil-200 dark:hover:bg-anvil-850"
              >
                {p}
              </Link>
            </li>
          ))}
          {walk.data?.truncated ? (
            <li className="px-3 py-1.5 text-[11px] text-anvil-500 dark:text-anvil-400">Searched the first {GO_TO_FILE_MAX} files.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * The empty-repository state (`ux-dx-spec.md` §5.5): the commands that push an existing
 * repository, or start from scratch, and where the bytes will go.
 */
function EmptyRepoState({ home, addr, branch }: { home: RepoHome; addr: RepoAddress; branch: string }): JSX.Element {
  const remote = `dash://${addr.owner}/${addr.name}`
  const configured = home.backend.kind !== 'platform' || home.backend.uris.length > 0
  return (
    <section
      aria-label="Empty repository"
      className="rounded-lg border border-anvil-200 bg-white p-5 dark:border-anvil-750 dark:bg-anvil-900"
    >
      <div className="mb-4 flex items-center gap-2">
        <Rocket className="h-5 w-5 text-forge-500" aria-hidden />
        <h2 className="text-prose">
          <span className="font-mono">
            {addr.owner.length > 20 ? `${addr.owner.slice(0, 8)}…` : addr.owner}/{home.repo.name || addr.name}
          </span>{' '}
          is empty.
        </h2>
      </div>
      <h3 className="mb-1.5 text-dense font-medium">Push an existing repository</h3>
      <CopyRow text={`git remote add origin ${remote}`} />
      <CopyRow text={`git push -u origin ${branch.replace(/^refs\/heads\//, '')}`} />
      <h3 className="mb-1.5 mt-4 text-dense font-medium">Or start from scratch</h3>
      <CopyRow text={`dg repo clone ${addr.owner}/${addr.name} && cd ${addr.name}`} />
      <p className="mt-4 text-[12px] text-anvil-600 dark:text-anvil-300">
        Storage: packs go to <span className="font-mono">{configured ? home.backend.label : 'Platform'}</span>
        {configured ? ' (set by the owner)' : ''} · Platform: manifest + refs only, ~0.0003 DASH per push
      </p>
      <p className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-300">
        No git-remote-dash yet?{' '}
        <a
          href="https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/INSTALL.md"
          target="_blank"
          rel="noreferrer noopener"
          className="text-forge-700 underline dark:text-forge-400"
        >
          Install →
        </a>
      </p>
      {!configured ? (
        <p role="note" className="mt-3 flex items-start gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-[12px] text-anvil-700 dark:text-anvil-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
          <span>
            No storage configured: pushes will be stored on Platform at ~0.28 DASH/MiB.{' '}
            <Link href="/settings/storage" className="font-medium text-forge-700 underline dark:text-forge-400">
              Configure storage →
            </Link>
          </span>
        </p>
      ) : null}
    </section>
  )
}
