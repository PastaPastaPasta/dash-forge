// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRef } from '@/lib/repo/contract'
import { EMPTY_STORAGE_CONFIG, type StorageConfig } from '@/lib/storage'

const state = vi.hoisted(() => ({ pin: vi.fn(), planHook: vi.fn(), locked: false, config: null as StorageConfig | null, listener: null as (() => void) | null }))
vi.mock('./use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('./use-storage-config', () => ({ useStorageConfig: () => ({ config: state.config, needsUnlock: state.locked, storable: true }) }))
vi.mock('./use-async', () => ({ useAsync: state.planHook }))
vi.mock('@/lib/repo/private-session', async (load) => ({ ...await load<object>(), onPrivateSessionsClosed: (listener: () => void) => { state.listener = listener; return () => { state.listener = null } } }))
vi.mock('@/lib/storage/pin', () => ({ pinRepo: state.pin, readPinPlan: vi.fn() }))
import { useRepoPin } from './use-repo-pin'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const repo = { forge: { core: 'core' }, repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
let host: HTMLDivElement; let root: Root; let view: ReturnType<typeof useRepoPin>
function Probe({ onlyWithProfile = false }: { onlyWithProfile?: boolean }) { view = useRepoPin(repo, { onlyWithProfile }); return <span>{view.error}</span> }
const render = async (onlyWithProfile = false) => { await act(async () => root.render(<Probe onlyWithProfile={onlyWithProfile} />)) }
beforeEach(() => {
  state.locked = false; state.config = { ...EMPTY_STORAGE_CONFIG, profiles: [{ name: 'kubo', settings: { kind: 'ipfs-kubo', provider: 'kubo', api: 'http://127.0.0.1:5001', gateway: '', publicGateway: '', pinningEndpoint: '' }, secrets: {} }] }
  state.pin.mockReset().mockResolvedValue({ pinned: 1, already: 0, failed: 0, sizeBytes: 1 })
  state.planHook.mockReset().mockReturnValue({ data: { targets: [], requiresConsent: false }, error: null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('a dialog’s pin lifetime', () => {
  it('rechecks current unlock state before an old fork callback starts pinning', async () => {
    await render(); const startAfterFork = view.start
    state.locked = true; state.config = null; await render()
    await act(async () => startAfterFork(false))
    expect(state.pin).not.toHaveBeenCalled(); expect(host.textContent).toContain('Unlock your storage profiles')
  })
  it('never starts a late pin after the dialog unmounted', async () => {
    await render(); const oldStart = view.start
    await act(async () => root.render(null))
    await oldStart(false); expect(state.pin).not.toHaveBeenCalled()
  })
  it('cancels an active run when the vault closes', async () => {
    state.pin.mockImplementation(async (_sdk, _repo, _profile, _plan, opts) => new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ pinned: 0, already: 0, failed: 1, sizeBytes: 0 }))))
    await render()
    let run: Promise<void>
    await act(async () => { run = view.start(false) })
    await act(async () => { state.listener!(); await run })
    expect(state.pin.mock.calls[0]![4].signal.aborted).toBe(true)
  })
  it('does not enumerate for a fork with no kubo profile', async () => {
    state.config = EMPTY_STORAGE_CONFIG; await render(true)
    expect(state.planHook.mock.calls.at(-1)![2].enabled).toBe(false)
  })
})
