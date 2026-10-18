// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRef } from '@/lib/repo/contract'

const state = vi.hoisted(() => ({ start: vi.fn(), fork: vi.fn(), push: vi.fn(), profile: true, size: 1048576, pinError: null as string | null, planError: null as string | null, signer: { identityId: 'me' }, sdk: {} }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'me', signer: state.signer }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, disabledReason: null, failed: () => 'fork failed' }) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: state.sdk, ready: true }) }))
vi.mock('@/hooks/use-async', () => ({ useAsync: () => ({ data: { manifests: [], refs: [], unreferenceable: [] }, error: null }) }))
vi.mock('@/hooks/use-repo-pin', () => ({ useRepoPin: () => ({
  plan: { data: { sizeBytes: state.size, requiresConsent: false }, error: state.planError },
  profiles: state.profile ? [{ name: 'kubo' }] : [], profile: state.profile ? { name: 'kubo' } : null,
  rows: [], summary: null, error: state.pinError, running: false, start: state.start, cancel: vi.fn(), setChosen: vi.fn(),
}) }))
vi.mock('@/lib/repo', async (load) => ({ ...await load<object>(), forkRepoV2: state.fork, checkForkName: async () => ({ kind: 'free' }) }))
vi.mock('@/lib/spend-toast', () => ({ spendAction: async (_: unknown, work: (tag: (v: unknown) => unknown) => Promise<unknown>) => work((v) => v) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('@/components/ui/cost-preview', () => ({ CostPreview: () => <span>cost</span> }))
import { ForkButton } from './fork-button'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const parent = { forge: { core: 'core' }, repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
let host: HTMLDivElement; let root: Root
beforeEach(() => {
  vi.useFakeTimers(); state.profile = true; state.size = 1048576; state.pinError = null; state.planError = null
  state.fork.mockReset().mockResolvedValue({ name: 'repo', unreferenceable: [] }); state.start.mockReset().mockResolvedValue(undefined); state.push.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
const render = async () => {
  await act(async () => root.render(<ForkButton parent={parent} defaults={{ defaultBranch: 'main', description: '' }} />))
  await act(async () => button('Fork').click())
  await act(async () => vi.advanceTimersByTimeAsync(301))
}
const option = () => [...host.querySelectorAll('label')].find((l) => l.textContent?.includes('Also pin'))?.querySelector<HTMLInputElement>('input')

describe('optional pinning after a fork', () => {
  it('checks pinning by default only below 256 MiB', async () => {
    await render(); expect(option()?.checked).toBe(true)
    state.size = 256 * 1048576
    await act(async () => root.render(<ForkButton parent={parent} defaults={{ defaultBranch: 'main', description: '' }} />))
    expect(option()?.checked).toBe(false)
  })
  it('does not offer pinning without a kubo profile', async () => {
    state.profile = false; await render(); expect(option()).toBeUndefined()
  })
  it('pins the parent after a successful fork, preserving success when pinning fails', async () => {
    state.start.mockImplementation(async () => { state.pinError = 'node unavailable' })
    await render(); await act(async () => button('Sign & fork').click())
    expect(state.fork).toHaveBeenCalledOnce(); expect(state.fork.mock.calls[0]![2]).toBe(parent)
    expect(state.start).toHaveBeenCalledWith(false)
    expect(host.textContent).toContain('Your fork is ready')
    expect(host.textContent).toContain('Fork created; pinning failed: node unavailable')
    await act(async () => button('View fork').click())
    expect(state.push).toHaveBeenCalledWith('/repo/?owner=me&name=repo&created=1')
  })
})

it('hides pinning errors when pinning is unticked', async () => {
  state.pinError = 'node unavailable'; state.planError = 'plan unavailable'
  await render()
  expect(host.textContent).toContain('Could not read files to pin')
  await act(async () => option()!.click())
  expect(host.textContent).not.toContain('Could not read files to pin')
  expect(host.textContent).not.toContain('Fork created; pinning failed')
  await act(async () => button('Sign & fork').click())
  expect(state.start).not.toHaveBeenCalled(); expect(state.push).toHaveBeenCalled()
})
