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
  storage: null as unknown,
  sealed: false,
  error: null as string | null,
  reload: vi.fn(),
  fork: [] as unknown[],
  manifests: [{ packHash: 'p', kind: 0, sizeBytes: 1, objectCount: 1, chunkCount: 0, storage: 1, uris: ['https://parent.example/p'] }] as unknown[],
  onPlatform: new Set<string>(),
}))
vi.mock('@/hooks/use-storage-config', () => ({
  useStorageConfig: () => ({ config: s.storage, usable: s.storage, needsUnlock: s.sealed, sealed: s.sealed, error: s.error, loading: false, reload: s.reload }),
}))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))
vi.mock('@/components/auth/unlock-more', () => ({ UnlockMore: ({ title }: { title: string }) => <span>{title}</span> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, network: 'devnet', ready: true }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'M', signer: { identityId: 'M', network: 'devnet' } }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: s.role, known: true }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-browse-reader', () => ({ useBrowseReader: () => ({ kind: 'ready', reader: {}, version: 'r1', local: false, behind: false, unavailable: [] }) }))
vi.mock('@/components/repo/fork-contribute', async (orig) => ({ ...(await orig<typeof import('@/components/repo/fork-contribute')>()), useForkParent: () => PARENT }))
vi.mock('@/lib/view/fork-sync', async (orig) => ({ ...(await orig<typeof import('@/lib/view/fork-sync')>()), syncAncestry: async () => s.ancestry }))
vi.mock('@/lib/view/pull-diff', async (orig) => ({ ...(await orig<typeof import('@/lib/view/pull-diff')>()), historyWalker: () => ({ reader: {}, done: () => undefined }) }))
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  readSyncTarget: async () => ({ branch: 'master', tip: s.parentTip }),
  readSyncManifests: async () => ({ manifests: s.manifests, unreferenceable: [], onPlatform: s.onPlatform, fork: s.fork }),
  syncFork: async (_sdk: unknown, _auth: unknown, _repo: unknown, input: unknown) => {
    s.synced.push(input)
    return { manifestsWritten: 1 }
  },
}))

import { ForkSyncBar, syncCost } from './fork-sync'

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
  s.storage = null
  s.sealed = false
  s.error = null
  s.reload.mockReset()
  s.fork = []
  s.manifests = [{ packHash: 'p', kind: 0, sizeBytes: 1, objectCount: 1, chunkCount: 0, storage: 1, uris: ['https://parent.example/p'] }]
  s.onPlatform = new Set()
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

  it('copies the new packs to the viewer\'s storage when they have some', async () => {
    s.storage = {
      profiles: [{ name: 'r2', settings: { kind: 's3', provider: 'r2', endpoint: 'https://a.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://cdn.example', prefix: '' }, secrets: { accessKeyId: 'k', secretAccessKey: 's' } }],
      defaultPolicy: { targets: ['r2'], replicas: 1, platformFallback: false },
    }
    await render()
    await open()
    expect(host.textContent).toMatch(/Copies 1 new pack of proj to r2, then moves main\./)
    await act(async () => q('fork-sync-update')?.click())
    await settle()
    expect(s.synced[0]).toMatchObject({ copy: expect.any(Function) })
  })

  it('keeps the files by reference when asked, from a collapsed option', async () => {
    s.storage = {
      profiles: [{ name: 'r2', settings: { kind: 's3', provider: 'r2', endpoint: 'https://a.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://cdn.example', prefix: '' }, secrets: { accessKeyId: 'k', secretAccessKey: 's' } }],
      defaultPolicy: { targets: ['r2'], replicas: 1, platformFallback: false },
    }
    await render()
    await open()
    const option = q('fork-sync-by-reference') as HTMLInputElement
    expect(option.closest('details')?.open).toBe(false)
    await act(async () => option.click())
    expect(host.textContent).toMatch(/Records 1 new pack of proj by reference/)
    await act(async () => q('fork-sync-update')?.click())
    await settle()
    expect(s.synced[0]).not.toHaveProperty('copy')
  })

  it('never syncs by reference behind sealed settings: unlock, or choose not to copy', async () => {
    s.sealed = true
    await render()
    await open()
    expect(host.textContent).toContain('Unlock this tab to copy the new files to your storage')
    expect(q('fork-sync-update')).toBeNull()
    await act(async () => q('fork-sync-skip-copy')?.click())
    expect(host.textContent).toMatch(/Records 1 new pack of proj by reference/)
    await act(async () => q('fork-sync-update')?.click())
    await settle()
    expect(s.synced[0]).not.toHaveProperty('copy')
  })

  it('offers a retry when the settings could not be read', async () => {
    s.error = 'vault unreadable'
    await render()
    await open()
    expect(host.textContent).toContain("Couldn't open your storage settings.")
    expect(q('fork-sync-update')).toBeNull()
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try again')?.click())
    expect(s.reload).toHaveBeenCalledOnce()
  })

  it('needs no storage when every new pack is on Platform', async () => {
    s.sealed = true
    s.onPlatform = new Set(['p'])
    await render()
    await open()
    expect(q('fork-sync-update')).not.toBeNull()
  })

  it("copies to the storage that holds the fork's earlier copies, over the default policy", async () => {
    const held = { ...{ name: 'r2', settings: { kind: 's3', provider: 'r2', endpoint: 'https://a.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://cdn.example', prefix: '' }, secrets: { accessKeyId: 'k', secretAccessKey: 's' } }, name: 'held', settings: { ...{ name: 'r2', settings: { kind: 's3', provider: 'r2', endpoint: 'https://a.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://cdn.example', prefix: '' }, secrets: { accessKeyId: 'k', secretAccessKey: 's' } }.settings, publicUrl: 'https://held.example' } }
    s.storage = { profiles: [{ name: 'r2', settings: { kind: 's3', provider: 'r2', endpoint: 'https://a.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://cdn.example', prefix: '' }, secrets: { accessKeyId: 'k', secretAccessKey: 's' } }, held], defaultPolicy: { targets: ['r2'], replicas: 1, platformFallback: false } }
    s.fork = [{ uploader: 'M', uris: ['https://held.example/forge/old'] }]
    await render()
    await open()
    expect(host.textContent).toMatch(/Copies 1 new pack of proj to held, then moves main\./)
  })

  it("prices the forker's own address into each copied manifest", () => {
    const plan = { manifests: s.manifests, unreferenceable: [], onPlatform: new Set<string>() } as never
    expect(syncCost(plan, { name: 'r2', settings: { kind: 's3', provider: 'r2', endpoint: 'https://a.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://cdn.example', prefix: '' }, secrets: { accessKeyId: 'k', secretAccessKey: 's' } } as never).credits).toBeGreaterThan(syncCost(plan).credits)
    expect(syncCost({ ...(plan as object), onPlatform: new Set(['p']) } as never, { name: 'r2', settings: { kind: 's3', provider: 'r2', endpoint: 'https://a.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://cdn.example', prefix: '' }, secrets: { accessKeyId: 'k', secretAccessKey: 's' } } as never).credits).toBe(syncCost(plan).credits)
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
