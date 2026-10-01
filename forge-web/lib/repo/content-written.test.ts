/**
 * G4: every write that changes what a repo stores tells the browse cache and the repo home
 * (`repoContentWritten`), for the repo written to — a browser merge's base repo, and a branch
 * commit's source repo when that is a fork of the repo being viewed. A write that fails still
 * drops the caches (it may have landed), but names no moved ref.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'

const write = vi.fn()
// RC2 member roles: the claimed role (`r`) is role-claim.test.ts's and rc1-writers.test.ts's.
vi.mock('./role-claim', async (orig) => ({ ...(await orig<typeof import('./role-claim')>()), roleClaim: async () => ({}) }))
vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  createDocumentIdempotent: (...a: unknown[]) => write(...a),
}))
vi.mock('./config', () => ({ readConfigBundle: () => Promise.resolve({ config: { protectedPatterns: [] }, history: [] }) }))

const { onRepoContentWritten, writePackManifest, writeRefUpdate } = await import('./push')

const forge = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const PARENT: RepoRef = { forge, repoId: '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD', ownerId: 'o', name: 'p', visibility: 'public' }
const FORK: RepoRef = { forge, repoId: 'GKBTXUdo3MpRYAUqgZvTZGTav9mXGqfJfR5822K2tp79', ownerId: 'c', name: 'f', visibility: 'public' }
const auth = { identityId: 'contributor' } as unknown as WriteAuth
// No existing manifest of this signer: the write goes ahead.
const sdk = { documents: { query: () => Promise.resolve(new Map()) } } as unknown as EvoSDK

const heard: { repo: string; moved?: { refName: string; newOid: string } }[] = []
onRepoContentWritten((repo, moved) => heard.push({ repo: repo.repoId, ...(moved ? { moved } : {}) }))

beforeEach(() => {
  heard.length = 0
  write.mockReset()
  write.mockResolvedValue({ documentId: 'doc', alreadyExisted: false })
})

const manifest = { packHash: 'ab'.repeat(32), kind: 0, sizeBytes: 10, objectCount: 1, chunkCount: 1, storage: 0 as const, uris: ['platform://CORE/r/o/' + 'ab'.repeat(32)] }

describe('repoContentWritten', () => {
  it("a branch commit into a fork: the fork's pack, index and ref writes each tell the caches, about the fork", async () => {
    await writePackManifest(sdk, auth, FORK, manifest)
    await writePackManifest(sdk, auth, FORK, { ...manifest, packHash: 'cd'.repeat(32), kind: 1 })
    await writeRefUpdate(sdk, auth, FORK, { refName: 'refs/heads/fix', newOid: 'EF'.repeat(20) })
    expect(heard).toEqual([
      { repo: FORK.repoId },
      { repo: FORK.repoId },
      { repo: FORK.repoId, moved: { refName: 'refs/heads/fix', newOid: 'ef'.repeat(20) } },
    ])
    expect(heard.some((h) => h.repo === PARENT.repoId)).toBe(false)
  })

  it("a browser merge: the base repo's ref move is named", async () => {
    await writeRefUpdate(sdk, auth, PARENT, { refName: 'refs/heads/main', newOid: '12'.repeat(20), prevOid: '34'.repeat(20) })
    expect(heard).toEqual([{ repo: PARENT.repoId, moved: { refName: 'refs/heads/main', newOid: '12'.repeat(20) } }])
  })

  it('a listener that throws neither hides the write result nor stops the other listeners', async () => {
    const off = onRepoContentWritten(() => {
      throw new Error('listener bug')
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(writeRefUpdate(sdk, auth, PARENT, { refName: 'refs/heads/main', newOid: '12'.repeat(20) })).resolves.toMatchObject({ documentId: 'doc' })
      expect(heard).toHaveLength(1)
    } finally {
      off()
      quiet.mockRestore()
    }
  })

  it('a failed write still drops the caches (it may have landed) but names no move', async () => {
    write.mockRejectedValueOnce(new Error('timed out'))
    await expect(writeRefUpdate(sdk, auth, PARENT, { refName: 'refs/heads/main', newOid: '12'.repeat(20) })).rejects.toThrow('timed out')
    expect(heard).toEqual([{ repo: PARENT.repoId }])
  })
})
