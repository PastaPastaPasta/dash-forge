// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_STORAGE_CONFIG, type StorageConfig } from '@/lib/storage'
import { validatePairResponse } from '@/lib/storage/kubo-connect'

const mocks = vi.hoisted(() => ({ save: vi.fn(), pair: vi.fn(), probe: vi.fn(), identity: 'me' as string | null, config: null as StorageConfig | null, locked: false }))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: mocks.config, storable: mocks.identity !== null, needsUnlock: mocks.locked, loading: false, error: null, save: mocks.save }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: mocks.identity }) }))
vi.mock('@/components/sign-in-button', () => ({ SignInButton: () => <button>Sign in</button> }))
vi.mock('@/components/auth/unlock-more', () => ({ UnlockMore: () => <button>Unlock</button> }))
vi.mock('@/lib/storage/kubo-connect', async (load) => ({ ...await load<object>(), pairWithNode: mocks.pair }))
vi.mock('@/lib/storage/probe', async (load) => ({ ...await load<object>(), probeProfile: mocks.probe }))
import { KuboConnect } from './kubo-connect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  mocks.identity = 'me'; mocks.locked = false; mocks.config = EMPTY_STORAGE_CONFIG
  mocks.save.mockReset().mockImplementation(async (next: StorageConfig) => { mocks.config = next })
  mocks.probe.mockReset().mockResolvedValue(true)
  mocks.pair.mockReset().mockResolvedValue(validatePairResponse({ name: 'kubo', api: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080', auth: `Bearer ${'a'.repeat(43)}`, peerId: 'peer', version: '0.43.1' }))
  vi.stubGlobal('location', { origin: 'https://forge.dashhq.org', pathname: '/settings/storage/' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const render = async (): Promise<void> => { await act(async () => root.render(<KuboConnect />)) }
const click = async (label: string): Promise<void> => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
const fragment = (): void => { Object.defineProperty(window, '__forgeKuboPair', { value: '#kubo=5001.7KQ2-M9XD-PF4C', configurable: true }) }

describe('the kubo connection form', () => {
  it.each([
    ['https://forge.dashhq.org', '/settings/storage/', 'dg ipfs up'],
    ['http://localhost:3000', '/settings/storage/', "dg ipfs up --origin 'http://localhost:3000'"],
    ['https://ipfs.io', '/ipfs/bafy/settings/storage/', 'Open Forge from its own address'],
    ['https://ipfs.io', '/ipns/example/settings/storage/', 'Open Forge from its own address'],
  ])('shows setup for %s%s', async (origin, pathname, text) => {
    vi.stubGlobal('location', { origin, pathname }); await render()
    expect(host.textContent).toContain(text)
    if (pathname.startsWith('/ip')) expect(host.querySelector('pre')).toBeNull()
  })
  it('pairs automatically but never probes or saves without Test and save', async () => {
    fragment(); await render()
    expect(host.textContent).toContain('Connect the IPFS node on this computer?')
    expect(mocks.probe).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled()
    expect(host.innerHTML).not.toContain('Bearer')
    await click('Test and save')
    expect(mocks.probe).toHaveBeenCalledOnce(); expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.save.mock.calls[0]![0].defaultPolicy.targets).toEqual(['kubo'])
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(mocks.save.mock.calls.at(-1)![0].defaultPolicy).toBeNull()
    expect(mocks.save.mock.calls.at(-1)![0].profiles[0].name).toBe('kubo')
  })
  it('does not save a failed probe, and Cancel forgets the payload', async () => {
    mocks.probe.mockResolvedValue(false); fragment(); await render(); await click('Test and save')
    expect(mocks.save).not.toHaveBeenCalled(); await click('Cancel')
    expect(host.textContent).not.toContain('Connect the IPFS node on this computer?')
  })
  it('keeps the paired payload in memory while signed out or locked', async () => {
    mocks.identity = null; mocks.config = null; fragment(); await render()
    expect(host.textContent).toContain('Sign in to finish connecting'); expect(mocks.save).not.toHaveBeenCalled()
    mocks.identity = 'me'; mocks.locked = true; await render()
    expect(host.textContent).toContain('Unlock'); expect(mocks.save).not.toHaveBeenCalled()
    mocks.locked = false; mocks.config = EMPTY_STORAGE_CONFIG; await render()
    expect(host.textContent).toContain('Test and save')
  })
  it('leaves an existing storage policy unchanged and the checkbox unchecked', async () => {
    mocks.config = { ...EMPTY_STORAGE_CONFIG, profiles: [{ name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }], defaultPolicy: { targets: ['platform'], replicas: 1, platformFallback: false } }
    fragment(); await render(); await click('Test and save')
    expect(mocks.save.mock.calls[0]![0].defaultPolicy.targets).toEqual(['platform'])
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
  })
})
