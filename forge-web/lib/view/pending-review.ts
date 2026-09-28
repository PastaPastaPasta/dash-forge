/**
 * The pending review's local edits (review-parity R1, §4.1): add, edit and remove a pending
 * comment, set the verdict and summary, and what a submit will write. The draft is kept by
 * `review-writes.ts` (IndexedDB; memory for a private repo) and submitted by
 * `submitReviewDraft`, which is resumable and never writes a document twice. Once a submit has
 * started (`attemptedAt`), the draft is frozen: editing it would make the resumed submit disagree
 * with what already landed, so the page offers only "Retry" or "Discard".
 */

import type { AnchorInput, DraftComment, ReviewDraft, VerdictInput } from '../repo'
import { previewCreate, previewCredits, type CostPreview } from '../sdk'

/**
 * Where a pending review lives, said wherever one is shown: unlike a GitHub pending review it is
 * NOT on the account (a draft on Platform would cost a write per edit), so another browser or
 * device never sees it. It survives reloads and signing out and in again here (it is keyed by
 * network, identity and PR, not by session); a private repo's only lasts while this tab is open.
 */
export function draftWhereabouts(privateRepo: boolean): string {
  return privateRepo
    ? 'Pending comments are saved in this tab only (a private repo’s are never written to disk): submit before closing it. Other browsers and devices do not see them.'
    : 'Pending comments are saved in this browser only, for this identity: other browsers and devices do not see them. They stay through reloads and signing out and in again here.'
}

/** A fresh local draft for `prId` anchored to `headOid`. */
export function newReviewDraft(input: { draftId: string; network: string; identity: string; repoId: string; prId: string; headOid: string; private: boolean; now: number }): ReviewDraft {
  return {
    draftId: input.draftId,
    ...(input.private ? { private: true } : {}),
    network: input.network,
    identity: input.identity,
    repoId: input.repoId,
    prId: input.prId,
    headOid: input.headOid,
    verdict: 'comment',
    summary: '',
    comments: [],
    startedAt: input.now,
  }
}

/** Whether a submit already began: the draft can then only be retried or discarded. */
export function submitStarted(d: ReviewDraft): boolean {
  return d.attemptedAt !== undefined || d.reviewId !== undefined || d.comments.some((c) => c.landedId !== undefined)
}

function editable(d: ReviewDraft): void {
  if (submitStarted(d)) throw new Error('this review is being submitted: retry or discard it first')
}

/**
 * Add a pending comment. An anchor on the draft's own head carries no commit (the submit uses the
 * draft's head); one made on another head (the PR moved since the draft began, and the diff now
 * shows the new head) keeps that head, so it is never filed under a line of the old one.
 */
export function addDraftComment(d: ReviewDraft, localId: string, anchor: AnchorInput, body: string): ReviewDraft {
  editable(d)
  if (body.trim() === '') throw new Error('a comment needs a body')
  const { commitOid, ...rest } = anchor
  const own = commitOid === undefined || commitOid.toLowerCase() === d.headOid.toLowerCase()
  return { ...d, comments: [...d.comments, { localId, anchor: own ? rest : { ...rest, commitOid }, body: body.trim() }] }
}

/**
 * The draft as a submit begins: frozen at once (`attemptedAt`), with the chosen verdict and the
 * trimmed summary, so nothing on the page can edit or re-save it while the documents are written.
 */
export function startSubmit(d: ReviewDraft, verdict: VerdictInput, summary: string, now: number): ReviewDraft {
  const set = submitStarted(d) ? d : setDraftVerdict(d, verdict, summary.trim())
  return set.attemptedAt === undefined ? { ...set, attemptedAt: now } : set
}

export function editDraftComment(d: ReviewDraft, localId: string, body: string): ReviewDraft {
  editable(d)
  if (body.trim() === '') throw new Error('a comment needs a body')
  return { ...d, comments: d.comments.map((c) => (c.localId === localId ? { ...c, body: body.trim() } : c)) }
}

export function removeDraftComment(d: ReviewDraft, localId: string): ReviewDraft {
  editable(d)
  return { ...d, comments: d.comments.filter((c) => c.localId !== localId) }
}

export function setDraftVerdict(d: ReviewDraft, verdict: VerdictInput, summary: string): ReviewDraft {
  editable(d)
  return { ...d, verdict, summary }
}

/**
 * Re-anchor a draft to a new head (the PR moved while it was pending, §4.1): comments whose line
 * `exists` in the new diff move with it; the rest keep the old head and will show as outdated.
 * Returns the new draft and how many comments could not move.
 */
export function reanchorDraft(d: ReviewDraft, headOid: string, exists: (path: string, side: 0 | 1, line: number) => boolean): { draft: ReviewDraft; stranded: number } {
  editable(d)
  let stranded = 0
  const comments = d.comments.map((c): DraftComment => {
    const a = c.anchor
    const lines = a.line === undefined || a.side === undefined ? [] : Array.from({ length: a.line - (a.startLine ?? a.line) + 1 }, (_, i) => (a.startLine ?? a.line!) + i)
    const moves = lines.every((l) => exists(a.path, a.side!, l))
    if (moves) return c
    stranded += 1
    return { ...c, anchor: { ...a, commitOid: c.anchor.commitOid ?? d.headOid } }
  })
  return { draft: { ...d, headOid, comments }, stranded }
}

/**
 * Whether a draft holds nothing worth keeping: no comments, no summary, the default verdict and
 * no submit on record. Anything else (a summary alone, a chosen verdict) stays in this browser.
 */
export function draftIsEmpty(d: ReviewDraft): boolean {
  return d.comments.length === 0 && d.summary.trim() === '' && d.verdict === 'comment' && !submitStarted(d)
}

/** The head a pending comment is anchored to: its own (stranded by a re-anchor) or the draft's. */
export function draftCommentHead(d: ReviewDraft, c: DraftComment): string {
  return c.anchor.commitOid ?? d.headOid
}

/**
 * Split the pending comments into those that belong on the current diff's lines and those
 * anchored to another head (the PR moved since the draft began, or a re-anchor stranded them):
 * a line number on an older head names a different line now, so those are listed apart.
 */
export function splitDraftComments(d: ReviewDraft | null, headOid: string): { onLines: DraftComment[]; elsewhere: DraftComment[] } {
  const onLines: DraftComment[] = []
  const elsewhere: DraftComment[] = []
  for (const c of d?.comments ?? []) (draftCommentHead(d!, c) === headOid ? onLines : elsewhere).push(c)
  return { onLines, elsewhere }
}

/**
 * Whether a read of the PR shows a submitted review whole: the review and every comment it
 * wrote. A node can return the review a block before its last comments, so the page keeps
 * re-reading until all of them show (seen live: one of two threads, until a reload).
 */
/**
 * The wait after a submit before the page stops re-reading and says what is still missing:
 * 1.5 s, growing ×1.5 to 10 s at most, 9 times (about 60 s in all).
 */
export const SUBMIT_WAIT = { attempts: 9, delayMs: 1500, backoff: 1.5, maxDelayMs: 10_000 } as const

/** How many of a submit's comments the page shows (the review itself aside). */
export function commentsShown(thread: { readonly comments: readonly { readonly id: string }[] }, commentIds: readonly string[]): number {
  const ids = new Set(thread.comments.map((c) => c.id))
  return commentIds.filter((id) => ids.has(id)).length
}

export function reviewShows(
  thread: { readonly reviews: readonly { readonly id: string }[]; readonly comments: readonly { readonly id: string }[] },
  submitted: { readonly reviewId: string; readonly commentIds: readonly string[] },
): boolean {
  if (!thread.reviews.some((r) => r.id === submitted.reviewId)) return false
  const ids = new Set(thread.comments.map((c) => c.id))
  return submitted.commentIds.every((id) => ids.has(id))
}

/** What the submit will write: the review and each comment, priced as the composers do. */
export function draftCost(d: ReviewDraft): { documents: number; cost: CostPreview } {
  const review = previewCreate('review', { body: d.summary })
  const comments = d.comments.filter((c) => c.landedId === undefined).map((c) => previewCreate('comment', { body: c.body, path: c.anchor.path }))
  const docs = (d.reviewId === undefined ? 1 : 0) + comments.length
  const credits = (d.reviewId === undefined ? review.credits : 0) + comments.reduce((n, c) => n + c.credits, 0)
  return { documents: docs, cost: previewCredits(credits) }
}

/** "Your Request changes is recorded with 2 of 6 comments; 4 are still pending in this browser." */
export function partialSubmitMessage(d: ReviewDraft, verdictLabel: string): string {
  const landed = d.comments.filter((c) => c.landedId !== undefined).length
  const total = d.comments.length
  if (d.reviewId === undefined) return `Nothing was written yet; your ${verdictLabel} and its ${total} comment${total === 1 ? '' : 's'} are still pending in this browser.`
  return `Your ${verdictLabel} is recorded with ${landed} of ${total} comment${total === 1 ? '' : 's'}; ${total - landed} ${total - landed === 1 ? 'is' : 'are'} still pending in this browser. Retry to finish it: nothing is written twice.`
}
