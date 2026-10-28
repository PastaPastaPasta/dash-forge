// @vitest-environment jsdom
/**
 * The issue / PR sidebar's Boards section (design `docs/design/boards.md` §5.6): nothing read
 * before it is in view and the page's load is past (a scroll, or idle a while after), each board with the item's status and fields (editable by members, one
 * card write each), read-only for others, and "Add to board" for the repo's other open boards.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardView, RepoRef } from '@/lib/repo'
import { defaultSpec, foldBoard, type BoardItem } from '@/lib/rules/boards'
import type { ItemBoardPlacement } from '@/hooks/use-board'

const ME = 'MeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe'
const HOME_ID = 'Home1111111111111111111111111111111111111111'
const NOW = Date.UTC(2026, 9, 27, 12)
const ITEM_ID = 'Item1111111111111111111111111111111111111111'
let role: 'maintainer' | 'writer' | 'triage' | null = 'triage'
let entries: ItemBoardPlacement[] = []
let boards: BoardView[] = []
const seenItems: (BoardItem | null)[] = []
const write = vi.fn(async () => ({}))
const addTo = vi.fn(async () => ({}))

vi.mock('next/navigation', () => ({ usePathname: () => '/repo/issue/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined, push: () => undefined }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: ME }, identity: ME, balance: '100000000000', keyLimits: null }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role, known: true, failed: false, retry: () => undefined }) }))
vi.mock('@/lib/spend-toast', () => ({ spendAction: (_labels: unknown, run: (tag: (s: unknown) => unknown) => Promise<unknown>) => run((s) => s) }))
vi.mock('@/hooks/use-board', () => ({
  useBoardsDeployed: (forge: { meta?: string } | undefined) => forge?.meta !== undefined,
  useItemBoards: (_repo: unknown, item: BoardItem | null) => {
    seenItems.push(item)
    return { data: item === null ? null : entries, loading: false, error: null, cause: null, settled: true, reload: () => undefined, write, addTo }
  },
  useBoards: () => ({ data: boards, loading: false, error: null, cause: null, settled: true, reload: () => undefined, role, can: { place: true, edit: false }, create: vi.fn() }),
}))

const { ItemBoards } = await import('./item-boards')
const { DEFERRED_READ_MS } = await import('@/hooks/use-in-view')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPO = { repoId: HOME_ID, forge: { core: 'C', collab: 'L', community: 'M', meta: 'X', group: 'G' }, ownerId: ME, name: 'project', visibility: 'public' } as unknown as RepoRef
const addr = { owner: 'o', name: 'project' }
const ITEM: BoardItem = { id: ITEM_ID, number: 12, repoId: HOME_ID, repo: 'project', kind: 'issue', state: 'open', createdAt: NOW - 86_400_000, closedAt: null, title: 'Fix it', labels: [], assignees: [], milestone: null, author: ME }
const SPEC = defaultSpec(HOME_ID, NOW)
const boardView = (key: number, name: string, state: BoardView['state'] = 'open'): BoardView => ({ key, repoId: HOME_ID, state, name, spec: SPEC, specError: null, sealed: false, newest: { id: `b${key}`, ownerId: ME, updatedAt: NOW }, revisions: [] })
const entryOf = (board: BoardView, col: number, f: Record<string, number | string> = {}): ItemBoardPlacement => {
  const card = { id: `c${board.key}`, ownerId: ME, updatedAt: NOW, item: ITEM_ID, col, rank: null, f: JSON.stringify(f), state: 0 }
  return { home: REPO, board, cards: [card], card, placement: foldBoard({ spec: SPEC, home: HOME_ID, items: [ITEM], cards: [card], now: NOW }).items[0] ?? null }
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  role = 'triage'
  entries = [entryOf(boardView(5, 'Roadmap'), 2, { 1: 1, 2: 3 })]
  boards = [boardView(5, 'Roadmap'), boardView(6, 'Triage'), boardView(7, 'Old', 'closed')]
  seenItems.length = 0
  write.mockClear()
  addTo.mockClear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const button = (text: RegExp): HTMLButtonElement | undefined => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''))
/** Render the section, then scroll the page (what lets a section in view read at once). */
const render = (repo: RepoRef = REPO, scroll = true): void => {
  act(() => root.render(<ItemBoards repo={repo} addr={addr} item={ITEM} />))
  if (scroll) act(() => void window.dispatchEvent(new Event('scroll')))
}

describe('ItemBoards', () => {
  it('reads nothing until the section is in view', () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
    render()
    expect(seenItems.every((i) => i === null)).toBe(true)
    expect(el.textContent).toContain('Reading boards')
  })

  it('in view on load, reads only after a scroll, or once the page has been idle a while: a cold page load reads no board', () => {
    vi.useFakeTimers()
    try {
      const idle = vi.fn((go: () => void) => {
        go()
        return 1
      })
      vi.stubGlobal('requestIdleCallback', idle)
      render(REPO, false)
      expect(seenItems.every((i) => i === null)).toBe(true)
      act(() => void vi.advanceTimersByTime(DEFERRED_READ_MS - 1))
      expect(seenItems.every((i) => i === null)).toBe(true)
      act(() => void vi.advanceTimersByTime(1))
      expect(idle).toHaveBeenCalled()
      expect(seenItems.at(-1)).toEqual(ITEM)
    } finally {
      vi.useRealTimers()
    }
  })

  it('in view on load, reads at once when the reader scrolls', () => {
    render(REPO, false)
    expect(seenItems.every((i) => i === null)).toBe(true)
    act(() => void window.dispatchEvent(new Event('scroll')))
    expect(seenItems.at(-1)).toEqual(ITEM)
  })

  it('shows each board with the item’s status and fields; a member changes them with one card write', async () => {
    render()
    const board = el.querySelector('[data-testid="item-board"]') as HTMLElement
    expect(board.querySelector('a')?.getAttribute('href')).toBe('/repo/board/?owner=o&name=project&b=5')
    const status = board.querySelector('select[aria-label="Status on Roadmap"]') as HTMLSelectElement
    expect(status.value).toBe('2')
    expect((board.querySelector('select[aria-label="Priority on Roadmap"]') as HTMLSelectElement).value).toBe('1')
    expect((board.querySelector('input[aria-label="Estimate on Roadmap"]') as HTMLInputElement).value).toBe('3')
    await act(async () => {
      status.value = '3'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(write).toHaveBeenCalledWith(entries[0], { col: 3 })
    // shown at once, before the re-read
    expect((board.querySelector('select[aria-label="Status on Roadmap"]') as HTMLSelectElement).value).toBe('3')
  })

  it('is read-only for a reader, with only the fields that have a value', () => {
    role = null
    render()
    const board = el.querySelector('[data-testid="item-board"]') as HTMLElement
    expect(board.querySelector('select')).toBeNull()
    expect(board.textContent).toContain('In progress')
    expect(board.textContent).toContain('P0')
    expect(board.textContent).not.toContain('Iteration')
    expect(el.querySelector('[data-testid="add-to-board"]')).toBeNull()
  })

  it('adds the item to another open board of the repo, priced', async () => {
    entries = []
    render()
    expect(el.textContent).toContain('None yet')
    act(() => (el.querySelector('[data-testid="add-to-board"]') as HTMLButtonElement).click())
    const items = [...el.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)
    expect(items).toEqual(['Roadmap', 'Triage'])
    act(() => button(/Triage/)?.click())
    expect(document.querySelector('[role="dialog"] [data-testid="cost-preview"]')).not.toBeNull()
    await act(async () => button(/Sign & add/)?.click())
    await settle()
    expect(addTo).toHaveBeenCalledWith(boards[1], undefined, { intent: expect.any(String) })
  })

  it('offers only the boards the item is not on', () => {
    render()
    act(() => (el.querySelector('[data-testid="add-to-board"]') as HTMLButtonElement).click())
    expect([...el.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual(['Triage'])
  })

  it('is absent on a network without boards', () => {
    render({ ...REPO, forge: { core: 'C', collab: 'L', community: 'M', group: 'G' } } as unknown as RepoRef)
    expect(el.innerHTML).toBe('')
  })
})
