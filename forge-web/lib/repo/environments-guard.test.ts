/**
 * A repo with environment snapshots (kind 8): every environment is a letter to the people its
 * audience covered when it was saved, so any member change (add, remove, promote, demote) leaves
 * one saved for the wrong people. The web plans those saves and makes them around the change
 * (`lib/env/member-change.ts`); a change made without that plan is refused before anything is
 * written, and one made with it does not look again.
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

const MESSAGE = 'This repo has environments: a member change saves them again for the people they cover, so it has to be planned with them first. Nothing was changed.'

describe('member changes in a repo with environments', () => {
  it('refuses every grant, revoke and role change before anything is written', async () => {
    envSnapshots = [snapshot]
    const attempts = [
      revokeMember(sdk, auth, REPO, BOB, 'maintainer'),
      revokeMember(sdk, auth, REPO, BOB, 'writer'),
      revokeMember(sdk, auth, REPO, BOB, 'reader'),
      grantMember(sdk, auth, REPO, BOB, 'maintainer'),
      grantMember(sdk, auth, REPO, BOB, 'writer'),
      grantMember(sdk, auth, REPO, BOB, 'triage'),
      changeMemberRole(sdk, auth, REPO, BOB, 'maintainer', 'writer'),
      changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'maintainer'),
      changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'reader'),
      changeMemberRole(sdk, auth, REPO, BOB, 'reader', 'triage'),
    ]
    for (const a of attempts) {
      await expect(a).rejects.toBeInstanceOf(EnvironmentsMembershipError)
      await expect(a).rejects.toThrow(MESSAGE)
    }
    expect(kindsAsked).toEqual(Array(attempts.length).fill(8))
    expect(created).toEqual([])
  })

  it('lets a planned change through without looking again', async () => {
    envSnapshots = [snapshot]
    for (const attempt of [
      revokeMember(sdk, auth, REPO, BOB, 'writer', undefined, undefined, true),
      grantMember(sdk, auth, REPO, BOB, 'reader', undefined, undefined, true),
      changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'reader', undefined, undefined, true),
    ]) {
      await attempt.catch((e: unknown) => expect(e).not.toBeInstanceOf(EnvironmentsMembershipError))
    }
    expect(kindsAsked.filter((k) => k === 8)).toHaveLength(0)
  })

  it('lets a change through when the repo has no environments', async () => {
    for (const attempt of [
      revokeMember(sdk, auth, REPO, BOB, 'maintainer'),
      revokeMember(sdk, auth, REPO, BOB, 'writer'),
      grantMember(sdk, auth, REPO, BOB, 'reader'),
      changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'reader'),
    ]) {
      await attempt.catch((e: unknown) => expect(e).not.toBeInstanceOf(EnvironmentsMembershipError))
    }
    // each change looked for environments once, then went on to its own reads
    expect(kindsAsked.filter((k) => k === 8)).toHaveLength(4)
  })
})

/**
 * A private repo's membership goes through `private-members.ts` alone (`writes.ts` refuses it), so
 * those flows hold the same guard, ahead of the consent check and of any paid re-anchor.
 */
describe('member changes in a private repo with environments', () => {
  const PRIVATE: RepoRef = { ...REPO, visibility: 'private' }
  const c: PrivateWriteContext = { sdk, auth, repo: PRIVATE, network: 'devnet', ops: {} as unknown as EncryptionOps }
  const by = (owner: string, createdAt: number) => ({ ...snapshot, $id: `m-${owner}`, $ownerId: owner, $createdAt: createdAt })

  it("refuses promoting a writer whose dormant snapshot is newer than an environment's head", async () => {
    // Bob saved as a writer (it does not count); as a maintainer it would supersede Alice's head.
    envSnapshots = [by(BOB, 2), by(ALICE, 1)]
    await expect(addPrivateMember(c, BOB, 'maintainer', 'members:add')).rejects.toThrow(MESSAGE)
    expect(kindsAsked).toEqual([8])
    expect(created).toEqual([])
  })

  it("refuses removing the maintainer who wrote an environment's head before anything is re-anchored", async () => {
    envSnapshots = [by(CAROL, 1)]
    await expect(removePrivateMember(c, CAROL, 'maintainer', 'members:remove')).rejects.toBeInstanceOf(EnvironmentsMembershipError)
    expect(kindsAsked).toEqual([8])
    expect(created).toEqual([])
  })

  it('lets a planned add or removal through without looking again', async () => {
    envSnapshots = [by(ALICE, 1)]
    const planned: PrivateWriteContext = { ...c, environmentsPlanned: true }
    await addPrivateMember(planned, BOB, 'writer', 'members:add').catch((e: unknown) => expect(e).not.toBeInstanceOf(EnvironmentsMembershipError))
    await removePrivateMember(planned, BOB, 'writer', 'members:remove').catch((e: unknown) => expect(e).not.toBeInstanceOf(EnvironmentsMembershipError))
    expect(kindsAsked.filter((k) => k === 8)).toHaveLength(0)
  })

  it('refuses adding or removing any other role too', async () => {
    envSnapshots = [by(ALICE, 1)]
    await expect(addPrivateMember(c, BOB, 'writer', 'members:add')).rejects.toBeInstanceOf(EnvironmentsMembershipError)
    await expect(addPrivateMember(c, BOB, 'reader', 'members:add')).rejects.toBeInstanceOf(EnvironmentsMembershipError)
    await expect(removePrivateMember(c, BOB, 'writer', 'members:remove')).rejects.toBeInstanceOf(EnvironmentsMembershipError)
    await expect(removePrivateMember(c, BOB, 'triage', 'members:remove')).rejects.toBeInstanceOf(EnvironmentsMembershipError)
    expect(kindsAsked).toEqual([8, 8, 8, 8])
    expect(created).toEqual([])
  })
})
