/**
 * The PR-side pure logic: comment documents as views (anchors through `anchorOf`), review
 * comments grouped under their review, inline thread placement, the review fold summary, and
 * the byte encodings of `patch`, `packManifest` and ref updates, which must match forge-core
 * (`collab::v2::patch_props`, `RepoService::write_pack_manifest` / `write_ref_update`).
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { base58Decode } from '../auth/base58'
import { RoleOracle, type Review } from '../rules/v2'
import { mergeTimeline, toCommentView, type CommentView } from '../view/issues-view'
import { anchorLabel, extendSelection, placeThreads, rangeKeys, repliesByRoot } from '../view/inline-threads'
import { approverPhrase, summarizeReviews } from '../view/review-fold'
import type { ReviewView } from './issues'
import { refUpdateData, refUpdateType } from './push'
import { commentData } from './review-writes'
import { patchData } from './writes'

const HEAD = 'ab'.repeat(20)
const OLD = 'cd'.repeat(20)
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const ID_A = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF'
const ID_B = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'

describe('comment documents as views (anchors read by anchorOf)', () => {
  const doc = (extra: Record<string, unknown>) => ({ $id: ID_A, $ownerId: ID_B, $createdAt: 5, targetId: REPO, body: 'hi', ...extra })

  it('writes the contract fields and reads them back, a range included', () => {
    const data = commentData({ targetId: REPO, body: 'Nit', anchor: { path: 'src/a.ts', line: 7, startLine: 5, side: 0, commitOid: HEAD } }, ID_B)
    expect(Object.keys(data)).toEqual(['targetId', 'body', 'path', 'line', 'side', 'startLine', 'commitOid'])
    const v = toCommentView(doc({ path: 'src/a.ts', line: 7, startLine: 5, side: 0, commitOid: hexToBytes(HEAD) }))
    expect(v.anchor).toEqual({ path: 'src/a.ts', line: 7, startLine: 5, side: 0, commitOid: HEAD })
    expect(anchorLabel(v.anchor as NonNullable<typeof v.anchor>)).toBe('src/a.ts lines 5–7 (old)')
  })

  it('a body is shown as written: no anchor block is read from it', () => {
    const body = '<!-- forge-anchor {"path":"x.md","line":3,"side":1} -->\nhi'
    const v = toCommentView(doc({ body }))
    expect(v.anchor).toBeNull()
    expect(v.body).toBe(body)
  })

  it('a malformed anchor is a general comment; a path alone is file-level', () => {
    expect(toCommentView(doc({ path: 'a.ts', line: 3 })).anchor).toBeNull() // a line needs a side
    expect(toCommentView(doc({ path: 'a.ts', line: 3, startLine: 4, side: 1 })).anchor).toBeNull()
    expect(toCommentView(doc({ path: 'a.ts' })).anchor).toEqual({ path: 'a.ts', line: null, startLine: null, side: null, commitOid: '' })
  })

  it('reads replyTo and reviewId as identifiers', () => {
    // As the SDK returns them: base58, or base64 of the 32 bytes.
    const v = toCommentView(doc({ replyTo: Buffer.from(base58Decode(ID_A)).toString('base64'), reviewId: ID_B }))
    expect(v.replyTo).toBe(ID_A)
    expect(v.reviewId).toBe(ID_B)
    expect(toCommentView(doc({})).reviewId).toBeNull()
  })
})

describe('review comments are grouped under their review (groupReviewComments)', () => {
  const review = (id: string, reviewer: string, commentCount: number | null): ReviewView => ({
    id,
    reviewer,
    verdict: 'requestChanges',
    verdictCode: 2,
    commitOid: HEAD,
    body: 'see inline',
    commentCount,
    createdAt: 10,
  })

  it("nests the reviewer's own comments, leaves others alone, and reports what has landed", () => {
    const cs = [
      comment('c11', { author: 'R', reviewId: 'rv' }),
      comment('c12', { author: 'X', reviewId: 'rv' }), // not the reviewer: stands alone
      comment('c13'),
    ]
    const items = mergeTimeline(cs, [], [], [review('rv', 'R', 3)])
    expect(items.map((i) => (i.kind === 'comment' ? i.comment.id : i.kind))).toEqual(['review', 'c12', 'c13'])
    const r = items[0]
    if (r?.kind !== 'review') throw new Error('expected the review first')
    expect(r.comments.map((c) => c.id)).toEqual(['c11'])
    expect(r.expected).toBe(3)
  })

  it('a reply to a grouped review comment stands alone in the timeline and joins its inline thread', () => {
    const anchor = { path: 'a.ts', line: 3, startLine: 3, side: 1 as const, commitOid: HEAD }
    const cs = [comment('c11', { author: 'R', reviewId: 'rv', anchor }), comment('c12', { author: 'X', replyTo: 'c11' })]
    const items = mergeTimeline(cs, [], [], [review('rv', 'R', 1)])
    expect(items.map((i) => (i.kind === 'comment' ? i.comment.id : i.kind))).toEqual(['review', 'c12'])
    const placed = placeThreads(cs, HEAD, () => true)
    expect(placed.current.get('1:3:a.ts')?.map((t) => [t.root.id, t.replies.map((x) => x.id)])).toEqual([['c11', ['c12']]])
  })

  it('a reply whose parent was deleted says so; a reply to a present comment does not', () => {
    const cs = [comment('c1'), comment('c2', { replyTo: 'c1' }), comment('c3', { replyTo: 'gone' })]
    const items = mergeTimeline(cs, [], [], [])
    expect(items.map((i) => (i.kind === 'comment' ? [i.comment.id, i.orphaned ?? null] : null))).toEqual([
      ['c1', null],
      ['c2', null],
      ['c3', 'deleted'],
    ])
    // A private repo where some comment could not be opened: the parent may be that one.
    const hidden = mergeTimeline(cs, [], [], [], true)
    expect(hidden.map((i) => (i.kind === 'comment' ? i.orphaned ?? null : null))).toEqual([null, null, 'hidden'])
  })
})

function comment(id: string, extra: Partial<CommentView> = {}): CommentView {
  return { id, author: 'A', body: id, createdAt: Number(id.replace(/\D/g, '')) || 0, replyTo: null, anchor: null, reviewId: null, imported: false, ...extra }
}

describe('inline thread placement', () => {
  const on = (path: string, line: number, commitOid = HEAD, side: 0 | 1 = 1) => ({ anchor: { path, line, startLine: line, side, commitOid } })

  it('places a range under its last line, and file-level threads apart', () => {
    const cs = [
      comment('c1', { anchor: { path: 'a.ts', line: 9, startLine: 4, side: 1, commitOid: HEAD } }),
      comment('c2', { anchor: { path: 'a.ts', line: null, startLine: null, side: null, commitOid: HEAD } }),
      comment('c3', { anchor: { path: 'gone.ts', line: null, startLine: null, side: null, commitOid: HEAD } }),
    ]
    const placed = placeThreads(cs, HEAD, () => true, (path) => path === 'a.ts')
    expect([...placed.current.keys()]).toEqual(['1:9:a.ts'])
    expect(placed.fileLevel.map((t) => t.root.id)).toEqual(['c2'])
    expect(placed.outdated.map((t) => t.root.id)).toEqual(['c3'])
  })

  it('shows threads on the current head under their line, replies included', () => {
    const cs = [comment('c1', on('a.ts', 3)), comment('c2', { replyTo: 'c1' }), comment('c3', { replyTo: 'c2' }), comment('c4')]
    const placed = placeThreads(cs, HEAD, () => true)
    const t = placed.current.get('1:3:a.ts')
    expect(t?.map((x) => [x.root.id, x.replies.map((r) => r.id)])).toEqual([['c1', ['c2', 'c3']]])
    expect(placed.outdated).toEqual([])
    expect(placed.general.map((c) => c.id)).toEqual(['c4'])
  })

  it('collapses comments on an older head, or on a line the diff no longer shows, and counts them', () => {
    const cs = [
      comment('c1', on('a.ts', 3, OLD)),
      comment('c2', { replyTo: 'c1' }),
      comment('c3', on('a.ts', 99)),
      comment('c4', on('b.ts', 1, '')),
    ]
    const placed = placeThreads(cs, HEAD, (path, _side, line) => path === 'a.ts' && line < 50)
    expect(placed.current.size).toBe(0)
    expect(placed.outdated.map((t) => t.root.id)).toEqual(['c1', 'c3', 'c4'])
    expect(placed.outdatedCount).toBe(4)
  })

  it('keeps sides apart and survives a reply cycle', () => {
    const cs = [comment('c1', on('a.ts', 3, HEAD, 0)), comment('c2', on('a.ts', 3, HEAD, 1)), comment('c3', { replyTo: 'c4' }), comment('c4', { replyTo: 'c3' })]
    const placed = placeThreads(cs, HEAD, null)
    expect([...placed.current.keys()].sort()).toEqual(['0:3:a.ts', '1:3:a.ts'])
    expect(placed.general.map((c) => c.id)).toEqual(['c3', 'c4'])
  })

  it('groups every reply under its thread root (a reply to a reply too); general replies stay out', () => {
    const cs = [comment('c1', on('a.ts', 3)), comment('c2', { replyTo: 'c1' }), comment('c3', { replyTo: 'c2' }), comment('g1'), comment('g2', { replyTo: 'g1' })]
    const byRoot = repliesByRoot(cs)
    expect([...byRoot.keys()]).toEqual(['c1'])
    expect(byRoot.get('c1')?.map((c) => c.id)).toEqual(['c2', 'c3'])
  })

  it('tints every line a range covers (rangeKeys), one-line threads none', () => {
    const cs = [comment('c1', { anchor: { path: 'a.ts', line: 5, startLine: 3, side: 1, commitOid: HEAD } }), comment('c2', on('a.ts', 9))]
    const placed = placeThreads(cs, HEAD, () => true)
    expect([...rangeKeys(placed.current)].sort()).toEqual(['1:3:a.ts', '1:4:a.ts', '1:5:a.ts'])
  })
})

describe('line selection (drag or shift-click)', () => {
  it('extends on the same file and side, in order; anything else starts over', () => {
    const one = extendSelection(null, 'a.ts', 1, 7, false)
    expect(one).toEqual({ path: 'a.ts', side: 1, startLine: 7, line: 7 })
    expect(extendSelection(one, 'a.ts', 1, 3, true)).toEqual({ path: 'a.ts', side: 1, startLine: 3, line: 7 })
    expect(extendSelection(one, 'a.ts', 1, 9, true)).toEqual({ path: 'a.ts', side: 1, startLine: 7, line: 9 })
    expect(extendSelection(one, 'a.ts', 0, 9, true)).toEqual({ path: 'a.ts', side: 0, startLine: 9, line: 9 })
    expect(extendSelection(one, 'b.ts', 1, 9, true)).toEqual({ path: 'b.ts', side: 1, startLine: 9, line: 9 })
    expect(extendSelection(one, 'a.ts', 1, 9, false)).toEqual({ path: 'a.ts', side: 1, startLine: 9, line: 9 })
  })
})

describe('review fold summary', () => {
  const M1 = 'maint-1'
  const M2 = 'maint-2'
  const W = 'writer-1'
  const S = 'stranger'
  const oracle = new RoleOracle([
    { identity: M1, role: 'maintainer', createdAt: 1 },
    { identity: M2, role: 'maintainer', createdAt: 1 },
    { identity: W, role: 'writer', createdAt: 50 },
  ])
  const r = (id: string, reviewer: string, verdict: number, commitOid: string, createdAt: number): Review => ({ id, reviewer, verdict, commitOid, createdAt })

  it('shows the fold exactly: counted, stale, non-member, and the author not counted', () => {
    const reviews = [
      r('r1', M1, 1, HEAD, 10),
      r('r2', M2, 1, HEAD, 11),
      r('r3', W, 2, OLD, 60), // a member, but on an older head: stale
      r('r4', S, 1, HEAD, 12), // never a member
      r('r5', W, 1, HEAD, 20), // before W joined (50): doesn't count
      r('r6', W, 3, HEAD, 70), // comment-only: neither counts nor clears
    ]
    // M2 opened the PR: their own approval is shown, never counted (QW-003).
    const s = summarizeReviews(reviews, oracle, HEAD, M2)
    expect(s.approvedBy).toEqual({ maintainers: 1, writers: 0 })
    expect(approverPhrase(s.approvedBy)).toBe('1 maintainer')
    expect(s.rows).toEqual([
      { reviewer: M1, standing: { kind: 'approved', role: 'maintainer' } },
      { reviewer: M2, standing: { kind: 'author', verdict: 'approve' } },
      { reviewer: W, standing: { kind: 'stale', verdict: 'changes', commitOid: OLD } },
      { reviewer: S, standing: { kind: 'not-member', verdict: 'approve' } },
    ])
  })

  it('a dismissed review neither counts nor shows, as in the fold', () => {
    const s = summarizeReviews([r('r1', M1, 1, HEAD, 10), r('r2', M2, 2, HEAD, 11)], oracle, HEAD, 'someone', new Set(['r2']))
    expect(s.changesRequestedBy).toEqual([])
    expect(s.rows).toEqual([{ reviewer: M1, standing: { kind: 'approved', role: 'maintainer' } }])
  })

  it('dismissing a newer request for changes leaves the earlier approval standing', () => {
    const s = summarizeReviews([r('r1', M1, 1, HEAD, 10), r('r2', M1, 2, HEAD, 11)], oracle, HEAD, 'someone', new Set(['r2']))
    expect(s.changesRequestedBy).toEqual([])
    expect(s.rows).toEqual([{ reviewer: M1, standing: { kind: 'approved', role: 'maintainer' } }])
  })

  it('a newer request for changes replaces an approval', () => {
    const s = summarizeReviews([r('r1', M1, 1, HEAD, 10), r('r2', M1, 2, HEAD, 11)], oracle, HEAD, 'someone')
    expect(s.changesRequestedBy).toEqual([M1])
    expect(s.rows).toEqual([{ reviewer: M1, standing: { kind: 'changes', role: 'maintainer' } }])
    expect(approverPhrase({ maintainers: 1, writers: 1 })).toBe('1 maintainer and 1 writer')
  })
})

describe('document encodings (forge-core parity; packManifest is covered with lib/storage)', () => {
  const enc = (s: string) => new TextEncoder().encode(s)

  it('patch: ref-name hashes are sha256 of the names; head and source repo are raw bytes', () => {
    const data = patchData({
      title: 'Fix it',
      body: '',
      baseRefName: 'refs/heads/main',
      sourceRepoId: REPO,
      sourceRefName: 'refs/heads/my-fix',
      headOid: HEAD,
    })
    expect(Object.keys(data)).toEqual(['title', 'baseRefNameHash', 'baseRefName', 'sourceRepoId', 'sourceRefNameHash', 'sourceRefName', 'headOid'])
    expect(bytesToHex(data['baseRefNameHash'] as Uint8Array)).toBe(bytesToHex(sha256(enc('refs/heads/main'))))
    expect(bytesToHex(data['sourceRefNameHash'] as Uint8Array)).toBe(bytesToHex(sha256(enc('refs/heads/my-fix'))))
    expect(data['sourceRepoId']).toEqual(base58Decode(REPO))
    expect(bytesToHex(data['headOid'] as Uint8Array)).toBe(HEAD)
    expect(() => patchData({ title: ' ', body: '', baseRefName: 'refs/heads/main', sourceRepoId: REPO, sourceRefName: 'x', headOid: HEAD })).toThrow()
    expect(() => patchData({ title: 't', body: '', baseRefName: 'refs/heads/a b', sourceRepoId: REPO, sourceRefName: 'x', headOid: HEAD })).toThrow()
  })

  it('patch: carries no draft field (a draft is a kind-14 transition written after the patch)', () => {
    const input = { title: 't', body: '', baseRefName: 'refs/heads/main', sourceRepoId: REPO, sourceRefName: 'refs/heads/x', headOid: HEAD }
    expect('draft' in patchData({ ...input, draft: true })).toBe(false)
    expect('draft' in patchData(input)).toBe(false)
  })

  it('ref update: sha256 name hash, raw oids, force, and protected routing', () => {
    const d = refUpdateData({ refName: 'refs/heads/main', newOid: HEAD, prevOid: OLD })
    expect(bytesToHex(d['refNameHash'] as Uint8Array)).toBe(bytesToHex(sha256(enc('refs/heads/main'))))
    expect(bytesToHex(d['newOid'] as Uint8Array)).toBe(HEAD)
    expect(bytesToHex(d['prevOid'] as Uint8Array)).toBe(OLD)
    expect(d['force']).toBe(false)
    expect('prevOid' in refUpdateData({ refName: 'refs/heads/x', newOid: HEAD })).toBe(false)
    expect(() => refUpdateData({ refName: 'refs/heads/a\nb', newOid: HEAD })).toThrow()
    expect(refUpdateType('refs/heads/main', ['refs/heads/main'])).toBe('protectedRefUpdate')
    expect(refUpdateType('refs/heads/release/1', ['refs/heads/release/*'])).toBe('protectedRefUpdate')
    expect(refUpdateType('refs/heads/dev', ['refs/heads/main'])).toBe('refUpdate')
  })
})

