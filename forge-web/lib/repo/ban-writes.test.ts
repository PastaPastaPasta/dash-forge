/**
 * A banned identity's writes are refused before signing (UPDATE-1 `ban`, parity with `dg`'s E610):
 * issue, PR, comment and review creates, including the inline comments, thread replies and
 * suggestions written through `postComment`, and the bans are read fresh at write time.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const BOB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const ALICE = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const PR = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'

/** The ban documents the chain holds now; `banReads` counts the reads of them. */
let banDocs: Record<string, unknown>[] = []
let banReads = 0
const created: string[] = []

vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => {
      if (q.documentTypeName !== 'ban') return []
      banReads += 1
      return banDocs
    }),
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _auth: unknown, p: { documentType: string }) => {
      created.push(p.documentType)
      return { documentId: PR, confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
  }
})
vi.mock('./members', async (orig) => ({ ...(await orig<typeof import('./members')>()), readMembershipsCached: async () => [] }))
vi.mock('./role-claim', async (orig) => ({ ...(await orig<typeof import('./role-claim')>()), roleClaim: async () => ({}) }))
vi.mock('./members-writes', async (orig) => ({
  ...(await orig<typeof import('./members-writes')>()),
  targetAudience: async () => 'public',
  childAudience: async () => 'public',
  storedAudience: async () => ({ audience: 'public', doc: {} }),
  repoHasMembersKey: async () => false,
}))

import { resetMemoryStores } from '../idb'
import type { WriteAuth } from '../sdk'
import { BannedError, readBans, refuseIfBanned, resetBans } from './bans'
import type { RepoRef } from './contract'
import { postComment } from './review-writes'

const REPO: RepoRef = {
  forge: { core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1', collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS', community: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS', group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC' },
  repoId: '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z',
  ownerId: ALICE,
  name: 'demo',
  visibility: 'public',
}
const sdk = {} as EvoSDK
const auth = (identityId: string): WriteAuth => ({ identityId, network: 'devnet', getSigningKeyWif: () => 'x' })
/** The owner's ban of Bob, as the chain returns it. */
const BAN_OF_BOB = { $id: 'ban1', $ownerId: ALICE, $createdAt: 5, identityId: BOB, reason: 1 }

beforeEach(() => {
  banDocs = []
  banReads = 0
  created.length = 0
  resetBans()
  resetMemoryStores()
})

describe('inline comments, replies and suggestions by a banned identity', () => {
  it('refuses postComment before signing, as dg refuses the same', async () => {
    banDocs = [BAN_OF_BOB]
    await expect(postComment(sdk, auth(BOB), REPO, { targetId: PR, body: 'inline', anchor: { path: 'a.rs', line: 3, side: 1 } })).rejects.toBeInstanceOf(BannedError)
    await expect(postComment(sdk, auth(BOB), REPO, { targetId: PR, body: 'reply', replyTo: PR })).rejects.toBeInstanceOf(BannedError)
    expect(created).toEqual([])
  })

  it('lets a writer who is not banned post', async () => {
    banDocs = [BAN_OF_BOB]
    await postComment(sdk, auth(ALICE), REPO, { targetId: PR, body: 'fine' })
    expect(created).toEqual(['comment'])
  })
})

describe('bans are read fresh when something is about to be signed', () => {
  it('refuses at once after a ban, though the page read the bans a moment ago', async () => {
    expect(await readBans(sdk, REPO)).toEqual([])
    banDocs = [BAN_OF_BOB]
    await expect(refuseIfBanned(sdk, REPO, 'devnet', BOB)).rejects.toBeInstanceOf(BannedError)
  })

  it('allows at once after a lift, though the page read the ban a moment ago', async () => {
    banDocs = [BAN_OF_BOB]
    expect((await readBans(sdk, REPO)).length).toBe(1)
    banDocs = []
    await expect(refuseIfBanned(sdk, REPO, 'devnet', BOB)).resolves.toBeUndefined()
  })

  it('costs one read per write, and none on a page load', async () => {
    await readBans(sdk, REPO)
    await readBans(sdk, REPO)
    expect(banReads).toBe(1)
    await refuseIfBanned(sdk, REPO, 'devnet', BOB)
    expect(banReads).toBe(2)
  })
})
