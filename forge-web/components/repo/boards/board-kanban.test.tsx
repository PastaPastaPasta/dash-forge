// @vitest-environment jsdom
/**
 * The board layout (`docs/design/boards.md` §4.1, §5.2, §5.3): columns and cards from the fold,
 * WIP limits, the keyboard move, quick add's three ways in, and the read-only board.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardHookState } from '@/hooks/use-board'
import type { RepoRef } from '@/lib/repo'
import { type Placement, foldBoard } from '@/lib/rules/boards'

import { CARDS, HOME, ITEMS, ME, NOW, OTHER_REPO, SPEC, hookState, id } from './layout-fixture'
import type { BoardLayoutProps } from './layout-props'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: ME }, identity: ME, balance: '100000000000', keyLimits: null }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
const resolveItemByNumber = vi.fn()
vi.mock('@/lib/repo', async (orig) => ({ ...(await orig<typeof import('@/lib/repo')>()), resolveItemByNumber: (...a: unknown[]) => resolveItemByNumber(...a) }))
const resolveAnyRepoWith = vi.fn()
vi.mock('@/lib/repo/resolveRepo', async (orig) => ({ ...(await orig<typeof import('@/lib/repo/resolveRepo')>()), resolveAnyRepoWith: (...a: unknown[]) => resolveAnyRepoWith(...a) }))

const { BoardKanban } = await import('./board-kanban')
const { quickAddPlan } = await import('./quick-add')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FORGE = { core: 'C', collab: 'L', community: 'M', group: 'G' } as unknown as RepoRef['forge']
const HOME_REF: RepoRef = { forge: FORGE, repoId: HOME, ownerId: ME, name: 'project', visibility: 'public' }
const OTHER_REF: RepoRef = { forge: FORGE, repoId: OTHER_REPO, ownerId: ME, name: 'tools', visibility: 'public' }

const fold = foldBoard({ spec: SPEC, home: HOME, items: ITEMS, cards: CARDS, now: NOW })
const placements = new Map(fold.items.map((p) => [p.id, p]))

function props(over: Partial<BoardHookState> = {}, extra: Partial<BoardLayoutProps> = {}): BoardLayoutProps {
  const state = hookState({ fold, items: { items: ITEMS, hidden: new Set(), missing: new Set(), partial: false, hasOlderClosed: false, walks: new Map() }, ...over })
  const base = { state, spec: SPEC, view: { id: 1, name: 'Board', layout: 'board' as const, q: '' }, items: ITEMS, placements, onOpenItem: vi.fn(), home: HOME_REF, addr: { owner: 'alice', name: 'project' }, ...extra }
  return { ...base, rows: extra.rows ?? base.items.flatMap((item) => (base.placements.has(item.id) ? [{ item, placement: base.placements.get(item.id) as Placement }] : [])) }
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  resolveItemByNumber.mockReset()
  resolveAnyRepoWith.mockReset()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const render = async (p: BoardLayoutProps): Promise<void> => {
  await act(async () => root.render(<BoardKanban {...p} />))
  await settle()
}
const columns = () => [...el.querySelectorAll<HTMLElement>('[data-testid="kanban-column"]')]
const cardsIn = (col: HTMLElement) => [...col.querySelectorAll<HTMLElement>('[data-testid="kanban-card"]')].map((c) => Number(c.dataset['number']))
const card = (n: number) => el.querySelector<HTMLElement>(`[data-testid="kanban-card"][data-number="${n}"]`) as HTMLElement
const key = (target: HTMLElement, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
const type = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('board layout', () => {
  it('draws a column per status with the fold’s cards, counts and the closed item in Done', async () => {
    await render(props())
    const cols = columns()
    expect(cols.map((c) => c.getAttribute('aria-label'))).toEqual(['Todo', 'In progress', 'Done'])
    expect(cols.map(cardsIn)).toEqual([[1, 5], [2, 3], [4]])
    expect(cols.map((c) => c.querySelector('[data-testid="column-count"]')?.textContent)).toEqual(['2', '2', '1'])
    // The card says what it is: number, title, state, labels, its fields.
    expect(card(1).getAttribute('aria-label')).toBe('project #1 Write the parser, Open issue, labels bug, Priority P0, Estimate 3, Iteration 1, Start Oct 26, 2026, Target Nov 6, 2026')
    expect(card(1).textContent).toContain('Estimate 3')
    // Two repositories on the board: cards carry their repository's name (the label in full as the tooltip).
    expect(card(5).textContent).toContain('project#5')
    expect(card(5).querySelector('[title="project#5"]')).not.toBeNull()
    // The column sums the view's first number field.
    expect(cols[1]?.querySelector('[data-testid="column-sum"]')?.textContent).toBe('Estimate 7')
  })

  it('shows a column over its WIP limit in red, with words for screen readers', async () => {
    await render(props())
    const wip = columns()[1]?.querySelector('[data-testid="column-wip"]') as HTMLElement
    expect(wip.dataset['over']).toBe('true')
    expect(wip.textContent).toBe('2 / 1, over the limit')
    expect(columns()[0]?.querySelector('[data-testid="column-wip"]')).toBeNull()
  })

  it('moves a card from the keyboard: Space picks it up, arrows move it, Space drops it', async () => {
    const p = props()
    await render(p)
    const live = () => el.querySelector('[data-testid="kanban-live"]')?.textContent
    card(1).focus()
    await key(card(1), ' ')
    expect(live()).toContain('Picked up #1 Write the parser. Todo, position 1 of 2.')
    await key(card(1), 'ArrowRight')
    expect(live()).toBe('In progress, position 1 of 3')
    await key(card(1), 'ArrowDown')
    expect(live()).toBe('In progress, position 2 of 3')
    await key(card(1), ' ')
    expect(live()).toBe('Dropped #1 Write the parser in In progress, position 2 of 3.')
    // Between #2 and #3: just before #3 in the column's rank order.
    expect(p.state.move).toHaveBeenCalledWith({ id: id('a'), repoId: HOME }, { col: 2 }, [
      { id: id('b'), rank: placements.get(id('b'))?.rank },
      { id: id('c'), rank: placements.get(id('c'))?.rank },
    ], id('c'))
  })

  it('keeps the focus on a card dropped in another column once the move renders there', async () => {
    const p = props()
    await render(p)
    card(1).focus()
    await key(card(1), ' ')
    await key(card(1), 'ArrowRight')
    await key(card(1), ' ')
    // The hook's optimistic move renders after the drop: the card's element in Todo is gone.
    const rows = p.rows.map((r) => (r.item.id === id('a') ? { ...r, placement: { ...r.placement, col: 2 } } : r))
    await render({ ...p, rows, placements: new Map(rows.map((r) => [r.item.id, r.placement])) })
    expect(cardsIn(columns()[1] as HTMLElement)).toContain(1)
    expect(document.activeElement).toBe(card(1))
  })

  it('shows a board spanning repositories by repo name, never an owner id that hides the number', async () => {
    const owner = 'G1SAVd3dfdjNHJo2YmaNmhKThEa9kPVcwefCpeinC8ce'
    const items = ITEMS.map((i) => ({ ...i, repo: `${owner}/${i.repoId === HOME ? 'project' : 'tools'}` }))
    const p = props({}, { items })
    await render({ ...p, rows: p.rows.map((r) => ({ ...r, item: items.find((i) => i.id === r.item.id) ?? r.item })) })
    expect(card(5).textContent).toContain('tools#5')
    expect(card(5).textContent).not.toContain(owner)
    expect(card(5).querySelector(`[title="${owner}/tools#5"]`)).not.toBeNull()
    expect(card(5).getAttribute('aria-label')).toMatch(/^tools #5 Secret/)
    // Swimlanes by repository name the owner shortly (the full label is what repo: matches).
    await render({ ...p, rows: p.rows.map((r) => ({ ...r, item: items.find((i) => i.id === r.item.id) ?? r.item })), view: { ...p.view, lane: 'repo' } })
    expect([...el.querySelectorAll('[data-testid="kanban-lane"]')].map((l) => l.getAttribute('aria-label'))).toEqual(['G1SAVd3…nC8ce/project', 'G1SAVd3…nC8ce/tools'])
    const { repoLabelText } = await import('./board-fields')
    expect(repoLabelText('alice/tools')).toBe('alice/tools')
  })

  it('cancels a keyboard move with Escape, writing nothing', async () => {
    const p = props()
    await render(p)
    await key(card(2), ' ')
    await key(card(2), 'ArrowLeft')
    await key(card(2), 'Escape')
    expect(el.querySelector('[data-testid="kanban-live"]')?.textContent).toBe('Move cancelled. #2 Ship the table is back in In progress, position 1 of 2.')
    expect(p.state.move).not.toHaveBeenCalled()
  })

  it('warns when a drop takes a column over its WIP limit, and still moves', async () => {
    const { useToasts } = await import('@/hooks/use-toasts')
    const p = props()
    await render(p)
    await key(card(1), ' ')
    await key(card(1), 'ArrowRight')
    await key(card(1), 'Enter')
    expect(p.state.move).toHaveBeenCalledTimes(1)
    expect(useToasts.getState().toasts.some((t) => t.title === 'In progress is over its limit' && t.tone === 'warn')).toBe(true)
  })

  it('is read-only for a viewer who may not place cards: no grips, no quick add, Space opens', async () => {
    const p = props({ can: { place: false, edit: false } })
    await render(p)
    expect(el.querySelector('[data-testid="card-grip"]')).toBeNull()
    expect(el.querySelector('[data-testid="quick-add-open"]')).toBeNull()
    expect(el.querySelector('[aria-label$="column actions"]')).toBeNull()
    await key(card(1), ' ')
    expect(p.onOpenItem).toHaveBeenCalledWith(id('a'))
    expect(p.state.move).not.toHaveBeenCalled()
  })
})

describe('swimlanes and phones', () => {
  it('carries the copy of a card picked up in its second swimlane, from that swimlane', async () => {
    // #2 has two labels: it shows in the "bug" and the "ui" swimlanes.
    const items = ITEMS.map((i) => (i.number === 2 ? { ...i, labels: ['bug', 'ui'] } : i))
    const p = props({}, { items, view: { id: 1, name: 'Board', layout: 'board', q: '', lane: 'label' } })
    await render(p)
    const copies = [...el.querySelectorAll<HTMLElement>('[data-testid="kanban-card"][data-number="2"]')]
    expect(copies).toHaveLength(2)
    const second = copies[1] as HTMLElement
    second.focus()
    await key(second, ' ')
    expect(el.querySelector('[data-testid="kanban-live"]')?.textContent).toContain('In progress, swimlane ui, position 1 of 1.')
    // Labels are the item's own: Up and Down stay in the swimlane, Left moves the column.
    await key(second, 'ArrowUp')
    await key(second, 'ArrowLeft')
    expect(el.querySelector('[data-testid="kanban-live"]')?.textContent).toBe('Todo, swimlane ui, position 1 of 1')
    await key(second, ' ')
    expect(p.state.move).toHaveBeenCalledWith({ id: id('b'), repoId: HOME }, { col: 1 }, expect.any(Array), null)
  })

  it('shows one column at a time on a phone, and a keyboard carry keeps its card in view', async () => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    const p = props()
    await render(p)
    expect(columns().map((c) => c.getAttribute('aria-label'))).toEqual(['Todo'])
    const tabs = [...el.querySelectorAll<HTMLElement>('[data-testid="column-switcher"] [role="tab"]')]
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    card(1).focus()
    await key(card(1), ' ')
    await key(card(1), 'ArrowRight')
    // Still the Todo column, the card still focused; the target column's tab is marked.
    expect(document.activeElement).toBe(card(1))
    expect(tabs[1]?.className).toContain('ring-2')
    await key(card(1), ' ')
    expect(p.state.move).toHaveBeenCalledWith({ id: id('a'), repoId: HOME }, { col: 2 }, expect.any(Array), id('b'))
  })

  it('puts a carried card back when it loses focus', async () => {
    const p = props()
    await render(p)
    card(1).focus()
    await key(card(1), ' ')
    await act(async () => card(1).blur())
    expect(el.querySelector('[data-testid="kanban-live"]')?.textContent).toContain('Move cancelled.')
    await act(async () => card(2).click())
    expect(p.onOpenItem).toHaveBeenCalledWith(id('b'))
  })
})

describe('quick add', () => {
  const openIn = async (col: number): Promise<HTMLInputElement> => {
    const btn = columns()[col]?.querySelector<HTMLButtonElement>('[data-testid="quick-add-open"]') as HTMLButtonElement
    await act(async () => btn.click())
    return columns()[col]?.querySelector('[data-testid="quick-add"] input') as HTMLInputElement
  }
  const submit = async (input: HTMLInputElement, text: string): Promise<void> => {
    act(() => type(input, text))
    await act(async () => input.form?.requestSubmit())
    await settle()
  }

  it('reads a title, #12, owner/name#12 and an item link', () => {
    expect(quickAddPlan('  Fix the login ')).toEqual({ kind: 'title', title: 'Fix the login' })
    expect(quickAddPlan('#12')).toEqual({ kind: 'ref', number: 12 })
    expect(quickAddPlan('alice/tools#5')).toEqual({ kind: 'ref', owner: 'alice', name: 'tools', number: 5 })
    expect(quickAddPlan('https://forge.example/repo/issue/?owner=alice&name=tools&number=9')).toEqual({ kind: 'ref', owner: 'alice', name: 'tools', number: 9 })
    expect(quickAddPlan('   ')).toEqual({ kind: 'empty' })
  })

  it('makes an issue from a title, at the bottom of the column', async () => {
    const p = props({ quickAdd: vi.fn(async () => ({ item: { ...ITEMS[0], id: id('z'), number: 9 }, card: null, cardError: null }) as never) })
    await render(p)
    await submit(await openIn(0), 'Write the docs')
    expect(p.state.quickAdd).toHaveBeenCalledWith(expect.objectContaining({ title: 'Write the docs', col: 1, target: HOME_REF }))
    const input = columns()[0]?.querySelector('[data-testid="quick-add"] input') as HTMLInputElement
    expect(input.value).toBe('')
  })

  it('adds an existing item by #number in this repo', async () => {
    resolveItemByNumber.mockResolvedValue({ id: id('z'), kind: 'issue' })
    const p = props()
    await render(p)
    await submit(await openIn(1), '#12')
    expect(resolveItemByNumber).toHaveBeenCalledWith({}, HOME_REF, 12)
    expect(p.state.add).toHaveBeenCalledWith([{ id: id('z'), repoId: HOME }], 2, { confirmCrossRepo: true })
  })

  it('adds another repo’s item by owner/name#number, and says when there is none', async () => {
    resolveAnyRepoWith.mockResolvedValue({ repo: OTHER_REF })
    resolveItemByNumber.mockResolvedValueOnce({ id: id('y'), kind: 'pr' }).mockResolvedValueOnce(null)
    const p = props()
    await render(p)
    const input = await openIn(0)
    await submit(input, 'alice/tools#5')
    expect(resolveAnyRepoWith).toHaveBeenCalledWith({}, FORGE, { owner: 'alice', name: 'tools' })
    expect(p.state.add).toHaveBeenCalledWith([{ id: id('y'), repoId: OTHER_REPO }], 1, { confirmCrossRepo: true })
    await submit(input, 'alice/tools#6')
    expect(el.querySelector('[data-testid="quick-add-error"]')?.textContent).toBe('No issue or pull request #6 in alice/tools.')
  })

  it('asks first when a private repo’s board would name another repo’s item', async () => {
    resolveAnyRepoWith.mockResolvedValue({ repo: OTHER_REF })
    resolveItemByNumber.mockResolvedValue({ id: id('y'), kind: 'issue' })
    const p = props({}, { home: { ...HOME_REF, visibility: 'private' } })
    await render(p)
    await submit(await openIn(0), 'alice/tools#5')
    expect(document.body.textContent).toContain('Place another repo’s item?')
    expect(p.state.add).not.toHaveBeenCalled()
    const ok = document.querySelector<HTMLButtonElement>('[data-testid="confirm-action"]') as HTMLButtonElement
    await act(async () => ok.click())
    await settle()
    expect(p.state.add).toHaveBeenCalledTimes(1)
  })
})
