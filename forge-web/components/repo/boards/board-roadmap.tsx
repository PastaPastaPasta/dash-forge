'use client'

/**
 * The roadmap layout of a board (design `docs/design/boards.md` §4.3): a timeline with one row
 * per scheduled item, its bar from its start date to its target date (`view.date` = two `date`
 * field ids) or across its iteration (`view.date` = one `iter` field id). Without `view.date` it
 * plots the board's first iteration field, else its first two date fields. Items with no date
 * are listed beside the timeline ("Unscheduled").
 *
 * - **Zoom**: weeks, months or quarters (this page's choice: a view does not save it).
 * - **Marks**: today's line, and the iteration bands of the plotted (or first) iteration field,
 *   the current one shaded.
 * - **Editing**: a bar opens the item panel, where its dates are edited. Members who place cards
 *   may also drag a date bar's ends (or the bar, to move both dates): one card write on release.
 * - **Access**: every bar is a button named by its item, dates and status; the timeline is also
 *   given as a plain list for screen readers. Rendered with plain DOM, no chart library.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CalendarRange, Lock } from 'lucide-react'
import { labelTextColor } from '@/lib/repo'
import { DAY_MS, ITER_INDEX_MAX, byRank, dateDays, dateOf, fieldById, groupRows, iterationAt, iterationRange, sortRows, type BoardField, type BoardItem, type BoardRow, type BoardSpec, type BoardView as SavedView } from '@/lib/rules/boards'
import { EmptyState } from '@/components/ui/states'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { cn } from '@/lib/utils'
import { GroupHeading, ItemStateIcon, columnName, dayRangeText } from './board-fields'
import { ItemRef } from './board-bits'
import type { BoardLayoutProps } from './layout-props'


export type Zoom = 'weeks' | 'months' | 'quarters'
export const ZOOMS: readonly { readonly key: Zoom; readonly label: string }[] = [
  { key: 'weeks', label: 'Weeks' },
  { key: 'months', label: 'Months' },
  { key: 'quarters', label: 'Quarters' },
]
/** Pixels per day at each zoom. */
const PX: Readonly<Record<Zoom, number>> = { weeks: 28, months: 6, quarters: 2 }
/** Days of margin around what is plotted, and the least span shown. */
const PAD: Readonly<Record<Zoom, number>> = { weeks: 7, months: 21, quarters: 45 }
const MIN_SPAN: Readonly<Record<Zoom, number>> = { weeks: 56, months: 150, quarters: 450 }
/** The label column's width. */
const LABEL_W = 256

/** What a roadmap plots: one iteration field, or a start and an end date field. */
export type RoadmapDates = { readonly kind: 'iter'; readonly field: BoardField } | { readonly kind: 'range'; readonly start: BoardField; readonly end: BoardField }

/** The fields a view's roadmap plots (§4.3): `view.date`, else the first iteration field, else the first two date fields; null for none. */
export function roadmapDates(spec: BoardSpec, view: SavedView): RoadmapDates | null {
  const ids = view.date ?? (() => {
    const iter = spec.fields.find((f) => f.type === 'iter')
    if (iter !== undefined) return [iter.id]
    const dates = spec.fields.filter((f) => f.type === 'date')
    return dates.length >= 2 ? [(dates[0] as BoardField).id, (dates[1] as BoardField).id] : []
  })()
  const fields = ids.map((id) => fieldById(spec, id))
  const [a, b] = fields
  if (fields.length === 1 && a?.type === 'iter') return { kind: 'iter', field: a }
  if (fields.length === 2 && a?.type === 'date' && b?.type === 'date') return { kind: 'range', start: a, end: b }
  return null
}

/**
 * An item's bar: its first and last day (day numbers, inclusive); `single` when only one date is
 * set; `swapped` when its start date is after its target date (the left end is then the target).
 */
export interface Bar {
  readonly start: number
  readonly end: number
  readonly single: boolean
  readonly swapped?: boolean
}

/** Where `row`'s bar runs, or null when it has no date to plot. */
export function barOf(row: BoardRow, dates: RoadmapDates): Bar | null {
  const f = row.placement.fields
  if (dates.kind === 'iter') {
    const k = f[String(dates.field.id)]
    const r = typeof k === 'number' ? iterationRange(dates.field, k) : null
    return r === null ? null : { start: r.startMs / DAY_MS, end: r.endMs / DAY_MS - 1, single: false }
  }
  const s = dateDays(f[String(dates.start.id)])
  const e = dateDays(f[String(dates.end.id)])
  if (s === null && e === null) return null
  if (s === null || e === null) {
    const d = (s ?? e) as number
    return { start: d, end: d, single: true }
  }
  return { start: Math.min(s, e), end: Math.max(s, e), single: false, ...(s > e ? { swapped: true } : {}) }
}

/** A day number as `YYYY-MM-DD`. */
const dayOf = (d: number): string => dateOf(d * DAY_MS)

/** The day number of the first day of the month `months` after the one holding day `d`. */
function monthStart(d: number, months = 0): number {
  const [y, m] = dayOf(d).split('-').map(Number) as [number, number]
  const t = y * 12 + (m - 1) + months
  return dateDays(`${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}-01`) as number
}

/** The first day of the period (week, month, quarter) holding day `d`. */
function periodStart(d: number, zoom: Zoom): number {
  if (zoom === 'weeks') return d - ((((d + 3) % 7) + 7) % 7)
  const m = monthStart(d)
  if (zoom === 'months') return m
  const month = Number(dayOf(m).slice(5, 7))
  return monthStart(m, -((month - 1) % 3))
}

/** The first day of the period after the one starting at `d`. */
function nextPeriod(d: number, zoom: Zoom): number {
  return zoom === 'weeks' ? d + 7 : monthStart(d, zoom === 'months' ? 1 : 3)
}

/** The plotted span: whole periods covering every bar, today and the current iteration, with a margin. */
export function timelineSpan(bars: readonly Bar[], today: number, zoom: Zoom): { readonly from: number; readonly to: number } {
  let lo = today
  let hi = today
  for (const b of bars) {
    lo = Math.min(lo, b.start)
    hi = Math.max(hi, b.end)
  }
  lo -= PAD[zoom]
  hi += PAD[zoom]
  if (hi - lo < MIN_SPAN[zoom]) hi = lo + MIN_SPAN[zoom]
  const from = periodStart(lo, zoom)
  let to = from
  while (to <= hi) to = nextPeriod(to, zoom)
  return { from, to }
}

/** The header's ticks: each period's start and label, and the coarser band above it (month or year). */
function ticks(from: number, to: number, zoom: Zoom): { readonly major: { day: number; label: string }[]; readonly minor: { day: number; label: string }[] } {
  const minor: { day: number; label: string }[] = []
  for (let d = from; d < to; d = nextPeriod(d, zoom)) {
    const date = dayOf(d)
    const label =
      zoom === 'weeks'
        ? String(Number(date.slice(8, 10)))
        : zoom === 'months'
          ? new Date(d * DAY_MS).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })
          : `Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`
    minor.push({ day: d, label })
  }
  const major: { day: number; label: string }[] = []
  for (let d = zoom === 'weeks' ? monthStart(from) : dateDays(`${dayOf(from).slice(0, 4)}-01-01`) as number; d < to; ) {
    const label = zoom === 'weeks' ? new Date(d * DAY_MS).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) : dayOf(d).slice(0, 4)
    major.push({ day: Math.max(d, from), label })
    d = zoom === 'weeks' ? monthStart(d, 1) : monthStart(d, 12)
  }
  return { major, minor }
}

/** A bar's words: the item, its dates and its status (a bar's name, and the list fallback's line). */
function barText(item: BoardItem, bar: Bar, status: string, priv: boolean): string {
  const who = priv ? 'A private item' : `#${item.number} ${item.title}`
  return `${who}: ${dayRangeText(dayOf(bar.start), dayOf(bar.end))}, ${status}`
}

/** A drag in progress: which bar, which part, where it started, and the days it has moved. */
interface Drag {
  readonly item: string
  readonly part: 'start' | 'end' | 'move'
  readonly x: number
  readonly bar: Bar
  readonly delta: number
  readonly moved: boolean
}

export function BoardRoadmap({ state, spec, view, items, rows, onOpenItem }: BoardLayoutProps): JSX.Element {
  const [zoom, setZoom] = useState<Zoom>('months')
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag
  const scrollRef = useRef<HTMLDivElement>(null)
  const dates = roadmapDates(spec, view)
  const hidden = state.items?.hidden
  const multiRepo = useMemo(() => new Set(items.map((i) => i.repoId)).size > 1, [items])
  const today = Math.floor(state.now / DAY_MS)
  const px = PX[zoom]

  const { scheduled, unscheduled } = useMemo(() => {
    if (dates === null) return { scheduled: [] as { row: BoardRow; bar: Bar }[], unscheduled: rows }
    const withBars = rows.map((row) => ({ row, bar: barOf(row, dates) }))
    const on = withBars.filter((x): x is { row: BoardRow; bar: Bar } => x.bar !== null)
    // A view's sort orders the rows; otherwise they run by start date.
    const order = view.sort !== undefined ? sortRows(on.map((x) => x.row), view.sort, spec).map((r) => r.item.id) : null
    const sorted = order !== null ? order.map((id) => on.find((x) => x.row.item.id === id) as { row: BoardRow; bar: Bar }) : [...on].sort((a, b) => a.bar.start - b.bar.start || a.bar.end - b.bar.end || byRank(a.row.placement, b.row.placement))
    return { scheduled: sorted, unscheduled: withBars.filter((x) => x.bar === null).map((x) => x.row) }
  }, [rows, dates, view.sort, spec])

  const groups = useMemo(() => {
    if (view.group === undefined) return [{ key: 'all', group: null as string | number | null, rows: scheduled }]
    const byId = new Map(scheduled.map((x) => [x.row.item.id, x]))
    return groupRows(
      scheduled.map((x) => x.row),
      view.group,
      spec,
      state.now,
    )
      .filter((g) => g.items.length > 0)
      .map((g) => ({ key: `g:${String(g.key)}`, group: g.key, rows: g.items.map((id) => byId.get(id) as { row: BoardRow; bar: Bar }) }))
  }, [scheduled, view.group, spec, state.now])

  const span = useMemo(() => timelineSpan(scheduled.map((x) => x.bar), today, zoom), [scheduled, today, zoom])
  const width = (span.to - span.from) * px
  const xOf = (day: number): number => (day - span.from) * px
  const { major, minor } = useMemo(() => ticks(span.from, span.to, zoom), [span, zoom])

  // The iteration bands: the plotted iteration field's, else the board's first.
  const iterField = dates?.kind === 'iter' ? dates.field : spec.fields.find((f) => f.type === 'iter')
  const bands = useMemo(() => {
    if (iterField === undefined) return []
    const first = iterationAt(iterField, span.from * DAY_MS) ?? 0
    const out = []
    for (let k = first; k <= ITER_INDEX_MAX; k++) {
      const r = iterationRange(iterField, k)
      if (r === null || r.startMs / DAY_MS >= span.to) break
      if (r.endMs / DAY_MS > span.from) out.push(r)
    }
    return out
  }, [iterField, span])
  const currentIter = iterField === undefined ? null : iterationAt(iterField, state.now)

  // Open on today, a quarter of the way in: the first time and on a zoom, never on a poll (which
  // must not scroll the page under the viewer).
  const todayX = useRef(0)
  todayX.current = xOf(today)
  useEffect(() => {
    const el = scrollRef.current?.parentElement
    if (el != null) el.scrollLeft = Math.max(0, todayX.current - (el.clientWidth - LABEL_W) / 4)
  }, [zoom])

  const canDrag = state.can.place && dates?.kind === 'range'
  // the pointer press a drag handled: the click that follows it does nothing more
  const pressHandled = useRef(false)

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, item: string, part: Drag['part'], bar: Bar): void => {
    pressHandled.current = false
    // a private item is not this reader's to change; a touch on the bar scrolls the timeline (its ends still drag)
    if (!canDrag || e.button !== 0 || hidden?.has(item) === true || (part === 'move' && e.pointerType === 'touch')) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag({ item, part, x: e.clientX, bar, delta: 0, moved: false })
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = dragRef.current
    if (d === null) return
    const dx = e.clientX - d.x
    const movedNow = d.moved || Math.abs(dx) > 4
    // nothing shifts before the move counts as a drag: a press that opens the item never shows one
    setDrag({ ...d, delta: movedNow ? Math.round(dx / px) : 0, moved: movedNow })
  }
  const onPointerUp = (row: BoardRow): void => {
    const d = dragRef.current
    setDrag(null)
    if (d === null || dates?.kind !== 'range') return
    pressHandled.current = true
    if (!d.moved) {
      onOpenItem(row.item.id)
      return
    }
    const next = moved(d)
    if (next.start === d.bar.start && next.end === d.bar.end) return
    const has = (f: BoardField): boolean => row.placement.fields[String(f.id)] !== undefined
    // the left end is the start date, unless the dates are the wrong way round
    const [left, right] = d.bar.swapped === true ? [dates.end, dates.start] : [dates.start, dates.end]
    const fields: Record<number, string> = {}
    if (next.start !== d.bar.start || (d.part === 'start' && !has(left))) fields[left.id] = dayOf(next.start)
    if (next.end !== d.bar.end || (d.part === 'end' && !has(right))) fields[right.id] = dayOf(next.end)
    // a single-date bar moved keeps to its one date
    if (d.bar.single && d.part === 'move') {
      for (const f of [dates.start, dates.end]) if (!has(f)) delete fields[f.id]
    }
    void state.write({ id: row.item.id, repoId: row.item.repoId }, { fields }).catch(() => undefined)
  }

  if (dates === null) {
    return (
      <div data-testid="board-roadmap">
        <EmptyState icon={CalendarRange} title="Nothing to plot yet" body="A roadmap plots an iteration field, or a start and a target date field. Add one in the board's settings." />
      </div>
    )
  }

  const rowCount = groups.reduce((n, g) => n + g.rows.length + (view.group !== undefined ? 1 : 0), 0)
  return (
    <div className="space-y-3" data-testid="board-roadmap">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          {dates.kind === 'iter' ? `By ${dates.field.name}` : `From ${dates.start.name} to ${dates.end.name}`}
        </p>
        <div role="group" aria-label="Zoom" className="flex items-center gap-0.5 rounded-md border border-anvil-200 p-0.5 text-dense dark:border-anvil-800">
          {ZOOMS.map((z) => (
            <button
              key={z.key}
              type="button"
              aria-pressed={zoom === z.key}
              onClick={() => setZoom(z.key)}
              className={cn(
                'rounded px-2.5 py-1 whitespace-nowrap coarse:min-h-11',
                zoom === z.key ? 'bg-anvil-100 font-medium text-anvil-900 dark:bg-anvil-800 dark:text-anvil-50' : 'text-anvil-600 hover:text-anvil-900 dark:text-anvil-300 dark:hover:text-anvil-50',
              )}
            >
              {z.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          {/* The visual timeline; the list below says the same for screen readers. */}
          <ScrollRegion label="Roadmap timeline" className="max-h-[calc(100vh-15rem)] overflow-auto rounded-lg border border-anvil-200 dark:border-anvil-800">
            <div ref={scrollRef} className="relative" style={{ width: LABEL_W + width }} role="group" aria-label="Timeline">
              {/* Header: the coarse band, the periods, the iterations. */}
              <div className="sticky top-0 z-20 flex border-b border-anvil-200 bg-anvil-50 dark:border-anvil-800 dark:bg-anvil-900" aria-hidden>
                <div className="sticky left-0 z-30 flex shrink-0 items-end border-r border-anvil-200 bg-anvil-50 px-3 pb-1 text-[12px] font-semibold text-anvil-600 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-300" style={{ width: LABEL_W }}>
                  Item
                </div>
                <div className="relative" style={{ width, height: bands.length > 0 ? 60 : 42 }}>
                  {major.map((t) => (
                    <span key={`M${t.day}`} className="absolute top-0 h-5 border-l border-anvil-300 pl-1.5 text-[11px] font-semibold leading-5 text-anvil-700 dark:border-anvil-700 dark:text-anvil-200" style={{ left: xOf(t.day) }}>
                      {t.label}
                    </span>
                  ))}
                  {minor.map((t) => (
                    <span key={`m${t.day}`} className="absolute top-5 h-5 border-l border-anvil-200 pl-1 text-[11px] leading-5 text-anvil-500 dark:border-anvil-800 dark:text-anvil-400" style={{ left: xOf(t.day) }}>
                      {t.label}
                    </span>
                  ))}
                  {bands.map((b) => (
                    <span
                      key={`b${b.index}`}
                      className={cn('absolute top-10 h-5 truncate border-l border-anvil-300 px-1 text-[11px] leading-5 dark:border-anvil-700', b.index === currentIter ? 'font-semibold text-anvil-900 dark:text-anvil-50' : 'text-anvil-500 dark:text-anvil-400')}
                      style={{ left: xOf(b.startMs / DAY_MS), width: (b.endMs - b.startMs) / DAY_MS * px }}
                      title={`${b.name}: ${dayRangeText(b.start, b.end)}`}
                    >
                      {b.name}
                    </span>
                  ))}
                  {/* a tick at the header's foot: a full-height line would cross the labels above it */}
                  <span className="absolute bottom-0 h-2 border-l-2 border-forge-600 dark:border-forge-400" style={{ left: xOf(today) + px / 2 }} />
                </div>
              </div>

              {/* Body: bands, period lines and today behind the rows. */}
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0" style={{ left: LABEL_W, width }} aria-hidden>
                  {bands.map((b) => (
                    <span
                      key={`B${b.index}`}
                      className={cn('absolute inset-y-0', b.index === currentIter ? 'bg-forge-500/[0.06]' : b.index % 2 === 0 ? 'bg-anvil-100/60 dark:bg-anvil-900/60' : '')}
                      style={{ left: xOf(b.startMs / DAY_MS), width: (b.endMs - b.startMs) / DAY_MS * px }}
                    />
                  ))}
                  {minor.map((t) => (
                    <span key={`l${t.day}`} className="absolute inset-y-0 border-l border-anvil-100 dark:border-anvil-850" style={{ left: xOf(t.day) }} />
                  ))}
                  <span className="absolute inset-y-0 border-l-2 border-forge-600 dark:border-forge-400" style={{ left: xOf(today) + px / 2 }} data-testid="roadmap-today" />
                </div>

                {scheduled.length === 0 ? (
                  <p className="sticky left-0 px-3 py-6 text-dense text-anvil-500 dark:text-anvil-400" style={{ width: LABEL_W + Math.min(width, 480) }}>
                    No item has a date yet. Items get one in the item panel.
                  </p>
                ) : null}

                {groups.map((g) => (
                  <div key={g.key} role="presentation">
                    {view.group !== undefined ? (
                      <div className="sticky left-0 z-10 flex h-8 items-center border-b border-anvil-200 bg-white px-3 text-dense font-semibold text-anvil-900 dark:border-anvil-800 dark:bg-anvil-950 dark:text-anvil-50" style={{ width: LABEL_W + Math.min(width, 640) }}>
                        <GroupHeading spec={spec} by={view.group} groupKey={g.group} items={items} />
                        <span className="ml-2 text-[12px] font-normal tabular-nums text-anvil-500 dark:text-anvil-400">{g.rows.length}</span>
                      </div>
                    ) : null}
                    {g.rows.map(({ row, bar }) => {
                      const { item, placement } = row
                      const priv = hidden?.has(item.id) === true
                      const col = spec.columns.find((c) => c.id === placement.col)
                      const d = drag?.item === item.id ? drag : null
                      const shown = d !== null ? moved(d) : bar
                      const left = xOf(shown.start)
                      const w = Math.max(px, (shown.end - shown.start + 1) * px)
                      const fill = col?.color
                      const ink = fill === undefined ? null : labelTextColor(fill)
                      const text = barText(item, shown, columnName(spec, placement.col), priv)
                      const narrow = w < 96
                      return (
                        <div key={`${g.key}:${item.id}`} className={cn('flex h-9 border-b border-anvil-100 dark:border-anvil-850', placement.archived !== null && 'opacity-60', state.pending.has(item.id) && 'opacity-70')} data-item={item.id}>
                          <div className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-anvil-200 bg-white px-3 dark:border-anvil-800 dark:bg-anvil-950" style={{ width: LABEL_W }}>
                            {priv ? <Lock className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden /> : <ItemStateIcon item={item} />}
                            <button type="button" tabIndex={-1} onClick={() => onOpenItem(item.id)} className={cn('min-w-0 truncate text-left text-dense hover:underline', priv ? 'italic text-anvil-500 dark:text-anvil-400' : 'text-anvil-900 dark:text-anvil-50')} title={priv ? undefined : item.title}>
                              {priv ? 'A private item' : item.title}
                            </button>
                            {!priv ? <ItemRef item={item} multiRepo={multiRepo} className="max-w-[7rem] shrink-0 text-[11px] text-anvil-500 dark:text-anvil-400" /> : null}
                          </div>
                          <div className="relative" style={{ width }}>
                            <button
                              type="button"
                              aria-label={text}
                              title={text}
                              data-testid="roadmap-bar"
                              onClick={() => {
                                // a press the drag handled (opened, or moved the bar) is done; a key, a tap or a plain click opens
                                if (pressHandled.current) {
                                  pressHandled.current = false
                                  return
                                }
                                onOpenItem(item.id)
                              }}
                              onPointerDown={(e) => onPointerDown(e, item.id, 'move', bar)}
                              onPointerMove={onPointerMove}
                              onPointerUp={() => onPointerUp(row)}
                              onPointerCancel={() => setDrag(null)}
                              className={cn(
                                'group/bar absolute top-1.5 flex h-6 items-center overflow-hidden rounded-md border text-left text-[12px] font-medium shadow-sm',
                                bar.single && 'rounded-full',
                                fill === undefined && 'border-anvil-300 bg-anvil-200 text-anvil-900 dark:border-anvil-600 dark:bg-anvil-700 dark:text-anvil-50',
                                fill !== undefined && 'border-black/10 dark:border-white/10',
                                canDrag && !priv && 'cursor-grab',
                                d?.moved === true && 'cursor-grabbing ring-2 ring-focus',
                              )}
                              style={{ left, width: w, ...(fill !== undefined ? { backgroundColor: fill, color: ink ?? undefined } : {}) }}
                            >
                              {canDrag && !priv && !bar.single ? (
                                <span aria-hidden onPointerDown={(e) => onPointerDown(e, item.id, 'start', bar)} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize touch-none opacity-0 group-hover/bar:bg-black/10 group-hover/bar:opacity-100" />
                              ) : null}
                              {!narrow ? <span className="truncate px-2">{priv ? 'A private item' : item.title}</span> : null}
                              {canDrag && !priv && !bar.single ? (
                                <span aria-hidden onPointerDown={(e) => onPointerDown(e, item.id, 'end', bar)} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize touch-none opacity-0 group-hover/bar:bg-black/10 group-hover/bar:opacity-100" />
                              ) : null}
                            </button>
                            {narrow && !priv ? (
                              <span className="pointer-events-none absolute top-1.5 truncate pl-1.5 text-[12px] leading-6 text-anvil-600 dark:text-anvil-300" style={{ left: left + w, maxWidth: 240 }} aria-hidden>
                                {item.title}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
                {rowCount === 0 ? null : <div className="h-2" />}
              </div>
            </div>
          </ScrollRegion>
        </div>

        <aside className="w-full shrink-0 rounded-lg border border-anvil-200 lg:w-64 dark:border-anvil-800" aria-label="Unscheduled items" data-testid="roadmap-unscheduled">
          <h3 className="flex items-center justify-between border-b border-anvil-200 bg-anvil-50 px-3 py-2 text-[12px] font-semibold text-anvil-600 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-300">
            Unscheduled <span className="font-normal tabular-nums text-anvil-500 dark:text-anvil-400">{unscheduled.length}</span>
          </h3>
          {unscheduled.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-anvil-500 dark:text-anvil-400">Every item has a date.</p>
          ) : (
            <ul className="max-h-[calc(100vh-18rem)] overflow-y-auto py-1">
              {unscheduled.map(({ item }) => {
                const priv = hidden?.has(item.id) === true
                return (
                  <li key={item.id}>
                    <button type="button" onClick={() => onOpenItem(item.id)} className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-dense hover:bg-anvil-50 dark:hover:bg-anvil-900 coarse:min-h-11">
                      {priv ? <Lock className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden /> : <ItemStateIcon item={item} />}
                      <span className={cn('min-w-0 flex-1 truncate', priv ? 'italic text-anvil-500 dark:text-anvil-400' : 'text-anvil-900 dark:text-anvil-50')}>{priv ? 'A private item' : item.title}</span>
                      {!priv ? <ItemRef item={item} multiRepo={multiRepo} className="max-w-[8rem] shrink-0 text-[11px] text-anvil-500 dark:text-anvil-400" /> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>
      </div>

      {/* The timeline as a list, for screen readers. */}
      <section className="sr-only" aria-label="Roadmap as a list" data-testid="roadmap-list">
        <ul>
          {scheduled.map(({ row, bar }) => (
            <li key={row.item.id}>{barText(row.item, bar, columnName(spec, row.placement.col), hidden?.has(row.item.id) === true)}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/** A dragged bar's days: its start, its end or both moved by the drag's days. */
function moved(d: Drag): Bar {
  const { bar, delta, part } = d
  if (part === 'move') return { ...bar, start: bar.start + delta, end: bar.end + delta }
  if (part === 'start') return { ...bar, start: Math.min(bar.start + delta, bar.end) }
  return { ...bar, end: Math.max(bar.end + delta, bar.start) }
}
