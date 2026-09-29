import { describe, expect, it } from 'vitest'

import { pageTitle } from './page-title'

const ID = 'Bdx8pb9VYHqoeWDoY96HNNrjoQyZvaoBjSqZJ5fajRDB'
const q = (s: string): URLSearchParams => new URLSearchParams(s)

describe('pageTitle (L-59)', () => {
  it('names the repo and the view, GitHub-style', () => {
    expect(pageTitle('/repo/', q(`owner=${ID}&name=dash`), 'unofficial-dashpay-dash-mirror')).toBe('unofficial-dashpay-dash-mirror/dash · Dash Forge')
    expect(pageTitle('/repo/issues/', q('owner=alice&name=p'))).toBe('Issues · alice/p · Dash Forge')
    expect(pageTitle('/repo/issue/', q('owner=alice&name=p&number=12'))).toBe('Issue #12 · alice/p · Dash Forge')
    expect(pageTitle('/repo/blob/', q('owner=alice&name=p&path=src/main.rs&ref=main'))).toBe('src/main.rs at main · alice/p · Dash Forge')
    expect(pageTitle('/repo/commit/', q('owner=alice&name=p&oid=0123456789abcdef'))).toBe('Commit 0123456 · alice/p · Dash Forge')
    expect(pageTitle('/repo/pull/', q('owner=alice&name=p&number=7762'))).toBe('Pull request #7762 · alice/p · Dash Forge')
  })

  it('shortens an identity id until its DPNS name is known', () => {
    expect(pageTitle('/repo/pulls', q(`owner=${ID}&name=dash`))).toBe('Pull requests · Bdx8pb9V…/dash · Dash Forge')
  })

  it('never shows a private repo’s sealed path or ref', () => {
    expect(pageTitle('/repo/blob/', q('owner=alice&name=p&path=~0a1b2c3d4e5f6a7b&ref=~ffeeddccbbaa9988'))).toBe('p · Dash Forge')
  })

  it('titles site pages and profiles', () => {
    expect(pageTitle('/', q(''))).toBe('Dash Forge')
    expect(pageTitle('/explore/', q(''))).toBe('Explore · Dash Forge')
    expect(pageTitle('/explore/', q('q=dash'))).toBe('Search “dash” · Dash Forge')
    expect(pageTitle('/u/', q(`name=${ID}`), 'alice')).toBe('alice · Dash Forge')
    expect(pageTitle('/u/followers/', q('name=alice'))).toBe('Followers · alice · Dash Forge')
    expect(pageTitle('/nope', q(''))).toBe('Dash Forge')
  })
})
