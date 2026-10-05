import { describe, expect, it } from 'vitest'

import type { DiscoveredRepo } from './discovery'
import { mapsToRepoPage, matchUpstream, mirrorsOf, mirrorToOpen } from './upstream-alias'

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

const NONE_SET: ReadonlySet<string> = new Set()
const MIRROR = 'Dash - Reinventing Cryptocurrency (mirror of github.com/dashpay/dash)'

describe('mirrorsOf: the repos that claim to mirror a GitHub repo (CJ-3)', () => {
  it('keeps the repos whose description names that GitHub repo, in any case', () => {
    const repos = [repo('a', MIRROR), repo('b', 'My own dash'), repo('c', 'Mirror of github.com/DashPay/Dash')]
    expect(mirrorsOf('dashpay', 'dash', repos, NONE_SET).map((r) => r.key)).toEqual(['a', 'c'])
  })
  it('never counts a fork, whose description is its parent’s copy, or a private repo', () => {
    const repos = [repo('a', MIRROR, { forkOf: 'x' }), repo('b', MIRROR, { visibility: 'private' })]
    expect(mirrorsOf('dashpay', 'dash', repos, NONE_SET)).toEqual([])
  })
  it('puts a showcase repo first', () => {
    const repos = [repo('a', MIRROR), repo('b', MIRROR)]
    expect(mirrorsOf('dashpay', 'dash', repos, new Set(['b'])).map((r) => r.key)).toEqual(['b', 'a'])
  })
})

const NONE: ReadonlySet<string> = new Set()

describe('mirrorToOpen', () => {
  it('opens the only claim when every repo of that name was read', () => {
    expect(mirrorToOpen([repo('a', MIRROR)], true, NONE)?.key).toBe('a')
  })
  it('does not open a lone claim when more repos share the name than were read', () => {
    expect(mirrorToOpen([repo('a', MIRROR)], false, NONE)).toBeNull()
  })
  it('lets the visitor pick between several claims, unless the showcase vouches for exactly one', () => {
    const two = [repo('a', MIRROR), repo('b', MIRROR)]
    expect(mirrorToOpen(two, true, NONE)).toBeNull()
    expect(mirrorToOpen(two, false, new Set(['b']))?.key).toBe('b')
    expect(mirrorToOpen(two, true, new Set(['a', 'b']))).toBeNull()
  })
  it('opens nothing when there is no mirror', () => {
    expect(mirrorToOpen([], true, NONE)).toBeNull()
  })
})

describe('matchUpstream', () => {
  it('says when "no mirror" is not certain', () => {
    expect(matchUpstream('dashpay', 'dash', { repos: [repo('b', 'mine')], more: true }, NONE)).toEqual({ mirrors: [], open: null, partial: true })
    expect(matchUpstream('dashpay', 'dash', { repos: [repo('a', MIRROR)], more: false }, NONE).open?.key).toBe('a')
  })
})

describe('mapsToRepoPage', () => {
  it('knows the GitHub sub-pages Forge has', () => {
    expect(mapsToRepoPage('issues/12')).toBe(true)
    expect(mapsToRepoPage('tree/main/src')).toBe(true)
    expect(mapsToRepoPage('actions')).toBe(false)
    expect(mapsToRepoPage('wiki/Home')).toBe(false)
  })
})
