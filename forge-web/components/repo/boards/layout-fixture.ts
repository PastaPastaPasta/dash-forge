// copy-lint-ignore-file: a test fixture, never shown to anyone
/**
 * A board for the layout tests (`board-table.test.tsx`, `board-roadmap.test.tsx`): the
 * new-board template with colours and WIP limits, five items folded at a fixed time, and a stand-in
 * for `useBoard`'s state whose writes are recorded.
 */

import { vi } from 'vitest'

import type { BoardHookState } from '@/hooks/use-board'
import type { BoardCard, BoardView } from '@/lib/repo'
import { dateDays, defaultSpec, foldBoard, type BoardItem, type BoardSpec, type BoardView as SavedView, type Placement } from '@/lib/rules/boards'
import type { BoardLayoutProps } from './layout-props'

export const HOME = 'Home1111111111111111111111111111111111111111'
export const OTHER_REPO = 'Repo2222222222222222222222222222222222222222'
export const ME = 'MeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe'
/** 2026-10-27 12:00 UTC (a Tuesday): Iteration 1 runs from Monday 2026-10-26. */
export const NOW = Date.UTC(2026, 9, 27, 12)
const DAY = 86_400_000

const base = defaultSpec(HOME, NOW)
export const SPEC: BoardSpec = {
  ...base,
  columns: [
    { id: 1, name: 'Todo', color: '#1d76db' },
    { id: 2, name: 'In progress', color: '#fbca04', wip: 1 },
    { id: 3, name: 'Done', color: '#0e8a16' },
  ],
  fields: [...base.fields, { id: 4, name: 'Start', type: 'date' }, { id: 5, name: 'Target', type: 'date' }],
}

/** Item ids are 44 base58 characters. */
export const id = (c: string): string => c.repeat(44).slice(0, 44)

const item = (c: string, n: number, extra: Partial<BoardItem> = {}): BoardItem => ({
  id: id(c),
  number: n,
  repoId: HOME,
  repo: 'project',
  kind: 'issue',
  state: 'open',
  createdAt: NOW - (10 - n) * DAY,
  closedAt: null,
  title: `Item ${n}`,
  labels: [],
  assignees: [],
  milestone: null,
  author: ME,
  ...extra,
})

export const ITEMS: BoardItem[] = [
  item('a', 1, { title: 'Write the parser', labels: ['bug'] }),
  item('b', 2, { title: 'Ship the table', assignees: [ME] }),
  item('c', 3, { title: 'Fix the roadmap', kind: 'pr' }),
  item('d', 4, { title: 'Old done work', state: 'closed', closedAt: NOW - DAY }),
  item('e', 5, { title: 'Secret', repoId: OTHER_REPO }),
]

const card = (c: string, col: number, f: Record<string, number | string> = {}, at = NOW - DAY): BoardCard => ({
  id: id(c.toUpperCase()),
  ownerId: ME,
  updatedAt: at,
  item: id(c),
  col,
  rank: null,
  f: Object.keys(f).length === 0 ? null : JSON.stringify(f),
  state: 0,
})

export const CARDS: BoardCard[] = [
  card('a', 1, { 1: 1, 2: 3, 3: 0, 4: '2026-10-26', 5: '2026-11-06' }),
  card('b', 2, { 1: 2, 2: 5, 3: 1 }),
  card('c', 2, { 2: 2, 4: '2026-11-02' }),
  card('e', 1),
]

export function fold(spec: BoardSpec = SPEC, cards: readonly BoardCard[] = CARDS): Map<string, Placement> {
  return new Map(foldBoard({ spec, home: HOME, items: ITEMS, cards, now: NOW }).items.map((p) => [p.id, p]))
}

const BOARD: BoardView = {
  key: 7,
  repoId: HOME,
  state: 'open',
  name: 'Roadmap',
  spec: SPEC,
  specError: null,
  sealed: false,
  newest: { id: 'b1', ownerId: ME, updatedAt: NOW - DAY },
  revisions: [{ id: 'b1', ownerId: ME, updatedAt: NOW - DAY }],
}

/** A stand-in for `useBoard`'s state: `write` records its calls and resolves. */
export function hookState(over: Partial<BoardHookState> = {}): BoardHookState {
  const done = vi.fn(async () => ({ written: [], failed: null, skipped: [] }))
  return {
    board: BOARD,
    cards: CARDS,
    items: { items: ITEMS, hidden: new Set([id('e')]), missing: new Set(), partial: false, hasOlderClosed: false, walks: new Map() },
    fold: null,
    now: NOW,
    loading: false,
    error: null,
    notFound: false,
    role: 'maintainer',
    can: { place: true, edit: true },
    pending: new Set(),
    refusal: null,
    dismissRefusal: vi.fn(),
    refresh: vi.fn(),
    loadOlderClosed: vi.fn(async () => undefined),
    write: vi.fn(async () => ({}) as never),
    move: vi.fn(async () => ({}) as never),
    add: done,
    archive: done,
    unarchive: done,
    remove: done,
    rerank: done,
    moveOpenToNextIteration: done,
    quickAdd: vi.fn(async () => ({}) as never),
    save: vi.fn(async () => ({}) as never),
    setState: vi.fn(async () => ({}) as never),
    ...over,
  }
}

/** Layout props over the fixture: every item on the board, the view given. */
export function layoutProps(view: Partial<SavedView> = {}, over: Partial<BoardLayoutProps> = {}): BoardLayoutProps {
  const placements = fold()
  const base = {
    state: hookState(),
    spec: SPEC,
    view: { id: 1, name: 'View', layout: 'table' as const, q: '', ...view },
    items: ITEMS.filter((i) => placements.get(i.id)?.on === true && placements.get(i.id)?.archived === null),
    placements: placements as ReadonlyMap<string, Placement>,
    onOpenItem: vi.fn(),
    onViewChange: vi.fn(),
    ...over,
  }
  return { ...base, rows: over.rows ?? base.items.flatMap((item) => (base.placements.has(item.id) ? [{ item, placement: base.placements.get(item.id) as Placement }] : [])) }
}

/** A day number of `YYYY-MM-DD`. */
export const dayNo = (s: string): number => dateDays(s) as number
