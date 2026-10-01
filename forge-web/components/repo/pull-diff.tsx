'use client'

/**
 * PullDiff — the PR's "Files changed": its head against the merge base with the base branch.
 *
 * Two repos are involved. The base history is read from the repo being viewed; the head is
 * read from the repo it was pushed to (the patch's source pointer `sourceRepoId` — usually the
 * contributor's own repo or fork). Each is resolved
 * through the same browse states as any other view — published index, else the in-browser
 * fallback clone — and reads prefer their own side's
 * repo while falling back to the other, since objects are content-addressed and verified.
 *
 * When a side cannot be loaded the comparison is still attempted from the other one (a merged
 * PR's head is usually in the base repo too), and the page says which repo was missing. It
 * shows "Diff unavailable" only when the objects genuinely are not reachable.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileDiff, Files, HardDriveDownload } from 'lucide-react'

import { readRepoById, repoKey, repoRefOf, type PullView, type RepoRef } from '@/lib/repo'
import {
  formatBytes,
  invalidateBrowseContext,
  loadPullComparison,
  tipOidOf,
  type DiffSides,
  type ObjectReader,
  type PullComparison,
  type RepoHome,
} from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useBrowseReader, type BrowseReaderState } from '@/hooks/use-browse-reader'
import { DiffView } from '@/components/repo/diff-view'
import { Button } from '@/components/ui/button'
import { Oid } from '@/components/ui/oid'
import { Spinner } from '@/components/ui/states'

/**
 * The PR's source repo when it is not the base repo: the `repo` document `sourceRepoId` names
 * (a fork, in the same forge contracts), read so its owner and visibility are real.
 */
export type SourceRepo =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'found'; readonly repo: RepoRef }
  /** `sourceRepoId` names no readable repo: the diff reads the base repo alone. */
  | { readonly kind: 'missing'; readonly message: string; readonly retry?: () => void }

export function useSourceRepo(base: RepoRef, sourceId: string | null): SourceRepo {
  const { sdk, ready } = useSdk()
  const { forge } = base
  const sourceRepo = useAsync<RepoRef | null>(
    async () => {
      const doc = await readRepoById(sdk!, forge, sourceId!)
      return doc === null ? null : repoRefOf(forge, doc)
    },
    [ready, forge.core, sourceId ?? ''],
    { enabled: ready && sdk !== null && sourceId !== null },
  )
  if (sourceId === null) return { kind: 'none' }
  if (sourceRepo.error) {
    return { kind: 'missing', message: `The source repo could not be read (${sourceRepo.error}).`, retry: sourceRepo.reload }
  }
  if (sourceRepo.data) return { kind: 'found', repo: sourceRepo.data }
  if (sourceRepo.settled && !sourceRepo.loading) {
    return { kind: 'missing', message: `The source repo ${sourceId.slice(0, 8)}… this PR names does not exist.` }
  }
  return { kind: 'loading' }
}

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
export interface SideProblem {
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
          <Files className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
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
        <FileDiff className="h-4 w-4 text-caution-700 dark:text-caution-400" aria-hidden />
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

/** The base-branch tips a PR's diff (and merge) start from, honoring a `retarget`. */
export function pullBase(pull: PullView, home: RepoHome): { baseRefName: string; baseTipOid: string; baseOidAtOpen: string; baseOidAtMerge: string } {
  // Diff against the branch the PR targets now: an authorized `retarget` moves it off the
  // patch's original `baseRefName`. `baseTipOid` / `baseOidAtOpen` were read from the
  // original ref's history, so they only apply while the PR still targets that ref.
  const baseRefName = pull.state.baseRef ?? pull.baseRefName
  const retargeted = baseRefName !== pull.baseRefName
  // The base branch's tip as every other view resolves it (validity- and protection-checked
  // by resolveRef), falling back to the newest raw update when the branch is not listed.
  const resolvedBase = home.branches.find((b) => b.refName === baseRefName)
  return {
    baseRefName,
    baseTipOid: tipOidOf(resolvedBase) ?? (retargeted ? '' : pull.baseTipOid),
    baseOidAtOpen: retargeted ? '' : pull.baseOidAtOpen,
    baseOidAtMerge: retargeted ? '' : pull.baseOidAtMerge ?? '',
  }
}

/** Both sides' readers for a comparison of `baseRepo` with the repo `sourceId` names. */
export interface ComparisonSides {
  readonly sides: DiffSides | null
  /**
   * The base repo's OWN reader, or null while it is not loaded. `sides.base` falls back to the
   * head's repo for display; anything that decides what the base repo holds (the merge) must
   * use this and never the fallback.
   */
  readonly baseOnly: ObjectReader | null
  /**
   * The head repo's OWN reader (the source repo's; the base repo's for a same-repo PR), or null
   * while it is not loaded: what proves a browser commit to the PR branch complete.
   */
  readonly headOnly: ObjectReader | null
  readonly problems: readonly SideProblem[]
  /** A side is still resolving; its progress label. */
  readonly waiting: string | null
  /** Changes when a side's reader does (a newer pack list, the index, an in-browser clone). */
  readonly sidesKey: string
  readonly crossRepo: boolean
  /** The PR's source repo when it is not the base (read once here; the page reuses it). */
  readonly source: SourceRepo
  /** Drop both sides' browse contexts so they resolve again ("Try again"). */
  readonly refresh: () => void
}

export function useComparisonSides(baseRepo: RepoRef, sourceId: string): ComparisonSides {
  // An empty source pointer only comes from a malformed document; the base repo is then the
  // only place the head could be.
  const baseKey = baseRepo.repoId
  const sourceKey = sourceId || baseKey
  const crossRepo = sourceKey !== baseKey
  const source = useSourceRepo(baseRepo, crossRepo ? sourceKey : null)

  const baseState = useBrowseReader(baseRepo)
  const sourceState = useBrowseReader(source.kind === 'found' ? source.repo : null)
  // A source that does not resolve falls back to the base repo's reader, with a visible note,
  // instead of waiting forever.
  const sourceMissing = source.kind === 'missing'
  const headState = crossRepo && !sourceMissing ? sourceState : baseState

  const baseReader = baseState.kind === 'ready' ? baseState.reader : null
  const headReader = headState.kind === 'ready' ? headState.reader : null
  const baseProblem = sideProblem(baseState, 'base repo')
  const headProblem = !crossRepo
    ? null
    : source.kind === 'missing'
      ? {
          message: `${source.message} The diff reads from the base repo only.`,
          ...(source.retry ? { action: { label: 'Retry source repo', run: source.retry } } : {}),
        }
      : sideProblem(sourceState, 'source repo')
  const problems = [baseProblem, headProblem].filter((p): p is SideProblem => p !== null)

  // Each side reads its own repo when it can, else the other one.
  const sides = useMemo<DiffSides | null>(() => {
    const base = baseReader ?? headReader
    const head = headReader ?? baseReader
    return base && head ? { base, head } : null
  }, [baseReader, headReader])

  // Which reader serves each side. The comparison and the per-file patches are recomputed
  // when this changes — once a source repo that was skipped is loaded into the browser, or a
  // push reached a side and its reader was replaced by a newer one.
  const readerKey = (state: BrowseReaderState): string => (state.kind === 'ready' ? state.version : 'none')
  const sidesKey = `${readerKey(baseState)}/${readerKey(headState)}`
  // "Try again": both sides' browse contexts are dropped and resolved afresh — a failure that
  // came from a stale one (a head pushed after it was resolved, L-08) is then gone.
  const baseRepoKey = repoKey(baseRepo)
  const sourceRepoKey = source.kind === 'found' ? repoKey(source.repo) : null
  const refresh = useCallback(() => {
    invalidateBrowseContext(baseRepoKey)
    if (sourceRepoKey !== null) invalidateBrowseContext(sourceRepoKey)
  }, [baseRepoKey, sourceRepoKey])
  const waiting =
    baseState.kind === 'loading'
      ? baseState.label
      : headState.kind === 'loading'
        ? `${crossRepo ? 'Source repo: ' : ''}${headState.label}`
        : null
  const headOnly = crossRepo && source.kind !== 'found' ? null : headReader
  return { sides, baseOnly: baseReader, headOnly, problems, waiting, sidesKey, crossRepo, source, refresh }
}

/** What a comparison diffs: the base tips and the head, as {@link loadPullComparison} takes them. */
export interface ComparisonSpec {
  readonly baseTipOid: string
  readonly baseOidAtOpen: string
  /** See `PullComparisonInput.baseOidAtMerge`. */
  readonly baseOidAtMerge?: string
  readonly headOid: string
  readonly merged: boolean
  readonly imported: boolean
  readonly importedUrl: string
  /** See `PullComparisonInput.sourceBaseOid`. */
  readonly sourceBaseOid: string
}

/** A comparison being computed: the sides' readers and the merge-base diff (see {@link usePullComparison}). */
export interface ComparisonState {
  readonly spec: ComparisonSpec
  readonly sides: DiffSides | null
  /** The head repo's own reader (see {@link ComparisonSides.headOnly}). */
  readonly headOnly: ObjectReader | null
  readonly problems: readonly SideProblem[]
  readonly waiting: string | null
  readonly sidesKey: string
  readonly data: PullComparison | null
  readonly loading: boolean
  readonly error: string | null
  readonly cause: unknown
  readonly reload: () => void
  /** "Try again": re-resolve both repos' browse contexts, then re-run the comparison. */
  readonly tryAgain: () => void
  readonly commitsRead: number
  readonly stop: () => void
  /** The source repo `useComparisonSides` resolved. */
  readonly source: SourceRepo
}

/**
 * Compute a head's comparison with its merge base against a base branch, across two repos. The PR
 * page holds one for the whole page: the Files tab renders it, the tab counts and the Commits
 * tab read it, so the merge-base walk runs once.
 */
export function usePullComparison(baseRepo: RepoRef, sourceId: string, spec: ComparisonSpec): ComparisonState {
  const { sides, headOnly, problems, waiting, sidesKey, crossRepo, source, refresh } = useComparisonSides(baseRepo, sourceId)
  const { baseTipOid, baseOidAtOpen } = spec
  // The merge-base search can read tens of thousands of commits on a long-lived branch: it
  // reports how far it got, and "Stop" ends it (D-040).
  const [commitsRead, setCommitsRead] = useState(0)
  const search = useRef<AbortController | null>(null)
  useEffect(() => () => search.current?.abort(), [])
  const { data, loading, error, cause, reload } = useAsync(
    () => {
      search.current?.abort()
      const controller = new AbortController()
      search.current = controller
      setCommitsRead(0)
      return loadPullComparison(
        sides as DiffSides,
        { baseTipOid, baseOidAtOpen, baseOidAtMerge: spec.baseOidAtMerge ?? '', headOid: spec.headOid, merged: spec.merged, imported: spec.imported, sourceBaseOid: spec.sourceBaseOid },
        { signal: controller.signal, onProgress: (n) => controller.signal.aborted || setCommitsRead(n) },
      )
    },
    [baseRepo.repoId, repoKey(baseRepo), sourceId, crossRepo, sidesKey, baseTipOid, baseOidAtOpen, spec.baseOidAtMerge ?? '', spec.headOid, spec.merged, spec.imported, spec.sourceBaseOid],
    { enabled: waiting === null && sides !== null && spec.headOid !== '' },
  )
  // A disabled comparison (a side reloading) must not keep walking history in the background.
  const enabled = waiting === null && sides !== null && spec.headOid !== ''
  useEffect(() => {
    if (!enabled) search.current?.abort()
  }, [enabled])
  const stop = useCallback(() => search.current?.abort(), [])
  // The comparison re-runs on the readers that come back (and on the same ones, if nothing had
  // changed).
  const tryAgain = useCallback(() => {
    refresh()
    reload()
  }, [refresh, reload])
  return { spec, sides, headOnly, problems, waiting, sidesKey, data, loading, error, cause, reload, tryAgain, commitsRead, stop, source }
}

/** The base, head and flags of a PR's comparison. */
export function pullSpec(pull: PullView, home: RepoHome, sourceBaseOid = ''): ComparisonSpec {
  const { baseTipOid, baseOidAtOpen, baseOidAtMerge } = pullBase(pull, home)
  // `sourceBaseOid`: only from a trusted mirror's record (the caller checks): anyone can write that text.
  return { baseTipOid, baseOidAtOpen, baseOidAtMerge, headOid: pull.headOid, merged: pull.state.merged, imported: pull.imported, importedUrl: pull.importedUrl, sourceBaseOid }
}

/** A head compared with its merge base against a base branch, across two repos. */
export function ComparisonDiff({
  baseRepo,
  sourceId,
  spec,
  noHead,
  wrap,
  onSides,
  onResult,
}: {
  baseRepo: RepoRef
  sourceId: string
  spec: ComparisonSpec
  noHead: string
  /** Told the comparison once it is computed (null while it is not). */
  onResult?: (comparison: PullComparison | null) => void
  wrap?: (comparison: PullComparison, diff: ReactNode) => ReactNode
  /**
   * Told the readers the comparison uses (e.g. to read the head commit), and a key that changes
   * whenever either is replaced.
   */
  onSides?: (sides: DiffSides | null, key: string) => void
}): JSX.Element {
  const state = usePullComparison(baseRepo, sourceId, spec)
  const { sides, sidesKey } = state
  useEffect(() => {
    onResult?.(state.data)
    return () => onResult?.(null)
  }, [onResult, state.data])
  useEffect(() => {
    onSides?.(sides, sidesKey)
    // Taken back when they change or this comparison goes (another head picked): nothing may be
    // read for the next head through this one's readers.
    return () => onSides?.(null, '')
  }, [onSides, sides, sidesKey])
  return <ComparisonView state={state} noHead={noHead} {...(wrap ? { wrap } : {})} />
}

/** Render a {@link ComparisonState}: progress, the side problems, the diff. */
export function ComparisonView({
  state,
  noHead,
  wrap,
  action,
}: {
  state: ComparisonState
  noHead: string
  wrap?: (comparison: PullComparison, diff: ReactNode) => ReactNode
  /** Extra controls beside the heading. */
  action?: ReactNode
}): JSX.Element {
  const { spec, sides, problems, waiting, sidesKey, data, loading, error, reload, tryAgain, commitsRead } = state
  const pull = { headOid: spec.headOid, imported: spec.imported, importedUrl: spec.importedUrl }
  const searching = loading && commitsRead > 0
  const searchProgress = (
    <div className="flex flex-wrap items-center justify-center gap-3 rounded-lg border border-anvil-200 px-4 py-6 text-center dark:border-anvil-800">
      <Spinner
        label={
          searching ? `Finding where this PR branched: ${commitsRead.toLocaleString('en-US')} commits read` : 'Comparing pull request'
        }
      />
      {searching ? (
        <Button size="sm" variant="ghost" onClick={state.stop}>
          Stop
        </Button>
      ) : null}
    </div>
  )

  const range =
    data !== null && data.upToDate !== true ? (
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400">
        {data.comparedBaseOid ? <Oid value={data.comparedBaseOid} chars={7} copyable={false} /> : <span>(empty tree)</span>}
        <span>…</span>
        <Oid value={pull.headOid} chars={7} copyable={false} />
        {action}
      </div>
    ) : action

  if (pull.headOid === '') {
    return (
      <Frame>
        <Unavailable title="Diff unavailable" message={noHead} />
      </Frame>
    )
  }
  if (waiting !== null) {
    return (
      <Frame>
        <div className="rounded-lg border border-anvil-200 px-4 py-6 text-center dark:border-anvil-800">
          <Spinner label={waiting} />
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
  if (loading && data === null) return <Frame>{searchProgress}</Frame>
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
              className="inline-flex h-7 items-center rounded-md bg-forge-700 px-2.5 text-dense font-medium text-white hover:bg-forge-800"
            >
              View original diff
            </a>
          ) : null}
          <Button size="sm" variant="ghost" onClick={tryAgain}>Try again</Button>
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
      {searching ? searchProgress : null}
      {data.comparisonNote && !searching ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-caution/30 bg-caution/5 px-3 py-2 text-dense text-anvil-600 dark:text-anvil-300">
          <span>{data.comparisonNote}</span>
          {data.searchStopped ? (
            <Button size="sm" variant="ghost" onClick={reload}>
              Search again
            </Button>
          ) : null}
          {data.fellBack && pull.imported && originalDiffUrl(pull.importedUrl) ? (
            <a
              href={originalDiffUrl(pull.importedUrl)!}
              target="_blank"
              rel="noopener noreferrer"
              className="text-dense font-medium text-forge-700 underline dark:text-forge-400"
              data-testid="original-diff-link"
            >
              View the diff on the source
            </a>
          ) : null}
        </div>
      ) : null}
      {data.upToDate ? (
        <div className="rounded-lg border border-anvil-200 px-4 py-6 text-center text-dense text-anvil-600 dark:border-anvil-800 dark:text-anvil-300" data-testid="nothing-to-compare">
          The base branch already contains this head: there is nothing to compare.
        </div>
      ) : null}
      {data.upToDate ? null : (() => {
        const diff = (
          <DiffView
            key={`${data.comparedBaseOid}..${pull.headOid}@${sidesKey}`}
            sides={data.sides}
            changes={data.changes}
            truncated={data.truncated}
            renameLimit={data.renameLimit}
          />
        )
        return wrap ? wrap(data, diff) : diff
      })()}
    </Frame>
  )
}
