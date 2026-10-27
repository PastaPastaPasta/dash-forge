'use client'

/**
 * The board (kanban) layout (`docs/design/boards.md` §4.1, §5.2, §5.3): one column per status, or
 * per value of the view's single-select or iteration field; optional swimlanes; cards with the
 * item's repository (on a multi-repository board), number, title, state, labels, assignees and
 * the view's fields.
 *
 * Members move cards by dragging (mouse or pen anywhere on a card; on touch screens by the grip,
 * so a swipe elsewhere still scrolls the board) or from the keyboard: Space picks the focused
 * card up, the arrow keys move it, Space or Enter drops it, Escape puts it back, and a live region
 * says where it is. A move is one card write, shown at once and taken back with the reason when
 * refused (the shell's banner). Between swimlanes a card moves only when they are a single-select
 * or iteration field (the move sets it too); assignees, labels, milestones and repositories are
 * the item's own, changed on the item. Dropping into a column over its WIP limit warns and still
 * moves (§2.1). Readers, and everyone on a closed board, get the board without drag handles or
 * quick add.
 *
 * On a phone one column shows at a time, with a switcher of every column (a card dragged onto a
 * column's name moves there).
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, GripVertical, Loader2, Lock, MoreHorizontal } from 'lucide-react'

import { AssigneeAvatars, LabelChip } from '@/components/repo/issue-bits'
import { useDismiss } from '@/components/repo/target-rail'
import { useMinWidth } from '@/hooks/use-prefs'
import { toast } from '@/hooks/use-toasts'
import { rankBefore, type CardItem, type CardPatch, type LabelDef, type MoveTarget } from '@/lib/repo'
import {
  fieldById,
  fieldKeyId,
  iterationAt,
  iterationRange,
  sumFieldOf,
  totals,
  type BoardField,
  type BoardFold,
  type BoardItem,
  type BoardSpec,
  type FieldValue,
  type Placement,
} from '@/lib/rules/boards'
import { cn, shortId } from '@/lib/utils'

import { FieldChip, itemStateWords } from './board-bits'
import { ColorDot, GroupHeading, ItemStateIcon, dayRangeText, fieldValueText } from './board-fields'
import { BulkActionDialog, cardCount, rerankAction, type BulkAction } from './board-dialogs'
import type { BoardLayoutProps } from './layout-props'
import { QuickAdd, type QuickAddTarget } from './quick-add'
import { asksArchived, beforeOf, dropIndex, kanbanLayout, rankedColumn, type ColumnKey, type KanbanColumn, type KanbanLane } from './view-state'

/** A place a card may be dropped: a column, a swimlane, a position among its other cards. */
interface DropTarget {
  readonly col: number
  readonly lane: number
  readonly index: number
}

/** A cell of the board: a column of a swimlane. */
interface CellPos {
  readonly col: number
  readonly lane: number
}

/** A drag in progress. `invalid`: why the pointer's place takes no drop (another lane of a kind a move cannot set). */
interface Drag {
  readonly item: string
  readonly from: DropTarget
  readonly to: DropTarget
  readonly mode: 'pointer' | 'keyboard'
  readonly invalid: string | null
}

/** A column as shown: its name, colour, WIP limit and the key a move sets. */
interface ColumnMeta {
  readonly name: string
  readonly color?: string | undefined
  readonly wip: number | null
  readonly hint?: string | undefined
  readonly current?: boolean
}

/** Pixels from the board's edge at which a drag scrolls it, and how far each frame. */
const EDGE = 48
const SCROLL_STEP = 14
/** A mouse drag starts after the pointer moves this far (a click stays a click). */
const DRAG_SLOP = 4

const LANE_NONE: Readonly<Record<string, string>> = { assignee: 'No assignee', label: 'No label', milestone: 'No milestone', repo: 'No repo' }
const LANE_WHY: Readonly<Record<string, string>> = {
  assignee: 'Assignees are the item’s own. Change them in its panel.',
  label: 'Labels are the item’s own. Change them in its panel.',
  milestone: 'The milestone is the item’s own. Change it on the item.',
  repo: 'A card stays in its repo.',
}

function columnMeta(spec: BoardSpec, key: ColumnKey, now: number): ColumnMeta {
  if (key.kind === 'status') {
    const c = spec.columns.find((x) => x.id === key.col)
    return c === undefined ? { name: 'No status', wip: null } : { name: c.name, color: c.color, wip: c.wip ?? null }
  }
  const field = fieldById(spec, key.field)
  if (field === undefined) return { name: '?', wip: null }
  if (key.value === null) return { name: `No ${field.name}`, wip: null }
  if (field.type === 'sel') {
    const o = field.options?.find((x) => x.id === key.value)
    return { name: o?.name ?? '?', color: o?.color, wip: null }
  }
  const k = typeof key.value === 'number' ? key.value : null
  const range = k === null ? null : iterationRange(field, k)
  return { name: range?.name ?? String(key.value), wip: null, hint: range ? dayRangeText(range.start, range.end) : undefined, current: k !== null && iterationAt(field, now) === k }
}

/** The items of the board's own status column `key` (any filter aside; archived ones too), in the fold's order. */
function statusColumnItems(fold: BoardFold, key: Extract<ColumnKey, { kind: 'status' }>): readonly string[] {
  return fold.columns.find((c) => c.id === key.col)?.items ?? []
}

/** Whether two drags are at the same place with the same verdict (a pointer move that changes neither needs no render). */
function sameDrop(a: Drag, b: Drag): boolean {
  return a.to.col === b.to.col && a.to.lane === b.to.lane && a.to.index === b.to.index && a.invalid === b.invalid
}

/** The single-select or iteration field a lane key names (a move between its lanes sets it), else null. */
function laneField(spec: BoardSpec, lane: string | null): number | null {
  if (lane === null) return null
  const id = fieldKeyId(lane)
  return id !== null && fieldById(spec, id) !== undefined ? id : null
}

/** Whether `e` comes from inside a control of the card (none today; kept for links added later). */
function fromControl(e: { target: EventTarget | null; currentTarget: EventTarget }): boolean {
  const t = e.target as HTMLElement | null
  const c = t?.closest('a, button, input, select, textarea')
  return c != null && c !== e.currentTarget
}

export function BoardKanban(props: BoardLayoutProps): JSX.Element {
  const { state, spec, view, items, rows, placements, onOpenItem, home, labels } = props
  const fold = state.fold
  const wide = useMinWidth(640)
  const instructions = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag
  const [announcement, setAnnouncement] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [phoneCol, setPhoneCol] = useState(0)
  const [bulk, setBulk] = useState<BulkAction | null>(null)
  const suppressClick = useRef(false)
  /** A card to focus once it renders (after a keyboard drop it re-renders in its new column). */
  const focusAfter = useRef<(CellPos & { readonly id: string }) | null>(null)

  const canPlace = state.can.place
  const archivedShown = asksArchived(view.q)
  const sorted = view.sort !== undefined && view.sort !== 'rank'
  const layout = useMemo(() => kanbanLayout(rows, spec, view, state.now), [rows, spec, view, state.now])
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const hidden = state.items?.hidden
  const multiRepo = new Set(items.map((i) => i.repoId)).size > 1 || spec.sources.some((s) => s.r !== undefined && s.r !== home?.repoId)
  const sumField = sumFieldOf(spec, view)
  const sumName = sumField === null ? null : (fieldById(spec, sumField)?.name ?? null)
  const movableLane = laneField(spec, layout.lane)

  /** The cell's items as shown (a column of a lane). */
  const cell = (col: number, lane: number): readonly string[] => {
    const c = layout.columns[col]
    return c === undefined ? [] : (layout.lanes[lane]?.cells.get(c.id) ?? [])
  }

  // ---------------------------------------------------------------------------------------------
  // Moving
  // ---------------------------------------------------------------------------------------------

  const cardItem = (id: string): CardItem => ({ id, repoId: byId.get(id)?.repoId ?? '' })

  /**
   * Where the card of `item` in cell `pos` is. An item with two assignees or labels shows in two
   * swimlanes: each copy is its own place.
   */
  const locate = (item: string, pos: CellPos): DropTarget | null => {
    const index = cell(pos.col, pos.lane).indexOf(item)
    return index < 0 ? null : { ...pos, index }
  }
  /** The card element of `item` in cell `pos` (item ids are base58: nothing to quote). */
  const cardEl = (item: string, pos: CellPos): HTMLElement | null =>
    rootRef.current?.querySelector<HTMLElement>(`[data-drop-cell][data-col="${pos.col}"][data-lane="${pos.lane}"] [data-card-id="${item}"]`) ?? null

  const sameSpot = (a: DropTarget, b: DropTarget): boolean => a.col === b.col && a.lane === b.lane && (sorted || a.index === b.index)

  /** Why a drop from lane `from` into lane `to` cannot be taken, or null. */
  const laneRefusal = (from: number, to: number): string | null => (from === to || movableLane !== null ? null : (LANE_WHY[layout.lane ?? ''] ?? 'Cards cannot move between these swimlanes.'))

  /** What a move into `col` writes: its status column, or its value of the grouping field. */
  const moveTargetOf = (col: KanbanColumn): MoveTarget => (col.key.kind === 'status' ? { col: col.key.col } : { field: col.key.field, value: col.key.value })

  /** Sign the move of `item` to `to` (§5.2): one card write; the hook shows it at once and takes it back when refused. */
  const commit = (item: string, from: DropTarget, to: DropTarget): void => {
    if (fold === null || sameSpot(from, to)) return
    const column = layout.columns[to.col]
    if (column === undefined) return
    const ranked = rankedColumn(fold, column.key, archivedShown)
    // A position in the shown cell: before the card under the gap (a sorted view: the bottom).
    const before = sorted ? null : beforeOf(cell(to.col, to.lane), ranked, to.index, item)
    const target = moveTargetOf(column)
    const laneKey = layout.lanes[to.lane]?.key ?? null
    const meta = columnMeta(spec, column.key, state.now)
    // Into a column over its limit (§2.1): warned once the move is signed, and moved all the same.
    const holds = column.key.kind === 'status' && from.col !== to.col ? statusColumnItems(fold, column.key).filter((id) => id !== item).length + 1 : 0
    const over = meta.wip !== null && holds > meta.wip
    // A guard that stopped the write opened what fixes it; a refused write is taken back by the
    // hook and its reason shows in the shell's banner. Nothing more to do here either way.
    const done = (p: Promise<unknown>): void =>
      void p.then(
        () => (over ? toast({ title: `${meta.name} is over its limit`, tone: 'warn', detail: `It holds ${holds} items. Its limit is ${meta.wip}.` }) : undefined),
        () => undefined,
      )
    if (movableLane !== null && to.lane !== from.lane) {
      // Another lane of a field: the column and the lane's value in one write.
      const r = rankBefore(ranked, item, before)
      if ('error' in r) {
        // The same rank refused through the move: its banner offers the re-rank.
        done(state.move(cardItem(item), target, ranked, before))
        return
      }
      const value = laneKey === null ? null : (laneKey as FieldValue)
      const fields: Record<number, FieldValue | null> = { [movableLane]: value }
      if ('field' in target) fields[target.field] = target.value
      const patch: CardPatch = { ...('col' in target ? { col: target.col } : {}), fields, rank: r.rank }
      done(state.write(cardItem(item), patch))
      return
    }
    done(state.move(cardItem(item), target, ranked, before))
  }

  // ---------------------------------------------------------------------------------------------
  // Keyboard (§5.2)
  // ---------------------------------------------------------------------------------------------

  const titleOf = (id: string): string => {
    const it = byId.get(id)
    if (it === undefined || hidden?.has(id)) return 'A private item'
    return `#${it.number} ${it.title}`
  }
  const where = (t: DropTarget, item: string): string => {
    const column = layout.columns[t.col]
    const name = column === undefined ? '' : columnMeta(spec, column.key, state.now).name
    const n = cell(t.col, t.lane).filter((id) => id !== item).length + 1
    const lane = layout.lane === null ? '' : `, swimlane ${laneName(layout.lanes[t.lane]?.key ?? null)}`
    return sorted ? `${name}${lane}` : `${name}${lane}, position ${Math.min(t.index, n - 1) + 1} of ${n}`
  }
  const laneName = (key: string | number | null): string => {
    if (layout.lane === null) return ''
    if (key === null) return LANE_NONE[layout.lane] ?? `No ${fieldById(spec, fieldKeyId(layout.lane) ?? 0)?.name ?? 'value'}`
    if (layout.lane === 'assignee') return shortId(String(key))
    const f = fieldKeyId(layout.lane)
    const field = f === null ? undefined : fieldById(spec, f)
    if (field?.type === 'sel') return field.options?.find((o) => o.id === key)?.name ?? String(key)
    if (field?.type === 'iter' && typeof key === 'number') return iterationRange(field, key)?.name ?? String(key)
    if (layout.lane === 'repo') return items.find((i) => i.repoId === key)?.repo ?? String(key)
    return String(key)
  }

  const pickUp = (item: string, pos: CellPos): void => {
    const from = locate(item, pos)
    if (from === null) return
    setDrag({ item, from, to: from, mode: 'keyboard', invalid: null })
    say(`Picked up ${titleOf(item)}. ${where(from, item)}. Use the arrow keys to move it, Space to drop it, Escape to cancel.`)
  }

  const step = (d: Drag, key: string, carrying = true): DropTarget => {
    const t = d.to
    const lanes = layout.lanes.length
    const len = (col: number, lane: number) => cell(col, lane).filter((id) => id !== d.item).length
    const crossLanes = (movableLane !== null || !carrying) && lanes > 1
    // A sorted column has no positions to carry a card to; the focus still moves card by card.
    const positional = !sorted || !carrying
    switch (key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const col = Math.max(0, Math.min(layout.columns.length - 1, t.col + (key === 'ArrowLeft' ? -1 : 1)))
        return { col, lane: t.lane, index: Math.min(t.index, len(col, t.lane)) }
      }
      case 'ArrowUp':
        if (positional && t.index > 0) return { ...t, index: t.index - 1 }
        return crossLanes && t.lane > 0 ? { col: t.col, lane: t.lane - 1, index: len(t.col, t.lane - 1) } : t
      case 'ArrowDown':
        if (positional && t.index < len(t.col, t.lane) - (carrying ? 0 : 1)) return { ...t, index: t.index + 1 }
        return crossLanes && t.lane < lanes - 1 ? { col: t.col, lane: t.lane + 1, index: 0 } : t
      default:
        return t
    }
  }

  /** Say `text` in the live region, even when it says the same as last time (a move at an edge). */
  const say = (text: string): void => setAnnouncement((prev) => (prev === text ? `${text}\u00a0` : text))

  const cancelCarry = (d: Drag): void => {
    setDrag(null)
    say(`Move cancelled. ${titleOf(d.item)} is back in ${where(d.from, d.item)}.`)
  }

  const onCardKey = (e: ReactKeyboardEvent<HTMLElement>, id: string, pos: CellPos): void => {
    if (e.nativeEvent.isComposing) return
    const d = dragRef.current
    // A mouse or touch drag owns the card until it ends (Escape cancels it).
    if (d !== null && d.mode === 'pointer') return
    if (d !== null && d.mode === 'keyboard' && d.item === id) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        setDrag(null)
        if (sameSpot(d.from, d.to)) {
          say(`${titleOf(id)} dropped where it was.`)
          return
        }
        focusAfter.current = { id, col: d.to.col, lane: d.to.lane }
        say(`Dropped ${titleOf(id)} in ${where(d.to, id)}.`)
        commit(id, d.from, d.to)
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        if (e.key === 'Escape') e.preventDefault()
        cancelCarry(d)
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault()
        // On a phone the card stays in view; the column switcher marks where it would go.
        const to = step(d, e.key)
        setDrag({ ...d, to })
        say(where(to, id))
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      onOpenItem(id)
    } else if (e.key === ' ') {
      e.preventDefault()
      if (canPlace) pickUp(id, pos)
      else onOpenItem(id)
    } else if (e.key.startsWith('Arrow') && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      // Not carrying: the arrows move the focus between cards.
      const at = locate(id, pos)
      if (at === null) return
      const next = step({ item: '', from: at, to: at, mode: 'keyboard', invalid: null }, e.key, false)
      const ids = cell(next.col, next.lane)
      const target = ids[Math.min(next.index, ids.length - 1)]
      if (target === undefined || (target === id && next.col === pos.col && next.lane === pos.lane)) return
      e.preventDefault()
      if (!wide && next.col !== pos.col) {
        // The column shows once the switch renders: focus it then.
        focusAfter.current = { id: target, col: next.col, lane: next.lane }
        setPhoneCol(next.col)
      } else cardEl(target, next)?.focus()
    }
  }

  /** A keyboard carry ends when its card loses focus (a click elsewhere): it is put back. */
  const onCardBlur = (id: string): void => {
    const d = dragRef.current
    if (d !== null && d.mode === 'keyboard' && d.item === id) cancelCarry(d)
  }

  // A card to focus once it has rendered (after a drop, or a phone's column switch): tried once.
  useEffect(() => {
    const f = focusAfter.current
    if (f === null) return
    focusAfter.current = null
    cardEl(f.id, f)?.focus()
  })

  // ---------------------------------------------------------------------------------------------
  // Pointer and touch
  // ---------------------------------------------------------------------------------------------

  /** The drop target under the pointer, from the cells' and cards' boxes. */
  const hitTest = (x: number, y: number, d: Drag): Drag => {
    const el = document.elementFromPoint(x, y)
    const tab = el?.closest<HTMLElement>('[data-drop-tab]')
    if (tab != null && rootRef.current?.contains(tab)) {
      const col = Number(tab.dataset['dropTab'])
      return { ...d, to: { col, lane: d.from.lane, index: cell(col, d.from.lane).filter((id) => id !== d.item).length }, invalid: null }
    }
    const zone = el?.closest<HTMLElement>('[data-drop-cell]')
    if (zone == null || !rootRef.current?.contains(zone)) return d
    const col = Number(zone.dataset['col'])
    const lane = Number(zone.dataset['lane'])
    const mids = [...zone.querySelectorAll<HTMLElement>('[data-card-id]')]
      .filter((c) => c.dataset['cardId'] !== d.item)
      .map((c) => {
        const r = c.getBoundingClientRect()
        return r.top + r.height / 2
      })
    return { ...d, to: { col, lane, index: dropIndex(mids, y) }, invalid: laneRefusal(d.from.lane, lane) }
  }

  // A drag outlives the render it started in (a poll, a move taken back): its listeners read the board through this.
  const live = useRef({ hitTest, commit })
  live.current = { hitTest, commit }

  /** Hold back the click that ends a drag (or a cancelled one) until the pointer is up. */
  const swallowClick = (): void => {
    suppressClick.current = true
    window.addEventListener('pointerup', () => setTimeout(() => (suppressClick.current = false), 0), { once: true })
  }

  const startPointer = (e: ReactPointerEvent<HTMLElement>, id: string, handle: boolean, pos: CellPos): void => {
    if (!canPlace || e.button !== 0 || dragRef.current !== null || fromControl(e)) return
    // Touch scrolls the board unless the gesture starts on the grip.
    if (e.pointerType === 'touch' && !handle) return
    const from = locate(id, pos)
    if (from === null) return
    const source = e.currentTarget.closest<HTMLElement>('[data-card-id]') ?? e.currentTarget
    const box = source.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY }
    const offset = { x: e.clientX - box.left, y: e.clientY - box.top }
    let started = handle && e.pointerType === 'touch'
    let pointer = { x: e.clientX, y: e.clientY }
    let frame: number | null = null
    if (handle) e.preventDefault()

    const place = (): void => {
      const g = ghostRef.current
      if (g !== null) {
        g.style.width = `${box.width}px`
        g.style.transform = `translate(${pointer.x - offset.x}px, ${pointer.y - offset.y}px)`
        g.style.visibility = 'visible'
      }
    }
    const begin = (): void => {
      started = true
      const d: Drag = { item: id, from, to: from, mode: 'pointer', invalid: null }
      setDrag(d)
      dragRef.current = d
      requestAnimationFrame(place)
      frame = requestAnimationFrame(tick)
    }
    // Auto-scroll near the board's and the window's edges while dragging.
    const tick = (): void => {
      const d = dragRef.current
      if (d === null || d.mode !== 'pointer') return
      const s = scrollRef.current
      let moved = false
      if (s !== null) {
        const r = s.getBoundingClientRect()
        if (pointer.x < r.left + EDGE && s.scrollLeft > 0) {
          s.scrollLeft -= SCROLL_STEP
          moved = true
        } else if (pointer.x > r.right - EDGE && s.scrollLeft + s.clientWidth < s.scrollWidth) {
          s.scrollLeft += SCROLL_STEP
          moved = true
        }
      }
      if (pointer.y < EDGE) {
        window.scrollBy(0, -SCROLL_STEP)
        moved = true
      } else if (pointer.y > window.innerHeight - EDGE) {
        window.scrollBy(0, SCROLL_STEP)
        moved = true
      }
      if (moved) {
        const next = live.current.hitTest(pointer.x, pointer.y, d)
        if (!sameDrop(next, d)) setDrag(next)
      }
      frame = requestAnimationFrame(tick)
    }
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return
      pointer = { x: ev.clientX, y: ev.clientY }
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_SLOP) return
        begin()
      }
      ev.preventDefault()
      place()
      const d = dragRef.current
      if (d === null) return
      const next = live.current.hitTest(ev.clientX, ev.clientY, d)
      if (!sameDrop(next, d)) {
        dragRef.current = next
        setDrag(next)
      }
    }
    const end = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return
      cleanup()
      const d = dragRef.current
      if (!started || d === null) return
      // The click that follows a drag is not an open.
      suppressClick.current = true
      setTimeout(() => (suppressClick.current = false), 0)
      setDrag(null)
      dragRef.current = null
      if (ev.type === 'pointerup' && d.invalid === null) live.current.commit(id, d.from, d.to)
      else if (d.invalid !== null) say(d.invalid)
    }
    const cancelKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      cleanup()
      if (started) swallowClick()
      setDrag(null)
      dragRef.current = null
    }
    const cleanup = (): void => {
      if (frame !== null) cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('keydown', cancelKey)
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('keydown', cancelKey)
    if (started) begin()
  }
  // ---------------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------------

  if (fold === null) return <div />

  const columnTotalsOf = (col: KanbanColumn): { count: number; sum: number | null } =>
    totals(
      col.items.map((id) => ({ item: byId.get(id) as BoardItem, placement: placements.get(id) as Placement })),
      sumField,
    )
  /** The whole column's count (any filter aside), for its WIP limit. */
  const wipCount = (col: KanbanColumn): number => (col.key.kind === 'status' ? statusColumnItems(fold, col.key).length : col.items.length)

  const quickTarget = (col: KanbanColumn, lane: KanbanLane, name: string): QuickAddTarget => {
    const fields: Record<number, FieldValue | null> = {}
    if (col.key.kind === 'field') fields[col.key.field] = col.key.value
    if (movableLane !== null && lane.key !== null) fields[movableLane] = lane.key as FieldValue
    return { col: col.key.kind === 'status' ? col.key.col : null, fields, column: col.key.kind === 'status' ? rankedColumn(fold, col.key) : [], name }
  }
  /** Quick add goes where a new item lands: every cell, but with lanes of the item's own facts only the "No …" lane. */
  const quickAddIn = (lane: KanbanLane): boolean => home !== undefined && canPlace && (layout.lane === null || movableLane !== null || lane.key === null)

  const openMenu = (col: KanbanColumn, action: 'rerank' | 'archive'): void => {
    const meta = columnMeta(spec, col.key, state.now)
    if (action === 'rerank') {
      setBulk(rerankAction(state, meta.name, rankedColumn(fold, col.key, archivedShown).map((c) => cardItem(c.id))))
      return
    }
    const ids = col.items.filter((id) => placements.get(id)?.archived === null)
    setBulk({
      title: `Archive ${meta.name}`,
      description: `Archives the ${cardCount(ids.length)} this view shows in ${meta.name}. They stay on the board under Show archived.`,
      confirmLabel: `Archive ${cardCount(ids.length)}`,
      items: ids.map(cardItem),
      run: (opts) => state.archive(ids.map(cardItem), opts),
      done: 'Cards archived',
    })
  }

  const renderCard = (id: string, pos: CellPos): JSX.Element => {
    const item = byId.get(id)
    const placement = placements.get(id)
    if (item === undefined || placement === undefined) return <div key={id} />
    const isHidden = hidden?.has(id) === true
    const pending = state.pending.has(id)
    const carried = drag?.item === id && drag.from.col === pos.col && drag.from.lane === pos.lane
    return (
      <KanbanCard
        key={id}
        item={item}
        placement={placement}
        spec={spec}
        cols={view.cols}
        hidden={isHidden}
        pending={pending}
        multiRepo={multiRepo}
        labels={labels}
        canPlace={canPlace}
        describedBy={instructions}
        carried={carried ? (drag?.mode ?? null) : null}
        onKeyDown={(e) => onCardKey(e, id, pos)}
        onBlur={() => onCardBlur(id)}
        onPointerDown={(e, handle) => startPointer(e, id, handle, pos)}
        onClick={() => {
          if (suppressClick.current || dragRef.current !== null) return
          onOpenItem(id)
        }}
      />
    )
  }

  const renderCell = (col: number, laneIdx: number, lane: KanbanLane): JSX.Element => {
    const column = layout.columns[col] as KanbanColumn
    const ids = lane.cells.get(column.id) ?? []
    const meta = columnMeta(spec, column.key, state.now)
    const target = drag !== null && drag.to.col === col && drag.to.lane === laneIdx && !(drag.mode === 'pointer' && drag.invalid !== null) ? drag.to : null
    const others = ids.filter((id) => id !== drag?.item)
    const indicatorAt = target === null ? -1 : sorted ? others.length : target.index
    const refused = drag !== null && drag.mode === 'pointer' && drag.invalid !== null && drag.to.lane === laneIdx && drag.to.col === col
    return (
      <div
        key={column.id}
        data-drop-cell
        data-col={col}
        data-lane={laneIdx}
        className={cn('flex min-h-[3rem] flex-col gap-1.5 p-1.5', refused && 'cursor-not-allowed')}
        title={refused ? (drag?.invalid ?? undefined) : undefined}
        aria-label={layout.lane === null ? undefined : `${meta.name}, ${laneName(lane.key)}`}
        role={layout.lane === null ? undefined : 'group'}
      >
        {ids.map((id) => {
          const i = others.indexOf(id)
          return (
            <div key={id} className="contents">
              {indicatorAt === i && i >= 0 ? <DropLine /> : null}
              {renderCard(id, { col, lane: laneIdx })}
            </div>
          )
        })}
        {indicatorAt === others.length ? <DropLine /> : null}
        {ids.length === 0 && target === null ? <p className="px-1 py-2 text-center text-[12px] text-anvil-500 dark:text-anvil-400">{refused ? drag?.invalid : 'No items'}</p> : null}
        {quickAddIn(lane) && home !== undefined ? (
          <QuickAdd state={state} spec={spec} home={home} homeLabel={items.find((i) => i.repoId === home.repoId)?.repo ?? home.name} target={quickTarget(column, lane, meta.name)} />
        ) : null}
      </div>
    )
  }

  const header = (col: number): JSX.Element => {
    const column = layout.columns[col] as KanbanColumn
    const meta = columnMeta(spec, column.key, state.now)
    const t = columnTotalsOf(column)
    const wipNow = wipCount(column)
    const over = meta.wip !== null && wipNow > meta.wip
    const isDone = column.key.kind === 'status' && column.key.col !== 0 && column.key.col === spec.done
    return (
      <div className="flex items-center gap-2 px-2 pb-1.5 pt-2" data-testid="kanban-column-header">
        <ColorDot color={meta.color} />
        <h3 className="min-w-0 truncate text-dense font-semibold text-anvil-900 dark:text-anvil-50" title={meta.hint ?? meta.name}>
          {meta.name}
        </h3>
        {meta.current ? <span className="rounded-full bg-forge-500/10 px-1.5 text-[11px] font-medium text-forge-800 dark:text-forge-400">Current</span> : null}
        <span className="rounded-full bg-anvil-200/70 px-1.5 text-[11px] font-medium tabular-nums text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200" title={`${t.count} shown`} data-testid="column-count">
          {t.count}
        </span>
        {meta.wip !== null ? (
          <span
            className={cn('inline-flex items-center gap-1 text-[11px] tabular-nums', over ? 'font-semibold text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')}
            title={over ? `Over its limit: ${wipNow} items, limit ${meta.wip}` : `${wipNow} of a limit of ${meta.wip}`}
            data-testid="column-wip"
            data-over={over || undefined}
          >
            {over ? <AlertTriangle className="h-3 w-3" aria-hidden /> : null}
            {wipNow} / {meta.wip}
            <span className="sr-only">{over ? ', over the limit' : ' limit'}</span>
          </span>
        ) : null}
        <span className="ml-auto" />
        {t.sum !== null && sumName !== null ? (
          <span className="text-[11px] tabular-nums text-anvil-500 dark:text-anvil-400" title={`${sumName}: ${t.sum}`} data-testid="column-sum">
            {sumName} {t.sum}
          </span>
        ) : null}
        {canPlace && home !== undefined ? <ColumnMenu name={meta.name} canRerank={!sorted && column.key.kind === 'status' && column.key.col !== 0} canArchive={isDone && t.count > 0} onPick={(a) => openMenu(column, a)} /> : null}
      </div>
    )
  }

  // All columns, or on a phone the one picked.
  const visibleCols = (wide ? layout.columns.map((_, i) => i) : [Math.min(phoneCol, layout.columns.length - 1)]).filter((c) => layout.columns[c] !== undefined)
  const gridStyle = { gridTemplateColumns: wide ? `repeat(${visibleCols.length}, minmax(17rem, 20rem))` : 'minmax(0, 1fr)' }
  const carried = drag?.mode === 'pointer' ? byId.get(drag.item) : undefined

  return (
    <div ref={rootRef} className="min-w-0" data-testid="board-kanban">
      <p id={instructions} className="sr-only">
        {canPlace ? 'Press Enter to open. Press Space to pick the card up, the arrow keys to move it, and Space again to drop it.' : 'Press Enter to open.'}
      </p>
      <div aria-live="assertive" aria-atomic="true" className="sr-only" data-testid="kanban-live">
        {announcement}
      </div>
      {!wide && layout.columns.length > 1 ? (
        <div role="tablist" aria-label="Columns" className="-mx-1 mb-2 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]" data-testid="column-switcher">
          {layout.columns.map((c, i) => {
            const meta = columnMeta(spec, c.key, state.now)
            const active = i === visibleCols[0]
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-drop-tab={i}
                onClick={() => setPhoneCol(i)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-dense coarse:min-h-11',
                  active ? 'border-forge-700 bg-forge-500/10 font-medium text-forge-800 dark:text-forge-400' : 'border-anvil-300 text-anvil-600 dark:border-anvil-700 dark:text-anvil-300',
                  drag !== null && drag.to.col === i && drag.to.col !== visibleCols[0] && 'ring-2 ring-focus',
                )}
              >
                <ColorDot color={meta.color} />
                {meta.name}
                <span className="tabular-nums text-anvil-500 dark:text-anvil-400">{c.items.length}</span>
              </button>
            )
          })}
        </div>
      ) : null}
      <div ref={scrollRef} className="overflow-x-auto overscroll-x-contain pb-2" data-testid="kanban-scroll">
        <div className="inline-grid min-w-full gap-3" style={gridStyle}>
          {visibleCols.map((col) => (
            <section
              key={(layout.columns[col] as KanbanColumn).id}
              aria-label={columnMeta(spec, (layout.columns[col] as KanbanColumn).key, state.now).name}
              className="flex min-w-0 flex-col rounded-lg border border-anvil-200 bg-anvil-50 dark:border-anvil-800 dark:bg-anvil-900/60"
              data-testid="kanban-column"
              data-column={(layout.columns[col] as KanbanColumn).id}
            >
              {header(col)}
              {layout.lane === null ? renderCell(col, 0, layout.lanes[0] as KanbanLane) : null}
            </section>
          ))}
        </div>
        {layout.lane !== null ? (
          <div className="mt-3 space-y-3" data-testid="kanban-lanes">
            {layout.lanes.map((lane, li) => {
              const open = !collapsed.has(lane.id)
              const count = new Set([...lane.cells.values()].flat()).size
              return (
                <section key={lane.id} className="rounded-lg border border-anvil-200 dark:border-anvil-800" aria-label={laneName(lane.key)} data-testid="kanban-lane">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setCollapsed((s) => (s.has(lane.id) ? new Set([...s].filter((x) => x !== lane.id)) : new Set([...s, lane.id])))}
                    className="flex w-full items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-3 py-1.5 text-left text-dense font-medium text-anvil-800 hover:bg-anvil-100 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-100 dark:hover:bg-anvil-850 coarse:min-h-11"
                  >
                    {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                    <LaneTitle lane={layout.lane as string} laneKey={lane.key} spec={spec} items={items} labels={labels} />
                    <span className="rounded-full bg-anvil-200/70 px-1.5 text-[11px] tabular-nums text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200">{count}</span>
                  </button>
                  {open ? (
                    <div className="inline-grid min-w-full gap-3 p-1.5" style={gridStyle}>
                      {visibleCols.map((col) => (
                        <div key={(layout.columns[col] as KanbanColumn).id} className="min-w-0 rounded-md bg-anvil-50/60 dark:bg-anvil-900/40">
                          {renderCell(col, li, lane)}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </div>
        ) : null}
      </div>
      {sorted && canPlace ? <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">This view is sorted, so a card dragged into a column goes where the sort puts it.</p> : null}
      {carried !== undefined ? (
        <div ref={ghostRef} aria-hidden className={cn('pointer-events-none fixed left-0 top-0 z-50 rotate-1 opacity-95 shadow-xl', drag?.invalid != null && 'opacity-60')} style={{ width: 0, visibility: 'hidden' }}>
          <CardFace item={carried} placement={placements.get(carried.id) as Placement} spec={spec} cols={view.cols} hidden={hidden?.has(carried.id) === true} multiRepo={multiRepo} labels={labels} />
          {drag?.invalid != null ? <p className="mt-1 rounded bg-anvil-900 px-2 py-1 text-[11px] text-white dark:bg-anvil-100 dark:text-anvil-900">{drag.invalid}</p> : null}
        </div>
      ) : null}
      {home !== undefined ? <BulkActionDialog action={bulk} state={state} home={home} onClose={() => setBulk(null)} /> : null}
    </div>
  )
}

/** Where a dragged card would land. */
function DropLine(): JSX.Element {
  return <div aria-hidden className="h-0.5 shrink-0 rounded-full bg-forge-600 dark:bg-forge-400" data-testid="drop-line" />
}

/** A swimlane's title (`GroupHeading`), a label in its own colour. */
function LaneTitle({ lane, laneKey, spec, items, labels }: { lane: string; laneKey: string | number | null; spec: BoardSpec; items: readonly BoardItem[]; labels?: ReadonlyMap<string, LabelDef> | undefined }): JSX.Element {
  const def = lane === 'label' && laneKey !== null ? labels?.get(String(laneKey)) : undefined
  if (def !== undefined) return <LabelChip name={String(laneKey)} def={def} />
  return <GroupHeading spec={spec} by={lane} groupKey={laneKey} items={items} />
}

/** A column's menu: re-rank it (§2.6), archive what it shows (the Done column). */
function ColumnMenu({ name, canRerank, canArchive, onPick }: { name: string; canRerank: boolean; canArchive: boolean; onPick: (a: 'rerank' | 'archive') => void }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  if (!canRerank && !canArchive) return null
  const item = 'block w-full rounded px-2.5 py-1.5 text-left text-dense text-anvil-800 hover:bg-anvil-100 dark:text-anvil-100 dark:hover:bg-anvil-850 coarse:min-h-11'
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`${name} column actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-anvil-500 hover:bg-anvil-200 hover:text-anvil-800 dark:text-anvil-400 dark:hover:bg-anvil-800 dark:hover:text-anvil-100 coarse:h-11 coarse:w-11"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        <div role="menu" aria-label={`${name} column actions`} className="absolute right-0 top-7 z-20 w-48 rounded-md border border-anvil-200 bg-white p-1 shadow-lg dark:border-anvil-750 dark:bg-anvil-900">
          {canRerank ? (
            <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onPick('rerank') }}>
              Re-rank column
            </button>
          ) : null}
          {canArchive ? (
            <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onPick('archive') }}>
              Archive all in column
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

interface CardFaceProps {
  readonly item: BoardItem
  readonly placement: Placement
  readonly spec: BoardSpec
  readonly cols: readonly string[] | undefined
  readonly hidden: boolean
  readonly multiRepo: boolean
  readonly labels?: ReadonlyMap<string, LabelDef> | undefined
}

/** The field chips a card shows: the view's `cols` fields, or with none every field the card has a value for. */
function cardFields(spec: BoardSpec, placement: Placement, cols: readonly string[] | undefined): { field: BoardField; value: FieldValue }[] {
  const ids =
    cols === undefined
      ? spec.fields.map((f) => f.id)
      : cols.flatMap((k) => {
          const id = fieldKeyId(k)
          return id === null ? [] : [id]
        })
  return ids.flatMap((id) => {
    const field = fieldById(spec, id)
    const value = placement.fields[String(id)]
    return field === undefined || value === undefined ? [] : [{ field, value }]
  })
}

/** A card's repository prefix ("owner/name "): only on a multi-repository board. */
function repoPrefix(item: BoardItem, multiRepo: boolean): string {
  return multiRepo && item.repo !== undefined ? `${item.repo} ` : ''
}

/** What a card shows (shared by the card and the drag ghost). */
function CardFace({ item, placement, spec, cols, hidden, multiRepo, labels }: CardFaceProps): JSX.Element {
  if (hidden) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-anvil-300 bg-white px-3 py-2 text-dense text-anvil-500 dark:border-anvil-700 dark:bg-anvil-900 dark:text-anvil-400">
        <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden /> A private item
      </div>
    )
  }
  const fields = cardFields(spec, placement, cols)
  const showMilestone = cols?.includes('milestone') === true && item.milestone !== null
  return (
    <div
      className={cn(
        'rounded-md border bg-white px-3 py-2 shadow-sm dark:bg-anvil-900',
        placement.archived !== null ? 'border-dashed border-anvil-300 dark:border-anvil-700' : 'border-anvil-200 group-hover:border-anvil-300 dark:border-anvil-800 dark:group-hover:border-anvil-700',
      )}
    >
      <div className="flex items-center gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
        <ItemStateIcon item={item} className="h-3.5 w-3.5" />
        <span className="min-w-0 truncate font-mono">
          {repoPrefix(item, multiRepo)}#{item.number}
        </span>
        {placement.archived !== null ? <span className="ml-auto rounded bg-anvil-100 px-1 text-[10px] font-medium uppercase tracking-wide text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300">Archived</span> : null}
      </div>
      <p className={cn('mt-0.5 line-clamp-3 break-words text-dense font-medium text-anvil-900 dark:text-anvil-50', placement.archived !== null && 'text-anvil-600 dark:text-anvil-300')}>{item.title || '(untitled)'}</p>
      {item.labels.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.labels.map((l) => {
            const def = labels?.get(l)
            return <LabelChip key={l} name={l} {...(def ? { def } : {})} />
          })}
        </div>
      ) : null}
      {fields.length > 0 || item.assignees.length > 0 || showMilestone ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {fields.map(({ field, value }) => (
            <FieldChip key={field.id} field={field} value={value} />
          ))}
          {showMilestone ? <span className="truncate rounded border border-anvil-200 px-1.5 text-[11px] leading-[18px] text-anvil-600 dark:border-anvil-750 dark:text-anvil-300">{item.milestone}</span> : null}
          {item.assignees.length > 0 ? (
            <span className="ml-auto">
              <AssigneeAvatars ids={item.assignees} />
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A card's accessible name: its repository and number, title, state, labels and field values. */
function cardLabel(p: CardFaceProps): string {
  if (p.hidden) return 'A private item'
  const parts = [`${repoPrefix(p.item, p.multiRepo)}#${p.item.number} ${p.item.title}`, itemStateWords(p.item)]
  if (p.placement.archived !== null) parts.push('archived')
  if (p.item.labels.length > 0) parts.push(`labels ${p.item.labels.join(', ')}`)
  // An iteration's value names its field already ("Iteration 2").
  for (const { field, value } of cardFields(p.spec, p.placement, p.cols)) parts.push(field.type === 'iter' ? fieldValueText(field, value) : `${field.name} ${fieldValueText(field, value)}`)
  return parts.join(', ')
}

function KanbanCard(
  props: CardFaceProps & {
    readonly pending: boolean
    readonly canPlace: boolean
    readonly describedBy: string
    readonly carried: 'pointer' | 'keyboard' | null
    onKeyDown(e: ReactKeyboardEvent<HTMLElement>): void
    onBlur(): void
    onPointerDown(e: ReactPointerEvent<HTMLElement>, handle: boolean): void
    onClick(): void
  },
): JSX.Element {
  const { item, pending, canPlace, carried } = props
  return (
    <div
      role="button"
      tabIndex={0}
      aria-roledescription={canPlace ? 'movable card' : 'card'}
      aria-label={cardLabel(props)}
      aria-describedby={props.describedBy}
      aria-busy={pending || undefined}
      aria-pressed={carried === 'keyboard' ? true : undefined}
      data-card-id={item.id}
      data-number={item.number}
      data-testid="kanban-card"
      onKeyDown={props.onKeyDown}
      onBlur={props.onBlur}
      onPointerDown={(e) => props.onPointerDown(e, false)}
      onClick={props.onClick}
      className={cn(
        'group relative select-none rounded-md outline-none',
        canPlace ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        carried === 'pointer' && 'opacity-40',
        carried === 'keyboard' && 'ring-2 ring-focus ring-offset-2 ring-offset-anvil-50 dark:ring-offset-anvil-950',
      )}
    >
      <CardFace {...props} />
      {canPlace ? (
        <span
          aria-hidden
          onPointerDown={(e) => {
            e.stopPropagation()
            props.onPointerDown(e, true)
          }}
          className="absolute -left-0.5 top-1/2 hidden h-8 w-4 -translate-y-1/2 cursor-grab touch-none items-center justify-center text-anvil-400 group-hover:flex coarse:flex dark:text-anvil-500"
          data-testid="card-grip"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      ) : null}
      {pending ? (
        <span className="absolute right-1.5 top-1.5" title="Saving">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-anvil-500 dark:text-anvil-400" aria-hidden />
          <span className="sr-only">Saving</span>
        </span>
      ) : null}
    </div>
  )
}

