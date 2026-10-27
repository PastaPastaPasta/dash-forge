'use client'

/**
 * The board page (`/repo/board?owner=&name=&b=<key>`, `docs/design/boards.md` §4, §5): the shell
 * every layout renders in. It reads the board (`useBoard`, polled while visible), and owns:
 *
 * - the header: name, description, Closed, refresh, Settings for members who edit boards;
 * - the view: the saved views as tabs, the URL's unsaved changes over one (`?view=&q=&group=
 *   &lane=&sort=&layout=`, a shareable cut), Save view (members who edit boards) and Reset;
 * - the filter: the board query (§4.4; qualifiers that name nothing here are listed under the box,
 *   `@me` is the signed-in identity), grouping, swimlanes and sort pickers, Show archived
 *   (`is:archived`), and "Load older closed items";
 * - the current iteration's dates and progress, with "Move open items to the next iteration"
 *   (§5.4, priced first);
 * - a refused write's reason (the card is back where it was), with the re-rank it may need;
 * - the item panel (§5.5), deep-linked as `&item=<id>`.
 *
 * It filters the items and hands the layout the view, the shown items and their placements
 * (`layout-props.ts`); the board layout is `board-kanban.tsx`, the table and roadmap `board-table.tsx`
 * and `board-roadmap.tsx`. Writes go through the write guard first (`use-guarded-board.ts`).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowDownUp, CalendarRange, KanbanSquare, Lock, RefreshCw, Search, Settings2, Table2, X } from 'lucide-react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button, buttonClass } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useBoard, useBoardsDeployed, type BoardHookState } from '@/hooks/use-board'
import { BoardsUnavailable } from './boards-list'
import { useParam, withTrailingSlash, type RepoAddress } from '@/hooks/use-query-param'
import { useSearchParams } from '@/hooks/use-route'
import { useSdk } from '@/hooks/use-sdk'
import { useUiStore } from '@/hooks/use-ui-store'
import { BoardWriteError, boardTextBytes, nextIterationPlan, ownRevision, readBoardDefinition, readLabels, repoContractIds, repoKey, type LabelDef, type RepoRef } from '@/lib/repo'
import { cachedDpnsName } from '@/lib/view/dpns'
import {
  fieldById,
  fieldKeyId,
  iterationAt,
  iterationProgress,
  iterationRange,
  MAX_VIEWS,
  parseBoardQuery,
  sumFieldOf,
  type BoardField,
  type BoardRow,
  type BoardSpec,
  type BoardView as SavedView,
  type Placement,
  type ViewLayout,
} from '@/lib/rules/boards'
import { priceBoardWrites } from '@/lib/sdk'
import type { RepoHome } from '@/lib/view'
import { cn, shortId } from '@/lib/utils'

import { boardSettingsHref, boardsHref, dayRangeText, viewKeyLabel } from './board-fields'
import { BulkActionDialog, cardCount, rerankAction, type BulkAction } from './board-dialogs'
import { BoardKanban } from './board-kanban'
import { BoardRoadmap } from './board-roadmap'
import { BoardTable } from './board-table'
import { ItemPanel } from './item-panel'
import type { BoardLayoutProps } from './layout-props'
import { useGuardedBoard } from './use-guarded-board'
import {
  ITEM_GROUP_KEYS,
  LAYOUTS,
  SORT_KEYS,
  VIEW_PARAMS,
  asksArchived,
  boardGroupOf,
  boardLaneOf,
  changeParams,
  effectiveView,
  laneOk,
  normalizeView,
  rankedColumn,
  readUrlView,
  savedViews,
  shownRows,
  withArchived,
} from './view-state'

const LAYOUT_ICON = { board: KanbanSquare, table: Table2, roadmap: CalendarRange } as const
const LAYOUT_NAME: Readonly<Record<ViewLayout, string>> = { board: 'Board', table: 'Table', roadmap: 'Roadmap' }

/** The page body: the board `b` of `home`. */
export function BoardPage({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const b = useParam('b')
  const key = /^\d{1,10}$/.test(b) ? Number(b) : 0
  // only where the network's forge-meta has the board types
  const deployed = useBoardsDeployed(home.repo.forge)
  if (deployed === null) return <LoadingBlock label="Reading the board" />
  if (!deployed) return <BoardsUnavailable />
  if (key < 1 || key > 4294967295) {
    return (
      <EmptyState
        icon={KanbanSquare}
        title="No board addressed"
        body="Pick a board from this repo's boards."
        action={
          <Link href={boardsHref(addr)} className={buttonClass({ variant: 'primary' })}>
            All boards
          </Link>
        }
      />
    )
  }
  return <BoardScreen key={`${repoKey(home.repo)}:${key}`} home={home} addr={addr} boardKey={key} />
}

function BoardScreen({ home, addr, boardKey }: { home: RepoHome; addr: RepoAddress; boardKey: number }): JSX.Element {
  const { network } = useSdk(repoContractIds(home.repo))
  // An item's repository as its card shows it: `owner/name`, the owner's name when known.
  const label = (r: RepoRef): string => `${r.repoId === home.repo.repoId ? addr.owner : (cachedDpnsName(network, r.ownerId) ?? shortId(r.ownerId))}/${r.name}`
  const raw = useBoard(home.repo, boardKey, { label })
  const [state, crossRepoDialog] = useGuardedBoard(raw, home.repo)

  if (state.loading) return <LoadingBlock label="Reading the board" />
  if (state.error !== null && state.board === null) return <ErrorState message={state.error} onRetry={state.refresh} />
  if (state.notFound || state.board === null) {
    return (
      <EmptyState
        icon={KanbanSquare}
        title="Board not found"
        body="No board with this number in this repo. It may have been deleted, or it is not visible yet."
        action={
          <Link href={boardsHref(addr)} className={buttonClass({ variant: 'primary' })}>
            All boards
          </Link>
        }
      />
    )
  }
  if (state.board.state === 'deleted') {
    return <EmptyState icon={KanbanSquare} title="This board was deleted" body="Its cards stay on Platform, but the board no longer shows." />
  }
  const spec = state.board.spec
  if (spec === null) {
    return state.board.specError === 'unreadable' ? (
      <EmptyState icon={Lock} title="Members-only board" body="This board is encrypted. Only members of this private repo can read it." />
    ) : (
      <ErrorState title="This board can't be shown" message="Its definition is not one this version of Forge reads. A member can fix it in the board's settings." onRetry={state.refresh} />
    )
  }
  return (
    <>
      <BoardLoaded home={home} addr={addr} state={state} spec={spec} />
      {crossRepoDialog}
    </>
  )
}

function BoardLoaded({ home, addr, state, spec }: { home: RepoHome; addr: RepoAddress; state: BoardHookState; spec: BoardSpec }): JSX.Element {
  const router = useRouter()
  const params = useSearchParams()
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  const board = state.board as NonNullable<typeof state.board>
  const url = readUrlView(params)
  const { base, view, dirty } = effectiveView(spec, url)
  const itemParam = params.get('item')
  const labelsRead = useAsync(() => readLabels(sdk!, home.repo), [ready, repoKey(home.repo)], { enabled: ready && sdk !== null })
  const labels = useMemo(() => new Map<string, LabelDef>((labelsRead.data ?? []).map((l) => [l.name, l])), [labelsRead.data])
  const [bulk, setBulk] = useState<BulkAction | null>(null)
  const [saving, setSaving] = useState(false)
  /** Whether the signer already has a revision of this board (Save view replaces it, else creates one). */
  const hasOwnRevision = identity !== null && ownRevision(board, identity) !== null

  /** Set or drop URL params (`null` drops one); `push` makes a history entry (opening an item). */
  const setParams = (changes: Readonly<Record<string, string | null>>, push = false): void => {
    const q = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) q.delete(k)
      else q.set(k, v)
    }
    const href = `${withTrailingSlash('/repo/board')}?${q.toString()}`
    if (push) router.push(href, { scroll: false })
    else router.replace(href, { scroll: false })
  }
  const resetView = (): Record<string, null> => Object.fromEntries(VIEW_PARAMS.map((p) => [p, null]))
  const onViewChange = (change: Partial<SavedView>): void => setParams(changeParams(change))

  const query = useMemo(() => parseBoardQuery(view.q, spec), [view.q, spec])
  const usesMe = query.preds.some((p) => (p.k === 'assignee' || p.k === 'author') && p.v === 'me')
  const rows = useMemo<BoardRow[]>(
    () => (state.fold === null || state.items === null ? [] : shownRows(state.items.items, state.fold, spec, query, { me: identity, now: state.now })),
    [state.fold, state.items, spec, query, identity, state.now],
  )
  const shownItems = useMemo(() => rows.map((r) => r.item), [rows])
  const placements = useMemo(() => new Map<string, Placement>(rows.map((r) => [r.item.id, r.placement])), [rows])
  const archived = asksArchived(view.q)

  // A view asking for archived items reads the older closed ones too (§2.4), once.
  const askedOlder = useRef(false)
  useEffect(() => {
    if (archived && state.items?.hasOlderClosed === true && !askedOlder.current) {
      askedOlder.current = true
      void state.loadOlderClosed().catch(() => undefined)
    }
  })
  const [loadingOlder, setLoadingOlder] = useState(false)

  const refusal = state.refusal
  const rerankCol = refusal?.error instanceof BoardWriteError && refusal.error.refusal === 're-rank' ? refusal.error.column : undefined

  /**
   * `fresh`'s views with the view in force saved over its saved one (or as the first view). The
   * definition is read fresh first: a column or field another member added meanwhile is kept, and
   * a view naming a field deleted meanwhile is saved without it.
   */
  const savedOver = (fresh: BoardSpec): SavedView[] => {
    const own = fresh.views.find((v) => v.id === base.id)
    if (own === undefined) return [...fresh.views, normalizeView(fresh, { ...view, id: Math.max(0, ...fresh.views.map((v) => v.id)) + 1, name: base.name })].slice(0, MAX_VIEWS)
    return fresh.views.map((v) => (v.id === base.id ? normalizeView(fresh, { ...view, id: v.id, name: v.name }) : v))
  }

  const layoutProps: BoardLayoutProps = {
    state,
    spec,
    view,
    items: shownItems,
    rows,
    placements,
    onOpenItem: (id) => setParams({ item: id }, true),
    onViewChange,
    home: home.repo,
    addr,
    labels,
  }
  const itemById = (id: string) => state.items?.items.find((i) => i.id === id)

  return (
    <div className="min-w-0 space-y-3" data-testid="board-page">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <nav aria-label="Breadcrumb" className="text-[12px] text-anvil-500 dark:text-anvil-400">
            <Link href={boardsHref(addr)} className="hit-area hover:text-forge-700 hover:underline dark:hover:text-forge-400">
              Boards
            </Link>
          </nav>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-anvil-900 dark:text-anvil-50">
            <span className="min-w-0 break-words">{board.name ?? 'Untitled board'}</span>
            {board.state === 'closed' ? (
              <span className="rounded-full border border-anvil-300 px-2 py-0.5 text-[11px] font-medium text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="board-closed">
                Closed
              </span>
            ) : null}
            {board.sealed ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-anvil-300 px-2 py-0.5 text-[11px] font-medium text-anvil-600 dark:border-anvil-700 dark:text-anvil-300">
                <Lock className="h-3 w-3" aria-hidden /> Members only
              </span>
            ) : null}
          </h1>
          {spec.desc !== undefined && spec.desc !== '' ? <p className="mt-0.5 max-w-3xl text-dense text-anvil-600 dark:text-anvil-300">{spec.desc}</p> : null}
        </div>
        <div className="flex items-center gap-1.5">
          {state.pending.size > 0 ? (
            <span className="text-[12px] text-anvil-500 dark:text-anvil-400" role="status">
              Saving {cardCount(state.pending.size)}…
            </span>
          ) : null}
          <Button variant="ghost" size="icon" onClick={state.refresh} aria-label="Refresh the board" title="Refresh">
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
          {state.can.edit ? (
            <Link href={boardSettingsHref(addr, board.key)} className={buttonClass({ variant: 'outline', size: 'sm' })} data-testid="board-settings-link">
              <Settings2 className="h-3.5 w-3.5" aria-hidden /> Settings
            </Link>
          ) : null}
        </div>
      </div>

      {board.state === 'closed' ? (
        <p role="note" className="rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-dense text-anvil-600 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-300">
          This board is closed. It is read-only until a member reopens it.
        </p>
      ) : signer === null ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="board-sign-in">
          Members move cards and edit fields.{' '}
          <button type="button" className="hit-area text-forge-700 hover:underline dark:text-forge-400" onClick={() => openLogin()}>
            Sign in
          </button>
        </p>
      ) : null}

      {/* Views */}
      <ViewTabs
        spec={spec}
        active={base.id}
        dirty={dirty}
        onPick={(id) => setParams({ ...resetView(), view: String(id), item: null })}
        actions={
          dirty ? (
            <div className="flex items-center gap-1.5 pb-1" data-testid="view-dirty">
              <Button variant="ghost" size="sm" onClick={() => setParams(resetView())}>
                Reset
              </Button>
              {state.can.edit && board.state === 'open' ? (
                <Button variant="outline" size="sm" onClick={() => setSaving(true)}>
                  Save view
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />

      {/* Filter bar */}
      <FilterBox q={view.q} onChange={(q) => setParams({ q })} />
      {query.unresolved.length > 0 ? (
        <p role="note" className="-mt-1 text-[12px] text-caution-700 dark:text-caution-400" data-testid="board-query-unresolved">
          Not applied: {query.unresolved.join(' ')}. They name nothing on this board.
        </p>
      ) : null}
      {usesMe && identity === null ? <p className="-mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">Sign in to filter by @me.</p> : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-dense">
        <LayoutPicker value={view.layout} onChange={(layout) => setParams({ layout: layout === base.layout ? null : layout })} />
        {view.layout !== 'roadmap' ? <GroupPicker spec={spec} view={view} onChange={(group) => onViewChange({ group })} /> : null}
        {view.layout === 'board' ? <LanePicker spec={spec} view={view} onChange={(lane) => onViewChange({ lane })} /> : null}
        {view.layout !== 'roadmap' ? <SortPicker spec={spec} value={view.sort} onChange={(sort) => onViewChange({ sort })} /> : null}
        <label className="inline-flex items-center gap-1.5 text-anvil-600 dark:text-anvil-300 coarse:min-h-11">
          <input type="checkbox" checked={archived} onChange={(e) => setParams({ q: withArchived(view.q, e.target.checked) })} className="accent-forge-600" data-testid="show-archived" />
          Show archived
        </label>
        <span className="ml-auto text-[12px] tabular-nums text-anvil-500 dark:text-anvil-400" data-testid="board-shown-count">
          {rows.length === 1 ? '1 item' : `${rows.length} items`}
        </span>
      </div>

      <IterationStrip spec={spec} view={view} state={state} onMove={setBulk} />

      {refusal !== null ? (
        <div role="alert" className="flex flex-wrap items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400" data-testid="board-refusal">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1 break-words">
            {refusal.message} {refusal.items.length > 0 ? 'The card is back where it was.' : ''}
          </p>
          {rerankCol !== undefined && state.fold !== null && state.can.place ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const name = spec.columns.find((c) => c.id === rerankCol)?.name ?? 'No status'
                const ranked = rankedColumn(state.fold!, { kind: 'status', col: rerankCol }, archived)
                setBulk(rerankAction(state, name, ranked.map((c) => ({ id: c.id, repoId: itemById(c.id)?.repoId ?? '' }))))
              }}
            >
              Re-rank column
            </Button>
          ) : null}
          <button type="button" aria-label="Dismiss" onClick={state.dismissRefusal} className="hit-area rounded p-0.5 hover:bg-danger/10">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
      {state.error !== null ? <p className="text-[12px] text-caution-700 dark:text-caution-400">The last refresh failed: {state.error}</p> : null}
      {state.items?.partial ? <p className="text-[12px] text-caution-700 dark:text-caution-400">Some open items may be missing: a source list could not be read to its end.</p> : null}

      {state.fold === null ? (
        <LoadingBlock label="Reading the board's items" />
      ) : view.layout === 'table' ? (
        <BoardTable {...layoutProps} />
      ) : view.layout === 'roadmap' ? (
        <BoardRoadmap {...layoutProps} />
      ) : (
        <BoardKanban {...layoutProps} />
      )}

      {state.items?.hasOlderClosed ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            loading={loadingOlder}
            onClick={async () => {
              setLoadingOlder(true)
              try {
                await state.loadOlderClosed()
              } finally {
                setLoadingOlder(false)
              }
            }}
            data-testid="load-older-closed"
          >
            Load older closed items
          </Button>
        </div>
      ) : null}

      {itemParam !== null && itemParam !== '' && state.items !== null ? (
        <ItemPanel state={state} spec={spec} itemId={itemParam} home={home.repo} addr={addr} labels={labels} onClose={() => setParams({ item: null })} />
      ) : null}

      <BulkActionDialog action={bulk} state={state} home={home.repo} onClose={() => setBulk(null)} />
      <ConfirmDialog
        open={saving}
        onClose={() => setSaving(false)}
        title={`Save view "${base.name}"`}
        description="Everyone who opens this board sees the view this way."
        cost={priceBoardWrites(hasOwnRevision ? 0 : 1, hasOwnRevision ? 1 : 0, { type: 'board', sealed: home.repo.visibility === 'private', bytes: boardTextBytes({ name: board.name ?? '', spec: { ...spec, views: savedOver(spec) } }) })}
        confirmLabel="Save view"
        successNote="View saved"
        onConfirm={async (intent) => {
          const fresh = sdk === null ? null : await readBoardDefinition(sdk, home.repo, board.key)
          if (fresh?.spec == null) throw new Error("This board can't be read right now. Reload and try again.")
          await state.save({ spec: { ...fresh.spec, views: savedOver(fresh.spec) } }, { intent })
          setParams(resetView())
        }}
      />
    </div>
  )
}

function ViewTabs({ spec, active, dirty, onPick, actions }: { spec: BoardSpec; active: number; dirty: boolean; onPick: (id: number) => void; actions: React.ReactNode }): JSX.Element {
  const views = savedViews(spec)
  return (
    <div className="flex flex-wrap items-end gap-x-3 border-b border-anvil-200 dark:border-anvil-800">
      <div role="tablist" aria-label="Views" className="-mb-px flex min-w-0 gap-1 overflow-x-auto [scrollbar-width:none]">
        {views.map((v) => {
          const Icon = LAYOUT_ICON[v.layout]
          const on = v.id === active
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onPick(v.id)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-dense coarse:min-h-11',
                on ? 'border-forge-600 font-medium text-anvil-900 dark:text-anvil-50' : 'border-transparent text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100',
              )}
              data-testid="view-tab"
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {v.name}
              {on && dirty ? (
                <>
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-forge-600 dark:bg-forge-400" />
                  <span className="sr-only">(unsaved changes)</span>
                </>
              ) : null}
            </button>
          )
        })}
      </div>
      <span className="ml-auto" />
      {actions}
    </div>
  )
}

/** The query box: filters as you type (the URL follows a moment later). */
function FilterBox({ q, onChange }: { q: string; onChange: (q: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(q)
  const last = useRef(q)
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  useEffect(() => {
    // Another control (Show archived, Reset, a view tab) changed the query: show it.
    if (q !== last.current) {
      last.current = q
      setDraft(q)
    }
  }, [q])
  useEffect(() => {
    if (draft === last.current) return
    const t = setTimeout(() => {
      last.current = draft
      changeRef.current(draft)
    }, 250)
    return () => clearTimeout(t)
  }, [draft])
  return (
    <form
      role="search"
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        last.current = draft
        onChange(draft)
      }}
    >
      <label htmlFor="board-filter" className="sr-only">
        Filter this board
      </label>
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <Input id="board-filter" value={draft} onChange={(e) => setDraft(e.target.value)} className="pl-8 font-mono text-[13px]" placeholder='status:"In progress" assignee:@me priority:P1' data-testid="board-filter" />
      </div>
      {draft !== '' ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft('')
            last.current = ''
            onChange('')
          }}
        >
          <X className="h-3.5 w-3.5" aria-hidden /> Clear
        </Button>
      ) : null}
    </form>
  )
}

const PICKER = 'rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11'

function LayoutPicker({ value, onChange }: { value: ViewLayout; onChange: (l: ViewLayout) => void }): JSX.Element {
  return (
    <div role="radiogroup" aria-label="Layout" className="inline-flex rounded-md border border-anvil-300 p-0.5 dark:border-anvil-700">
      {LAYOUTS.map((l) => {
        const Icon = LAYOUT_ICON[l]
        return (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={value === l}
            onClick={() => onChange(l)}
            className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 text-dense coarse:min-h-11', value === l ? 'bg-anvil-200 font-medium text-anvil-900 dark:bg-anvil-800 dark:text-anvil-50' : 'text-anvil-600 hover:text-anvil-900 dark:text-anvil-300 dark:hover:text-anvil-50')}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden /> {LAYOUT_NAME[l]}
          </button>
        )
      })}
    </div>
  )
}

/** The built-in item keys a grouping or swimlanes may use, named. */
function itemKeys(spec: BoardSpec): { key: string; name: string }[] {
  return ITEM_GROUP_KEYS.map((k) => ({ key: k, name: viewKeyLabel(spec, k) }))
}

function fieldKeys(spec: BoardSpec, types: readonly BoardField['type'][]): { key: string; name: string }[] {
  return spec.fields.filter((f) => types.includes(f.type)).map((f) => ({ key: `f${f.id}`, name: f.name }))
}

function GroupPicker({ spec, view, onChange }: { spec: BoardSpec; view: SavedView; onChange: (g: string) => void }): JSX.Element {
  const board = view.layout === 'board'
  const options = [{ key: 'status', name: 'Status' }, ...(board ? [] : itemKeys(spec)), ...fieldKeys(spec, ['sel', 'iter'])]
  const value = board ? boardGroupOf(spec, view) : (view.group ?? 'status')
  return (
    <label className="inline-flex items-center gap-1.5 text-anvil-600 dark:text-anvil-300">
      {board ? 'Columns' : 'Group'}
      <select value={value} onChange={(e) => onChange(e.target.value === 'status' ? '' : e.target.value)} className={PICKER} data-testid="group-picker">
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  )
}

function LanePicker({ spec, view, onChange }: { spec: BoardSpec; view: SavedView; onChange: (l: string) => void }): JSX.Element {
  const group = boardGroupOf(spec, view)
  const options = [...itemKeys(spec), ...fieldKeys(spec, ['sel', 'iter'])].filter((o) => laneOk(spec, o.key, group))
  const value = boardLaneOf(spec, view) ?? ''
  return (
    <label className="inline-flex items-center gap-1.5 text-anvil-600 dark:text-anvil-300">
      Swimlanes
      <select value={value} onChange={(e) => onChange(e.target.value)} className={PICKER} data-testid="lane-picker">
        <option value="">None</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  )
}

function SortPicker({ spec, value, onChange }: { spec: BoardSpec; value: string | undefined; onChange: (s: string) => void }): JSX.Element {
  const desc = value?.startsWith('-') === true
  const key = value === undefined ? 'rank' : desc ? value.slice(1) : value
  const options = [...SORT_KEYS.map((k) => ({ key: k, name: viewKeyLabel(spec, k) })), ...spec.fields.map((f) => ({ key: `f${f.id}`, name: f.name }))]
  return (
    <span className="inline-flex items-center gap-1">
      <label className="inline-flex items-center gap-1.5 text-anvil-600 dark:text-anvil-300">
        Sort
        <select value={key} onChange={(e) => onChange(e.target.value === 'rank' ? '' : `${desc ? '-' : ''}${e.target.value}`)} className={PICKER} data-testid="sort-picker">
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      {key !== 'rank' ? (
        <Button variant="ghost" size="icon" onClick={() => onChange(desc ? key : `-${key}`)} aria-label={desc ? 'Sorted descending: sort ascending' : 'Sorted ascending: sort descending'} title={desc ? 'Descending' : 'Ascending'}>
          <ArrowDownUp className={cn('h-4 w-4', desc && 'rotate-180')} aria-hidden />
        </Button>
      ) : null}
    </span>
  )
}

/**
 * The current iteration (§4.5): its dates, and done / total in items and points, of the view's
 * iteration field (its grouping or swimlanes when one is), else the board's first; with
 * "Move open items to the next iteration" for members (§5.4).
 */
function IterationStrip({ spec, view, state, onMove }: { spec: BoardSpec; view: SavedView; state: BoardHookState; onMove: (a: BulkAction) => void }): JSX.Element | null {
  const keyed = [view.group, view.lane].map((k) => (k === undefined ? null : fieldKeyId(k))).find((id) => id !== null && fieldById(spec, id)?.type === 'iter')
  const field = keyed != null ? fieldById(spec, keyed) : spec.fields.find((f) => f.type === 'iter')
  if (field === undefined || state.fold === null || state.items === null) return null
  const k = iterationAt(field, state.now)
  if (k === null) return null
  const range = iterationRange(field, k)
  if (range === null) return null
  const byId = new Map(state.items.items.map((i) => [i.id, i]))
  const rows: BoardRow[] = state.fold.items.filter((p) => p.on && p.archived === null && byId.has(p.id)).map((p) => ({ item: byId.get(p.id)!, placement: p }))
  const points = sumFieldOf(spec, view)
  const p = iterationProgress(rows, spec, field.id, k, points)
  const pct = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100)
  const plan = nextIterationPlan(spec, field.id, state.items.items, state.fold.items, state.now)
  const next = iterationRange(field, k + 1)
  const pointsName = points === null ? null : (fieldById(spec, points)?.name ?? null)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-anvil-200 px-3 py-2 text-dense dark:border-anvil-800" data-testid="iteration-strip">
      <span className="inline-flex items-center gap-1.5 font-medium text-anvil-900 dark:text-anvil-50">
        <CalendarRange className="h-4 w-4 text-fg-muted" aria-hidden />
        {range.name}
        <span className="font-normal text-anvil-500 dark:text-anvil-400">{dayRangeText(range.start, range.end)}</span>
      </span>
      <span className="inline-flex items-center gap-2 text-anvil-600 dark:text-anvil-300">
        <span className="h-1.5 w-28 overflow-hidden rounded-full bg-anvil-200 dark:bg-anvil-800" role="progressbar" aria-label={`${range.name} done`} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
          <span className="block h-full rounded-full bg-state-done" style={{ width: `${pct}%` }} />
        </span>
        <span className="tabular-nums" data-testid="iteration-progress">
          {p.done} of {p.total} done
          {p.points !== null && pointsName !== null ? ` · ${p.donePoints ?? 0} of ${p.points} ${pointsName}` : ''}
        </span>
      </span>
      {state.can.place && plan !== null && plan.items.length > 0 && next !== null ? (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() =>
            onMove({
              title: `Move open items to ${next.name}`,
              description: `Moves ${cardCount(plan.items.length)} still open in ${range.name}, outside Done, to ${next.name} (${dayRangeText(next.start, next.end)}).`,
              confirmLabel: `Move ${cardCount(plan.items.length)}`,
              items: plan.items,
              run: (opts) => state.moveOpenToNextIteration(field.id, opts),
              done: 'Moved to the next iteration',
            })
          }
          data-testid="move-to-next-iteration"
        >
          Move open items to {next.name}
        </Button>
      ) : null}
    </div>
  )
}
