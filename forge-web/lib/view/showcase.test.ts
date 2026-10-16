/**
 * QW-045: the showcase repos are read in one composite by id, shown in the configured order,
 * and only when the document is the entry's own (its owner and name), never another repo that
 * shares a name (Explore's Trending #1 was a second "forge-v2 demo" of another owner).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const queries: { where: unknown[] }[] = []
let answer: Record<string, unknown>[] = []
// Pages the recent feed is read from, in order (recentFeed).
let feedPages: { repos: unknown[]; next: unknown; pushesComplete?: boolean; fallback?: boolean }[] = []
const feedReads: unknown[] = []
vi.mock('./discovery', async (orig) => {
  const real = await orig<typeof import('./discovery')>()
  return {
    ...real,
    recentReposPage: vi.fn(async (_sdk: unknown, opts: { after?: unknown }) => {
      feedReads.push(opts.after ?? null)
      const page = feedPages[feedReads.length - 1] ?? { repos: [], next: null }
      return { pushesComplete: true, fallback: false, skippedTies: false, ...page }
    }),
    // The composite's rows, as `reposOf` turns them into cards.
    discoverReposById: vi.fn(async (_sdk: unknown, ids: readonly string[]) => {
      queries.push({ where: [['$id', 'in', ids]] })
      return new Map(answer.map((d) => [d['$id'] as string, real.fromRepoDoc({ repoId: d['$id'], ownerId: d['$ownerId'], name: d['name'], displayName: '', description: '', visibility: d['visibility'], defaultBranch: null, topics: [], forkOf: null, createdAt: 0 } as never, { stars: 1 })]))
    }),
  }
})

import type { EvoSDK } from '@dashevo/evo-sdk'
import { RECENT_PER_OWNER, capPerOwner, isCurated, landingRecent, listShowcaseRepos, recentFeed, type ShowcaseEntry } from './showcase'

// A network's entries, as SHOWCASE lists them (bonsia's mirrors and demo repo).
const entries: readonly ShowcaseEntry[] = [
  { owner: '3gvojK6k3Kt3QjeerN5JE8tbvFhUaTChwhZMbYKjizzs', name: 'dips', repoId: '9iRKx1dVvr4Eu3ckjGCo7dKwPKoM1cTdbfge72mCp993' },
  { owner: '7A1MEuLjzcHZq8bLBzGYSUkpb2VM9dv7gtNuNYrPxKt3', name: 'dash', repoId: '6qf6HGBvKAaMyDuV8xn1CijNQE3xysLzAGzKXZiXZUvW' },
  { owner: '2X2XM6kF5DK9Vx8Mfot4wetvppBKLE1W3tC87NA36jXP', name: 'forge-v2-demo', repoId: 'HhkpzikUjK1k5f3JHpYGBLYHf9mYZJFKbyeK7mwrpYA3' },
]
const doc = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const e = entries[i]!
  return { $id: e.repoId, $ownerId: e.owner, name: e.name, visibility: 'public', description: e.name, ...over }
}

beforeEach(() => {
  queries.length = 0
  feedReads.length = 0
  feedPages = []
})

describe('listShowcaseRepos', () => {
  it('reads every entry at once and keeps the configured order', async () => {
    answer = [doc(2), doc(0), doc(1)]
    const got = await listShowcaseRepos({} as EvoSDK, 'devnet', 'devnet-sakura', entries)
    expect(queries).toHaveLength(1)
    expect((queries[0] as { where: unknown[] }).where).toEqual([['$id', 'in', entries.map((e) => e.repoId)]])
    expect(got.map((r) => r.slug)).toEqual(['dips', 'dash', 'forge-v2-demo'])
    // With the composite's counts, as the ranked cards have them.
    expect(got.every((r) => r.stars === 1)).toBe(true)
  })

  it('leaves out a document that is not the entry’s, a private one, and a missing one', async () => {
    answer = [doc(0, { $ownerId: '6eBY8D5'.padEnd(44, 'x') }), doc(1, { visibility: 'private' })]
    expect(await listShowcaseRepos({} as EvoSDK, 'devnet', 'devnet-sakura', entries)).toEqual([])
  })

  it('reads nothing on a network with no showcase', async () => {
    expect(await listShowcaseRepos({} as EvoSDK, 'testnet', 'testnet')).toEqual([])
    expect(queries).toHaveLength(0)
  })
})

describe('isCurated: the landing feed keeps described, pushed repos (CJ-1)', () => {
  const repo = (description: string, pushedAt: number | null) =>
    ({ key: 'k', ownerId: 'o', name: 'n', slug: 'n', description, createdAt: 0, visibility: 'public', pushedAt }) as const
  it('keeps a repo with a description and a push', () => {
    expect(isCurated(repo('A tool', 1))).toBe(true)
  })
  it('drops one without a description, or with only whitespace', () => {
    expect(isCurated(repo('', 1))).toBe(false)
    expect(isCurated(repo('   ', 1))).toBe(false)
  })
  it('drops one with no push read', () => {
    expect(isCurated(repo('A tool', null))).toBe(false)
  })
  it('keeps a described one when the push lookup was incomplete, which proves nothing', () => {
    expect(isCurated(repo('A tool', null), false)).toBe(true)
    expect(isCurated(repo('', null), false)).toBe(false)
  })
})

describe('capPerOwner: the landing feed shows at most two repos per owner (ABU-V-03)', () => {
  const row = (key: string, ownerId: string) => ({ key, ownerId })
  it('is two by default', () => {
    expect(RECENT_PER_OWNER).toBe(2)
  })
  it('keeps each owner’s newest two, in feed order', () => {
    const feed = [row('1', 'spam'), row('2', 'spam'), row('3', 'alice'), row('4', 'spam'), row('5', 'bob'), row('6', 'spam'), row('7', 'alice'), row('8', 'alice')]
    expect(capPerOwner(feed).map((r) => r.key)).toEqual(['1', '2', '3', '5', '7'])
  })
  it('lets a flood by one owner take no more than the cap', () => {
    const flood = Array.from({ length: 24 }, (_, i) => row(`f${i}`, 'spam'))
    expect(capPerOwner([...flood, row('real', 'alice')]).map((r) => r.key)).toEqual(['f0', 'f1', 'real'])
  })
  it('takes the cap as a parameter and leaves a short feed alone', () => {
    expect(capPerOwner([row('1', 'a'), row('2', 'a'), row('3', 'a')], 1)).toHaveLength(1)
    expect(capPerOwner([])).toEqual([])
  })
})

describe('landingRecent: curated first, then the per-owner cap', () => {
  const repo = (key: string, ownerId: string, described: boolean) =>
    ({ key, ownerId, name: key, slug: key, description: described ? 'A tool' : '', createdAt: 0, visibility: 'public', pushedAt: 1 }) as const
  const feed = [repo('a1', 'a', false), repo('a2', 'a', false), repo('a3', 'a', true), repo('b1', 'b', true)]

  it('lets an owner’s undescribed repos not take the slots of their described one', () => {
    const r = landingRecent(feed, { pushesKnown: true, showAll: false })
    expect(r.shown.map((x) => x.key)).toEqual(['a3', 'b1'])
    expect(r.notCurated).toBe(2)
    expect(r.capped).toBe(0)
  })

  it('"Show all" still holds the cap, and says how many it left out', () => {
    const r = landingRecent(feed, { pushesKnown: true, showAll: true })
    expect(r.shown.map((x) => x.key)).toEqual(['a1', 'a2', 'b1'])
    expect(r.notCurated).toBe(0)
    expect(r.capped).toBe(1)
  })

  it('leaves out the featured repos before anything else', () => {
    const r = landingRecent(feed, { exclude: new Set(['a3']), pushesKnown: true, showAll: false })
    expect(r.shown.map((x) => x.key)).toEqual(['b1'])
  })
})

describe('recentFeed: read on while a flood leaves the feed short', () => {
  const row = (key: string, ownerId: string) => ({ key, ownerId, name: key, slug: key, description: 'A tool', createdAt: 0, visibility: 'public', pushedAt: 1 })

  it('reads one page when it already fills the feed', async () => {
    feedPages = [{ repos: Array.from({ length: 14 }, (_, i) => row(`r${i}`, `o${i}`)), next: { at: 1, seen: [] } }]
    const r = await recentFeed({} as EvoSDK, { network: 'devnet' })
    expect(r.repos).toHaveLength(14)
    expect(feedReads).toHaveLength(1)
  })

  it('reads the next pages when one owner flooded the first', async () => {
    const flood = Array.from({ length: 24 }, (_, i) => row(`f${i}`, 'spammer'))
    feedPages = [
      { repos: flood, next: { at: 9, seen: [] } },
      { repos: Array.from({ length: 24 }, (_, i) => row(`r${i}`, `o${i}`)), next: { at: 5, seen: [] } },
    ]
    const r = await recentFeed({} as EvoSDK, { network: 'devnet' })
    expect(feedReads).toEqual([null, { at: 9, seen: [] }])
    expect(r.repos).toHaveLength(48)
    expect(landingRecent(r.repos, { pushesKnown: true, showAll: false }).shown.length).toBeGreaterThanOrEqual(12)
  })

  it('stops at three pages, and at the end of the list', async () => {
    const flood = (n: number) => Array.from({ length: 24 }, (_, i) => row(`f${n}-${i}`, 'spammer'))
    feedPages = [1, 2, 3, 4].map((n) => ({ repos: flood(n), next: { at: n, seen: [] } }))
    await recentFeed({} as EvoSDK, { network: 'devnet' })
    expect(feedReads).toHaveLength(3)
    feedReads.length = 0
    feedPages = [{ repos: flood(1), next: null }]
    await recentFeed({} as EvoSDK, { network: 'devnet' })
    expect(feedReads).toHaveLength(1)
  })

  it('says older repos follow when every row read was hidden, so the page is not called empty', async () => {
    feedPages = [1, 2, 3].map((n) => ({ repos: [], next: { at: n, seen: [] } }))
    const r = await recentFeed({} as EvoSDK, { network: 'devnet' })
    expect(r.repos).toHaveLength(0)
    expect(r.more).toBe(true)
    feedReads.length = 0
    feedPages = [{ repos: [], next: null }]
    expect((await recentFeed({} as EvoSDK, { network: 'devnet' })).more).toBe(false)
  })
})
