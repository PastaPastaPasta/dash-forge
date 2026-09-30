/**
 * The Reviewers card and "since your review", ported from `dg`'s `threads.rs` tests
 * (`reviewer_rows_cover_every_standing`, `new_commits_since_your_review`) so the web and the CLI
 * agree on every standing.
 */

import { describe, expect, it } from 'vitest'

import { countApprovals, RoleOracle, type Review } from '../rules/v2'
import { importedReviewers, reviewerRows, sinceYourReview } from './review-fold'

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
      { identity: 'auth', role: 'maintainer', createdAt: 0 },
    ])
    const reviews = [
      review('r-m', 'm', 1, H2, 10),
      review('r-w', 'w', 2, H2, 11),
      review('r-s', 's', 1, H1, 5),
      review('r-d', 'd', 2, H1, 6),
      review('r-x', 'stranger', 1, H2, 12),
      review('r-c', 'chatty', 3, H2, 13),
      review('r-q', 'q', 1, H1, 1),
      review('r-a', 'auth', 1, H2, 14),
    ]
    const dismissed = [{ reviewId: 'r-d', reason: 'stale' }]
    const requested = [
      { identity: 'q', requestedAt: 7 },
      { identity: 'new', requestedAt: 8 },
    ]
    const approvals = countApprovals(reviews, oracle, H2, new Set(['r-d']), 'auth')
    expect(approvals.approvers).toEqual(['m'])
    const rows = reviewerRows(reviews, requested, dismissed, approvals, oracle, H2, 'auth')
    const state = Object.fromEntries(rows.map((r) => [r.identity, [r.state, r.reRequested]]))
    expect(state['m']).toEqual(['approved', false])
    expect(state['w']).toEqual(['changesRequested', false])
    expect(state['s']).toEqual(['stale', false])
    expect(state['d']).toEqual(['dismissed', false])
    expect(state['stranger']).toEqual(['notMember', false])
    expect(state['chatty']).toEqual(['commented', false])
    expect(state['q']).toEqual(['awaiting', true])
    expect(state['new']).toEqual(['awaiting', false])
    // The PR author's own approval (a maintainer's, on the head) never counts (QW-003).
    expect(state['auth']).toEqual(['author', false])
    expect(rows.find((r) => r.identity === 'auth')?.dismissId).toBeNull()
    expect(rows[0]?.requested && rows[1]?.requested).toBe(true)
    expect(rows.find((r) => r.identity === 'd')?.dismissReason).toBe('stale')
  })
})

describe('reviewerRows: what "Dismiss review" dismisses', () => {
  const oracle = new RoleOracle([{ identity: 'm', role: 'maintainer', createdAt: 0 }])
  const rows = (reviews: Review[], dismissed: { reviewId: string; reason: string }[] = []) =>
    reviewerRows(reviews, [], dismissed, countApprovals(reviews, oracle, H2, new Set(dismissed.map((d) => d.reviewId)), 'author'), oracle, H2, 'author')

  it('an approval then a comment-only review: the approval, not the comment', () => {
    const r = rows([review('appr', 'm', 1, H2, 10), review('chat', 'm', 3, H2, 11)])[0]
    expect(r?.state).toBe('approved')
    expect(r?.reviewId).toBe('chat')
    expect(r?.dismissId).toBe('appr')
  })

  it('the newest verdict dismissed while an older one still counts: the older one', () => {
    const r = rows([review('old', 'm', 1, H2, 10), review('new', 'm', 1, H2, 11)], [{ reviewId: 'new', reason: 'x' }])[0]
    expect(r?.state).toBe('approved')
    expect(r?.dismissId).toBe('old')
  })

  it('nothing counting: nothing to dismiss', () => {
    expect(rows([review('c', 'm', 3, H2, 10)])[0]?.dismissId).toBeNull()
    expect(rows([review('s', 'm', 1, H1, 10)])[0]?.dismissId).toBeNull()
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

describe('importedReviewers (a mirrored PR, QW-017)', () => {
  const MIRROR = 'mirror'
  const trusted = new Set([MIRROR])
  const imported = (login: string, verdict: string, at: number) => ({
    reviewer: MIRROR,
    body: `> Mirrored from github.com/dashpay/dips#161 by @${login} (review, ${verdict}, 2024-01-0${at})\n\nbody`,
    createdAt: 1000 + at,
    origin: { author: login, createdAt: at * 1000, url: 'https://github.com/dashpay/dips/pull/161', host: 'github.com' },
  })

  it("lists the source reviewers with their verdicts, and leaves out the mirror's own row", () => {
    const { reviewers, mirrorOnly } = importedReviewers(
      [imported('thephez', 'requested changes', 1), imported('VirgileBa', 'requested changes', 2), imported('thephez', 'commented', 3)],
      trusted,
    )
    // A later plain comment does not undo a change request, as on GitHub.
    expect(reviewers).toEqual([
      { login: 'thephez', host: 'github.com', verdict: 'requested changes' },
      { login: 'VirgileBa', host: 'github.com', verdict: 'requested changes' },
    ])
    expect([...mirrorOnly]).toEqual([MIRROR])
  })

  it('a newer standing verdict replaces an older one', () => {
    const { reviewers } = importedReviewers([imported('a', 'requested changes', 1), imported('a', 'approved', 2)], trusted)
    expect(reviewers).toEqual([{ login: 'a', host: 'github.com', verdict: 'approved' }])
  })

  it("trusts only the mirror set: an untrusted signer's imported record is its own review", () => {
    const { reviewers, mirrorOnly } = importedReviewers([imported('thephez', 'approved', 1)], new Set())
    expect(reviewers).toEqual([])
    expect(mirrorOnly.size).toBe(0)
    expect(importedReviewers([imported('thephez', 'approved', 1)], null).reviewers).toEqual([])
  })

  it('keeps the row of a signer who also reviewed natively', () => {
    const own = { reviewer: MIRROR, body: 'LGTM', createdAt: 5, origin: null }
    expect(importedReviewers([imported('x', 'approved', 1), own], trusted).mirrorOnly.size).toBe(0)
  })
})
