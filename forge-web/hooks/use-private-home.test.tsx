// @vitest-environment jsdom
/**
 * R8 (qa5 Q5-D04 sibling): a member of a public repo whose whole session is locked (the vault
 * holds their key, nothing is signed in) is still that member, so members-only content reads as
 * "Unlock to read" and not as an outsider's placeholders. Someone who holds no key here, or is no
 * member, still reads as an outsider.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import type { RepoAddress } from '@/hooks/use-query-param'

const state = vi.hoisted(() => ({
  identity: null as string | null,
  lockedIdentity: null as string | null,
  members: [] as { identity: string; role: string; createdAt: number }[],
  hasKey: true,
  ops: {} as object | null,
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: state.identity,
    lockedIdentity: state.lockedIdentity,
    resuming: false,
    unlockScope: state.identity === null ? null : 'full',
    controller: { unlockScope: () => (state.identity === null ? null : 'full') },
  }),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/lib/auth/encryption-key', () => ({ encryptionOps: async () => state.ops }))
vi.mock('@/lib/repo', () => ({
  readMembershipsCached: async () => state.members,
  repoContractIds: () => [],
}))
vi.mock('@/lib/repo/writes', () => ({ hasMembersKey: async () => state.hasKey }))
vi.mock('@/lib/repo/members-writes', () => ({ repoHasMembersKey: async () => state.hasKey }))
vi.mock('@/lib/sdk', () => ({ queryDocuments: async () => [] }))
vi.mock('@/lib/view', () => ({ loadPrivateHome: async () => null, withMembersSession: () => null }))

import { usePrivateHome, type PrivateHomeState } from './use-private-home'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as const
const HOME = { repo } as unknown as RepoHome
const ADDR = { owner: 'alice', name: 'demo' } as unknown as RepoAddress

let host: HTMLDivElement
let root: Root
let seen: PrivateHomeState | null = null

function Probe(): null {
  seen = usePrivateHome(HOME, ADDR)
  return null
}
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  Object.assign(state, { identity: null, lockedIdentity: null, members: [], hasKey: true, ops: {} })
  seen = null
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(): Promise<PrivateHomeState> {
  act(() => root.render(<Probe />))
  await flush()
  await flush()
  return seen!
}

describe('a public repo read by a locked session', () => {
  it('marks a member whose vault is locked as locked, so the page offers "Unlock to read"', async () => {
    state.lockedIdentity = 'bob'
    state.members = [{ identity: 'bob', role: 'writer', createdAt: 0 }]
    const got = await render()
    expect(got.home.lane).toEqual({ access: 'locked' })
  })

  it('keeps an outsider\'s view for a locked identity that is no member', async () => {
    state.lockedIdentity = 'carol'
    state.members = [{ identity: 'bob', role: 'writer', createdAt: 0 }]
    const got = await render()
    expect(got.home.lane).toBeUndefined()
  })

  it('says to set up the encryption key when the locked member\'s browser holds none', async () => {
    state.lockedIdentity = 'bob'
    state.members = [{ identity: 'bob', role: 'writer', createdAt: 0 }]
    state.ops = null
    const got = await render()
    expect(got.home.lane).toEqual({ access: 'no-key' })
  })

  it('reads nothing for nobody: signed out with no stored key', async () => {
    const got = await render()
    expect(got.home).toBe(HOME)
  })
})
