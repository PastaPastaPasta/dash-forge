/**
 * Members-only writes in a public repo (DESIGN §2.4, §3.3, §4.1, D14; stream 1B): who a new
 * document is for (the narrowest of its parents, read from the stored documents, failing
 * closed), the v0x03 seal with `vis: "public"` and `asMember`, the fixed audience of an edit, and
 * no members-only text at rest (drafts, the pending review, the signed-write cache).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Stored documents by `$id`, as the parent lookups read them. */
let stored: Record<string, Record<string, unknown>> = {}
const writes: { documentType: string; data: Record<string, unknown>; intent?: string }[] = []
const replaces: { documentType: string; changes: Record<string, unknown> }[] = []

vi.mock('./role-claim', async (orig) => ({ ...(await orig<typeof import('./role-claim')>()), roleClaim: async () => ({}) }))
vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { where?: [string, string, unknown][] }) => {
      const id = q.where?.find(([f]) => f === '$id')?.[2]
      const doc = typeof id === 'string' ? stored[id] : undefined
      return { documents: doc === undefined ? [] : [doc] }
    }),
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string; data: Record<string, unknown>; intent?: string }) => {
      writes.push({ documentType: p.documentType, data: p.data, ...(p.intent ? { intent: p.intent } : {}) })
      return { documentId: '8rSFEyS7gidGdS4r8m22YtMEc519otpDNQ242Zw9c1Gb', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
    precheckEdit: vi.fn(async () => undefined),
    replaceDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string; changes: Record<string, unknown> }) => {
      replaces.push({ documentType: p.documentType, changes: p.changes })
      return { documentId: 'x', revision: 2n, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
  }
})

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { idbEntries, resetMemoryStores } from '../idb'
import { EpochKeys, type OpenContext } from '../private'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { LongBodyRefusedError, longBodyField } from './long-body'
import { MEMBERS_TEXT_LIMIT, audienceFor, childAudience, sealMembersContent, targetAudience } from './members-writes'
import { admitAll, laneGate } from './private-content'
import { SEALED_TEXT_LIMIT } from './private-writes'
import { saveReviewDraft, loadReviewDraft, updateComment, type ReviewDraft } from './review-writes'
import { assertNoPlaintext, writeRepoDoc } from './writes'
import { commentDraftKey } from '../view/draft-text'
import { newReviewDraft } from '../view/pending-review'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const REPO_ID = id(0x31)
const BOB = id(0x42)
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO: RepoRef = { forge: FORGE, repoId: b58(REPO_ID), ownerId: b58(id(0x41)), name: 'mixed', visibility: 'public' }
const sdk = {} as unknown as EvoSDK
const auth: WriteAuth = { identityId: b58(BOB), network: 'devnet', getSigningKeyWif: () => 'x' }
const K0 = Uint8Array.from({ length: 32 }, (_, i) => 0x60 + i)

const ISSUE_PUBLIC = b58(id(0x51))
const ISSUE_MEMBERS = b58(id(0x52))
const ROOT_PUBLIC = b58(id(0x61))
const REPLY_MEMBERS = b58(id(0x62))
const SEALED = Uint8Array.from([0x03, ...new Uint8Array(60)])

beforeEach(() => {
  writes.length = 0
  replaces.length = 0
  resetMemoryStores()
  stored = {
    [ISSUE_PUBLIC]: { $id: ISSUE_PUBLIC, repoId: REPO.repoId, title: 'public' },
    [ISSUE_MEMBERS]: { $id: ISSUE_MEMBERS, repoId: REPO.repoId, enc: SEALED, epoch: 0 },
    [ROOT_PUBLIC]: { $id: ROOT_PUBLIC, repoId: REPO.repoId, body: 'root' },
    [REPLY_MEMBERS]: { $id: REPLY_MEMBERS, repoId: REPO.repoId, enc: SEALED, epoch: 0, replyTo: decodeIdentifier(ROOT_PUBLIC) },
  }
})

describe('who a new document is for', () => {
  it('a comment follows its target; a reply the narrowest of target, replied-to comment and root', async () => {
    expect(await childAudience(sdk, REPO, { targetId: ISSUE_PUBLIC })).toBe('public')
    expect(await childAudience(sdk, REPO, { targetId: ISSUE_MEMBERS })).toBe('members')
    expect(await childAudience(sdk, REPO, { targetId: ISSUE_PUBLIC, replyTo: ROOT_PUBLIC })).toBe('public')
    // a reply to a members-only reply under a public root, on a public issue, is members-only
    expect(await childAudience(sdk, REPO, { targetId: ISSUE_PUBLIC, replyTo: REPLY_MEMBERS })).toBe('members')
    // narrower on request
    expect(await childAudience(sdk, REPO, { targetId: ISSUE_PUBLIC, requested: 'members' })).toBe('members')
  })

  it('refuses a public child of a members-only parent, and specific people for now', async () => {
    await expect(childAudience(sdk, REPO, { targetId: ISSUE_MEMBERS, requested: 'public' })).rejects.toThrow(/can't be public/)
    await expect(childAudience(sdk, REPO, { targetId: ISSUE_PUBLIC, replyTo: REPLY_MEMBERS, requested: 'public' })).rejects.toThrow(/can't be public/)
    expect(() => audienceFor(REPO, 'specificPeople', null)).toThrow(/specific people/)
  })

  it('fails closed: a parent that cannot be read is an error, never public', async () => {
    await expect(targetAudience(sdk, REPO, b58(id(0x99)))).rejects.toThrow(/could not be read/)
    await expect(childAudience(sdk, REPO, { targetId: ISSUE_PUBLIC, replyTo: b58(id(0x98)) })).rejects.toThrow(/could not be read/)
    // another repo's document is not this thread's
    stored[b58(id(0x97))] = { $id: b58(id(0x97)), repoId: b58(id(0x01)), title: 'elsewhere' }
    await expect(targetAudience(sdk, REPO, b58(id(0x97)))).rejects.toThrow(/could not be read/)
  })

  it('a private repo is members-only whatever is asked', async () => {
    const priv: RepoRef = { ...REPO, visibility: 'private' }
    expect(await childAudience(sdk, priv, { targetId: ISSUE_PUBLIC })).toBe('members')
    expect(() => audienceFor(priv, 'public', null)).toThrow(/private/)
  })
})

describe('the members-only seal', () => {
  const ctx = async (): Promise<OpenContext> => ({
    keys: new Map([[0, await EpochKeys.import(REPO_ID, 0, new Uint8Array(K0))]]),
    anchors: new Map([[0, { id: id(0x71), height: 10, statedHeight: 10 }]]),
    members: { has: () => true },
  })

  it('writes enc v0x03, epoch and asMember, no content field, and opens for a member', async () => {
    const writer = { keys: await EpochKeys.import(REPO_ID, 0, new Uint8Array(K0)) }
    await writeRepoDoc(sdk, auth, REPO, 'comment', { targetId: decodeIdentifier(ISSUE_MEMBERS), body: 'MEMBERS-TEXT' }, 'i1', undefined, undefined, {
      audience: 'members',
      membersWriter: writer,
    })
    const [w] = writes
    expect(w?.documentType).toBe('comment')
    const data = w!.data
    expect(data['body']).toBeUndefined()
    expect((data['enc'] as Uint8Array)[0]).toBe(0x03)
    expect(data['epoch']).toBe(0)
    expect(data['vis']).toBe('public')
    expect(base58Encode(data['asMember'] as Uint8Array)).toBe(auth.identityId)
    // the intent names the key: a retry after a rotation signs afresh
    expect(w!.intent).toMatch(/^i1:e0:/)
    // nothing of the text is in what is signed (and so in the signed-write cache)
    expect(JSON.stringify(data, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v))).not.toContain('MEMBERS-TEXT')
    // a member reads it back through their members-key session
    const doc = { ...data, $id: b58(id(0x81)), $ownerId: auth.identityId, $createdAt: 5, $createdAtBlockHeight: 20, targetId: ISSUE_MEMBERS }
    const { docs } = await admitAll(laneGate(REPO, await ctx()), 'comment', [doc])
    expect(docs[0]?.['body']).toBe('MEMBERS-TEXT')
  })

  it('an event value follows its members-only target, read from the stored document', async () => {
    const writer = { keys: await EpochKeys.import(REPO_ID, 0, new Uint8Array(K0)) }
    await writeRepoDoc(sdk, auth, REPO, 'event', { targetId: decodeIdentifier(ISSUE_MEMBERS), targetNumber: 3, kind: 1, value: 'secret-label' }, 'i2', undefined, undefined, { membersWriter: writer })
    expect(writes[0]?.data['value']).toBeUndefined()
    expect((writes[0]?.data['enc'] as Uint8Array)[0]).toBe(0x03)
    // an event carries no asMember (its gate is the member event type)
    expect(writes[0]?.data['asMember']).toBeUndefined()
    // a public target's event value stays plaintext
    await writeRepoDoc(sdk, auth, REPO, 'event', { targetId: decodeIdentifier(ISSUE_PUBLIC), targetNumber: 1, kind: 1, value: 'bug' }, 'i3')
    expect(writes[1]?.data['value']).toBe('bug')
  })

  it('caps members-only text 32 bytes under a private repo’s, and refuses a members-only long body (never stored in plaintext)', async () => {
    for (const k of ['issue', 'patch', 'comment', 'review'] as const) expect(MEMBERS_TEXT_LIMIT[k]).toBe(SEALED_TEXT_LIMIT[k] - 32)
    const writer = { keys: await EpochKeys.import(REPO_ID, 0, new Uint8Array(K0)) }
    await expect(sealMembersContent(auth, 'comment', { targetId: decodeIdentifier(ISSUE_PUBLIC), body: 'x'.repeat(5054) }, writer)).rejects.toThrow(/at most 5053/)
    await expect(longBodyField(sdk, auth, REPO, 'comment', 'y'.repeat(6000), {}, undefined, 'members')).rejects.toBeInstanceOf(LongBodyRefusedError)
    expect(writes).toEqual([])
  })

  it('a members-only pull request or ref update is not written in this release', async () => {
    const writer = { keys: await EpochKeys.import(REPO_ID, 0, new Uint8Array(K0)) }
    await expect(sealMembersContent(auth, 'patch', { title: 't', number: 1 }, writer)).rejects.toThrow(/not supported yet/)
  })

  it('a public repo’s sealed write never carries plaintext content beside enc', () => {
    expect(() => assertNoPlaintext(REPO, 'comment', { enc: SEALED, body: 'leak' })).toThrow(/plaintext to members-only content/)
    expect(() => assertNoPlaintext(REPO, 'comment', { body: 'fine' })).not.toThrow()
    expect(() => assertNoPlaintext(REPO, 'comment', { body: 'x' }, true)).toThrow()
  })
})

describe('an edit keeps the audience it was written with (DESIGN §2.4)', () => {
  it('a members-only comment is never replaced with plaintext: without a seal context it is refused', async () => {
    const cid = b58(id(0x91))
    stored[cid] = { $id: cid, repoId: REPO.repoId, enc: SEALED, epoch: 0, targetId: decodeIdentifier(ISSUE_MEMBERS) }
    await expect(updateComment(sdk, auth, REPO, { id: cid, body: 'now public', expectedRevision: 1n })).rejects.toThrow(/members-only, and an edit keeps who can read it/)
    expect(replaces).toEqual([])
  })

  it('a public comment stays public', async () => {
    const cid = b58(id(0x92))
    stored[cid] = { $id: cid, repoId: REPO.repoId, body: 'old', targetId: decodeIdentifier(ISSUE_PUBLIC) }
    await updateComment(sdk, auth, REPO, { id: cid, body: 'new' })
    expect(replaces[0]?.changes['body']).toBe('new')
    expect(replaces[0]?.changes['enc']).toBeUndefined()
  })
})

describe('no members-only text at rest', () => {
  it('a members-only composer keeps no draft in this browser', () => {
    expect(commentDraftKey(REPO, ISSUE_PUBLIC, auth.identityId)).not.toBeNull()
    expect(commentDraftKey(REPO, ISSUE_MEMBERS, auth.identityId, 'members')).toBeNull()
    expect(commentDraftKey({ ...REPO, visibility: 'private' }, ISSUE_PUBLIC, auth.identityId)).toBeNull()
  })

  it('a members-only pending review lives in memory only: IndexedDB holds nothing of it', async () => {
    const draft: ReviewDraft = {
      ...newReviewDraft({ draftId: 'd1', network: 'devnet', identity: auth.identityId, repoId: REPO.repoId, prId: ISSUE_PUBLIC, headOid: 'ab'.repeat(20), private: false, membersOnly: true, now: 1 }),
      summary: 'MEMBERS-REVIEW-TEXT',
    }
    expect(draft.audience).toBe('members')
    await saveReviewDraft(draft, REPO)
    expect(JSON.stringify(await idbEntries('journal'))).not.toContain('MEMBERS-REVIEW-TEXT')
    expect((await loadReviewDraft('devnet', auth.identityId, ISSUE_PUBLIC))?.summary).toBe('MEMBERS-REVIEW-TEXT')
    // a public review's draft still survives a reload (IndexedDB)
    const pub = newReviewDraft({ draftId: 'd2', network: 'devnet', identity: auth.identityId, repoId: REPO.repoId, prId: ISSUE_MEMBERS, headOid: 'ab'.repeat(20), private: false, now: 1 })
    await saveReviewDraft(pub, REPO)
    expect((await idbEntries('journal')).length).toBe(1)
  })
})
