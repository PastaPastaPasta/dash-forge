import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DocumentQuery, PlainDocument } from '../sdk'
import { RoleOracle, type Membership } from '../rules/v2'

// The records and the membership a test serves; every query is recorded.
const served: { docs: PlainDocument[]; members: Membership[]; queries: DocumentQuery[] } = { docs: [], members: [], queries: [] }
const writes = vi.hoisted(() => ({ created: [] as unknown[], deleted: [] as unknown[], fail: null as unknown }))
vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryAllDocuments: async (_sdk: unknown, q: DocumentQuery) => {
    served.queries.push(q)
    return served.docs
  },
  createDocumentIdempotent: async (_sdk: unknown, _auth: unknown, params: unknown) => {
    if (writes.fail) throw writes.fail
    writes.created.push(params)
    return { documentId: 'new' }
  },
  deleteDocumentIdempotent: async (_sdk: unknown, _auth: unknown, params: unknown) => {
    writes.deleted.push(params)
    return { deleted: true, actualCredits: null }
  },
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

import { ConsensusRefusal, DUPLICATE_UNIQUE_CODE } from '../sdk'
import { deleteMirror, forgetMirrorsBy, mirrorCopy, mirrorRecordOf, mirrorsBy, mirrorUrisOf, mirrorUrisProblem, recordMirror, resetMirrorUris } from './pack-mirrors'
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
  writes.created = []
  writes.deleted = []
  writes.fail = null
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

describe('pack mirrors (web writer)', () => {
  const REPO_ID = 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1'
  const repo = { ...REPO, repoId: REPO_ID } as RepoRef

  it("lists the signer's records by owner, kept to this repository", async () => {
    served.docs = [
      { ...record('me', 1, ['https://m.example/a']), $id: 'a', repoId: REPO_ID },
      { ...record('me', 2, ['ipfs://bafyb']), $id: 'b', repoId: 'OTHER', kind: 2 },
    ]
    expect(await mirrorsBy({} as never, repo, 'me')).toEqual([{ id: 'a', repoId: REPO_ID, packHash: H, kind: 1, uris: ['https://m.example/a'] }])
    expect(served.queries[0]).toMatchObject({ dataContractId: 'CORE', documentTypeName: 'packMirror', where: [['$ownerId', '==', 'me']], orderBy: [['$createdAt', 'asc']] })
  })

  it("reads the signer's records once per session, again after a pin or unpin", async () => {
    served.docs = [{ ...record('me', 1, ['https://m.example/a']), $id: 'a', repoId: REPO_ID }]
    await mirrorsBy({} as never, repo, 'me')
    await mirrorsBy({} as never, { ...repo, repoId: 'OTHER' } as RepoRef, 'me')
    expect(served.queries).toHaveLength(1)
    forgetMirrorsBy('me')
    await mirrorsBy({} as never, repo, 'me')
    expect(served.queries).toHaveLength(2)
  })

  it('records one address with its kind, in forge-meta on a four-contract set', async () => {
    await recordMirror({} as never, {} as never, { ...repo, forge: { ...FORGE, meta: 'META' } } as RepoRef, H, ['ipfs://bafyq'], 'pin:i')
    expect(writes.created).toEqual([expect.objectContaining({ contractId: 'META', documentType: 'packMirror', intent: 'pin:i', data: expect.objectContaining({ kind: 2, uris: ['ipfs://bafyq'] }) })])
  })

  it('refuses a private repository and addresses the rule refuses, before signing', async () => {
    await expect(recordMirror({} as never, {} as never, { ...repo, visibility: 'private' } as RepoRef, H, ['https://m.example/p'])).rejects.toThrow(/public repositories/)
    await expect(recordMirror({} as never, {} as never, repo, H, ['https://m.example/p', 'ipfs://bafyq'])).rejects.toThrow('one mirror holds https addresses or IPFS addresses, not both')
    expect(writes.created).toEqual([])
  })

  it('takes a record the signer already holds as done, and deletes by id', async () => {
    writes.fail = new ConsensusRefusal(DUPLICATE_UNIQUE_CODE, 'duplicate')
    await expect(recordMirror({} as never, {} as never, repo, H, ['https://m.example/p'])).resolves.toBeUndefined()
    await deleteMirror({} as never, {} as never, repo, 'a')
    expect(writes.deleted).toEqual([{ contractId: 'CORE', documentType: 'packMirror', documentId: 'a', repo: REPO_ID }])
  })

  it('words each refusal as the CLI does', () => {
    expect(mirrorUrisProblem(['https://m.example/p'])).toBeNull()
    expect(mirrorUrisProblem([])).toBe('give at least one address')
    expect(mirrorUrisProblem(['ipfs://bafy/x'])).toBe('address 1: an ipfs:// address is the bare CID, no path')
    expect(mirrorUrisProblem(['https://a.example/p', 'https://a.example/p'])).toBe('address 2: the same address twice')
  })
})
