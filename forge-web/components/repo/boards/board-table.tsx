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
 *   taken back by the hook if refused. The shell's guarded state asks before a private home's
 *   card for another repository's item (§3.3). A closed item's Status offers no column before
 *   Done, where it shows whatever its card says (§2.4).
 * - **Keyboard**: the body is a grid with one tab stop (roving tabindex): arrows, Home / End,
 *   Ctrl+Home / Ctrl+End and Page Up / Down move; Enter edits an editable cell or opens the item
 *   from any other; Escape cancels an edit. The cell in focus and the one being edited are named
 *   by (section, item, column), never by position, so a poll that adds or moves a row never moves
 *   an edit onto another item.
 *
 * Archived items (a view with `is:archived`), items with a write in flight and private items
 * ("a private item", `BoardItemSet.hidden`) are marked on their row. Not virtualized: a board
 * reads at most a few hundred open items per source, which a plain table renders.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Archive, ArrowDown, ArrowUp, ArrowUpDown, Loader2, Lock, Table2 } from 'lucide-react'
import type { CardPatch, LabelDef } from '@/lib/repo'
import { dateOf, fieldById, fieldOfKey, groupRows, sortKeyOk, sortRows, sumFieldOf, totals, type BoardItem, type BoardRow, type BoardSpec, type BoardView as SavedView, type FieldValue } from '@/lib/rules/boards'
import { AssigneeAvatars, LabelChip } from '@/components/repo/issue-bits'
import { Author } from '@/components/author'
import { EmptyState } from '@/components/ui/states'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { cn, shortId } from '@/lib/utils'
import { DotLabel, FieldInput, GroupHeading, ItemStateIcon, StatusSelect, dayText, fieldValueText, viewKeyLabel } from './board-fields'
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

/** Whether a column's cells are edited in place (Status and the custom fields). */
function editableKey(spec: BoardSpec, key: string): boolean {
  return key === 'status' || fieldOfKey(spec.fields, key) !== undefined
}

const STATE_WORD = { open: 'Open', closed: 'Closed', merged: 'Merged' } as const

interface Section {
  readonly key: string
  readonly group: string | number | null
  readonly rows: readonly BoardRow[]
}

/** A cell: its section, its item and its column key. */
interface CellRef {
  readonly section: string
  readonly item: string
  readonly col: string
}

const sameCell = (a: CellRef | null, b: CellRef): boolean => a !== null && a.section === b.section && a.item === b.item && a.col === b.col

export function BoardTable({ state, spec, view, rows, items, onOpenItem, onViewChange, home, labels }: BoardLayoutProps): JSX.Element {
  const cols = useMemo(() => tableColumns(spec, view), [spec, view])
  const hidden = state.items?.hidden
  const sumField = sumFieldOf(spec, view)
  const sumName = sumField === null ? null : (fieldById(spec, sumField)?.name ?? null)
  const multiRepo = useMemo(() => new Set(items.map((i) => i.repoId)).size > 1, [items])
  const sections: Section[] = useMemo(() => {
    const sorted = sortRows(rows, view.sort, spec)
    if (view.group === undefined) return [{ key: 'all', group: null, rows: sorted }]
    const byId = new Map(sorted.map((r) => [r.item.id, r]))
    return groupRows(sorted, view.group, spec, state.now).map((g) => ({ key: `g:${String(g.key)}`, group: g.key, rows: g.items.map((id) => byId.get(id) as BoardRow) }))
  }, [rows, view.sort, view.group, spec, state.now])
  // The grid's rows in order (an item in two groups, by assignee or label, is a row in each).
  const flat = useMemo(() => sections.flatMap((s) => s.rows.map((r) => ({ section: s.key, row: r }))), [sections])

  const [active, setActive] = useState<CellRef | null>(null)
  const [editing, setEditing] = useState<CellRef | null>(null)
  const refocus = useRef(false)
  const gridRef = useRef<HTMLTableElement>(null)
  // The cell in focus by position: the active one while its row is shown, else the first.
  const at = (() => {
    const r = active === null ? -1 : flat.findIndex((f) => f.section === active.section && f.row.item.id === active.item)
    const c = active === null ? -1 : cols.indexOf(active.col)
    return { r: Math.max(0, r), c: Math.max(0, c) }
  })()
  const cellAt = (r: number, c: number): CellRef | null => {
    const f = flat[r]
    const col = cols[c]
    return f === undefined || col === undefined ? null : { section: f.section, item: f.row.item.id, col }
  }
  const cellEl = (ref: CellRef | null): HTMLElement | null => {
    if (ref === null) return null
    // matched by dataset, not a selector: a section's key holds a label or milestone name as is
    const row = [...(gridRef.current?.querySelectorAll<HTMLElement>('tr[data-item]') ?? [])].find((tr) => tr.dataset['section'] === ref.section && tr.dataset['item'] === ref.item)
    return [...(row?.querySelectorAll<HTMLElement>('td[data-col]') ?? [])].find((td) => td.dataset['col'] === ref.col) ?? null
  }

  // After an edit ends with Enter, Escape or a pick, its editor is gone and focus with it: put it
  // back on the cell. An edit ended by leaving it (Tab, a click elsewhere) leaves focus there.
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    const target = cellAt(at.r, at.c)
    const t = setTimeout(() => {
      const a = document.activeElement
      if (a === null || a === document.body) cellEl(target)?.focus()
    }, 0)
    return () => clearTimeout(t)
  })

  const move = (r: number, c: number): void => {
    const next = cellAt(Math.max(0, Math.min(flat.length - 1, r)), Math.max(0, Math.min(cols.length - 1, c)))
    if (next === null) return
    setActive(next)
    cellEl(next)?.focus()
  }

  const canEdit = (item: BoardItem, key: string): boolean => state.can.place && hidden?.has(item.id) !== true && editableKey(spec, key)

  const endEdit = (): void => {
    refocus.current = true
    setEditing(null)
  }

  const commit = (item: BoardItem, key: string, value: FieldValue | null): void => {
    endEdit()
    const patch: CardPatch | null = key === 'status' ? { col: value as number } : (() => {
      const field = fieldOfKey(spec.fields, key)
      return field === undefined ? null : { fields: { [field.id]: value } }
    })()
    // A refusal is taken back and reported by the board (`state.refusal`).
    if (patch !== null) void state.write({ id: item.id, repoId: item.repoId }, patch).catch(() => undefined)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>): void => {
    if (editing !== null) return
    const target = e.target as HTMLElement
    if (target.dataset['col'] === undefined) return
    const { r, c } = at
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
        if (item !== undefined && canEdit(item, key)) setEditing(cellAt(r, c))
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

  const focusAt = cellAt(at.r, at.c)
  return (
    <div data-testid="board-table">
      <ScrollRegion label="Board table" className="max-h-[calc(100vh-14rem)] min-h-[12rem] overflow-auto rounded-lg border border-anvil-200 dark:border-anvil-800">
        <table ref={gridRef} role="grid" aria-label="Board items" aria-colcount={cols.length} className="w-full border-separate border-spacing-0 text-dense" onKeyDown={onKeyDown}>
          <thead>
            <tr role="row">
              {cols.map((key, ci) => {
                const sorted = sortKey === key
                const label = viewKeyLabel(spec, key)
                const sortable = sortKeyOk(spec.fields, key)
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
                            {sumName}: <span className="font-mono tabular-nums text-anvil-700 dark:text-anvil-200">{String(t.sum)}</span>
                          </span>
                        ) : null}
                      </span>
                    </th>
                  </tr>
                ) : null}
                {s.rows.map(({ item, placement }) => {
                  const priv = hidden?.has(item.id) === true
                  const pending = state.pending.has(item.id)
                  return (
                    <tr
                      key={`${s.key}:${item.id}`}
                      role="row"
                      data-section={s.key}
                      data-item={item.id}
                      className={cn('group/row', placement.archived !== null && 'text-anvil-500 dark:text-anvil-400', pending && 'opacity-70')}
                      aria-busy={pending || undefined}
                    >
                      {cols.map((key, ci) => {
                        const here: CellRef = { section: s.key, item: item.id, col: key }
                        const isActive = focusAt !== null && sameCell(focusAt, here)
                        const isEditing = sameCell(editing, here)
                        const editable = canEdit(item, key)
                        return (
                          <td
                            key={key}
                            role="gridcell"
                            tabIndex={isActive && !isEditing ? 0 : -1}
                            data-col={key}
                            aria-readonly={editable ? undefined : true}
                            onFocus={() => {
                              if (!isActive) setActive(here)
                            }}
                            onClick={() => {
                              setActive(here)
                              if (isEditing) return
                              if (editable) setEditing(here)
                              else onOpenItem(item.id)
                            }}
                            className={cn(
                              'h-9 max-w-[20rem] cursor-pointer border-b border-anvil-100 px-3 align-middle outline-none group-hover/row:bg-anvil-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-offset-0 focus-visible:ring-focus dark:border-anvil-850 dark:group-hover/row:bg-anvil-900',
                              ci === 0 && 'sticky left-0 z-10 border-r border-r-anvil-200 bg-white dark:border-r-anvil-800 dark:bg-anvil-950',
                              isEditing && 'px-1.5',
                            )}
                          >
                            {isEditing ? (
                              <EditCell spec={spec} item={item} keyName={key} value={key === 'status' ? placement.col : placement.fields[String(fieldOfKey(spec.fields, key)?.id)]} now={state.now} onCommit={(v) => commit(item, key, v)} onCancel={endEdit} />
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
    </div>
  )
}

/** The editor of one cell: the Status select, or the field's input. */
function EditCell({ spec, item, keyName, value, now, onCommit, onCancel }: { spec: BoardSpec; item: BoardItem; keyName: string; value: FieldValue | undefined; now: number; onCommit: (v: FieldValue | null) => void; onCancel: () => void }): JSX.Element | null {
  const label = `${viewKeyLabel(spec, keyName)} of #${item.number}`
  if (keyName === 'status') return <StatusSelect spec={spec} value={value as number} closed={item.state !== 'open'} label={label} autoFocus onChange={onCommit} onCancel={onCancel} className="py-0.5" />
  const field = fieldOfKey(spec.fields, keyName)
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
          {!priv ? <span className={cn('shrink-0 font-mono text-[12px]', muted)}>{multiRepo && item.repo !== undefined ? `${item.repo}#${item.number}` : `#${item.number}`}</span> : null}
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
      return <span className={cn('whitespace-nowrap', muted)}>{priv ? '' : dayText(dateOf(item.createdAt))}</span>
    case 'status': {
      const col = spec.columns.find((x) => x.id === placement.col)
      return (
        <DotLabel color={col?.color} className={col === undefined ? muted : undefined}>
          {col?.name ?? 'No status'}
        </DotLabel>
      )
    }
    default: {
      const field = fieldOfKey(spec.fields, keyName)
      if (field === undefined) return null
      const v = placement.fields[String(field.id)]
      const text = fieldValueText(field, v)
      if (field.type === 'sel' && v !== undefined) return <DotLabel color={field.options?.find((o) => o.id === v)?.color}>{text}</DotLabel>
      return <span className={cn('block truncate', field.type === 'num' && 'text-right font-mono tabular-nums')}>{text}</span>
    }
  }
}
