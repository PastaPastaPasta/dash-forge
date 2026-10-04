// @vitest-environment jsdom
/**
 * P1-4: a fork's bar on its Code tab, as GitHub's. Equal tips read "up to date" with no further
 * work; otherwise "Sync fork" (members who can push) or "Compare" (anyone else) works out the
 * ancestry, then offers the fast-forward (Update branch), says there is nothing to take, or
 * offers the pull request that merges the parent's branch into the fork.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'

const FORK_TIP = 'a'.repeat(40)
const PARENT_TIP = 'b'.repeat(40)
const PARENT = { forge: { core: 'C', collab: 'L', community: 'M' }, repoId: 'PARENTID', ownerId: 'PO', name: 'proj', visibility: 'public' }

const s = vi.hoisted(() => ({
  role: 'writer' as string | null,
  parentTip: '' as string,
  ancestry: { forkInParent: true, parentInFork: false, unrelated: false, behind: 3, ahead: 0 },
  synced: [] as unknown[],
}))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, network: 'devnet', ready: true }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'M', network: 'devnet' } }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: s.role, known: true }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-browse-reader', () => ({ useBrowseReader: () => ({ kind: 'ready', reader: {}, version: 'r1', local: false, behind: false, unavailable: [] }) }))
vi.mock('@/components/repo/fork-contribute', async (orig) => ({ ...(await orig<typeof import('@/components/repo/fork-contribute')>()), useForkParent: () => PARENT }))
vi.mock('@/lib/view/fork-sync', async (orig) => ({ ...(await orig<typeof import('@/lib/view/fork-sync')>()), syncAncestry: async () => s.ancestry }))
vi.mock('@/lib/view/pull-diff', async (orig) => ({ ...(await orig<typeof import('@/lib/view/pull-diff')>()), historyWalker: () => ({ reader: {}, done: () => undefined }) }))
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  readSyncTarget: async () => ({ branch: 'master', tip: s.parentTip }),
  readSyncManifests: async () => ({ manifests: [{ packHash: 'p', kind: 0, sizeBytes: 1, objectCount: 1, chunkCount: 0, storage: 1, uris: ['platform://x'] }], unreferenceable: [] }),
  syncFork: async (_sdk: unknown, _auth: unknown, _repo: unknown, input: unknown) => {
    s.synced.push(input)
    return { manifestsWritten: 1 }
  },
}))

import { ForkSyncBar } from './fork-sync'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const home = (protectedPatterns: string[] = []): RepoHome =>
  ({
    repo: { forge: PARENT.forge, repoId: 'FORKID', ownerId: 'ME', name: 'proj', visibility: 'public' },
    config: { protectedPatterns },
    defaultBranch: 'main',
    v2: { forkOf: 'PARENTID' },
    branches: [],
    tags: [],
  }) as unknown as RepoHome

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  s.role = 'writer'
  s.parentTip = PARENT_TIP
  s.ancestry = { forkInParent: true, parentInFork: false, unrelated: false, behind: 3, ahead: 0 }
  s.synced.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const reload = vi.fn()

async function render(h = home()): Promise<void> {
  await act(async () => root.render(<ForkSyncBar home={h} addr={{ owner: 'ME', name: 'proj' }} forkReader={{} as never} forkTip={FORK_TIP} reload={reload} />))
  await settle()
}

async function open(): Promise<void> {
  await act(async () => q('fork-sync-open')?.click())
  await settle()
}

describe('the fork bar', () => {
  it('says the branch is up to date when the tips match, with nothing to do', async () => {
    s.parentTip = FORK_TIP
    await render()
    expect(q('fork-sync-status')?.textContent).toMatch(/^This branch is up to date with PO\/proj:master\.$/)
    expect(q('fork-sync-open')).toBeNull()
  })

  it('fast-forwards a branch behind the parent: Update branch moves it from its tip', async () => {
    await render()
    expect(q('fork-sync-status')?.textContent).toMatch(/not the same as PO\/proj:master/)
    expect(q('fork-sync-open')?.textContent).toMatch(/Sync fork/)
    await open()
    expect(q('fork-sync-behind')?.textContent).toMatch(/3 commits behind PO\/proj:master/)
    expect(host.textContent).toMatch(/Records 1 new pack of proj by reference/)
    await act(async () => q('fork-sync-update')?.click())
    await settle()
    expect(s.synced).toHaveLength(1)
    expect(s.synced[0]).toMatchObject({ refName: 'refs/heads/main', forkTip: FORK_TIP, parentTip: PARENT_TIP })
    expect(reload).toHaveBeenCalled()
  })

  it('lets anyone compare, but only the fork’s maintainers and writers update', async () => {
    s.role = null
    await render()
    expect(q('fork-sync-open')?.textContent).toMatch(/Compare/)
    await open()
    expect(q('fork-sync-behind')).not.toBeNull()
    expect(q('fork-sync-update')).toBeNull()
  })

  it('keeps a protected default branch for maintainers', async () => {
    await render(home(['refs/heads/main']))
    await open()
    const update = q('fork-sync-update') as HTMLButtonElement
    expect(update.disabled).toBe(true)
    expect(update.title).toBe('main is protected here: only maintainers can sync it.')
  })

  it('never moves a diverged branch: it offers the pull request that merges the parent’s branch', async () => {
    s.ancestry = { forkInParent: false, parentInFork: false, unrelated: false, behind: 2, ahead: 1 }
    await render()
    await open()
    expect(q('fork-sync-diverged')?.textContent).toMatch(/1 commit ahead of and 2 commits behind PO\/proj:master/)
    const href = (q('fork-sync-pr') as HTMLAnchorElement).getAttribute('href') ?? ''
    expect(decodeURIComponent(href)).toContain('head=PARENTID:refs/heads/master')
    expect(href).toContain('base=main')
    expect(q('fork-sync-update')).toBeNull()
  })

  it('has nothing to sync when the fork is ahead', async () => {
    s.ancestry = { forkInParent: false, parentInFork: true, unrelated: false, behind: 0, ahead: 4 }
    await render()
    await open()
    expect(q('fork-sync-ahead')?.textContent).toMatch(/4 commits ahead of PO\/proj:master: there is nothing to sync/)
  })
})
