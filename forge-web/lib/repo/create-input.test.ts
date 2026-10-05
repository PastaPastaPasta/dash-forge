/** Create-form input refused before anything is written (`checkRepoInput`). */

import { describe, expect, it } from 'vitest'

import { checkRepoInput } from './writes'

describe('checkRepoInput', () => {
  // CodeRabbit (PR #372): `refs/heads/<branch>` can outgrow a protected pattern's 100
  // characters, and the first config is written after the repo and its maintainer.
  it('refuses a default branch too long to protect, unless protection is off', () => {
    expect(() => checkRepoInput({ name: 'demo', defaultBranch: 'b'.repeat(90), protect: true })).toThrow(/too long to protect/)
    expect(() => checkRepoInput({ name: 'demo', defaultBranch: 'b'.repeat(90) })).not.toThrow()
    expect(() => checkRepoInput({ name: 'demo', defaultBranch: 'b'.repeat(89), protect: true })).not.toThrow()
  })
})
