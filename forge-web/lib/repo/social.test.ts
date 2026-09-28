/**
 * Follow lists (L-36): `follow` is `indexOnly`, so Drive refuses a `startAfter` cursor and a
 * list pages by a range on the index's terminal, ordered by it. The mock enforces that shape.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import { readFollowPage } from './social'

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
