// @vitest-environment jsdom
/**
 * The re-read after a browser merge (DESIGN §13 3C open item: the merge box's "Published." line
 * disappeared once the page re-read). The PR page re-reads the repo home after a merge (L-09);
 * a plain reload also drops a member's members-key session, so while the new one is read the
 * home has no members key, the page's reads are re-keyed (`contentKey`) and the PR page mounts
 * again: the merge box, its steps and its result line are gone, and the merged PR offers no box.
 * A merge changes no members or keys: its reload keeps the session, and the page keeps its key.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import type { RepoAddress } from '@/hooks/use-query-param'

const state = vi.hoisted(() => ({
  homes: 0,
  /** The members-key sessions read, by cache key: one is read again only once it is dropped. */
  sessions: new Map<string, { id: string; closed: boolean; resolution: { keys: Map<number, unknown> } }>(),
  read: 0,
  invalidated: [] as string[],
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ identity: 'bob', lockedIdentity: null, resuming: false, unlockScope: 'full', controller: { unlockScope: () => 'full' } }),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' }, recoveries: 0 }) }))
vi.mock('@/hooks/use-query-param', () => ({ useParam: () => '' }))
vi.mock('@/lib/auth/encryption-key', () => ({ encryptionOps: async () => ({}) }))
vi.mock('@/lib/repo', () => ({
  readMembershipsCached: async () => [{ identity: 'bob', role: 'writer', createdAt: 0 }],
  repoContractIds: () => [],
  onRepoContentWritten: () => undefined,
  repoKey: (r: { repoId: string; lane?: { id: string } }) => (r.lane === undefined ? r.repoId : `${r.repoId}#${r.lane.id}`),
}))
vi.mock('@/lib/repo/private-session', () => ({
  invalidatePrivateSession: (repo: { repoId: string }) => {
    for (const k of [...state.sessions.keys()]) if (k.startsWith(repo.repoId)) state.sessions.delete(k)
  },
  loadPrivateSessionCached: async (_sdk: unknown, repo: { repoId: string }, _network: string, reader: string) => {
    const key = `${repo.repoId}:${reader}`
    let s = state.sessions.get(key)
    if (s === undefined) {
      s = { id: `lane${++state.read}`, closed: false, resolution: { keys: new Map([[0, {}]]) } }
      state.sessions.set(key, s)
    }
    return s
  },
  loadPublishedSessionCached: async () => null,
  onPrivateSessionsClosed: () => () => undefined,
  privateSessionGeneration: () => 0,
  peekPublishedSession: () => undefined,
  sessionUnwrapper: () => null,
}))
vi.mock('@/lib/repo/writes', () => ({ hasMembersKey: async () => true }))
vi.mock('@/lib/repo/members-writes', () => ({ repoHasMembersKey: async () => true }))
vi.mock('@/lib/repo/members-access', () => ({
  membersAccessOf: async (o: { session: (ops: unknown) => Promise<unknown> }) => ({ access: 'member', session: await o.session({}) }),
}))
vi.mock('@/lib/repo/converted', () => ({ knownConversion: () => undefined }))
vi.mock('@/lib/repo/letter-session', () => ({ letterSessionFor: async () => null }))
vi.mock('@/lib/repo/source', () => ({ contractOf: () => 'C', repoSource: () => ({ repoQuery: () => ({}) }) }))
vi.mock('@/lib/sdk', () => ({ queryDocuments: async () => [], evoSdkService: { getStatus: () => ({ phase: 'ready' }) }, isUnreachableError: () => false }))
vi.mock('@/lib/view', () => ({
  // Every read is a new home object, as a real re-read is.
  loadRepoHome: async () => {
    state.homes++
    return { repo: { repoId: 'R', name: 'demo', visibility: 'public', forge: {} }, branches: [], tags: [] }
  },
  invalidateBrowseContext: (key: string) => void state.invalidated.push(key),
  loadBrowseContextCached: async () => null,
  loadPrivateHome: async () => null,
  withLetterReader: (h: unknown) => h,
  withMembersRefs: async (_sdk: unknown, h: unknown) => h,
  withMembersSession: (home: RepoHome, session: unknown, access: string) => ({ ...home, repo: { ...home.repo, lane: session }, lane: { access, session } }),
}))
vi.mock('@/lib/view/own-ref-moves', () => ({ awaitingOwnRefMoves: () => false, forgetOwnRefMoves: () => undefined, showsOwnRefMoves: () => true }))
vi.mock('@/lib/view/retry', () => ({ retryUntil: (load: () => Promise<unknown>) => load(), retryWhileMissing: (load: () => Promise<unknown>) => load() }))
vi.mock('@/lib/view/private-nav', () => ({ forgetPrivateNav: () => undefined, sealRepoUrls: () => undefined }))

import { usePrivateHome } from './use-private-home'
import { useRepoHome, type HomeReloadOptions } from './use-repo'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ADDR = { owner: 'alice', name: 'demo', repoId: '' } as unknown as RepoAddress

let host: HTMLDivElement
let root: Root
/** The members key each rendered home was read with ('' for none): the page's reads key by it. */
let keys: string[] = []
let reload: (options?: HomeReloadOptions) => void = () => undefined

/** What the scaffold does: the plain home, then the viewer's home over it. */
function Page(): null {
  const home = useRepoHome(ADDR)
  const priv = usePrivateHome(home.data ?? null, ADDR)
  reload = home.reload
  if (priv !== null && !priv.pending) keys.push(priv.home.repo.lane?.id ?? '')
  return null
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  state.sessions.clear()
  state.invalidated = []
  keys = []
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function memberPage(): Promise<string> {
  act(() => root.render(<Page />))
  await flush()
  const lane = keys.at(-1) as string
  expect(lane).toMatch(/^lane/)
  keys = []
  return lane
}

describe("a member's page re-read after a merge", () => {
  it('keeps the members-key session: every render reads with the same key, so the page is not mounted again', async () => {
    const lane = await memberPage()
    const before = state.homes
    act(() => reload({ keepSession: true }))
    await flush()
    // the home was read again and its browse context dropped
    expect(state.homes).toBeGreaterThan(before)
    expect(state.invalidated).toContain('R')
    expect(keys.length).toBeGreaterThan(0)
    expect(new Set(keys)).toEqual(new Set([lane]))
  })

  it('a plain reload (a write that may change members or keys) reads a new session, the page re-keyed meanwhile', async () => {
    const lane = await memberPage()
    act(() => reload())
    await flush()
    // without a members key while the new session is read (''), then the new one
    expect(keys).toContain('')
    expect(keys.at(-1)).not.toBe(lane)
    expect(keys.at(-1)).toMatch(/^lane/)
  })
})
