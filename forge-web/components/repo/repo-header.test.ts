/** Which repo tab a route lights (L-40: Stargazers lit Code). */

import { describe, expect, it } from 'vitest'

import { activeRepoTab, hasBoards } from './repo-header'

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
    ['/repo/boards/', 'boards'],
    ['/repo/board', 'boards'],
    ['/repo/board/settings/', 'boards'],
    ['/repo/settings/', 'settings'],
    ['/repo/settings/environments/', 'settings'],
    ['/repo/settings/bots/', 'settings'],
  ] as const)('%s lights %s', (path, tab) => {
    expect(activeRepoTab(path)).toBe(tab)
  })

  it('lights no tab on Stargazers, as on GitHub', () => {
    expect(activeRepoTab('/repo/stargazers')).toBeNull()
    expect(activeRepoTab('/repo/labels/')).toBe('issues')
    expect(activeRepoTab('/repo/milestones')).toBe('issues')
    expect(activeRepoTab('/repo/stargazers/')).toBeNull()
    // The security policy page, like Stargazers, sits under no tab.
    expect(activeRepoTab('/repo/security/')).toBeNull()
  })
})

describe('hasBoards', () => {
  it('is the four-contract set with forge-meta (boards.md §3)', () => {
    expect(hasBoards({ meta: 'M' })).toBe(true)
    expect(hasBoards({})).toBe(false)
    expect(hasBoards(null)).toBe(false)
  })
})
