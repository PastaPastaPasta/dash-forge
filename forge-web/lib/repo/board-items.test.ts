/**
 * A board's items (`docs/design/boards.md` §2.3, §2.4): open items of the sources, the closed
 * ones within the auto-archive window from the newest-first state changes (with `closedAt`), the
 * items cards name (any repository; a private one's a placeholder), and the fold over them.
 */

import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { defaultSpec, type BoardItem, type BoardSpec, type CardDoc, type ItemKind } from '../rules/boards'
import { ISSUE_CLOSE, ISSUE_LOCK, ISSUE_REOPEN, PR_MERGE } from '../rules/transition'
import { CLOSED_PER_REPO, addCardItems, assembleBoard, loadBoardItems, loadOlderClosed, type BoardItemReader } from './board-items'
import type { BoardView } from './boards'
import type { RepoRef } from './contract'
import type { TransitionView } from './transitions'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 27)
const id = (n: number): string => base58Encode(new Uint8Array(32).fill(n))
const HOME = id(1)
const OTHER_REPO = id(2)
const PRIVATE_REPO = id(3)
const FORGE = { core: 'C', collab: 'L', community: 'M', meta: 'T', group: 'G' }
const repo = (repoId: string, visibility: 'public' | 'private' = 'public'): RepoRef => ({ forge: FORGE, repoId, ownerId: id(9), name: `r${repoId.slice(0, 3)}`, visibility })

function item(n: number, over: Partial<BoardItem> = {}): BoardItem {
  return { id: id(100 + n), number: n, repoId: HOME, kind: 'issue', state: 'open', createdAt: NOW - (100 - n) * DAY, closedAt: null, title: `Item ${n}`, labels: [], assignees: [], milestone: null, author: id(9), ...over }
}

let tx = 0
function t(target: number, kind: number, at: number): TransitionView {
  return { id: `t${++tx}`, targetId: id(100 + target), kind, actor: id(9), asAuthor: 0, createdAt: at }
}

/** A reader over fixed rows, recording its calls. */
function reader(rows: { open?: BoardItem[]; closed?: BoardItem[]; transitions?: TransitionView[]; elsewhere?: Record<string, BoardItem[]>; repos?: Record<string, RepoRef> }) {
  const calls: string[] = []
  const all = [...(rows.open ?? []), ...(rows.closed ?? []), ...Object.values(rows.elsewhere ?? {}).flat()]
  const r: BoardItemReader = {
    async openItems(rp, kind: ItemKind) {
      calls.push(`open:${kind}`)
      return { items: (rows.open ?? []).filter((i) => i.repoId === rp.repoId && i.kind === kind), complete: true }
    },
    async transitions(rp, before) {
      calls.push(`transitions:${before ?? 'newest'}`)
      // Drive's descending walk: newest first, ties by `$id` descending
      const sorted = (rows.transitions ?? []).filter((x) => before === null || x.createdAt <= before).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      return sorted.slice(0, 100)
    },
    async transitionsAt(_rp, at, startAfter) {
      calls.push(`at:${at}:${startAfter ?? ''}`)
      const tied = (rows.transitions ?? []).filter((x) => x.createdAt === at).sort((a, b) => (a.id < b.id ? -1 : 1))
      const from = startAfter === null ? 0 : tied.findIndex((x) => x.id === startAfter) + 1
      return tied.slice(from, from + 100)
    },
    async itemsById(rp, ids) {
      calls.push(`byId:${ids.length}`)
      return all.filter((i) => i.repoId === rp.repoId && ids.includes(i.id)).map((i) => ({ ...i, closedAt: null }))
    },
    async transitionsOf(_rp, ids) {
      return (rows.transitions ?? []).filter((x) => ids.includes(x.targetId))
    },
    async locate(ids) {
      return new Map(all.filter((i) => ids.includes(i.id)).map((i) => [i.id, { repoId: i.repoId, kind: i.kind }]))
    },
    async repo(repoId) {
      return rows.repos?.[repoId] ?? null
    },
  }
  return { r, calls }
}

const SPEC: BoardSpec = defaultSpec(HOME, NOW)
const card = (target: number, over: Partial<CardDoc> = {}): CardDoc => ({ id: `card${target}`, ownerId: id(9), updatedAt: NOW - DAY, item: id(100 + target), col: 2, rank: null, f: null, state: 0, ...over })
const BOARD: BoardView = {
  key: 7,
  repoId: HOME,
  state: 'open',
  name: 'Board',
  spec: SPEC,
  specError: null,
  sealed: false,
  newest: { id: 'b', ownerId: id(9), updatedAt: 1 },
  revisions: [{ id: 'b', ownerId: id(9), updatedAt: 1 }],
}

describe('loadBoardItems', () => {
  it('reads open items, closed ones in the auto-archive window with their closedAt, and stops past it', async () => {
    const open = [item(1), item(2, { kind: 'pr' })]
    const closed = [item(3, { state: 'closed' }), item(4, { state: 'merged', kind: 'pr' }), item(5, { state: 'closed' }), item(6, { state: 'closed' })]
    const transitions = [
      t(3, ISSUE_CLOSE, NOW - 2 * DAY),
      t(3, ISSUE_LOCK, NOW - DAY),
      t(4, PR_MERGE, NOW - 3 * DAY),
      // reopened and closed again: the latest close counts
      t(5, ISSUE_CLOSE, NOW - 40 * DAY),
      t(5, ISSUE_REOPEN, NOW - 30 * DAY),
      t(5, ISSUE_CLOSE, NOW - 5 * DAY),
      // reopened since: open (it is an open item)
      t(1, ISSUE_CLOSE, NOW - 6 * DAY),
      t(1, ISSUE_REOPEN, NOW - 4 * DAY),
      // closed long ago, past the 14-day window
      ...Array.from({ length: 100 }, (_, i) => t(6, ISSUE_CLOSE, NOW - (60 + i) * DAY)),
    ]
    const { r } = reader({ open, closed, transitions })
    const set = await loadBoardItems(r, { home: repo(HOME), spec: SPEC, cards: [], now: NOW })
    const byNumber = new Map(set.items.map((i) => [i.number, i]))
    expect([...byNumber.keys()].sort()).toEqual([1, 2, 3, 4, 5])
    expect(byNumber.get(3)?.closedAt).toBe(NOW - 2 * DAY)
    expect(byNumber.get(4)?.closedAt).toBe(NOW - 3 * DAY)
    expect(byNumber.get(5)?.closedAt).toBe(NOW - 5 * DAY)
    expect(byNumber.get(1)?.closedAt).toBeNull()
    expect(set.hasOlderClosed).toBe(true)
    expect(set.partial).toBe(false)
    // Done holds the closed and merged ones; the sources take every item
    const fold = assembleBoard(BOARD, set, [], NOW)
    expect(fold?.columns.find((c) => c.id === 3)?.items.length).toBe(3)
    expect(fold?.items.every((p) => p.on)).toBe(true)
  })

  it('with auto-archive off reads the most recently closed per repository, and reads on when asked', async () => {
    const spec: BoardSpec = { ...SPEC, arch: 0 }
    const closed = Array.from({ length: CLOSED_PER_REPO + 50 }, (_, i) => item(i + 1, { id: base58Encode(new Uint8Array(32).fill(0).map((_, j) => (j === 0 ? 7 : j === 1 ? i >> 8 : j === 2 ? i & 255 : 1))), state: 'closed' }))
    const transitions = closed.map((c, i): TransitionView => ({ id: `x${i}`, targetId: c.id, kind: ISSUE_CLOSE, actor: id(9), asAuthor: 0, createdAt: NOW - i * 1000 }))
    const { r } = reader({ closed, transitions })
    const input = { home: repo(HOME), spec, cards: [], now: NOW }
    const set = await loadBoardItems(r, input)
    expect(set.items.length).toBeGreaterThanOrEqual(CLOSED_PER_REPO)
    expect(set.items.length).toBeLessThan(closed.length)
    expect(set.hasOlderClosed).toBe(true)
    const older = await loadOlderClosed(r, input, set)
    expect(older.items).toHaveLength(closed.length)
    expect(older.hasOlderClosed).toBe(false)
  })

  it("reads the items cards name outside the sources, a private repo's as a placeholder", async () => {
    const elsewhere = { [OTHER_REPO]: [item(7, { repoId: OTHER_REPO, state: 'closed' })], [PRIVATE_REPO]: [item(8, { repoId: PRIVATE_REPO })] }
    const { r } = reader({
      elsewhere,
      transitions: [t(7, ISSUE_CLOSE, NOW - 100 * DAY)],
      repos: { [OTHER_REPO]: repo(OTHER_REPO), [PRIVATE_REPO]: repo(PRIVATE_REPO, 'private') },
    })
    const cards = [card(7), card(8), card(99)]
    const set = await loadBoardItems(r, { home: repo(HOME), spec: SPEC, cards, now: NOW })
    const seven = set.items.find((i) => i.number === 7)
    expect(seven).toMatchObject({ repoId: OTHER_REPO, state: 'closed', closedAt: NOW - 100 * DAY, repo: repo(OTHER_REPO).name })
    expect(set.hidden).toEqual(new Set([id(108)]))
    expect(set.items.find((i) => i.id === id(108))).toMatchObject({ title: '', repoId: PRIVATE_REPO })
    expect(set.missing).toEqual(new Set([id(199)]))
    // closed, so in Done; its card is newer than the close, so auto-archive spares it
    const fold = assembleBoard(BOARD, set, cards, NOW)
    expect(fold?.items.find((p) => p.id === id(107))).toMatchObject({ on: true, col: 3, archived: null })
  })

  it('a poll that brings a card for a new item reads only that item', async () => {
    const { r, calls } = reader({ open: [item(1)], elsewhere: { [OTHER_REPO]: [item(9, { repoId: OTHER_REPO })] }, repos: { [OTHER_REPO]: repo(OTHER_REPO) } })
    const input = { home: repo(HOME), spec: SPEC, cards: [], now: NOW }
    const set = await loadBoardItems(r, input)
    calls.length = 0
    const same = await addCardItems(r, { ...input, cards: [card(1)] }, set)
    expect(same).toBe(set)
    expect(calls).toEqual([])
    const more = await addCardItems(r, { ...input, cards: [card(1), card(9)] }, set)
    expect(more.items.map((i) => i.number).sort()).toEqual([1, 9])
    expect(calls).toEqual(['byId:1'])
  })

  it('a repo whose every close is older than the window reads none at first, and has older ones', async () => {
    const closed = [item(3, { state: 'closed' })]
    const { r } = reader({ closed, transitions: [t(3, ISSUE_CLOSE, NOW - 90 * DAY)] })
    const input = { home: repo(HOME), spec: SPEC, cards: [], now: NOW }
    const set = await loadBoardItems(r, input)
    expect(set.items).toEqual([])
    expect(set.hasOlderClosed).toBe(true)
    const older = await loadOlderClosed(r, input, set)
    expect(older.items.map((i) => [i.number, i.closedAt])).toEqual([[3, NOW - 90 * DAY]])
    expect(older.hasOlderClosed).toBe(false)
    // folded, it is auto-archived: hidden unless a view asks for archived items
    expect(assembleBoard(BOARD, older, [], NOW)?.items[0]?.archived).toBe('auto')
  })

  it('walks past a block of more than a page of state changes at one time', async () => {
    const spec: BoardSpec = { ...SPEC, arch: 0 }
    const ids = Array.from({ length: 150 }, (_, i) => base58Encode(new Uint8Array(32).fill(0).map((_, j) => (j === 0 ? 9 : j === 1 ? i : 1))))
    const closed = [...ids.map((x, i) => item(i + 1, { id: x, state: 'closed' })), item(200, { state: 'closed' })]
    const transitions: TransitionView[] = [
      ...ids.map((x, i): TransitionView => ({ id: `tie${String(i).padStart(3, '0')}`, targetId: x, kind: ISSUE_CLOSE, actor: id(9), asAuthor: 0, createdAt: NOW - DAY })),
      t(200, ISSUE_CLOSE, NOW - 2 * DAY),
    ]
    const { r, calls } = reader({ closed, transitions })
    const set = await loadBoardItems(r, { home: repo(HOME), spec, cards: [], now: NOW })
    expect(set.items).toHaveLength(151)
    expect(set.items.find((i) => i.number === 200)?.closedAt).toBe(NOW - 2 * DAY)
    expect(set.hasOlderClosed).toBe(false)
    expect(calls.filter((c) => c.startsWith('at:'))).toHaveLength(2)
  })

  it('counts only closes of the kinds the sources name toward the first read', async () => {
    const spec: BoardSpec = { ...SPEC, arch: 0, sources: [{ r: HOME, k: 'i', q: '' }] }
    const prs = Array.from({ length: CLOSED_PER_REPO }, (_, i) => item(i + 1, { id: base58Encode(new Uint8Array(32).fill(0).map((_, j) => (j === 0 ? 8 : j === 1 ? i : 1))), kind: 'pr', state: 'merged' }))
    const issue = item(250, { state: 'closed' })
    const transitions: TransitionView[] = [...prs.map((p, i): TransitionView => ({ id: `m${i}`, targetId: p.id, kind: PR_MERGE, actor: id(9), asAuthor: 0, createdAt: NOW - i * 1000 })), t(250, ISSUE_CLOSE, NOW - DAY)]
    const { r } = reader({ closed: [...prs, issue], transitions })
    const set = await loadBoardItems(r, { home: repo(HOME), spec, cards: [], now: NOW })
    expect(set.items.map((i) => i.number)).toEqual([250])
    expect(set.hasOlderClosed).toBe(false)
  })

  it('a private source repository this reader holds no session for is not read at all', async () => {
    const spec: BoardSpec = { ...SPEC, sources: [...SPEC.sources, { r: PRIVATE_REPO, k: 'a', q: '' }] }
    const { r, calls } = reader({ open: [item(1)], repos: { [PRIVATE_REPO]: repo(PRIVATE_REPO, 'private') } })
    await loadBoardItems(r, { home: repo(HOME), spec, cards: [], now: NOW })
    // the home's two kinds, its closed walk and the read of what it found; nothing of the private source
    expect(calls).toEqual(['open:issue', 'open:pr', 'transitions:newest', 'byId:0'])
  })

  it("opens a private repository's items with the session this reader already holds for it (§2.5)", async () => {
    const session = { id: 's' } as unknown as NonNullable<RepoRef['session']>
    const elsewhere = { [PRIVATE_REPO]: [item(8, { repoId: PRIVATE_REPO })] }
    const { r } = reader({ elsewhere, repos: { [PRIVATE_REPO]: repo(PRIVATE_REPO, 'private') } })
    const asked: string[] = []
    const set = await loadBoardItems(r, {
      home: repo(HOME),
      spec: SPEC,
      cards: [card(8)],
      now: NOW,
      sessionOf: (rp) => {
        asked.push(rp.repoId)
        return session
      },
    })
    expect(asked).toEqual([PRIVATE_REPO])
    expect(set.hidden.size).toBe(0)
    expect(set.items.find((i) => i.id === id(108))).toMatchObject({ number: 8, title: 'Item 8' })
  })

  it('reads only the kinds the sources name', async () => {
    const spec: BoardSpec = { ...SPEC, sources: [{ r: HOME, k: 'p', q: '' }] }
    const { r, calls } = reader({ open: [item(1), item(2, { kind: 'pr' })] })
    const set = await loadBoardItems(r, { home: repo(HOME), spec, cards: [], now: NOW })
    expect(calls.filter((c) => c.startsWith('open'))).toEqual(['open:pr'])
    expect(set.items.map((i) => i.number)).toEqual([2])
  })
})
