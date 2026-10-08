/**
 * A members-only review whose author made its text public (DESIGN §4.6): the public comment
 * attached to it replaces its text, or its placeholder, and is not shown again on its own; and
 * the make-public dialog's quote check (§12 item 15) names someone else's quoted post only.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { ReviewView } from '../repo/issues'
import { clearMembersTexts, noteMembersText, quotedMembersPost } from '../repo/members-texts'
import { withReviewTexts, type CommentView } from './issues-view'

const review = (id: string, extra: Partial<ReviewView> = {}): ReviewView => ({
  id,
  reviewer: 'bob',
  verdict: 'comment',
  verdictCode: 3,
  commitOid: 'ab'.repeat(20),
  body: '',
  commentCount: null,
  createdAt: 10,
  ...extra,
})

const comment = (id: string, extra: Partial<CommentView> = {}): CommentView => ({
  id,
  author: 'bob',
  body: 'The token is logged in two places.',
  createdAt: 20,
  replyTo: null,
  anchor: null,
  reviewId: 'R1',
  imported: false,
  ...extra,
})

describe('withReviewTexts', () => {
  it('a member reads the made-public text in place of the members-only one', () => {
    const r = review('R1', { audience: 'members', body: 'sealed text' })
    const got = withReviewTexts([r], [r], [comment('C1')])
    expect(got.reviews).toHaveLength(1)
    expect(got.reviews[0]).toMatchObject({ id: 'R1', body: 'The token is logged in two places.', madePublic: true })
    expect(got.reviews[0]?.audience).toBeUndefined()
    expect(got.comments).toEqual([])
    expect([...got.carried]).toEqual(['R1'])
  })

  it('an outsider gets the review with its text instead of the placeholder', () => {
    const r = review('R1', { membersOnly: true, verdict: 'approve', verdictCode: 1 })
    const got = withReviewTexts([], [r], [comment('C1')])
    expect(got.reviews[0]).toMatchObject({ id: 'R1', verdict: 'approve', madePublic: true, body: 'The token is logged in two places.' })
    expect(got.reviews[0]?.membersOnly).toBeUndefined()
  })

  it('only the reviewer’s own unanchored public comment counts', () => {
    const r = review('R1', { membersOnly: true })
    const others = [
      comment('C1', { author: 'eve' }),
      comment('C2', { audience: 'members' }),
      comment('C3', { replyTo: 'C0' }),
      comment('C4', { bareAnchor: { line: 4, commitOid: null } }),
    ]
    const got = withReviewTexts([], [r], others)
    expect(got.reviews).toEqual([])
    expect(got.comments).toHaveLength(4)
    expect(got.carried.size).toBe(0)
  })
})

describe('quotedMembersPost', () => {
  beforeEach(() => clearMembersTexts())

  it("names someone else's quoted members-only post, never the author's own", () => {
    const secret = 'The staging signing key rotates at 03:12 every Sunday night'
    noteMembersText('repo', 'alice-doc', [secret], { author: 'alice', kind: 'comment' })
    noteMembersText('repo', 'bob-doc', ['Bob says the deploy window is Friday afternoon only'], { author: 'bob', kind: 'issue' })
    expect(quotedMembersPost('repo', `As alice said: ${secret}`, 'bob')).toEqual({ author: 'alice', kind: 'comment' })
    expect(quotedMembersPost('repo', 'Bob says the deploy window is Friday afternoon only', 'bob')).toBeNull()
    expect(quotedMembersPost('repo', secret, 'alice')).toBeNull()
    expect(quotedMembersPost('other', secret, 'bob')).toBeNull()
  })
})
