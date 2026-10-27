'use client'

/**
 * The table layout of a board (design `docs/design/boards.md` §4.2): one row per shown item,
 * one column per view key (`view.cols`, §2.7; without them Title, Status, Assignees, Labels and
 * every custom field), as GitHub's project table.
 *
 * - **Sort**: a header click asks the shell for `sort` (ascending, then descending, then the
 *   board order) through `onViewChange`; rows are ordered by the rules' `sortRows`.
 * - **Groups**: `view.group` makes sections (`groupRows`), each with its count, its WIP limit
 *   (Status) and the sum of the view's first number field (`sumFieldOf`, `totals`, §4.5).
 * - **Editing**: members who place cards (`state.can.place`) edit Status and the custom fields in
 *   place; each change is one card write (`state.write`, Status writes `col`), shown at once and
 *   taken back by the hook if refused. A private home's card for another repository's item asks
 *   first (§3.3).
 * - **Keyboard**: the body is a grid with one tab stop (roving tabindex): arrows, Home / End,
 *   Ctrl+Home / Ctrl+End and Page Up / Down move; Enter edits an editable cell or opens the item
 *   from any other; Escape cancels an edit.
 *
 * Archived items (a view with `is:archived`), items with a write in flight and private items
 * ("a private item", `BoardItemSet.hidden`) are marked on their row. Not virtualized: a board
 * reads at most a few hundred open items per source, which a plain table renders.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Archive, ArrowDown, ArrowUp, ArrowUpDown, Loader2, Lock, Table2 } from 'lucide-react'
import { crossRepoCardNeedsConfirm, type CardPatch, type LabelDef } from '@/lib/repo'
import { groupRows, sortRows, sumFieldOf, totals, type BoardItem, type BoardRow, type BoardSpec, type BoardView as SavedView, type FieldValue } from '@/lib/rules/boards'
import { AssigneeAvatars, LabelChip } from '@/components/repo/issue-bits'
import { Author } from '@/components/author'
import { EmptyState } from '@/components/ui/states'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { useConfirmAction } from '@/components/ui/confirm-action'
import { cn, shortId } from '@/lib/utils'
import { ColorDot, FieldInput, GroupHeading, ItemStateIcon, StatusSelect, dayText, fieldValueText, viewKeyLabel } from './board-fields'
import type { BoardLayoutProps } from './layout-props'

/** The table's columns: the view's `cols` with Title first, or Title, Status, Assignees, Labels and every custom field. */
export function tableColumns(spec: BoardSpec, view: SavedView): string[] {
  const cols = view.cols ?? ['title', 'status', 'assignees', 'labels', ...spec.fields.map((f) => `f${f.id}`)]
  return ['title', ...cols.filter((c) => c !== 'title')]
}

/** The `sort` a header click asks for: ascending, then descending, then none (the board order). */
export function nextSort(current: string | undefined, key: string): string | undefined {
  if (current === key) return `-${key}`
  if (current === `-${key}`) return undefined
  return key
}

/** The custom field a view key names, or undefined. */
function fieldOf(spec: BoardSpec, key: string) {
  const m = /^f(\d+)$/.exec(key)
  return m ? spec.fields.find((f) => f.id === Number(m[1])) : undefined
}

/** Whether a column's cells are edited in place (Status and the custom fields). */
function editableKey(spec: BoardSpec, key: string): boolean {
  return key === 'status' || fieldOf(spec, key) !== undefined
}

const STATE_WORD = { open: 'Open', closed: 'Closed', merged: 'Merged' } as const

/** A number as both clients print it (§2.7). */
function numText(n: number): string {
  return String(n)
}

interface Section {
  readonly key: string
  readonly group: string | number | null
  readonly rows: readonly BoardRow[]
}

export function BoardTable({ state, spec, view, items, placements, onOpenItem, onViewChange, home, labels }: BoardLayoutProps): JSX.Element {
  const cols = useMemo(() => tableColumns(spec, view), [spec, view])
  const hidden = state.items?.hidden
  const sumField = sumFieldOf(spec, view)
  const sumName = sumField === null ? null : (spec.fields.find((f) => f.id === sumField)?.name ?? null)
  const multiRepo = useMemo(() => new Set(items.map((i) => i.repoId)).size > 1, [items])
  const sections: Section[] = useMemo(() => {
    const rows = items.flatMap((item): BoardRow[] => {
      const placement = placements.get(item.id)
      return placement === undefined ? [] : [{ item, placement }]
    })
    const sorted = sortRows(rows, view.sort, spec)
    if (view.group === undefined) return [{ key: 'all', group: null, rows: sorted }]
    const byId = new Map(sorted.map((r) => [r.item.id, r]))
    return groupRows(sorted, view.group, spec, state.now).map((g) => ({ key: `g:${String(g.key)}`, group: g.key, rows: g.items.map((id) => byId.get(id) as BoardRow) }))
  }, [items, placements, view.sort, view.group, spec, state.now])
  // The grid's rows in order (an item in two groups, by assignee or label, is a row in each).
  const flat = useMemo(() => sections.flatMap((s) => s.rows.map((r) => ({ section: s.key, row: r }))), [sections])

  const [active, setActive] = useState({ r: 0, c: 0 })
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const refocus = useRef(false)
  const gridRef = useRef<HTMLTableElement>(null)
  const [confirm, confirmElement] = useConfirmAction()
  const r = Math.min(active.r, Math.max(0, flat.length - 1))
  const c = Math.min(active.c, cols.length - 1)

  const cellEl = (row: number, col: number): HTMLElement | null => gridRef.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`) ?? null
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    cellEl(r, c)?.focus()
  })

  const move = (row: number, col: number): void => {
    const nr = Math.max(0, Math.min(flat.length - 1, row))
    const nc = Math.max(0, Math.min(cols.length - 1, col))
    setActive({ r: nr, c: nc })
    cellEl(nr, nc)?.focus()
  }

  const canEdit = (item: BoardItem, key: string): boolean => state.can.place && hidden?.has(item.id) !== true && editableKey(spec, key)

  const write = async (item: BoardItem, patch: CardPatch): Promise<void> => {
    const board = state.board
    let confirmCrossRepo = false
    const homeRepo = home ?? (board === null ? null : { repoId: board.repoId, visibility: board.sealed ? 'private' : 'public' })
    if (homeRepo !== null && crossRepoCardNeedsConfirm(homeRepo, item.repoId)) {
      const ok = await confirm({
        title: 'Place an item of another repo',
        body: 'This board is in a private repo. Placing this item on it shows everyone that this repo tracks it.',
        confirmLabel: 'Place it',
        tone: 'primary',
      })
      if (!ok) return
      confirmCrossRepo = true
    }
    // A refusal is taken back and reported by the board (`state.refusal`).
    await state.write({ id: item.id, repoId: item.repoId }, patch, confirmCrossRepo ? { confirmCrossRepo } : undefined).catch(() => undefined)
  }

  const endEdit = (): void => {
    refocus.current = true
    setEditing(null)
  }

  const commit = (item: BoardItem, key: string, value: FieldValue | null | number): void => {
    endEdit()
    if (key === 'status') void write(item, { col: value as number })
    else {
      const field = fieldOf(spec, key)
      if (field !== undefined) void write(item, { fields: { [field.id]: value } })
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>): void => {
    if (editing !== null) return
    const target = e.target as HTMLElement
    if (target.dataset['cell'] === undefined) return
    const item = flat[r]?.row.item
    switch (e.key) {
      case 'ArrowDown':
        move(r + 1, c)
        break
      case 'ArrowUp':
        move(r - 1, c)
        break
      case 'ArrowRight':
        move(r, c + 1)
        break
      case 'ArrowLeft':
        move(r, c - 1)
        break
      case 'Home':
        move(e.ctrlKey || e.metaKey ? 0 : r, 0)
        break
      case 'End':
        move(e.ctrlKey || e.metaKey ? flat.length - 1 : r, cols.length - 1)
        break
      case 'PageDown':
        move(r + 10, c)
        break
      case 'PageUp':
        move(r - 10, c)
        break
      case 'Enter':
      case 'F2': {
        const key = cols[c] as string
        if (item !== undefined && canEdit(item, key)) setEditing({ r, c })
        else if (item !== undefined && e.key === 'Enter') onOpenItem(item.id)
        break
      }
      default:
        return
    }
    e.preventDefault()
  }

  const sortKey = view.sort?.replace(/^-/, '')
  const desc = view.sort?.startsWith('-') === true

  if (flat.length === 0) {
    return <EmptyState icon={Table2} title="No items match" body="Items this view's filter matches show here, one per row." />
  }

  let rowIndex = -1
  return (
    <div data-testid="board-table">
      <ScrollRegion label="Board table" className="max-h-[calc(100vh-14rem)] min-h-[12rem] overflow-auto rounded-lg border border-anvil-200 dark:border-anvil-800">
        <table ref={gridRef} role="grid" aria-label="Board items" aria-rowcount={flat.length + 1} aria-colcount={cols.length} className="w-full border-separate border-spacing-0 text-dense" onKeyDown={onKeyDown}>
          <thead>
            <tr role="row">
              {cols.map((key, ci) => {
                const sorted = sortKey === key
                const label = viewKeyLabel(spec, key)
                const sortable = key !== 'labels' && key !== 'assignees' && key !== 'state'
                const Icon = sorted ? (desc ? ArrowDown : ArrowUp) : ArrowUpDown
                return (
                  <th
                    key={key}
                    role="columnheader"
                    scope="col"
                    aria-sort={sorted ? (desc ? 'descending' : 'ascending') : undefined}
                    className={cn(
                      'sticky top-0 z-20 h-9 whitespace-nowrap border-b border-anvil-200 bg-anvil-50 px-3 text-left text-[12px] font-semibold text-anvil-600 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-300',
                      ci === 0 && 'left-0 z-30 min-w-[18rem] border-r',
                    )}
                  >
                    {sortable && onViewChange !== undefined ? (
                      <button
                        type="button"
                        onClick={() => onViewChange({ sort: nextSort(view.sort, key) })}
                        className="group inline-flex items-center gap-1 rounded hover:text-anvil-900 dark:hover:text-anvil-50 coarse:min-h-11"
                        aria-label={`Sort by ${label}${sorted ? (desc ? ', descending' : ', ascending') : ''}`}
                        data-testid={`sort-${key}`}
                      >
                        {label}
                        <Icon className={cn('h-3 w-3', sorted ? 'text-anvil-800 dark:text-anvil-100' : 'opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60')} aria-hidden />
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          {sections.map((s) => {
            const t = totals(s.rows, sumField)
            const wip = view.group === 'status' ? (spec.columns.find((col) => col.id === s.group)?.wip ?? null) : null
            const over = wip !== null && t.count > wip
            return (
              <tbody key={s.key} data-testid="board-table-section">
                {view.group !== undefined ? (
                  <tr role="row">
                    <th role="rowheader" scope="rowgroup" colSpan={cols.length} className="sticky left-0 border-b border-anvil-200 bg-white px-3 py-2 text-left font-semibold text-anvil-900 dark:border-anvil-800 dark:bg-anvil-950 dark:text-anvil-50">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <GroupHeading spec={spec} by={view.group} groupKey={s.group} items={items} />
                        <span className={cn('text-[12px] font-normal tabular-nums', over ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')} data-testid="section-count">
                          {wip !== null ? `${t.count} / ${wip}` : t.count}
                          {over ? <span className="sr-only"> (over its limit)</span> : null}
                        </span>
                        {t.sum !== null && sumName !== null ? (
                          <span className="text-[12px] font-normal text-anvil-500 dark:text-anvil-400" data-testid="section-sum">
                            {sumName}: <span className="font-mono tabular-nums text-anvil-700 dark:text-anvil-200">{numText(t.sum)}</span>
                          </span>
                        ) : null}
                      </span>
                    </th>
                  </tr>
                ) : null}
                {s.rows.map(({ item, placement }) => {
                  rowIndex++
                  const ri = rowIndex
                  const priv = hidden?.has(item.id) === true
                  const pending = state.pending.has(item.id)
                  return (
                    <tr
                      key={`${s.key}:${item.id}`}
                      role="row"
                      aria-rowindex={ri + 2}
                      data-item={item.id}
                      className={cn('group/row', placement.archived !== null && 'text-anvil-500 dark:text-anvil-400', pending && 'opacity-70')}
                      aria-busy={pending || undefined}
                    >
                      {cols.map((key, ci) => {
                        const isActive = ri === r && ci === c
                        const isEditing = editing !== null && editing.r === ri && editing.c === ci
                        const editable = canEdit(item, key)
                        return (
                          <td
                            key={key}
                            role="gridcell"
                            tabIndex={isActive && !isEditing ? 0 : -1}
                            data-cell={`${ri}:${ci}`}
                            aria-readonly={editable ? undefined : true}
                            onFocus={() => {
                              if (!isActive) setActive({ r: ri, c: ci })
                            }}
                            onClick={() => {
                              setActive({ r: ri, c: ci })
                              if (editable) setEditing({ r: ri, c: ci })
                              else onOpenItem(item.id)
                            }}
                            className={cn(
                              'h-9 max-w-[20rem] cursor-pointer border-b border-anvil-100 px-3 align-middle outline-none group-hover/row:bg-anvil-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-offset-0 focus-visible:ring-focus dark:border-anvil-850 dark:group-hover/row:bg-anvil-900',
                              ci === 0 && 'sticky left-0 z-10 border-r border-r-anvil-200 bg-white dark:border-r-anvil-800 dark:bg-anvil-950',
                              isEditing && 'px-1.5',
                            )}
                          >
                            {isEditing ? (
                              <EditCell spec={spec} item={item} keyName={key} value={key === 'status' ? placement.col : placement.fields[String(fieldOf(spec, key)?.id)]} now={state.now} onCommit={(v) => commit(item, key, v)} onCancel={endEdit} />
                            ) : (
                              <Cell spec={spec} item={item} keyName={key} placement={placement} priv={priv} pending={pending} multiRepo={multiRepo} labels={home === undefined || item.repoId === home.repoId ? labels : undefined} />
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            )
          })}
        </table>
      </ScrollRegion>
      {confirmElement}
    </div>
  )
}

/** The editor of one cell: the Status select, or the field's input. */
function EditCell({ spec, item, keyName, value, now, onCommit, onCancel }: { spec: BoardSpec; item: BoardItem; keyName: string; value: FieldValue | number | undefined; now: number; onCommit: (v: FieldValue | null) => void; onCancel: () => void }): JSX.Element | null {
  const label = `${viewKeyLabel(spec, keyName)} of #${item.number}`
  if (keyName === 'status') return <StatusSelect spec={spec} value={value as number} label={label} autoFocus onChange={onCommit} onCancel={onCancel} className="py-0.5" />
  const field = fieldOf(spec, keyName)
  if (field === undefined) return null
  return <FieldInput field={field} value={value} now={now} label={label} autoFocus onCommit={onCommit} onCancel={onCancel} className="py-0.5" />
}

/** One cell as read. */
function Cell({ spec, item, keyName, placement, priv, pending, multiRepo, labels }: { spec: BoardSpec; item: BoardItem; keyName: string; placement: BoardRow['placement']; priv: boolean; pending: boolean; multiRepo: boolean; labels: ReadonlyMap<string, LabelDef> | undefined }): JSX.Element | null {
  const muted = 'text-anvil-500 dark:text-anvil-400'
  switch (keyName) {
    case 'title':
      return (
        <span className="flex min-w-0 items-center gap-2">
          {priv ? <Lock className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden /> : <ItemStateIcon item={item} />}
          <span className={cn('min-w-0 truncate', priv ? 'italic text-anvil-500 dark:text-anvil-400' : 'font-medium text-anvil-900 dark:text-anvil-50')} title={priv ? undefined : item.title}>
            {priv ? 'A private item' : item.title}
          </span>
          {!priv ? (
            <span className={cn('shrink-0 font-mono text-[12px]', muted)}>
              {multiRepo && item.repo !== undefined ? `${item.repo}#${item.number}` : `#${item.number}`}
            </span>
          ) : null}
          {placement.archived !== null ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-anvil-300 px-1.5 text-[11px] text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="archived-badge">
              <Archive className="h-3 w-3" aria-hidden /> Archived
            </span>
          ) : null}
          {pending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" aria-hidden />
              <span className="sr-only">Saving</span>
            </>
          ) : null}
        </span>
      )
    case 'number':
      return <span className={cn('font-mono tabular-nums', muted)}>#{item.number}</span>
    case 'repo':
      return <span className="font-mono">{item.repo ?? shortId(item.repoId)}</span>
    case 'state':
      return <span>{priv ? '' : STATE_WORD[item.state]}</span>
    case 'author':
      return priv || item.author === '' ? null : <Author identityId={item.author} link={false} />
    case 'assignees':
      return <AssigneeAvatars ids={item.assignees} />
    case 'labels':
      return (
        <span className="flex min-w-0 flex-wrap gap-1 overflow-hidden">
          {item.labels.map((l) => (
            <LabelChip key={l} name={l} def={labels?.get(l)} />
          ))}
        </span>
      )
    case 'milestone':
      return <span className="truncate">{item.milestone ?? ''}</span>
    case 'created':
      return <span className={cn('whitespace-nowrap', muted)}>{priv ? '' : dayText(new Date(item.createdAt).toISOString().slice(0, 10))}</span>
    case 'status': {
      const col = spec.columns.find((x) => x.id === placement.col)
      return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <ColorDot color={col?.color} />
          <span className={cn('truncate', col === undefined && muted)}>{col?.name ?? 'No status'}</span>
        </span>
      )
    }
    default: {
      const field = fieldOf(spec, keyName)
      if (field === undefined) return null
      const v = placement.fields[String(field.id)]
      const text = fieldValueText(field, v)
      if (field.type === 'sel' && v !== undefined) {
        const opt = field.options?.find((o) => o.id === v)
        return (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <ColorDot color={opt?.color} />
            <span className="truncate">{text}</span>
          </span>
        )
      }
      return <span className={cn('block truncate', field.type === 'num' && 'text-right font-mono tabular-nums')}>{text}</span>
    }
  }
}
