import { describe, expect, it } from 'vitest'

import { deleteNeedsForce, dependentsWarning } from './branch-dependents'

describe('dependentsWarning', () => {
  it('names each open PR, how it uses the branch, and what deleting it does', () => {
    const d = { pulls: [{ number: 12, title: 'Add parser', uses: 'base' as const }, { number: 14, title: 'Docs', uses: 'head' as const }], searched: null }
    expect(dependentsWarning('feature-a', d)).toBe(
      "2 open pull requests use feature-a: #12 Add parser (merges into it); #14 Docs (its source branch). A pull request whose base branch is deleted can't be merged until its base is changed (Edit base on the pull request). A pull request whose source branch is deleted stops following new pushes.",
    )
    expect(deleteNeedsForce(d)).toBe(true)
  })

  it("says when a PR that uses the branch is filed in another repository (a fork's branch)", () => {
    const d = { pulls: [{ number: 9, title: 'Fix', uses: 'head' as const, repoId: 'UP' }], searched: null }
    expect(dependentsWarning('feature', d)).toBe(
      '1 open pull request uses feature: #9 Fix (its source branch, in another repository). A pull request whose source branch is deleted stops following new pushes.',
    )
  })

  it('says nothing when no PR uses it, and how far it looked when it did not read every PR', () => {
    expect(dependentsWarning('x', { pulls: [], searched: null })).toBeNull()
    expect(dependentsWarning('x', { pulls: [], searched: 500 })).toBe('No open pull request among the newest 500 uses x.')
    expect(deleteNeedsForce({ pulls: [], searched: null })).toBe(false)
  })

  it('never blocks the delete when the check fails, but says so', () => {
    const d = { error: 'timeout' }
    expect(dependentsWarning('x', d)).toBe("Couldn't check whether open pull requests use x.")
    expect(deleteNeedsForce(d)).toBe(false)
  })
})
