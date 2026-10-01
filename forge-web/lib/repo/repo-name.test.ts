import { describe, expect, it } from 'vitest'

import { normalizeRepoName, REPO_NAME_RULE, suggestRepoName } from './writes'

describe('a typed repo name, converted as GitHub converts it (QW3-036)', () => {
  it('lowercases and turns each run of other characters into one dash', () => {
    expect(suggestRepoName('QA3 Bad Name!')).toBe('qa3-bad-name')
    expect(suggestRepoName('My Project')).toBe('my-project')
    expect(suggestRepoName('a  /  b')).toBe('a-b')
  })

  it('keeps a valid name as it is (only letters lowercased)', () => {
    expect(suggestRepoName('forge-core')).toBe('forge-core')
    expect(suggestRepoName('Dash.Core_2')).toBe('dash.core_2')
  })

  it('starts with a letter or digit, ends without a dash, and fits 63 characters', () => {
    expect(suggestRepoName('--.hidden repo')).toBe('hidden-repo')
    expect(suggestRepoName('x'.repeat(62) + ' y')).toBe('x'.repeat(62))
    expect(suggestRepoName('!!!')).toBeNull()
    expect(suggestRepoName('')).toBeNull()
  })

  it('says what a name can hold, in a sentence, when one is refused', () => {
    expect(() => normalizeRepoName('QA3 Bad Name!')).toThrow(`"QA3 Bad Name!" is not a valid repository name. ${REPO_NAME_RULE}`)
    expect(REPO_NAME_RULE).toMatch(/^A repository name uses/)
  })
})
