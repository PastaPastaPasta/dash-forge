/**
 * A repo with environment snapshots (kind 8): removing, demoting or making a maintainer changes
 * whose snapshots count (D24). `dg` saves the affected environments again first; the web does
 * not yet, so it refuses those changes before anything is written.
 */
import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let envSnapshots: Record<string, unknown>[] = []
const kindsAsked: unknown[] = []
const created: string[] = []

vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    queryAllDocuments: vi.fn(async () => []),
    queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { where?: unknown[][] }) => {
      const kind = q.where?.find((w) => w[0] === 'kind')?.[2]
      kindsAsked.push(kind)
      return { documents: kind === 8 ? envSnapshots : [] }
    }),
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string }) => {
      created.push(p.documentType)
      return { documentId: 'x', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
    deleteDocument: vi.fn(async () => {
      created.push('delete')
      return { confirmed: true }
    }),
  }
})

// A missing consent is read once, not re-read 1.5 s apart.
vi.mock('../view/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../view/retry')>()),
  retryWhileMissing: <T>(read: () => Promise<T | null>) => read(),
}))

import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import type { EncryptionOps } from '../auth/encryption-key'
import { addPrivateMember, removePrivateMember, type PrivateWriteContext } from './private-members'
import { EnvironmentsMembershipError, changeMemberRole, grantMember, revokeMember } from './writes'

const ALICE = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const BOB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const CAROL = '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC'
const FORGE = {
  core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1',
  collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  community: 'E24SPCssqYzFQmjcQ1hNmiLXrzz1o9AqTv54tuWNkgHz',
  group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC',
}
const REPO: RepoRef = { forge: FORGE, repoId: '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z', ownerId: ALICE, name: 'demo', visibility: 'public' }
const sdk = {} as unknown as EvoSDK
const auth: WriteAuth = { identityId: ALICE, network: 'devnet', getSigningKeyWif: () => 'x' }

const snapshot = { $id: 'm1', $ownerId: ALICE, $createdAt: 1, kind: 8, packHash: new Uint8Array(32).fill(7), sizeBytes: 512 }

beforeEach(() => {
  envSnapshots = []
  kindsAsked.length = 0
  created.length = 0
})

describe('maintainer changes in a repo with environments', () => {
  it('refuses removing, demoting or making a maintainer before anything is written', async () => {
    envSnapshots = [snapshot]
    await expect(revokeMember(sdk, auth, REPO, BOB, 'maintainer')).rejects.toThrow(
      'This repo has environments. Remove or demote maintainers with dg for now.',
    )
    await expect(changeMemberRole(sdk, auth, REPO, BOB, 'maintainer', 'writer')).rejects.toBeInstanceOf(EnvironmentsMembershipError)
    await expect(grantMember(sdk, auth, REPO, BOB, 'maintainer')).rejects.toThrow('This repo has environments. Make maintainers with dg for now.')
    await expect(changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'maintainer')).rejects.toBeInstanceOf(EnvironmentsMembershipError)
    expect(kindsAsked).toEqual([8, 8, 8, 8])
    expect(created).toEqual([])
  })

  it('leaves other role changes alone and does not look for environments', async () => {
    envSnapshots = [snapshot]
    for (const attempt of [
      revokeMember(sdk, auth, REPO, BOB, 'writer'),
      changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'reader'),
      grantMember(sdk, auth, REPO, BOB, 'reader'),
    ]) {
      await attempt.catch((e: unknown) => expect(e).not.toBeInstanceOf(EnvironmentsMembershipError))
    }
    expect(kindsAsked).not.toContain(8)
  })

  it('lets a maintainer change through when the repo has no environments', async () => {
    await revokeMember(sdk, auth, REPO, BOB, 'maintainer').catch((e: unknown) => expect(e).not.toBeInstanceOf(EnvironmentsMembershipError))
    expect(kindsAsked).toContain(8)
  })
})

/**
 * A private repo's membership goes through `private-members.ts` alone (`writes.ts` refuses it), so
 * those flows hold the same guard, ahead of the consent check and of any paid re-anchor.
 */
describe('maintainer changes in a private repo with environments', () => {
  const PRIVATE: RepoRef = { ...REPO, visibility: 'private' }
  const c: PrivateWriteContext = { sdk, auth, repo: PRIVATE, network: 'devnet', ops: {} as unknown as EncryptionOps }
  const by = (owner: string, createdAt: number) => ({ ...snapshot, $id: `m-${owner}`, $ownerId: owner, $createdAt: createdAt })

  // The guard refuses on any environment snapshot; these are the two cases it exists for.
  it("refuses promoting a writer whose dormant snapshot is newer than an environment's head", async () => {
    // Bob saved as a writer (it does not count); as a maintainer it would supersede Alice's head.
    envSnapshots = [by(BOB, 2), by(ALICE, 1)]
    await expect(addPrivateMember(c, BOB, 'maintainer', 'members:add')).rejects.toThrow('This repo has environments. Make maintainers with dg for now.')
    expect(kindsAsked).toEqual([8])
    expect(created).toEqual([])
  })

  it("refuses removing the maintainer who wrote an environment's head before anything is re-anchored", async () => {
    envSnapshots = [by(CAROL, 1)]
    await expect(removePrivateMember(c, CAROL, 'maintainer', 'members:remove')).rejects.toBeInstanceOf(EnvironmentsMembershipError)
    expect(kindsAsked).toEqual([8])
    expect(created).toEqual([])
  })

  it('does not look for environments when no maintainer role changes', async () => {
    envSnapshots = [by(ALICE, 1)]
    await addPrivateMember(c, BOB, 'writer', 'members:add').catch((e: unknown) => expect(e).not.toBeInstanceOf(EnvironmentsMembershipError))
    await removePrivateMember(c, BOB, 'writer', 'members:remove').catch((e: unknown) => expect(e).not.toBeInstanceOf(EnvironmentsMembershipError))
    expect(kindsAsked).not.toContain(8)
  })
})
