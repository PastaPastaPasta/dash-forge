'use client'

/**
 * RepoHomeContent — the Code tab landing (`ux-dx-spec.md` §5.3): the ref bar (branch switcher,
 * `n commits`, Go to file), the root file list with a lazily loaded commit column, and the
 * README. Reads are size-independent (locator ranged object reads); `flatIndex` is never
 * loaded here ({@link GoToFile} lists the files from the history index, then a walk). A repo with no refs shows the empty state (§5.5); a private repo the viewer
 * cannot decrypt never reaches here (the scaffold shows `PrivateRepoState`); unreadable storage degrades via
 * {@link BrowseBoundary}.
 */

import { useCallback, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { AlertTriangle, FileText, GitCommit, Rocket } from 'lucide-react'
import { CopyRow } from '@/components/ui/copy-row'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { dashRange, PUSH_COST_DASH } from '@/lib/sdk/cost'
import { repoCommands, shellWord } from '@/lib/view/repo-commands'
import type { BrowseReader } from '@/lib/browse'
import { loadRepoFacts } from '@/lib/view/repo-facts'
import { repoKey } from '@/lib/repo'
import type { RepoHome, SelectedRef } from '@/lib/view'
import {
  commitRootTree,
  decodeTextBlob,
  pickReadme,
  readBlob,
  readTree,
  selectRef,
  selectedTip,
  type TreeEntry,
} from '@/lib/view'
import { historyWalker } from '@/lib/view/commit-log'
import {
  CommitCell,
  commitCountLabel,
  commitCountTitle,
  countWithHistory,
  SearchOlderHistory,
  useLastCommits,
} from '@/components/repo/commit-column'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { ResolvedTip } from '@/components/repo/resolved-tip'
import { StorageUnreachableCard } from '@/components/repo/storage-unreachable'
import { PackUnavailableError, unavailableOf } from '@/lib/view/browse-source'
import { FileList } from '@/components/repo/file-list'
import { LatestCommit } from '@/components/repo/latest-commit'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { MarkdownView, type MarkdownRepoContext } from '@/components/markdown-view'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { GoToFile } from '@/components/repo/go-to-file'
import { Oid } from '@/components/ui/oid'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { pinnedHref, usePermalinkKey } from '@/components/repo/permalink'
import { ForkSyncBar } from '@/components/repo/fork-sync'

/** The ref bar counts at most this many commits (one read each), then shows `100+`. */
const HOME_COMMIT_COUNT_CAP = 100

interface RootView {
  readonly tree: string
  readonly entries: TreeEntry[]
}

/** The root listing: the list paints as soon as it is read, before the README and the commit column. */
async function loadRoot(reader: BrowseReader, tipOid: string): Promise<RootView> {
  const { tree } = await commitRootTree(reader, tipOid)
  return { tree, entries: await readTree(reader, tree) }
}

/** The README shown under the list, or null (none, or unreadable: the list still stands). */
async function loadReadme(reader: BrowseReader, entries: readonly TreeEntry[]): Promise<{ name: string; text: string } | null> {
  const entry = pickReadme(entries)
  if (!entry) return null
  try {
    const text = decodeTextBlob(await readBlob(reader, entry.oid))
    return text === null ? null : { name: entry.name, text }
  } catch {
    return null
  }
}

export function RepoHomeContent({
  home,
  addr,
  refParam = '',
  reload,
}: {
  home: RepoHome
  addr: RepoAddress
  refParam?: string
  /** Re-read the repo home (after this page moved a branch: a fork's sync). */
  reload?: () => void
}): JSX.Element {

  const selected = selectRef(home.branches, home.tags, home.defaultBranch, refParam)
  if (refParam && !selected.ref && !selected.pinned) {
    return <RefNotFoundState addr={addr} refParam={refParam} defaultBranch={home.defaultBranch} />
  }
  const tipOid = selectedTip(selected)
  // An enumerated ref with no tip was deleted (null-oid update), even the default branch.
  // Only a ref with no entry at all (fresh repo) gets the empty-repo invitation below.
  if (!tipOid && selected.ref) {
    return <RefDeletedState addr={addr} name={selected.name} defaultBranch={home.defaultBranch} />
  }

  if (!tipOid) return <EmptyRepoState home={home} addr={addr} branch={selected.name} />

  return (
    <BrowseBoundary repo={home.repo} addr={addr}>
      {(reader, retry) => (
        // An annotated tag (a release) is peeled to its commit first (L-01): the listing, the
        // commit count and the commit column all key on the commit.
        <ResolvedTip reader={reader} retry={retry} repo={home.repo} tip={tipOid} pinned={selected.pinned !== undefined} name={selected.name} addr={addr} refParam={refParam} accepts="commit" label="Reading root tree">
          {(tip) => <RootBody reader={reader} retry={retry} tipOid={tip.oid} home={home} addr={addr} selected={selected} refParam={refParam} reloadHome={reload} />}
        </ResolvedTip>
      )}
    </BrowseBoundary>
  )
}

function RootBody({
  reader,
  retry,
  tipOid,
  home,
  addr,
  selected,
  refParam,
  reloadHome,
}: {
  reader: BrowseReader
  /** Re-resolve the browse context ({@link BrowseBoundary}): a tip newer than the reader (L-09). */
  retry: () => void
  tipOid: string
  home: RepoHome
  addr: RepoAddress
  selected: SelectedRef
  refParam: string
  reloadHome?: () => void
}): JSX.Element {
  const { data, loading, error, cause, reload } = useAsync(() => loadRoot(reader, tipOid), [tipOid])
  // `y` pins the home to this commit (README and all), as GitHub's `/tree/<oid>` does.
  usePermalinkKey(pinnedHref(addr, 'home', tipOid, '', home.repo.visibility === 'private'))
  // The README, the commit column and the count load after the list paints and never block it.
  const names = useMemo(() => (data === null ? null : data.entries.map((e) => e.name)), [data])
  const readme = useAsync(() => loadReadme(reader, data?.entries ?? []), [data?.tree ?? ''], { enabled: data !== null })
  // One read-ahead walker for both walks of the history, so they share its blocks.
  // Keyed to the tip too: a new tip's walk starts with an empty read-ahead cache.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const walker = useMemo(() => historyWalker(reader), [reader, tipOid])
  const lastCommits = useLastCommits(reader, tipOid, '', names, walker)
  const commits = useAsync(
    (signal) => countWithHistory(reader, tipOid, HOME_COMMIT_COUNT_CAP, { walker, signal }),
    [tipOid],
    { enabled: data !== null },
  )
  const rootTreeOf = useCallback(() => Promise.resolve(data?.tree ?? ''), [data?.tree])
  const readmeRepo = useMemo<MarkdownRepoContext>(() => ({ addr, refParam, dir: '', reader, tipOid }), [addr, refParam, reader, tipOid])
  // The About card's LICENSE and language bar (F-5): worked out only once everything the page
  // shows has settled (list, README, commit count and column), so they never delay it.
  const key = repoKey(home.repo)
  // The count settles when it fails too (it would never have data): the facts do not wait on it.
  const settled = data !== null && !readme.loading && !commits.loading && lastCommits.done
  useEffect(() => {
    if (!settled || data === null) return
    const stop = new AbortController()
    void loadRepoFacts(key, tipOid, reader, data.tree, data.entries, stop.signal).catch(() => undefined)
    return () => stop.abort()
  }, [settled, key, tipOid, reader, data])

  if (loading && !data) return <LoadingBlock label="Reading root tree" />
  if (cause instanceof PackUnavailableError) {
    // An indexed repo whose storage stopped answering: the same card as the fallback clone's.
    return <StorageUnreachableCard repo={home.repo} addr={addr} packs={[unavailableOf(cause)]} retry={reload} />
  }
  if (error) return <ErrorState message={error} onRetry={retry} />
  if (!data) return <LoadingBlock />

  const commitsHref = repoHref('/repo/commits', addr, refParam ? { ref: refParam } : {})
  // The README's relative links and images resolve against the repo root at this commit.
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-dense text-anvil-500 dark:text-anvil-400">
        <RefSwitcher home={home} addr={addr} current={selected} />
        <Link
          href={commitsHref}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-anvil-700 hover:bg-anvil-100 coarse:min-h-11 dark:text-anvil-200 dark:hover:bg-anvil-800"
          data-testid="commit-count"
          title={commitCountTitle(commits.data)}
        >
          <GitCommit className="h-3.5 w-3.5" aria-hidden />
          {commitCountLabel(commits.data)}
        </Link>
        <Oid value={tipOid} />
        <GoToFile reader={reader} repoKey={key} tipOid={tipOid} rootTree={rootTreeOf} addr={addr} refParam={refParam} className="ml-auto" />
      </div>

      {/* A fork's default branch against its parent's (GitHub's "Sync fork" bar). The fork's
          own tip: the selected ref's, never a pinned commit's. */}
      {home.v2.forkOf !== null && selected.pinned === undefined && !selected.isTag && selected.name === home.defaultBranch ? (
        <ForkSyncBar home={home} addr={addr} forkReader={reader} forkTip={tipOid} reload={reloadHome} />
      ) : null}

      <FileList
        entries={data.entries}
        addr={addr}
        basePath=""
        refParam={refParam}
        header={<LatestCommit reader={reader} tipOid={tipOid} addr={addr} />}
        commitColumn={(name) => <CommitCell commit={lastCommits.found.get(name)} column={lastCommits} addr={addr} />}
      />
      <SearchOlderHistory column={lastCommits} />

      {readme.data ? (
        <section aria-label="README" className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense font-medium dark:border-anvil-800 dark:bg-anvil-900">
            <FileText className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            {readme.data.name}
          </div>
          <div className="px-5 py-4">
            {/\.(md|markdown)$/i.test(readme.data.name) ? (
              <MarkdownView source={readme.data.text} images="auto" repo={readmeRepo} />
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-anvil-700 dark:text-anvil-200">
                {readme.data.text}
              </pre>
            )}
          </div>
        </section>
      ) : readme.loading ? (
        <LoadingBlock label="Reading README" />
      ) : null}
    </div>
  )
}

/**
 * The empty-repository state (`ux-dx-spec.md` §5.5): the commands that push an existing
 * repository, or start from scratch, and where the bytes will go.
 */
function EmptyRepoState({ home, addr, branch }: { home: RepoHome; addr: RepoAddress; branch: string }): JSX.Element {
  const cmd = repoCommands(addr.owner, addr.name)
  const configured = home.backend.kind !== 'platform' || home.backend.uris.length > 0
  return (
    <section
      aria-label="Empty repository"
      className="rounded-lg border border-anvil-200 bg-white p-5 dark:border-anvil-750 dark:bg-anvil-900"
    >
      <div className="mb-4 flex items-center gap-2">
        <Rocket className="h-5 w-5 text-fg-muted" aria-hidden />
        <h2 className="text-prose">
          <span className="font-mono">
            {addr.owner.length > 20 ? `${addr.owner.slice(0, 8)}…` : addr.owner}/{home.repo.name || addr.name}
          </span>{' '}
          is empty.
        </h2>
      </div>
      <h3 className="mb-1.5 text-dense font-medium">Push an existing repository</h3>
      <CopyRow text={cmd.remoteAdd} label="Copy the remote add command" />
      <CopyRow text={cmd.setNetwork} label="Copy the network setting" />
      <CopyRow text={`git push -u origin ${shellWord(branch.replace(/^refs\/heads\//, ''))}`} label="Copy the push command" />
      <h3 className="mb-1.5 mt-4 text-dense font-medium">Or start from scratch</h3>
      <CopyRow text={`${cmd.dgClone} && cd ${shellWord(addr.name)}`} label="Copy the clone command" />
      <p className="mt-2 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="empty-repo-network">
        This repository is on <span className="font-mono">{ACTIVE_NETWORK.key}</span>: the commands set that in the
        repository&apos;s git config, so a later <span className="font-mono">git push</span> goes there.
      </p>
      <p className="mt-4 text-[12px] text-anvil-600 dark:text-anvil-300">
        Storage: packs go to <span className="font-mono">{configured ? home.backend.kind : 'Platform'}</span>
        {configured
          ? ` (set by the owner) · Platform: manifest + refs only, ~${dashRange(PUSH_COST_DASH.byo)} DASH per push`
          : ` · a small push ≈ ${dashRange(PUSH_COST_DASH.platform)} DASH with packs on Platform (${dashRange(PUSH_COST_DASH.byo)} with your own storage)`}
      </p>
      <p className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-300">
        No git-remote-dash yet?{' '}
        <a
          href="https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/INSTALL.md"
          target="_blank"
          rel="noreferrer noopener"
          className="hit-area text-forge-700 underline dark:text-forge-400"
        >
          Install →
        </a>
      </p>
      {!configured ? (
        // Touch: far enough below Install that the two links' 44 px hit areas do not overlap (QW3-060).
        <p role="note" className="mt-3 flex items-start gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-[12px] coarse:mt-6 text-anvil-700 dark:text-anvil-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
          <span>
            No storage configured: pushes will be stored on Platform at ~{PUSH_COST_DASH.perMib} DASH/MiB.{' '}
            <Link href="/settings/storage/" className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
              Configure storage →
            </Link>
          </span>
        </p>
      ) : null}
    </section>
  )
}
