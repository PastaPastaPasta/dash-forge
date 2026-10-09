/**
 * An author makes their own members-only post public (DESIGN §4.6, §2.4; stream R5): the one
 * audience change allowed before mainnet is the author's replace that drops `enc` and `epoch` and
 * sets the plaintext; everything else is refused before anything is signed.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let stored: Record<string, Record<string, unknown>> = {}
const writes: { documentType: string; data: Record<string, unknown> }[] = []
const replaces: { documentType: string; changes: Record<string, unknown> }[] = []
let configs: Record<string, unknown>[] = []

vi.mock('../view/retry', () => ({ retryWhileMissing: vi.fn(async (f: () => Promise<unknown>) => f()) }))
vi.mock('./members', async (orig) => ({
  ...(await orig<typeof import('./members')>()),
  readRoleOracle: async () => ({ currentRole: () => 'maintainer' }),
}))
vi.mock('./role-claim', async (orig) => ({ ...(await orig<typeof import('./role-claim')>()), roleClaim: async () => ({}) }))
vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => (q.documentTypeName === 'config' ? configs : [])),
    queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { where?: [string, string, unknown][] }) => {
      const id = q.where?.find(([f]) => f === '$id')?.[2]
      const doc = typeof id === 'string' ? stored[id] : undefined
      return { documents: doc === undefined ? [] : [doc] }
    }),
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string; data: Record<string, unknown> }) => {
      writes.push({ documentType: p.documentType, data: p.data })
      return { documentId: '8rSFEyS7gidGdS4r8m22YtMEc519otpDNQ242Zw9c1Gb', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
    precheckEdit: vi.fn(async () => undefined),
    replaceDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string; changes: Record<string, unknown> }) => {
      replaces.push({ documentType: p.documentType, changes: p.changes })
      return { documentId: 'x', revision: 2n, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
  }
})

import { base58Encode } from '../auth/base58'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { makePostPublic, makeReviewTextPublic, provenanceOf } from './make-public-writes'
import { childAudience, forgetStoredDoc } from './members-writes'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const BOB = b58(id(0x42))
const ALICE = b58(id(0x43))
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO: RepoRef = { forge: FORGE, repoId: b58(id(0x31)), ownerId: b58(id(0x41)), name: 'mixed', visibility: 'public' }
const sdk = {} as unknown as EvoSDK
const auth: WriteAuth = { identityId: BOB, network: 'devnet', getSigningKeyWif: () => 'x' }
const SEALED = Uint8Array.from([0x03, ...new Uint8Array(60)])
const LETTER = Uint8Array.from([0x04, ...new Uint8Array(160)])
const SEALED_CONFIG = Uint8Array.from([0x02, ...new Uint8Array(84)])

const ISSUE_PUBLIC = b58(id(0x51))
const ISSUE_MEMBERS = b58(id(0x52))
const MINE = b58(id(0x61))
const THEIRS = b58(id(0x62))
const ON_MEMBERS_ISSUE = b58(id(0x63))
const MY_ISSUE = b58(id(0x64))
const PR = b58(id(0x70))
const MY_REVIEW = b58(id(0x71))
const THEIR_REVIEW = b58(id(0x72))
const MY_PUBLIC = b58(id(0x65))
const MY_LETTER = b58(id(0x66))

beforeEach(() => {
  configs = [{ $id: 'c1', defaultBranch: 'main' }, { $id: 'c2', enc: SEALED_CONFIG, epoch: 0 }]
  writes.length = 0
  replaces.length = 0
  const sealed = (owner: string, extra: Record<string, unknown> = {}) => ({ repoId: REPO.repoId, $ownerId: owner, enc: SEALED, epoch: 0, asMember: owner, ...extra })
  stored = {
    [ISSUE_PUBLIC]: { $id: ISSUE_PUBLIC, repoId: REPO.repoId, $ownerId: ALICE, title: 'public' },
    [ISSUE_MEMBERS]: { $id: ISSUE_MEMBERS, ...sealed(ALICE) },
    [MINE]: { $id: MINE, ...sealed(BOB, { targetId: ISSUE_PUBLIC }) },
    [THEIRS]: { $id: THEIRS, ...sealed(ALICE, { targetId: ISSUE_PUBLIC }) },
    [ON_MEMBERS_ISSUE]: { $id: ON_MEMBERS_ISSUE, ...sealed(BOB, { targetId: ISSUE_MEMBERS }) },
    [MY_ISSUE]: { $id: MY_ISSUE, ...sealed(BOB, { number: 3 }) },
    [PR]: { $id: PR, repoId: REPO.repoId, $ownerId: ALICE, title: 'a public PR' },
    [MY_REVIEW]: { $id: MY_REVIEW, ...sealed(BOB, { patchId: PR, verdict: 3 }) },
    [THEIR_REVIEW]: { $id: THEIR_REVIEW, ...sealed(ALICE, { patchId: PR, verdict: 3 }) },
    [MY_PUBLIC]: { $id: MY_PUBLIC, repoId: REPO.repoId, $ownerId: BOB, body: 'public', targetId: ISSUE_PUBLIC },
    [MY_LETTER]: { $id: MY_LETTER, ...sealed(BOB, { targetId: ISSUE_PUBLIC, enc: LETTER }) },
  }
})

describe('the author makes their own members-only post public', () => {
  it('a comment: the body set in plaintext, enc and epoch removed, in one replace', async () => {
    await makePostPublic(sdk, auth, REPO, { type: 'comment', id: MINE, opened: { body: 'We rotated the key.' }, expectedRevision: 1n })
    expect(replaces).toHaveLength(1)
    const c = replaces[0]?.changes ?? {}
    expect(c['body']).toBe('We rotated the key.')
    expect('enc' in c && c['enc'] === undefined).toBe(true)
    expect('epoch' in c && c['epoch'] === undefined).toBe(true)
    // the membership proof stays (it is re-checked) unless the author is no longer a member
    expect('asMember' in c).toBe(false)
    // a public reply to it is possible now, in this tab too (its sealed copy is forgotten)
    stored[MINE] = { $id: MINE, repoId: REPO.repoId, $ownerId: BOB, body: 'We rotated the key.', targetId: ISSUE_PUBLIC }
    expect(await childAudience(sdk, REPO, { targetId: ISSUE_PUBLIC, replyTo: MINE, requested: 'public' })).toBe('public')
    forgetStoredDoc(REPO, 'comment', MINE)
  })

  it('a Read-role reviewer may make their review’s text public: it is a comment, not a verdict', async () => {
    await makeReviewTextPublic(sdk, auth, REPO, { reviewId: MY_REVIEW, patchId: PR, text: 'From a reader.', post: { isMember: true, locked: false, role: 'reader' } })
    expect(writes).toHaveLength(1)
    expect(writes[0]?.documentType).toBe('comment')
    expect(writes[0]?.data['verdict']).toBeUndefined()
  })

  it('a review on a locked PR: the member’s attached comment carries the proof', async () => {
    await makeReviewTextPublic(sdk, auth, REPO, { reviewId: MY_REVIEW, patchId: PR, text: 'Locked, still public.', post: { isMember: true, locked: true } })
    expect(writes[0]?.data['asMember']).toBeDefined()
  })

  it('an issue: its title and body; and a former member drops the proof', async () => {
    await makePostPublic(sdk, auth, REPO, { type: 'issue', id: MY_ISSUE, opened: { title: 'Rotate', body: 'Done.' }, dropProof: true })
    expect(replaces[0]?.changes).toMatchObject({ title: 'Rotate', body: 'Done.' })
    expect('asMember' in (replaces[0]?.changes ?? {})).toBe(true)
  })

  it('an inline comment keeps no file name: path is immutable on this network', async () => {
    await makePostPublic(sdk, auth, REPO, { type: 'comment', id: MINE, opened: { body: 'nit', path: 'src/lib.rs' } })
    expect(replaces[0]?.changes['path']).toBeUndefined()
    expect('path' in (replaces[0]?.changes ?? {})).toBe(false)
  })

  it('a letter may be made public by its author too', async () => {
    await makePostPublic(sdk, auth, REPO, { type: 'comment', id: MY_LETTER, opened: { body: 'for everyone' } })
    expect(replaces).toHaveLength(1)
  })

  it('a review: a public comment attached to it, with no anchor', async () => {
    await makeReviewTextPublic(sdk, auth, REPO, { reviewId: MY_REVIEW, patchId: PR, text: 'Blocking: the token is logged.' })
    expect(writes).toHaveLength(1)
    expect(writes[0]?.documentType).toBe('comment')
    const data = writes[0]?.data ?? {}
    expect(data['body']).toBe('Blocking: the token is logged.')
    expect(data['enc']).toBeUndefined()
    expect(base58Encode(data['reviewId'] as Uint8Array)).toBe(MY_REVIEW)
    expect(data['path']).toBeUndefined()
    expect(data['line']).toBeUndefined()
  })
})

describe('every other audience change is refused before signing', () => {
  it("someone else's post", async () => {
    await expect(makePostPublic(sdk, auth, REPO, { type: 'comment', id: THEIRS, opened: { body: 'x' } })).rejects.toThrow(/Only its author can make this post public/)
    await expect(makeReviewTextPublic(sdk, auth, REPO, { reviewId: THEIR_REVIEW, patchId: PR, text: 'x' })).rejects.toThrow(/Only its author/)
    expect(replaces).toEqual([])
    expect(writes).toEqual([])
  })

  it('a public post, a private repo, an imported post, a members-only conversation', async () => {
    await expect(makePostPublic(sdk, auth, REPO, { type: 'comment', id: MY_PUBLIC, opened: { body: 'x' } })).rejects.toThrow(/already public/)
    await expect(makePostPublic(sdk, auth, { ...REPO, visibility: 'private' }, { type: 'comment', id: MINE, opened: { body: 'x' } })).rejects.toThrow(/private/)
    await expect(makePostPublic(sdk, auth, REPO, { type: 'issue', id: MY_ISSUE, opened: { title: 't', importedAuthor: 'octocat' } })).rejects.toThrow(/imported/)
    await expect(makePostPublic(sdk, auth, REPO, { type: 'comment', id: ON_MEMBERS_ISSUE, opened: { body: 'x' } })).rejects.toThrow(/conversation is members-only/)
    await expect(makePostPublic(sdk, auth, REPO, { type: 'patch', id: PR, opened: { title: 't' } })).rejects.toThrow(/pull request can't be made public/)
    await expect(makeReviewTextPublic(sdk, auth, REPO, { reviewId: MY_REVIEW, patchId: ISSUE_PUBLIC, text: 'x' })).rejects.toThrow(/not on this pull request/)
    expect(replaces).toEqual([])
  })

  it('an empty text has nothing to publish', async () => {
    await expect(makePostPublic(sdk, auth, REPO, { type: 'comment', id: MINE, opened: { body: '  ' } })).rejects.toThrow(/no text/)
    await expect(makeReviewTextPublic(sdk, auth, REPO, { reviewId: MY_REVIEW, patchId: PR, text: ' ' })).rejects.toThrow(/no text/)
  })
})

describe('provenanceOf', () => {
  it('reads an imported post’s author and URL, and nothing else', () => {
    expect(provenanceOf(null)).toEqual({})
    expect(provenanceOf({ author: 'octo', url: 'https://x', createdAt: 1 })).toEqual({ importedAuthor: 'octo', importedUrl: 'https://x' })
    expect(provenanceOf({ createdAt: 1 })).toEqual({})
  })
})
