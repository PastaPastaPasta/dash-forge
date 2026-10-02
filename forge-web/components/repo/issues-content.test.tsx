// @vitest-environment jsdom
/**
 * The issue list's pinned issues (QW3-003): page 1 reads them only when the repo's member-event
 * feed is short; otherwise it says so and reads them when asked, keeping the list on screen.
 * The issue index is faked; what the list asks it for is asserted.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IssueListPage, IssueRow, IssueSelection } from '@/lib/repo'

vi.mock('next/link', async () => {
  const { forwardRef } = await import('react')
  return { default: forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>((props, ref) => <a ref={ref} {...props} />) }
})
let params = ''
const replaced: string[] = []
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (href: string) => replaced.push(href), push: () => undefined }),
  usePathname: () => '/repo/issues/',
  useSearchParams: () => new URLSearchParams(params),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: null, signer: null, locked: false }) }))
vi.mock('@/hooks/use-mirror-trust', () => ({ useMirrorTrust: () => null }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useRepoWriteGeneration: () => 0 }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: () => '', disabledReason: null }) }))
vi.mock('@/hooks/use-first-write', () => ({ useFirstWrite: () => ({}) }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => null }))
vi.mock('@/components/repo/use-repo-totals', () => ({ useRepoTotals: () => 704 }))
vi.mock('@/components/repo/use-milestones', () => ({ useMilestones: () => ({ data: [] }) }))
vi.mock('@/components/repo/mirror-note', () => ({ MirrorNote: () => null, MirrorComposeHint: () => null }))
vi.mock('@/components/repo/byline', () => ({ Byline: () => <span>someone</span> }))
vi.mock('@/components/repo/target-href', () => ({ useRepoLinks: () => null }))
vi.mock('@/components/repo/issue-templates', () => ({ IssueTemplatePicker: () => null }))

const asked: { q: IssueSelection; pins: boolean }[] = []
let answer: IssueListPage
vi.mock('@/lib/repo', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/repo')>()
  return {
    ...real,
    queryIssues: async (_sdk: unknown, _repo: unknown, q: IssueSelection, _total: unknown, _network: unknown, options: { pins?: boolean }) => {
      asked.push({ q, pins: options.pins === true })
      return options.pins === true ? { ...answer, pinsUnread: false, pinned: [issue(41)] } : answer
    },
  }
})

import type { RepoHome } from '@/lib/view'
import { IssuesContent } from './issues-content'

function issue(number: number): IssueRow {
  return {
    id: `i${number}`,
    number,
    title: `Issue ${number}`,
    body: '',
    author: 'A',
    createdAt: number,
    updatedAt: number,
    revision: 1,
    imported: false,
    importedUrl: '',
    upstreamNumber: null,
    state: { open: true, labels: [], assignees: [] },
    stateComplete: true,
    comments: 0,
  } as unknown as IssueRow
}

const HOME = { repo: { repoId: 'r', forge: { core: 'C', collab: 'L', group: 'G' }, ownerId: 'o', name: 'n', visibility: 'public' }, description: '', config: null } as unknown as RepoHome

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  asked.length = 0
  params = ''
  replaced.length = 0
  answer = {
    rows: [issue(5612), issue(5600)],
    pinned: [],
    pinsUnread: true,
    matching: 97,
    hasNext: true,
    openCount: 97,
    closedCount: 1607,
    searchedOf: null,
    stateComplete: true,
    labels: [],
    hidden: 0,
    hiddenBy: { malformed: 0, sealed: 0 } as never,
  }
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const button = (text: string): HTMLButtonElement | undefined => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

describe('IssuesContent pinned issues (QW3-003)', () => {
  it('says the pinned issues were not checked, and reads them when asked, the list staying on screen', async () => {
    act(() => root.render(<IssuesContent home={HOME} addr={{ owner: 'o', name: 'n' }} />))
    await settle()
    expect(asked).toEqual([expect.objectContaining({ pins: false })])
    expect(el.querySelector('[data-testid="pins-unread"]')?.textContent).toContain('pinned issues are not checked on every load')
    // Digit-grouped tab counts (QW3-058).
    expect([...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim())).toEqual(['97 Open', '1,607 Closed', 'All'])
    act(() => button('Check for pinned issues')?.click())
    await settle()
    expect(asked).toHaveLength(2)
    expect(asked[1]).toMatchObject({ pins: true, q: asked[0]?.q })
    expect(el.querySelector('[data-testid="pins-unread"]')).toBeNull()
    expect([...el.querySelectorAll('[data-testid="pinned-issue"]')].map((p) => p.getAttribute('data-number'))).toEqual(['41'])
    expect(el.querySelectorAll('[data-testid="issue-row"]')).toHaveLength(2)
  })

  it('a short feed shows its pins with no note', async () => {
    answer = { ...answer, pinsUnread: false, pinned: [issue(7)] }
    act(() => root.render(<IssuesContent home={HOME} addr={{ owner: 'o', name: 'n' }} />))
    await settle()
    expect(el.querySelector('[data-testid="pins-unread"]')).toBeNull()
    expect(el.querySelectorAll('[data-testid="pinned-issue"]')).toHaveLength(1)
  })
})

describe('IssuesContent search with no match in its tab (QW3-051)', () => {
  it('says how many match in the other state and searches every state when asked', async () => {
    params = 'q=label%3Abug'
    answer = { ...answer, rows: [], matching: 0, hasNext: false, openCount: 0, closedCount: 1, pinsUnread: false }
    act(() => root.render(<IssuesContent home={HOME} addr={{ owner: 'o', name: 'n' }} />))
    await settle()
    expect(asked[0]?.q.state).toBe('open')
    expect(el.textContent).toContain('No issues match')
    expect(el.textContent).toContain('None is open; 1 closed issue matches.')
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="issues-search-all"]')?.click())
    await settle()
    expect(replaced.at(-1)).toBe('/repo/issues/?owner=o&name=n&state=all&label=bug')
  })
})

describe('IssuesContent search parity (QW4-023, QW4-028)', () => {
  const submit = async (text: string): Promise<void> => {
    const input = el.querySelector('#issue-search') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => (el.querySelector('form[role="search"]') as HTMLFormElement).requestSubmit())
    await settle()
  }

  it('a GitHub link with is:issue and no state lists every state', async () => {
    params = 'q=is%3Aissue+in%3Atitle+DIP'
    act(() => root.render(<IssuesContent home={HOME} addr={{ owner: 'o', name: 'n' }} />))
    await settle()
    expect(asked[0]?.q).toMatchObject({ state: 'all', scope: 'title', text: 'DIP' })
    expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe('All')
  })

  it('a typed search with its state qualifier taken out searches every state; one with it stays on the tab', async () => {
    act(() => root.render(<IssuesContent home={HOME} addr={{ owner: 'o', name: 'n' }} />))
    await settle()
    await submit('is:issue in:title DIP')
    expect(replaced.at(-1)).toBe('/repo/issues/?owner=o&name=n&state=all&q=in%3Atitle+DIP')
    await submit('is:open in:title DIP')
    expect(replaced.at(-1)).toBe('/repo/issues/?owner=o&name=n&q=in%3Atitle+DIP')
  })

  it('filters by reason: and keeps it in the URL', async () => {
    params = 'state=closed&q=reason%3A%22not+planned%22'
    act(() => root.render(<IssuesContent home={HOME} addr={{ owner: 'o', name: 'n' }} />))
    await settle()
    expect(asked[0]?.q).toMatchObject({ state: 'closed', reason: 'not_planned', text: '' })
    expect(el.querySelector('[data-testid="issue-search-dropped"]')).toBeNull()
    expect((el.querySelector('#issue-search') as HTMLInputElement).value).toBe('is:closed reason:"not planned"')
  })
})
