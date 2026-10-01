// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { forgetShownOwnReviews, OWN_REVIEW_TTL_MS, ownReviewScope, rememberOwnReview, unshownOwnReviews } from './own-reviews'

const scope = ownReviewScope('devnet', 'R', 6, 'outsider')

beforeEach(() => sessionStorage.clear())

describe('own reviews awaiting a read (QW3-047)', () => {
  it('keeps a submitted review across a reload until a read shows it', () => {
    rememberOwnReview(scope, { id: 'r1', verdict: 'approve', at: 1000 })
    expect(unshownOwnReviews(scope, new Set(), 2000)).toEqual([{ id: 'r1', verdict: 'approve', at: 1000 }])
    // Shown: forgotten for good.
    expect(unshownOwnReviews(scope, new Set(['r1']), 3000)).toEqual([])
    forgetShownOwnReviews(scope, new Set(['r1']), 3000)
    expect(unshownOwnReviews(scope, new Set(), 4000)).toEqual([])
  })

  it('drops one past its time, and keeps scopes apart', () => {
    rememberOwnReview(scope, { id: 'r1', verdict: 'approve', at: 0 })
    expect(unshownOwnReviews(ownReviewScope('devnet', 'R', 7, 'outsider'), new Set(), 1)).toEqual([])
    expect(unshownOwnReviews(scope, new Set(), OWN_REVIEW_TTL_MS + 1)).toEqual([])
  })

  it('ignores a malformed record', () => {
    sessionStorage.setItem(`forge:own-reviews:${scope}`, '{"not":"a list"}')
    expect(unshownOwnReviews(scope, new Set(), 1)).toEqual([])
  })
})
