// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRef } from '@/lib/repo/contract'

const R2 = { name: 'r2', settings: { kind: 's3', provider: 'r2', endpoint: 'https://a.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://cdn.example', prefix: '' }, secrets: { accessKeyId: 'k', secretAccessKey: 's' } }
const state = vi.hoisted(() => ({ fork: vi.fn(), push: vi.fn(), storage: null as unknown, needsUnlock: false, error: null as string | null, reload: vi.fn(), onCopy: null as null | ((hash: string, state: string, why?: string) => void) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'me', signer: { identityId: 'me' } }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, disabledReason: null, failed: () => 'fork failed' }) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true }) }))
const MANIFESTS = [
  { packHash: 'aa'.repeat(32), kind: 0, sizeBytes: 3 * 1048576, objectCount: 1, chunkCount: 0, storage: 1, uris: ['https://parent.example/a'] },
  { packHash: 'bb'.repeat(32), kind: 0, sizeBytes: 1048576, objectCount: 1, chunkCount: 0, storage: 1, uris: ['platform://core/r/owner/bb'] },
]
vi.mock('@/hooks/use-async', () => ({ useAsync: () => ({ data: { manifests: MANIFESTS, refs: [], unreferenceable: [], onPlatform: new Set(['bb'.repeat(32)]) }, error: null }) }))
vi.mock('@/hooks/use-storage-config', () => ({
  useStorageConfig: () => ({ config: state.storage, usable: state.storage, needsUnlock: state.needsUnlock, sealed: state.needsUnlock, error: state.error, loading: false, reload: state.reload }),
}))
vi.mock('@/lib/storage/pin-copies', async (load) => ({
  ...await load<object>(),
  forkCopier: (_sdk: unknown, _parent: unknown, profile: { name: string }, opts: { onCopy: (hash: string, state: string, why?: string) => void }) => {
    state.onCopy = opts.onCopy
    return Object.assign(async () => null, { profile: profile.name })
  },
}))
vi.mock('@/lib/repo', async (load) => ({ ...await load<object>(), forkRepoV2: state.fork, checkForkName: async () => ({ kind: 'free' }) }))
vi.mock('@/lib/spend-toast', () => ({ spendAction: async (_: unknown, work: (tag: (v: unknown) => unknown) => Promise<unknown>) => work((v) => v) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))
vi.mock('@/components/ui/cost-preview', () => ({ CostPreview: ({ cost }: { cost: { credits: number } }) => <span data-testid="cost">{cost.credits}</span> }))
vi.mock('@/components/auth/unlock-more', () => ({ UnlockMore: ({ title }: { title: string }) => <span>{title}</span> }))
import { ForkButton } from './fork-button'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const parent = { forge: { core: 'core' }, repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
let host: HTMLDivElement; let root: Root
beforeEach(() => {
  vi.useFakeTimers(); state.storage = null; state.needsUnlock = false; state.error = null; state.reload.mockReset(); state.onCopy = null
  state.fork.mockReset().mockResolvedValue({ name: 'repo', unreferenceable: [] }); state.push.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
const render = async () => {
  await act(async () => root.render(<ForkButton parent={parent} defaults={{ defaultBranch: 'main', description: '' }} />))
  await act(async () => button('Fork').click())
  await act(async () => vi.advanceTimersByTimeAsync(301))
}

describe('a fork and storage', () => {
  it('forks by reference with no storage, and says so in one line that links to setup', async () => {
    await render()
    const line = host.querySelector('[data-testid="fork-storage"]')!
    expect(line.textContent).toBe("Files stay on repo's storage. Set up storage to keep your own copy.")
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/settings/storage/')
    expect(host.textContent).not.toContain('IPFS')
    await act(async () => button('Sign & fork').click())
    expect(state.fork.mock.calls[0]![3]).not.toHaveProperty('copy')
    expect(state.push).toHaveBeenCalledWith('/repo/?owner=me&name=repo&created=1')
  })

  it("copies the parent's packs to the default policy's first readable target", async () => {
    state.storage = { profiles: [R2], defaultPolicy: { targets: ['r2'], replicas: 1, platformFallback: false } }
    await render()
    expect(host.querySelector('[data-testid="fork-storage"]')).toBeNull()
    expect(host.querySelector('[data-testid="fork-plan"]')?.textContent).toContain('2 pack manifests (1 copied to r2, 3.0 MB)')
    await act(async () => button('Sign & fork').click())
    expect(state.fork.mock.calls[0]![3]).toMatchObject({ copy: expect.objectContaining({ profile: 'r2' }) })
    expect(state.push).toHaveBeenCalled()
  })

  it('keeps the files by reference when asked, from a collapsed option', async () => {
    state.storage = { profiles: [R2], defaultPolicy: { targets: ['r2'], replicas: 1, platformFallback: false } }
    await render()
    const option = host.querySelector<HTMLInputElement>('[data-testid="fork-by-reference"]')!
    expect(option.closest('details')?.open).toBe(false)
    await act(async () => option.click())
    expect(host.querySelector('[data-testid="fork-plan"]')?.textContent).toContain('2 pack manifests by reference')
    await act(async () => button('Sign & fork').click())
    expect(state.fork.mock.calls[0]![3]).not.toHaveProperty('copy')
  })

  it('stops with one plain message when a pack could not be copied', async () => {
    state.storage = { profiles: [R2], defaultPolicy: { targets: ['r2'], replicas: 1, platformFallback: false } }
    const { CopyFailed } = await import('@/lib/storage/pin-copies')
    const message = 'A file could not be copied to r2. Press Sign & fork again to finish, or tick "Don\'t copy" under Storage.'
    state.fork.mockImplementation(async () => {
      state.onCopy!('aa'.repeat(32), 'failed', 'bucket unreachable')
      throw new CopyFailed(message, 'bucket unreachable')
    })
    await render()
    await act(async () => button('Sign & fork').click())
    expect(state.push).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message)
    expect(host.querySelector('ol[aria-label="Copy progress"]')?.closest('details')?.open).toBe(false)
    expect(host.querySelector('ol[aria-label="Copy progress"]')?.textContent).toContain('failed: bucket unreachable')
    expect(button('Sign & fork')).toBeTruthy()
  })

  it('never forks by reference behind sealed settings: unlock, or choose not to copy', async () => {
    state.needsUnlock = true
    await render()
    expect(host.textContent).toContain('Unlock this tab to copy the files to your storage')
    expect(button('Sign & fork')).toBeUndefined()
    await act(async () => button('Fork without copying').click())
    expect(host.querySelector('[data-testid="fork-storage"]')?.textContent).toContain("Files stay on repo's storage.")
    await act(async () => button('Sign & fork').click())
    expect(state.fork.mock.calls[0]![3]).not.toHaveProperty('copy')
  })

  it('offers a retry when the settings could not be read, never a silent by-reference fork', async () => {
    state.error = 'vault unreadable'
    await render()
    expect(host.textContent).toContain("Couldn't open your storage settings.")
    expect(button('Sign & fork')).toBeUndefined()
    await act(async () => button('Try again').click())
    expect(state.reload).toHaveBeenCalledOnce()
    expect(button('Fork without copying')).toBeTruthy()
  })

  it("prices the forker's own address into each copied manifest", async () => {
    await render()
    const byRef = Number(host.querySelector('[data-testid="cost"]')?.textContent)
    act(() => root.unmount()); root = createRoot(host)
    state.storage = { profiles: [R2], defaultPolicy: { targets: ['r2'], replicas: 1, platformFallback: false } }
    await render()
    expect(Number(host.querySelector('[data-testid="cost"]')?.textContent)).toBeGreaterThan(byRef)
  })
})
