// @vitest-environment jsdom
/**
 * The tags list's commit chips (L-02): a chip shows the commit its tag names, and a tag that is
 * force-moved to another commit gets a fresh chip rather than the old commit it already showed.
 * Each row's date is its tip's (QW2-023), with the time the ref last moved only as a labelled
 * fallback.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', async () => {
  const { forwardRef } = await import('react')
  return { default: forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>((props, ref) => <a ref={ref} {...props} />) }
})

/** The repo each useBrowse call was given (null: no browse index read). */
const browseCalls: unknown[] = []
/** tip → the commit the fake peel answers. */
const peelTo = new Map<string, string>()
/** What the published index says: ready, or not indexed (no reader will come). */
let indexed = true
vi.mock('@/hooks/use-browse', () => ({
  useBrowse: (repo: unknown) => {
    browseCalls.push(repo)
    if (repo === null) return { data: null, error: null }
    return { data: indexed ? { kind: 'ready', context: { reader: READER } } : { kind: 'unindexed' }, error: null }
  },
}))
vi.mock('@/hooks/use-trust-view', () => ({ useTrustView: () => 'tags' }))
/** tip → the date (ms) the fake tip read answers; missing: the read fails. */
const dateOf = new Map<string, number>()
vi.mock('@/lib/view/tip', () => ({
  peekDeclared: () => undefined,
  peelCached: async (_r: unknown, tip: string) => ({ oid: peelTo.get(tip) ?? tip, type: 'commit' }),
  tipDateCached: async (_r: unknown, tip: string) => {
    const ms = dateOf.get(tip)
    if (ms === undefined) throw new Error('unreadable')
    return ms
  },
}))
/** The viewer's role on the repo (branch administration, P1-4). */
let role: string | null = null
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role, known: true }) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, network: 'devnet', ready: true }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'M', network: 'devnet' } }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/components/repo/private-compose', () => ({ privateComposeBlock: () => null }))
const READER: Record<string, unknown> = {
  forView: () => READER,
  forHistoryWalk: () => READER,
  readObject: async () => ({ type: 'commit', bytes: new Uint8Array() }),
}

import type { RepoHome } from '@/lib/view'
import { RefListContent, refUpdatedAt } from './ref-list-content'

const TAG_A = 'a'.repeat(40)
const TAG_B = 'b'.repeat(40)
const COMMIT_A = '1'.repeat(40)
const COMMIT_B = '2'.repeat(40)

function home(tagTip: string, more: readonly string[] = [], protectedPatterns: readonly string[] = []): RepoHome {
  const ref = (refName: string, oid: string) => ({ refName, refNameHash: 'x', state: { state: 'resolved', oid, author: 'id', createdAt: 1 } })
  return {
    repo: { repoId: 'r', visibility: 'public', forge: { core: 'c', collab: 'l', community: 'm' } },
    config: { protectedPatterns },
    defaultBranch: 'main',
    branches: [ref('refs/heads/main', COMMIT_A), ...more.map((b) => ref(`refs/heads/${b}`, COMMIT_B))],
    tags: [ref('refs/tags/v1', tagTip)],
  } as unknown as RepoHome
}

const addr = { owner: 'o', name: 'n' }
let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  role = null
  browseCalls.length = 0
  peelTo.clear()
  peelTo.set(TAG_A, COMMIT_A)
  peelTo.set(TAG_B, COMMIT_B)
  dateOf.clear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const chip = (): HTMLAnchorElement => el.querySelector('[data-testid="tag-commit"]') as HTMLAnchorElement
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('RefListContent tag chips', () => {
  it('shows the commit a tag names, and follows a force-moved tag', async () => {
    await act(async () => root.render(<RefListContent home={home(TAG_A)} addr={addr} kind="tags" />))
    await settle()
    expect(chip().getAttribute('href')).toContain(`oid=${COMMIT_A}`)
    expect(chip().textContent).toContain(COMMIT_A.slice(0, 7))

    await act(async () => root.render(<RefListContent home={home(TAG_B)} addr={addr} kind="tags" />))
    await settle()
    expect(chip().getAttribute('href')).toContain(`oid=${COMMIT_B}`)
    expect(chip().textContent).toContain(COMMIT_B.slice(0, 7))
  })

  it('shows the tip itself when the repo has no published index (and starts no in-browser clone)', async () => {
    indexed = false
    try {
      await act(async () => root.render(<RefListContent home={home(TAG_A)} addr={addr} kind="tags" />))
      await settle()
      expect(chip().getAttribute('href')).toContain(`oid=${TAG_A}`)
      expect(chip().textContent).toContain(TAG_A.slice(0, 7))
    } finally {
      indexed = true
    }
  })

  it('the branches list has no tag chips', async () => {
    await act(async () => root.render(<RefListContent home={home(TAG_A)} addr={addr} kind="branches" />))
    expect(el.querySelector('[data-testid="tag-commit"]')).toBeNull()
  })
})

// QW2-023: every ref of a mirror read "updated 11h ago", the time of the mirror's sync.
describe('RefListContent dates', () => {
  const updated = (): HTMLElement => el.querySelector('[data-testid="ref-updated"]') as HTMLElement
  it('dates a branch by its tip commit, an old one by its day', async () => {
    dateOf.set(COMMIT_A, new Date(2015, 0, 2, 12).getTime())
    await act(async () => root.render(<RefListContent home={home(TAG_A)} addr={addr} kind="branches" />))
    await settle()
    expect(updated().dataset['source']).toBe('commit')
    expect(updated().textContent).toMatch(/^updated on .*2015/)
  })

  it('dates a tag by its tag date, a recent one by its age', async () => {
    dateOf.set(TAG_A, Date.now() - 3 * 86_400_000)
    await act(async () => root.render(<RefListContent home={home(TAG_A)} addr={addr} kind="tags" />))
    await settle()
    expect(updated().textContent).toBe('updated 3d ago')
  })

  it('says "pushed" for the time the ref moved when the tip cannot be read, or no index will be ready', async () => {
    await act(async () => root.render(<RefListContent home={home(TAG_A)} addr={addr} kind="branches" />))
    await settle()
    expect(updated().dataset['source']).toBe('push')
    expect(updated().textContent).toMatch(/^pushed /)
    indexed = false
    try {
      dateOf.set(COMMIT_A, 1)
      await act(async () => root.render(<RefListContent home={home(TAG_B)} addr={addr} kind="tags" />))
      await settle()
      expect(updated().textContent).toMatch(/^pushed /)
    } finally {
      indexed = true
    }
  })
})

describe('refUpdatedAt (QW-061d: when a branch last moved)', () => {
  it('is the update time, a diverged ref\'s newest head, or unknown', () => {
    expect(refUpdatedAt({ refName: 'refs/heads/a', state: { state: 'resolved', oid: 'x', author: 'a', createdAt: 42 } } as never)).toBe(42)
    expect(refUpdatedAt({ refName: 'refs/heads/b', state: { state: 'diverged', heads: [{ createdAt: 5 }, { createdAt: 9 }] } } as never)).toBe(9)
    expect(refUpdatedAt({ refName: 'refs/heads/c', state: { state: 'deleted' } } as never)).toBe(0)
  })
})

// P1-4: GitHub's branch administration, for maintainers and writers only.
describe('RefListContent branch administration', () => {
  const deletes = (): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('[data-testid="delete-branch"]')]
  const render = async (h: RepoHome, kind: 'branches' | 'tags' = 'branches') => {
    await act(async () => root.render(<RefListContent home={h} addr={addr} kind={kind} />))
    await settle()
  }

  it('offers nothing to a signed-out viewer or a non-member', async () => {
    await render(home(TAG_A, ['feature']))
    expect(el.querySelector('[data-testid="new-branch"]')).toBeNull()
    expect(deletes()).toEqual([])
    expect(el.querySelector('[data-testid="role-limit"]')).toBeNull()
  })

  it('tells triage members and readers why there is no button', async () => {
    role = 'triage'
    await render(home(TAG_A, ['feature']))
    expect(el.querySelector('[data-testid="new-branch"]')).toBeNull()
    expect(deletes()).toEqual([])
    expect(el.querySelector('[data-testid="role-limit"]')?.textContent).toBe("Your role here is triage: a triage member can't create or delete branches.")
  })

  it('gives a writer New branch and delete, never on the default or a protected branch', async () => {
    role = 'writer'
    await render(home(TAG_A, ['feature', 'release/1'], ['refs/heads/release/*']))
    expect(el.querySelector('[data-testid="new-branch"]')).not.toBeNull()
    const [main, feature, release] = deletes()
    expect(main?.disabled).toBe(true)
    expect(main?.getAttribute('aria-label')).toMatch(/^main is the default branch/)
    expect(feature?.disabled).toBe(false)
    expect(feature?.getAttribute('aria-label')).toBe('Delete branch feature')
    expect(release?.disabled).toBe(true)
    expect(release?.getAttribute('aria-label')).toMatch(/^release\/1 is protected/)
  })

  it('has no branch controls on the tags list', async () => {
    role = 'maintainer'
    await render(home(TAG_A, ['feature']), 'tags')
    expect(el.querySelector('[data-testid="new-branch"]')).toBeNull()
    expect(deletes()).toEqual([])
  })
})
