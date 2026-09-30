// @vitest-environment jsdom
/**
 * QW-019: the Labels and Milestones pages, as a maintainer and as a visitor.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import type { LabelDef } from '@/lib/repo'
import type { Milestone } from '@/lib/rules/parity'

const ME = 'MeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe'
const OTHER = 'OtherOtherOtherOtherOtherOtherOtherOtherOthe'
let role: 'maintainer' | 'writer' | null = 'maintainer'

vi.mock('next/navigation', () => ({ usePathname: () => '/repo/labels/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined, push: () => undefined }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: ME }, identity: ME, balance: '100000000000', keyLimits: null }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role, known: true, failed: false, retry: () => undefined }) }))

const labels: LabelDef[] = [
  { name: 'bug', color: '#d73a4a', description: "Something isn't working", retired: false, createdAt: 1, id: 'l1' },
  { name: 'docs', color: '#0075ca', description: '', retired: false, createdAt: 2, id: 'l2' },
  { name: 'old', color: '', description: '', retired: true, createdAt: 3, id: 'l3' },
]
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  readLabels: async () => labels,
  // `docs` was also defined by another member: deleting it writes a retirement first.
  readLabelDocs: async (_sdk: unknown, _repo: unknown, name: string) =>
    name === 'docs' ? [{ id: 'l2', owner: OTHER, createdAt: 2 }] : [{ id: 'l1', owner: ME, createdAt: 1 }],
  issueMilestoneItems: async () => [
    { open: true, milestone: 'v1.0' },
    { open: false, milestone: 'v1.0' },
  ],
  pullMilestoneItems: async () => [{ open: false, milestone: 'v1.0' }],
}))
const milestones: Milestone[] = [
  { id: 'm1', title: 'v1.0', description: 'The first release', dueOn: Date.UTC(2020, 0, 1), closed: false, open: 0, closedItems: 0 },
  { id: 'm2', title: 'v2.0', description: '', dueOn: null, closed: false, open: 0, closedItems: 0 },
  { id: 'm3', title: 'v0.9', description: '', dueOn: null, closed: true, open: 0, closedItems: 0 },
]
vi.mock('@/lib/repo/milestones', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo/milestones')>()),
  readMilestoneDefs: async () => ({
    docs: milestones.map((m) => ({ id: m.id, title: m.title, description: m.description, dueOn: m.dueOn, closed: m.closed, createdAt: 1 })),
    owners: new Map([
      ['v1.0', [{ id: 'm1', owner: ME }]],
      ['v2.0', [{ id: 'm2', owner: OTHER }]],
      ['v0.9', [{ id: 'm3', owner: ME }]],
    ]),
  }),
}))

const { LabelsContent } = await import('./labels-content')
const { MilestonesContent } = await import('./milestones-content')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOME = { repo: { repoId: 'r', forge: { core: 'C', collab: 'L', community: 'M', group: 'G' }, ownerId: ME, name: 'n', visibility: 'public' }, description: '', config: null } as unknown as RepoHome
const addr = { owner: 'o', name: 'n' }

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  role = 'maintainer'
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const button = (text: RegExp): HTMLButtonElement | undefined => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? ''))
const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Labels page (QW-019)', () => {
  it('lists the live labels with links to their issues, and the retired ones apart', async () => {
    await act(async () => root.render(<LabelsContent home={HOME} addr={addr} />))
    await settle()
    const rows = [...el.querySelectorAll('[data-testid="label-row"]')]
    expect(rows.map((r) => r.getAttribute('data-label'))).toEqual(['bug', 'docs'])
    expect(rows[0]?.textContent).toContain("Something isn't working")
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/repo/issues/?owner=o&name=n&label=bug&state=all')
    expect(el.textContent).toContain('2 labels')
    expect(el.querySelector('[data-testid="retired-labels"]')?.textContent).toContain('1 retired label')
  })

  it('lets a member create one (refusing a name in use), and edit one with its name fixed', async () => {
    await act(async () => root.render(<LabelsContent home={HOME} addr={addr} />))
    await settle()
    act(() => button(/New label/)!.click())
    const form = el.querySelector('[data-testid="label-new-form"]')!
    const name = form.querySelector('#new-label-name') as HTMLInputElement
    act(() => type(name, 'bug'))
    expect(form.textContent).toContain('A label with this name exists.')
    expect((button(/Create label/) as HTMLButtonElement).disabled).toBe(true)
    // A name differing only in case is the same label (as the issue page's picker has it).
    act(() => type(name, 'Bug'))
    expect(form.textContent).toContain('A label with this name exists.')
    act(() => type(name, 'old'))
    expect(form.textContent).toContain('A retired label has this name')
    // The schema's byte bound, not only its character bound: 30 three-byte characters are 90 bytes.
    act(() => type(name, '界'.repeat(30)))
    expect((button(/Create label/) as HTMLButtonElement).disabled).toBe(true)
    act(() => type(name, 'good first issue'))
    expect((button(/Create label/) as HTMLButtonElement).disabled).toBe(false)
    act(() => button(/Create label/)!.click())
    expect(document.body.textContent).toContain('Create label "good first issue"')
    // Edit: the name is fixed (issues carry a label by its name).
    act(() => button(/Cancel/)!.click())
    act(() => button(/Edit label bug/)!.click())
    expect((el.querySelector('#label-bug-name') as HTMLInputElement).disabled).toBe(true)
    // Delete asks first, and says what it does: here a retirement, as another member defined it too.
    await act(async () => button(/Delete label docs/)!.click())
    await settle()
    expect(document.body.textContent).toContain('Delete label "docs"')
    expect(document.body.textContent).toContain('a retirement is written first')
  })

  it('restores a retired label with a colour and description chosen afresh', async () => {
    await act(async () => root.render(<LabelsContent home={HOME} addr={addr} />))
    await settle()
    act(() => button(/Restore/)!.click())
    const form = el.querySelector('[data-testid="label-restore-form"]')!
    expect((form.querySelector('#label-old-name') as HTMLInputElement).disabled).toBe(true)
    act(() => button(/Restore label/)!.click())
    expect(document.body.textContent).toContain('Restore label "old"')
  })

  it('shows a visitor no write controls', async () => {
    role = null
    await act(async () => root.render(<LabelsContent home={HOME} addr={addr} />))
    await settle()
    expect(button(/New label/)).toBeUndefined()
    expect(button(/Edit label/)).toBeUndefined()
    expect(button(/Delete label/)).toBeUndefined()
  })
})

describe('Milestones page (QW-019)', () => {
  it('lists open milestones with due dates and progress, and the closed ones on their tab', async () => {
    await act(async () => root.render(<MilestonesContent home={HOME} addr={addr} />))
    await settle()
    const tabs = [...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim())
    expect(tabs).toEqual(['2 Open', '1 Closed'])
    const rows = [...el.querySelectorAll('[data-testid="milestone-row"]')]
    expect(rows.map((r) => r.getAttribute('data-title'))).toEqual(['v1.0', 'v2.0'])
    // Two of its three items (issues and PRs) are closed.
    expect(rows[0]?.querySelector('[data-testid="milestone-progress"]')?.textContent).toContain('67% complete')
    expect(rows[0]?.textContent).toMatch(/Past due by \d+ days/)
    expect(rows[1]?.textContent).toContain('No due date')
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/repo/issues/?owner=o&name=n&state=all&q=milestone%3Av1.0')
    // The counts cover PRs too, so their list is linked beside the issues'.
    expect([...(rows[0]?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'))).toContain('/repo/pulls/?owner=o&name=n&state=all&q=milestone%3Av1.0')
    act(() => (el.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click())
    expect([...el.querySelectorAll('[data-testid="milestone-row"]')].map((r) => r.getAttribute('data-title'))).toEqual(['v0.9'])
    expect(button(/Reopen/)).toBeDefined()
  })

  it("does not offer to delete a milestone another member also defined; it offers to close it", async () => {
    await act(async () => root.render(<MilestonesContent home={HOME} addr={addr} />))
    await settle()
    expect(button(/Delete milestone v1.0/)?.disabled).toBe(false)
    const other = button(/Delete milestone v2.0/)!
    expect(other.disabled).toBe(true)
    expect(other.title).toMatch(/Close it instead/)
    act(() => button(/Delete milestone v1.0/)!.click())
    expect(document.body.textContent).toContain('Delete milestone "v1.0"')
  })

  it('refuses to create one in a private repository, and says why', async () => {
    const priv = { ...HOME, repo: { ...HOME.repo, visibility: 'private' } } as unknown as RepoHome
    await act(async () => root.render(<MilestonesContent home={priv} addr={addr} />))
    await settle()
    expect(button(/New milestone/)).toBeUndefined()
    expect(el.querySelector('[data-testid="milestones-private-note"]')?.textContent).toMatch(/sealed/)
  })
})
