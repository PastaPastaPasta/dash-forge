/**
 * The PR header's review summary: the forge-v2 approval fold (`countApprovals`, `forge-v2.md`
 * §6) shown exactly, plus every other reviewer's standing and why it does not count
 * (`ux-dx-spec.md` §5.7):
 *
 *  - counted approvals and change requests on the current head, by role;
 *  - "stale — new commits since": a member's newest verdict was on an older head;
 *  - "doesn't count (not a maintainer or writer)": the reviewer was not a member when they
 *    reviewed, or is not one now;
 *  - "not counted (triage)" / "(reader)": a member who is not an approver (RC2 roles: consensus
 *    records their member verdict; only maintainers and role-1 writers count);
 *  - the PR author's own verdict never counts (GitHub: authors can't approve their own PR) and
 *    is labelled "author, not counted".
 */

import { countApprovals, isApprover, type Review, type Role, type RoleOracle } from '../rules/v2'

import { compareKey } from '../rules'
import { importedVerdictOf, trustedOrigin, type ImportedVerdict, type Origin } from '../repo/provenance'
import { plural } from './format'

/**
 * The verdict an approve or request-changes review states, whoever wrote it: a member's 1/2, or a
 * non-member's 4/5 (RC1 R-16), which consensus records and the fold never counts. Null otherwise.
 */
function statedVerdict(code: number): 'approve' | 'changes' | null {
  if (code === 1 || code === 4) return 'approve'
  return code === 2 || code === 5 ? 'changes' : null
}

export type ReviewerStanding =
  | { readonly kind: 'approved'; readonly role: Role }
  | { readonly kind: 'changes'; readonly role: Role }
  | { readonly kind: 'author'; readonly verdict: 'approve' | 'changes' }
  | { readonly kind: 'stale'; readonly verdict: 'approve' | 'changes'; readonly commitOid: string }
  | { readonly kind: 'not-member'; readonly verdict: 'approve' | 'changes' }
  /** A member who was not an approver (triage or reader) when they reviewed, or is not one now. */
  | { readonly kind: 'not-approver'; readonly verdict: 'approve' | 'changes'; readonly role: Role }

export interface ReviewerRow {
  readonly reviewer: string
  readonly standing: ReviewerStanding
}

export interface ReviewSummary {
  readonly rows: readonly ReviewerRow[]
  readonly approvedBy: { readonly maintainers: number; readonly writers: number }
  readonly changesRequestedBy: readonly string[]
}

/**
 * Summarize a PR's reviews against `headOid`. `reviews` must already be the well-formed ones
 * (the fold's input). Comment-only verdicts (3), unknown ones and `dismissed` reviews (which
 * the fold treats as comments) neither count nor show here.
 */
export function summarizeReviews(
  reviews: readonly Review[],
  oracle: RoleOracle,
  headOid: string,
  author: string,
  dismissed: ReadonlySet<string> = new Set(),
): ReviewSummary {
  const counted = countApprovals(reviews, oracle, headOid, dismissed, author)
  const approvers = new Set(counted.approvers)
  const changes = new Set(counted.changesRequested)
  const newest = new Map<string, Review>()
  const verdicts = reviews.filter((r) => statedVerdict(r.verdict) !== null && !dismissed.has(r.id))
  for (const r of [...verdicts].sort(compareKey)) newest.set(r.reviewer, r)

  const rows: ReviewerRow[] = []
  let maintainers = 0
  let writers = 0
  for (const [reviewer, r] of newest) {
    const role = oracle.currentRole(reviewer)
    const verdict = statedVerdict(r.verdict) as 'approve' | 'changes'
    if (approvers.has(reviewer) && role !== null) {
      if (role === 'maintainer') maintainers += 1
      else writers += 1
      rows.push({ reviewer, standing: { kind: 'approved', role } })
    } else if (changes.has(reviewer) && role !== null) {
      rows.push({ reviewer, standing: { kind: 'changes', role } })
    } else if (reviewer === author) {
      rows.push({ reviewer, standing: { kind: 'author', verdict } })
    } else if (role === null || !oracle.memberAt(reviewer, r.createdAt)) {
      rows.push({ reviewer, standing: { kind: 'not-member', verdict } })
    } else if (!isApprover(role) || !oracle.approverAt(reviewer, r.createdAt)) {
      rows.push({ reviewer, standing: { kind: 'not-approver', verdict, role } })
    } else {
      rows.push({ reviewer, standing: { kind: 'stale', verdict, commitOid: r.commitOid } })
    }
  }
  const rank = (s: ReviewerStanding): number => ({ approved: 0, changes: 1, author: 2, stale: 3, 'not-approver': 4, 'not-member': 5 })[s.kind]
  rows.sort((a, b) => rank(a.standing) - rank(b.standing))
  return { rows, approvedBy: { maintainers, writers }, changesRequestedBy: [...changes] }
}

/** "2 maintainers", "1 maintainer and 1 writer". */
export function approverPhrase({ maintainers, writers }: ReviewSummary['approvedBy']): string {
  const parts = [maintainers > 0 ? plural(maintainers, 'maintainer') : '', writers > 0 ? plural(writers, 'writer') : ''].filter((p) => p !== '')
  return parts.join(' and ')
}

// ---------------------------------------------------------------------------
// The Reviewers card and "new commits since your review" (review-parity R9, R11–R13)
// ---------------------------------------------------------------------------

/** A reviewer's standing on the PR. Parity: `dg`'s `threads::Standing`. */
export type Standing = 'approved' | 'changesRequested' | 'commented' | 'awaiting' | 'stale' | 'dismissed' | 'notMember' | 'notApprover' | 'author'

/** Human wording, as `dg pr view` prints it. */
export const STANDING_LABEL: Readonly<Record<Standing, string>> = {
  approved: 'Approved',
  changesRequested: 'Changes requested',
  commented: 'Commented',
  awaiting: 'Awaiting review',
  stale: 'Stale — new commits since',
  dismissed: 'Dismissed',
  notMember: "Doesn't count (not a maintainer or writer)",
  notApprover: 'Not counted (triage or reader)',
  author: 'Author, not counted',
}

/** One row of the Reviewers card. Parity: `dg`'s `threads::ReviewerRow`. */
export interface ReviewerCardRow {
  readonly identity: string
  readonly state: Standing
  /** A standing request (not removed). */
  readonly requested: boolean
  readonly requestedAt: number | null
  /** Requested again after they had reviewed. */
  readonly reRequested: boolean
  /** Their newest review (any verdict), for display. */
  readonly reviewId: string | null
  /**
   * The review "Dismiss review" dismisses: the one that counts on the head for them (the newest
   * approve / request-changes on the head, not dismissed, made while a member — exactly what
   * `countApprovals` stands on), or null when none counts.
   */
  readonly dismissId: string | null
  /** The head their newest review was on. */
  readonly reviewedOid: string | null
  /** Why their newest review was dismissed. */
  readonly dismissReason: string | null
}

/** The newest review per reviewer by `(createdAt, id)`. */
function newestPerReviewer(reviews: readonly Review[]): Map<string, Review> {
  const out = new Map<string, Review>()
  for (const r of reviews) {
    const held = out.get(r.reviewer)
    if (held === undefined || compareKey(r, held) > 0) out.set(r.reviewer, r)
  }
  return out
}

/**
 * One row per reviewer (anyone with a review) and per requested reviewer, requested first, then
 * by identity. What counts comes first, so a row never disagrees with the approvals fold.
 * Parity: `dg`'s `threads::reviewer_rows` (its test `reviewer_rows_cover_every_standing` is
 * ported in `review-fold.test.ts`).
 */
export function reviewerRows(
  reviews: readonly Review[],
  requested: readonly { readonly identity: string; readonly requestedAt: number }[],
  dismissed: readonly { readonly reviewId: string; readonly reason: string }[],
  approvals: { readonly approvers: readonly string[]; readonly changesRequested: readonly string[] },
  oracle: RoleOracle,
  head: string,
  author: string,
): ReviewerCardRow[] {
  const newest = newestPerReviewer(reviews)
  const req = new Map(requested.map((r) => [r.identity, r.requestedAt]))
  const reasons = new Map(dismissed.map((d) => [d.reviewId, d.reason]))
  // The review each counted reviewer's standing rests on (countApprovals' own filter, newest wins).
  const counting = newestPerReviewer(
    reviews.filter((r) => (r.verdict === 1 || r.verdict === 2) && r.reviewer !== author && !reasons.has(r.id) && r.commitOid === head && oracle.approverAt(r.reviewer, r.createdAt)),
  )
  const counted = new Set([...approvals.approvers, ...approvals.changesRequested])
  const who = [...new Set([...newest.keys(), ...req.keys()])]
  const rows = who.map((id): ReviewerCardRow => {
    const review = newest.get(id)
    const requestedAt = req.get(id) ?? null
    const awaiting = requestedAt !== null && (review === undefined || review.createdAt <= requestedAt)
    const dismissal = review === undefined ? undefined : reasons.get(review.id)
    let state: Standing
    if (awaiting) state = 'awaiting'
    else if (approvals.approvers.includes(id)) state = 'approved'
    else if (approvals.changesRequested.includes(id)) state = 'changesRequested'
    else if (dismissal !== undefined) state = 'dismissed'
    else if (id === author && review !== undefined && statedVerdict(review.verdict) !== null) state = 'author'
    else if (review !== undefined && (review.verdict === 4 || review.verdict === 5)) state = 'notMember'
    else if (review !== undefined && (review.verdict === 1 || review.verdict === 2)) {
      if (!oracle.memberAt(id, review.createdAt) || oracle.currentRole(id) === null) state = 'notMember'
      else if (!oracle.approverAt(id, review.createdAt) || !oracle.currentApprover(id)) state = 'notApprover'
      else if (review.commitOid !== head) state = 'stale'
      else state = 'commented'
    } else state = 'commented'
    return {
      identity: id,
      state,
      requested: requestedAt !== null,
      requestedAt,
      reRequested: awaiting && review !== undefined,
      reviewId: review?.id ?? null,
      dismissId: counted.has(id) ? counting.get(id)?.id ?? null : null,
      reviewedOid: review?.commitOid ?? null,
      dismissReason: dismissal ?? null,
    }
  })
  return rows.sort((a, b) => Number(b.requested) - Number(a.requested) || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0))
}

/** "New commits since your review": the viewer's newest review is on an older head. */
export interface SinceYourReview {
  readonly reviewedOid: string
  readonly headOid: string
  /** How many times the head moved after that review. */
  readonly headUpdates: number
}

/** The marker for `viewer`, or null (no review, or their newest is on the head). Parity: `dg`'s `since_your_review`. */
export function sinceYourReview(
  reviews: readonly Review[],
  head: string,
  headUpdates: readonly { readonly createdAt: number }[],
  viewer: string | null,
): SinceYourReview | null {
  if (viewer === null) return null
  const mine = newestPerReviewer(reviews).get(viewer)
  if (mine === undefined || mine.commitOid === head) return null
  return { reviewedOid: mine.commitOid, headOid: head, headUpdates: headUpdates.filter((h) => h.createdAt >= mine.createdAt).length }
}

// ---------------------------------------------------------------------------
// Reviewers on the source forge (a mirrored PR, QW-017)
// ---------------------------------------------------------------------------

/** A reviewer on the source forge, as a trusted mirror's imported reviews record them. */
export interface ImportedReviewer {
  /** The source forge's login (`thephez`). */
  readonly login: string
  /** `github.com`, … (`''` when the import recorded no URL). */
  readonly host: string
  readonly verdict: ImportedVerdict
}

/** What {@link importedReviewers} reads of a review. */
export interface ImportedReviewInput {
  readonly reviewer: string
  readonly body: string
  readonly createdAt: number
  readonly origin?: Origin | null
}

/**
 * A mirrored PR's reviewers on the source forge (QW-017): each review a trusted mirror imported
 * (`trustedOrigin`) names its source reviewer and verdict (`importedVerdictOf`). Per login, the
 * newest approval or change request stands over later plain comments, as GitHub's Reviewers
 * list shows it; a login with only comments shows as commented. Sorted by login.
 *
 * `mirrorOnly` is the signers every one of whose reviews was imported: the mirror identity,
 * whose own row ("Commented") says nothing about who reviewed, so the card leaves it out.
 */
export function importedReviewers(
  reviews: readonly ImportedReviewInput[],
  trusted: ReadonlySet<string> | null,
): { readonly reviewers: ImportedReviewer[]; readonly mirrorOnly: ReadonlySet<string> } {
  const native = new Set<string>()
  const signers = new Set<string>()
  const byLogin = new Map<string, ImportedReviewer & { readonly at: number }>()
  const standing = (v: ImportedVerdict): boolean => v !== 'commented'
  for (const r of reviews) {
    signers.add(r.reviewer)
    const origin = trustedOrigin(r.origin, r.reviewer, trusted)
    if (origin === null || origin.author === '') {
      native.add(r.reviewer)
      continue
    }
    const verdict = importedVerdictOf(r.body) ?? 'commented'
    const at = origin.createdAt || r.createdAt
    const held = byLogin.get(origin.author)
    // A standing verdict beats a comment; between two of the same weight the newer wins.
    const wins = held === undefined || (standing(verdict) === standing(held.verdict) ? at >= held.at : standing(verdict))
    if (wins) byLogin.set(origin.author, { login: origin.author, host: origin.host, verdict, at })
  }
  const reviewers = [...byLogin.values()]
    .sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()))
    .map(({ login, host, verdict }) => ({ login, host, verdict }))
  return { reviewers, mirrorOnly: new Set([...signers].filter((s) => !native.has(s))) }
}
