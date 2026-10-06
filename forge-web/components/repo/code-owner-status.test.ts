import { describe, expect, it } from 'vitest'

import { codeOwnerChangesIncomplete } from './code-owners'

describe('codeOwnerChangesIncomplete (the code owner rule fails closed)', () => {
  it('trusts a complete merge-base listing', () => {
    expect(codeOwnerChangesIncomplete(null, { truncated: false })).toBe(false)
  })
  it('does not trust a failed, cut-short, fallen-back or stopped listing', () => {
    expect(codeOwnerChangesIncomplete('boom', null)).toBe(true)
    expect(codeOwnerChangesIncomplete(null, { truncated: true })).toBe(true)
    expect(codeOwnerChangesIncomplete(null, { truncated: false, fellBack: true })).toBe(true)
    expect(codeOwnerChangesIncomplete(null, { truncated: false, fellBack: true, searchStopped: true })).toBe(true)
  })
})
