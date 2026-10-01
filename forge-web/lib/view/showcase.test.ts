/**
 * QW-045: the showcase repos are read in one composite by id, shown in the configured order,
 * and only when the document is the entry's own (its owner and name), never another repo that
 * shares a name (Explore's Trending #1 was a second "forge-v2 demo" of another owner).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const queries: { where: unknown[] }[] = []
let answer: Record<string, unknown>[] = []
vi.mock('./discovery', async (orig) => {
  const real = await orig<typeof import('./discovery')>()
  return {
    ...real,
    // The composite's rows, as `reposOf` turns them into cards.
    discoverReposById: vi.fn(async (_sdk: unknown, ids: readonly string[]) => {
      queries.push({ where: [['$id', 'in', ids]] })
      return new Map(answer.map((d) => [d['$id'] as string, real.fromRepoDoc({ repoId: d['$id'], ownerId: d['$ownerId'], name: d['name'], displayName: '', description: '', visibility: d['visibility'], defaultBranch: null, topics: [], forkOf: null, createdAt: 0 } as never, { stars: 1 })]))
    }),
  }
})

import type { EvoSDK } from '@dashevo/evo-sdk'
import { listShowcaseRepos, type ShowcaseEntry } from './showcase'

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
