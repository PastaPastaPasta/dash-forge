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
    precheckEdit: vi.fn(async (_sdk: unknown, _auth: unknown, p: { documentId: string }) => {
      prechecks.push(p.documentId)
      if (precheckFails) throw new Error('only the author can edit this')
    }),
    replaceDocumentIdempotent: vi.fn(async (_sdk: unknown, _auth: unknown, p: { documentType: string; changes: Record<string, unknown>; expectedRevision?: bigint; expectRepoId?: string }) => {
      replaces.push({ documentType: p.documentType, changes: p.changes, expectedRevision: p.expectedRevision, expectRepoId: p.expectRepoId })
      return { documentId: 'x', revision: 2n, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
  }
})

const prechecks: string[] = []
let precheckFails = false
const replaces: { documentType: string; changes: Record<string, unknown>; expectedRevision?: bigint; expectRepoId?: string }[] = []
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
import { decodeIdentifier } from '../auth/base58'
import { clearSignedWrites, lockVault } from '../auth/vault'
import type { RepoRef } from './contract'
import {
  anchorData,
  eventRoute,
  loadReviewDraft,
  postComment,
  postTargetEvent,
  reconcileReviewDraft,
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

const ALICE = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const BOB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
/** A member posting to an unlocked PR. */
const MEMBER = { isMember: true }
const PR = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const REPO: RepoRef = {
  forge: { core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1', collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS', community: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS', group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC' },
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
    // The state kinds are transitions now: no authorEvent carries them.
    for (const kind of ['merge', 'close', 'reopen', 'draft', 'ready', 'labelAdd', 'reviewDismiss', 'milestoneSet', 'retarget'] as const) {
      expect(eventRoute({ viewer: ALICE, author: ALICE, isMember: false, kind })).toBeNull()
    }
    expect(eventRoute({ viewer: BOB, author: ALICE, isMember: false, kind: 'threadResolve' })).toBeNull()
  })

  it('posts the author route as an authorEvent document', async () => {
    const r = await postTargetEvent(sdk, auth(ALICE), REPO, { target, kind: 'headUpdate', author: ALICE, isMember: false, payload: { oidHex: HEAD } })
    expect(r.route).toBe('authorEvent')
    expect(writes[0]?.documentType).toBe('authorEvent')
    expect(writes[0]?.data['kind']).toBe(16)
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
    // Every private edit names the revision it read (as the CLI's): without it, refused before sealing.
    await expect(updateTarget(sdk, auth(ALICE), PRIVATE, { type: 'issue', id: PR, title: 'x', seal: { current: { title: 'old' }, bind: { number: 3 } } })).rejects.toThrow(/revision/)
    expect(sealed).toHaveLength(0)
    await updateTarget(sdk, auth(ALICE), PRIVATE, {
      type: 'issue',
      id: PR,
      title: 'new',
      expectedRevision: 1n,
      seal: { current: { title: 'old', body: 'b' }, bind: { number: 3 } },
    })
    expect(sealed[0]).toEqual(['issue', { number: 3 }, { title: 'old', body: 'b' }, { title: 'new' }, undefined, undefined])
    // Only enc/epoch are written; legacy plaintext next to enc is cleared in the same replace.
    expect(replaces[0]).toEqual({ documentType: 'issue', changes: { enc: new Uint8Array([1, 2, 3]), epoch: 4, title: undefined, body: undefined }, expectedRevision: 1n, expectRepoId: PRIVATE.repoId })
    await updateComment(sdk, auth(ALICE), PRIVATE, { id: PR, body: 'edited', expectedRevision: 2n, seal: { current: { body: 'was' }, bind: { targetId: PR }, imported: { author: 'octocat', url: 'u' } } })
    expect(replaces[1]?.changes).toEqual({ enc: new Uint8Array([1, 2, 3]), epoch: 4, body: undefined })
    // The comment's provenance is re-sealed, and the edit names the revision and the repo it read.
    expect(sealed[1]?.[5]).toEqual({ author: 'octocat', url: 'u' })
    expect(replaces[1]).toMatchObject({ expectedRevision: 2n, expectRepoId: PRIVATE.repoId })
    // RC1: a dead parent and a lapsed proof are removed in the sealed replace too (plaintext references).
    await updateComment(sdk, auth(ALICE), PRIVATE, { id: PR, body: 'again', dropReplyTo: true, dropProof: true, expectedRevision: 3n, seal: { current: { body: 'edited' }, bind: { targetId: PR } } })
    expect(replaces[2]?.changes).toEqual({ enc: new Uint8Array([1, 2, 3]), epoch: 4, body: undefined, replyTo: undefined, asMember: undefined })
    expect(Object.keys(replaces[2]?.changes ?? {})).toEqual(expect.arrayContaining(['replyTo', 'asMember']))
    // A private comment edit without the revision it read is refused (both clients guard edits by revision).
    await expect(updateComment(sdk, auth(ALICE), PRIVATE, { id: PR, body: 'x', seal: { current: { body: 'was' }, bind: { targetId: PR } } })).rejects.toThrow(/revision/)
    // The author (and repo, revision) is checked before any key work: a refused precheck seals nothing.
    const sealedBefore = sealed.length
    precheckFails = true
    await expect(updateComment(sdk, auth(BOB), PRIVATE, { id: PR, body: 'y', expectedRevision: 2n, seal: { current: { body: 'was' }, bind: { targetId: PR } } })).rejects.toThrow(/author/)
    precheckFails = false
    expect(sealed.length).toBe(sealedBefore)
    expect(prechecks.length).toBeGreaterThan(0)
    // A public edit is plaintext, as before.
    await updateTarget(sdk, auth(ALICE), REPO, { type: 'issue', id: PR, title: 'pub' })
    expect(replaces[3]?.changes).toEqual({ title: 'pub' })
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
    expect(reviewData({ patchId: PR, verdict: 'requestChanges', commitOid: HEAD, commentCount: 2, post: MEMBER }, BOB)).toMatchObject({ verdict: 2, commentCount: 2 })
    expect(() => reviewData({ patchId: PR, verdict: 'approve', commitOid: HEAD, commentCount: 65536, post: MEMBER }, BOB)).toThrow()
  })
})

describe('private repos', () => {
  const PRIVATE: RepoRef = { ...REPO, visibility: 'private' }
  it('refuses plaintext issues, PRs, comments, reviews and edits before signing', async () => {
    await expect(postComment(sdk, auth(BOB), PRIVATE, { targetId: PR, body: 'secret' })).rejects.toThrow(/private repo/)
    await expect(updateComment(sdk, auth(BOB), PRIVATE, { id: PR, body: 'secret' })).rejects.toThrow(/private repo/)
    const d = { draftId: 'p', network: 'devnet', identity: BOB, repoId: REPO.repoId, prId: PR, headOid: HEAD, verdict: 'approve' as const, summary: '', comments: [], startedAt: 0 }
    await expect(submitReviewDraft(sdk, auth(BOB), PRIVATE, d, MEMBER, undefined, NO_CHAIN)).rejects.toThrow(/private repo/)
    expect(writes).toHaveLength(0)
    // Events are plaintext by design, and still allowed.
    await postTargetEvent(sdk, auth(ALICE), PRIVATE, { target, kind: 'headUpdate', author: ALICE, isMember: false, payload: { oidHex: HEAD } })
    expect(writes[0]?.documentType).toBe('authorEvent')
  })
})

describe('where a pending review is kept', () => {
  const d = (identity: string): ReviewDraft => ({
    draftId: `d-${identity}`,
    network: 'devnet',
    identity,
    repoId: REPO.repoId,
    prId: PR,
    headOid: 'ab'.repeat(20),
    verdict: 'comment',
    summary: 'kept',
    comments: [{ localId: 'c1', anchor: { path: 'a.rs', line: 3, side: 1 }, body: 'one' }],
    startedAt: 1,
  })

  it('is keyed by network, identity and PR: a sign-out and sign-in (a new session) finds it', async () => {
    await saveReviewDraft(d(BOB))
    // Signing out locks the vault and clears the pending signed writes; it never touches drafts.
    lockVault()
    clearSignedWrites()
    expect((await loadReviewDraft('devnet', BOB, PR))?.summary).toBe('kept')
    // Another identity in the same browser has its own (none), and never sees BOB's.
    expect(await loadReviewDraft('devnet', ALICE, PR)).toBeUndefined()
    expect(await loadReviewDraft('testnet', BOB, PR)).toBeUndefined()
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
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, draft(), MEMBER, (p) => progress.push(p.done), NO_CHAIN)
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
    await expect(submitReviewDraft(sdk, auth(BOB), REPO, draft(), MEMBER, undefined, NO_CHAIN)).rejects.toThrow('network dropped')
    const saved = await loadReviewDraft('devnet', BOB, PR)
    expect(saved?.reviewId).toBe(D(1))
    expect(saved?.comments.map((c) => c.landedId ?? null)).toEqual([D(2), null, null])
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, saved as ReviewDraft, MEMBER, undefined, NO_CHAIN)
    expect(writes.map((w) => w.documentType)).toEqual(['review', 'comment', 'comment', 'comment'])
    expect(out.commentIds).toEqual([D(2), D(3), D(4)])
    expect(await loadReviewDraft('devnet', BOB, PR)).toBeUndefined()
  })

  it('adopts writes that landed without their save instead of posting them twice', async () => {
    // The review and comment 1 landed on chain, but the tab died before either was saved:
    // the draft in IndexedDB knows nothing of them.
    // x0 is an earlier review of Bob's, identical, recorded as prior before the first write.
    const d = { ...draft(), attemptedAt: 5, priorReviews: ['x0'] }
    await saveReviewDraft(d)
    const landedReview: ChainReview = { id: D(1), reviewer: BOB, verdict: 2, commitOid: HEAD, body: 'two things', commentCount: 3, createdAt: 5 }
    const landedComment: ChainComment = { id: D(2), owner: BOB, reviewId: D(1), body: 'one', anchor: { path: 'a.rs', line: 3, side: 1, commitOid: HEAD }, createdAt: 6 }
    const reads: SubmitReads = {
      reviews: async () => [
        { ...landedReview, id: 'x0', createdAt: 4 },
        // an earlier identical review a lagging node left out of priorReviews: older than ours
        { ...landedReview, id: 'x7', createdAt: 3 },
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
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, d, MEMBER, undefined, reads)
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
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, d, MEMBER, undefined, { reviews: async () => [earlier], comments: async () => [] })
    expect(writes.map((w) => w.documentType)).toEqual(['review'])
    expect(out.reviewId).toBe(D(1))
  })

  it("files a second review's comments under the second review, as the drawer submits it (attempt stamped first)", async () => {
    // Bob's first review (same verdict, head, summary and one comment) landed a minute ago. The
    // drawer stamps `attemptedAt` before the first submit (`startSubmit`): the reconcile must not
    // take the first review for this draft's own and write the new comment with its id.
    const now = Date.now()
    const first: ChainReview = { id: D(5), reviewer: BOB, verdict: 2, commitOid: HEAD, body: 'two things', commentCount: 1, createdAt: now - 60_000 }
    const firstComment: ChainComment = { id: 'f1', owner: BOB, reviewId: D(5), body: 'earlier', anchor: { path: 'a.rs', line: 1, side: 1, commitOid: HEAD }, createdAt: now - 59_000 }
    const reads: SubmitReads = { reviews: async () => [first], comments: async () => [firstComment] }
    const d: ReviewDraft = { ...draft(), comments: [{ localId: 'c1', anchor: { path: 'a.rs', line: 3, side: 1 }, body: 'one' }], attemptedAt: now }
    await saveReviewDraft(d)
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, d, MEMBER, undefined, reads)
    expect(writes.map((w) => w.documentType)).toEqual(['review', 'comment'])
    expect(out.reviewId).toBe(D(1))
    expect(writes[1]?.data['reviewId']).toEqual(decodeIdentifier(D(1)))
  })

  it('records the earlier reviews before the first write, and a resume never adopts one of them', async () => {
    const now = Date.now()
    const first: ChainReview = { id: D(5), reviewer: BOB, verdict: 2, commitOid: HEAD, body: 'two things', commentCount: 3, createdAt: now - 60_000 }
    const other: ChainReview = { ...first, id: 'x1', reviewer: ALICE }
    let chain: ChainReview[] = [first, other]
    const reads: SubmitReads = { reviews: async () => chain, comments: async () => [] }
    failAt = 0 // the review write throws (a timeout) although it landed, so its id is never saved
    await expect(submitReviewDraft(sdk, auth(BOB), REPO, { ...draft(), attemptedAt: now }, MEMBER, undefined, reads)).rejects.toThrow('network dropped')
    const saved = (await loadReviewDraft('devnet', BOB, PR)) as ReviewDraft
    expect(saved.priorReviews).toEqual([D(5)])
    // The resume sees the first review and this draft's own, which landed without its save.
    const own: ChainReview = { ...first, id: D(4), createdAt: now + 1_000 }
    chain = [first, other, own]
    const out = await submitReviewDraft(sdk, auth(BOB), REPO, saved, MEMBER, undefined, reads)
    expect(out.reviewId).toBe(D(4))
    expect(writes.map((w) => w.documentType)).toEqual(['comment', 'comment', 'comment'])
  })

  it('adopts no review for a draft without its record of earlier reviews (nothing of it was written)', async () => {
    const now = Date.now()
    const earlier: ChainReview = { id: D(5), reviewer: BOB, verdict: 2, commitOid: HEAD, body: 'two things', commentCount: 3, createdAt: now }
    const d: ReviewDraft = { ...draft(), attemptedAt: now }
    expect(await reconcileReviewDraft(d, { reviews: async () => [earlier], comments: async () => [] })).toBe(d)
  })

  it('records the attempt before the first write, so a crash after it reconciles', async () => {
    await saveReviewDraft(draft())
    failAt = 0
    await expect(submitReviewDraft(sdk, auth(BOB), REPO, draft(), MEMBER, undefined, NO_CHAIN)).rejects.toThrow('network dropped')
    expect((await loadReviewDraft('devnet', BOB, PR))?.attemptedAt).toBeTypeOf('number')
  })

  it("refuses to submit another identity's draft", async () => {
    await expect(submitReviewDraft(sdk, auth(ALICE), REPO, draft(), MEMBER, undefined, NO_CHAIN)).rejects.toThrow(/another identity/)
    expect(writes).toHaveLength(0)
  })
})
