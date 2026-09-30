/**
 * A mirrored PR's review comments, placed under the review they were submitted with (QW2-010).
 *
 * An import writes each source review as a `review` and each review comment as an anchored
 * `comment`, but the source's review id is not recorded (`reviewId` is empty), so the
 * Conversation tab listed every review comment as a card of its own: dips #161 read as 283 flat
 * cards. GitHub's own shape is recoverable from the provenance each carries (the source author and
 * time): a review comment belongs to its author's first review submitted at or after it (a pending
 * review's comments are written before it is submitted; a single comment or a reply is its own
 * review, submitted with it). Only trusted provenance is used (`trustedOrigin`: the signer may
 * mirror), and only a mirrored review comment ever moves.
 */

import type { Anchor } from '../rules/review'
import type { Origin } from '../repo/provenance'
import { importedVerdictOf, searchableBody } from '../repo/provenance'
import type { TimelineItem } from './issues-view'

/** Clock slack between a comment and its review's submission at the source (ms). */
export const SUBMIT_SLACK_MS = 2_000
/** A pending review older than this is not taken to hold a comment (ms). */
export const PENDING_MAX_MS = 30 * 24 * 60 * 60_000

type ReviewItem = Extract<TimelineItem, { kind: 'review' }>
type CommentItem = Extract<TimelineItem, { kind: 'comment' }>

/** A mirrored review comment's provenance kind (`(review comment, 2024-11-07)`). */
function isMirroredReviewComment(body: string): boolean {
  return /^> Mirrored from \S+ by @\S+ \(review comment,/.test(body)
}

/**
 * `items` with each mirrored review comment moved under its mirrored review. `originOf` gives an
 * item's trusted provenance, or null (not mirrored, or its signer may not mirror).
 */
export function foldMirroredReviews(items: readonly TimelineItem[], originOf: (item: ReviewItem | CommentItem) => Origin | null): TimelineItem[] {
  // The mirrored reviews per (signer, source host, source author), oldest first.
  const reviewsBy = new Map<string, { item: ReviewItem; at: number }[]>()
  const who = (signer: string, o: Origin): string => `${signer}\u0000${o.host}\u0000${o.author}`
  for (const it of items) {
    if (it.kind !== 'review') continue
    const o = originOf(it)
    if (o === null || o.createdAt <= 0 || importedVerdictOf(it.review.body) === null) continue
    const k = who(it.review.reviewer, o)
    const list = reviewsBy.get(k)
    if (list === undefined) reviewsBy.set(k, [{ item: it, at: o.createdAt }])
    else list.push({ item: it, at: o.createdAt })
  }
  if (reviewsBy.size === 0) return [...items]
  for (const list of reviewsBy.values()) list.sort((a, b) => a.at - b.at)
  const attached = new Map<ReviewItem, { item: CommentItem; at: number }[]>()
  const moved = new Set<CommentItem>()
  for (const it of items) {
    if (it.kind !== 'comment') continue
    const c = it.comment
    // By its provenance kind: most mirrored review comments carry no anchor (the source's line is
    // gone once the PR moved on; the file is named in the text).
    if (c.replyTo !== null || c.reviewId !== null || !isMirroredReviewComment(c.body)) continue
    const o = originOf(it)
    if (o === null || o.createdAt <= 0) continue
    const list = reviewsBy.get(who(c.author, o))
    if (list === undefined) continue
    // The first review at or after the comment (its own submission); only when there is none,
    // one submitted within the clock slack before it.
    const after = list.find((r) => r.at >= o.createdAt && r.at - o.createdAt <= PENDING_MAX_MS)
    const before = after === undefined ? [...list].reverse().find((r) => r.at < o.createdAt && o.createdAt - r.at <= SUBMIT_SLACK_MS) : undefined
    const best = after ?? before
    if (best === undefined) continue
    const into = attached.get(best.item)
    if (into === undefined) attached.set(best.item, [{ item: it, at: o.createdAt }])
    else into.push({ item: it, at: o.createdAt })
    moved.add(it)
  }
  return items.flatMap((it): TimelineItem[] => {
    if (it.kind === 'comment' && moved.has(it)) return []
    if (it.kind !== 'review') return [it]
    const add = attached.get(it)
    if (add === undefined) return [it]
    return [{ ...it, comments: [...it.comments, ...add.sort((a, b) => a.at - b.at).map((c) => c.item.comment)] }]
  })
}

/**
 * A mirrored comment's text as a thread shows it: without the provenance quote (the byline shows
 * who wrote it at the source, and when), and without the leading `` `path` `` (line n) line the
 * import adds, which becomes `file` for the thread's header. An anchored comment's header names
 * its anchor, so only a line naming that same file is lifted.
 */
export function mirroredCommentText(body: string, anchor: Anchor | null): { text: string; file: string | null } {
  const text = searchableBody(body).replace(/^\s+/, '')
  const first = text.split('\n', 1)[0] ?? ''
  const m = /^`([^`]+)`( line \d+)?\s*$/.exec(first)
  if (m === null || (anchor !== null && m[1] !== anchor.path)) return { text, file: null }
  return { text: text.slice(first.length).replace(/^\s+/, ''), file: `${m[1]}${m[2] ?? ''}` }
}

/**
 * Whether a mirrored review says nothing of its own: a "commented" verdict with no text beyond
 * its provenance, and no comments under it. GitHub shows no card for these; the timeline shows a
 * one-line event instead.
 */
export function isEmptyMirroredReview(item: ReviewItem): boolean {
  return item.comments.length === 0 && item.expected === 0 && importedVerdictOf(item.review.body) === 'commented' && searchableBody(item.review.body).trim() === ''
}
