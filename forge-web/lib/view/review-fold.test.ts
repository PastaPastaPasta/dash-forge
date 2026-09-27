/**
 * The Reviewers card and "since your review", ported from `dg`'s `threads.rs` tests
 * (`reviewer_rows_cover_every_standing`, `new_commits_since_your_review`) so the web and the CLI
 * agree on every standing.
 */

import { describe, expect, it } from 'vitest'

import { countApprovals, RoleOracle, type Review } from '../rules/v2'
import { reviewerRows, sinceYourReview } from './review-fold'

const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)

const review = (id: string, reviewer: string, verdict: number, commitOid: string, createdAt: number): Review => ({ id, reviewer, verdict, commitOid, createdAt })

describe('reviewerRows', () => {
  it('covers every standing, as dg does', () => {
    const oracle = new RoleOracle([
      { identity: 'm', role: 'maintainer', createdAt: 0 },
      { identity: 'w', role: 'writer', createdAt: 0 },
      { identity: 'd', role: 'writer', createdAt: 0 },
      { identity: 's', role: 'writer', createdAt: 0 },
    ])
    const reviews = [
      review('r-m', 'm', 1, H2, 10),
      review('r-w', 'w', 2, H2, 11),
      review('r-s', 's', 1, H1, 5),
      review('r-d', 'd', 2, H1, 6),
      review('r-x', 'stranger', 1, H2, 12),
      review('r-c', 'chatty', 3, H2, 13),
      review('r-q', 'q', 1, H1, 1),
    ]
    const dismissed = [{ reviewId: 'r-d', reason: 'stale' }]
    const requested = [
      { identity: 'q', requestedAt: 7 },
      { identity: 'new', requestedAt: 8 },
    ]
    const approvals = countApprovals(reviews, oracle, H2, new Set(['r-d']))
    const rows = reviewerRows(reviews, requested, dismissed, approvals, oracle, H2)
    const state = Object.fromEntries(rows.map((r) => [r.identity, [r.state, r.reRequested]]))
    expect(state['m']).toEqual(['approved', false])
    expect(state['w']).toEqual(['changesRequested', false])
    expect(state['s']).toEqual(['stale', false])
    expect(state['d']).toEqual(['dismissed', false])
    expect(state['stranger']).toEqual(['notMember', false])
    expect(state['chatty']).toEqual(['commented', false])
    expect(state['q']).toEqual(['awaiting', true])
    expect(state['new']).toEqual(['awaiting', false])
    expect(rows[0]?.requested && rows[1]?.requested).toBe(true)
    expect(rows.find((r) => r.identity === 'd')?.dismissReason).toBe('stale')
  })
})

describe('sinceYourReview', () => {
  it('counts the head moves after the viewer reviewed an older head', () => {
    const reviews = [review('r', 'me', 2, H1, 10)]
    const updates = [{ createdAt: 5 }, { createdAt: 15 }]
    expect(sinceYourReview(reviews, H2, updates, 'me')).toEqual({ reviewedOid: H1, headOid: H2, headUpdates: 1 })
    expect(sinceYourReview(reviews, H2, updates, 'other')).toBeNull()
    expect(sinceYourReview(reviews, H1, updates, 'me')).toBeNull()
    expect(sinceYourReview(reviews, H2, updates, null)).toBeNull()
  })
})
