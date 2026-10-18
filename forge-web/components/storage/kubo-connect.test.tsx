// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_STORAGE_CONFIG, type StorageConfig } from '@/lib/storage'
import { validatePairResponse } from '@/lib/storage/kubo-connect'
import type { StorageConfigState } from '@/hooks/use-storage-config'

const mocks = vi.hoisted(() => ({ save: vi.fn(), pair: vi.fn(), probe: vi.fn(), identity: 'me' as string | null, config: null as StorageConfig | null, locked: false, params: new URLSearchParams() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/settings/storage/', useSearchParams: () => mocks.params }))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: mocks.config, storable: mocks.identity !== null, needsUnlock: mocks.locked, loading: false, error: null, save: mocks.save }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: mocks.identity }) }))
vi.mock('@/components/sign-in-button', () => ({ SignInButton: () => <button>Sign in</button> }))
vi.mock('@/components/auth/unlock-more', () => ({ UnlockMore: ({ title }: { title: string }) => <button>{title}</button> }))
vi.mock('@/lib/storage/kubo-connect', async (load) => ({ ...await load<object>(), pairWithNode: mocks.pair }))
vi.mock('@/lib/storage/probe', async (load) => ({ ...await load<object>(), probeProfile: mocks.probe }))
vi.mock('@/components/app-shell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/storage/storage-wizard', async (load) => {
  const actual = await load<typeof import('./storage-wizard')>()
  return { ...actual, StorageWizardView: ({ storage }: { storage: StorageConfigState }) => storage.needsUnlock ? <actual.StorageWizardView storage={storage} /> : <div>Storage wizard</div> }
})
import StorageSettingsPage from '@/app/settings/storage/page'
import { KuboConnect } from './kubo-connect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  mocks.identity = 'me'; mocks.locked = false; mocks.config = EMPTY_STORAGE_CONFIG; mocks.params = new URLSearchParams()
  mocks.save.mockReset().mockImplementation(async (next: StorageConfig) => { mocks.config = next })
  mocks.probe.mockReset().mockResolvedValue(true)
  mocks.pair.mockReset().mockResolvedValue(validatePairResponse({ name: 'kubo', api: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080', auth: `Bearer ${'a'.repeat(43)}`, peerId: 'peer', version: '0.43.1' }))
  vi.stubGlobal('location', { origin: 'https://forge.dashhq.org', pathname: '/settings/storage/', search: '', hash: '' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); delete (window as Window & { __forgeKuboPair?: string }).__forgeKuboPair; vi.restoreAllMocks(); vi.unstubAllGlobals() })
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
    vi.stubGlobal('location', { origin, pathname, search: '', hash: '' }); await render()
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
    await render() // The vault hook publishes the saved settings on its next render.
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(mocks.save.mock.calls.at(-1)![0].defaultPolicy).toBeNull()
    expect(mocks.save.mock.calls.at(-1)![0].profiles[0].name).toBe('kubo')
  })
  it('strips a same-document pairing link immediately and pairs only once', async () => {
    await act(async () => root.render(<StorageSettingsPage />))
    expect(host.querySelector('[aria-label="Connect an IPFS node"]')).toBeNull()
    const state = { __NA: true, tree: 'keep' }
    vi.spyOn(window.history, 'state', 'get').mockReturnValue(state)
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => { location.hash = '' })
    location.search = '?keep=1'; location.hash = '#kubo=5001.7KQ2-M9XD-PF4C'
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      expect(location.hash).toBe('')
      expect(mocks.pair).toHaveBeenCalledWith({ port: 5001, code: '7KQ2-M9XD-PF4C' })
    })
    expect(replace).toHaveBeenCalledWith(state, '', '/settings/storage/?keep=1')
    expect(host.textContent).toContain('Connect the IPFS node on this computer?')
    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')))
    await act(async () => root.render(<StorageSettingsPage />))
    expect(mocks.pair).toHaveBeenCalledOnce()
    expect(mocks.probe).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled()
  })
  it('captures a Next client navigation that lands with a hash without hashchange', async () => {
    await render()
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => { location.hash = '' })
    location.hash = '#kubo=5001.7KQ2-M9XD-PF4C'
    // Next publishes a new search-params object when its canonical URL changes, including hash.
    mocks.params = new URLSearchParams()
    await render()
    expect(location.hash).toBe(''); expect(mocks.pair).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('Connect the IPFS node on this computer?')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('leaves unrelated hashes and pairing links on other paths alone', async () => {
    await render()
    const replace = vi.spyOn(window.history, 'replaceState')
    for (const [pathname, hash] of [['/settings/storage/', '#help'], ['/repo/', '#kubo=5001.7KQ2-M9XD-PF4C'], ['/settings/storage/extra', '#kubo=5001.7KQ2-M9XD-PF4C']]) {
      vi.stubGlobal('location', { origin: 'https://forge.dashhq.org', pathname, search: '', hash })
      await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')))
      expect(location.hash).toBe(hash)
    }
    expect(replace).not.toHaveBeenCalled(); expect(mocks.pair).not.toHaveBeenCalled()
  })
  it('consumes a stashed link only once even after remounting', async () => {
    fragment(); await render()
    await act(async () => root.render(<div />))
    await render()
    expect(mocks.pair).toHaveBeenCalledOnce()
  })
  it('keeps exactly one unlock panel on the paired, locked Storage page', async () => {
    mocks.locked = true; mocks.config = null; fragment()
    await act(async () => root.render(<StorageSettingsPage />))
    expect(host.textContent).toContain('Connect the IPFS node on this computer?')
    expect([...host.querySelectorAll('button')].filter((b) => b.textContent?.startsWith('Unlock'))).toHaveLength(1)
    expect(host.textContent).toContain('Unlock this tab to set up or open your storage settings')
    expect(host.textContent).not.toContain('Test and save')
    expect(mocks.save).not.toHaveBeenCalled()
    mocks.locked = false; mocks.config = EMPTY_STORAGE_CONFIG
    await act(async () => root.render(<StorageSettingsPage />))
    expect(host.textContent).toContain('Test and save')
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
  it('adds the node to the current policy and restores that policy exactly when unticked', async () => {
    const previous = { targets: ['platform', 'bucket'], replicas: 2, platformFallback: true }
    mocks.config = { ...EMPTY_STORAGE_CONFIG, profiles: [{ name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }], defaultPolicy: previous }
    fragment(); await render(); await click('Test and save'); await render()
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(mocks.save.mock.calls.at(-1)![0].defaultPolicy).toEqual({ ...previous, targets: ['platform', 'bucket', 'kubo'] })
    await render()
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(mocks.save.mock.calls.at(-1)![0].defaultPolicy).toEqual(previous)
  })
  it('shows only the sign-in prompt on the signed-out storage page unless pairing is pending', async () => {
    mocks.identity = null; mocks.config = null
    await act(async () => root.render(<StorageSettingsPage />))
    expect(host.textContent).toContain('Sign in to set up storage')
    expect(host.textContent).not.toContain('Run one command')
    expect(host.querySelector('[aria-label="Connect an IPFS node"]')).toBeNull()
    await act(async () => root.render(<div />))
    fragment()
    await act(async () => root.render(<StorageSettingsPage />))
    expect(host.textContent).toContain('Connect the IPFS node on this computer?')
    expect(host.textContent).not.toContain('Run one command')
  })
  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'https://forge.dashhq.org'])('renders the Safari notice only when needed on %s', async (origin) => {
    vi.stubGlobal('navigator', { userAgent: 'Version/18.0 Safari/605.1' })
    vi.stubGlobal('location', { origin, pathname: '/settings/storage/', search: '', hash: '' }); await render()
    expect(host.textContent?.includes("Safari can't reach")).toBe(origin.startsWith('https:'))
  })
  it('leaves an existing storage policy unchanged and the checkbox unchecked', async () => {
    mocks.config = { ...EMPTY_STORAGE_CONFIG, profiles: [{ name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }], defaultPolicy: { targets: ['platform'], replicas: 1, platformFallback: false } }
    fragment(); await render(); await click('Test and save')
    expect(mocks.save.mock.calls[0]![0].defaultPolicy.targets).toEqual(['platform'])
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
  })
})
