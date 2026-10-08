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
const writes: { documentType: string; data: Record<string, unknown>; intent?: string; contentKey?: string }[] = []
/** Documents the queries answer by type (comments for `readComments`). */
let byType: Record<string, Record<string, unknown>[]> = {}
/** Artifacts stored (a long body): must stay empty for members-only text. */
const artifacts: string[] = []
const replaces: { documentType: string; changes: Record<string, unknown> }[] = []

// Lag retries happen once here (no real time in tests).
vi.mock('../view/retry', () => ({ retryWhileMissing: vi.fn(async (f: () => Promise<unknown>) => f()) }))
/** The repo's configs: a members-key anchor beside the plaintext one (members-only content is on). */
let configs: Record<string, unknown>[] = []
let reads = 0
vi.mock('../storage/upload', async (orig) => ({
  ...(await orig<typeof import('../storage/upload')>()),
  storeArtifact: vi.fn(async () => {
    artifacts.push('stored')
    throw new Error('a test stores no artifact')
  }),
}))
// The signer may record artifacts (a maintainer): the long-body checks get past the role check.
vi.mock('./members', async (orig) => ({
  ...(await orig<typeof import('./members')>()),
  readRoleOracle: async () => ({ currentRole: () => 'maintainer' }),
}))
vi.mock('./role-claim', async (orig) => ({ ...(await orig<typeof import('./role-claim')>()), roleClaim: async () => ({}) }))
vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => {
      reads += 1
      return q.documentTypeName === 'config' ? configs : byType[q.documentTypeName] ?? []
    }),
    queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { where?: [string, string, unknown][] }) => {
      reads += 1
      const id = q.where?.find(([f]) => f === '$id')?.[2]
      const doc = typeof id === 'string' ? stored[id] : undefined
      return { documents: doc === undefined ? [] : [doc] }
    }),
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string; data: Record<string, unknown>; intent?: string; contentKey?: string }) => {
      writes.push({ documentType: p.documentType, data: p.data, ...(p.intent ? { intent: p.intent } : {}), ...(p.contentKey ? { contentKey: p.contentKey } : {}) })
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
import { postComment, updateTarget } from './review-writes'
import { contentHash } from '../sdk'
import { readComments } from '../view/issues-view'
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
const SEALED_CONFIG = Uint8Array.from([0x02, ...new Uint8Array(84)])

beforeEach(() => {
  configs = [{ $id: 'c1', defaultBranch: 'main' }, { $id: 'c2', enc: SEALED_CONFIG, epoch: 0 }]
  reads = 0
  byType = {}
  artifacts.length = 0
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

  it('a repository made public: a thread written while it was private stays the default but binds nothing (§18.1)', async () => {
    const OLD_ISSUE = b58(id(0x53))
    const OLD_REPLY = b58(id(0x63))
    const NEW_REPLY = b58(id(0x64))
    stored[OLD_ISSUE] = { $id: OLD_ISSUE, repoId: REPO.repoId, enc: Uint8Array.from([0x01, ...new Uint8Array(40)]), epoch: 0, vis: 'private' }
    stored[OLD_REPLY] = { $id: OLD_REPLY, repoId: REPO.repoId, enc: Uint8Array.from([0x01, ...new Uint8Array(40)]), epoch: 0, vis: 'private' }
    stored[NEW_REPLY] = { $id: NEW_REPLY, repoId: REPO.repoId, enc: SEALED, epoch: 1, vis: 'public', replyTo: decodeIdentifier(OLD_REPLY) }
    expect(await childAudience(sdk, REPO, { targetId: OLD_ISSUE })).toBe('members')
    expect(await childAudience(sdk, REPO, { targetId: OLD_ISSUE, requested: 'public' })).toBe('public')
    expect(await childAudience(sdk, REPO, { targetId: ISSUE_PUBLIC, replyTo: OLD_REPLY, requested: 'public' })).toBe('public')
    // a members-only reply written since still binds
    await expect(childAudience(sdk, REPO, { targetId: OLD_ISSUE, replyTo: NEW_REPLY, requested: 'public' })).rejects.toThrow(/can't be public/)
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
    expect(commentDraftKey(REPO, ISSUE_PUBLIC, auth.identityId, 'public')).not.toBeNull()
    expect(commentDraftKey(REPO, ISSUE_MEMBERS, auth.identityId, 'members')).toBeNull()
    expect(commentDraftKey({ ...REPO, visibility: 'private' }, ISSUE_PUBLIC, auth.identityId, 'public')).toBeNull()
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

describe('review round 1 regressions', () => {
  const ISSUE_SEALED_STORED = b58(id(0xa1))
  const COMMENT_SEALED_STORED = b58(id(0xa2))
  const seal = { current: { body: 'old' }, bind: { targetId: ISSUE_MEMBERS } }

  it('C1: a long edit of a members-only comment or issue is refused before any artifact is stored', async () => {
    stored[COMMENT_SEALED_STORED] = { $id: COMMENT_SEALED_STORED, repoId: REPO.repoId, enc: SEALED, epoch: 0, targetId: decodeIdentifier(ISSUE_MEMBERS) }
    stored[ISSUE_SEALED_STORED] = { $id: ISSUE_SEALED_STORED, repoId: REPO.repoId, enc: SEALED, epoch: 0, number: 9 }
    const long = 'z'.repeat(6000)
    await expect(updateComment(sdk, auth, REPO, { id: COMMENT_SEALED_STORED, body: long, expectedRevision: 1n, seal })).rejects.toBeInstanceOf(LongBodyRefusedError)
    await expect(
      updateTarget(sdk, auth, REPO, { type: 'issue', id: ISSUE_SEALED_STORED, body: long, expectedRevision: 1n, seal: { current: { title: 't' }, bind: { number: 9 } } }),
    ).rejects.toBeInstanceOf(LongBodyRefusedError)
    expect(artifacts).toEqual([])
    expect(writes).toEqual([])
    expect(replaces).toEqual([])
  })

  it('C1 backstop: a public long body for an edit of a stored sealed document is refused', async () => {
    stored[COMMENT_SEALED_STORED] = { $id: COMMENT_SEALED_STORED, repoId: REPO.repoId, enc: SEALED, epoch: 0 }
    await expect(longBodyField(sdk, auth, REPO, 'comment', 'q'.repeat(6000), {}, undefined, 'public', { type: 'comment', id: COMMENT_SEALED_STORED })).rejects.toThrow(/members-only/)
    expect(artifacts).toEqual([])
  })

  it('H2: a reply under a members-only root posted with no audience is never public plaintext', async () => {
    const root = b58(id(0xa3))
    stored[root] = { $id: root, repoId: REPO.repoId, enc: SEALED, epoch: 0 }
    // postComment (a quick reply, an inline thread's Reply) settles nothing itself
    await expect(postComment(sdk, auth, REPO, { targetId: ISSUE_PUBLIC, body: 'QAMARK reply', replyTo: root })).rejects.toThrow()
    expect(writes).toEqual([])
    // with the members key it is sealed
    const writer = { keys: await EpochKeys.import(REPO_ID, 0, new Uint8Array(K0)) }
    await writeRepoDoc(sdk, auth, REPO, 'comment', { targetId: decodeIdentifier(ISSUE_PUBLIC), replyTo: decodeIdentifier(root), body: 'QAMARK reply' }, 'r1', undefined, undefined, { membersWriter: writer })
    expect(writes[0]?.data['body']).toBeUndefined()
    expect((writes[0]?.data['enc'] as Uint8Array)[0]).toBe(0x03)
    // a review on a members-only PR, settled by nobody, follows it too
    await writeRepoDoc(sdk, auth, REPO, 'review', { patchId: decodeIdentifier(ISSUE_MEMBERS), verdict: 3, commitOid: new Uint8Array(20), body: 'QAMARK review' }, 'r2', undefined, undefined, { membersWriter: writer })
    expect(writes[1]?.data['body']).toBeUndefined()
    expect((writes[1]?.data['enc'] as Uint8Array)[0]).toBe(0x03)
  })

  it('an author event with a value on a members-only target is refused (it cannot be sealed)', async () => {
    await expect(writeRepoDoc(sdk, auth, REPO, 'authorEvent', { targetId: decodeIdentifier(ISSUE_MEMBERS), targetNumber: 3, kind: 7, value: 'secret' }, 'a1')).rejects.toThrow(/members-only/)
    expect(writes).toEqual([])
  })

  it('M5: a public repo with no members key reads no parent for a comment (one cached config read)', async () => {
    const other: RepoRef = { ...REPO, repoId: b58(id(0x33)) }
    configs = [{ $id: 'c1', defaultBranch: 'main' }]
    await writeRepoDoc(sdk, auth, other, 'comment', { targetId: decodeIdentifier(b58(id(0x34))), body: 'plain' }, 'p1')
    await writeRepoDoc(sdk, auth, other, 'comment', { targetId: decodeIdentifier(b58(id(0x35))), body: 'plain too' }, 'p2')
    expect(writes.map((w) => w.data['body'])).toEqual(['plain', 'plain too'])
    expect(reads).toBe(1)
  })

  it('M6: a members-only verdict read as a non-member (4 / 5) is written as the member it is, with the proof', async () => {
    const writer = { keys: await EpochKeys.import(REPO_ID, 0, new Uint8Array(K0)) }
    const out = await sealMembersContent(auth, 'review', { patchId: decodeIdentifier(ISSUE_MEMBERS), verdict: 4, commitOid: new Uint8Array(20), body: 'ok' }, writer)
    expect(out['verdict']).toBe(1)
    expect(base58Encode(out['asMember'] as Uint8Array)).toBe(auth.identityId)
    const req = await sealMembersContent(auth, 'review', { patchId: decodeIdentifier(ISSUE_MEMBERS), verdict: 5, commitOid: new Uint8Array(20) }, writer)
    expect(req['verdict']).toBe(2)
  })

  it('L9: the retry cache keys a sealed write by an HMAC under the epoch key, not a plain hash', async () => {
    const writer = { keys: await EpochKeys.import(REPO_ID, 0, new Uint8Array(K0)) }
    const data = { targetId: decodeIdentifier(ISSUE_MEMBERS), body: 'QAMARK keyed' }
    await writeRepoDoc(sdk, auth, REPO, 'comment', data, 'k1', undefined, undefined, { audience: 'members', membersWriter: writer })
    const key = writes[0]?.contentKey
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toBe(contentHash('comment', { repoId: decodeIdentifier(REPO.repoId), ...data }))
  })

  it('L8: readComments shows a sealed comment it cannot open as nothing, never a blank public comment', async () => {
    byType = {
      comment: [
        { $id: b58(id(0xb1)), $ownerId: auth.identityId, $createdAt: 1, repoId: REPO.repoId, targetId: ISSUE_PUBLIC, body: 'public words' },
        { $id: b58(id(0xb2)), $ownerId: auth.identityId, $createdAt: 2, $createdAtBlockHeight: 5, repoId: REPO.repoId, targetId: ISSUE_PUBLIC, enc: SEALED, epoch: 0 },
      ],
    }
    const shown = await readComments(sdk, REPO, ISSUE_PUBLIC)
    expect(shown.map((c) => c.body)).toEqual(['public words'])
  })
})
