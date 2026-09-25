'use client'

/**
 * PullDiff — the PR's "Files changed": its head against the merge base with the base branch.
 *
 * Two repos are involved. The base history is read from the repo being viewed; the head is
 * read from the contract it was pushed to (the patch's `sourceContractId`, usually the
 * contributor's own repo). Each is resolved through the same browse states as any other view
 * — published index, else the in-browser fallback clone — and reads prefer their own side's
 * repo while falling back to the other, since objects are content-addressed and verified.
 *
 * When a side cannot be loaded the comparison is still attempted from the other one (a merged
 * PR's head is usually in the base repo too), and the page says which repo was missing. It
 * shows "Diff unavailable" only when the objects genuinely are not reachable.
 */

import { useMemo, type ReactNode } from 'react'
import { FileDiff, Files, HardDriveDownload } from 'lucide-react'

import type { PullView, RepoRef } from '@/lib/repo'
import { formatBytes, loadPullComparison, tipOidOf, type DiffSides, type RepoHome } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { useBrowseReader, type BrowseReaderState } from '@/hooks/use-browse-reader'
import { DiffView } from '@/components/repo/diff-view'
import { Button } from '@/components/ui/button'
import { Oid } from '@/components/ui/oid'
import { Spinner } from '@/components/ui/states'

/** Link to the archived upstream PR's own diff, for an imported PR from GitHub. */
function originalDiffUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
    if (!/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)) return null
    url.pathname = `${url.pathname.replace(/\/$/, '')}/files`
    return url.toString()
  } catch {
    return null
  }
}

/** A side that did not yield a reader: what to say about it, and what the user can do. */
interface SideProblem {
  readonly message: string
  readonly action?: { readonly label: string; readonly run: () => void }
}

function sideProblem(state: BrowseReaderState, what: string): SideProblem | null {
  switch (state.kind) {
    case 'ready':
    case 'loading':
      return null
    case 'no-packs':
      return { message: `The ${what} has no stored packs.` }
    case 'error':
      return {
        message: `The ${what} could not be loaded (${state.message}).`,
        action: { label: `Retry ${what}`, run: state.retry },
      }
    case 'offer':
      return {
        message: `The ${what} ${state.behind ? "browse index is behind" : 'is not indexed for browsing'}, and loading it into your browser downloads about ${formatBytes(state.sizeBytes)}.`,
        action: { label: `Load ${what} (${formatBytes(state.sizeBytes)})`, run: state.start },
      }
  }
}

function Frame({ children, action }: { children: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <section className="space-y-3" aria-labelledby="files-changed-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Files className="h-4 w-4 text-anvil-400" aria-hidden />
          <h2 id="files-changed-heading" className="text-prose font-semibold">Files changed</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Unavailable({
  title,
  message,
  problems = [],
  children,
}: {
  title: string
  message: string
  problems?: readonly SideProblem[]
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="rounded-lg border border-caution/30 bg-caution/5 px-4 py-5">
      <div className="flex items-center gap-2 text-dense font-medium text-anvil-900 dark:text-anvil-50">
        <FileDiff className="h-4 w-4 text-caution" aria-hidden />
        {title}
      </div>
      <p className="mt-1 break-words text-dense text-anvil-600 dark:text-anvil-300">{message}</p>
      {problems.map((p) => (
        <p key={p.message} className="mt-1 break-words text-dense text-anvil-600 dark:text-anvil-300">
          {p.message}
        </p>
      ))}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {problems.map((p) =>
          p.action ? (
            <Button key={p.message} size="sm" onClick={p.action.run}>
              <HardDriveDownload className="h-3.5 w-3.5" aria-hidden />
              {p.action.label}
            </Button>
          ) : null,
        )}
        {children}
      </div>
    </div>
  )
}

export function PullDiff({ pull, home }: { pull: PullView; home: RepoHome }): JSX.Element {
  const baseRepo = home.repo
  // Diff against the branch the PR targets now: an authorized `retarget` moves it off the
  // patch's original `baseRefName`. `baseTipOid` / `baseOidAtOpen` were read from the
  // original ref's history, so they only apply while the PR still targets that ref.
  const baseRefName = pull.state.baseRef ?? pull.baseRefName
  const retargeted = baseRefName !== pull.baseRefName
  // The base branch's tip as every other view resolves it (validity- and protection-checked
  // by resolveRef), falling back to the newest raw update when the branch is not listed.
  const resolvedBase = home.branches.find((b) => b.refName === baseRefName)
  const baseTipOid = tipOidOf(resolvedBase) ?? (retargeted ? '' : pull.baseTipOid)
  const baseOidAtOpen = retargeted ? '' : pull.baseOidAtOpen
  // An empty source pointer only comes from a malformed document; the base repo is then the
  // only place the head could be. Browse reads are keyed by contract alone — the owner is
  // carried for the type and is the PR author, who pushed the source repo.
  const sourceContractId = pull.sourceContractId || baseRepo.contractId
  const crossRepo = sourceContractId !== baseRepo.contractId
  const sourceRepo = useMemo<RepoRef | null>(
    () => (crossRepo ? { contractId: sourceContractId, ownerId: pull.author } : null),
    [crossRepo, sourceContractId, pull.author],
  )

  const baseState = useBrowseReader(baseRepo)
  const sourceState = useBrowseReader(sourceRepo)
  const headState = crossRepo ? sourceState : baseState

  const baseReader = baseState.kind === 'ready' ? baseState.reader : null
  const headReader = headState.kind === 'ready' ? headState.reader : null
  const baseProblem = sideProblem(baseState, 'base repo')
  const headProblem = crossRepo ? sideProblem(sourceState, 'source repo') : null
  const problems = [baseProblem, headProblem].filter((p): p is SideProblem => p !== null)

  // Each side reads its own repo when it can, else the other one.
  const sides = useMemo<DiffSides | null>(() => {
    const base = baseReader ?? headReader
    const head = headReader ?? baseReader
    return base && head ? { base, head } : null
  }, [baseReader, headReader])

  // Which reader serves each side. The comparison and the per-file patches are recomputed
  // when this changes — e.g. once a source repo that was skipped is loaded into the browser.
  const readerKey = (state: BrowseReaderState): string =>
    state.kind === 'ready' ? (state.local ? 'local' : 'index') : 'none'
  const sidesKey = `${readerKey(baseState)}/${readerKey(headState)}`

  const waiting = baseState.kind === 'loading' || headState.kind === 'loading'
  const { data, loading, error, reload } = useAsync(
    () =>
      loadPullComparison(sides as DiffSides, {
        baseTipOid,
        baseOidAtOpen,
        headOid: pull.headOid,
        merged: pull.state.merged,
        imported: pull.imported,
      }),
    [
      baseRepo.contractId,
      sourceContractId,
      sidesKey,
      baseTipOid,
      baseOidAtOpen,
      pull.headOid,
      pull.state.merged,
      pull.imported,
    ],
    { enabled: !waiting && sides !== null && pull.headOid !== '' },
  )

  const range =
    data !== null ? (
      <div className="flex items-center gap-2 text-[12px] text-anvil-400">
        {data.comparedBaseOid ? <Oid value={data.comparedBaseOid} chars={7} copyable={false} /> : <span>(empty tree)</span>}
        <span>…</span>
        <Oid value={pull.headOid} chars={7} copyable={false} />
      </div>
    ) : undefined

  if (pull.headOid === '') {
    return (
      <Frame>
        <Unavailable title="Diff unavailable" message="This PR does not record a head commit." />
      </Frame>
    )
  }
  if (waiting) {
    const label = baseState.kind === 'loading' ? baseState.label : headState.kind === 'loading' ? headState.label : ''
    return (
      <Frame>
        <div className="rounded-lg border border-anvil-200 px-4 py-6 text-center dark:border-anvil-800">
          <Spinner label={`${crossRepo && baseState.kind !== 'loading' ? 'Source repo: ' : ''}${label}`} />
        </div>
      </Frame>
    )
  }
  if (sides === null) {
    return (
      <Frame>
        <Unavailable
          title="Diff unavailable"
          message="Neither the base repo nor the repo holding the PR's head could be loaded, so there are no objects to compare."
          problems={problems}
        />
      </Frame>
    )
  }
  if (loading && data === null) {
    return (
      <Frame>
        <div className="rounded-lg border border-anvil-200 px-4 py-6 text-center dark:border-anvil-800">
          <Spinner label="Comparing pull request" />
        </div>
      </Frame>
    )
  }
  if (error !== null || data === null) {
    const original = pull.imported ? originalDiffUrl(pull.importedUrl) : null
    return (
      <Frame>
        <Unavailable
          title={pull.imported ? 'Native diff unavailable' : 'Diff unavailable'}
          message={
            pull.imported
              ? `This imported PR does not include enough retained Git history to reconstruct an exact diff (${error ?? 'no result'}).`
              : `Dash Forge could not reconstruct this diff from the stored Git objects (${error ?? 'no result'}).`
          }
          problems={problems}
        >
          {original ? (
            <a
              href={original}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center rounded-md bg-forge-700 px-2.5 text-dense font-medium text-white hover:bg-forge-600"
            >
              View original diff
            </a>
          ) : null}
          <Button size="sm" variant="ghost" onClick={reload}>Try again</Button>
        </Unavailable>
      </Frame>
    )
  }

  return (
    <Frame action={range}>
      {problems.map((p) => (
        <div
          key={p.message}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-caution/30 bg-caution/5 px-3 py-2 text-dense text-anvil-600 dark:text-anvil-300"
        >
          <span>{p.message} Its objects were read from the other repo instead.</span>
          {p.action ? <Button size="sm" onClick={p.action.run}>{p.action.label}</Button> : null}
        </div>
      ))}
      {data.comparisonNote ? (
        <p className="rounded-md border border-caution/30 bg-caution/5 px-3 py-2 text-dense text-anvil-600 dark:text-anvil-300">
          {data.comparisonNote}
        </p>
      ) : null}
      <DiffView
        key={`${data.comparedBaseOid}..${pull.headOid}@${sidesKey}`}
        sides={data.sides}
        changes={data.changes}
        truncated={data.truncated}
      />
    </Frame>
  )
}
