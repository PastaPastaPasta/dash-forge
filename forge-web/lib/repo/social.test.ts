/**
 * Follow lists (L-36): `follow` is `indexOnly`, so Drive refuses a `startAfter` cursor and a
 * list pages by a range on the index's terminal, ordered by it. The mock enforces that shape.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import type { RepoRef } from './contract'
import { noteTargetCreated, readFollowPage, readTargetCounts } from './social'

const FORGE = { core: 'CORE', collab: 'COLLAB', group: 'G' } as unknown as ForgeIds

interface Q {
  documentTypeName: string
  where?: readonly (readonly [string, string, unknown])[]
  orderBy?: readonly (readonly [string, string])[]
  limit?: number
  startAfter?: string
}

/** `a` follows `b`, as index-only rows; ids sort as strings (base58 of equal length does). */
const EDGES: readonly (readonly [string, string])[] = [
  ['A1', 'T'], ['A2', 'T'], ['A3', 'T'], ['A4', 'T'], ['A5', 'T'],
  ['T', 'B1'], ['T', 'B2'],
  ['A1', 'X'],
]

function followSdk(seen: Q[]): EvoSDK {
  return {
    documents: {
      query: (q: Q): Promise<Map<string, unknown>> => {
        seen.push(q)
        if (q.startAfter !== undefined) return Promise.reject(new Error('startAt/startAfter cannot address an indexOnly position'))
        let rows = EDGES.map(([owner, target], i) => ({ $id: `f${i}`, $ownerId: owner, identityId: target }) as Record<string, unknown>)
        for (const [field, op, value] of q.where ?? []) {
          if (op === '==') rows = rows.filter((d) => d[field] === value)
          else if (op === '>') rows = rows.filter((d) => String(d[field]) > String(value))
          else return Promise.reject(new Error(`unsupported ${op}`))
        }
        const [field] = q.orderBy?.[0] ?? ['$id']
        rows.sort((a, b) => (String(a[field]) < String(b[field]) ? -1 : 1))
        rows = rows.slice(0, q.limit ?? 100)
        return Promise.resolve(new Map(rows.map((d) => [String(d['$id']), d])))
      },
    },
  } as unknown as EvoSDK
}

describe('readTargetCounts after a create (L-37)', () => {
  const REPO = { forge: FORGE, repoId: 'R', ownerId: 'o', name: 'n', visibility: 'public' } as unknown as RepoRef

  /** A count facade answering `answers` in turn for issues (last one repeats), 0 for patches. */
  function countingSdk(answers: number[]): { sdk: EvoSDK; reads: () => number } {
    let reads = 0
    const sdk = {
      documents: {
        count: (q: Q): Promise<Map<string, bigint>> => {
          if (q.documentTypeName !== 'issue') return Promise.resolve(new Map([['', 0n]]))
          const n = answers[Math.min(reads++, answers.length - 1)]!
          return Promise.resolve(new Map([['', BigInt(n)]]))
        },
      },
    } as unknown as EvoSDK
    return { sdk, reads: () => reads }
  }

  it('re-reads a count that a lagging node gives below what this browser created', async () => {
    await readTargetCounts(countingSdk([0]).sdk, FORGE, 'R', { retryMs: 0 })
    noteTargetCreated(REPO, 'issue')
    const lagging = countingSdk([0, 0, 1])
    expect(await readTargetCounts(lagging.sdk, FORGE, 'R', { retryMs: 0 })).toEqual({ issues: 1, pulls: 0 })
    expect(lagging.reads()).toBe(3)
    // Once seen, the floor is gone: one read.
    const after = countingSdk([1])
    await readTargetCounts(after.sdk, FORGE, 'R', { retryMs: 0 })
    expect(after.reads()).toBe(1)
  })

  it('gives up after a few re-reads and shows what the node says', async () => {
    await readTargetCounts(countingSdk([5]).sdk, FORGE, 'R', { retryMs: 0 })
    noteTargetCreated(REPO, 'issue')
    const stuck = countingSdk([5])
    expect((await readTargetCounts(stuck.sdk, FORGE, 'R', { retryMs: 0 })).issues).toBe(5)
    expect(stuck.reads()).toBe(5)
    // The floor is spent: the next read does not wait again.
    const next = countingSdk([5])
    await readTargetCounts(next.sdk, FORGE, 'R', { retryMs: 0 })
    expect(next.reads()).toBe(1)
  })

  it('two creates raise the floor by two', async () => {
    await readTargetCounts(countingSdk([7]).sdk, FORGE, 'R', { retryMs: 0 })
    noteTargetCreated(REPO, 'issue')
    noteTargetCreated(REPO, 'issue')
    const lagging = countingSdk([8, 9])
    expect((await readTargetCounts(lagging.sdk, FORGE, 'R', { retryMs: 0 })).issues).toBe(9)
    expect(lagging.reads()).toBe(2)
  })
})

describe('readFollowPage', () => {
  it('lists followers by the byTarget terminal, paging with a range and no startAfter', async () => {
    const seen: Q[] = []
    const sdk = followSdk(seen)
    const first = await readFollowPage(sdk, FORGE, 'T', 'followers', null, 2)
    expect(first).toEqual({ ids: ['A1', 'A2'], next: 'A2' })
    const second = await readFollowPage(sdk, FORGE, 'T', 'followers', first.next, 2)
    expect(second).toEqual({ ids: ['A3', 'A4'], next: 'A4' })
    const last = await readFollowPage(sdk, FORGE, 'T', 'followers', second.next, 2)
    expect(last).toEqual({ ids: ['A5'], next: null })
    for (const q of seen) {
      expect(q.startAfter).toBeUndefined()
      expect(q.orderBy).toEqual([['$ownerId', 'asc']])
      expect(q.where?.[0]).toEqual(['identityId', '==', 'T'])
    }
  })

  it('lists whom an identity follows by the byOwner terminal', async () => {
    const seen: Q[] = []
    const page = await readFollowPage(followSdk(seen), FORGE, 'T', 'following')
    expect(page).toEqual({ ids: ['B1', 'B2'], next: null })
    expect(seen[0]?.orderBy).toEqual([['identityId', 'asc']])
    expect(seen[0]?.where?.[0]).toEqual(['$ownerId', '==', 'T'])
  })

  it('an identity nobody follows has an empty last page', async () => {
    expect(await readFollowPage(followSdk([]), FORGE, 'B1', 'following')).toEqual({ ids: [], next: null })
  })
})
