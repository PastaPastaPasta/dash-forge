/**
 * Review-parity writes: what each helper writes (byte for byte against the contract), which
 * route it takes, what it refuses before signing, and a pending review's submit and resume
 * against a scripted write engine.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const writes: { documentType: string; data: Record<string, unknown>; intent?: string }[] = []
let failAt: number | null = null
/** Distinct well-formed document ids, D(1), D(2), ... */
const IDS = ['8rSFEyS7gidGdS4r8m22YtMEc519otpDNQ242Zw9c1Gb', 'EA8HsynH63cw1i8xQLoARwk43sDf74HrKut1D4RV3L35', 'DBL7NnqGZjyVHwo2jp3K1QD9oRBcbFZnSnB9kQ8bmoYu', 'C6Gox4Qdg9iuQkAnq8hr6XSMYMKNUfSjESD81KrZu4pm', '6N175pfKBhzcNg9kdpPLBTG32LdpZCLxG6XPReg4NPHS']
const D = (n: number): string => IDS[n - 1] as string

vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _auth: unknown, p: { documentType: string; data: Record<string, unknown>; intent?: string }) => {
      if (failAt !== null && writes.length === failAt) {
        failAt = null
        throw new Error('network dropped')
      }
      writes.push({ documentType: p.documentType, data: p.data, ...(p.intent ? { intent: p.intent } : {}) })
      return { documentId: D(writes.length), confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
    replaceDocumentIdempotent: vi.fn(async (_sdk: unknown, _auth: unknown, p: { documentType: string; changes: Record<string, unknown> }) => {
      replaces.push({ documentType: p.documentType, changes: p.changes })
      return { documentId: 'x', revision: 2n, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
  }
})

const replaces: { documentType: string; changes: Record<string, unknown> }[] = []
const sealed: unknown[][] = []
vi.mock('./private-writes', async (importOriginal) => {
  const real = await importOriginal<typeof import('./private-writes')>()
  return {
    ...real,
    sealEdit: vi.fn(async (...args: unknown[]) => {
      sealed.push(args.slice(3))
      return { enc: new Uint8Array([1, 2, 3]), epoch: 4 }
    }),
  }
})

import { resetMemoryStores } from '../idb'
import type { RepoRef } from './contract'
import {
  anchorData,
  eventRoute,
  loadReviewDraft,
  postComment,
  postTargetEvent,
  reviewData,
  saveReviewDraft,
  setAssignee,
  setLabel,
  submitReviewDraft,
  targetEventData,
  updateComment,
  updateTarget,
  type ChainComment,
  type ChainReview,
  type ReviewDraft,
  type SubmitReads,
} from './review-writes'
import type { WriteAuth } from '../sdk'

const ALICE = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const BOB = '6jAyDGGcc6fgA7bsraQPriTAZ73Lkq5QgnenaRhqteHd'
const PR = 'GKBTXUdo3MpRYAUqgZvTZGTav9mXGqfJfR5822K2tp79'
const REPO: RepoRef = {
  forge: { core: 'GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL', collab: 'BMfPmaEiMqDp64NDa4Am79VoRpZ9MPVNnCUy6i3UiyWi', group: 'G6T1mjQZJ4pqjaraEw71RRSbVasd7JSbgsWfmLUgNhL2' },
  repoId: '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z',
  ownerId: ALICE,
  name: 'demo',
  visibility: 'public',
}
const HEAD = 'ab'.repeat(20)
const sdk = {} as EvoSDK
const auth = (identityId: string): WriteAuth => ({ identityId, network: 'devnet', getSigningKeyWif: () => 'x' })
const target = { id: PR, number: 3 }
/** Chain reads that find nothing (a first submit). */
const NO_CHAIN: SubmitReads = { reviews: async () => [], comments: async () => [] }

beforeEach(() => {
  writes.length = 0
  failAt = null
  resetMemoryStores()
})

describe('event payloads and routes', () => {
  it('writes the kind integer and the payload each review kind needs', () => {
    expect(targetEventData(target, 'threadResolve', { refId: BOB })).toMatchObject({ kind: 11, targetNumber: 3 })
    expect(targetEventData(target, 'threadResolve', { refId: BOB })['refId']).toBeInstanceOf(Uint8Array)
    expect(targetEventData(target, 'reviewDismiss', { refId: BOB, value: 'stale' })).toMatchObject({ kind: 15, value: 'stale' })
    const head = targetEventData(target, 'headUpdate', { oidHex: HEAD })
    expect(head['kind']).toBe(16)
    expect((head['oid'] as Uint8Array).length).toBe(20)
    expect(targetEventData(target, 'milestoneClear')).toEqual(expect.objectContaining({ kind: 18 }))
  })

  it('refuses a review kind without its payload before signing', () => {
    for (const kind of ['threadResolve', 'threadUnresolve', 'reviewRequest', 'reviewRequestRemove', 'reviewDismiss'] as const) {
      expect(() => targetEventData(target, kind)).toThrow(/refId/)
    }
    expect(() => targetEventData(target, 'headUpdate')).toThrow(/oid/)
    expect(() => targetEventData(target, 'headUpdate', { oidHex: 'abcd' })).toThrow(/oid/)
    expect(() => targetEventData(target, 'headUpdate', { oidHex: 'ab'.repeat(25) })).toThrow(/oid/)
    expect(() => targetEventData(target, 'milestoneSet')).toThrow(/name/)
  })

  it('checks a retarget ref name and the value bounds as forge-core does', () => {
    expect(targetEventData(target, 'retarget', { value: 'refs/heads/dev' })).toMatchObject({ kind: 8 })
    expect(() => targetEventData(target, 'retarget', { value: '-x' })).toThrow(/retarget/)
    expect(() => targetEventData(target, 'retarget')).toThrow(/retarget/)
    expect(targetEventData(target, 'labelAdd', { value: 'é'.repeat(120) })).toMatchObject({ kind: 4 })
    expect(() => targetEventData(target, 'labelAdd', { value: 'x'.repeat(121) })).toThrow(/120 characters/)
    expect(() => targetEventData(target, 'labelAdd', { value: '🔥'.repeat(121) })).toThrow(/120 characters/)
    expect(() => targetEventData(target, 'labelAdd', { value: '🔥'.repeat(121) })).toThrow(/480 bytes/)
  })

  it('routes: members always use event; the author an authorEvent for author kinds only', () => {
    expect(eventRoute({ viewer: BOB, author: ALICE, isMember: true, kind: 'reviewDismiss' })).toBe('event')
    expect(eventRoute({ viewer: ALICE, author: ALICE, isMember: false, kind: 'headUpdate' })).toBe('authorEvent')
    expect(eventRoute({ viewer: ALICE, author: ALICE, isMember: false, kind: 'threadResolve' })).toBe('authorEvent')
    for (const kind of ['merge', 'labelAdd', 'reviewDismiss', 'milestoneSet', 'retarget'] as const) {
      expect(eventRoute({ viewer: ALICE, author: ALICE, isMember: false, kind })).toBeNull()
    }
    expect(eventRoute({ viewer: BOB, author: ALICE, isMember: false, kind: 'threadResolve' })).toBeNull()
  })

  it('posts the author route as an authorEvent document', async () => {
    const r = await postTargetEvent(sdk, auth(ALICE), REPO, { target, kind: 'ready', author: ALICE, isMember: false })
    expect(r.route).toBe('authorEvent')
    expect(writes[0]?.documentType).toBe('authorEvent')
    expect(writes[0]?.data['kind']).toBe(10)
    await expect(postTargetEvent(sdk, auth(ALICE), REPO, { target, kind: 'reviewDismiss', author: ALICE, isMember: false, payload: { refId: BOB } })).rejects.toThrow(/maintainer or writer/)
    expect(writes).toHaveLength(1)
  })
})

describe('assignees and labels (F-1)', () => {
  it('names the assignee in value and refId, so the addressee index finds it', async () => {
    await setAssignee(sdk, auth(ALICE), REPO, { target, assignee: BOB, assign: true })
    await setAssignee(sdk, auth(ALICE), REPO, { target, assignee: BOB, assign: false })
    expect(writes.map((w) => [w.documentType, w.data['kind'], w.data['value']])).toEqual([
      ['event', 6, BOB],
      ['event', 7, BOB],
    ])
    for (const w of writes) {
      expect(w.data['refId']).toBeInstanceOf(Uint8Array)
      expect((w.data['refId'] as Uint8Array).length).toBe(32)
    }
  })

  it('refuses an assign whose refId does not name the assignee', () => {
    expect(() => targetEventData(target, 'assign', { value: BOB })).toThrow(/refId/)
    expect(() => targetEventData(target, 'assign', { value: BOB, refId: ALICE })).toThrow(/refId/)
    expect(() => targetEventData(target, 'unassign', { refId: BOB })).toThrow(/refId/)
  })

  it('writes label events with the trimmed name and refuses an empty one', async () => {
    await setLabel(sdk, auth(ALICE), REPO, { target, label: ' bug ', add: true })
    await setLabel(sdk, auth(ALICE), REPO, { target, label: 'bug', add: false })
    expect(writes.map((w) => [w.data['kind'], w.data['value']])).toEqual([
      [4, 'bug'],
      [5, 'bug'],
    ])
    await expect(setLabel(sdk, auth(ALICE), REPO, { target, label: ' ', add: true })).rejects.toThrow(/label name/)
  })

  it('re-seals a private edit (sealEdit) and replaces only enc/epoch; without the context it refuses', async () => {
    const PRIVATE: RepoRef = { ...REPO, visibility: 'private' }
    replaces.length = 0
    sealed.length = 0
    await expect(updateTarget(sdk, auth(ALICE), PRIVATE, { type: 'issue', id: PR, title: 'x' })).rejects.toThrow(/private repo/)
    expect(replaces).toHaveLength(0)
    await updateTarget(sdk, auth(ALICE), PRIVATE, {
      type: 'issue',
      id: PR,
      title: 'new',
      seal: { current: { title: 'old', body: 'b' }, bind: { number: 3 } },
    })
    expect(sealed[0]).toEqual(['issue', { number: 3 }, { title: 'old', body: 'b' }, { title: 'new' }, undefined])
    expect(replaces[0]).toEqual({ documentType: 'issue', changes: { enc: new Uint8Array([1, 2, 3]), epoch: 4 } })
    await updateComment(sdk, auth(ALICE), PRIVATE, { id: PR, body: 'edited', seal: { current: { body: 'was' }, bind: { targetId: PR } } })
    expect(replaces[1]?.changes).not.toHaveProperty('body')
    // A public edit is plaintext, as before.
    await updateTarget(sdk, auth(ALICE), REPO, { type: 'issue', id: PR, title: 'pub' })
    expect(replaces[2]?.changes).toEqual({ title: 'pub' })
  })
})

describe('anchors and reviews', () => {
  it('writes single-line, range and file-level anchors; refuses malformed ones', () => {
    expect(anchorData({ path: 'a.rs', line: 3, side: 1 })).toEqual({ path: 'a.rs', line: 3, side: 1 })
    expect(anchorData({ path: 'a.rs', line: 5, startLine: 3, side: 0 })).toEqual({ path: 'a.rs', line: 5, side: 0, startLine: 3 })
    expect(anchorData({ path: 'README.md' })).toEqual({ path: 'README.md' })
    expect(() => anchorData({ path: 'a.rs', line: 3, startLine: 4, side: 1 })).toThrow(/range/)
    expect(() => anchorData({ path: 'a.rs', line: 3 })).toThrow(/side/)
    expect(() => anchorData({ path: 'a.rs', side: 1 })).toThrow(/line/)
    expect(() => anchorData({ path: '' })).toThrow(/path/)
  })

  it('writes commentCount on a review and bounds it', () => {
    expect(reviewData({ patchId: PR, verdict: 'requestChanges', commitOid: HEAD, commentCount: 2 })).toMatchObject({ verdict: 2, commentCount: 2 })
    expect(() => reviewData({ patchId: PR, verdict: 'approve', commitOid: HEAD, commentCount: 65536 })).toThrow()
  })
})

describe('private repos', () => {
  const PRIVATE: RepoRef = { ...REPO, visibility: 'private' }
  it('refuses plaintext issues, PRs, comments, reviews and edits before signing', async () => {
    await expect(postComment(sdk, auth(BOB), PRIVATE, { targetId: PR, body: 'secret' })).rejects.toThrow(/private repo/)
    await expect(updateComment(sdk, auth(BOB), PRIVATE, { id: PR, body: 'secret' })).rejects.toThrow(/private repo/)
    const d = { draftId: 'p', network: 'devnet', identity: BOB, repoId: REPO.repoId, prId: PR, headOid: HEAD, verdict: 'approve' as const, summary: '', comments: [], startedAt: 0 }
    await expect(submitReviewDraft(sdk, auth(BOB), PRIVATE, d, undefined, NO_CHAIN)).rejects.toThrow(/private repo/)
    expect(writes).toHaveLength(0)
    // Events are plaintext by design, and still allowed.
    await postTargetEvent(sdk, auth(ALICE), PRIVATE, { target, kind: 'ready', author: ALICE, isMember: false })
    expect(writes[0]?.documentType).toBe('authorEvent')
  })
})

describe('pending review submit', () => {
  const draft = (): ReviewDraft => ({
    draftId: 'd1',
    network: 'devnet',
    identity: BOB,
    repoId: REPO.repoId,
    prId: PR,
    headOid: HEAD,
    verdict: 'requestChanges',
    summary: 'two things',
    comments: [
      { localId: 'c1', anchor: { path: 'a.rs', line: 3, side: 1 }, body: 'one' },
      { localId: 'c2', anchor: { path: 'a.rs', line: 9, startLine: 7, side: 1 }, body: 'two' },
      { localId: 'c3', anchor: { path: 'README.md' }, body: 'three' },
    ],
    startedAt: 1,
  })

  it('writes the review first with commentCount, then each comment with reviewId and the head', async () => {
    await saveReviewDraft(draft())
    const progress: number[] = []
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, draft(), (p) => progress.push(p.done), NO_CHAIN)
    expect(writes.map((w) => w.documentType)).toEqual(['review', 'comment', 'comment', 'comment'])
    expect(writes[0]?.data).toMatchObject({ verdict: 2, body: 'two things', commentCount: 3 })
    for (const w of writes.slice(1)) {
      expect(w.data['reviewId']).toBeInstanceOf(Uint8Array)
      expect((w.data['commitOid'] as Uint8Array).length).toBe(20)
    }
    expect(writes[2]?.data).toMatchObject({ startLine: 7, line: 9 })
    expect(writes.map((w) => w.intent)).toEqual(['review:d1:review', 'review:d1:comment:c1', 'review:d1:comment:c2', 'review:d1:comment:c3'])
    expect(out).toEqual({ reviewId: D(1), commentIds: [D(2), D(3), D(4)] })
    expect(progress).toEqual([0, 1, 2, 3, 4])
    expect(await loadReviewDraft('devnet', BOB, PR)).toBeUndefined()
  })

  it('resumes after a failure at comment 2 of 3 without rewriting what landed', async () => {
    await saveReviewDraft(draft())
    failAt = 2 // the review and comment 1 land, comment 2 fails
    await expect(submitReviewDraft(sdk, auth(BOB), REPO, draft(), undefined, NO_CHAIN)).rejects.toThrow('network dropped')
    const saved = await loadReviewDraft('devnet', BOB, PR)
    expect(saved?.reviewId).toBe(D(1))
    expect(saved?.comments.map((c) => c.landedId ?? null)).toEqual([D(2), null, null])
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, saved as ReviewDraft, undefined, NO_CHAIN)
    expect(writes.map((w) => w.documentType)).toEqual(['review', 'comment', 'comment', 'comment'])
    expect(out.commentIds).toEqual([D(2), D(3), D(4)])
    expect(await loadReviewDraft('devnet', BOB, PR)).toBeUndefined()
  })

  it('adopts writes that landed without their save instead of posting them twice', async () => {
    // The review and comment 1 landed on chain, but the tab died before either was saved:
    // the draft in IndexedDB knows nothing of them.
    const d = { ...draft(), attemptedAt: 5 }
    await saveReviewDraft(d)
    const landedReview: ChainReview = { id: D(1), reviewer: BOB, verdict: 2, commitOid: HEAD, body: 'two things', commentCount: 3, createdAt: 5 }
    const landedComment: ChainComment = { id: D(2), owner: BOB, reviewId: D(1), body: 'one', anchor: { path: 'a.rs', line: 3, side: 1, commitOid: HEAD }, createdAt: 6 }
    const reads: SubmitReads = {
      reviews: async () => [
        landedReview,
        // not ours: another reviewer, an older head, another count, before the draft started
        { ...landedReview, id: 'x1', reviewer: ALICE },
        { ...landedReview, id: 'x2', commitOid: 'cd'.repeat(20) },
        { ...landedReview, id: 'x3', commentCount: 2 },
        { ...landedReview, id: 'x5', verdict: 1 },
        { ...landedReview, id: 'x6', body: 'another review' },
      ],
      comments: async () => [
        landedComment,
        // a comment by someone else naming the review, and one of ours with other text
        { ...landedComment, id: 'y1', owner: ALICE },
        { ...landedComment, id: 'y2', body: 'different' },
      ],
    }
    writes.length = 0
    const pad = (n: number) => { while (writes.length < n) writes.push({ documentType: 'pad', data: {} }) }
    pad(2) // the next fake id the engine hands out is D(3)
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, d, undefined, reads)
    const posted = writes.filter((w) => w.documentType !== 'pad')
    expect(posted.map((w) => w.documentType)).toEqual(['comment', 'comment'])
    expect(posted.map((w) => w.intent)).toEqual(['review:d1:comment:c2', 'review:d1:comment:c3'])
    expect(out.reviewId).toBe(D(1))
    expect(out.commentIds).toEqual([D(2), D(3), D(4)])
  })

  it('never adopts an earlier review for a draft that has not been submitted yet', async () => {
    // A review with the same verdict, head, body and count already exists (an earlier review by
    // the same person): a first submit must still write its own.
    const d = { ...draft(), comments: [] }
    const earlier: ChainReview = { id: D(5), reviewer: BOB, verdict: 2, commitOid: HEAD, body: 'two things', commentCount: 0, createdAt: Date.now() + 60_000 }
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, d, undefined, { reviews: async () => [earlier], comments: async () => [] })
    expect(writes.map((w) => w.documentType)).toEqual(['review'])
    expect(out.reviewId).toBe(D(1))
  })

  it('records the attempt before the first write, so a crash after it reconciles', async () => {
    await saveReviewDraft(draft())
    failAt = 0
    await expect(submitReviewDraft(sdk, auth(BOB), REPO, draft(), undefined, NO_CHAIN)).rejects.toThrow('network dropped')
    expect((await loadReviewDraft('devnet', BOB, PR))?.attemptedAt).toBeTypeOf('number')
  })

  it("refuses to submit another identity's draft", async () => {
    await expect(submitReviewDraft(sdk, auth(ALICE), REPO, draft(), undefined, NO_CHAIN)).rejects.toThrow(/another identity/)
    expect(writes).toHaveLength(0)
  })
})
