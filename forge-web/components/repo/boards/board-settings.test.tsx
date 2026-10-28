// @vitest-environment jsdom
/**
 * A board's settings (design `docs/design/boards.md` §2, §5.1, §8): the draft saved as one
 * priced write, precise problems before it, deleting a field without breaking a view, the
 * source filter checked as typed, close and delete, and what a reader sees.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import type { BoardView } from '@/lib/repo'
import { defaultSpec, type BoardSpec } from '@/lib/rules/boards'

const ME = 'MeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe'
const HOME_ID = 'Home1111111111111111111111111111111111111111'
const NOW = Date.UTC(2026, 9, 27, 12)
let role: 'maintainer' | 'writer' | 'triage' | null = 'writer'
let board: BoardView
let fresh: BoardView | null = null
let cards: { id: string; ownerId: string; updatedAt: number; item: string; col: number | null; rank: string | null; f: string | null; state: number }[] = []
const push = vi.fn()
const saveBoard = vi.fn(async () => ({ key: 9, documentId: 'd', created: false, result: {} }))
const setBoardState = vi.fn(async () => ({ key: 9, documentId: 'd', created: false, result: {} }))

vi.mock('next/navigation', () => ({ usePathname: () => '/repo/board/settings/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined, push }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: ME }, identity: ME, balance: '100000000000', keyLimits: null }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role, known: true, failed: false, retry: () => undefined }) }))
vi.mock('@/lib/spend-toast', () => ({ spendAction: (_labels: unknown, run: (tag: (s: unknown) => unknown) => Promise<unknown>) => run((s) => s) }))
vi.mock('@/lib/view/discovery', () => ({ listReposByOwner: async () => ({ owned: [{ key: HOME_ID, slug: 'project', name: 'project', ownerId: ME }, { key: 'Other222222222222222222222222222222222222222', slug: 'docs', name: 'docs', ownerId: ME }], member: [] }) }))
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  boardsDeployed: async () => true,
  readBoard: async () => ({ board, cards, since: 0 }),
  readBoardDefinition: async () => fresh ?? board,
  readRepoById: async () => null,
  saveBoard,
  setBoardState,
}))

const { BoardSettings } = await import('./board-settings')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOME = { repo: { repoId: HOME_ID, forge: { core: 'C', collab: 'L', community: 'M', meta: 'X', group: 'G' }, ownerId: ME, name: 'project', visibility: 'public' }, description: '', config: null } as unknown as RepoHome
const addr = { owner: 'o', name: 'project' }
const boardOf = (spec: BoardSpec, state: BoardView['state'] = 'open'): BoardView => ({
  key: 9,
  repoId: HOME_ID,
  state,
  name: 'Roadmap',
  spec,
  specError: null,
  sealed: false,
  newest: { id: 'b9', ownerId: ME, updatedAt: NOW },
  revisions: [{ id: 'b9', ownerId: ME, updatedAt: NOW }],
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  role = 'writer'
  board = boardOf(defaultSpec(HOME_ID, NOW))
  cards = []
  fresh = null
  saveBoard.mockClear()
  setBoardState.mockClear()
  push.mockReset()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  el.remove()
})
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const button = (text: RegExp): HTMLButtonElement | undefined => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? ''))
const labelled = <T extends Element>(label: string): T => document.querySelector(`[aria-label="${label}"]`) as T
const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const open = async (): Promise<void> => {
  await act(async () => root.render(<BoardSettings home={HOME} addr={addr} boardKey={9} />))
  await settle()
}
const savedSpec = (): BoardSpec => (saveBoard.mock.calls[0] as unknown as [unknown, unknown, unknown, number, { spec: BoardSpec; name: string }])[4].spec

describe('Board settings', () => {
  it('saves the draft as one priced write: renamed and added columns, names trimmed', async () => {
    await open()
    expect(el.querySelectorAll('[data-testid="column-row"]')).toHaveLength(3)
    expect((el.querySelector('[data-testid="settings-save"]') as HTMLButtonElement).disabled).toBe(true)
    type(labelled<HTMLInputElement>('Name of column 2'), 'Doing ')
    act(() => button(/Add column/)?.click())
    expect(el.querySelectorAll('[data-testid="column-row"]')).toHaveLength(4)
    expect(el.textContent).toContain('Unsaved changes')
    expect(el.querySelector('[data-testid="size-meter"]')?.textContent).toMatch(/\/ 4,096 bytes/)
    act(() => (el.querySelector('[data-testid="settings-save"]') as HTMLButtonElement).click())
    expect(document.querySelector('[role="dialog"] [data-testid="cost-preview"]')).not.toBeNull()
    await act(async () => button(/Sign & save/)?.click())
    await settle()
    expect(saveBoard).toHaveBeenCalledTimes(1)
    expect(savedSpec().columns.map((c) => c.name)).toEqual(['Todo', 'Doing', 'Done', 'Column 4'])
  })

  it('never gives a new column, field or option an id a card still names', async () => {
    // a card still names deleted column 6, field 9 and Priority's deleted option 7
    cards = [{ id: 'c', ownerId: ME, updatedAt: NOW, item: 'i', col: 6, rank: null, f: JSON.stringify({ 1: 7, 9: 'x' }), state: 0 }]
    await open()
    act(() => button(/Add column/)?.click())
    act(() => button(/Add option/)?.click())
    act(() => button(/Add field/)?.click())
    type(labelled<HTMLInputElement>('New field name'), 'Size')
    act(() => button(/^Add$/)?.click())
    act(() => (el.querySelector('[data-testid="settings-save"]') as HTMLButtonElement).click())
    await act(async () => button(/Sign & save/)?.click())
    await settle()
    const spec = savedSpec()
    expect(spec.columns.at(-1)?.id).toBe(7)
    expect(spec.fields.at(-1)).toMatchObject({ id: 10, name: 'Size' })
    expect(spec.fields[0]?.options?.at(-1)?.id).toBe(8)
  })

  it('refuses to save over a revision another member wrote meanwhile', async () => {
    await open()
    type(labelled<HTMLInputElement>('Name of column 1'), 'Backlog')
    fresh = { ...board, newest: { id: 'b9', ownerId: 'Other', updatedAt: NOW + 5 } }
    act(() => (el.querySelector('[data-testid="settings-save"]') as HTMLButtonElement).click())
    await act(async () => button(/Sign & save/)?.click())
    await settle()
    expect(saveBoard).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Someone changed this board while you were editing. Reload and try again.')
    expect(el.querySelector('[data-testid="settings-stale"]')).not.toBeNull()
  })

  it('names a problem precisely and holds the save', async () => {
    await open()
    type(labelled<HTMLInputElement>('Name of column 2'), 'todo')
    expect(el.textContent).toContain('Another column has this name.')
    expect(el.querySelector('[data-testid="settings-problem"]')).not.toBeNull()
    expect((el.querySelector('[data-testid="settings-save"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('deletes a field and the views pointing at it', async () => {
    await open()
    act(() => button(/Delete field Iteration/)?.click())
    act(() => (el.querySelector('[data-testid="settings-save"]') as HTMLButtonElement).click())
    await act(async () => button(/Sign & save/)?.click())
    await settle()
    const spec = savedSpec()
    expect(spec.fields.map((f) => f.name)).toEqual(['Priority', 'Estimate'])
    expect(spec.views.find((v) => v.name === 'Roadmap')).toEqual({ id: 3, name: 'Roadmap', layout: 'roadmap', q: '' })
    expect(spec.views.find((v) => v.name === 'Table')?.cols).toEqual(['title', 'status', 'assignees', 'f1', 'f2'])
  })

  it('edits a select field’s options and previews an iteration cadence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    await open()
    act(() => button(/Add option/)?.click())
    expect(labelled<HTMLInputElement>('Option 5 of Priority').value).toBe('Option 5')
    expect(el.querySelector('[data-testid="iteration-preview"]')?.textContent).toContain('Iteration 1: Oct 26 – Nov 8, 2026')
    const days = labelled<HTMLInputElement>('Days in each Iteration')
    act(() => days.focus())
    // typed freely: clearing it is not 1, and 7 is checked only when the field is left
    type(days, '')
    type(days, '7')
    act(() => days.blur())
    expect(el.querySelector('[data-testid="iteration-preview"]')?.textContent).toContain('Iteration 2: Nov 2 – Nov 8, 2026')
  })

  it('checks a source filter as it is typed', async () => {
    await open()
    type(labelled<HTMLInputElement>('Filter of source 1'), 'label:bug status:Todo')
    expect(el.querySelector('[data-testid="source-unresolved"]')?.textContent).toContain('Not applied: status:Todo')
    expect(labelled<HTMLSelectElement>('Repo of source 1').textContent).toContain('project (this repo)')
    expect(labelled<HTMLSelectElement>('Repo of source 1').textContent).toContain('docs')
  })

  it('closes and deletes the board, each its own write', async () => {
    await open()
    act(() => button(/Close board/)?.click())
    await act(async () => button(/Sign & close/)?.click())
    await settle()
    expect(setBoardState).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 9, 'closed', expect.anything())
    await act(async () => new Promise((r) => setTimeout(r, 950)))
    act(() => (el.querySelector('[data-testid="delete-board"]') as HTMLButtonElement).click())
    await act(async () => button(/Sign & delete/)?.click())
    await settle()
    expect(setBoardState).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.anything(), 9, 'deleted', expect.anything())
    expect(push).toHaveBeenCalledWith('/repo/boards/?owner=o&name=project')
  })

  it('is read-only for a triage member, and for a closed board until reopened', async () => {
    role = 'triage'
    await open()
    expect(el.querySelector('[data-testid="settings-read-only"]')?.textContent).toContain('Only maintainers and members with Write')
    expect((el.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    expect(el.querySelector('[data-testid="settings-save-bar"]')).toBeNull()
    expect(el.querySelector('[data-testid="delete-board"]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(el)
    role = 'maintainer'
    board = boardOf(defaultSpec(HOME_ID, NOW), 'closed')
    await open()
    expect(el.textContent).toContain('This board is closed. Reopen it to change it.')
    expect((el.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    expect(button(/Reopen board/)).toBeDefined()
  })
})
