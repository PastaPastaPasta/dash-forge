'use client'

/**
 * CompareContent — `/repo/compare?base=<ref>&head=<ref>` (L-30): what `head` has that `base` does
 * not, between any two branches, tags or commits of the repo, as GitHub's `base...head`: the
 * commits (`git log base..head`) and the diff from their merge base (`git diff -M base...head`).
 * Short names work (`?base=v22.0.0&head=develop`); a pair of branches offers "Create pull request".
 * The merge-base search reports how far it got and can be stopped, as on a PR.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState, type FormEvent } from 'react'
import { ArrowLeftRight, GitCompare, GitPullRequest } from 'lucide-react'

import type { BrowseReader } from '@/lib/browse'
import { repoKey } from '@/lib/repo'
import { branchName, plural, selectedTip, selectRef, shortOid, type RepoHome, type SelectedRef } from '@/lib/view'
import { loadComparison } from '@/lib/view/compare'
import { MergeBaseCancelledError } from '@/lib/view/pull-diff'
import { resolveTip } from '@/lib/view/tip'
import { useAsync } from '@/hooks/use-async'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { DiffView } from '@/components/repo/diff-view'
import { CommitList } from '@/components/repo/pull-tabs'
import { ReadErrorState } from '@/components/repo/resolved-tip'
import { Button } from '@/components/ui/button'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { Input } from '@/components/ui/input'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, Spinner } from '@/components/ui/states'
import { TrustPanel } from '@/components/ui/trust-panel'
import { useRepoTrust } from '@/hooks/use-repo-trust'

export function CompareContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const baseGiven = useParam('base')
  const baseParam = baseGiven || home.defaultBranch
  const headParam = useParam('head')
  const base = selectRef(home.branches, home.tags, home.defaultBranch, baseParam)
  const head = headParam ? selectRef(home.branches, home.tags, home.defaultBranch, headParam) : null
  const missing = [base, head].find((s): s is SelectedRef => s !== null && selectedTip(s) === null)
  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="flex items-center gap-2 text-xl">
            <GitCompare className="h-5 w-5 text-anvil-500 dark:text-anvil-400" aria-hidden /> Compare changes
          </h1>
          {/* GitHub's `/owner/name/compare/base...head` (QW-058). */}
          {headParam ? <CopyLinkButton repo={addr} target={{ kind: 'compare', head: headParam, ...(baseGiven ? { base: baseGiven } : {}) }} className="ml-auto" /> : null}
        </div>
        <p className="mt-1 text-dense text-anvil-600 dark:text-anvil-300">
          Pick two branches, tags or commits: this shows what the second has that the first does not, from where their histories meet.
        </p>
      </div>
      <ComparePicker key={`${baseParam}\0${headParam}`} home={home} addr={addr} base={baseParam} head={headParam} />
      {/* The page has no rail (the diff takes the width), so its Verification card sits here,
          collapsed to its one line, as on every other code page (QW2-042). It attests the
          compare side: the ref whose changes are shown. */}
      {head !== null && missing === undefined ? <CompareVerification home={home} selected={head} /> : null}
      {head === null ? null : missing !== undefined ? (
        <EmptyState icon={GitCompare} title="Nothing to compare" body={`No branch, tag or commit named ${missing.name} in ${home.repo.name}.`} />
      ) : (
        <BrowseBoundary repo={home.repo} addr={addr}>
          {(reader, retry) => <Resolve reader={reader} retry={retry} home={home} addr={addr} base={base} head={head} params={[baseParam, headParam]} />}
        </BrowseBoundary>
      )}
    </div>
  )
}

/** The Verification card for the compared refs: a leaf, so a content check re-renders only it. */
function CompareVerification({ home, selected }: { home: RepoHome; selected: SelectedRef }): JSX.Element {
  return <TrustPanel report={useRepoTrust(home, selected)} />
}

/** Two ref fields (branches and tags offered; any commit id accepted), Swap and Compare. */
function ComparePicker({ home, addr, base, head }: { home: RepoHome; addr: RepoAddress; base: string; head: string }): JSX.Element {
  const router = useRouter()
  const [b, setB] = useState(base)
  const [h, setH] = useState(head)
  const go = (nb: string, nh: string): void => router.push(repoHref('/repo/compare', addr, { base: nb.trim(), head: nh.trim() }))
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (b.trim() !== '' && h.trim() !== '') go(b, h)
  }
  const names = [...home.branches.map((r) => branchName(r.refName)), ...home.tags.map((t) => t.refName.replace(/^refs\/tags\//, ''))]
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded-lg border border-anvil-200 p-3 dark:border-anvil-800" aria-label="Refs to compare">
      <datalist id="compare-refs">
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium text-anvil-600 dark:text-anvil-300">
        base
        <Input value={b} onChange={(e) => setB(e.target.value)} list="compare-refs" className="w-56 max-w-full font-mono" aria-label="Base: branch, tag or commit" />
      </label>
      <span className="pb-2 text-anvil-500 dark:text-anvil-400" aria-hidden>
        …
      </span>
      <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium text-anvil-600 dark:text-anvil-300">
        compare
        <Input value={h} onChange={(e) => setH(e.target.value)} list="compare-refs" placeholder="branch, tag or commit" className="w-56 max-w-full font-mono" aria-label="Compare: branch, tag or commit" />
      </label>
      <Button type="submit" variant="primary" disabled={b.trim() === '' || h.trim() === ''}>
        Compare
      </Button>
      <Button type="button" variant="ghost" disabled={b.trim() === '' || h.trim() === ''} onClick={() => go(h, b)} title="Swap base and compare">
        <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden /> Swap
      </Button>
    </form>
  )
}

/** Both sides peeled to commits (a tag names one; a short id resolves), then compared. */
function Resolve({
  reader,
  retry,
  home,
  addr,
  base,
  head,
  params,
}: {
  reader: BrowseReader
  retry: () => void
  home: RepoHome
  addr: RepoAddress
  base: SelectedRef
  head: SelectedRef
  /** The refs as the URL names them (`tags/v1`, a full commit id), for links that keep them. */
  params: readonly [string, string]
}): JSX.Element {
  const key = repoKey(home.repo)
  const baseTip = selectedTip(base) as string
  const headTip = selectedTip(head) as string
  const tips = useAsync(
    () =>
      Promise.all([
        resolveTip(reader, baseTip, { repoKey: key, pinned: base.pinned !== undefined }),
        resolveTip(reader, headTip, { repoKey: key, pinned: head.pinned !== undefined }),
      ]),
    [baseTip, headTip, key],
  )
  if (tips.error !== null) return <ReadErrorState cause={tips.cause} retry={retry} addr={addr} repo={home.repo} />
  if (tips.data === null) return <Progress label="Reading both refs" />
  const [b, h] = tips.data
  const notCommit = ([[b, base], [h, head]] as const).find(([tip]) => tip.type !== 'commit')?.[1]
  if (notCommit !== undefined) return <EmptyState icon={GitCompare} title={`${notCommit.name} is not a commit`} body="Only commits (a branch, a tag of a commit, a commit id) have a history to compare." />
  return <Compared key={`${b.oid}...${h.oid}`} reader={reader} addr={addr} base={base} head={head} params={params} baseOid={b.oid} headOid={h.oid} />
}

function Progress({ label, onStop }: { label: string; onStop?: () => void }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 rounded-lg border border-anvil-200 px-4 py-6 dark:border-anvil-800" data-testid="compare-progress">
      <Spinner label={label} />
      {onStop ? (
        <Button size="sm" variant="ghost" onClick={onStop}>
          Stop
        </Button>
      ) : null}
    </div>
  )
}

function Compared({
  reader,
  addr,
  base,
  head,
  params: [baseParam, headParam],
  baseOid,
  headOid,
}: {
  reader: BrowseReader
  addr: RepoAddress
  base: SelectedRef
  head: SelectedRef
  params: readonly [string, string]
  baseOid: string
  headOid: string
}): JSX.Element {
  const [read, setRead] = useState(0)
  const [searching, setSearching] = useState(true)
  const stop = useRef<AbortController | null>(null)
  const cmp = useAsync(
    (signal) => {
      const c = new AbortController()
      stop.current = c
      signal.addEventListener('abort', () => c.abort())
      setRead(0)
      setSearching(true)
      return loadComparison(reader, baseOid, headOid, {
        signal: c.signal,
        onProgress: (n) => c.signal.aborted || setRead(n),
        onMergeBase: () => c.signal.aborted || setSearching(false),
      })
    },
    [baseOid, headOid],
  )
  if (cmp.error !== null) {
    const stopped = cmp.cause instanceof MergeBaseCancelledError
    return <ErrorState title={stopped ? 'Comparison stopped' : undefined} message={cmp.error} onRetry={cmp.reload} />
  }
  const data = cmp.data
  if (data === null) {
    return searching && read > 0 ? (
      <Progress label={`Finding where the histories meet: ${read.toLocaleString('en-US')} commits read`} onStop={() => stop.current?.abort()} />
    ) : (
      <Progress label={searching ? 'Comparing' : 'Reading the commits and changed files'} />
    )
  }
  if (data.kind === 'identical') return <EmptyState icon={GitCompare} title="Nothing to compare" body={`${base.name} and ${head.name} are the same commit.`} />
  if (data.kind === 'unrelated') return <EmptyState icon={GitCompare} title="Nothing to compare" body={`${base.name} and ${head.name} have entirely different histories.`} />
  if (data.kind === 'up-to-date') {
    return (
      <EmptyState
        icon={GitCompare}
        title="There isn't anything to compare"
        body={`${base.name} is up to date with all commits from ${head.name}.`}
        action={
          <Link href={repoHref('/repo/compare', addr, { base: headParam, head: baseParam })} className="text-dense font-medium text-forge-700 underline underline-offset-2 dark:text-forge-400">
            Compare {head.name}...{base.name} instead
          </Link>
        }
      />
    )
  }
  const { diff, commits, mergeBase } = data
  const commitCount = plural(commits.total ?? `${commits.commits.length}+`, 'commit')
  const branches = base.ref !== undefined && !base.isTag && head.ref !== undefined && !head.isTag && base.ref.refName !== head.ref.refName
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-anvil-200 px-4 py-3 text-dense dark:border-anvil-800" data-testid="compare-summary">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-anvil-600 dark:text-anvil-300">
          <span className="font-medium text-anvil-800 dark:text-anvil-100">{commitCount}</span>
          <span>{plural(diff.truncated ? `${diff.changes.length.toLocaleString('en-US')}+` : diff.changes.length, 'file')} changed</span>
          <span className="flex items-center gap-1 text-[12px]">
            from merge base <Oid value={mergeBase} chars={7} copyable={false} />
          </span>
        </div>
        {branches ? (
          <Link
            href={repoHref('/repo/pulls/new', addr, { base: baseParam, head: headParam })}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-forge-700 px-3 text-dense font-medium text-white hover:bg-forge-800"
            data-testid="compare-create-pr"
          >
            <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> Create pull request
          </Link>
        ) : null}
      </div>
      <details open={commits.commits.length <= 10} className="group">
        <summary className="mb-2 cursor-pointer text-dense font-semibold text-anvil-700 coarse:py-3 dark:text-anvil-200">
          Commits ({commitCount})
        </summary>
        <CommitList commits={commits} addr={addr} allHint={`Clone the repo and run git log ${shortOid(mergeBase)}..${shortOid(headOid)} to see them all.`} />
      </details>
      <DiffView
        key={`${mergeBase}...${headOid}`}
        sides={{ base: reader, head: reader }}
        changes={diff.changes}
        truncated={diff.truncated}
        renameLimit={diff.renameLimit}
        fileHref={(path) => repoHref('/repo/blob', addr, { path, ref: headOid })}
      />
    </div>
  )
}
