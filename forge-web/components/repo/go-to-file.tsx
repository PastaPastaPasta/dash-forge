'use client'

/**
 * Go to file (QW-028): GitHub's file finder on the repo home and every directory. Fuzzy matching
 * ({@link fuzzyRank}: `netproc` finds `src/net_processing.cpp`), the arrow keys and Enter to open
 * a result, Escape to leave, and `t` anywhere on the page to start typing.
 *
 * The list comes from the history index first: the index the file list's column already loaded
 * names every path at the tip, so the first results need no read at all. The tree walk the
 * language bar shares ({@link repoFilesWalk}, its reads in parallel) starts on first focus and,
 * once done, is the list: it is exact where an index a delta extends can still name a deleted file.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import type { ObjectReader } from '@/lib/view/tree-nav'
import { indexedFilePaths, repoFilesWalk } from '@/lib/view/repo-facts'
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
}: {
  reader: ObjectReader & { readonly memoScope?: object }
  repoKey: string
  tipOid: string
  /** The tip's root tree, read when the walk starts. */
  rootTree: () => Promise<string>
  addr: RepoAddress
  refParam: string
  className?: string
}): JSX.Element {
  const [started, setStarted] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const router = useRouter()
  // The index's list (no read when the column already loaded it), then the walk's exact one.
  const indexed = useAsync(() => indexedFilePaths(reader, tipOid), [key, tipOid], { enabled: started })
  const walk = useAsync(async () => repoFilesWalk(key, tipOid, reader, await rootTree()), [key, tipOid], { enabled: started })
  const paths = useMemo(() => walk.data?.files.map((f) => f.path) ?? indexed.data ?? null, [walk.data, indexed.data])
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

  // A new query starts from its best match.
  useEffect(() => setActive(0), [q])

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
      router.push(hrefOf(hit.path))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setQuery('')
      input.current?.blur()
    }
  }

  const searching = paths === null && (walk.loading || indexed.loading || !started)
  const open = q !== ''
  return (
    <div className={cn('relative w-full sm:w-56', className)}>
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
        className="h-8 py-1 pl-8 pr-7"
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
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Files"
          className="absolute right-0 z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-anvil-200 bg-white py-1 shadow-lg dark:border-anvil-750 dark:bg-anvil-900 sm:w-96"
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
          {walk.data?.truncated ? (
            <li className="px-3 py-1.5 text-[11px] text-anvil-500 dark:text-anvil-400">Searched the first {plural(walk.data.files.length, 'file')}.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
