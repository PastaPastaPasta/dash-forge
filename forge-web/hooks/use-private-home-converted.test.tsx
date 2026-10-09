// @vitest-environment jsdom
/**
 * R9 (M-C's live run): a repository made public is read with the keys its owner published, and
 * the browse plane decides by them which earlier packs it skips without downloading. The page
 * used to get the plain home at once, so its in-browser clone started without the keys and
 * listed a pack they open as one that "could not be fetched", until the keys arrived (or for
 * good, when they arrived after it). The keys are held back here as long as the test likes:
 * the home must wait for them, and never be handed out without them.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PrivateSession } from '@/lib/repo/private-session'
import type { RepoHome } from '@/lib/view'
import type { RepoAddress } from '@/hooks/use-query-param'

const state = vi.hoisted(() => ({
  identity: null as string | null,
  conversion: { sealOffEpoch: 1, markerHeight: 40 } as { sealOffEpoch: number | null; markerHeight: number | null } | null,
  published: [] as { resolve: (s: unknown) => void; reject: (e: unknown) => void }[],
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: state.identity,
    lockedIdentity: null,
    resuming: false,
    unlockScope: state.identity === null ? null : 'full',
    controller: { unlockScope: () => (state.identity === null ? null : 'full') },
  }),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/lib/auth/encryption-key', () => ({ encryptionOps: async () => null }))
vi.mock('@/lib/repo', () => ({ readMembershipsCached: async () => [], repoContractIds: () => [] }))
vi.mock('@/lib/repo/writes', () => ({ hasMembersKey: async () => false }))
vi.mock('@/lib/repo/members-writes', () => ({ repoHasMembersKey: async () => false }))
vi.mock('@/lib/sdk', () => ({ queryDocuments: async () => [] }))
vi.mock('@/lib/view', () => ({ loadPrivateHome: async () => null, withMembersSession: () => null }))
vi.mock('@/lib/repo/converted', () => ({ knownConversion: () => state.conversion }))
vi.mock('@/lib/repo/private-session', () => ({
  invalidatePrivateSession: () => undefined,
  loadPrivateSessionCached: async () => {
    throw new Error('no members session in this test')
  },
  // Held until the test settles it: the published keys arrive whenever the test says.
  loadPublishedSessionCached: () =>
    new Promise((resolve, reject) => {
      state.published.push({ resolve, reject })
    }),
  onPrivateSessionsClosed: () => () => undefined,
  privateSessionGeneration: () => 0,
  sessionUnwrapper: () => null,
}))

import { usePrivateHome, type PrivateHomeState } from './use-private-home'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as const
const HOME = { repo } as unknown as RepoHome
const ADDR = { owner: 'alice', name: 'demo' } as unknown as RepoAddress
const KEYS = { id: 'published-1', resolution: { keys: new Map([[0, {}]]) } } as unknown as PrivateSession

let host: HTMLDivElement
let root: Root
/** Every state the page was handed, in order. */
let seen: PrivateHomeState[] = []

function Probe(): null {
  const s = usePrivateHome(HOME, ADDR)
  if (s !== null) seen.push(s)
  return null
}
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
const last = (): PrivateHomeState => seen[seen.length - 1] as PrivateHomeState
/** A home the page would read packs through: handed out, not pending. */
const served = (): PrivateHomeState[] => seen.filter((s) => !s.pending)

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  Object.assign(state, { identity: null, conversion: { sealOffEpoch: 1, markerHeight: 40 }, published: [] })
  seen = []
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount(): Promise<void> {
  act(() => root.render(<Probe />))
  await flush()
  await flush()
}

describe('a repository made public, before its published keys are read', () => {
  it('waits for them: no home is handed out without them, however long they take', async () => {
    await mount()
    expect(state.published).toHaveLength(1)
    // The keys are still on their way: the page waits, it does not start reading packs.
    for (let i = 0; i < 5; i++) await flush()
    expect(last().pending).toBe(true)
    expect(served()).toEqual([])
    await act(async () => state.published[0]!.resolve(KEYS))
    await flush()
    await flush()
    expect(served().length).toBeGreaterThan(0)
    // Every home the page ever read through carries them: on its packs and, for a reader without
    // a members-key session, on its earlier discussion.
    for (const s of served()) {
      expect(s.home.repo.published).toBe(KEYS)
      expect(s.home.repo.lane).toBe(KEYS)
    }
  })

  it('a signed-in viewer waits for them too, then reads with them while their members access is worked out', async () => {
    state.identity = 'bob'
    await mount()
    expect(served()).toEqual([])
    await act(async () => state.published[0]!.resolve(KEYS))
    await flush()
    await flush()
    expect(served().length).toBeGreaterThan(0)
    for (const s of served()) expect(s.home.repo.published).toBe(KEYS)
  })

  it('serves the plain home once the keys turn out unreadable, or none were published', async () => {
    await mount()
    await act(async () => state.published[0]!.reject(new Error('node refused')))
    await flush()
    await flush()
    expect(last().pending).toBe(false)
    expect(last().home).toBe(HOME)
  })

  it('a public repo never made public is served at once, without a read', async () => {
    state.conversion = null
    await mount()
    expect(state.published).toEqual([])
    expect(seen[0]?.pending).toBe(false)
    expect(seen[0]?.home).toBe(HOME)
  })
})
