/**
 * Reviews this tab submitted that the node it reads may not show yet (QW3-047): a review is on
 * Platform once its write is confirmed, but a node a few blocks behind still answers without it,
 * and a reload then shows no trace of it. Each confirmed review is remembered for this browser
 * session (sessionStorage, per network, repo, PR and reviewer) until a read shows it or it is
 * {@link OWN_REVIEW_TTL_MS} old, so the PR page can say "your review is on Platform" meanwhile.
 * Nothing about it is trusted: it only words a note, never a verdict or a count.
 */

/** How long a submitted review is waited for before the note is dropped. */
export const OWN_REVIEW_TTL_MS = 15 * 60_000

export interface OwnReview {
  /** The review document's id. */
  readonly id: string
  /** The verdict, when submitted with one from the composer; 'review' from the review drawer. */
  readonly verdict: 'approve' | 'requestChanges' | 'comment' | 'review'
  /** When it was confirmed (ms). */
  readonly at: number
}

const key = (scope: string): string => `forge:own-reviews:${scope}`

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function load(scope: string): OwnReview[] {
  try {
    const raw = storage()?.getItem(key(scope))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((r): r is OwnReview => typeof r?.id === 'string' && typeof r?.verdict === 'string' && typeof r?.at === 'number') : []
  } catch {
    return []
  }
}

function save(scope: string, rows: readonly OwnReview[]): void {
  try {
    if (rows.length === 0) storage()?.removeItem(key(scope))
    else storage()?.setItem(key(scope), JSON.stringify(rows))
  } catch {
    // No storage: the note shows until this page view ends.
  }
}

/** The scope a PR's own reviews are kept under. */
export function ownReviewScope(network: string, repoId: string, number: number, reviewer: string): string {
  return `${network}:${repoId}:${number}:${reviewer}`
}

/** Remember a review this tab just submitted (confirmed on Platform). */
export function rememberOwnReview(scope: string, review: OwnReview): void {
  save(scope, [...load(scope).filter((r) => r.id !== review.id), review])
}

/** The remembered reviews a read has not shown yet (`shown`: the review ids the page read), newest first. Reads only. */
export function unshownOwnReviews(scope: string, shown: ReadonlySet<string>, now = Date.now()): OwnReview[] {
  return load(scope)
    .filter((r) => !shown.has(r.id) && now - r.at < OWN_REVIEW_TTL_MS)
    .sort((a, b) => b.at - a.at)
}

/** Forget the remembered reviews a read shows, and expired ones. */
export function forgetShownOwnReviews(scope: string, shown: ReadonlySet<string>, now = Date.now()): void {
  const all = load(scope)
  const left = all.filter((r) => !shown.has(r.id) && now - r.at < OWN_REVIEW_TTL_MS)
  if (left.length !== all.length) save(scope, left)
}
