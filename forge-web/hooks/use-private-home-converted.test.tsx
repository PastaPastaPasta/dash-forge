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
  /** What the session cache already holds (a page mounted again). */
  peek: undefined as unknown,
  /** Held memberships reads (a members lookup still on its way), when `holdMembers`. */
  holdMembers: false,
  members: [] as ((m: unknown[]) => void)[],
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
vi.mock('@/lib/repo', () => ({
  readMembershipsCached: () => (state.holdMembers ? new Promise((resolve) => state.members.push(resolve)) : Promise.resolve([])),
  repoContractIds: () => [],
}))
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
  peekPublishedSession: () => state.peek,
  privateSessionGeneration: () => 0,
  sessionUnwrapper: () => null,
}))

import { PUBLISHED_RETRY_MS, usePrivateHome, type PrivateHomeState } from './use-private-home'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as const
const HOME = { repo } as unknown as RepoHome
const ADDR = { owner: 'alice', name: 'demo' } as unknown as RepoAddress
const KEYS = { id: 'published-1', resolution: { keys: new Map([[0, {}]]) } } as unknown as PrivateSession
const KEYS2 = { id: 'published-2', resolution: { keys: new Map([[0, {}]]) } } as unknown as PrivateSession
/** The plain home the page passes in; a new object is a re-read (Retry, a write). */
let home: RepoHome = HOME

let host: HTMLDivElement
let root: Root
/** Every state the page was handed, in order. */
let seen: PrivateHomeState[] = []

function Probe(): null {
  const s = usePrivateHome(home, ADDR)
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
  Object.assign(state, { identity: null, conversion: { sealOffEpoch: 1, markerHeight: 40 }, published: [], peek: undefined, holdMembers: false, members: [] })
  seen = []
  home = HOME
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

  it('serves the plain home once the keys turn out unreadable twice, or none were published', async () => {
    await mount()
    await act(async () => state.published[0]!.reject(new Error('node refused')))
    await flush()
    // One more try first: still waiting, nothing handed out
    expect(last().pending).toBe(true)
    await act(async () => {
      await new Promise((r) => setTimeout(r, PUBLISHED_RETRY_MS + 100))
    })
    expect(state.published).toHaveLength(2)
    await act(async () => state.published[1]!.reject(new Error('node refused')))
    await flush()
    await flush()
    expect(last().pending).toBe(false)
    expect(last().home).toBe(HOME)
  })

  it('a read that fails once is tried again, and the page reads with the keys it then gets', async () => {
    await mount()
    await act(async () => state.published[0]!.reject(new Error('node refused')))
    await act(async () => {
      await new Promise((r) => setTimeout(r, PUBLISHED_RETRY_MS + 100))
    })
    await act(async () => state.published[1]!.resolve(KEYS))
    await flush()
    await flush()
    expect(served().length).toBeGreaterThan(0)
    for (const s of served()) expect(s.home.repo.published).toBe(KEYS)
  })

  it('a public repo never made public is served at once, without a read', async () => {
    state.conversion = null
    await mount()
    expect(state.published).toEqual([])
    expect(seen[0]?.pending).toBe(false)
    expect(seen[0]?.home).toBe(HOME)
  })
})

describe('a repository made public, once its published keys are read', () => {
  async function withKeys(): Promise<void> {
    await mount()
    await act(async () => state.published[0]!.resolve(KEYS))
    await flush()
    await flush()
  }

  it('a page mounted again paints at once with the keys already read', async () => {
    state.peek = KEYS
    await mount()
    expect(seen[0]?.pending).toBe(false)
    expect(seen[0]?.home.repo.published).toBe(KEYS)
    expect(seen.every((s) => !s.pending)).toBe(true)
  })

  it('reads them again when the plain home is re-read (Retry, a write), keeping the ones in hand meanwhile', async () => {
    await withKeys()
    const before = state.published.length
    seen = []
    home = { ...HOME }
    act(() => root.render(<Probe />))
    await flush()
    // A second read, and no waiting screen while it runs
    expect(state.published.length).toBe(before + 1)
    expect(seen.every((s) => !s.pending)).toBe(true)
    expect(last().home.repo.published).toBe(KEYS)
    await act(async () => state.published[before]!.resolve(KEYS2))
    await flush()
    await flush()
    expect(last().home.repo.published).toBe(KEYS2)
  })

  it("a signed-in viewer's members lookup does not hold the page: it reads with the keys meanwhile", async () => {
    state.identity = 'bob'
    state.holdMembers = true
    await withKeys()
    // The memberships read is still on its way
    expect(state.members.length).toBeGreaterThan(0)
    expect(last().pending).toBe(false)
    expect(last().home.laneLoading).toBe(true)
    expect(last().home.repo.published).toBe(KEYS)
  })
})
