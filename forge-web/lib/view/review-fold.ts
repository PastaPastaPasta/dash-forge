/**
 * The PR header's review summary: the forge-v2 approval fold (`countApprovals`, `forge-v2.md`
 * §6) shown exactly, plus every other reviewer's standing and why it does not count
 * (`ux-dx-spec.md` §5.7):
 *
 *  - counted approvals and change requests on the current head, by role;
 *  - "stale — new commits since": a member's newest verdict was on an older head;
 *  - "doesn't count (not a maintainer or writer)": the reviewer was not a member when they
 *    reviewed, or is not one now;
 *  - a member approving their own PR counts and is labelled "author approval (counted)".
 */

import { countApprovals, type Review, type Role, type RoleOracle } from '../rules/v2'
import { compareKey } from '../rules'

export type ReviewerStanding =
  | { readonly kind: 'approved'; readonly role: Role; readonly self: boolean }
  | { readonly kind: 'changes'; readonly role: Role }
  | { readonly kind: 'stale'; readonly verdict: 'approve' | 'changes'; readonly commitOid: string }
  | { readonly kind: 'not-member'; readonly verdict: 'approve' | 'changes' }

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
 * (the fold's input). Comment-only verdicts (3) and unknown ones neither count nor show here.
 */
export function summarizeReviews(reviews: readonly Review[], oracle: RoleOracle, headOid: string, author: string): ReviewSummary {
  const counted = countApprovals(reviews, oracle, headOid)
  const approvers = new Set(counted.approvers)
  const changes = new Set(counted.changesRequested)
  const newest = new Map<string, Review>()
  for (const r of [...reviews].filter((r) => r.verdict === 1 || r.verdict === 2).sort(compareKey)) newest.set(r.reviewer, r)

  const rows: ReviewerRow[] = []
  let maintainers = 0
  let writers = 0
  for (const [reviewer, r] of newest) {
    const role = oracle.currentRole(reviewer)
    const verdict = r.verdict === 1 ? 'approve' : 'changes'
    if (approvers.has(reviewer) && role !== null) {
      if (role === 'maintainer') maintainers += 1
      else writers += 1
      rows.push({ reviewer, standing: { kind: 'approved', role, self: reviewer === author } })
    } else if (changes.has(reviewer) && role !== null) {
      rows.push({ reviewer, standing: { kind: 'changes', role } })
    } else if (role === null || !oracle.memberAt(reviewer, r.createdAt)) {
      rows.push({ reviewer, standing: { kind: 'not-member', verdict } })
    } else {
      rows.push({ reviewer, standing: { kind: 'stale', verdict, commitOid: r.commitOid } })
    }
  }
  const rank = (s: ReviewerStanding): number => ({ approved: 0, changes: 1, stale: 2, 'not-member': 3 })[s.kind]
  rows.sort((a, b) => rank(a.standing) - rank(b.standing))
  return { rows, approvedBy: { maintainers, writers }, changesRequestedBy: [...changes] }
}

/** "2 maintainers", "1 maintainer and 1 writer". */
export function approverPhrase({ maintainers, writers }: ReviewSummary['approvedBy']): string {
  const part = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  const parts = [maintainers > 0 ? part(maintainers, 'maintainer') : '', writers > 0 ? part(writers, 'writer') : ''].filter((p) => p !== '')
  return parts.join(' and ')
}
