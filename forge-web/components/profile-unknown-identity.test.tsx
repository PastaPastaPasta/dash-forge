// @vitest-environment jsdom
/**
 * A well-formed id that is no identity: the profile says so, offers no Follow (a paid write of a
 * follow of nobody) and reads nothing more for it; a failed identity read stays a retryable error.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const balance = vi.fn<(id: string) => Promise<bigint | undefined>>()
const SDK = { identities: { balance: (id: string) => balance(id) } }
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: SDK, ready: true, network: 'testnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'Viewer1111111111111111111111111111111111111', signer: {} }) }))
vi.mock('@/components/ui/network-badge', async (orig) => ({ ...(await orig<typeof import('@/components/ui/network-badge')>()), isForgeDeployed: () => true }))
vi.mock('@/lib/view', async (orig) => ({
  ...(await orig<typeof import('@/lib/view')>()),
  resolveDpnsName: async () => null,
  listReposByOwner: async () => ({ owned: [], member: [] }),
}))
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  readFollowCounts: async () => ({ followers: 0, following: 0 }),
}))
vi.mock('@/lib/repo/profile', () => ({ readProfile: async () => null }))
const followEnabled: boolean[] = []
vi.mock('@/hooks/use-relation-toggle', () => ({
  useRelationToggle: (p: { enabled: boolean }) => {
    followEnabled.push(p.enabled)
    return { on: false, busy: false, error: null, delta: 0, run: vi.fn() }
  },
}))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: vi.fn(), sheet: null }) }))
vi.mock('@/hooks/use-first-write', () => ({ useFirstWrite: () => ({}) }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsLookup: () => null }))

const { ProfileContent } = await import('./profile-content')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GHOST = '7xQ3n8m2YH5bR9kLpT4vW6cZ1aFgDs8eJh2NqUyBtKiP'
const REAL = 'H3xi5biFj6wbxmpbdhHx1D2D3ofKJJ7anDG58ixhqvry'
const FLAKY = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  balance.mockReset()
  followEnabled.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (id: string): Promise<void> => {
  await act(async () => root.render(<ProfileContent identityId={id} byId />))
  for (let i = 0; i < 5; i++) await act(async () => undefined)
}
const followButton = (): HTMLButtonElement | undefined => [...host.querySelectorAll('button')].find((b) => /Follow/.test(b.textContent ?? ''))

describe('ProfileContent and an id that is no identity', () => {
  it('says "No such identity", offers no Follow, and never reads the follow relation', async () => {
    balance.mockResolvedValue(undefined)
    await render(GHOST)
    expect(balance).toHaveBeenCalledWith(GHOST)
    expect(host.textContent).toContain('No such identity')
    expect(host.textContent).toContain(`No identity ${GHOST} exists on testnet.`)
    expect(followButton()).toBeUndefined()
    expect(host.querySelector('[data-testid="profile-card"]')).toBeNull()
    expect(followEnabled).not.toContain(true)
  })

  it('shows a real identity with its Follow button', async () => {
    balance.mockResolvedValue(5n)
    await render(REAL)
    expect(host.querySelector('[data-testid="profile-card"]')).not.toBeNull()
    expect(followButton()).toBeDefined()
    expect(followEnabled).toContain(true)
  })

  it('keeps a failed identity read a retryable error, never "not found"', async () => {
    balance.mockRejectedValue(new Error('DAPI unreachable'))
    await render(FLAKY)
    expect(host.textContent).not.toContain('No such identity')
    expect(followButton()).toBeUndefined()
    expect([...host.querySelectorAll('button')].some((b) => /retry|try again/i.test(b.textContent ?? ''))).toBe(true)
  })
})
