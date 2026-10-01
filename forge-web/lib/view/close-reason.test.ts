import { describe, expect, it } from 'vitest'

import { closeWhyOf, closedSkipped } from './close-reason'

const close = (reason?: number, dupNumber?: number) => ({ id: 't', kind: 1, createdAt: 1, ...(reason !== undefined ? { reason } : {}), ...(dupNumber !== undefined ? { dupNumber } : {}) })
const href = (n: number): string => `/repo/issue?number=${n}`

describe('closeWhyOf (QW-069)', () => {
  const issues = new Map([[3, { number: 3, title: 'The first report' }]])
  it('says why, and links a duplicate only to an issue of the repo', () => {
    expect(closeWhyOf(close(2), 7, issues, href)).toEqual({ phrase: 'closed this as not planned', duplicate: null, skipped: true })
    expect(closeWhyOf(close(1), 7, issues, href)).toEqual({ phrase: 'closed this as completed', duplicate: null, skipped: false })
    expect(closeWhyOf(close(3, 3), 7, issues, href)).toEqual({
      phrase: 'closed this as a duplicate of #3',
      duplicate: { number: 3, title: 'The first report', href: '/repo/issue?number=3' },
      skipped: true,
    })
    // #9 is no issue of the repo (a PR, or nothing): no link, no number
    expect(closeWhyOf(close(3, 9), 7, issues, href)).toEqual({ phrase: 'closed this as a duplicate', duplicate: null, skipped: true })
  })
  it('has nothing to say for a plain close, a reopen or a PR', () => {
    expect(closeWhyOf(close(), 7, issues, href)).toBeNull()
    expect(closeWhyOf({ ...close(2), kind: 2 }, 7, issues, href)).toBeNull()
    expect(closeWhyOf({ ...close(2), kind: 11 }, 7, issues, href)).toBeNull()
  })
  it('greys out what was not done', () => {
    expect(closedSkipped({ reason: 'completed', duplicateOf: null })).toBe(false)
    expect(closedSkipped({ reason: 'duplicate', duplicateOf: null })).toBe(true)
    expect(closedSkipped(null)).toBe(false)
  })
})
