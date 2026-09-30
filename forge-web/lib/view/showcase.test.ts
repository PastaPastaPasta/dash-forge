/**
 * QW-045: the showcase repos are read in one proved query by id, shown in the configured order,
 * and only when the document is the entry's own (its owner and name), never another repo that
 * shares a name (Explore's Trending #1 was a second "forge-v2 demo" of another owner).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const queries: unknown[] = []
let answer: Record<string, unknown>[] = []
vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: unknown) => {
    queries.push(q)
    return { documents: answer }
  }),
}))

vi.mock('../constants', async (orig) => {
  const real = await orig<typeof import('../constants')>()
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet: { ...real.NETWORKS.devnet, v2: { core: 'C' } } } }
})

import type { EvoSDK } from '@dashevo/evo-sdk'
import { listShowcaseRepos, showcaseFor } from './showcase'

const entries = showcaseFor('devnet-bonsia')
const doc = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const e = entries[i]!
  return { $id: e.repoId, $ownerId: e.owner, name: e.name, visibility: 'public', description: e.name, ...over }
}

beforeEach(() => {
  queries.length = 0
})

describe('listShowcaseRepos', () => {
  it('reads every entry at once and keeps the configured order', async () => {
    answer = [doc(2), doc(0), doc(1)]
    const got = await listShowcaseRepos({} as EvoSDK, 'devnet', 'devnet-bonsia')
    expect(queries).toHaveLength(1)
    expect((queries[0] as { where: unknown[] }).where).toEqual([['$id', 'in', entries.map((e) => e.repoId)]])
    expect(got.map((r) => r.slug)).toEqual(['dips', 'dash', 'forge-v2-demo'])
  })

  it('leaves out a document that is not the entry’s, a private one, and a missing one', async () => {
    answer = [doc(0, { $ownerId: '6eBY8D5'.padEnd(44, 'x') }), doc(1, { visibility: 'private' })]
    expect(await listShowcaseRepos({} as EvoSDK, 'devnet', 'devnet-bonsia')).toEqual([])
  })

  it('reads nothing on a network with no showcase', async () => {
    expect(await listShowcaseRepos({} as EvoSDK, 'testnet', 'testnet')).toEqual([])
    expect(queries).toHaveLength(0)
  })
})
