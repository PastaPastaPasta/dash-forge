// @vitest-environment jsdom
/**
 * The Boards list (design `docs/design/boards.md` §2.1, §5.1): open and closed boards, what a
 * row says, the empty state, and New board (a template, priced, then the board opens) for
 * maintainers and writers only.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import type { BoardView } from '@/lib/repo'
import { defaultSpec } from '@/lib/rules/boards'

const ME = 'MeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe'
const HOME_ID = 'Home1111111111111111111111111111111111111111'
const push = vi.fn()
let can = { place: true, edit: true }
let boards: BoardView[] = []
const create = vi.fn(async () => ({ key: 42, documentId: 'd', created: true, result: {} }))

vi.mock('next/navigation', () => ({ usePathname: () => '/repo/boards/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined, push }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: ME }, identity: ME, balance: '100000000000', keyLimits: null }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/lib/spend-toast', () => ({ spendAction: (_labels: unknown, run: (tag: (s: unknown) => unknown) => Promise<unknown>) => run((s) => s) }))
vi.mock('@/hooks/use-board', () => ({
  useBoards: () => ({ data: boards, loading: false, error: null, cause: null, settled: true, reload: () => undefined, role: can.edit ? 'writer' : 'triage', can, create }),
}))

const { BoardsList } = await import('./boards-list')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FORGE = { core: 'C', collab: 'L', community: 'M', meta: 'X', group: 'G' }
const home = (forge: object = FORGE): RepoHome => ({ repo: { repoId: HOME_ID, forge, ownerId: ME, name: 'project', visibility: 'public' }, description: '', config: null }) as unknown as RepoHome
const addr = { owner: 'o', name: 'project' }
const NOW = Date.now()
const board = (key: number, name: string | null, state: BoardView['state'] = 'open', desc?: string): BoardView => ({
  key,
  repoId: HOME_ID,
  state,
  name,
  spec: name === null ? null : { ...defaultSpec(HOME_ID, NOW), ...(desc ? { desc } : {}) },
  specError: name === null ? 'unreadable' : null,
  sealed: name === null,
  newest: { id: `b${key}`, ownerId: ME, updatedAt: NOW - 3 * 3_600_000 },
  revisions: [],
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  can = { place: true, edit: true }
  boards = []
  push.mockReset()
  create.mockClear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const button = (text: RegExp): HTMLButtonElement | undefined => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''))
const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Boards list', () => {
  it('lists the open boards with their description, columns and last change; closed ones under Closed', () => {
    boards = [board(1, 'Roadmap', 'open', 'What ships when'), board(2, 'Old sprint', 'closed'), board(3, null)]
    act(() => root.render(<BoardsList home={home()} addr={addr} />))
    const rows = [...el.querySelectorAll('[data-testid="board-row"]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Roadmap')
    expect(rows[0]?.textContent).toContain('What ships when')
    expect(rows[0]?.textContent).toContain('3 columns')
    expect(rows[0]?.textContent).toContain('Updated 3h ago')
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/repo/board/?owner=o&name=project&b=1')
    expect(rows[1]?.textContent).toContain('Encrypted board')
    expect(el.textContent).toContain('2 Open')
    act(() => button(/Closed/)?.click())
    expect([...el.querySelectorAll('[data-testid="board-row"]')].map((r) => r.textContent)).toEqual([expect.stringContaining('Old sprint')])
  })

  it('explains boards when there are none; a triage member gets no New board', () => {
    can = { place: true, edit: false }
    act(() => root.render(<BoardsList home={home()} addr={addr} />))
    expect(el.textContent).toContain('No boards yet')
    expect(el.textContent).toContain('Boards lay out issues and pull requests in columns')
    expect(el.querySelector('[data-testid="new-board"]')).toBeNull()
  })

  it('creates a board from a template, priced, and opens it', async () => {
    act(() => root.render(<BoardsList home={home()} addr={addr} />))
    act(() => (el.querySelector('[data-testid="new-board"]') as HTMLButtonElement).click())
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.textContent).toContain('New board')
    expect(dialog.querySelector('[data-testid="cost-preview"]')).not.toBeNull()
    expect(button(/Sign & create/)?.disabled).toBe(true)
    type(document.querySelector('[data-testid="new-board-name"]') as HTMLInputElement, '  Sprints ')
    act(() => (document.querySelector('[data-testid="template-sprint"]') as HTMLButtonElement).click())
    expect(document.querySelector('[data-testid="template-sprint"]')?.getAttribute('aria-checked')).toBe('true')
    await act(async () => button(/Sign & create/)?.click())
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
    const input = (create.mock.calls[0] as unknown as [{ name: string; spec: { columns: { name: string }[] }; intent: string }])[0]
    expect(input.name).toBe('Sprints')
    expect(input.spec.columns.map((c) => c.name)).toEqual(['Backlog', 'Todo', 'In progress', 'In review', 'Done'])
    expect(typeof input.intent).toBe('string')
    expect(push).toHaveBeenCalledWith('/repo/board/?owner=o&name=project&b=42')
  })

  it('says boards are not on a network without them', () => {
    act(() => root.render(<BoardsList home={home({ core: 'C', collab: 'L', community: 'M', group: 'G' })} addr={addr} />))
    expect(el.textContent).toContain("Boards aren't available on this network yet.")
  })
})
