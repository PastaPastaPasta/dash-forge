/**
 * A browser fork takes its parent's default branch (QW2-013: it was always `main`) and its
 * description, not "fork of <owner id>/<name>" (QW2-062), as a GitHub fork does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const created: unknown[] = []
vi.mock('./writes', async (orig) => ({
  ...(await orig<typeof import('./writes')>()),
  createRepo: vi.fn(async (_sdk: unknown, _auth: unknown, _forge: unknown, input: unknown) => {
    created.push(input)
    return { repoId: 'F'.repeat(44), name: 'fork' }
  }),
}))
vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryDocumentsWithProof: vi.fn(async () => ({ documents: [] })),
}))
vi.mock('./packs', async (orig) => ({ ...(await orig<typeof import('./packs')>()), readRepoPackManifests: vi.fn(async () => []) }))
const parentRefs: { refName: string; state: unknown }[] = []
vi.mock('./refs', async (orig) => ({
  ...(await orig<typeof import('./refs')>()),
  // The parent's refs (the fork's own read comes back empty: it is new).
  readRefs: vi.fn(async (_sdk: unknown, repo: { repoId: string }) => (repo.repoId === 'P'.repeat(44) ? parentRefs : [])),
}))
const refWrites: string[] = []
vi.mock('./push', async (orig) => ({
  ...(await orig<typeof import('./push')>()),
  writeRefUpdate: vi.fn(async (_sdk: unknown, _auth: unknown, _repo: unknown, input: { refName: string }) => {
    refWrites.push(input.refName)
  }),
}))

import type { EvoSDK } from '@dashevo/evo-sdk'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { forkRepoV2 } from './fork'

const parent = { forge: { core: 'C' }, repoId: 'P'.repeat(44), ownerId: 'O'.repeat(44), name: 'proj', visibility: 'public' } as unknown as RepoRef
const auth = { identityId: 'M'.repeat(44) } as unknown as WriteAuth
const sdk = {} as EvoSDK

beforeEach(() => {
  created.length = 0
  refWrites.length = 0
  parentRefs.length = 0
})

describe('forkRepoV2 defaults', () => {
  it("writes the parent's default branch and the description given", async () => {
    await forkRepoV2(sdk, auth, parent, { name: 'proj', description: 'A project', defaultBranch: 'develop' })
    expect(created[0]).toMatchObject({ name: 'proj', description: 'A project', defaultBranch: 'develop', forkOf: parent.repoId })
  })

  it('writes no made-up description when none is given', async () => {
    await forkRepoV2(sdk, auth, parent, { name: 'proj', description: '' })
    const input = created[0] as Record<string, unknown>
    expect(input['description']).toBeUndefined()
    expect(JSON.stringify(input)).not.toContain('fork of')
  })

  it('copies the default branch alone when asked, and never a mirror PR head (QW3-009, QW3-010)', async () => {
    const at = (oid: string) => ({ state: 'resolved', oid, author: 'a', createdAt: 1 })
    parentRefs.push(
      { refName: 'refs/heads/develop', state: at('aa') },
      { refName: 'refs/heads/master', state: at('bb') },
      { refName: 'refs/tags/v1', state: at('cc') },
      { refName: 'refs/mirror/pull/7/head', state: at('dd') },
    )
    const only = await forkRepoV2(sdk, auth, parent, { name: 'proj', defaultBranch: 'develop', defaultBranchOnly: true })
    expect(only.refsWritten).toEqual(['refs/heads/develop'])
    refWrites.length = 0
    const all = await forkRepoV2(sdk, auth, parent, { name: 'proj', defaultBranch: 'develop' })
    expect(all.refsWritten).toEqual(['refs/heads/develop', 'refs/heads/master', 'refs/tags/v1'])
    expect(refWrites).not.toContain('refs/mirror/pull/7/head')
  })
})
