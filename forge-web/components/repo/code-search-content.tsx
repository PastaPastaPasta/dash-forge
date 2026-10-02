'use client'

/**
 * Code search in a repo (P1-3): GitHub's code search over one ref, run in this browser.
 *
 * The ref's index is opened from the search worker first (no read at all when this browser built
 * it before). Without one, the page plans it (the tree walk Go to file shares, no blob read),
 * then builds it — at once when it reads little, else when the viewer says so, showing what it
 * reads and how far it has got. A large repo is searched on its default branch only. Once built,
 * every search runs in the worker and sends no request.
 *
 * When the ref moved since its index was built, the older index is searched meanwhile, said so,
 * with "Update index" (which reads only the files that changed).
 */

import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, FileSearch, FolderOpen, HardDriveDownload, Search } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import { selectedTip, selectRef, shortOid } from '@/lib/view'
import { formatBytes, plural, timeAgo } from '@/lib/view/format'
import { parseCodeQuery } from '@/lib/view/code-query'
import type { FileResult, MatchRange, ResultLine, SearchResult } from '@/lib/view/code-match'
import type { CodeIndexSummary } from '@/lib/view/code-index-host'
import {
  buildCodeIndex,
  codeSearchTarget,
  latestCodeIndex,
  openCodeIndex,
  planAllowed,
  planAutoBuilds,
  planCodeIndex,
  searchCode,
  MAX_FILE_BYTES,
  type BuildProgress,
  type CodeSearchTarget,
} from '@/lib/view/code-index'
import type { PeeledTip } from '@/lib/view/tip'
import { repoKey, type RepoRef } from '@/lib/repo'
import { errorMessage, cn } from '@/lib/utils'
import { useAsync } from '@/hooks/use-async'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { ResolvedTip } from '@/components/repo/resolved-tip'
import { RefDeletedState, RefSwitcher, unknownRefState } from '@/components/repo/ref-switcher'
// `/` focuses this page's box through the repo header's handler (`code-search-box.tsx`).
import { CODE_SEARCH_FIELD, CODE_SEARCH_ROUTE } from '@/components/repo/code-search-box'
import { Button, buttonClass } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, ErrorState, Spinner } from '@/components/ui/states'

/** Files shown per page of results. */
const PAGE = 20
/** Matching lines shown per file before "Show more matches". */
const COLLAPSED_MATCHES = 3
/** Typing pauses this long before the search runs (it runs in the worker, with no request). */
const TYPE_DELAY_MS = 200

/** The index the page searches, and how it got it. */
type IndexState =
  | { readonly phase: 'opening' }
  /** `stale`: an index of the ref at an older tip, searched while the current one is not built. */
  | { readonly phase: 'ready'; readonly summary: CodeIndexSummary; readonly stale: boolean }
  /** No index of this tip; `missing`: one was kept but lost files (evicted, or failing a check). */
  | { readonly phase: 'none'; readonly missing: number }
  /** A large repo, off its default branch: searched there only. */
  | { readonly phase: 'default-only'; readonly files: number }
  | { readonly phase: 'error'; readonly message: string }

export function CodeSearchContent({ home, addr, refParam, initialQuery }: { home: RepoHome; addr: RepoAddress; refParam: string; initialQuery: string }): JSX.Element {
  const selected = selectRef(home.branches, home.tags, home.defaultBranch, refParam)
  const tipOid = selectedTip(selected)
  const unknown = unknownRefState(home, addr, selected, refParam, '')
  if (unknown !== null) return unknown
  if (!tipOid && selected.ref) return <RefDeletedState addr={addr} name={selected.name} defaultBranch={home.defaultBranch} />
  if (!tipOid) return <EmptyState icon={FolderOpen} title="Empty repo" body={`No commits on ${selected.name}, so no code to search.`} />
  const isDefault = !selected.isTag && selected.pinned === undefined && selected.name === home.defaultBranch
  return (
    <SearchView
      key={`${repoKey(home.repo)}\0${tipOid}`}
      home={home}
      addr={addr}
      refParam={refParam}
      initialQuery={initialQuery}
      tipOid={tipOid}
      isDefault={isDefault}
      pinned={selected.pinned !== undefined}
      current={selected}
    />
  )
}

function SearchView({
  home,
  addr,
  refParam,
  initialQuery,
  tipOid,
  isDefault,
  pinned,
  current,
}: {
  home: RepoHome
  addr: RepoAddress
  refParam: string
  initialQuery: string
  tipOid: string
  isDefault: boolean
  pinned: boolean
  current: ReturnType<typeof selectRef>
}): JSX.Element {
  const router = useRouter()
  // One target per repo and tip (the view is keyed by them): the index effect runs once.
  const target = useMemo(() => codeSearchTarget(home.repo, tipOid, current.name, isDefault), [home.repo, tipOid, current.name, isDefault])
  const [text, setText] = useState(initialQuery)
  const [query, setQuery] = useState(initialQuery.trim())
  const [index, setIndex] = useState<IndexState>({ phase: 'opening' })
  const defaultBranch = home.defaultBranch
  /** The viewer asked to build (or update) the index. */
  const [building, setBuilding] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // The kept index of this tip, else the ref's newest at an older tip (searched meanwhile).
  useEffect(() => {
    let live = true
    const settle = (s: IndexState): void => {
      if (live) setIndex(s)
    }
    ;(async () => {
      const opened = await openCodeIndex(target)
      if (opened.state === 'ready') return settle({ phase: 'ready', summary: opened.summary, stale: false })
      const latest = await latestCodeIndex(target)
      if (latest !== null && latest.tip !== target.tip) {
        const older = await openCodeIndex({ ...target, tip: latest.tip })
        if (older.state === 'ready') return settle({ phase: 'ready', summary: older.summary, stale: true })
      }
      // A large repo is indexed on its default branch only: when its index there says so, another
      // ref is turned away with no walk of its tree.
      if (!target.defaultBranch) {
        const main = await latestCodeIndex({ ...target, ref: defaultBranch })
        if (main?.large === true) return settle({ phase: 'default-only', files: main.files })
      }
      settle({ phase: 'none', missing: opened.state === 'incomplete' ? opened.missing : 0 })
    })().catch((e: unknown) => settle({ phase: 'error', message: errorMessage(e) }))
    return () => {
      live = false
    }
  }, [target, defaultBranch])

  // Typing searches after a short pause.
  useEffect(() => {
    const next = text.trim()
    if (next === query) return
    const t = setTimeout(() => setQuery(next), TYPE_DELAY_MS)
    return () => clearTimeout(t)
  }, [text, query])

  // The URL follows the query searched (replace: no history entry per search), so a reload or a
  // shared link searches it again.
  const shownQuery = useRef(initialQuery.trim())
  useEffect(() => {
    if (query === shownQuery.current) return
    shownQuery.current = query
    router.replace(repoHref(CODE_SEARCH_ROUTE, addr, { ...(query ? { query } : {}), ...(refParam ? { ref: refParam } : {}) }), { scroll: false })
  }, [query, router, addr, refParam])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    setQuery(text.trim())
  }

  const parsed = useMemo(() => parseCodeQuery(query), [query])
  const ready = index.phase === 'ready' ? index : null
  const needsBuild = index.phase === 'none' || (ready?.stale === true && building)

  return (
    <div className="space-y-4" data-testid="code-search">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher home={home} addr={addr} current={current} keep={query ? { query } : {}} />
        <h2 className="text-prose font-semibold">Code search</h2>
      </div>
      <form role="search" aria-label={`Search the code of ${home.repo.name}`} onSubmit={submit} className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-anvil-500 dark:text-anvil-400" aria-hidden />
          <label htmlFor="code-search-query" className="sr-only">
            Search code
          </label>
          <Input
            ref={input}
            id="code-search-query"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search code: a word, &quot;a phrase&quot;, /regex/, path:src language:cpp"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            autoFocus={initialQuery === ''}
            className="pl-9 font-mono"
            aria-describedby="code-search-help"
            {...{ [CODE_SEARCH_FIELD]: '' }}
            data-testid="code-search-input"
          />
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <SyntaxHelp />
      {parsed.error !== null ? (
        <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">
          {parsed.error}
        </p>
      ) : null}
      {parsed.ignored.length > 0 ? (
        <ul className="space-y-0.5 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="code-search-ignored">
          {parsed.ignored.map((i) => (
            <li key={i.token}>
              <code className="font-mono">{i.token}</code> is not applied: {i.why}.
            </li>
          ))}
        </ul>
      ) : null}

      {index.phase === 'opening' ? <Spinner label="Opening this browser’s index" /> : null}
      {index.phase === 'default-only' ? <DefaultOnly addr={addr} files={index.files} defaultBranch={defaultBranch} refName={target.ref} query={query} /> : null}
      {index.phase === 'error' ? <ErrorState title="The search index could not be opened" message={index.message} onRetry={() => window.location.reload()} /> : null}
      {ready !== null ? <IndexLine summary={ready.summary} stale={ready.stale} target={target} building={building} onUpdate={() => setBuilding(true)} /> : null}

      {needsBuild ? (
        <BrowseBoundary repo={home.repo} addr={addr}>
          {(reader, retry) => (
            <ResolvedTip reader={reader} retry={retry} repo={home.repo} tip={target.tip} pinned={pinned} name={target.ref} addr={addr} refParam={refParam} accepts="tree" label="Reading the ref">
              {(tip) => (
                <IndexBuilder
                  reader={reader}
                  repo={home.repo}
                  addr={addr}
                  target={target}
                  tip={tip}
                  defaultBranch={home.defaultBranch}
                  query={query}
                  missing={index.phase === 'none' ? index.missing : 0}
                  confirmed={building}
                  onConfirm={() => setBuilding(true)}
                  onBuilt={(summary) => {
                    setBuilding(false)
                    setIndex({ phase: 'ready', summary, stale: false })
                  }}
                />
              )}
            </ResolvedTip>
          )}
        </BrowseBoundary>
      ) : null}

      {ready !== null ? <Results target={target} summary={ready.summary} stale={ready.stale} query={query} addr={addr} refParam={refParam} /> : null}
    </div>
  )
}

/** The syntax, folded (GitHub's code search syntax, as far as one repo's files go). */
function SyntaxHelp(): JSX.Element {
  const rows: [string, string][] = [
    ['word other', 'files holding every word, in the content or the path'],
    ['"exact phrase"', 'the phrase as written'],
    ['/fo+ ba[rz]/', 'a regular expression'],
    ['NOT word, -word', 'files without it'],
    ['path:src/net, path:*.cpp', 'paths holding it, or a glob (a leading / anchors at the root)'],
    ['language:cpp', 'files of a language (-language: leaves one out)'],
    ['content:word', 'the content only, not the path'],
    ['case:yes', 'match case'],
  ]
  return (
    <details id="code-search-help" className="text-[12px] text-anvil-600 dark:text-anvil-400">
      <summary className="hit-area cursor-pointer select-none">Search syntax</summary>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="font-mono text-anvil-800 dark:text-anvil-200">{k}</dt>
            <dd className="mb-1 sm:mb-0">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  )
}

/** What the index searched holds, and what it leaves out (honest limits). */
function IndexLine({ summary, stale, target, building, onUpdate }: { summary: CodeIndexSummary; stale: boolean; target: CodeSearchTarget; building: boolean; onUpdate: () => void }): JSX.Element {
  const left = summary.skipped.binary + summary.skipped.large + summary.skipped.symlink
  return (
    <div className="space-y-2" data-testid="code-search-index">
      {stale ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
          <AlertTriangle className="h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
          <span className="min-w-0 flex-1">
            Searching an older index: {target.ref} at {shortOid(summary.commit ?? summary.tip)}. {target.ref} has moved to {shortOid(target.tip)}.
          </span>
          {!building ? (
            <Button size="sm" variant="outline" onClick={onUpdate} data-testid="code-search-update">
              Update index
            </Button>
          ) : null}
        </div>
      ) : null}
      <details className="text-[12px] text-anvil-600 dark:text-anvil-400">
        <summary className="hit-area cursor-pointer select-none">
          {plural(summary.files, 'file')} of {summary.ref} at {shortOid(summary.commit ?? summary.tip)} · {formatBytes(summary.bytes)} of text · indexed in this browser {timeAgo(summary.builtAt)}
        </summary>
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          <li>The files were read from the repo’s storage once, each checked against its id, and are kept in this browser{target.persist ? '' : ' tab only (a private repo’s files are never written to disk)'}. Searching sends no request.</li>
          <li>
            Not searched: {left === 0 ? 'nothing' : [summary.skipped.binary ? plural(summary.skipped.binary, 'binary file') : '', summary.skipped.large ? `${plural(summary.skipped.large, 'file')} over ${formatBytes(MAX_FILE_BYTES)}` : '', summary.skipped.symlink ? plural(summary.skipped.symlink, 'symlink') : ''].filter(Boolean).join(', ')}; submodules.
          </li>
          {summary.truncated ? <li>The repo has more files than an index lists: only the first {plural(summary.files, 'file')} are searched.</li> : null}
          {summary.capped ? <li>Reading stopped at 100 MiB of text: the files past it are not searched.</li> : null}
          {summary.large ? <li>A large repo: only its default branch is indexed, and one index is kept.</li> : null}
        </ul>
      </details>
    </div>
  )
}

/** A large repo off its default branch: its code search covers the default branch only. */
function DefaultOnly({ addr, files, defaultBranch, refName, query }: { addr: RepoAddress; files: number; defaultBranch: string; refName: string; query: string }): JSX.Element {
  return (
    <EmptyState
      icon={FileSearch}
      title={`Content search covers ${defaultBranch} only`}
      body={`This is a large repository (${plural(files, 'file')} to search). Its index is built for the default branch alone, so a browser keeps one copy. Search ${defaultBranch}, or clone the repo and use git grep on ${refName}.`}
      action={
        <Link href={repoHref(CODE_SEARCH_ROUTE, addr, query ? { query } : {})} className={buttonClass({ variant: 'primary' })} data-testid="code-search-default">
          Search {defaultBranch}
        </Link>
      }
    />
  )
}

/** Plan the index, then build it: at once when small, else when the viewer says so. */
function IndexBuilder({
  reader,
  repo,
  addr,
  target,
  tip,
  defaultBranch,
  query,
  missing,
  confirmed,
  onConfirm,
  onBuilt,
}: {
  reader: BrowseReader
  repo: RepoRef
  addr: RepoAddress
  target: CodeSearchTarget
  tip: PeeledTip
  defaultBranch: string
  query: string
  missing: number
  confirmed: boolean
  onConfirm: () => void
  onBuilt: (summary: CodeIndexSummary) => void
}): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const plan = useAsync((signal) => planCodeIndex(reader, repo, target, tip, { signal }), [target.scope, target.tip, tip.oid, attempt])
  const [progress, setProgress] = useState<BuildProgress | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [stopped, setStopped] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const p = plan.data
  const go = p !== null && planAllowed(p) && (confirmed || planAutoBuilds(p) || p.toRead.length === 0) && failure === null && !stopped

  useEffect(() => {
    if (!go || p === null) return
    const abort = new AbortController()
    controller.current = abort
    setProgress({ files: 0, total: p.toRead.length, bytes: 0, text: 0 })
    buildCodeIndex(reader, p, { signal: abort.signal, onProgress: setProgress })
      .then((summary) => {
        if (!abort.signal.aborted) onBuilt(summary)
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return
        setFailure(errorMessage(e))
      })
    return () => abort.abort()
    // The build runs once per plan; `onBuilt` is the parent's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, p])

  if (plan.error !== null) return <ErrorState title="Couldn’t list the files to index" message={plan.error} cause={plan.cause} onRetry={plan.reload} />
  if (p === null) return <Spinner label={`Listing the files of ${target.ref}`} />
  if (p.tooLarge) {
    return (
      <EmptyState
        icon={HardDriveDownload}
        title="Too large to search in a browser"
        body={`${target.ref} holds more than 100 MiB of text (${plural(p.files.length, 'file')}). Clone the repo and use git grep.`}
      />
    )
  }
  if (!planAllowed(p)) return <DefaultOnly addr={addr} files={p.files.length} defaultBranch={defaultBranch} refName={target.ref} query={query} />
  if (failure !== null) {
    return (
      <ErrorState
        title="The index could not be built"
        message={`${failure} What was read is kept: building again continues from there.`}
        onRetry={() => {
          setFailure(null)
          setStopped(false)
          setAttempt((n) => n + 1)
        }}
      />
    )
  }
  if (go && progress !== null) {
    const pct = progress.total === 0 ? 100 : Math.round((progress.files / progress.total) * 100)
    return (
      <div className="space-y-2 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="code-search-building">
        <p className="text-dense text-anvil-700 dark:text-anvil-200">
          Indexing {target.ref}: {progress.files.toLocaleString('en-US')} of {plural(progress.total, 'file')} read
          {p.readBytes > 0 ? ` · ${formatBytes(progress.bytes)} of about ${formatBytes(p.readBytes)}` : ''}
        </p>
        <div
          role="progressbar"
          aria-label={`Indexing ${target.ref}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-2 overflow-hidden rounded-full bg-anvil-100 dark:bg-anvil-800"
        >
          <div className="h-full bg-forge-600 transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            controller.current?.abort()
            setStopped(true)
            setProgress(null)
          }}
        >
          Stop
        </Button>
      </div>
    )
  }
  return (
    <div className="space-y-3 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="code-search-plan">
      <h3 className="text-prose font-semibold">{missing > 0 ? 'Rebuild this browser’s index' : `Index ${target.ref} for code search`}</h3>
      <p className="text-dense text-anvil-700 dark:text-anvil-200">
        {missing > 0 ? `${plural(missing, 'file')} of the index kept here went missing (the browser cleared some of its storage). ` : ''}
        Code search reads each text file of {target.ref} once — {plural(p.readPaths, 'file')}, {p.unsized > 0 ? 'at least' : 'about'} {formatBytes(p.readBytes)} from the repo’s storage
        {p.cached > 0 ? ` (${p.cached.toLocaleString('en-US')} more are already in this browser)` : ''} — checks each against its id and keeps them{' '}
        {target.persist ? 'in this browser' : 'in this tab'}. After that, searching sends no request.
      </p>
      {p.large ? <p className="text-[12px] text-anvil-600 dark:text-anvil-400">A large repository: only its default branch is indexed, and one index is kept.</p> : null}
      {stopped ? <p className="text-[12px] text-anvil-600 dark:text-anvil-400">Stopped. What was read is kept: building again continues from there.</p> : null}
      <Button
        variant="primary"
        onClick={() => {
          // After a stop, plan again: what the stopped build read is kept, and not read twice.
          if (stopped) setAttempt((n) => n + 1)
          setStopped(false)
          onConfirm()
        }}
        data-testid="code-search-build"
      >
        {stopped ? 'Continue indexing' : 'Build index'}
      </Button>
    </div>
  )
}

/** The results of `query` over the loaded index: no request. */
function Results({ target, summary, stale, query, addr, refParam }: { target: CodeSearchTarget; summary: CodeIndexSummary; stale: boolean; query: string; addr: RepoAddress; refParam: string }): JSX.Element | null {
  // A new query starts from the first page.
  const [paging, setPaging] = useState({ query, limit: PAGE })
  const limit = paging.query === query ? paging.limit : PAGE
  const result = useAsync(() => searchCode(target, summary.tip, query, 0, limit), [target.scope, summary.tip, query, limit], { enabled: query !== '' })
  // While a search runs, the previous results stay (no flash of "Searching" per keystroke).
  const shown = useRef<SearchResult | null>(null)
  if (result.data !== null) shown.current = result.data
  if (query === '') {
    return <p className="text-dense text-anvil-600 dark:text-anvil-400">Type to search {plural(summary.files, 'file')} of {summary.ref}.</p>
  }
  if (result.error !== null) return <ErrorState title="The search failed" message={result.error} onRetry={result.reload} />
  const data = shown.current
  if (data === null) return <Spinner label="Searching" />
  // Links open the file at the commit searched when the index is an older one.
  const linkRef = stale ? (summary.commit ?? summary.tip) : refParam
  return (
    <section aria-label="Results" className="space-y-3" data-testid="code-search-results">
      <p role="status" className="text-dense text-anvil-700 dark:text-anvil-200" data-testid="code-search-count">
        {data.fileCount === 0 ? 'No files match.' : `${plural(data.fileCount, 'file')}`}
        {data.stopped ? ' (the search stopped after 5 s; refine it for every match)' : ''}
        <span className="ml-2 text-[12px] text-anvil-500 dark:text-anvil-400">{Math.max(1, Math.round(data.ms))} ms, in this browser</span>
      </p>
      {data.unknownLanguages.length > 0 ? (
        <p className="text-[12px] text-anvil-600 dark:text-anvil-400">Unknown language: {data.unknownLanguages.join(', ')}.</p>
      ) : null}
      <ol className="space-y-3">
        {data.files.map((f) => (
          <li key={f.path}>
            <FileHit file={f} addr={addr} linkRef={linkRef} />
          </li>
        ))}
      </ol>
      {data.files.length < data.fileCount ? (
        <Button variant="outline" onClick={() => setPaging({ query, limit: limit + PAGE })} loading={result.loading} data-testid="code-search-more">
          Show more files ({(data.fileCount - data.files.length).toLocaleString('en-US')} more)
        </Button>
      ) : null}
    </section>
  )
}

/** `text` with its `ranges` marked. */
function Marked({ text, ranges }: { text: string; ranges: readonly MatchRange[] }): JSX.Element {
  const parts: JSX.Element[] = []
  let at = 0
  for (const [s, e] of ranges) {
    if (s > at) parts.push(<Fragment key={`t${at}`}>{text.slice(at, s)}</Fragment>)
    parts.push(
      <mark key={`m${s}`} className="rounded-sm bg-caution/30 text-inherit dark:bg-caution/40">
        {text.slice(s, e)}
      </mark>,
    )
    at = e
  }
  if (at < text.length) parts.push(<Fragment key={`t${at}`}>{text.slice(at)}</Fragment>)
  return <>{parts}</>
}

/** Lines in runs of consecutive line numbers (a gap between runs is shown as a divider). */
function runs(lines: readonly ResultLine[]): ResultLine[][] {
  const out: ResultLine[][] = []
  for (const l of lines) {
    const last = out[out.length - 1]
    if (last !== undefined && (last[last.length - 1] as ResultLine).n + 1 === l.n) last.push(l)
    else out.push([l])
  }
  return out
}

function FileHit({ file, addr, linkRef }: { file: FileResult; addr: RepoAddress; linkRef: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const href = (line?: number): string => `${repoHref('/repo/blob', addr, { path: file.path, ...(linkRef ? { ref: linkRef } : {}) })}${line ? `#L${line}` : ''}`
  // Collapsed: the runs holding the first few matching lines.
  const all = runs(file.lines)
  let matched = 0
  const shown = expanded
    ? all
    : all.filter((run) => {
        if (matched >= COLLAPSED_MATCHES) return false
        matched += run.filter((l) => l.ranges.length > 0).length
        return true
      })
  const shownMatches = shown.flat().filter((l) => l.ranges.length > 0).length
  const more = file.matchLines - shownMatches
  return (
    <article className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="code-search-hit">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-anvil-200 bg-anvil-50 px-3 py-2 dark:border-anvil-800 dark:bg-anvil-900">
        <h3 className="min-w-0 flex-1 break-all font-mono text-dense">
          <Link href={href()} className="hover:text-forge-800 hover:underline dark:hover:text-forge-400">
            <Marked text={file.path} ranges={file.pathRanges} />
          </Link>
        </h3>
        {file.language !== null ? <span className="text-[11px] text-anvil-500 dark:text-anvil-400">{file.language}</span> : null}
        {file.matchLines > 0 ? <span className="text-[11px] text-anvil-500 dark:text-anvil-400">{plural(file.matchLines, 'matching line')}</span> : null}
      </header>
      {shown.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[12px] leading-5">
            <tbody>
              {shown.map((run, i) => (
                <Fragment key={run[0]?.n ?? i}>
                  {i > 0 ? (
                    <tr aria-hidden>
                      <td colSpan={2} className="h-1.5 border-y border-anvil-100 bg-anvil-50 dark:border-anvil-850 dark:bg-anvil-900" />
                    </tr>
                  ) : null}
                  {run.map((l) => (
                    <tr key={l.n} className={l.ranges.length > 0 ? '' : 'text-anvil-500 dark:text-anvil-400'}>
                      <td className="w-px select-none whitespace-nowrap px-3 text-right align-top">
                        <Link href={href(l.n)} className="text-anvil-500 hover:text-forge-800 dark:text-anvil-400 dark:hover:text-forge-400" aria-label={`Line ${l.n}`}>
                          {l.n}
                        </Link>
                      </td>
                      <td className="whitespace-pre pr-3 text-anvil-800 dark:text-anvil-100">
                        {l.clippedStart ? <span aria-hidden>…</span> : null}
                        <Marked text={l.text} ranges={l.ranges} />
                        {l.clippedEnd ? <span aria-hidden>…</span> : null}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {more > 0 || expanded ? (
        <div className="border-t border-anvil-200 px-3 py-1.5 dark:border-anvil-800">
          {expanded ? (
            <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
              Show fewer matches
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setExpanded(true)} aria-label={`Show ${more} more matches in ${file.path}`}>
              Show {plural(more, 'more match', 'more matches')}
            </Button>
          )}
          {expanded && file.matchLines > file.lines.filter((l) => l.ranges.length > 0).length ? (
            <Link href={href()} className={cn('ml-2 text-[12px] text-forge-700 hover:underline dark:text-forge-400')}>
              Open the file for every match
            </Link>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
