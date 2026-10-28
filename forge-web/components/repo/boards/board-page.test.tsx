// @vitest-environment jsdom
/**
 * The board page's shell (`docs/design/boards.md` §4, §5): the query filters the cards, qualifiers
 * naming nothing are listed under the box, the view's unsaved changes offer Save and Reset, a
 * refused write's reason shows, and the item panel edits a field with one card write.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardHookState } from '@/hooks/use-board'
import type { RepoRef } from '@/lib/repo'
import { foldBoard } from '@/lib/rules/boards'
import type { RepoHome } from '@/lib/view'

import { CARDS, HOME, ITEMS, ME, NOW, OTHER_REPO, SPEC, hookState, id } from './layout-fixture'

let params = new URLSearchParams()
const replace = vi.fn()
const push = vi.fn()
let board: BoardHookState
vi.mock('next/navigation', () => ({ usePathname: () => '/repo/board/', useRouter: () => ({ replace, push }) }))
vi.mock('@/hooks/use-route', () => ({ useSearchParams: () => params, usePathname: () => '/repo/board/' }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: ME }, identity: ME, balance: '100000000000', keyLimits: null }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: 'maintainer', known: true, failed: false, retry: () => undefined }) }))
vi.mock('@/hooks/use-board', () => ({ useBoard: () => board, useBoardsDeployed: () => true, useBoards: () => ({ data: [], loading: false, error: null, cause: null, settled: true, reload: () => undefined, role: null, can: { place: false, edit: false }, create: async () => ({}) }) }))
const readLabels = vi.fn(async () => [{ name: 'bug', color: '#d73a4a', description: '', retired: false, createdAt: 1, id: 'l1' }])
vi.mock('@/lib/repo', async (orig) => ({ ...(await orig<typeof import('@/lib/repo')>()), readLabels: () => readLabels() }))
const loadIssueThread = vi.fn(async () => ({ issue: { body: 'The parser drops **comments**.' }, labels: [], members: [] }))
vi.mock('@/lib/view', async (orig) => ({ ...(await orig<typeof import('@/lib/view')>()), loadIssueThread: () => loadIssueThread() }))

const { BoardPage, filterPlaceholder } = await import('./board-page')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FORGE = { core: 'C', collab: 'L', community: 'M', group: 'G', meta: 'X' } as unknown as RepoRef['forge']
const HOME_REF: RepoRef = { forge: FORGE, repoId: HOME, ownerId: ME, name: 'project', visibility: 'public' }
const HOME_VIEW = { repo: HOME_REF, description: '', config: null } as unknown as RepoHome
const addr = { owner: 'alice', name: 'project' }
const fold = foldBoard({ spec: SPEC, home: HOME, items: ITEMS, cards: CARDS, now: NOW })

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  board = hookState({ fold, items: { items: ITEMS, hidden: new Set(), missing: new Set(), partial: false, hasOlderClosed: false, walks: new Map() } })
  replace.mockReset()
  push.mockReset()
  readLabels.mockClear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const render = async (query: string): Promise<void> => {
  params = new URLSearchParams(`owner=alice&name=project&b=7&${query}`)
  await act(async () => root.render(<BoardPage home={HOME_VIEW} addr={addr} />))
  await settle()
}
const shown = () => [...el.querySelectorAll<HTMLElement>('[data-testid="kanban-card"]')].map((c) => Number(c.dataset['number']))

describe('board page', () => {
  it('shows the board with its views, and every item when nothing filters', async () => {
    await render('')
    expect(el.querySelector('h1')?.textContent).toContain('Roadmap')
    expect([...el.querySelectorAll('[data-testid="view-tab"]')].map((t) => t.textContent)).toEqual(['Board', 'Table', 'Roadmap'])
    expect(shown()).toEqual([1, 5, 2, 3, 4])
    expect(el.querySelector('[data-testid="board-settings-link"]')?.getAttribute('href')).toBe('/repo/board/settings/?owner=alice&name=project&b=7')
    expect(el.querySelector('[data-testid="view-dirty"]')).toBeNull()
  })

  it('filters by the query in the URL, @me as the signed-in identity', async () => {
    await render('q=label%3Abug')
    expect(shown()).toEqual([1])
    await render('q=assignee%3A%40me')
    expect(shown()).toEqual([2])
    await render('q=status%3A%22In+progress%22+-priority%3AP1')
    expect(shown()).toEqual([3])
  })

  it('lists the qualifiers that name nothing on the board under the box', async () => {
    await render('q=nope%3Ax+label%3Abug')
    expect(el.querySelector('[data-testid="board-query-unresolved"]')?.textContent).toBe('Not applied: nope:x. It names nothing on this board.')
    expect(shown()).toEqual([1])
  })

  it('offers Reset and Save view for unsaved changes, and Only archived adds is:archived', async () => {
    await render('q=label%3Abug')
    expect(el.querySelector('[data-testid="view-dirty"]')?.textContent).toContain('Save view')
    const archived = el.querySelector<HTMLInputElement>('[data-testid="show-archived"]') as HTMLInputElement
    await act(async () => archived.click())
    expect(replace).toHaveBeenLastCalledWith('/repo/board/?owner=alice&name=project&b=7&q=label%3Abug+is%3Aarchived', { scroll: false })
    const reset = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Reset') as HTMLButtonElement
    await act(async () => reset.click())
    expect(replace).toHaveBeenLastCalledWith('/repo/board/?owner=alice&name=project&b=7', { scroll: false })
  })

  it('shows a refused write’s reason and offers the re-rank it needs', async () => {
    const { BoardWriteError } = await import('@/lib/repo')
    const error = new BoardWriteError('re-rank', 'There is no room left between these cards. Re-rank this column first.', 2)
    board = { ...board, refusal: { items: [id('a')], message: error.message, error } }
    await render('')
    const banner = el.querySelector('[data-testid="board-refusal"]') as HTMLElement
    expect(banner.textContent).toContain('There is no room left between these cards. Re-rank this column first. The card is back where it was.')
    const rerank = [...banner.querySelectorAll('button')].find((b) => b.textContent === 'Re-rank column') as HTMLButtonElement
    await act(async () => rerank.click())
    expect(document.body.textContent).toContain('Re-rank In progress')
  })

  it('opens the item panel from the URL and writes a field change as one card write', async () => {
    await render(`item=${id('a')}`)
    await settle()
    const panel = document.querySelector('[data-testid="item-panel"]') as HTMLElement
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.textContent).toContain('Write the parser')
    expect(panel.textContent).toContain('The parser drops comments.')
    const status = panel.querySelector<HTMLSelectElement>('#item-field-status') as HTMLSelectElement
    await act(async () => {
      status.value = '3'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(board.write).toHaveBeenLastCalledWith({ id: id('a'), repoId: HOME }, { col: 3 }, undefined)
    const priority = panel.querySelector<HTMLSelectElement>('#item-field-1') as HTMLSelectElement
    await act(async () => {
      priority.value = '2'
      priority.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(board.write).toHaveBeenLastCalledWith({ id: id('a'), repoId: HOME }, { fields: { 1: 2 } }, undefined)
    const estimate = panel.querySelector<HTMLInputElement>('#item-field-2') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(estimate, '8')
      estimate.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => estimate.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(board.write).toHaveBeenLastCalledWith({ id: id('a'), repoId: HOME }, { fields: { 2: 8 } }, undefined)
    // Escape closes it (the URL drops `item`).
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await settle()
    expect(replace).toHaveBeenLastCalledWith('/repo/board/?owner=alice&name=project&b=7', { scroll: false })
  })

  it('asks once before a private repo’s board writes a card for another repo’s item', async () => {
    const homeView = { ...HOME_VIEW, repo: { ...HOME_REF, visibility: 'private' } } as unknown as RepoHome
    params = new URLSearchParams(`owner=alice&name=project&b=7&item=${id('e')}`)
    await act(async () => root.render(<BoardPage home={homeView} addr={addr} />))
    await settle()
    const panel = document.querySelector('[data-testid="item-panel"]') as HTMLElement
    const status = panel.querySelector<HTMLSelectElement>('#item-field-status') as HTMLSelectElement
    await act(async () => {
      status.value = '2'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('Place another repo’s item?')
    expect(board.write).not.toHaveBeenCalled()
    await act(async () => (document.querySelector('[data-testid="confirm-action"]') as HTMLButtonElement).click())
    await settle()
    expect(board.write).toHaveBeenLastCalledWith({ id: id('e'), repoId: OTHER_REPO }, { col: 2 }, { confirmCrossRepo: true })
  })

  it('groups the table by Status, by another key, or not at all', async () => {
    await render('layout=table')
    const picker = el.querySelector<HTMLSelectElement>('[data-testid="group-picker"]') as HTMLSelectElement
    expect([...picker.options].slice(0, 3).map((o) => o.text)).toEqual(['None', 'Status', 'Assignee'])
    expect(picker.value).toBe('')
    await act(async () => {
      picker.value = 'status'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(replace).toHaveBeenLastCalledWith('/repo/board/?owner=alice&name=project&b=7&layout=table&group=status', { scroll: false })
    await render('layout=table&group=status')
    expect(el.querySelectorAll('[data-testid="board-table-section"]').length).toBe(3)
  })

  it('lets a roadmap plot an iteration or a pair of date fields', async () => {
    await render('layout=roadmap')
    const picker = el.querySelector<HTMLSelectElement>('[data-testid="dates-picker"]') as HTMLSelectElement
    expect([...picker.options].map((o) => o.text)).toEqual(['Iteration', 'Start to Target'])
    expect(picker.value).toBe('3')
    await act(async () => {
      picker.value = '4,5'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(replace).toHaveBeenLastCalledWith('/repo/board/?owner=alice&name=project&b=7&layout=roadmap&date=4%2C5', { scroll: false })
  })

  it('suggests a filter in the board’s own terms', () => {
    expect(filterPlaceholder(SPEC)).toBe('status:"In progress" assignee:@me priority:P0')
    expect(filterPlaceholder({ ...SPEC, columns: [{ id: 1, name: 'Todo' }], fields: [] })).toBe('status:Todo assignee:@me')
  })

  it('reads the label definitions again when an item shows a label they lack (one just defined)', async () => {
    board = { ...board, items: { ...(board.items as NonNullable<BoardHookState['items']>), items: ITEMS.map((i) => (i.id === id('b') ? { ...i, labels: ['docs'] } : i)) } }
    await render('')
    await settle()
    expect(readLabels).toHaveBeenCalledTimes(2)
    await render('q=label%3Adocs')
    await settle()
    expect(readLabels).toHaveBeenCalledTimes(2)
  })

  it('closes the item panel once its item is removed from the board', async () => {
    await render(`item=${id('a')}`)
    await settle()
    const panel = document.querySelector('[data-testid="item-panel"]') as HTMLElement
    expect(panel.querySelector('[data-testid="item-page-link"]')?.textContent).toBe('Go to issue ')
    const remove = [...panel.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Remove') as HTMLButtonElement
    await act(async () => remove.click())
    await act(async () => (document.querySelector('[data-testid="confirm-action"]') as HTMLButtonElement).click())
    await settle()
    expect(board.remove).toHaveBeenCalledWith([{ id: id('a'), repoId: HOME }], undefined)
    expect(replace).toHaveBeenLastCalledWith('/repo/board/?owner=alice&name=project&b=7', { scroll: false })
  })

  it('gives a reader the board without field editors', async () => {
    board = { ...board, can: { place: false, edit: false } }
    await render(`item=${id('b')}`)
    const panel = document.querySelector('[data-testid="item-panel"]') as HTMLElement
    expect(panel.querySelector('select')).toBeNull()
    expect(panel.querySelector('[data-testid="item-panel-fields"]')?.textContent).toContain('In progress')
    expect(el.querySelector('[data-testid="board-settings-link"]')).toBeNull()
  })
})
