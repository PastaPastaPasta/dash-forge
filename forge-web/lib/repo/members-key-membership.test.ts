/**
 * Stream 1F (web): a public repo with members-only content (any sealed `config`, private-repos.md
 * §17) changes its members through the key-aware flows: an add shares the members key, a removal
 * rotates it (a maintainer's epochs re-anchored first), a role change keeps it between roles that
 * hold it. Without this tab's encryption key nothing is written. A public repo without
 * members-only content is a bare document write, as always.
 */
import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let configs: Record<string, unknown>[] = []
let memberships: Record<string, Record<string, unknown>[]> = {}
const created: string[] = []
const flows: string[] = []

vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => (q.documentTypeName === 'config' ? configs : [])),
    queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => ({
      documents: memberships[q.documentTypeName] ?? [],
    })),
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string }) => {
      created.push(p.documentType)
      return { documentId: 'x', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
    deleteDocument: vi.fn(async () => {
      created.push('delete')
      return { confirmed: true }
    }),
    deleteDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string }) => {
      created.push('delete')
      memberships = { ...memberships, [p.documentType]: [] }
      return { deleted: true, actualCredits: null }
    }),
  }
})

vi.mock('../view/retry', () => ({ retryWhileMissing: vi.fn(async (f: () => Promise<unknown>) => f()) }))
vi.mock('./contract-shape', () => ({ contractHasProperty: vi.fn(async () => true) }))

vi.mock('./private-members', () => ({
  addPrivateMember: vi.fn(async (_c: unknown, id: string, role: string) => {
    flows.push(`add:${role}:${id}`)
    return { shared: true }
  }),
  removePrivateMember: vi.fn(async (_c: unknown, id: string, role: string) => {
    flows.push(`remove:${role}:${id}`)
    return 1
  }),
  waitForMembers: vi.fn(async () => {
    flows.push('wait')
    return []
  }),
  holds: () => true,
  runRepair: vi.fn(async () => {
    flows.push('repair')
  }),
  rotateRepoKey: vi.fn(async (_c: unknown, exclude: string[]) => {
    flows.push(`rotate-excluding:${exclude.join(',')}`)
    return 1
  }),
}))

import type { EncryptionOps } from '../auth/encryption-key'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { MembersKeyMembershipError, changeMemberRole, grantMember, hasMembersKey, revokeMember } from './writes'

const ALICE = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const BOB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const FORGE = {
  core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1',
  collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  community: 'E24SPCssqYzFQmjcQ1hNmiLXrzz1o9AqTv54tuWNkgHz',
  group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC',
}
const REPO: RepoRef = { forge: FORGE, repoId: '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z', ownerId: ALICE, name: 'demo', visibility: 'public' }
const sdk = {} as unknown as EvoSDK
const auth: WriteAuth = { identityId: ALICE, network: 'devnet', getSigningKeyWif: () => 'x' }
const ops = { keyId: 4 } as unknown as EncryptionOps

const plainConfig = { $id: 'c1', $createdAt: 1, defaultBranch: 'main', vis: 'public' }
const membersAnchor = { $id: 'c2', $createdAt: 2, enc: new Uint8Array(85).fill(2), epoch: 0, vis: 'public' }

beforeEach(() => {
  configs = []
  memberships = {}
  created.length = 0
  flows.length = 0
})

describe('membership changes of a public repo with members-only content', () => {
  it('a public repo with only plaintext configs has no members key', async () => {
    configs = [plainConfig]
    expect(await hasMembersKey(sdk, REPO)).toBe(false)
  })

  it('any sealed config is a members key, even next to plaintext ones', async () => {
    configs = [plainConfig, membersAnchor]
    expect(await hasMembersKey(sdk, REPO)).toBe(true)
    // the SDK may hand bytes back as a base64 string or a number array
    configs = [{ ...membersAnchor, enc: 'AgAAAA==' }]
    expect(await hasMembersKey(sdk, REPO)).toBe(true)
    configs = [{ ...membersAnchor, enc: [2, 0, 0] }]
    expect(await hasMembersKey(sdk, REPO)).toBe(true)
    configs = [{ ...membersAnchor, enc: [] }]
    expect(await hasMembersKey(sdk, REPO)).toBe(false)
  })

  it('every private repo has one', async () => {
    expect(await hasMembersKey(sdk, { ...REPO, visibility: 'private' })).toBe(true)
  })

  it('without an unlocked encryption key: an add, a removal and a role change are refused before anything is written', async () => {
    configs = [plainConfig, membersAnchor]
    await expect(grantMember(sdk, auth, REPO, BOB, 'reader')).rejects.toBeInstanceOf(MembersKeyMembershipError)
    await expect(revokeMember(sdk, auth, REPO, BOB, 'writer', undefined, null)).rejects.toBeInstanceOf(MembersKeyMembershipError)
    await expect(changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'reader')).rejects.toThrow(/Unlock your encryption key/)
    expect(created).toEqual([])
    expect(flows).toEqual([])
  })

  it('an add shares the key and a removal rotates it (the key-aware flows), never a bare document write', async () => {
    configs = [plainConfig, membersAnchor]
    await grantMember(sdk, auth, REPO, BOB, 'reader', 'i1', ops)
    await revokeMember(sdk, auth, REPO, BOB, 'reader', 'i2', ops)
    expect(flows).toEqual([`add:reader:${BOB}`, `remove:reader:${BOB}`])
    expect(created).toEqual([])
  })

  it('without members-only content a membership change is the bare document write it always was', async () => {
    configs = [plainConfig]
    memberships = {}
    await revokeMember(sdk, auth, REPO, BOB, 'writer', undefined, ops)
    expect(flows).toEqual([])
  })

  it("a maintainer's role change goes through the key-aware removal of the maintainer role, after the new role", async () => {
    configs = [plainConfig, membersAnchor]
    memberships = {
      consent: [{ $id: 'k', $ownerId: BOB }],
      maintainer: [{ $id: 'm', $ownerId: ALICE, memberId: BOB }],
    }
    await changeMemberRole(sdk, auth, REPO, BOB, 'maintainer', 'writer', 'i3', ops)
    // the writer document first (they never stop being a member), then the key-aware removal
    expect(created).toEqual(['writer'])
    // the member list shows the new role before the removal plans its rotation from it
    expect(flows).toEqual(['wait', `remove:maintainer:${BOB}`])
  })

  it('a new maintainer goes through the key-aware add; the writer document they leave is a bare delete (they keep the key)', async () => {
    configs = [plainConfig, membersAnchor]
    memberships = {
      consent: [{ $id: 'k', $ownerId: BOB }],
      writer: [{ $id: 'w', $ownerId: ALICE, memberId: BOB, role: 1 }],
    }
    await changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'maintainer', 'i4', ops)
    expect(flows).toEqual([`add:maintainer:${BOB}`])
    expect(created).toEqual(['delete'])
  })

  it('a change between roles that hold the key keeps it: no rotation, no key flow', async () => {
    configs = [plainConfig, membersAnchor]
    memberships = {
      consent: [{ $id: 'k', $ownerId: BOB }],
      writer: [{ $id: 'w', $ownerId: ALICE, memberId: BOB, role: 1 }],
    }
    await changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'reader', 'i5', ops)
    expect(created).toEqual(['delete', 'writer'])
    expect(flows).toEqual([])
  })
})

describe('a resumed maintainer demotion', () => {
  it('takes a writer document that already stands as granted, then removes the maintainer role', async () => {
    configs = [plainConfig, membersAnchor]
    memberships = {
      consent: [{ $id: 'k', $ownerId: BOB }],
      maintainer: [{ $id: 'm', $ownerId: ALICE, memberId: BOB }],
      writer: [{ $id: 'w', $ownerId: ALICE, memberId: BOB, role: 1 }],
    }
    await changeMemberRole(sdk, auth, REPO, BOB, 'maintainer', 'writer', 'i7', ops)
    // nothing written again for the role that stands; the member list is waited on, then the removal
    expect(created).toEqual([])
    expect(flows).toEqual(['wait', `remove:maintainer:${BOB}`])
  })
})

describe('a failed role change on a repo with members-only content', () => {
  it('rotates the key away from someone left without a role, never silently', async () => {
    configs = [plainConfig, membersAnchor]
    memberships = {
      consent: [{ $id: 'k', $ownerId: BOB }],
      writer: [{ $id: 'w', $ownerId: ALICE, memberId: BOB, role: 1 }],
    }
    const real = await import('../sdk')
    const create = vi.mocked(real.createDocumentIdempotent)
    create.mockImplementationOnce(async () => {
      throw new Error('node dropped the write')
    })
    await expect(changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'reader', 'i6', ops)).rejects.toThrow(/members-only key was changed/)
    expect(flows).toEqual([`rotate-excluding:${BOB}`])
  })
})
