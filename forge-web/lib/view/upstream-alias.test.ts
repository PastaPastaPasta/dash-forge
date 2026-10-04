import { describe, expect, it } from 'vitest'

import type { DiscoveredRepo } from './discovery'
import { mirrorsOf, mirrorToOpen } from './upstream-alias'

const repo = (key: string, description: string, extra: Partial<DiscoveredRepo> = {}): DiscoveredRepo => ({
  key,
  ownerId: `owner-${key}`,
  name: 'dash',
  slug: 'dash',
  description,
  createdAt: 0,
  visibility: 'public',
  forkOf: null,
  ...extra,
})

const MIRROR = 'Dash - Reinventing Cryptocurrency (mirror of github.com/dashpay/dash)'

describe('mirrorsOf: the repos that claim to mirror a GitHub repo (CJ-3)', () => {
  it('keeps the repos whose description names that GitHub repo, in any case', () => {
    const repos = [repo('a', MIRROR), repo('b', 'My own dash'), repo('c', 'Mirror of github.com/DashPay/Dash')]
    expect(mirrorsOf('dashpay', 'dash', repos).map((r) => r.key)).toEqual(['a', 'c'])
  })
  it('never counts a fork, whose description is its parent’s copy, or a private repo', () => {
    const repos = [repo('a', MIRROR, { forkOf: 'x' }), repo('b', MIRROR, { visibility: 'private' })]
    expect(mirrorsOf('dashpay', 'dash', repos)).toEqual([])
  })
  it('puts a showcase repo first', () => {
    const repos = [repo('a', MIRROR), repo('b', MIRROR)]
    expect(mirrorsOf('dashpay', 'dash', repos, new Set(['b'])).map((r) => r.key)).toEqual(['b', 'a'])
  })
})

describe('mirrorToOpen', () => {
  it('opens the only claim', () => {
    expect(mirrorToOpen([repo('a', MIRROR)])?.key).toBe('a')
  })
  it('lets the visitor pick between several claims, unless the showcase vouches for one', () => {
    const two = [repo('a', MIRROR), repo('b', MIRROR)]
    expect(mirrorToOpen(two)).toBeNull()
    expect(mirrorToOpen(two, new Set(['b']))?.key).toBe('b')
    expect(mirrorToOpen(two, new Set(['a', 'b']))).toBeNull()
  })
  it('opens nothing when there is no mirror', () => {
    expect(mirrorToOpen([])).toBeNull()
  })
})
