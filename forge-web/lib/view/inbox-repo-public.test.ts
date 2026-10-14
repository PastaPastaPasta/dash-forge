/**
 * The inbox's "made this repo public" items (`./inbox-repo-public`, DESIGN §4.10 step 6): each
 * repo I belong to is checked once, when it is public; one made public gives one item at the
 * conversion's time, naming Everything when the owner published the history; a repo never private
 * is never checked again.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let configs: Record<string, unknown>[] = []
let repoDoc: Record<string, unknown> | null = null
let bundles: Uint8Array[] = []
const reads: string[] = []

vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => (reads.push(q.documentTypeName), configs)),
  queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => (reads.push(q.documentTypeName), { documents: repoDoc === null ? [] : [repoDoc] })),
}))
vi.mock('../repo/converted', async (orig) => ({
  ...(await orig<typeof import('../repo/converted')>()),
  readMakePublicBundles: vi.fn(async () => (reads.push('bundles'), bundles.map((bytes) => ({ owner: new Uint8Array(32), bytes })))),
}))

import { base58Encode } from '../auth/base58'
import { ENTRY_COMMENT, ENTRY_EPOCH_KEY, encodeBundle } from '../private'
import { publishesHistory } from '../repo/converted'
import { idbPut, resetMemoryStores } from '../idb'
import { loadItems, planFeeds, pollOnce, threadKey, type Subscriptions } from './inbox'
import { EVERYTHING_PUBLIC_WHAT, conversionAt, repoPublicItems, repoRefOf } from './inbox-repo-public'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO = { id: base58Encode(id(0x11)), ownerId: base58Encode(id(0x21)), name: 'ledger', private: false }
const ME = base58Encode(id(0x31))
const sdk = {} as unknown as EvoSDK
const MIN = 60_000

const privateConfig = (at: number, h: number) => ({ $id: base58Encode(id(0x80 + h)), $createdAt: at, $createdAtBlockHeight: h, epoch: 0, enc: 'AQ==', vis: 'private' })
const publicConfig = (at: number, h: number) => ({ $id: base58Encode(id(0xa0 + h)), $createdAt: at, $createdAtBlockHeight: h, defaultBranch: 'main', vis: 'public' })
const history = encodeBundle([{ kind: ENTRY_EPOCH_KEY, target: id(0x11), revision: 0, key: new Uint8Array(32).fill(5) }], 'made public')

beforeEach(() => {
  resetMemoryStores()
  configs = []
  repoDoc = null
  bundles = []
  reads.length = 0
})

describe('checking a repo I belong to', () => {
  it('a repo never private: no item, never checked again', async () => {
    configs = [publicConfig(MIN, 1)]
    expect(await repoPublicItems(sdk, FORGE, REPO, ME)).toEqual({ items: [], verdict: 'never' })
    expect(reads).toEqual(['config'])
  })

  it('a private repo is not checked yet', async () => {
    expect(await repoPublicItems(sdk, FORGE, { ...REPO, private: true }, ME)).toEqual({ items: [], verdict: null })
    expect(reads).toEqual([])
  })

  it('made public (Code only): "made this repo public" by its owner, at the marker', async () => {
    configs = [privateConfig(MIN, 1), publicConfig(7 * MIN, 7)]
    const { items, verdict } = await repoPublicItems(sdk, FORGE, REPO, ME)
    expect(verdict).toBe('done')
    expect(items).toEqual([{ id: `repoPublic:${REPO.id}`, kind: 'repoPublic', repo: REPO, what: 'made this repo public', actor: REPO.ownerId, at: 7 * MIN, read: false }])
    // the marker said when: the repo document is not read
    expect(reads).not.toContain('repo')
  })

  it('with everything written while private, when the owner published it', async () => {
    configs = [privateConfig(MIN, 1), publicConfig(7 * MIN, 7)]
    bundles = [history]
    const { items } = await repoPublicItems(sdk, FORGE, REPO, ME)
    expect(items.map((i) => [i.id, i.what])).toEqual([[`repoPublic:${REPO.id}:everything`, 'made this repo public, with everything written while private']])
  })

  it('flipped before its settings landed: at the repo document’s last change', async () => {
    configs = [privateConfig(MIN, 1)]
    repoDoc = { $id: REPO.id, $updatedAt: 6 * MIN }
    expect((await repoPublicItems(sdk, FORGE, REPO, ME)).items[0]?.at).toBe(6 * MIN)
  })

  it('the owner made it public: nothing for them', async () => {
    configs = [privateConfig(MIN, 1), publicConfig(7 * MIN, 7)]
    expect(await repoPublicItems(sdk, FORGE, REPO, REPO.ownerId)).toEqual({ items: [], verdict: 'done' })
  })
})

describe('the pure parts', () => {
  it('conversionAt: the marker, else the flip, else the seal-off', () => {
    const ref = repoRefOf(FORGE, REPO)
    expect(conversionAt(ref, [privateConfig(MIN, 1), publicConfig(7 * MIN, 7)], 6 * MIN)).toBe(7 * MIN)
    expect(conversionAt(ref, [privateConfig(MIN, 1)], 6 * MIN)).toBe(6 * MIN)
    expect(conversionAt(ref, [privateConfig(2 * MIN, 1)], null)).toBe(2 * MIN)
    expect(conversionAt(ref, [publicConfig(MIN, 1)], null)).toBeNull()
  })

  it('publishesHistory: an entry publishing this repo’s epoch key, nothing else', () => {
    expect(publishesHistory(REPO.id, [history])).toBe(true)
    expect(publishesHistory(base58Encode(id(0x12)), [history])).toBe(false)
    const docs = encodeBundle([{ kind: ENTRY_COMMENT, target: id(0x44), revision: 1, key: new Uint8Array(32) }], '')
    expect(publishesHistory(REPO.id, [docs])).toBe(false)
    expect(publishesHistory(REPO.id, [new Uint8Array([1, 2, 3])])).toBe(false)
    expect(EVERYTHING_PUBLIC_WHAT).toBe('made everything written while private public')
  })

  it('planFeeds: one check per public repo I belong to (not as owner), until it is checked', () => {
    const repo = (n: number, priv = false) => ({ id: base58Encode(id(n)), ownerId: REPO.ownerId, name: `r${n}`, private: priv })
    const subs: Subscriptions = {
      at: 0,
      threads: [],
      droppedRepos: 0,
      droppedThreads: 0,
      repos: [
        { repo: repo(1), reason: 'maintainer' },
        { repo: repo(2), reason: 'reader' },
        { repo: repo(3), reason: 'owner' },
        { repo: repo(4), reason: 'watched' },
        { repo: repo(5, true), reason: 'writer' },
        { repo: repo(6), reason: 'triage' },
      ],
    }
    const checks = (done: Set<string>) =>
      planFeeds(subs, { stars: false, pushes: false }, ME, new Set(), done)
        .filter((f) => f.kind === 'repoPublic')
        .map((f) => f.repo.name)
    expect(checks(new Set())).toEqual(['r1', 'r2', 'r6'])
    expect(checks(new Set([repo(2).id]))).toEqual(['r1', 'r6'])
  })

  it('its items are one thread per repo, apart from the repo’s pushes', () => {
    const item = { id: 'x', repo: REPO, what: 'made this repo public', actor: REPO.ownerId, at: 1, read: false }
    expect(threadKey({ ...item, kind: 'repoPublic' })).toBe(`${REPO.id}:repoPublic`)
    expect(threadKey({ ...item, kind: 'push' })).toBe(`${REPO.id}:push`)
  })
})

describe('the poll', () => {
  it('checks a member repo once: its item is stored, and the repo is never checked again', async () => {
    configs = [privateConfig(MIN, 1), publicConfig(7 * MIN, 7)]
    const now = 10 * MIN
    await idbPut('inbox', `devnet:${ME}:subs`, { at: now, repos: [{ repo: REPO, reason: 'writer' }], threads: [], droppedRepos: 0, droppedThreads: 0, collab: FORGE.collab })
    await pollOnce(sdk, 'devnet', FORGE, ME, { now })
    expect((await loadItems('devnet', ME)).map((i) => [i.kind, i.what])).toEqual([['repoPublic', 'made this repo public']])
    const configReads = reads.filter((r) => r === 'config').length
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: now + 1 })
    expect(reads.filter((r) => r === 'config').length).toBe(configReads)
    expect(await loadItems('devnet', ME)).toHaveLength(1)
  })
})
