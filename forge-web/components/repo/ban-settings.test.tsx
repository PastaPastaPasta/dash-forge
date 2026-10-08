/** The ban dialog's note for a member: a ban keeps their role (Q5). */

import { describe, expect, it } from 'vitest'

import { banKeepsRole } from './ban-settings'

describe('banKeepsRole', () => {
  it('tells a maintainer banning a writer that the writer can still push', () => {
    expect(banKeepsRole('writer')).toBe("They have the writer role here. A ban doesn't remove that role: they can still push. To remove it, use Settings → Members.")
  })
  it('names any other member role, and says nothing for a non-member', () => {
    expect(banKeepsRole('triage')).toMatch(/^They have the triage role here\. A ban doesn't remove that role\. /)
    expect(banKeepsRole(null)).toBeNull()
    expect(banKeepsRole('maintainer')).toBeNull()
  })
})
