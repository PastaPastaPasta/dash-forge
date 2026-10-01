'use client'

/**
 * Go to file (QW-028): GitHub's file finder on the repo home and every directory. Fuzzy matching
 * ({@link fuzzyRank}: `netproc` finds `src/net_processing.cpp`), the arrow keys and Enter to open
 * a result, Escape to leave, and `t` anywhere on the page to start typing. The code pages with no
 * finder of their own (a file, its blame, a commit, a comparison) open it in a dialog on `t`
 * ({@link GoToFileHotkey}, QW2-043), as GitHub does on every code page.
 *
 * The list comes from the history index first: the index the file list's column already loaded
 * names every path at the tip, so the first results need no read at all. The tree walk the
 * language bar shares ({@link repoFilesWalk}, its reads in parallel) starts on first focus and,
 * once done, is the list: it is exact where an index a delta extends can still name a deleted file.
 * A full index of the tip itself is exact already, and then no walk runs (QW3-001: on a large repo
 * the walk reads the whole object index).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import type { ObjectReader } from '@/lib/view/tree-nav'
import { rootTreeOf, type PeeledTip } from '@/lib/view/tip'
import { repoKey, type RepoRef } from '@/lib/repo'
import { Dialog } from '@/components/ui/dialog'
import { indexedFilePaths, indexListsTip, repoFilesWalk } from '@/lib/view/repo-facts'
import { fuzzyRank, type FuzzyHit } from '@/lib/view/fuzzy'
import { plural } from '@/lib/view/format'
import { isPageShortcut } from '@/lib/focus'
import { useAsync } from '@/hooks/use-async'
import { Input } from '@/components/ui/input'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

/** Results shown at once (the list scrolls). */
const RESULTS = 20

/** A path with its matched characters marked. */
function Marked({ hit }: { hit: FuzzyHit }): JSX.Element {
  const at = new Set(hit.positions)
  const parts: JSX.Element[] = []
  let run = ''
  let marked = false
  const flush = (key: number): void => {
    if (run === '') return
    parts.push(marked ? <mark key={key} className="bg-transparent font-semibold text-anvil-900 dark:text-anvil-50">{run}</mark> : <span key={key}>{run}</span>)
    run = ''
  }
  for (let i = 0; i < hit.path.length; i++) {
    if (at.has(i) !== marked) {
      flush(i)
      marked = at.has(i)
    }
    run += hit.path[i]
  }
  flush(hit.path.length)
  return <>{parts}</>
}

export function GoToFile({
  reader,
  repoKey: key,
  tipOid,
  rootTree,
  addr,
  refParam,
  className,
  inDialog = false,
  onOpen,
}: {
  reader: ObjectReader & { readonly memoScope?: object }
  repoKey: string
  tipOid: string
  /** The tip's root tree, read when the walk starts. */
  rootTree: () => Promise<string>
  addr: RepoAddress
  refParam: string
  className?: string
  /** In {@link GoToFileHotkey}'s dialog: focused on open, with the results under the box. */
  inDialog?: boolean
  /** A result was opened (the dialog closes). */
  onOpen?: () => void
}): JSX.Element {
  const [started, setStarted] = useState(inDialog)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const router = useRouter()
  // The index's list (no read when the column already loaded it), then the walk's exact one.
  const indexed = useAsync(() => indexedFilePaths(reader, tipOid), [key, tipOid], { enabled: started })
  // A full index of this very tip is already the exact list: no walk, which on a large repo reads
  // its whole object index (QW3-001). Otherwise the walk starts once the index's answer is in.
  const exact = indexed.data != null && indexListsTip(reader, tipOid)
  const walk = useAsync(async () => repoFilesWalk(key, tipOid, reader, await rootTree()), [key, tipOid], { enabled: started && indexed.settled && !exact })
  // A walk that stopped at its file cap names fewer paths than a complete index: the index then
  // stays the list, and the walk's partial one answers only when there is no index.
  const walkPaths = useMemo(() => walk.data?.files.map((f) => f.path) ?? null, [walk.data])
  const walkInUse = walkPaths !== null && (!walk.data?.truncated || indexed.data == null)
  const paths = walkInUse ? walkPaths : (indexed.data ?? walkPaths)
  const q = query.trim()
  const hits = useMemo(() => (q === '' || paths === null ? [] : fuzzyRank(q, paths, RESULTS)), [q, paths])
  const hrefOf = (path: string): string => repoHref('/repo/blob', addr, { path, ...(refParam ? { ref: refParam } : {}) })
  const optionId = (i: number): string => `${listId}-${i}`

  // `t` starts typing a file name, as on GitHub.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isPageShortcut(e, 't')) return
      const box = input.current
      if (box === null || box.getClientRects().length === 0) return
      e.preventDefault()
      box.focus()
      box.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // A new list of results (a new query, or the walk's list replacing the index's) starts from its
  // best match, so the highlighted row always exists and Enter always opens something.
  useEffect(() => setActive(0), [hits])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (hits.length === 0) return
      e.preventDefault()
      const next = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length
      setActive(next)
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      const hit = hits[active]
      if (hit === undefined) return
      e.preventDefault()
      onOpen?.()
      router.push(hrefOf(hit.path))
    } else if (e.key === 'Escape') {
      // In the dialog, Escape closes it (the dialog's own handler).
      if (inDialog) return
      e.preventDefault()
      setQuery('')
      input.current?.blur()
    }
  }

  const searching = paths === null && (walk.loading || indexed.loading || !started)
  const open = q !== ''
  return (
    <div className={cn('relative w-full', inDialog ? '' : 'sm:w-56', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <label htmlFor={`${listId}-input`} className="sr-only">
          Go to file
        </label>
        <Input
          ref={input}
          id={`${listId}-input`}
          value={query}
          onFocus={() => setStarted(true)}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Go to file"
          autoFocus={inDialog}
          className={cn('py-1 pl-8 pr-7', inDialog ? 'h-9' : 'h-8')}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && hits[active] !== undefined ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          data-testid="go-to-file"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-anvil-300 px-1 font-mono text-[10px] text-anvil-500 sm:block dark:border-anvil-700 dark:text-anvil-400" aria-hidden>
          t
        </kbd>
      </div>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Files"
          className={cn(
            'z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-anvil-200 bg-white py-1 dark:border-anvil-750 dark:bg-anvil-900',
            inDialog ? 'relative' : 'absolute right-0 shadow-lg sm:w-96',
          )}
        >
          {searching ? <li className="px-3 py-1.5 text-anvil-500 dark:text-anvil-400">Listing files…</li> : null}
          {walk.error && paths === null ? <li className="px-3 py-1.5 text-danger-700 dark:text-danger-400">{walk.error}</li> : null}
          {!searching && paths !== null && hits.length === 0 ? <li className="px-3 py-1.5 text-anvil-500 dark:text-anvil-400">No matching file.</li> : null}
          {hits.map((hit, i) => (
            <li key={hit.path} id={optionId(i)} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)}>
              <Link
                href={hrefOf(hit.path)}
                // The input keeps focus (and the arrow keys) while the list is open.
                tabIndex={-1}
                onClick={onOpen}
                className={cn(
                  'block truncate px-3 py-1.5 font-mono text-[12px] text-anvil-600 coarse:min-h-11 coarse:py-3 dark:text-anvil-300',
                  i === active && 'bg-anvil-100 dark:bg-anvil-800',
                )}
                data-testid="go-to-file-result"
              >
                <Marked hit={hit} />
              </Link>
            </li>
          ))}
          {walkInUse && walk.data?.truncated ? (
            <li className="px-3 py-1.5 text-[11px] text-anvil-500 dark:text-anvil-400">Searched the first {plural(walk.data.files.length, 'file')}.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * `t` on a code page without a finder of its own (QW2-043): Go to file in a dialog, listing the
 * files of the commit (or tree) the page shows, each opened at the page's ref. Renders nothing
 * until `t` is pressed, and reads nothing until then either.
 */
export function GoToFileHotkey({
  reader,
  repo,
  tip,
  addr,
  refParam,
}: {
  reader: ObjectReader & { readonly memoScope?: object }
  repo: RepoRef
  /** The page's commit (or tree); a tag of a blob has no files to list. */
  tip: PeeledTip
  addr: RepoAddress
  /** The `?ref=` the results open at (a commit's own id on a commit page). */
  refParam: string
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const listable = tip.type !== 'blob'
  useEffect(() => {
    if (!listable) return
    const onKey = (e: KeyboardEvent): void => {
      if (!isPageShortcut(e, 't')) return
      e.preventDefault()
      setOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [listable])
  const rootTree = useCallback(() => rootTreeOf(reader, tip), [reader, tip])
  if (!open) return null
  return (
    <Dialog open onClose={() => setOpen(false)} title="Go to file" className="max-w-lg">
      <GoToFile reader={reader} repoKey={repoKey(repo)} tipOid={tip.oid} rootTree={rootTree} addr={addr} refParam={refParam} inDialog onOpen={() => setOpen(false)} />
    </Dialog>
  )
}
