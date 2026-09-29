// @vitest-environment jsdom
/**
 * The PR list (L-44): Open / Merged / Closed tabs with counts, a pager past the first page, the
 * search box and filters in the URL, labels and comment counts on the rows. The pull index is
 * faked; what the list asks it for, and what it writes to the URL, is asserted.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PullListPage, PullRow, PullSelection } from '@/lib/repo'

vi.mock('next/link', async () => {
  const { forwardRef } = await import('react')
  return { default: forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>((props, ref) => <a ref={ref} {...props} />) }
})
let search = ''
const replaced: string[] = []
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (href: string) => replaced.push(href), push: () => undefined }),
  usePathname: () => '/repo/pulls/',
  useSearchParams: () => new URLSearchParams(search),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: null }) }))
vi.mock('@/hooks/use-mirror-trust', () => ({ useMirrorTrust: () => null }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useRepoWriteGeneration: () => 0 }))
vi.mock('@/components/repo/use-repo-totals', () => ({ useRepoTotals: () => 203 }))
vi.mock('@/components/repo/mirror-note', () => ({ MirrorNote: () => null }))
vi.mock('@/components/repo/byline', () => ({ Byline: () => <span>someone</span> }))

const asked: PullSelection[] = []
let answer: PullListPage
vi.mock('@/lib/repo', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/repo')>()
  return {
    ...real,
    queryPulls: async (_sdk: unknown, _repo: unknown, q: PullSelection) => {
      asked.push(q)
      return answer
    },
  }
})

import type { RepoHome } from '@/lib/view'
import { PullsContent } from './pulls-content'

function row(number: number, extra: Partial<PullRow> = {}): PullRow {
  return {
    id: `p${number}`,
    number,
    title: `PR ${number}`,
    body: '',
    author: 'A',
    createdAt: number,
    updatedAt: number,
    revision: 1,
    baseRefName: 'refs/heads/main',
    baseTipOid: '',
    baseOidAtOpen: '',
    headOid: '',
    initialHeadOid: '',
    review: { head: '', headUpdates: [], requestedReviewers: [], resolvedThreads: [], dismissedReviews: [], milestone: null },
    sourceId: '',
    sourceRefName: null,
    headOnBase: false,
    imported: false,
    importedUrl: '',
    state: { open: true, merged: false, draft: false, baseRef: null, labels: [], assignees: [] },
    stateComplete: true,
    epoch: null,
    comments: 0,
    ...extra,
  }
}

const HOME = { repo: { repoId: 'r', forge: { core: 'C', collab: 'L', group: 'G' }, ownerId: 'o', name: 'n', visibility: 'public' }, description: '' } as unknown as RepoHome
const addr = { owner: 'o', name: 'n' }

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  search = ''
  replaced.length = 0
  asked.length = 0
  answer = {
    rows: [
      row(203, { comments: 2, state: { open: true, merged: false, draft: false, baseRef: null, labels: ['bug'], assignees: [] } }),
      row(202, { state: { open: true, merged: false, draft: true, baseRef: null, labels: [], assignees: [] } }),
    ],
    matching: 150,
    hasNext: true,
    counts: { open: 150, merged: 40, closed: 13 },
    searchedOf: null,
    stateComplete: true,
    labels: [{ name: 'bug', color: '#d73a4a' } as never],
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
const render = async (): Promise<void> => {
  act(() => root.render(<PullsContent home={HOME} addr={addr} />))
  await settle()
}
const tabs = (): string[] => [...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim() ?? '')
const button = (text: string): HTMLButtonElement => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement

describe('PullsContent (L-44)', () => {
  it('shows exact counts on the tabs, the rows with labels and comments, and a pager past the first page', async () => {
    await render()
    expect(tabs()).toEqual(['150 Open', '40 Merged', '13 Closed', 'All'])
    const rows = [...el.querySelectorAll('[data-testid="pull-row"]')]
    expect(rows.map((r) => r.getAttribute('data-number'))).toEqual(['203', '202'])
    expect(rows[0]?.textContent).toContain('bug')
    expect(rows[0]?.querySelector('[data-testid="pull-comments"]')?.textContent).toContain('2 comments')
    expect(rows[1]?.textContent).toContain('Draft · into main')
    expect(el.querySelector('[data-testid="page-indicator"]')?.textContent).toBe('Page 1 of 6')
    expect(asked[0]).toMatchObject({ state: 'open', page: 1, pageSize: 25, sort: 'newest' })
  })

  it('reads the tab, filters, sort and page from the URL', async () => {
    search = 'owner=o&name=n&state=merged&label=bug&sort=oldest&page=2'
    await render()
    expect(asked[0]).toMatchObject({ state: 'merged', labels: ['bug'], sort: 'oldest', page: 2 })
    expect((el.querySelector('#pull-search') as HTMLInputElement).value).toBe('is:merged label:bug sort:created-asc')
  })

  it('writes a tab change and the next page to the URL', async () => {
    await render()
    act(() => button('40 Merged').click())
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&state=merged')
    act(() => button('Next').click())
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&page=2')
  })

  it('applies a search with qualifiers, and says which it could not apply', async () => {
    await render()
    const input = el.querySelector('#pull-search') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, 'is:merged label:bug author:alice parser')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => (el.querySelector('form[role="search"]') as HTMLFormElement).requestSubmit())
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&state=merged&label=bug&q=parser')
    expect(el.querySelector('[data-testid="pull-search-dropped"]')?.textContent).toContain('author:alice')
  })

  it('an empty Open tab does not invite the first PR while some are merged or closed', async () => {
    answer = { ...answer, rows: [], matching: 0, hasNext: false, counts: { open: 0, merged: 40, closed: 13 } }
    await render()
    expect(el.textContent).toContain('No open pull requests')
    expect(el.textContent).toContain('53 pull requests are merged or closed')
  })
})
