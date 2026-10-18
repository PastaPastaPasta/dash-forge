import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRef } from './contract'
import { readPendingKeep } from './keep-for-members-read'

const data = vi.hoisted(() => ({ all: [] as unknown[], below: [] as unknown[], public: [] as unknown[], members: [] as unknown[], boundary: 2, unfetched: 0, parents: {} as Record<string, string[]>, tags: {} as Record<string, string>, ready: true, folds: [] as (number | undefined)[] }))
vi.mock('../auth/base58', () => ({ decodeIdentifier: () => new Uint8Array(32) }))
vi.mock('./config', () => ({ readDefaultBranch: async () => 'main' }))
vi.mock('./source', () => ({ readAllRows: async () => [] }))
vi.mock('./private-session', () => ({ readSessionSealOff: async () => ({ kind: 'active', epoch: data.boundary, replacesThrough: null }) }))
vi.mock('./private-content', () => ({ privateGate: () => ({}), admitAll: async () => ({ docs: [] }) }))
vi.mock('./make-public-check', () => ({
  privateViewOf: (repo: RepoRef) => ({ ...repo, visibility: 'private' }),
  readConversion: async () => ({ sealOffEpoch: 3, markerHeight: 20 }),
  privateEraRefs: async (_session: unknown, _rows: unknown, below: number | undefined) => { data.folds.push(below); return below === undefined ? data.all : data.below },
  openPrivateEraPacks: async () => ({ packs: [], unfetched: data.unfetched }),
}))
vi.mock('./make-public-objects', () => ({ workStoreOf: async () => ({ oids: new Set() }) }))
vi.mock('./members-branches', () => ({ readMembersRefs: async () => ({ branches: data.members }) }))
vi.mock('./refs', () => ({ readRefs: async () => data.public }))
vi.mock('./fork', () => ({ refTip: (r: { tip: string }) => r.tip }))
vi.mock('../view/browse-source', () => ({ loadBrowseContext: async () => data.ready ? ({ kind: 'ready', context: { reader: { readObject: async (oid: string) => {
  if (oid in data.tags) return { type: 'tag', bytes: new TextEncoder().encode(`object ${data.tags[oid]}\ntype commit\ntag v2\ntagger a <a@a> 1 +0000\n\ntag\n`) }
  if (!(oid in data.parents)) throw new Error('missing object')
  return { type: 'commit', bytes: new TextEncoder().encode(`tree ${'0'.repeat(40)}\n${data.parents[oid]!.map((p) => `parent ${p}\n`).join('')}author a <a@a> 1 +0000\ncommitter a <a@a> 1 +0000\n\nmessage\n`) }
} } } }) : ({ kind: 'unindexed' }) }))

const ref = (name: string, tip: string) => ({ refName: `refs/heads/${name}`, tip })
const repo = (): RepoRef => ({ repoId: 'r', ownerId: 'o', visibility: 'public', name: 'n', lane: { closed: false, resolution: { anchors: new Map() } } }) as unknown as RepoRef
const sdk = {} as EvoSDK
beforeEach(() => {
  data.all = [ref('topic', 'b')]
  data.below = [ref('topic', 'a')]
  data.public = [ref('topic', 'a')]
  data.members = []
  data.boundary = 2
  data.unfetched = 0
  data.parents = { a: [], b: ['a'] }
  data.tags = {}
  data.folds = []
  data.ready = true
})

describe('pending member keep count', () => {
  it('uses both private-era folds and the existing lower marker boundary', async () => {
    expect(await readPendingKeep(sdk, repo())).toBe(1)
    expect(data.folds).toEqual([undefined, 2])
  })
  it('clamps to the recorded run when its boundary is lower', async () => {
    expect(await readPendingKeep(sdk, repo(), 1)).toBe(1)
    expect(data.folds).toEqual([undefined, 1])
  })
  it('counts no work once an alias contains the withheld tip', async () => {
    data.members = [ref('members/topic', 'c')]
    data.parents['c'] = ['b']
    expect(await readPendingKeep(sdk, repo())).toBe(0)
  })
  it('needs no old pack when a members-only ref already has the exact tip', async () => {
    data.members = [ref('members/topic', 'b')]
    data.unfetched = 1
    expect(await readPendingKeep(sdk, repo())).toBe(0)
  })
  it('counts no work when public history contains the tip', async () => {
    data.public = [ref('topic', 'c')]
    data.parents['c'] = ['b']
    expect(await readPendingKeep(sdk, repo())).toBe(0)
  })
  it('follows annotated public tags when checking coverage', async () => {
    data.public = [{ refName: 'refs/tags/v2', tip: 'tag' }]
    data.all = [ref('topic', 'b'.repeat(40))]
    data.tags['tag'] = 'b'.repeat(40)
    expect(await readPendingKeep(sdk, repo())).toBe(0)
  })
  it('does not count tags', async () => {
    data.all = [{ refName: 'refs/tags/v2', tip: 'b' }]
    data.below = []
    expect(await readPendingKeep(sdk, repo())).toBe(0)
  })
  it('does not treat a narrower branch as kept for all members', async () => {
    data.members = [{ ...ref('members/topic', 'b'), narrower: {} }]
    expect(await readPendingKeep(sdk, repo())).toBe(1)
  })
  it('does not infer a count without keys or when packs are incomplete', async () => {
    expect(await readPendingKeep(sdk, { ...repo(), lane: undefined })).toBeNull()
    data.unfetched = 1
    expect(await readPendingKeep(sdk, repo())).toBeNull()
  })
  it('does not infer coverage when public objects cannot be read', async () => {
    data.ready = false
    await expect(readPendingKeep(sdk, repo())).rejects.toThrow('Code could not be read')
  })
})
