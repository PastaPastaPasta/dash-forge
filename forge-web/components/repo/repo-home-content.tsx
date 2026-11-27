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
import { FileText, GitBranch, GitCommit, Rocket } from 'lucide-react'
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
  isLive,
  pickReadme,
  readBlob,
  readTree,
  refParamFor,
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
import { useAuth } from '@/contexts/auth-context'
import { useViewerRole } from '@/hooks/use-repo-chrome'
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
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { pinnedHref, usePermalinkKey } from '@/components/repo/permalink'
import { ForkSyncBar } from '@/components/repo/fork-sync'
import { RecentPushBanner } from '@/components/repo/recent-push-banner'
import { ownerLabel } from '@/lib/page-title'
import { BeingMadePublicState } from '@/components/repo/conversion-status'
import { FiatNote } from '@/components/ui/fiat-note'
import { DOCS } from '@/lib/docs-links'
import { PhoneCloneBox } from '@/components/repo/phone-clone'

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

  // The default branch was never pushed, but other refs were (a repo pushed only to feature
  // branches): never call it empty; list what it does have.
  const liveRefs = [...home.branches, ...home.tags].filter(isLive)
  if (!tipOid && !refParam && liveRefs.length > 0) return <BeingMadePublicState home={home} empty={<DefaultBranchUnbornState home={home} addr={addr} />} loading={<LoadingBlock label="Reading this repo" />} />

  // A repo being made public has no public branch until its code is published: say so to everyone
  // rather than invite them to push to an empty repo (DESIGN §4.10).
  if (!tipOid) return <BeingMadePublicState home={home} empty={<EmptyRepoState home={home} addr={addr} branch={selected.name} />} loading={<LoadingBlock label="Reading this repo" />} />

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
      <RecentPushBanner home={home} addr={addr} />
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
      <PhoneCloneBox home={home} addr={addr} selected={selected} />

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

/** How many branches the unborn-default state links before pointing at the Branches page. */
const UNBORN_DEFAULT_BRANCHES = 6

/**
 * A repo whose default branch has no commit while other branches or tags do: its refs, to open one.
 */
function DefaultBranchUnbornState({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const branches = home.branches.filter(isLive).map((b) => b.refName.replace(/^refs\/heads\//, ''))
  const tags = home.tags.filter(isLive).length
  const shown = branches.slice(0, UNBORN_DEFAULT_BRANCHES)
  const counted = [branches.length > 0 ? `${branches.length} ${branches.length === 1 ? 'branch' : 'branches'}` : null, tags > 0 ? `${tags} ${tags === 1 ? 'tag' : 'tags'}` : null].filter((x) => x !== null).join(' and ')
  return (
    <section
      aria-labelledby="unborn-default-heading"
      className="rounded-lg border border-anvil-200 bg-white p-5 dark:border-anvil-750 dark:bg-anvil-900"
      data-testid="default-branch-unborn"
    >
      <div className="mb-2 flex items-center gap-2">
        <GitBranch className="h-5 w-5 text-fg-muted" aria-hidden />
        <h2 id="unborn-default-heading" className="text-prose">
          The default branch <span className="font-mono">{home.defaultBranch}</span> has no commits yet
        </h2>
      </div>
      <p className="text-dense text-anvil-600 dark:text-anvil-300">
        This repo has {counted}. Pick one to browse its code.
      </p>
      {shown.length > 0 ? (
        <ul aria-label="Branches" className="mt-3 flex flex-wrap gap-x-2 gap-y-3 coarse:gap-y-5">
          {shown.map((name) => (
            <li key={name}>
              <Link
                href={repoHref('/repo', addr, { ref: refParamFor(name, false, home.defaultBranch) })}
                className="hit-area inline-flex max-w-full items-center gap-1 rounded-md border border-anvil-200 px-2 py-1 font-mono text-[12px] text-forge-700 hover:bg-anvil-50 dark:border-anvil-750 dark:text-forge-400 dark:hover:bg-anvil-850"
              >
                <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{name}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 flex flex-wrap gap-x-4 text-dense">
        {branches.length > 0 ? (
          <Link href={repoHref('/repo/branches', addr)} className="hit-area text-forge-700 underline dark:text-forge-400">
            All branches →
          </Link>
        ) : null}
        {tags > 0 ? (
          <Link href={repoHref('/repo/tags', addr)} className="hit-area text-forge-700 underline dark:text-forge-400">
            Tags →
          </Link>
        ) : null}
      </p>
    </section>
  )
}

/** Whether the viewer pushes here, so its storage warning is theirs: the owner, a maintainer or a writer (false until the role is read). */
function useCanConfigureStorage(home: RepoHome): boolean {
  const { identity } = useAuth()
  const { role } = useViewerRole(home.repo)
  return identity !== null && (identity === home.repo.ownerId || role === 'maintainer' || role === 'writer')
}

function EmptyRepoState({ home, addr, branch }: { home: RepoHome; addr: RepoAddress; branch: string }): JSX.Element {
  const cmd = repoCommands(addr.owner, addr.name)
  const configured = home.backend.kind !== 'platform' || home.backend.uris.length > 0
  const canConfigure = useCanConfigureStorage(home)
  const branchName = shellWord(branch.replace(/^refs\/heads\//, ''))
  const repoName = home.repo.name || addr.name
  const note = 'text-[12px] text-anvil-600 dark:text-anvil-300'
  return (
    <section
      aria-label="Empty repository"
      className="space-y-4 rounded-lg border border-anvil-200 bg-white p-5 dark:border-anvil-750 dark:bg-anvil-900"
    >
      <div>
        <div className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-fg-muted" aria-hidden />
          <h2 className="text-prose">
            <span className="font-mono">
              {ownerLabel(addr.owner)}/{repoName}
            </span>{' '}
            is empty.
          </h2>
        </div>
        <p className={`mt-1 ${note}`}>
          {canConfigure ? 'Push your code to get started.' : 'Nothing has been pushed yet.'}
        </p>
      </div>

      <div className="space-y-1.5">
        <h3 className="text-dense font-medium">Push an existing repository</h3>
        <CopyRow text={cmd.remoteAdd} label="Copy the remote add command" />
        <CopyRow text={cmd.setNetwork} label="Copy the network setting" />
        <CopyRow text={`git push -u origin ${branchName}`} label="Copy the push command" />
      </div>

      <div className="space-y-2 border-t border-anvil-100 pt-3 dark:border-anvil-850">
        <details className="text-dense">
          <summary className="hit-area cursor-pointer select-none font-medium text-anvil-700 hover:text-anvil-900 dark:text-anvil-200 dark:hover:text-anvil-50">
            Start from scratch
          </summary>
          <div className="mt-2 space-y-1.5">
            <CopyRow text={`${cmd.dgClone} && cd ${shellWord(addr.name)}`} label="Copy the clone command" />
            <CopyRow
              text={`echo ${shellWord(`# ${repoName}`)} > README.md && git add README.md && git commit -m 'First commit' && git push -u origin HEAD:${branchName}`}
              label="Copy the first commit and push commands"
            />
          </div>
        </details>

        <details className="text-dense">
          <summary className="hit-area cursor-pointer select-none font-medium text-anvil-700 hover:text-anvil-900 dark:text-anvil-200 dark:hover:text-anvil-50">
            First time? Install tools &amp; sign in
          </summary>
          <div className="mt-2 space-y-2">
            <p className={note}>
              Needs <span className="font-mono">git-remote-dash</span> and <span className="font-mono">dg</span>.{' '}
              <Link href={DOCS.install} className="hit-area text-forge-700 underline dark:text-forge-400">
                Install →
              </Link>
            </p>
            <CopyRow text={cmd.authLogin} label="Copy the sign-in command" />
            <p className={note} data-testid="empty-repo-sign-in">
              Scan the QR code with {ACTIVE_NETWORK.network === 'testnet' ? "DashPay for Android's testnet build" : 'DashPay for Android or Dash Wallet for iOS'}, or use your 12 words with{' '}
              <span className="font-mono">{cmd.authLoginWords}</span>. New identity: <span className="font-mono">{cmd.authNew}</span>.
            </p>
          </div>
        </details>

        <details className="text-dense">
          <summary className="hit-area cursor-pointer select-none font-medium text-anvil-700 hover:text-anvil-900 dark:text-anvil-200 dark:hover:text-anvil-50">
            Storage &amp; push cost
          </summary>
          <div className={`mt-2 space-y-1.5 ${note}`}>
            <p data-testid="empty-repo-network">
              Network: <span className="font-mono">{ACTIVE_NETWORK.key}</span>.
            </p>
            <p>
              Storage: packs go to <span className="font-mono">{configured ? home.backend.kind : 'Platform'}</span>
              {configured
                ? <> · ~{dashRange(PUSH_COST_DASH.byo)} DASH per push<FiatNote dash={PUSH_COST_DASH.byo.max} range={PUSH_COST_DASH.byo.min} /></>
                : <> · a small push ≈ {dashRange(PUSH_COST_DASH.platform)} DASH<FiatNote dash={PUSH_COST_DASH.platform.max} range={PUSH_COST_DASH.platform.min} /> ({dashRange(PUSH_COST_DASH.byo)} with your own storage<FiatNote dash={PUSH_COST_DASH.byo.max} range={PUSH_COST_DASH.byo.min} />)</>}
            </p>
          </div>
        </details>
      </div>

      {!configured && canConfigure ? (
        <p className={note}>
          No storage configured (~{PUSH_COST_DASH.perMib} DASH/MiB on Platform<FiatNote dash={PUSH_COST_DASH.perMib} />).{' '}
          <Link href="/settings/storage/" className="hit-area font-medium text-forge-700 underline dark:text-forge-400">
            Configure storage →
          </Link>
        </p>
      ) : null}
    </section>
  )
}
