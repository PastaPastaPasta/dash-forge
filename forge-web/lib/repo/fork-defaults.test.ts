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
vi.mock('./refs', async (orig) => ({ ...(await orig<typeof import('./refs')>()), readRefs: vi.fn(async () => []) }))

import type { EvoSDK } from '@dashevo/evo-sdk'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { forkRepoV2 } from './fork'

const parent = { forge: { core: 'C' }, repoId: 'P'.repeat(44), ownerId: 'O'.repeat(44), name: 'proj', visibility: 'public' } as unknown as RepoRef
const auth = { identityId: 'M'.repeat(44) } as unknown as WriteAuth
const sdk = {} as EvoSDK

beforeEach(() => {
  created.length = 0
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
})
