/**
 * A public repo with members-only content turned on (any sealed `config`, private-repos.md §17):
 * the web refuses its membership changes until it shares and rotates the members key itself
 * (stream 1F-web). Without the guard an add would leave a member with no key and a removal would
 * leave a removed member reading new members-only content.
 */
import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let configs: Record<string, unknown>[] = []
const created: string[] = []

vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => (q.documentTypeName === 'config' ? configs : [])),
    queryDocumentsWithProof: vi.fn(async () => ({ documents: [] })),
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

const plainConfig = { $id: 'c1', $createdAt: 1, defaultBranch: 'main', vis: 'public' }
const membersAnchor = { $id: 'c2', $createdAt: 2, enc: new Uint8Array(85).fill(2), epoch: 0, vis: 'public' }

beforeEach(() => {
  configs = []
  created.length = 0
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

  it('refuses an add, a removal and a role change before anything is written', async () => {
    configs = [plainConfig, membersAnchor]
    await expect(grantMember(sdk, auth, REPO, BOB, 'reader')).rejects.toBeInstanceOf(MembersKeyMembershipError)
    await expect(revokeMember(sdk, auth, REPO, BOB, 'writer')).rejects.toBeInstanceOf(MembersKeyMembershipError)
    await expect(changeMemberRole(sdk, auth, REPO, BOB, 'writer', 'reader')).rejects.toThrow(
      'This repo has members-only content turned on. Change its members with dg for now.',
    )
    expect(created).toEqual([])
  })
})
