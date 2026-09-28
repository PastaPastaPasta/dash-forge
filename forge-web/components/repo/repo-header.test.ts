/** Which repo tab a route lights (L-40: Stargazers lit Code). */

import { describe, expect, it } from 'vitest'

import { activeRepoTab } from './repo-header'

describe('activeRepoTab', () => {
  it.each([
    ['/repo', 'code'],
    ['/repo/', 'code'],
    ['/repo/tree/', 'code'],
    ['/repo/branches', 'code'],
    ['/repo/tags/', 'code'],
    ['/repo/commit', 'code'],
    ['/repo/blame/', 'code'],
    ['/repo/issue/', 'issues'],
    ['/repo/pulls/new/', 'pulls'],
    ['/repo/release', 'releases'],
    ['/repo/settings/', 'settings'],
  ] as const)('%s lights %s', (path, tab) => {
    expect(activeRepoTab(path)).toBe(tab)
  })

  it('lights no tab on Stargazers, as on GitHub', () => {
    expect(activeRepoTab('/repo/stargazers')).toBeNull()
    expect(activeRepoTab('/repo/stargazers/')).toBeNull()
  })
})
