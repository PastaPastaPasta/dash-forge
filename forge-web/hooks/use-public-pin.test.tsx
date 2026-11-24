// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRef } from '@/lib/repo/contract'

const KUBO = { name: 'node', settings: { kind: 'ipfs-kubo', provider: 'kubo', api: 'http://127.0.0.1:5001', gateway: '', publicGateway: '', pinningEndpoint: '' }, secrets: {} }
const PLATFORM = { name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }
const state = vi.hoisted(() => ({ pin: vi.fn(), del: vi.fn(), reload: vi.fn(), check: vi.fn(), status: null as unknown }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'me', signer: { identityId: 'me' } }) }))
vi.mock('./use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('./use-write-guard', () => ({ useWriteGuard: () => ({ check: state.check, failed: (e: unknown) => `failed: ${String(e)}` }) }))
vi.mock('./use-storage-config', () => ({ useStorageConfig: () => ({ config: { profiles: [PLATFORM, KUBO] }, needsUnlock: false }) }))
vi.mock('./use-async', () => ({ useAsync: () => ({ data: state.status, error: null, reload: state.reload }) }))
vi.mock('@/lib/spend-toast', () => ({ spendAction: async (_: unknown, work: (tag: (v: unknown) => unknown) => Promise<unknown>) => work((v) => v) }))
vi.mock('@/lib/repo/pack-mirrors', async (load) => ({ ...await load<object>(), deleteMirror: state.del }))
vi.mock('@/lib/storage/pin-copies', async (load) => ({ ...await load<object>(), pinPacks: state.pin }))
import { usePublicPin } from './use-public-pin'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const repo = { forge: { core: 'core' }, repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
const COST = { credits: 1, dash: 0.00001 } as never
const missing = [{ packHash: 'a'.repeat(64), sizeBytes: 1, source: {} }]
let host: HTMLDivElement; let root: Root; let view: ReturnType<typeof usePublicPin>
function Probe() { view = usePublicPin(repo); return <span>{view.error}</span> }
const render = async () => { await act(async () => root.render(<Probe />)) }
beforeEach(() => {
  state.status = { packs: missing, mine: [{ id: 'm1' }, { id: 'm2' }], missing, tooLarge: [] }
  state.pin.mockReset().mockResolvedValue({ recorded: 1, failed: 0, sizeBytes: 1 }); state.del.mockReset().mockResolvedValue({ deleted: true }); state.reload.mockReset(); state.check.mockReset().mockReturnValue(true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('a public pin', () => {
  it('offers only storage others can read', async () => {
    await render()
    expect(view.profiles.map((p) => p.name)).toEqual(['node'])
    expect(view.profile?.name).toBe('node')
  })

  it('checks the write, copies only the missing packs, then reads the records again', async () => {
    await render()
    await act(async () => view.start(COST))
    expect(state.check).toHaveBeenCalledWith(COST, 'core', 'pin this repo')
    expect(state.pin).toHaveBeenCalledOnce()
    expect(state.pin.mock.calls[0]!.slice(2, 5)).toEqual([repo, KUBO, missing])
    expect(view.summary).toEqual({ recorded: 1, failed: 0, sizeBytes: 1 })
    expect(state.reload).toHaveBeenCalled()
  })

  it('reports a refused record through the write guard', async () => {
    state.pin.mockRejectedValue('no credits')
    await render()
    await act(async () => view.start(COST))
    expect(view.error).toBe('failed: no credits')
  })

  it('fails the run when no file could be copied', async () => {
    state.pin.mockResolvedValue({ recorded: 0, failed: 1, sizeBytes: 0 })
    await render()
    await act(async () => view.start(COST))
    expect(view.error).toBe('failed: Error: No file could be copied: see the details.')
  })

  it('does nothing the write guard refuses', async () => {
    state.check.mockReturnValue(false)
    await render()
    await act(async () => view.start(COST))
    await act(async () => view.unpin())
    expect(state.pin).not.toHaveBeenCalled()
    expect(state.del).not.toHaveBeenCalled()
  })

  it("deletes each of the signer's records on unpin", async () => {
    await render()
    await act(async () => view.unpin())
    expect(state.check).toHaveBeenCalledWith(0, 'core', 'unpin this repo')
    expect(state.del.mock.calls.map((c) => c[3])).toEqual(['m1', 'm2'])
    expect(state.reload).toHaveBeenCalled()
  })
})
