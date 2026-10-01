/**
 * Trending (platform-parity-spec §4.3): the preference and its default, and the ranked reads
 * Explore issues (the request each one sends, and how a page decodes).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import { resetStarShapes } from './star-shape'
import { TRENDING_DEFAULT, TRENDING_PREF_KEY, readMostFollowed, readMostStarred, readTrending, setTrendingPref, trendingPref } from './trending'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'G' }

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

  /** `schemas`: forge-community's document types (a fused-star contract has no `starBeat`). */
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
    await readTrending(rankedSdk(seen, { star: {} }), FORGE, 'week', 25)
    expect(seen).toEqual([
      { dataContractId: 'COMMUNITY', documentTypeName: 'star', groupBy: 'repoId', aggregate: { type: 'count' }, limit: 25, direction: 'desc', timeRange: [{ field: '$createdAt', selector: 'oldest' }] },
    ])
  })

  it('reads the shape once per contract, and again after a failed read', async () => {
    let fetches = 0
    const flaky = {
      contracts: { fetch: () => (++fetches === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ schemas: { star: {} } })) },
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
