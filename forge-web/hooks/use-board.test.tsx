// @vitest-environment jsdom
/**
 * `useBoard` (`docs/design/boards.md` §5.2, §5.7): a move shows at once and is taken back with
 * the reason when refused; a landed move is re-read by a poll at once, merged by `$id`; the
 * 20 s poll reads only while the tab is visible.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultSpec, type BoardItem, type CardDoc } from '@/lib/rules/boards'
import type { BoardItemSet, BoardRead, RepoRef } from '@/lib/repo'

const HOME = 'H'.repeat(44)
const NOW = Date.UTC(2026, 9, 27)
const SPEC = defaultSpec(HOME, NOW)
const ITEM: BoardItem = { id: 'I'.repeat(44), number: 1, repoId: HOME, kind: 'issue', state: 'open', createdAt: NOW - 1000, closedAt: null, title: 'One', labels: [], assignees: [], milestone: null, author: 'me' }
const CARD: CardDoc = { id: 'c1', ownerId: 'me', updatedAt: 100, item: ITEM.id, col: 1, rank: null, f: null, state: 0 }

const state = vi.hoisted(() => ({
  move: null as null | { resolve: (v: unknown) => void; reject: (e: unknown) => void },
  writes: [] as { patch: unknown; opts: { over?: unknown } | undefined; resolve: (v: unknown) => void }[],
  since: vi.fn(),
  read: null as unknown,
  // the SDK and the signer are stable across renders, as the app's are
  sdk: {},
  signer: { identityId: 'me', network: 'devnet', getSigningKeyWif: () => 'W' },
}))
vi.mock('./use-sdk', () => ({ useSdk: () => ({ sdk: state.sdk, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: state.signer }) }))
vi.mock('./use-repo-chrome', () => ({ useViewerRole: () => ({ role: 'triage', known: true, failed: false, retry: () => undefined }) }))
vi.mock('@/lib/repo', async (load) => ({
  ...(await load<typeof import('@/lib/repo')>()),
  readBoard: async () => state.read,
  boardItemReader: () => ({}),
  loadBoardItems: async (): Promise<BoardItemSet> => ({ items: [ITEM], hidden: new Set(), missing: new Set(), partial: false, hasOlderClosed: false, walks: new Map() }),
  addCardItems: async (_r: unknown, _i: unknown, set: BoardItemSet) => set,
  readCardsSince: state.since,
  writeCard: (_sdk: unknown, _auth: unknown, _repo: unknown, _board: unknown, _item: unknown, patch: unknown, opts?: { over?: unknown }) =>
    new Promise((resolve) => {
      state.writes.push({ patch, opts, resolve })
    }),
  moveCard: () =>
    new Promise((resolve, reject) => {
      state.move = { resolve, reject }
    }),
}))

import { BOARD_POLL_MS, useBoard } from './use-board'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo: RepoRef = { forge: { core: 'C', collab: 'L', community: 'M', meta: 'T', group: 'G' }, repoId: HOME, ownerId: 'me', name: 'repo', visibility: 'public' }
let host: HTMLDivElement
let root: Root
let view: ReturnType<typeof useBoard>
function Probe() {
  view = useBoard(repo, 7)
  return null
}
const colOf = (): number | undefined => view.fold?.items.find((p) => p.id === ITEM.id)?.col

beforeEach(async () => {
  state.move = null
  state.writes = []
  state.since.mockReset().mockResolvedValue([])
  const read: BoardRead = {
    board: { key: 7, repoId: HOME, state: 'open', name: 'B', spec: SPEC, specError: null, sealed: false, newest: { id: 'b', ownerId: 'me', updatedAt: 1 }, revisions: [{ id: 'b', ownerId: 'me', updatedAt: 1 }] },
    cards: [CARD],
    since: 100,
  }
  state.read = read
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Probe />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('useBoard', () => {
  it('loads, folds, and says what a triage member may do', () => {
    expect(colOf()).toBe(1)
    expect(view.can).toEqual({ place: true, edit: false })
  })

  it('shows a move at once and takes it back with the reason when refused', async () => {
    let done!: Promise<unknown>
    await act(async () => {
      done = view.move({ id: ITEM.id, repoId: HOME }, { col: 2 }, [], null).catch((e: unknown) => e)
    })
    expect(colOf()).toBe(2)
    expect(view.pending.has(ITEM.id)).toBe(true)
    await act(async () => {
      state.move?.reject(new Error('refused by consensus'))
      await done
    })
    expect(colOf()).toBe(1)
    expect(view.pending.size).toBe(0)
    expect(view.refusal).toMatchObject({ items: [ITEM.id], message: expect.stringContaining('refused by consensus') })
  })

  it('a landed move polls at once and keeps the landed card, merged by $id', async () => {
    state.since.mockResolvedValue([{ ...CARD, updatedAt: 200, col: 2, rank: 'F' }, { ...CARD, updatedAt: 200, col: 2, rank: 'F' }])
    let done!: Promise<unknown>
    await act(async () => {
      done = view.move({ id: ITEM.id, repoId: HOME }, { col: 2 }, [], null)
    })
    await act(async () => {
      state.move?.resolve({ card: CARD, created: false, result: {} })
      await done
    })
    expect(state.since).toHaveBeenCalledWith(expect.anything(), repo, 7, 100)
    expect(view.cards.filter((c) => c.id === 'c1')).toHaveLength(1)
    expect(colOf()).toBe(2)
    expect(view.pending.size).toBe(0)
  })

  it("keeps a landed move's card until a poll reads it", async () => {
    let done!: Promise<unknown>
    await act(async () => {
      done = view.move({ id: ITEM.id, repoId: HOME }, { col: 2 }, [], null)
    })
    // the replica does not show it yet: the poll after the write reads nothing new
    await act(async () => {
      state.move?.resolve({ card: { ...CARD, col: 2, rank: 'F' }, created: false, result: {} })
      await done
    })
    expect(colOf()).toBe(2)
    expect(view.pending.size).toBe(0)
  })

  it('polls every 20 s while visible, and not while hidden', async () => {
    vi.useFakeTimers()
    await act(async () => root.render(null))
    await act(async () => root.render(<Probe />))
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    state.since.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_POLL_MS)
    })
    expect(state.since).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_POLL_MS)
    })
    expect(state.since).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  it('two quick edits of one item both land: the second waits, and applies over the first', async () => {
    const item = { id: ITEM.id, repoId: HOME }
    let a!: Promise<unknown>
    let b!: Promise<unknown>
    await act(async () => {
      a = view.write(item, { col: 2 })
      b = view.write(item, { fields: { 2: 5 } })
    })
    // both shown at once
    expect(colOf()).toBe(2)
    expect(view.fold?.items.find((p) => p.id === ITEM.id)?.fields).toEqual({ 2: 5 })
    // the second is not started before the first lands
    expect(state.writes).toHaveLength(1)
    const first = { id: 'c1', ownerId: 'me', updatedAt: 300, item: ITEM.id, col: 2, rank: null, f: null, state: 0 }
    await act(async () => {
      state.writes[0]?.resolve({ card: first, created: false, result: {} })
      await a
    })
    expect(state.writes).toHaveLength(2)
    expect(state.writes[1]?.patch).toEqual({ fields: { 2: 5 } })
    // built over the first write's card, not a read that may not show it yet
    expect(state.writes[1]?.opts?.over).toEqual(first)
    await act(async () => {
      state.writes[1]?.resolve({ card: { ...first, f: '{"2":5}' }, created: false, result: {} })
      await b
    })
  })
})
