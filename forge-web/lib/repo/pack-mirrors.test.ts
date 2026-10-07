import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DocumentQuery, PlainDocument } from '../sdk'
import { RoleOracle, type Membership } from '../rules/v2'

// The records and the membership a test serves; every query is recorded.
const served: { docs: PlainDocument[]; members: Membership[]; queries: DocumentQuery[] } = { docs: [], members: [], queries: [] }
vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryDocuments: async (_sdk: unknown, q: DocumentQuery) => {
    served.queries.push(q)
    const owners = q.where?.find(([f, op]) => f === '$ownerId' && op === 'in')?.[2] as string[] | undefined
    const rows = owners === undefined ? served.docs : served.docs.filter((d) => owners.includes(String(d['$ownerId'])))
    return [...rows].sort((a, b) => String(a['$ownerId']).localeCompare(String(b['$ownerId']))).slice(0, q.limit ?? 100)
  },
}))
vi.mock('./members', async (orig) => ({
  ...(await orig<typeof import('./members')>()),
  readRoleOracle: async () => new RoleOracle(served.members),
}))

import { mirrorCopy, mirrorRecordOf, mirrorUrisOf, resetMirrorUris } from './pack-mirrors'
import type { ForgeIds } from '../deployments'
import type { RepoRef } from './contract'
import type { PackManifest } from './packs'

const H = 'ab'.repeat(32)
const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const REPO = { forge: FORGE, repoId: 'R', ownerId: 'O', name: 'proj', visibility: 'public' } as unknown as RepoRef
const PACK = { packHash: H, storage: 0, uris: [], copies: [], documentId: 'd' } as unknown as PackManifest

function record(owner: string, at: number, uris: string[]): PlainDocument {
  return { $id: `id-${owner}`, $ownerId: owner, $createdAt: at, packHash: H, kind: 1, uris }
}

afterEach(() => {
  served.docs = []
  served.members = []
  served.queries = []
  resetMirrorUris()
})

describe('pack mirrors (web reader)', () => {
  it('reads a record, and skips one without a pack or addresses', () => {
    expect(mirrorRecordOf({ $id: 'm1', $ownerId: 'o', $createdAt: 3, packHash: H, kind: 1, uris: ['https://m.example/p'] })).toEqual({
      id: 'm1',
      owner: 'o',
      ownerRole: null,
      createdAt: 3,
      packHash: H,
      kind: 1,
      uris: ['https://m.example/p'],
    })
    expect(mirrorRecordOf({ $id: 'm2', packHash: H, kind: 1, uris: [] })).toBeNull()
  })

  it('stands in as one external copy at the mirrors, never for a private repo', async () => {
    expect(mirrorCopy(PACK, ['ipfs://bafyq'])).toMatchObject({ storage: 1, uris: ['ipfs://bafyq'], copies: undefined })
    // A private repo reads nothing at all.
    expect(await mirrorUrisOf({} as never, { ...REPO, visibility: 'private' } as RepoRef, PACK)).toEqual([])
    expect(served.queries).toEqual([])
  })

  it("reads members' records by writer, so a page of strangers' cannot push them out", async () => {
    // 120 strangers whose ids sort before the member's: one page of everyone's holds none of the member's.
    served.docs = [
      ...Array.from({ length: 120 }, (_, n) => record(`a${String(n).padStart(3, '0')}`, n, [`https://s${n}.example/p`])),
      record('zMember', 500, ['https://member.example/p']),
    ]
    served.members = [{ identity: 'zMember', role: 'writer', createdAt: 1 }]
    const uris = await mirrorUrisOf({} as never, REPO, PACK)
    expect(uris[0]).toBe('https://member.example/p')
    expect(uris).toHaveLength(8)
    expect(served.queries.some((q) => q.where?.some(([f, op]) => f === '$ownerId' && op === 'in'))).toBe(true)
  })

  it("ranks a member by the best role they hold, and reads a pack's records once a session", async () => {
    served.docs = [record('w', 1, ['https://w.example/p']), record('m', 2, ['https://m.example/p'])]
    // `m` holds a maintainer document and a later writer one: a maintainer, first.
    served.members = [
      { identity: 'm', role: 'maintainer', createdAt: 1 },
      { identity: 'm', role: 'writer', createdAt: 2 },
      { identity: 'w', role: 'writer', createdAt: 1 },
    ]
    expect(await mirrorUrisOf({} as never, REPO, PACK)).toEqual(['https://m.example/p', 'https://w.example/p'])
    const reads = served.queries.length
    await mirrorUrisOf({} as never, REPO, PACK)
    expect(served.queries).toHaveLength(reads)
    resetMirrorUris()
    await mirrorUrisOf({} as never, REPO, PACK)
    expect(served.queries).toHaveLength(2 * reads)
  })
})
