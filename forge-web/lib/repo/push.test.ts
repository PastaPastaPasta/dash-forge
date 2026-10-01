/**
 * The push-side writes in their RC1 forms (R-01, R-02, R-09, R-10, R-11): `packHash` written and
 * queried as an identifier, no `offsetIndexParts`, a manifest shape consensus accepts, and ref
 * updates with an RC1-legal name, 20/32-byte oids and the repo's `vis` stamp (after sealing).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { DocumentQuery, WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import type { PrivateSession } from './private-session'

const write = vi.fn()
// RC2 member roles: the claimed role (`r`) is role-claim.test.ts's and rc1-writers.test.ts's.
vi.mock('./role-claim', () => ({ roleClaim: async () => ({}) }))
vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  createDocumentIdempotent: (...a: unknown[]) => write(...a),
}))
const slept: number[] = []
vi.mock('../sdk/facade', async (orig) => ({
  ...(await orig<typeof import('../sdk/facade')>()),
  sleep: (ms: number) => {
    slept.push(ms)
    return Promise.resolve()
  },
}))
vi.mock('./config', () => ({ readConfigBundle: () => Promise.resolve({ config: { protectedPatterns: [] }, history: [] }) }))
// A private repo's writer: sealing moves the name into `enc`, as `sealContent` does.
vi.mock('./private-writes', () => ({
  privateWriter: () => Promise.resolve({ keys: { epoch: 0 }, protectedPatterns: [] }),
  sealForRepo: (_s: unknown, _a: unknown, _r: unknown, _t: unknown, data: Record<string, unknown>) => {
    const { refName: _name, ...rest } = data
    return Promise.resolve({ ...rest, enc: new Uint8Array(61), epoch: 0 })
  },
  sealedIntent: (intent: string | undefined) => intent,
}))

const { manifestShapeProblem, refUpdateData, writePackManifest, writeRefUpdate } = await import('./push')
const { ConsensusRefusal } = await import('../sdk')

const forge = { core: 'CORE', collab: 'COLLAB', community: 'COMM', group: 'GROUP' }
const REPO: RepoRef = { forge, repoId: '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD', ownerId: 'o', name: 'p', visibility: 'public' }
const auth = { identityId: 'GKBTXUdo3MpRYAUqgZvTZGTav9mXGqfJfR5822K2tp79' } as unknown as WriteAuth
const HASH = 'ab'.repeat(32)
const queries: DocumentQuery[] = []
const sdk = {
  documents: {
    query: (q: DocumentQuery) => {
      queries.push(q)
      return Promise.resolve(new Map())
    },
  },
} as unknown as EvoSDK

beforeEach(() => {
  slept.length = 0
  queries.length = 0
  write.mockReset()
  write.mockResolvedValue({ documentId: 'doc' })
})

const manifest = { packHash: HASH, kind: 0, sizeBytes: 14_700, objectCount: 1, chunkCount: 1, storage: 0 as const, uris: [`platform://CORE/r/o/${HASH}`] }
const dataOf = (call: number): Record<string, unknown> => (write.mock.calls[call]?.[2] as { data: Record<string, unknown> }).data

describe('packManifest (R-09, R-11)', () => {
  it('writes packHash as the 32 identifier bytes and queries it base58, with no offsetIndexParts', async () => {
    await writePackManifest(sdk, auth, REPO, manifest)
    const data = dataOf(0)
    expect(data['packHash']).toEqual(new Uint8Array(32).fill(0xab))
    expect('offsetIndexParts' in data).toBe(false)
    const where = queries[0]?.where ?? []
    expect(where).toContainEqual(['packHash', '==', base58Encode(new Uint8Array(32).fill(0xab))])
  })

  it('refuses before signing a shape consensus refuses', async () => {
    // The R-09 / O-05 / R-11 vectors, as manifest inputs.
    const ok = [
      manifest,
      { ...manifest, sizeBytes: 0, chunkCount: 0 },
      { ...manifest, sizeBytes: 29_400, chunkCount: 2 },
      { ...manifest, storage: 1 as const, chunkCount: 0, sizeBytes: 50_000_000_000 },
      { ...manifest, storage: 1 as const, chunkCount: 0, sizeBytes: 2 ** 40 },
      { ...manifest, kind: 3, tips: ['01'.repeat(20)] },
      { ...manifest, kind: 3, tips: ['01'.repeat(20), '02'.repeat(20)] },
      { ...manifest, kind: 3, tips: ['01'.repeat(32)] },
      { ...manifest, kind: 4 },
    ]
    for (const m of ok) expect(manifestShapeProblem(m)).toBeNull()
    const refused = [
      { ...manifest, storage: 1 as const, chunkCount: 3 },
      { ...manifest, sizeBytes: 14_701 },
      { ...manifest, sizeBytes: 20_000 },
      { ...manifest, sizeBytes: -1 },
      { ...manifest, storage: 1 as const, chunkCount: 0, sizeBytes: 2 ** 40 + 1 },
      { ...manifest, sizeBytes: 1.5 },
      { ...manifest, kind: 3 },
      { ...manifest, kind: 3, tips: ['01'.repeat(20), '02'.repeat(20), '03'.repeat(20)] },
      { ...manifest, kind: 3, tips: ['01'.repeat(20), '02'.repeat(32)] },
      { ...manifest, packHash: 'ab'.repeat(31) },
    ]
    for (const m of refused) expect(manifestShapeProblem(m), JSON.stringify(m)).not.toBeNull()
    await expect(writePackManifest(sdk, auth, REPO, { ...manifest, sizeBytes: 14_701 })).rejects.toThrow(/chunks/)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('a manifest refused by a node a block behind its chunks', () => {
  const lagging = () => new ConsensusRefusal(10422, 'A document of type "packManifest" breaks its propertyConstraints rule "platformChunks": NotMet', {}, false)

  it('is retried after about a block, with a bounded backoff', async () => {
    write.mockRejectedValueOnce(lagging()).mockRejectedValueOnce(lagging()).mockResolvedValueOnce({ documentId: 'doc' })
    await expect(writePackManifest(sdk, auth, REPO, manifest)).resolves.toMatchObject({ documentId: 'doc' })
    expect(write).toHaveBeenCalledTimes(3)
    expect(slept).toEqual([4_000, 8_000])
  })

  it('gives up after the last wait, and never retries another refusal', async () => {
    write.mockRejectedValue(lagging())
    await expect(writePackManifest(sdk, auth, REPO, manifest)).rejects.toThrow(/platformChunks/)
    expect(write).toHaveBeenCalledTimes(4)
    write.mockReset()
    write.mockRejectedValue(new ConsensusRefusal(10422, 'breaks its propertyConstraints rule "storageShape": NotMet'))
    await expect(writePackManifest(sdk, auth, REPO, manifest)).rejects.toThrow(/storageShape/)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not retry a platformChunks refusal paid in a block (the chunks really are missing)', async () => {
    write.mockRejectedValue(new ConsensusRefusal(10422, 'breaks its propertyConstraints rule "platformChunks": NotMet', {}, true))
    await expect(writePackManifest(sdk, auth, REPO, manifest)).rejects.toThrow(/platformChunks/)
    expect(write).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })
})

describe('ref updates (R-01, R-02, R-10)', () => {
  it('refuse an RC1-illegal name or oid before signing', () => {
    for (const refName of ['refs/heads/a..b', 'refs/heads/x.lock', 'refs/heads/a@{1}', 'HEAD', 'heads/main', 'refs/heads/a b', `refs/${'a'.repeat(251)}`]) {
      expect(() => refUpdateData({ refName, newOid: 'ab'.repeat(20) }), refName).toThrow(/illegal ref name/)
    }
    expect(() => refUpdateData({ refName: 'refs/heads/main', newOid: 'ab'.repeat(25) })).toThrow(/20- or 32-byte/)
    expect(() => refUpdateData({ refName: 'refs/heads/main', newOid: 'ab'.repeat(20), prevOid: 'ab'.repeat(21) })).toThrow(/20- or 32-byte/)
    expect(refUpdateData({ refName: 'refs/heads/main', newOid: 'ab'.repeat(32), prevOid: 'cd'.repeat(20) })['prevOid']).toHaveLength(20)
    // A delete: the zero oid of the ref's width.
    expect(refUpdateData({ refName: 'refs/heads/main', newOid: '0'.repeat(40), prevOid: 'ab'.repeat(20) })['newOid']).toEqual(new Uint8Array(20))
  })

  it('stamp a public repo\'s ref update vis public', async () => {
    await writeRefUpdate(sdk, auth, REPO, { refName: 'refs/heads/main', newOid: 'ab'.repeat(20) })
    expect(dataOf(0)).toMatchObject({ refName: 'refs/heads/main', vis: 'public' })
  })

  it('stamp a private repo\'s sealed ref update vis private, in plaintext beside enc', async () => {
    const priv: RepoRef = { ...REPO, visibility: 'private', session: {} as PrivateSession }
    await writeRefUpdate(sdk, auth, priv, { refName: 'refs/heads/main', newOid: 'ab'.repeat(20) })
    const data = dataOf(0)
    expect(data['vis']).toBe('private')
    expect(data['refName']).toBeUndefined()
    expect(data['enc']).toBeInstanceOf(Uint8Array)
  })
})
