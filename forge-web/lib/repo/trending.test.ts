/**
 * Trending (platform-parity-spec §4.3): the preference and its default, and the ranked reads
 * Explore issues (the request each one sends, and how a page decodes).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { resetStarShapes } from './star-shape'
import { STAR_BEAT_GRID } from '../rules/parity'
import { rc1Contracts } from '../sdk/rc1-validate'
import {
  OWNER_STAR_LOOKUP_LIMIT,
  SELF_STAR_CLOCK_MARGIN_MS,
  TRENDING_DEFAULT,
  TRENDING_PREF_KEY,
  fusedTrending,
  ownerStarLookupOf,
  readMostFollowed,
  readMostStarred,
  readOwnerStars,
  readTrending,
  selfStarDecidable,
  setTrendingPref,
  trendingNote,
  trendingPref,
  trendingWindowOf,
  trendingWindowStart,
  type TrendingRepo,
} from './trending'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'G' }
/** C1's star schema, as far as the shape reads it: `byWeek` with its time window. */
const FUSED_STAR = { indices: [{ name: 'byWeek', timeRange: { on: '$createdAt', range: 604800, step: 86400, ttl: 604800 } }] }

function memoryStore(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('the "count my stars toward Trending" preference', () => {
  it('defaults to on (the owner decision), from one constant', () => {
    expect(TRENDING_DEFAULT).toBe(true)
    expect(trendingPref(memoryStore())).toBe(TRENDING_DEFAULT)
  })

  it('remembers off and on, and ignores a value it does not know', () => {
    const s = memoryStore()
    setTrendingPref(false, s)
    expect(s.data.get(TRENDING_PREF_KEY)).toBe('off')
    expect(trendingPref(s)).toBe(false)
    setTrendingPref(true, s)
    expect(trendingPref(s)).toBe(true)
    s.data.set(TRENDING_PREF_KEY, 'maybe')
    expect(trendingPref(s)).toBe(TRENDING_DEFAULT)
  })
})

describe('ranked reads', () => {
  beforeEach(() => resetStarShapes())

  /** `schemas`: forge-community's document types (a fused star carries a time-window index, `star-shape.ts`). */
  function rankedSdk(seen: unknown[], schemas: Record<string, object> = { star: {}, starBeat: {} }): EvoSDK {
    return {
      contracts: { fetch: () => Promise.resolve({ schemas }) },
      documents: {
        ranked: (q: unknown) => {
          seen.push(q)
          return Promise.resolve({
            startingRank: 0n,
            entries: [
              { groupKeyHex: 'b2'.repeat(32), groupValue: 'RepoB', value: 3n, rank: 0n },
              { groupKeyHex: 'a1'.repeat(32), groupValue: 'RepoA', value: 3n, rank: 1n },
            ],
          })
        },
      },
    } as unknown as EvoSDK
  }

  it('trending this week is the oldest open window of starBeat, today the newest', async () => {
    const seen: unknown[] = []
    const page = await readTrending(rankedSdk(seen), FORGE, 'week', 25)
    await readTrending(rankedSdk(seen), FORGE, 'today', 10)
    expect(seen).toEqual([
      { dataContractId: 'COMMUNITY', documentTypeName: 'starBeat', groupBy: 'repoId', aggregate: { type: 'count' }, limit: 25, direction: 'desc', timeRange: [{ field: '$createdAt', selector: 'oldest' }] },
      { dataContractId: 'COMMUNITY', documentTypeName: 'starBeat', groupBy: 'repoId', aggregate: { type: 'count' }, limit: 10, direction: 'desc', timeRange: [{ field: '$createdAt', selector: 'newest' }] },
    ])
    expect(page.entries).toEqual([
      { group: 'RepoB', keyHex: 'b2'.repeat(32), count: 3, rank: 0 },
      { group: 'RepoA', keyHex: 'a1'.repeat(32), count: 3, rank: 1 },
    ])
  })

  it('on a fused-star contract (RC2 C1) trending ranks the star itself, with the same windows', async () => {
    const seen: unknown[] = []
    await readTrending(rankedSdk(seen, { star: FUSED_STAR }), FORGE, 'week', 25)
    expect(seen).toEqual([
      { dataContractId: 'COMMUNITY', documentTypeName: 'star', groupBy: 'repoId', aggregate: { type: 'count' }, limit: 25, direction: 'desc', timeRange: [{ field: '$createdAt', selector: 'oldest' }] },
    ])
  })

  it('reads the shape once per contract, and again after a failed read', async () => {
    let fetches = 0
    const flaky = {
      contracts: { fetch: () => (++fetches === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ schemas: { star: FUSED_STAR } })) },
      documents: { ranked: () => Promise.resolve({ startingRank: 0n, entries: [] }) },
    } as unknown as EvoSDK
    await expect(readTrending(flaky, FORGE, 'week')).rejects.toThrow('offline')
    await readTrending(flaky, FORGE, 'week')
    await readTrending(flaky, FORGE, 'today')
    expect(fetches).toBe(2)
  })

  it('most starred ranks star.byRepo and most followed follow.byTarget, all time', async () => {
    const seen: unknown[] = []
    await readMostStarred(rankedSdk(seen), FORGE)
    await readMostFollowed(rankedSdk(seen), FORGE)
    expect(seen).toEqual([
      { dataContractId: 'COMMUNITY', documentTypeName: 'star', groupBy: 'repoId', aggregate: { type: 'count' }, limit: 25, direction: 'desc' },
      { dataContractId: 'COMMUNITY', documentTypeName: 'follow', groupBy: 'identityId', aggregate: { type: 'count' }, limit: 25, direction: 'desc' },
    ])
  })
})

describe('fused-star Trending, filtered on read (RC2 C1: O-08 moves to readers)', () => {
  const DAY = 86_400_000
  // 2026-10-01 12:00 UTC: today's window starts at 00:00, the week's six days earlier.
  const NOW = Date.UTC(2026, 9, 1, 12)
  const TODAY = Date.UTC(2026, 9, 1)

  it('reads the windows the ranked read selects, on the grid the committed star (or starBeat) declares', () => {
    expect(trendingWindowOf('today', NOW)).toEqual({ start: TODAY, end: TODAY + 7 * DAY })
    expect(trendingWindowOf('week', NOW)).toEqual({ start: TODAY - 6 * DAY, end: TODAY + DAY })
    const schemas = rc1Contracts()['forge-community'].documentSchemas as Record<string, { indices?: { name: string; timeRange?: { range: number; step: number; phase?: number } }[] }>
    const byWeek = [...(schemas['star']?.indices ?? []), ...(schemas['starBeat']?.indices ?? [])].filter((i) => i.timeRange !== undefined)
    expect(byWeek).toHaveLength(1)
    expect({ phase: 0, ...byWeek[0]?.timeRange }).toMatchObject(STAR_BEAT_GRID)
  })

  it('checks the owner of a public repo created inside the window only', () => {
    const week = trendingWindowOf('week', NOW)
    const at = (createdAt: number, visibility: 'public' | 'private' = 'public'): TrendingRepo => ({ ownerId: 'O', visibility, createdAt })
    // A clock margin inside the window's start: a device clock a little behind cannot pull an
    // owner's star from before the window into it.
    expect(selfStarDecidable(at(TODAY - 6 * DAY + SELF_STAR_CLOCK_MARGIN_MS), week)).toBe(true)
    expect(selfStarDecidable(at(TODAY - 6 * DAY + SELF_STAR_CLOCK_MARGIN_MS - 1), week)).toBe(false)
    expect(selfStarDecidable(at(NOW, 'private'), week)).toBe(false)
    expect(selfStarDecidable(at(NOW), null)).toBe(false)
  })

  const entry = (group: string, count: number, keyHex: string) => ({ group, keyHex, count, rank: 0 })
  const repo = (ownerId: string, visibility: 'public' | 'private' = 'public'): TrendingRepo & { name: string } => ({ ownerId, visibility, createdAt: NOW, name: ownerId })

  it('drops private repos, takes owners out of their own counts, drops emptied rows and re-ranks', () => {
    const repos = new Map([
      ['A', repo('a')],
      ['B', repo('b')],
      ['C', repo('c', 'private')],
      ['D', repo('d')],
      ['E', repo('e')],
    ])
    const rows = fusedTrending(
      [entry('C', 9, 'cc'), entry('A', 3, 'aa'), entry('B', 3, 'bb'), entry('D', 2, 'dd'), entry('E', 1, 'ee'), entry('X', 1, '99')],
      repos,
      new Set(['B', 'E']),
      10,
    )
    // C is private; B 3 → 2 ties D at 2, the larger key (dd) first; E's only star was its owner's;
    // X has no repo row (counted as missing by the caller).
    expect(rows.map((r) => [r.name, r.rankCount])).toEqual([
      ['a', 3],
      ['d', 2],
      ['b', 2],
    ])
    expect(fusedTrending([entry('A', 3, 'aa'), entry('D', 2, 'dd')], repos, new Set(), 1).map((r) => r.name)).toEqual(['a'])
  })
})

describe('readOwnerStars with the batched lookup', () => {
  /** A distinct 32-byte identifier, base58. */
  const ident = (n: number): string => base58Encode(new Uint8Array(32).fill(n))
  const [O1, O2, O3, R1, R2, R9] = [1, 2, 3, 11, 12, 19].map(ident) as [string, string, string, string, string, string]
  const pairs = [
    { repoId: R1, ownerId: O1 },
    { repoId: R2, ownerId: O2 },
  ]
  const row = (owner: string, repo: string): Record<string, unknown> => ({ $ownerId: owner, repoId: repo })
  /** An sdk whose every `documents.query` is counted: the per-pair reads. */
  function counting(starred: readonly string[] = []): { sdk: EvoSDK; reads: () => number } {
    let n = 0
    const sdk = {
      documents: {
        query: async (q: { where: readonly (readonly [string, string, string])[] }) => {
          n++
          const repo = q.where.find(([f]) => f === 'repoId')?.[2] ?? ''
          return new Map(starred.includes(repo) ? [[repo, { id: repo }]] : [])
        },
      },
    } as unknown as EvoSDK
    return { sdk, reads: () => n }
  }

  it('settles every pair from a complete lookup with no read of its own', async () => {
    const { sdk, reads } = counting()
    const out = await readOwnerStars(sdk, FORGE, pairs, ownerStarLookupOf([row(O1, R1), row(O1, R9), row(O2, R9)]))
    // O1's own star of R1 is found; O2 stars R9 only, not its own R2.
    expect([...out]).toEqual([R1])
    expect(reads()).toBe(0)
  })

  it('never takes another owner\'s star of a repo for its owner\'s', async () => {
    const { sdk, reads } = counting()
    // O2, also on the page, stars R1, which O1 owns: not O1's own star.
    expect([...(await readOwnerStars(sdk, FORGE, pairs, ownerStarLookupOf([row(O2, R1)])))]).toEqual([])
    expect(reads()).toBe(0)
  })

  it('reads the pairs a full lookup did not show, and only those', async () => {
    const { sdk, reads } = counting([R2])
    const rows = Array.from({ length: OWNER_STAR_LOOKUP_LIMIT }, (_, i) => row(i === 0 ? O1 : O3, i === 0 ? R1 : ident(100 + i)))
    const lookup = ownerStarLookupOf(rows)
    expect(lookup.complete).toBe(false)
    expect([...(await readOwnerStars(sdk, FORGE, pairs, lookup))].sort()).toEqual([R1, R2].sort())
    expect(reads()).toBe(1)
  })

  it('does not trust a lookup whose rows lack identifiers: every pair it cannot see is read', async () => {
    const { sdk, reads } = counting([R1])
    const lookup = ownerStarLookupOf([{ repoId: R9 }, { $ownerId: O2 }])
    expect(lookup).toMatchObject({ stars: [], complete: false })
    expect([...(await readOwnerStars(sdk, FORGE, pairs, lookup))]).toEqual([R1])
    expect(reads()).toBe(2)
  })

  it('reads every pair when there was no lookup', async () => {
    const { sdk, reads } = counting([R1])
    expect([...(await readOwnerStars(sdk, FORGE, pairs))]).toEqual([R1])
    expect(reads()).toBe(2)
  })
})

describe('the Trending window in words (QW4-018, QW4-019)', () => {
  // 2026-10-02 02:16 UTC, a Friday: the QA repro's clock.
  const NOW = Date.UTC(2026, 9, 2, 2, 16)

  it('names "today" as the UTC day so far, with the local start when it differs', () => {
    expect(trendingWindowStart('today', NOW, 'UTC')).toBe('00:00 UTC')
    // 02:16 UTC is 10:16 PM the day before in New York, where today's window began at 8:00 PM.
    expect(trendingWindowStart('today', NOW, 'America/New_York')).toBe('00:00 UTC (8:00 PM your time)')
    // At 23:30 UTC it is 7:30 PM there, and the window began at 8:00 PM the evening before.
    expect(trendingWindowStart('today', Date.UTC(2026, 9, 2, 23, 30), 'America/New_York')).toBe('00:00 UTC (8:00 PM yesterday your time)')
    expect(trendingWindowStart('today', NOW, 'Asia/Tokyo')).toBe('00:00 UTC (9:00 AM your time)')
  })

  it('names the week by the UTC day it began, six days before today', () => {
    expect(trendingWindowStart('week', NOW, 'UTC')).toBe('Sat, Sep 26, 00:00 UTC')
    expect(trendingWindowStart('week', NOW, 'America/New_York')).toBe('Sat, Sep 26, 00:00 UTC (Fri, Sep 25, 8:00 PM your time)')
  })

  it('describes the fused star without an opt-out, and the beat shape with it', () => {
    const fused = trendingNote('fused', 'week', NOW, 'UTC')
    expect(fused).toBe(
      "Most new stars this week (since Sat, Sep 26, 00:00 UTC). Private repos and owners' stars on new repos aren't counted. Unstarring doesn't undo a count.",
    )
    expect(fused).not.toContain('opted out')
    const beat = trendingNote('beat', 'today', NOW, 'UTC')
    expect(beat).toBe("Most new stars today (since 00:00 UTC). Private repos, owners' own stars and stars from people who opted out aren't counted. Unstarring doesn't undo a count.")
  })

  it('says only what holds for both shapes while the shape is read, and no start without a clock', () => {
    expect(trendingNote(null, 'today', null)).toBe('Most new stars today.')
  })
})
