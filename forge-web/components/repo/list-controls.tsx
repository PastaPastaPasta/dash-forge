'use client'

/**
 * The controls the Issues and Pull requests lists share (L-44): the search box with its qualifier
 * lookup ({@link useListQuery}), the state tabs, the label, person and sort filters, the "not
 * applied" note and the pager. Each list keeps its own query grammar (`lib/view/issue-query`,
 * `lib/view/pull-query`) and passes it in.
 */

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, MessageSquare, Search, SlidersHorizontal } from 'lucide-react'
import type { EvoSDK } from '@dashevo/evo-sdk'
import type { Network } from '@/lib/constants'
import type { LabelDef } from '@/lib/repo'
import { plural, resolveDpnsId } from '@/lib/view'
import { dpnsAuthorCandidates, Q_MAX, resolveSearchNames, withQuery } from '@/lib/view/issue-query'
import type { RepoAddress } from '@/hooks/use-query-param'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LabelChip } from '@/components/repo/issue-bits'
import { cn } from '@/lib/utils'

/** What a list tells {@link useListQuery} about its query grammar. */
export interface ListGrammar<Q> {
  /** The query as search-box text (qualifiers first). */
  readonly text: (q: Q) => string
  /** The box's text lifted onto `base`. */
  readonly parse: (text: string, base: Q) => Q
  /** The known qualifiers in `text` whose values could not be used. */
  readonly unresolved: (text: string) => string[]
  /** What a submit keeps of the current query (the state tab); every other filter is what the box says. */
  readonly submitBase: (q: Q) => Q
}

/** A list's search box state and its query changes, race-safe (L-43). */
export interface ListSearch<Q> {
  readonly value: string
  readonly setValue: (text: string) => void
  readonly submit: (e: FormEvent) => Promise<void>
  readonly searching: boolean
  /** Qualifiers typed (or linked in `?q=`) that could not be used: said, not silently dropped. */
  readonly dropped: readonly string[]
  /** DPNS names DPNS was asked for and does not know. */
  readonly notFound: readonly string[]
  /** Not connected yet, so a DPNS name could not be looked up. */
  readonly notReady: boolean
  /** A tab, filter or page change: wins over a name lookup still in flight. */
  readonly change: (c: Partial<Q>) => void
  /** Clear filters: back to the state tab alone, and the note goes with the filters. */
  readonly clear: () => void
}

/** What the box and its note read of a {@link ListSearch}, whatever the list's query type. */
export type SearchState = Omit<ListSearch<never>, 'change' | 'clear'>

/**
 * A list whose query lives in the URL (`parse` reads it, `toParams` writes it with
 * `router.replace`), with its search box: `author:` / `assignee:` DPNS names are resolved to
 * identity ids before the qualifiers are lifted (L-43), in a typed submit and, once connected, in
 * a linked `?q=`; the newest submit, tab, filter or page change wins, so an overtaken lookup
 * neither applies its result nor leaves the spinner on.
 */
export function useListQuery<Q extends { readonly page: number }>({
  addr,
  parse,
  toParams,
  grammar,
  sdk,
  ready,
  network,
}: {
  addr: RepoAddress
  parse: (params: { get(name: string): string | null; getAll(name: string): string[] }) => Q
  toParams: (q: Q) => [string, string][]
  grammar: ListGrammar<Q>
  sdk: EvoSDK | null
  ready: boolean
  network: Network
}): { query: Q; search: ListSearch<Q> } {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const query = useMemo(() => parse(params), [params, parse])
  const setQuery = (next: Q): void => {
    const q = new URLSearchParams({ owner: addr.owner, name: addr.name })
    if (addr.repoId) q.set('repo', addr.repoId)
    for (const [k, v] of toParams(next)) q.append(k, v)
    router.replace(`${pathname}?${q.toString()}`, { scroll: false })
  }
  // The linked `?q=`, capped as the query parsers cap it (a crafted link cannot force unbounded DPNS reads).
  const linkedQ = params.get('q')?.slice(0, Q_MAX) ?? null

  const [search, setSearch] = useState<string | null>(null)
  const [dropped, setDropped] = useState<readonly string[]>(() => grammar.unresolved(linkedQ ?? ''))
  const [notFound, setNotFound] = useState<readonly string[]>([])
  const [notReady, setNotReady] = useState(false)
  const [searching, setSearching] = useState(false)
  // Which lookup is current: an earlier one settling later is dropped; none touches state after unmount.
  const current = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const value = search ?? grammar.text(query)

  // `base` carries what `text` itself does not encode (a linked `?q=` beside its `label=`/`sort=` params).
  const resolveAndApply = async (text: string, base: Q): Promise<void> => {
    const id = ++current.current
    const stillWanted = (): boolean => mounted.current && current.current === id
    setNotReady(!sdk && dpnsAuthorCandidates(text).length > 0)
    setSearching(true)
    try {
      const resolved = sdk ? await resolveSearchNames(text, (name) => resolveDpnsId(sdk, name, network)) : { text, notFound: [] }
      if (!stillWanted()) return
      setDropped(grammar.unresolved(resolved.text))
      setNotFound(resolved.notFound)
      setQuery({ ...grammar.parse(resolved.text, base), page: base.page })
      // Back to the URL-driven text only if the box still holds what was submitted.
      setSearch((held) => (held === text ? null : held))
    } finally {
      if (stillWanted()) setSearching(false)
    }
  }

  // A DPNS name linked in `?q=` goes through the same lookup once connected, unless the viewer
  // changed the list meanwhile (the URL no longer holds that `q`).
  const pending = useRef(linkedQ)
  useEffect(() => {
    const raw = pending.current
    if (raw === null) return
    const hasNames = dpnsAuthorCandidates(raw).length > 0
    if (hasNames && (!ready || !sdk)) return
    pending.current = null
    if (hasNames && linkedQ === raw) void resolveAndApply(raw, query)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the SDK becomes ready; `pending` guards re-entry.
  }, [ready, sdk])

  const overtake = (): void => {
    current.current++
    setSearching(false)
  }
  return {
    query,
    search: {
      value,
      setValue: setSearch,
      submit: async (e) => {
        e.preventDefault()
        await resolveAndApply(value, grammar.submitBase(query))
      },
      searching,
      dropped,
      notFound,
      notReady,
      change: (c) => {
        overtake()
        setQuery(withQuery(query, c))
      },
      clear: () => {
        overtake()
        setDropped([])
        setNotFound([])
        setNotReady(false)
        setQuery(grammar.submitBase(query))
      },
    },
  }
}

/** The search form (a spinner while a name lookup runs). */
export function SearchBox({ id, label, search, placeholder }: { id: string; label: string; search: SearchState; placeholder: string }): JSX.Element {
  const Icon = search.searching ? Loader2 : Search
  return (
    <form onSubmit={search.submit} className="flex min-w-[16rem] flex-1 items-center gap-2" role="search">
      <label htmlFor={id} className="sr-only">{label}</label>
      <div className="relative flex-1">
        <Icon className={cn('pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-anvil-500 dark:text-anvil-400', search.searching && 'animate-spin')} aria-hidden />
        <Input id={id} value={search.value} onChange={(e) => search.setValue(e.target.value)} className="pl-8 font-mono text-[13px]" placeholder={placeholder} />
      </div>
    </form>
  )
}

/** The note under the box: the qualifiers not applied, and why (`reason`). */
export function DroppedNote({ search, reason, testId }: { search: SearchState; reason: string; testId: string }): JSX.Element | null {
  if (search.dropped.length === 0) return null
  return (
    <p role="note" className="mb-3 text-[12px] text-caution-700 dark:text-caution-400" data-testid={testId}>
      Not applied: {search.dropped.join(' ')}. {reason}
      {search.notReady ? ' Not connected yet, so a DPNS name could not be looked up — try again once connected.' : ''}
    </p>
  )
}

/** The sort select (newest, oldest, most commented). */
export function SortSelect<S extends 'newest' | 'oldest' | 'comments'>({ id, value, onChange }: { id: string; value: S; onChange: (s: S) => void }): JSX.Element {
  return (
    <>
      <label className="sr-only" htmlFor={id}>Sort</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as S)}
        className="rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
      >
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="comments">Most commented</option>
      </select>
    </>
  )
}

/** A count before a tab's name (nothing while not proven). */
export function tabCount(n: number | null | undefined): string {
  return n == null ? '' : `${n} `
}

/**
 * The state tabs' row. On a phone it stays one row (QW2-071: "All" wrapped onto a row of its
 * own): the tabs drop their icons below `sm`, as GitHub's underline nav does when it is short of
 * room, and the row scrolls sideways if counts still make it too wide (`p-1 -m-1`: room inside
 * the scroller for a tab's focus ring).
 */
export function StateTabs({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div
      className="-m-1 flex items-center gap-x-3 overflow-x-auto p-1 [scrollbar-width:none] max-sm:w-[calc(100%+0.5rem)] max-sm:gap-x-2 max-sm:[&_svg]:hidden [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label={label}
    >
      {children}
    </div>
  )
}

/** How many of the {@link FilterBar}'s shared controls are set away from their defaults. */
export function filterCount(q: {
  readonly labels: readonly string[]
  readonly milestone: string | null
  readonly noMilestone: boolean
  readonly author: string | null
  /** A mirrored `author:login`, which the Author select does not show. */
  readonly authorLogin: string | null
  readonly assignee: string | null
  readonly sort: string
}): number {
  return (
    q.labels.length +
    Number(q.milestone !== null || q.noMilestone) +
    Number(q.author !== null || q.authorLogin !== null) +
    Number(q.assignee !== null) +
    Number(q.sort !== 'newest')
  )
}

/**
 * The filters beside the state tabs. From `sm` up they sit in the row; on a phone they fold
 * behind one "Filters" button (with how many are set), so the first result is on the first
 * screen rather than under five rows of selects (QW2-071).
 */
export function FilterBar({ active, children }: { active: number; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md border border-anvil-300 px-2 py-1 text-dense dark:border-anvil-700 coarse:min-h-11 coarse:px-3 sm:hidden"
        data-testid="filters-toggle"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
        Filters{active > 0 ? ` (${active})` : ''}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      <div id={id} className={cn('w-full flex-wrap items-center gap-2 sm:ml-auto sm:flex sm:w-auto', open ? 'flex' : 'hidden')}>
        {children}
      </div>
    </>
  )
}

export function StateTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        // min-h-6 / min-w-6: 24 px with a mouse too (WCAG 2.5.8, QW2-071).
        'inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap text-dense font-medium transition-colors coarse:min-h-11 coarse:min-w-11',
        active ? 'text-anvil-900 dark:text-anvil-50' : 'text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100',
      )}
    >
      {children}
    </button>
  )
}

/** Label filter: a multi-select of the repo's defined labels (every selected label must match). */
export function LabelFilter({ labels, selected, onChange }: { labels: readonly LabelDef[]; selected: readonly string[]; onChange: (l: string[]) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const names = [...new Set([...labels.filter((l) => !l.retired).map((l) => l.name), ...selected])]
  const byName = new Map(labels.map((l) => [l.name, l]))
  const close = (): void => setOpen(false)
  return (
    // L-72: a backdrop (outside click) and an Escape handler (bubbles up from the trigger or any
    // option, whichever has focus) — this popover previously only ever toggled on the button.
    <div
      className="relative"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        close()
        triggerRef.current?.focus()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-anvil-300 px-2 py-1 text-dense dark:border-anvil-700 coarse:min-h-11 coarse:px-3"
      >
        Label{selected.length ? ` (${selected.length})` : ''}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={close} />
          <div role="listbox" aria-label="Filter by label" aria-multiselectable className="absolute right-0 z-20 mt-1 max-h-72 w-60 overflow-auto rounded-md border border-anvil-200 bg-white p-1 shadow-lg dark:border-anvil-750 dark:bg-anvil-950">
            {names.length === 0 ? <p className="px-2 py-1.5 text-dense text-anvil-500 dark:text-anvil-400">No labels defined.</p> : null}
            {names.map((n) => {
              const on = selected.includes(n)
              return (
                <button
                  key={n}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => onChange(on ? selected.filter((x) => x !== n) : [...selected, n])}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-dense hover:bg-anvil-100 dark:hover:bg-anvil-850 coarse:min-h-11"
                >
                  <input type="checkbox" readOnly checked={on} tabIndex={-1} aria-hidden className="accent-forge-600" />
                  <LabelChip name={n} def={byName.get(n)} />
                </button>
              )
            })}
          </div>
        </>
      ) : null}
    </div>
  )
}

/** Author / assignee filter: anyone, me, an identity id, or (assignee) nobody. */
export function PersonFilter({
  label,
  value,
  signedIn,
  allowNone,
  onChange,
}: {
  label: string
  value: string | null
  signedIn: boolean
  allowNone?: boolean
  onChange: (v: string | null) => void
}): JSX.Element {
  const choice = value === null ? '' : value === 'me' || value === 'none' ? value : 'id'
  const [id, setId] = useState(choice === 'id' ? value ?? '' : '')
  // L-42: `choice` only changes once a typed id is committed (blur/Enter), so picking "identity
  // id…" from the select needs its own flag — otherwise the select has nothing new to show and
  // snaps back to "anyone" with no input ever appearing.
  const [editingId, setEditingId] = useState(choice === 'id')
  const selectId = `filter-${label.toLowerCase()}`
  const idInputRef = useRef<HTMLInputElement>(null)
  // Set by the select's own onChange, just before it flips `editingId` true, so the effect below
  // only steals focus into the id box for that one user gesture — never for `value` arriving from
  // outside (a reload, "Clear filters", or a submitted `author:<id>` qualifier resolving here).
  const focusIdRef = useRef(false)

  // `value` can change from outside this component's own commit path (a reload, "Clear filters",
  // or a search-box `author:`/`assignee:` qualifier resolving to an id) — track id-entry mode off
  // `value` itself, not just the select's own onChange, or the id box can vanish while the select
  // still reads "identity id…" (or stay showing a stale one after an external reset).
  useEffect(() => {
    setEditingId(value !== null && value !== 'me' && value !== 'none')
    if (value === null) setId('')
    else if (value !== 'me' && value !== 'none') setId(value)
    // `value` changing from outside is never the select's own gesture; drop a stale flag so a
    // later, unrelated `editingId` transition can't steal focus for a gesture that already
    // happened (or never did).
    focusIdRef.current = false
  }, [value])

  useEffect(() => {
    if (!editingId || !focusIdRef.current) return
    focusIdRef.current = false
    idInputRef.current?.focus()
  }, [editingId])

  const commitId = (): void => {
    const next = id.trim() || null
    if (next !== value) onChange(next)
  }

  return (
    <span className="inline-flex items-center gap-1">
      <label htmlFor={selectId} className="text-dense text-anvil-600 dark:text-anvil-300">{label}</label>
      <select
        id={selectId}
        value={editingId ? 'id' : choice}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'id') {
            focusIdRef.current = true
            setEditingId(true)
            if (choice !== 'id') setId('')
          } else {
            setEditingId(false)
            onChange(v === '' ? null : v)
          }
        }}
        className="rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
      >
        <option value="">anyone</option>
        <option value="me" disabled={!signedIn}>me</option>
        {allowNone ? <option value="none">nobody</option> : null}
        <option value="id">identity id…</option>
      </select>
      {editingId ? (
        <Input
          ref={idInputRef}
          aria-label={`${label} identity id`}
          value={id}
          onChange={(e) => setId(e.target.value)}
          onBlur={commitId}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitId()
          }}
          className="h-7 w-44 py-0 font-mono text-[12px]"
          placeholder="base58 id"
        />
      ) : null}
    </span>
  )
}

export function Pager({
  page,
  hasNext,
  matching,
  pageSize,
  onPage,
  label,
}: {
  page: number
  hasNext: boolean
  /** Every matching row, when known: the page count. */
  matching: number | null
  pageSize: number
  onPage: (p: number) => void
  label: string
}): JSX.Element | null {
  if (page === 1 && !hasNext) return null
  const pages = matching === null ? null : Math.max(1, Math.ceil(matching / pageSize))
  // Past the last page (a stale or hand-edited `?page=`), Previous goes to the last one rather
  // than one back, and no "Page 9 of 6" is claimed (QW-068).
  const past = pages !== null && page > pages
  return (
    <nav aria-label={label} className="mt-4 flex items-center justify-center gap-3 text-dense">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(past ? pages : page - 1)}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Previous
      </Button>
      <span className="text-anvil-500 dark:text-anvil-400" data-testid="page-indicator">
        Page {page}
        {pages !== null && !past ? ` of ${pages}` : ''}
      </span>
      <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => onPage(page + 1)}>
        Next <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </nav>
  )
}

/**
 * The list body when `?page=` lies past the last page (QW-068): says so and offers the last page,
 * rather than the empty list's "nothing has been merged yet".
 */
export function PastLastPage({ page, last, onPage }: { page: number; last: number; onPage: (p: number) => void }): JSX.Element {
  return (
    <div className="px-4 py-8 text-center text-dense text-anvil-600 dark:text-anvil-300" data-testid="page-past-end">
      <p className="font-medium text-anvil-900 dark:text-anvil-50">There is no page {page}</p>
      <p className="mt-1 text-anvil-500 dark:text-anvil-400">This list has {plural(last, 'page')}.</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={() => onPage(last)}>
        Go to page {last}
      </Button>
    </div>
  )
}

/** What a milestone filter offers: the repo's milestones (open first), or null while they are read. */
export interface MilestoneChoice {
  readonly title: string
  readonly closed: boolean
}

/** The milestone filter (QW-018): any, none, or one of the repo's milestones (open ones first). */
export function MilestoneFilter({
  milestones,
  value,
  none,
  onChange,
}: {
  milestones: readonly MilestoneChoice[] | null
  value: string | null
  none: boolean
  onChange: (c: { milestone: string | null; noMilestone: boolean }) => void
}): JSX.Element {
  const known = milestones ?? []
  const open = known.filter((m) => !m.closed)
  const closed = known.filter((m) => m.closed)
  // A milestone named in the URL that the repo does not define (yet) stays selectable.
  const extra = value !== null && !known.some((m) => m.title === value) ? [value] : []
  return (
    <span className="inline-flex items-center gap-1">
      <label htmlFor="filter-milestone" className="text-dense text-anvil-600 dark:text-anvil-300">Milestone</label>
      <select
        id="filter-milestone"
        // A milestone's option is `m:<title>`, so no title can read as "any" or "none".
        value={none ? 'none' : value !== null ? `m:${value}` : ''}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === 'none' ? { milestone: null, noMilestone: true } : { milestone: v.startsWith('m:') ? v.slice(2) : null, noMilestone: false })
        }}
        className="max-w-[10rem] rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
      >
        <option value="">any</option>
        <option value="none">none</option>
        {[...extra, ...open.map((m) => m.title)].map((t) => (
          <option key={t} value={`m:${t}`}>{t}</option>
        ))}
        {closed.length > 0 ? (
          <optgroup label="Closed">
            {closed.map((m) => (
              <option key={m.title} value={`m:${m.title}`}>{m.title}</option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </span>
  )
}

/**
 * What `author:login` matched (QW-062): a name with no identity behind it is the login an
 * import recorded, so the list shows the items a trusted mirror imported from that author.
 */
export function AuthorLoginNote({ login, notFound }: { login: string | null; notFound: readonly string[] }): JSX.Element | null {
  if (login === null) return null
  const noName = notFound.some((n) => n.toLowerCase() === login.toLowerCase())
  return (
    <p role="note" className="mb-3 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="author-login-note">
      author:{login} matches items mirrored from @{login} on the source forge{noName ? ` (no DPNS name ${login}.dash exists)` : ''}.
    </p>
  )
}

/** "Searched the newest N of M …": a search or comment sort that looked at part of the repo. */
export function SearchedNote({ searchedOf, noun }: { searchedOf: { readonly searched: number; readonly total: number | null } | null | undefined; noun: string }): JSX.Element | null {
  if (!searchedOf) return null
  return (
    <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
      Searched the newest {searchedOf.searched}
      {searchedOf.total !== null ? ` of ${searchedOf.total}` : ''} {noun}; older ones were not read for this search.
    </p>
  )
}

/** A row's label chip that adds the label to the list's filter. */
export function LabelChipFilter({ name, def, selected, onChange }: { name: string; def: LabelDef | undefined; selected: readonly string[]; onChange: (labels: string[]) => void }): JSX.Element {
  return (
    <button type="button" onClick={() => onChange(selected.includes(name) ? [...selected] : [...selected, name])} aria-label={`Filter by label ${name}`} className="hit-area">
      <LabelChip name={name} def={def} />
    </button>
  )
}

/** A link to one row of a list (its title). */
export function RowLink({ href, title }: { href: string; title: string }): JSX.Element {
  return (
    <Link href={href} className="hit-area text-dense font-medium text-anvil-900 hover:text-forge-700 dark:text-anvil-50 dark:hover:text-forge-400">
      {title || '(untitled)'}
    </Link>
  )
}

/** A row's comment count (nothing when there are none). */
export function CommentCount({ n }: { n: number | null }): JSX.Element | null {
  if (!n) return null
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="comment-count">
      <MessageSquare className="h-3.5 w-3.5" aria-hidden /> <span aria-hidden>{n}</span>
      <span className="sr-only">{plural(n, 'comment')}</span>
    </span>
  )
}
