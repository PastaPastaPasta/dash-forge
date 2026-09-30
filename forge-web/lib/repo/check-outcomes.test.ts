/**
 * The CI outcome counts behind the list dots (O-07), against the Drive-shaped mock: a page's heads
 * cost exactly {@link OUTCOME_REQUESTS} proved counts (one per outcome, `headOid in [page]` grouped
 * by head), a later page only the heads it adds, and a head no run names reads as no dot.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ForgeIds } from '../deployments'
import { LOG_PAGE } from '../view/path-history'
import { base64ToHex, hexToBase64 } from '../sdk'
import {
  CACHE_TTL_MS,
  OUTCOME_REQUESTS,
  cachedOutcomeCounts,
  checkDotState,
  clearOutcomeCache,
  outcomePhrase,
  RESOLVE_MAX,
  readOutcomeCounts,
} from './check-outcomes'
import type { RepoRef } from './contract'
import { mockSdk, newSeen, type Doc, type Seen, type Store } from './drive-mock'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OTHER = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const RUNNER = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const repo: RepoRef = { forge: FORGE, repoId: REPO, ownerId: OTHER, name: 'demo', visibility: 'public' }

const oid = (n: number, width = 40): string => n.toString(16).padStart(width, '0')

let seq = 0
/** A `checkRun` on `head` with `outcome` (the stored `toJSON` shape: headOid base64), named `name` (distinct by default). */
const run = (head: string, outcome: 0 | 1 | 2, repoId = REPO, name?: string): Doc => {
  seq += 1
  return {
    $id: `run${String(seq).padStart(4, '0')}`,
    $ownerId: RUNNER,
    $createdAt: 1_000 + seq,
    repoId,
    headOid: hexToBase64(head),
    name: name ?? `check-${seq}`,
    status: outcome === 0 ? 'queued' : 'completed',
    ...(outcome === 0 ? {} : { conclusion: outcome === 1 ? 'success' : 'failure' }),
    outcome,
  }
}

function setup(runs: Doc[]): { sdk: ReturnType<typeof mockSdk>; seen: Seen; store: Store } {
  const seen = newSeen()
  const store: Store = { COMMUNITY: { checkRun: runs } }
  return { sdk: mockSdk(store, seen), seen, store }
}

const all = (seen: Seen): number => seen.composites.length + seen.queries.length + seen.counts.length + seen.sums.length

beforeEach(() => clearOutcomeCache())

describe('CI outcome counts for a list page', () => {
  it('counts each head by outcome from three proved counts, plus one run read per mixed head', async () => {
    // Head 1: 2 passed + 1 failed; head 2: 1 pending + 1 passed; head 3: none; a run in another repo.
    const { sdk, seen } = setup([run(oid(1), 1), run(oid(1), 1), run(oid(1), 2), run(oid(2), 0), run(oid(2), 1), run(oid(1), 2, OTHER)])
    const heads = Array.from({ length: 25 }, (_, i) => oid(i + 1))
    const counts = await readOutcomeCounts(sdk, repo, heads)

    expect(counts.get(oid(1))).toEqual({ pending: 0, passed: 2, failed: 1 })
    expect(counts.get(oid(2))).toEqual({ pending: 1, passed: 1, failed: 0 })
    expect(counts.get(oid(3))).toEqual({ pending: 0, passed: 0, failed: 0 })
    expect(counts.size).toBe(25)

    // The budget: one proved count per outcome for the page; heads 1 and 2 are mixed (distinct
    // checks here, so resolving changes nothing) and cost one run read each; no other row costs anything.
    expect(OUTCOME_REQUESTS).toBe(3)
    expect(seen.counts).toHaveLength(OUTCOME_REQUESTS)
    expect(seen.queries.map((q) => q.documentTypeName)).toEqual(['checkRun', 'checkRun'])
    expect(all(seen)).toBe(OUTCOME_REQUESTS + 2)
    // Each on the `outcome (repoId, headOid, outcome)` index: repoId ==, headOid in (base64), outcome ==, grouped by head.
    for (const [k, q] of seen.counts.entries()) {
      expect(q.dataContractId).toBe('COMMUNITY')
      expect(q.documentTypeName).toBe('checkRun')
      expect((q as { groupBy?: string[] }).groupBy).toEqual(['headOid'])
      const where = q.where ?? []
      expect(where[0]).toEqual(['repoId', '==', REPO])
      expect(where[1]?.[0]).toBe('headOid')
      expect(where[1]?.[1]).toBe('in')
      expect((where[1]?.[2] as string[]).map(base64ToHex).sort()).toEqual([...heads].sort())
      expect(where[2]).toEqual(['outcome', '==', k])
    }
  })

  it('a commit log page costs three counts, and the next page only reads the commits it adds', async () => {
    const { sdk, seen } = setup([run(oid(5), 1), run(oid(45), 2)])
    const page1 = Array.from({ length: LOG_PAGE }, (_, i) => oid(i + 1))
    const page2 = Array.from({ length: LOG_PAGE }, (_, i) => oid(LOG_PAGE + i + 1))
    await readOutcomeCounts(sdk, repo, page1)
    expect(seen.counts).toHaveLength(OUTCOME_REQUESTS)

    const both = await readOutcomeCounts(sdk, repo, [...page1, ...page2])
    expect(seen.counts).toHaveLength(2 * OUTCOME_REQUESTS)
    const second = seen.counts.slice(OUTCOME_REQUESTS).map((q) => (q.where?.[1]?.[2] as string[]).length)
    expect(second).toEqual([LOG_PAGE, LOG_PAGE, LOG_PAGE])
    expect(both.get(oid(5))?.passed).toBe(1)
    expect(both.get(oid(45))?.failed).toBe(1)

    // A revisit within the cache's minute reads nothing; the seed is what the list shows first.
    await readOutcomeCounts(sdk, repo, page2)
    expect(seen.counts).toHaveLength(2 * OUTCOME_REQUESTS)
    expect(cachedOutcomeCounts(repo, page1).size).toBe(LOG_PAGE)
    expect(cachedOutcomeCounts(repo, page1, CACHE_TTL_MS, Date.now() + 2 * CACHE_TTL_MS).size).toBe(0)
    // What a list shows while it re-reads: the last known counts, however old.
    expect(cachedOutcomeCounts(repo, page1, Infinity, Date.now() + 2 * CACHE_TTL_MS).size).toBe(LOG_PAGE)
  })

  it('reads a head again once its reply is older than the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { sdk, seen } = setup([run(oid(1), 1)])
      await readOutcomeCounts(sdk, repo, [oid(1)])
      vi.setSystemTime(Date.now() + CACHE_TTL_MS - 1)
      await readOutcomeCounts(sdk, repo, [oid(1)])
      expect(seen.counts).toHaveLength(OUTCOME_REQUESTS)
      vi.setSystemTime(Date.now() + 1)
      await readOutcomeCounts(sdk, repo, [oid(1)])
      expect(seen.counts).toHaveLength(2 * OUTCOME_REQUESTS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('names at most 100 heads per count: 150 heads are two batches', async () => {
    const { sdk, seen } = setup([])
    await readOutcomeCounts(sdk, repo, Array.from({ length: 150 }, (_, i) => oid(i + 1)))
    expect(seen.counts).toHaveLength(2 * OUTCOME_REQUESTS)
    expect(seen.counts.map((q) => (q.where?.[1]?.[2] as string[]).length).sort((a, b) => a - b)).toEqual([50, 50, 50, 100, 100, 100])
  })

  it('joins a read already in flight rather than sending the same heads again', async () => {
    const { sdk, seen } = setup([run(oid(1), 1)])
    const heads = [oid(1), oid(2)]
    const [a, b] = await Promise.all([readOutcomeCounts(sdk, repo, heads), readOutcomeCounts(sdk, repo, [...heads, oid(3)])])
    expect(a.get(oid(1))?.passed).toBe(1)
    expect(b.get(oid(1))?.passed).toBe(1)
    expect(b.get(oid(3))).toEqual({ pending: 0, passed: 0, failed: 0 })
    // The second call read only oid(3): three counts for the first two, three for the third.
    expect(seen.counts).toHaveLength(2 * OUTCOME_REQUESTS)
    expect(seen.counts.slice(OUTCOME_REQUESTS).every((q) => (q.where?.[1]?.[2] as string[]).length === 1)).toBe(true)
  })

  it('reads SHA-256 heads, folds case and duplicates, skips what is not an oid, and reads nothing for no heads', async () => {
    const sha256Head = oid(7, 64)
    const { sdk, seen } = setup([run(sha256Head, 0)])
    const counts = await readOutcomeCounts(sdk, repo, [sha256Head.toUpperCase(), sha256Head, 'not-an-oid', ''])
    expect([...counts.keys()]).toEqual([sha256Head])
    expect(counts.get(sha256Head)?.pending).toBe(1)
    expect(seen.counts).toHaveLength(OUTCOME_REQUESTS)
    expect((await readOutcomeCounts(sdk, repo, [])).size).toBe(0)
    expect(seen.counts).toHaveLength(OUTCOME_REQUESTS)
  })

  it('never sends the ungrouped range count that fails to verify over an absent path (bonsia probe)', async () => {
    const { sdk, seen } = setup([])
    // The dot read over heads with no runs: grouped point lookups (`outcome ==`), which verify.
    expect((await readOutcomeCounts(sdk, repo, [oid(9)])).get(oid(9))).toEqual({ pending: 0, passed: 0, failed: 0 })
    for (const q of seen.counts) {
      expect((q as { groupBy?: string[] }).groupBy).toEqual(['headOid'])
      expect((q.where ?? []).every(([, op]) => op === '==' || op === 'in')).toBe(true)
    }
    // The shape the probe refutes, which the mock refuses the same way.
    const count = (sdk as unknown as { documents: { count: (q: unknown) => Promise<unknown> } }).documents.count
    await expect(
      count({ dataContractId: 'COMMUNITY', documentTypeName: 'checkRun', where: [['repoId', '==', REPO], ['headOid', '==', hexToBase64(oid(9))], ['outcome', '>=', 0]] }),
    ).rejects.toThrow()
  })

  it('caches nothing from a failed read: the retry asks again', async () => {
    const { sdk, seen } = setup([run(oid(1), 2)])
    const documents = (sdk as unknown as { documents: { count: (q: unknown) => Promise<unknown> } }).documents
    const count = documents.count
    documents.count = async () => {
      throw new Error('node down')
    }
    await expect(readOutcomeCounts(sdk, repo, [oid(1)])).rejects.toThrow('node down')
    documents.count = count
    expect(cachedOutcomeCounts(repo, [oid(1)]).size).toBe(0)
    expect((await readOutcomeCounts(sdk, repo, [oid(1)])).get(oid(1))?.failed).toBe(1)
    expect(seen.counts).toHaveLength(OUTCOME_REQUESTS)
  })
})

describe('re-runs: mixed heads resolve to the newest run of each check', () => {
  it('a check that failed and then passed on a re-run is green; one still failing stays red', async () => {
    const { sdk, seen } = setup([
      run(oid(1), 2, REPO, 'build'), run(oid(1), 1, REPO, 'build'), // re-run fixed it
      run(oid(2), 1, REPO, 'build'), run(oid(2), 2, REPO, 'build'), // re-run broke it
      run(oid(3), 1, REPO, 'lint'), run(oid(3), 0, REPO, 'lint'), // re-run pending
      run(oid(4), 1, REPO, 'build'), run(oid(4), 1, REPO, 'lint'), // not mixed: the fast path
    ])
    const counts = await readOutcomeCounts(sdk, repo, [oid(1), oid(2), oid(3), oid(4)])
    expect(counts.get(oid(1))).toEqual({ pending: 0, passed: 1, failed: 0 })
    expect(checkDotState(counts.get(oid(1))!)).toBe('success')
    expect(counts.get(oid(2))).toEqual({ pending: 0, passed: 0, failed: 1 })
    expect(counts.get(oid(3))).toEqual({ pending: 1, passed: 0, failed: 0 })
    expect(counts.get(oid(4))).toEqual({ pending: 0, passed: 2, failed: 0 })
    // Three counts, and one run read for each of the three mixed heads only.
    expect(seen.counts).toHaveLength(OUTCOME_REQUESTS)
    expect(seen.queries).toHaveLength(3)
    expect(all(seen)).toBe(OUTCOME_REQUESTS + 3)
  })

  it(`resolves at most ${RESOLVE_MAX} mixed heads per page; the rest show as mixed, never red`, async () => {
    const runs: Doc[] = []
    for (let i = 1; i <= RESOLVE_MAX + 3; i++) runs.push(run(oid(i), 2, REPO, 'build'), run(oid(i), 1, REPO, 'build'))
    const { sdk, seen } = setup(runs)
    const heads = Array.from({ length: RESOLVE_MAX + 3 }, (_, i) => oid(i + 1))
    const counts = await readOutcomeCounts(sdk, repo, heads)
    expect(seen.queries).toHaveLength(RESOLVE_MAX)
    expect(all(seen)).toBe(OUTCOME_REQUESTS + RESOLVE_MAX)
    const states = heads.map((h) => checkDotState(counts.get(h)!))
    expect(states.filter((x) => x === 'success')).toHaveLength(RESOLVE_MAX)
    expect(states.filter((x) => x === 'mixed')).toHaveLength(3)
    expect(states).not.toContain('failure')
    const past = counts.get(heads.find((h) => counts.get(h)?.unresolved === true)!)!
    expect(outcomePhrase(past)).toBe('Mixed results across re-runs: 1 successful, 1 failing runs')
  })

  it('resolves the top rows first, and reads an unresolved head again rather than serving it from the cache', async () => {
    const runs: Doc[] = []
    // Lowest hex last in the list, so a hex-ordered cap would resolve the wrong rows.
    const heads = Array.from({ length: RESOLVE_MAX + 2 }, (_, i) => oid(RESOLVE_MAX + 2 - i))
    for (const h of heads) runs.push(run(h, 2, REPO, 'build'), run(h, 1, REPO, 'build'))
    const { sdk, seen } = setup(runs)
    const first = await readOutcomeCounts(sdk, repo, heads)
    expect(heads.map((h) => first.get(h)?.unresolved === true)).toEqual(heads.map((_, i) => i >= RESOLVE_MAX))
    const before = all(seen)
    const again = await readOutcomeCounts(sdk, repo, heads)
    // Only the two unresolved heads are read again: three counts and two run reads.
    expect(all(seen) - before).toBe(OUTCOME_REQUESTS + 2)
    expect(heads.every((h) => checkDotState(again.get(h)!) === 'success')).toBe(true)
    // Everything resolved is now cached: nothing more is read.
    const settled = all(seen)
    await readOutcomeCounts(sdk, repo, heads)
    expect(all(seen)).toBe(settled)
  })

  it('a head whose runs cannot be read shows as mixed; the rest of the page keeps its dots', async () => {
    const { sdk } = setup([
      run(oid(1), 2, REPO, 'build'), run(oid(1), 1, REPO, 'build'),
      run(oid(2), 1, REPO, 'build'),
    ])
    const query = sdk.documents.query.bind(sdk.documents)
    sdk.documents.query = (async () => {
      throw new Error('unavailable')
    }) as typeof sdk.documents.query
    const counts = await readOutcomeCounts(sdk, repo, [oid(1), oid(2)])
    sdk.documents.query = query
    expect(checkDotState(counts.get(oid(1))!)).toBe('mixed')
    expect(checkDotState(counts.get(oid(2))!)).toBe('success')
  })
})

describe('the dot and its label', () => {
  it("is GitHub's: any failure is red, else pending is yellow, else green; none without runs", () => {
    expect(checkDotState({ pending: 1, passed: 3, failed: 1 })).toBe('failure')
    expect(checkDotState({ pending: 1, passed: 3, failed: 0 })).toBe('pending')
    expect(checkDotState({ pending: 0, passed: 3, failed: 0 })).toBe('success')
    expect(checkDotState({ pending: 0, passed: 0, failed: 0 })).toBeNull()
  })

  it('says how many of each', () => {
    expect(outcomePhrase({ pending: 0, passed: 2, failed: 1 })).toBe('2 successful, 1 failing checks')
    expect(outcomePhrase({ pending: 1, passed: 0, failed: 0 })).toBe('1 pending check')
    expect(outcomePhrase({ pending: 2, passed: 1, failed: 0 })).toBe('1 successful, 2 pending checks')
    expect(outcomePhrase({ pending: 0, passed: 0, failed: 0 })).toBe('')
  })
})
