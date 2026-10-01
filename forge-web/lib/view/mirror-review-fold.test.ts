/**
 * QW2-010: a mirrored PR's review comments fold under the review they were submitted with.
 */

import { describe, expect, it } from 'vitest'

import type { Origin } from '../repo/provenance'
import type { ReviewView } from '../repo'
import type { CommentView, TimelineItem } from './issues-view'
import { foldMirroredReviews, isEmptyMirroredReview, mirroredCommentText, nestThreadReplies, PENDING_MAX_MS } from './mirror-review-fold'

const MIRROR = 'MirrorMirrorMirrorMirrorMirrorMirrorMirror1'
const s = (sec: number): number => sec * 1000
const origin = (author: string, sec: number): Origin => ({ author, createdAt: s(sec), url: `https://github.com/o/r/pull/1#x${sec}`, host: 'github.com' })

function review(id: string, author: string, sec: number, verdict = 'commented', text = ''): Extract<TimelineItem, { kind: 'review' }> {
  const r: ReviewView = {
    id,
    reviewer: MIRROR,
    verdict: 'comment',
    verdictCode: 3,
    commitOid: 'a'.repeat(40),
    body: `> Mirrored from github.com/o/r#1 by @${author} (review, ${verdict}, 2024-11-07)\n\n${text}`,
    commentCount: null,
    createdAt: 1000 + sec,
    origin: origin(author, sec),
  }
  return { kind: 'review', at: r.createdAt, review: r, comments: [], expected: 0 }
}

function comment(id: string, author: string, sec: number, kind = 'review comment', anchored = true): Extract<TimelineItem, { kind: 'comment' }> {
  const c: CommentView = {
    id,
    author: MIRROR,
    body: `> Mirrored from github.com/o/r#1 by @${author} (${kind}, 2024-11-07)\n\n\`dip.md\`\n\ntext ${id}`,
    createdAt: 1000 + sec,
    replyTo: null,
    anchor: anchored ? { path: 'dip.md', line: null, startLine: null, side: null, commitOid: 'a'.repeat(40) } : null,
    reviewId: null,
    imported: true,
    origin: origin(author, sec),
  }
  return { kind: 'comment', at: c.createdAt, comment: c }
}

const trusted = (it: Extract<TimelineItem, { kind: 'review' | 'comment' }>): Origin | null => (it.kind === 'review' ? it.review.origin ?? null : it.comment.origin ?? null)

describe('foldMirroredReviews', () => {
  it("puts each review comment under its author's first review submitted at or after it", () => {
    const items: TimelineItem[] = [
      // A pending review: two comments drafted, then submitted.
      comment('c1', 'udjin', 100),
      comment('c2', 'udjin', 160),
      review('r1', 'udjin', 200, 'commented', 'Some notes'),
      // A reply: its own review, submitted with it (a second apart).
      comment('c3', 'hush', 300),
      review('r2', 'hush', 301),
      // A conversation comment and another author's review comment stay where they are.
      comment('c4', 'udjin', 150, 'comment', false),
      comment('c5', 'pasta', 170),
      // A review comment the import wrote without an anchor still folds, by its provenance kind.
      comment('c6', 'udjin', 180, 'review comment', false),
    ]
    const out = foldMirroredReviews(items, trusted)
    const summary = out.map((it) => (it.kind === 'review' ? `${it.review.id}[${it.comments.map((c) => c.id).join(',')}]` : it.kind === 'comment' ? it.comment.id : it.kind))
    expect(summary).toEqual(['r1[c1,c2,c6]', 'r2[c3]', 'c4', 'c5'])
  })

  it('prefers the review submitted with a comment over one a second before it', () => {
    const items: TimelineItem[] = [comment('ca', 'hush', 300), review('ra', 'hush', 300), comment('cb', 'hush', 301), review('rb', 'hush', 301)]
    const out = foldMirroredReviews(items, trusted)
    expect(out.map((it) => (it.kind === 'review' ? `${it.review.id}[${it.comments.map((c) => c.id).join(',')}]` : 'x'))).toEqual(['ra[ca]', 'rb[cb]'])
  })

  it('never reaches past the pending window, and leaves untrusted items alone', () => {
    const items: TimelineItem[] = [comment('c1', 'udjin', 100), review('r1', 'udjin', 100 + PENDING_MAX_MS / 1000 + 1)]
    expect(foldMirroredReviews(items, trusted).filter((it) => it.kind === 'comment')).toHaveLength(1)
    expect(foldMirroredReviews([comment('c1', 'udjin', 100), review('r1', 'udjin', 101)], () => null).filter((it) => it.kind === 'comment')).toHaveLength(1)
  })
})

describe('isEmptyMirroredReview', () => {
  it('is a commented review with only its provenance and no comments', () => {
    expect(isEmptyMirroredReview(review('r', 'a', 1))).toBe(true)
    expect(isEmptyMirroredReview(review('r', 'a', 1, 'commented', 'LGTM overall'))).toBe(false)
    expect(isEmptyMirroredReview(review('r', 'a', 1, 'approved'))).toBe(false)
    expect(isEmptyMirroredReview({ ...review('r', 'a', 1), comments: [comment('c', 'a', 1).comment] })).toBe(false)
  })
})

describe('mirroredCommentText', () => {
  it('drops the provenance quote and the path line the thread header already names', () => {
    const anchor = { path: 'dip.md', line: null, startLine: null, side: null, commitOid: 'a'.repeat(40) } as const
    const head = '> Mirrored from github.com/o/r#1 by @u (review comment, 2024-11-07)\n\n'
    expect(mirroredCommentText(`${head}\`dip.md\` line 12\n\nNeeds more detail.`, anchor)).toEqual({ text: 'Needs more detail.', file: 'dip.md line 12' })
    expect(mirroredCommentText(`${head}\`other.md\`\n\nX`, anchor)).toEqual({ text: '`other.md`\n\nX', file: null })
    // No anchor (the source line is gone): the file is lifted for the header.
    expect(mirroredCommentText(`${head}\`dip-ct.md\`\n\nsame`, null)).toEqual({ text: 'same', file: 'dip-ct.md' })
  })
})

describe('nestThreadReplies (QW2-010)', () => {
  const reply = (id: string, to: string, author: string, sec: number): CommentView => ({ ...comment(id, author, sec).comment, replyTo: to, anchor: null })
  it("takes a reply out of its own review, and that review when it says nothing else", () => {
    const root = comment('c1', 'udjin', 100).comment
    const withRoot = { ...review('r1', 'udjin', 101, 'commented', 'notes'), comments: [root], expected: 1 }
    // GitHub files a reply as a one-comment review of its own
    const replyOnly = { ...review('r2', 'hush', 200), comments: [reply('c2', 'c1', 'hush', 199)], expected: 1 }
    // an approval whose only comment was a reply keeps its card
    const approved = { ...review('r3', 'pasta', 300, 'approved'), comments: [reply('c3', 'c1', 'pasta', 299)], expected: 1 }
    const out = nestThreadReplies([withRoot, replyOnly, approved], new Set(['c1', 'c2', 'c3']))
    expect(out.map((it) => (it.kind === 'review' ? [it.review.id, it.comments.map((c) => c.id), it.expected] : it.kind))).toEqual([
      ['r1', ['c1'], 1],
      ['r3', [], 0],
    ])
    // a reply outside an inline thread stays where it is
    expect(nestThreadReplies([replyOnly], new Set())).toEqual([replyOnly])
  })
})
