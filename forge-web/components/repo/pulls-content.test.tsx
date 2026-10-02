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
/** The mirror trust set the list reads (null: not read yet). */
let mirrorTrust: ReadonlySet<string> | null = null
vi.mock('@/hooks/use-mirror-trust', () => ({ useMirrorTrust: () => mirrorTrust }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useRepoWriteGeneration: () => 0 }))
/** The repo's PR total as `useRepoTotals` reads it (null until its count arrives). */
let repoTotal: number | null = 203
vi.mock('@/components/repo/use-repo-totals', () => ({ useRepoTotals: () => repoTotal }))
vi.mock('@/components/repo/mirror-note', () => ({ MirrorNote: () => null }))
vi.mock('@/components/repo/byline', () => ({ Byline: () => <span>someone</span> }))

const ALICE = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
/** Set to hold every DPNS lookup until it resolves. */
let lookupGate: Promise<void> | null = null
vi.mock('@/lib/view', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/view')>()
  return {
    ...real,
    resolveDpnsId: async (_sdk: unknown, name: string) => {
      if (lookupGate) await lookupGate
      return name.toLowerCase().startsWith('alice') ? ALICE : null
    },
  }
})

const asked: PullSelection[] = []
/** The parent `readForkParent` answers for a fork (QW3-012). */
let forkParent: unknown = null
let answer: PullListPage
/** Answers for the next reads, in order (then `answer`). */
let answers: PullListPage[] = []
/** Set to hold every read after the first until it resolves. */
let laterGate: Promise<void> | null = null
vi.mock('@/lib/repo', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/repo')>()
  return {
    ...real,
    queryPulls: async (_sdk: unknown, _repo: unknown, q: PullSelection) => {
      asked.push(q)
      if (asked.length > 1 && laterGate) await laterGate
      return answers.shift() ?? answer
    },
    readForkParent: async () => forkParent,
  }
})

/** The CI status dots' reads (O-07): each call's heads; `dotGate` holds the answer until it resolves. */
const dotReads: string[][] = []
let dotGate: Promise<void> | null = null
const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
vi.mock('@/lib/repo/check-outcomes', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/repo/check-outcomes')>()
  return {
    ...real,
    readOutcomeCounts: async (_sdk: unknown, _repo: unknown, heads: readonly string[]) => {
      dotReads.push([...heads])
      if (dotGate) await dotGate
      return new Map([
        [H1, { pending: 0, passed: 2, failed: 1 }],
        [H2, { pending: 0, passed: 0, failed: 0 }],
      ])
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
    mergeBaseRefName: 'refs/heads/main',
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
    upstreamNumber: null,
    state: { open: true, merged: false, draft: false, baseRef: null, labels: [], assignees: [], mergeOnBase: null },
    stateComplete: true,
    epoch: null,
    comments: 0,
    ...extra,
  }
}

const HOME = {
  repo: { repoId: 'r', forge: { core: 'C', collab: 'L', group: 'G' }, ownerId: 'o', name: 'n', visibility: 'public' },
  v2: { forkOf: null },
  description: '',
  defaultBranch: 'main',
  branches: [],
} as unknown as RepoHome
const addr = { owner: 'o', name: 'n' }

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  search = ''
  mirrorTrust = null
  lookupGate = null
  dotGate = null
  dotReads.length = 0
  replaced.length = 0
  asked.length = 0
  answers = []
  laterGate = null
  forkParent = null
  repoTotal = 203
  answer = {
    rows: [
      row(203, { comments: 2, state: { open: true, merged: false, draft: false, baseRef: null, labels: ['bug'], assignees: [], mergeOnBase: null } }),
      row(202, { state: { open: true, merged: false, draft: true, baseRef: null, labels: [], assignees: [], mergeOnBase: null } }),
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
const render = async (home: RepoHome = HOME): Promise<void> => {
  act(() => root.render(<PullsContent home={home} addr={addr} />))
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
    expect(rows[0]?.querySelector('[data-testid="comment-count"]')?.textContent).toContain('2 comments')
    expect(rows[1]?.textContent).toContain('Draft · into main')
    expect(el.querySelector('[data-testid="page-indicator"]')?.textContent).toBe('Page 1 of 6')
    expect(asked[0]).toMatchObject({ state: 'open', page: 1, pageSize: 25, sort: 'newest' })
  })

  it('says how far a page read when it stopped at its read budget, and reads on when asked (QW2-002)', async () => {
    // The Open tab's first load read the newest 397 PRs and found none of the tab's 30.
    answer = { ...answer, rows: [], matching: 30, hasNext: false, counts: { open: 30, merged: 1400, closed: 336 }, searchedOf: { searched: 397, total: 1766, more: true } }
    await render()
    expect(el.textContent).toContain('None among the newest 397 pull requests')
    expect(el.textContent).not.toContain('No open pull requests')
    expect(el.querySelector('[data-testid="list-read-budget"]')?.textContent).toContain('Read the newest 397 of 1,766 pull requests; older ones are not read yet.')
    // "Look through older" asks the same page again (the index reads on from where it stopped).
    answer = { ...answer, rows: [row(30), row(29)], searchedOf: null }
    act(() => button('Look through older pull requests').click())
    await settle()
    expect(asked).toHaveLength(2)
    expect(asked[1]).toEqual(asked[0])
    expect([...el.querySelectorAll('[data-testid="pull-row"]')].map((r) => r.getAttribute('data-number'))).toEqual(['30', '29'])
    expect(el.querySelector('[data-testid="list-read-budget"]')).toBeNull()
  })

  it('an oldest-first page that stopped at its read budget says it read the oldest, and offers the newer', async () => {
    search = 'owner=o&name=n&sort=oldest'
    answer = { ...answer, rows: [], matching: 30, hasNext: false, counts: { open: 30, merged: 1400, closed: 336 }, searchedOf: { searched: 397, total: 1766, more: true } }
    await render()
    expect(el.textContent).toContain('None among the oldest 397 pull requests')
    expect(el.textContent).toContain('Newer ones are not read yet.')
    expect(el.querySelector('[data-testid="list-read-budget"]')?.textContent).toContain('Read the oldest 397 of 1,766 pull requests; newer ones are not read yet.')
    expect(button('Look through newer pull requests')).toBeDefined()
  })

  it('digit-groups the tab counts as the rest of the UI does (QW3-058)', async () => {
    answer = { ...answer, counts: { open: 8, merged: 4309, closed: 594 } }
    await render()
    expect(tabs()).toEqual(['8 Open', '4,309 Merged', '594 Closed', 'All'])
  })

  it('a sparse tab finding its older rows through the state scan reads on by itself until it has them (QW3-002)', async () => {
    // The first load found the newest open PRs; the proved count says one more is older.
    const first: PullListPage = { ...answer, rows: [row(5615), row(5614)], matching: 3, hasNext: false, counts: { open: 3, merged: 4309, closed: 594 }, searchedOf: { searched: 880, total: 4911, more: true, kind: 'scan', auto: true } }
    answers = [first]
    answer = { ...first, rows: [row(5615), row(5614), row(4604)], searchedOf: null }
    await render()
    await settle()
    // It asked again by itself, with no click, for the same page, and then stopped.
    expect(asked).toHaveLength(2)
    expect(asked[1]).toEqual(asked[0])
    expect([...el.querySelectorAll('[data-testid="pull-row"]')].map((r) => r.getAttribute('data-number'))).toEqual(['5615', '5614', '4604'])
    expect(el.querySelector('[data-testid="list-read-budget"]')).toBeNull()
    await settle()
    expect(asked).toHaveLength(2)
  })

  it('while a sparse tab reads on, its rows stay and its note says how far it got, with no button to press', async () => {
    answer = { ...answer, rows: [row(5615)], matching: 3, hasNext: false, counts: { open: 3, merged: 4309, closed: 594 }, searchedOf: { searched: 880, total: 4911, more: true, kind: 'scan', auto: true } }
    laterGate = new Promise(() => undefined)
    await render()
    await settle()
    expect(asked).toHaveLength(2)
    expect([...el.querySelectorAll('[data-testid="pull-row"]')].map((r) => r.getAttribute('data-number'))).toEqual(['5615'])
    const note = el.querySelector('[data-testid="list-read-budget"]')
    expect(note?.getAttribute('role')).toBe('status')
    expect(note?.textContent).toContain('Finding the older pull requests in this tab: checked about 880 of 4,911 pull requests so far')
    expect(button('Look through older pull requests')).toBeUndefined()
  })

  it('a sort by comments says how many it sorted and reads on when asked (QW3-004)', async () => {
    answer = { ...answer, searchedOf: { searched: 397, total: 4911, more: true, kind: 'sort' } }
    search = 'sort=comments&state=all'
    await render()
    expect(el.querySelector('[data-testid="list-read-budget"]')?.textContent).toContain('Sorted the newest 397 of 4,911 pull requests by comments; older ones are not read yet.')
    act(() => button('Look through older pull requests').click())
    await settle()
    expect(asked).toHaveLength(2)
  })

  it("shows each head's CI status dot after the rows, from one read for the page (O-07)", async () => {
    let release = (): void => undefined
    dotGate = new Promise((r) => (release = r))
    answer = { ...answer, rows: [row(203, { headOid: H1 }), row(202, { headOid: H2 })] }
    await render()
    // The rows are there while the dots are still being read.
    expect(el.querySelectorAll('[data-testid="pull-row"]')).toHaveLength(2)
    expect(el.querySelector('[data-testid="check-dot"]')).toBeNull()
    release()
    await settle()
    expect(dotReads).toEqual([[H1, H2]])
    const rows = [...el.querySelectorAll('[data-testid="pull-row"]')]
    const dot = rows[0]?.querySelector('[data-testid="check-dot"]')
    expect(dot?.getAttribute('data-state')).toBe('failure')
    expect(dot?.getAttribute('aria-label')).toBe('2 successful, 1 failing checks')
    // No runs reported on #202's head: no dot.
    expect(rows[1]?.querySelector('[data-testid="check-dot"]')).toBeNull()
  })

  it('reads only the heads a new page adds, keeping the dots it has (O-07)', async () => {
    const H3 = 'c'.repeat(40)
    answer = { ...answer, rows: [row(203, { headOid: H1 }), row(202, { headOid: H2 })] }
    await render()
    answer = { ...answer, rows: [row(203, { headOid: H1 }), row(201, { headOid: H3 })] }
    act(() => button('Next').click())
    search = 'owner=o&name=n&page=2'
    await render()
    expect(dotReads).toEqual([[H1, H2], [H3]])
  })

  it('reads the tab, filters, sort and page from the URL', async () => {
    search = 'owner=o&name=n&state=merged&label=bug&sort=oldest&page=2'
    await render()
    expect(asked[0]).toMatchObject({ state: 'merged', labels: ['bug'], sort: 'oldest', page: 2 })
    expect((el.querySelector('#pull-search') as HTMLInputElement).value).toBe('is:merged label:bug sort:created-asc')
  })

  it('a search that matches none in its tab offers every state (QW3-051)', async () => {
    search = 'owner=o&name=n&label=bug'
    answer = { ...answer, rows: [], matching: 0, hasNext: false, counts: { open: 0, merged: 2, closed: 0 } }
    await render()
    expect(el.textContent).toContain('Try fewer filters, or search every state.')
    act(() => (el.querySelector('[data-testid="pulls-search-all"]') as HTMLButtonElement).click())
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&state=all&label=bug')
  })

  it("reads page 1 once when the repo's total arrives while it reads: the same query again would read on", async () => {
    repoTotal = null
    search = 'owner=o&name=n&state=all&sort=comments'
    await render()
    expect(asked).toHaveLength(1)
    repoTotal = 203
    await render()
    expect(asked).toHaveLength(1)
  })

  it('writes a tab change and the next page to the URL', async () => {
    await render()
    act(() => button('40 Merged').click())
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&state=merged')
    act(() => button('Next').click())
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&page=2')
  })

  const submit = async (text: string): Promise<void> => {
    const input = el.querySelector('#pull-search') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => (el.querySelector('form[role="search"]') as HTMLFormElement).requestSubmit())
    await settle()
  }

  it('applies a search with qualifiers, a DPNS author resolved to its id (L-43 parity)', async () => {
    await render()
    await submit('is:merged label:bug author:alice.dash parser')
    expect(replaced.at(-1)).toBe(`/repo/pulls/?owner=o&name=n&state=merged&label=bug&author=${ALICE}&q=parser`)
    expect(el.querySelector('[data-testid="pull-search-dropped"]')).toBeNull()
  })

  it('intersects state qualifiers: is:closed is:unmerged is the closed-without-merging PRs (QW4-007)', async () => {
    await render()
    await submit('is:pr is:closed is:unmerged')
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&state=closed')
    expect(el.querySelector('[data-testid="pull-search-dropped"]')).toBeNull()
    // Two states no PR can be in together: said, the first kept.
    await submit('is:open is:merged')
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n')
    expect(el.querySelector('[data-testid="pull-search-dropped"]')?.textContent).toContain('is:merged')
  })

  it('a search with no state, typed or linked, lists every state (QW4-023)', async () => {
    await render()
    await submit('is:pr fix')
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&state=all&q=fix')
    search = 'owner=o&name=n&q=is%3Apr'
    asked.length = 0
    await render()
    expect(asked.at(-1)).toMatchObject({ state: 'all' })
  })

  it('says which qualifiers it could not apply, and why', async () => {
    await render()
    await submit('is:open author:bobby.dash mentions:@me fix')
    const note = el.querySelector('[data-testid="pull-search-dropped"]')?.textContent ?? ''
    expect(note).toContain('author:bobby.dash')
    expect(note).toContain('No DPNS name `bobby.dash` was found.')
    expect(note).toContain('mentions: is an Issues filter.')
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&q=fix')
    // Clear filters drops the note with the filters.
    search = 'owner=o&name=n&q=fix'
    await render()
    act(() => button('Clear filters').click())
    expect(el.querySelector('[data-testid="pull-search-dropped"]')).toBeNull()
  })

  it('matches a name DPNS does not know as a mirrored author login, and says so (QW-062)', async () => {
    await render()
    await submit('is:open author:thephez fix')
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&q=author%3Athephez+fix')
    expect(el.querySelector('[data-testid="pull-search-dropped"]')).toBeNull()
    search = 'owner=o&name=n&q=author%3Athephez+fix'
    // Until the mirror trust set is read, no row could match: the list waits rather than read.
    asked.length = 0
    await render()
    expect(asked).toEqual([])
    expect(el.textContent).toContain('Reading pull requests')
    mirrorTrust = new Set(['owner'])
    await render()
    expect(asked.at(-1)).toMatchObject({ author: null, authorLogin: 'thephez', text: 'fix' })
    expect(el.querySelector('[data-testid="author-login-note"]')?.textContent).toContain('mirrored from @thephez')
  })

  it('reports review: and a bad draft: value instead of searching for them as text (QW-020)', async () => {
    await render()
    await submit('is:open review:approved draft:maybe in:comments fix')
    const note = el.querySelector('[data-testid="pull-search-dropped"]')?.textContent ?? ''
    expect(note).toContain('review:approved')
    expect(note).toContain('draft: takes true or false.')
    expect(note).toContain('in: takes title or body')
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&q=fix')
  })

  it('applies draft:, review-requested:@me, -label:, milestone: and comments: from the URL', async () => {
    search = `owner=o&name=n&q=draft%3Afalse+review-requested%3A${ALICE}+-label%3Awontfix+milestone%3A%22v1+0%22+comments%3A%3E2`
    await render()
    expect(asked.at(-1)).toMatchObject({ draft: false, reviewRequested: ALICE, notLabels: ['wontfix'], milestone: 'v1 0', comments: { min: 3, max: Infinity } })
    expect((el.querySelector('#pull-search') as HTMLInputElement).value).toBe(`is:open -label:wontfix milestone:"v1 0" comments:>2 draft:false review-requested:${ALICE}`)
    // `review-requested:@me` needs a viewer: signed out, nothing is read.
    asked.length = 0
    search = 'owner=o&name=n&q=review-requested%3A%40me'
    await render()
    expect(asked).toEqual([])
    expect(el.textContent).toContain('Sign in to filter by your own pull requests')
  })

  it('says a page past the last one does not exist and offers the last page (QW-068)', async () => {
    answer = { ...answer, rows: [], matching: 150, hasNext: false }
    search = 'owner=o&name=n&state=merged&page=9'
    await render()
    const past = el.querySelector('[data-testid="page-past-end"]')
    expect(past?.textContent).toContain('There is no page 9')
    expect(past?.textContent).toContain('6 pages')
    expect(el.textContent).not.toContain('Nothing has been merged yet')
    expect(el.querySelector('[data-testid="page-indicator"]')?.textContent).toBe('Page 9')
    act(() => button('Go to page 6').click())
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&state=merged&page=6')
  })

  it('a tab change overtaking a slow name lookup stops the spinner, and the lookup is dropped', async () => {
    let finish!: () => void
    lookupGate = new Promise((r) => (finish = r))
    await render()
    const input = el.querySelector('#pull-search') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, 'author:alice.dash')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => (el.querySelector('form[role="search"]') as HTMLFormElement).requestSubmit())
    await settle()
    expect(el.querySelector('form[role="search"] .animate-spin')).not.toBeNull()
    act(() => button('40 Merged').click())
    expect(el.querySelector('form[role="search"] .animate-spin')).toBeNull()
    finish()
    await settle()
    expect(replaced.at(-1)).toBe('/repo/pulls/?owner=o&name=n&state=merged')
  })

  it('resolves a DPNS name linked in ?q= once connected', async () => {
    search = 'owner=o&name=n&q=author%3Aalice.dash'
    await render()
    expect(replaced.at(-1)).toBe(`/repo/pulls/?owner=o&name=n&author=${ALICE}`)
  })

  it('an empty Open tab does not invite the first PR while some are merged or closed', async () => {
    answer = { ...answer, rows: [], matching: 0, hasNext: false, counts: { open: 0, merged: 40, closed: 13 } }
    await render()
    expect(el.textContent).toContain('No open pull requests')
    expect(el.textContent).toContain('53 pull requests are merged or closed')
  })

  it("on a fork, New pull request opens the parent's form with the fork's default branch as the head (QW3-012)", async () => {
    const newPull = (): string => [...el.querySelectorAll('a')].find((a) => a.textContent?.includes('New pull request'))?.getAttribute('href') ?? ''
    await render()
    expect(newPull()).toBe('/repo/pulls/new/?owner=o&name=n')
    forkParent = { repoId: 'P', forge: HOME.repo.forge, ownerId: 'up', name: 'dips', visibility: 'public' }
    await render({ ...HOME, v2: { forkOf: 'P' }, defaultBranch: 'master' } as unknown as RepoHome)
    expect(newPull()).toBe('/repo/pulls/new/?owner=up&name=dips&head=r%3Amaster')
  })
})

describe('an archived repo (QW3-017)', () => {
  it('offers no New pull request link, only a disabled button saying why', async () => {
    act(() => root.render(<PullsContent home={{ ...HOME, config: { archived: true } } as unknown as RepoHome} addr={addr} />))
    await settle()
    expect([...el.querySelectorAll('a')].some((a) => a.textContent?.includes('New pull request'))).toBe(false)
    const b = el.querySelector('[data-testid="new-pull-archived"]') as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(b.title).toMatch(/archived/)
  })

  it('links New pull request in a live repo', async () => {
    await render()
    expect([...el.querySelectorAll('a')].some((a) => a.textContent?.includes('New pull request'))).toBe(true)
    expect(el.querySelector('[data-testid="new-pull-archived"]')).toBeNull()
  })
})
