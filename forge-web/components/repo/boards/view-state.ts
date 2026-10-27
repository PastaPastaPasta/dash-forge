/**
 * The board page's view state (`docs/design/boards.md` §4): which saved view is in force, the
 * unsaved changes the URL carries over it (`?view=&q=&group=&lane=&sort=&layout=&cols=&date=`),
 * which items it shows and how the board layout groups them. Pure, so the shell
 * (`board-page.tsx`) and the kanban (`board-kanban.tsx`) share one reading and tests pin it.
 */

import { searchTokens } from '@/lib/rules/search-terms'
import {
  LAYOUTS,
  byRank,
  fieldKeyId,
  groupKeyOk,
  groupRows,
  matchesBoardQuery,
  sortRows,
  type BoardFold,
  type BoardItem,
  type BoardQuery,
  type BoardRow,
  type BoardSpec,
  type BoardView as SavedView,
  type FieldValue,
  type Placement,
  type QueryContext,
  type RowGroup,
  type ViewLayout,
} from '@/lib/rules/boards'
import type { RankedCard } from '@/lib/repo'

/** The view a board with no saved views shows: the board layout, everything, by status. */
export const DEFAULT_VIEW: SavedView = { id: 0, name: 'Board', layout: 'board', q: '' }

/** Every layout a view may use, in the order the layout picker lists them (the rules' own list). */
export { LAYOUTS }

/** The built-in item keys (besides Status) a view may group by or split into swimlanes: the item's own facts. */
export const ITEM_GROUP_KEYS: readonly string[] = ['assignee', 'label', 'milestone', 'repo']

/** The view params the URL may carry (each an unsaved change over the saved view). */
export const VIEW_PARAMS = ['q', 'group', 'lane', 'sort', 'layout', 'cols', 'date'] as const

/** What the URL says about the view: the saved view's id, and each change over it (null: none). */
export interface BoardUrlView {
  readonly view: number | null
  readonly q: string | null
  readonly group: string | null
  readonly lane: string | null
  readonly sort: string | null
  readonly layout: ViewLayout | null
  readonly cols: readonly string[] | null
  readonly date: readonly number[] | null
}

/** Read the view params of a board URL. An empty `group`, `lane` or `sort` clears the saved one. */
export function readUrlView(params: { get(name: string): string | null }): BoardUrlView {
  const view = params.get('view')
  const layout = params.get('layout')
  const cols = params.get('cols')
  const date = params.get('date')
  return {
    view: view !== null && /^\d{1,3}$/.test(view) ? Number(view) : null,
    q: params.get('q'),
    group: params.get('group'),
    lane: params.get('lane'),
    sort: params.get('sort'),
    layout: layout !== null && (LAYOUTS as readonly string[]).includes(layout) ? (layout as ViewLayout) : null,
    cols: cols === null ? null : cols.split(',').filter((c) => c !== ''),
    date: date === null ? null : date.split(',').filter((d) => /^\d{1,3}$/.test(d)).map(Number),
  }
}

/** The board's saved views, or the one default view when it saved none. */
export function savedViews(spec: BoardSpec): readonly SavedView[] {
  return spec.views.length > 0 ? spec.views : [DEFAULT_VIEW]
}

/** Whether `key` may group the board layout's columns: Status, or a single-select or iteration field (§2.7). */
export function boardGroupOk(spec: BoardSpec, key: string): boolean {
  return groupKeyOk(spec.fields, key, true)
}

/** Whether `key` may split the board into swimlanes under grouping `group` (never Status, never the grouping). */
export function laneOk(spec: BoardSpec, key: string, group: string): boolean {
  return key !== 'status' && key !== group && groupKeyOk(spec.fields, key, false)
}

/** A copy of `v` with optional key `k` set to `value`, or left out when `value` is empty. */
function withKey(v: SavedView, k: 'group' | 'lane' | 'sort', value: string): SavedView {
  const { group, lane, sort, ...rest } = v
  const keys: Record<'group' | 'lane' | 'sort', string | undefined> = { group, lane, sort }
  keys[k] = value === '' ? undefined : value
  return {
    ...rest,
    ...(keys.group !== undefined ? { group: keys.group } : {}),
    ...(keys.lane !== undefined ? { lane: keys.lane } : {}),
    ...(keys.sort !== undefined ? { sort: keys.sort } : {}),
  }
}

/** The built-in keys a view may sort by. */
export const SORT_KEYS: readonly string[] = ['rank', 'title', 'number', 'created', 'status', 'repo', 'author', 'milestone']
/** The built-in columns a view may show. */
const COL_KEYS: readonly string[] = ['title', 'number', 'repo', 'state', 'author', 'assignees', 'labels', 'milestone', 'created', 'status']

/** Whether `key` names one of the board's custom fields (`f<id>`). */
function isField(spec: BoardSpec, key: string): boolean {
  const id = fieldKeyId(key)
  return id !== null && spec.fields.some((f) => f.id === id)
}

/**
 * `view` with every key the board's rules would refuse for its layout left out (§2.7): a grouping
 * the layout cannot use, swimlanes on Status or the grouping, a sort, column or date key naming no
 * field. A URL may say anything; what is shown, the pickers and what Save view writes agree.
 */
export function normalizeView(spec: BoardSpec, view: SavedView): SavedView {
  let v = view
  const groupOk = (k: string) => groupKeyOk(spec.fields, k, v.layout === 'board')
  if (v.group !== undefined && !groupOk(v.group)) v = withKey(v, 'group', '')
  if (v.lane !== undefined && !laneOk(spec, v.lane, v.group ?? 'status')) v = withKey(v, 'lane', '')
  if (v.sort !== undefined) {
    const k = v.sort.startsWith('-') ? v.sort.slice(1) : v.sort
    if (!SORT_KEYS.includes(k) && !isField(spec, k)) v = withKey(v, 'sort', '')
  }
  if (v.cols !== undefined) v = { ...v, cols: [...new Set(v.cols.filter((c) => COL_KEYS.includes(c) || isField(spec, c)))] }
  if (v.date !== undefined) {
    const types = v.date.map((d) => spec.fields.find((f) => f.id === d)?.type)
    const ok = (types.length === 1 && types[0] === 'iter') || (types.length === 2 && types[0] === 'date' && types[1] === 'date' && v.date[0] !== v.date[1])
    if (!ok) {
      const { date: _date, ...rest } = v
      v = rest
    }
  }
  return v
}

/** The view in force: the saved view the URL names (else the first), with the URL's changes over it. */
export interface EffectiveView {
  /** The saved view it starts from. */
  readonly base: SavedView
  /** The saved view with the URL's changes. */
  readonly view: SavedView
  /** The URL changes the saved view (Save view / Reset are offered). */
  readonly dirty: boolean
}

export function effectiveView(spec: BoardSpec, url: BoardUrlView): EffectiveView {
  const views = savedViews(spec)
  const base = views.find((v) => v.id === url.view) ?? (views[0] as SavedView)
  let view: SavedView = base
  if (url.layout !== null) view = { ...view, layout: url.layout }
  if (url.q !== null) view = { ...view, q: url.q }
  if (url.group !== null) view = withKey(view, 'group', url.group)
  if (url.lane !== null) view = withKey(view, 'lane', url.lane)
  if (url.sort !== null) view = withKey(view, 'sort', url.sort)
  if (url.cols !== null) view = { ...view, cols: url.cols }
  if (url.date !== null) view = { ...view, date: url.date }
  view = normalizeView(spec, view)
  return { base, view, dirty: !sameView(base, view) }
}

/** Whether two views say the same (name and id aside). */
export function sameView(a: SavedView, b: SavedView): boolean {
  const key = (v: SavedView) => JSON.stringify([v.layout, v.q, v.group ?? '', v.lane ?? '', v.sort ?? '', v.cols ?? null, v.date ?? null])
  return key(a) === key(b)
}

/** The URL params for a change to the view in force (`null` removes a param). */
export function changeParams(change: Partial<SavedView>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  if (change.layout !== undefined) out['layout'] = change.layout
  if (change.q !== undefined) out['q'] = change.q
  for (const k of ['group', 'lane', 'sort'] as const) if (k in change) out[k] = change[k] ?? ''
  if (change.cols !== undefined) out['cols'] = change.cols.join(',')
  if (change.date !== undefined) out['date'] = change.date.join(',')
  return out
}

/** The grouping the board layout uses for `view`: its own when the board layout takes it, else Status. */
export function boardGroupOf(spec: BoardSpec, view: SavedView): string {
  return view.group !== undefined && boardGroupOk(spec, view.group) ? view.group : 'status'
}

/** The swimlanes of `view` on the board layout, or null for none (or a key it may not use). */
export function boardLaneOf(spec: BoardSpec, view: SavedView): string | null {
  return view.lane !== undefined && laneOk(spec, view.lane, boardGroupOf(spec, view)) ? view.lane : null
}

/** Whether a query asks for archived items (`is:archived`, the "Show archived" toggle). */
export function asksArchived(q: string): boolean {
  return searchTokens(q).some((t) => t.toLowerCase() === 'is:archived')
}

/** `q` with `is:archived` added or removed. */
export function withArchived(q: string, on: boolean): string {
  const rest = searchTokens(q).filter((t) => t.toLowerCase() !== 'is:archived')
  return (on ? [...rest, 'is:archived'] : rest).join(' ')
}

/** The rows a query shows, in input order: items on the board that `query` matches (§4.4). */
export function shownRows(items: readonly BoardItem[], fold: BoardFold, spec: BoardSpec, query: BoardQuery, ctx: QueryContext): BoardRow[] {
  const byId = new Map(fold.items.map((p) => [p.id, p]))
  const rows: BoardRow[] = []
  for (const item of items) {
    const placement = byId.get(item.id)
    if (placement !== undefined && matchesBoardQuery(item, placement, spec, query, ctx)) rows.push({ item, placement })
  }
  return rows
}

/** What a kanban column is: a status column, or one value of the grouping field (null: "No <field>"). */
export type ColumnKey = { readonly kind: 'status'; readonly col: number } | { readonly kind: 'field'; readonly field: number; readonly value: FieldValue | null }

/** One kanban column: its key and its items (shown order) per lane. */
export interface KanbanColumn {
  readonly key: ColumnKey
  /** A stable string for React keys and DOM ids. */
  readonly id: string
  /** Item ids in shown order, all lanes. */
  readonly items: readonly string[]
}

/** One swimlane: its group key (null: "No <key>") and, per column id, its items in shown order. */
export interface KanbanLane {
  readonly key: string | number | null
  readonly id: string
  readonly cells: ReadonlyMap<string, readonly string[]>
}

export interface KanbanLayout {
  readonly group: string
  readonly lane: string | null
  readonly columns: readonly KanbanColumn[]
  /** The lanes; one lane keyed `''` with every item when the view has none. */
  readonly lanes: readonly KanbanLane[]
}

function columnKeyOf(group: string, key: string | number | null): ColumnKey {
  if (group === 'status') return { kind: 'status', col: typeof key === 'number' ? key : 0 }
  return { kind: 'field', field: fieldKeyId(group) as number, value: key }
}

/** A column's DOM-safe id. */
export function columnId(key: ColumnKey): string {
  return key.kind === 'status' ? `c${key.col}` : `f${key.field}-${key.value === null ? 'none' : String(key.value).replace(/[^0-9A-Za-z_-]/g, '_')}`
}

/**
 * The board layout of `rows` (§4.1): sorted by the view's sort (rank by default), grouped into
 * columns by Status or the view's single-select / iteration field (every column of the board, or
 * every option; "No status" / "No <field>" only while it holds an item), and split into the view's
 * swimlanes when it has some.
 */
export function kanbanLayout(rows: readonly BoardRow[], spec: BoardSpec, view: SavedView, now: number): KanbanLayout {
  const group = boardGroupOf(spec, view)
  const lane = boardLaneOf(spec, view)
  const sorted = sortRows(rows, view.sort, spec)
  const groups: RowGroup[] = groupRows(sorted, group, spec, now)
  const columns = groups.map((g) => {
    const key = columnKeyOf(group, g.key)
    return { key, id: columnId(key), items: g.items }
  })
  if (lane === null) return { group, lane, columns, lanes: [{ key: '', id: 'all', cells: new Map(columns.map((c) => [c.id, c.items])) }] }
  const lanes = groupRows(sorted, lane, spec, now).map((l, i) => {
    const inLane = new Set(l.items)
    return { key: l.key, id: `l${i}`, cells: new Map(columns.map((c) => [c.id, c.items.filter((id) => inLane.has(id))])) }
  })
  return { group, lane, columns, lanes }
}

/** Whether `placement` sits in column `key` (its column, or its value of the grouping field). */
export function inColumn(placement: Placement, key: ColumnKey): boolean {
  if (key.kind === 'status') return placement.col === key.col
  const v = placement.fields[String(key.field)]
  return key.value === null ? v === undefined : v === key.value
}

/**
 * Every item of column `key` on the board (any filter aside; archived ones only when `archived`),
 * in rank order, as a move ranks against them (§2.6).
 */
export function rankedColumn(fold: BoardFold, key: ColumnKey, archived = false): RankedCard[] {
  return fold.items
    .filter((p) => p.on && (archived || p.archived === null) && inColumn(p, key))
    .sort(byRank)
    .map((p) => ({ id: p.id, rank: p.rank }))
}

/**
 * The item a drop at `index` of `shown` (a column's shown items, the moving one left out) goes
 * just before, in the whole column `ranked`: the shown item at `index`, or past the last shown one
 * the item after it in the column (null: the bottom). So a filtered column drops exactly where
 * the viewer sees the gap.
 */
export function beforeOf(shown: readonly string[], ranked: readonly RankedCard[], index: number, moving: string): string | null {
  const others = shown.filter((id) => id !== moving)
  if (index < others.length) return others[index] as string
  const last = others[others.length - 1]
  if (last === undefined) return null
  const whole = ranked.filter((c) => c.id !== moving)
  const at = whole.findIndex((c) => c.id === last)
  return at < 0 ? null : (whole[at + 1]?.id ?? null)
}

/** Where a drop lands on the y axis: the index among cards whose vertical midpoints are `mids`. */
export function dropIndex(mids: readonly number[], y: number): number {
  const at = mids.findIndex((m) => y < m)
  return at < 0 ? mids.length : at
}
