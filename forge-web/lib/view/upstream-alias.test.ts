import { describe, expect, it } from 'vitest'

import type { DiscoveredRepo } from './discovery'
import { backlinkFile } from '../rules/mirror-backlink'
import { clearMirrorChecks, checkMirrorClaim } from './mirror-check'
import { mapsToRepoPage, matchUpstream, mirrorsOf, mirrorToOpen, verifiedMirrors } from './upstream-alias'

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

describe('mirrorToOpen (ABU-04: a claim alone opens nothing)', () => {
  it('does not open a lone, unvouched claim, even when every repo of that name was read', () => {
    expect(mirrorToOpen([repo('a', MIRROR)], NONE, NONE)).toBeNull()
  })
  it('opens the one the showcase vouches for', () => {
    const two = [repo('a', MIRROR), repo('b', MIRROR)]
    expect(mirrorToOpen(two, new Set(['b']), NONE)?.key).toBe('b')
    expect(mirrorToOpen([repo('b', MIRROR)], new Set(['b']), NONE)?.key).toBe('b')
  })
  it('opens the one whose backlink check passed', () => {
    const two = [repo('a', MIRROR), repo('b', MIRROR)]
    expect(mirrorToOpen(two, NONE, new Set(['a']))?.key).toBe('a')
    expect(mirrorToOpen([repo('a', MIRROR)], NONE, new Set(['a']))?.key).toBe('a')
  })
  it('lets the visitor pick when two are vouched or two are confirmed', () => {
    const two = [repo('a', MIRROR), repo('b', MIRROR)]
    expect(mirrorToOpen(two, new Set(['a', 'b']), NONE)).toBeNull()
    expect(mirrorToOpen(two, NONE, new Set(['a', 'b']))).toBeNull()
  })
  it('puts the showcase first: a confirmed look-alike does not outrank a vouched repo, nor open beside two', () => {
    const three = [repo('a', MIRROR), repo('b', MIRROR), repo('c', MIRROR)]
    expect(mirrorToOpen(three, new Set(['b']), new Set(['a']))?.key).toBe('b')
    expect(mirrorToOpen(three, new Set(['b', 'c']), new Set(['a']))).toBeNull()
  })
  it('opens nothing when there is no mirror', () => {
    expect(mirrorToOpen([], NONE, NONE)).toBeNull()
  })
})

describe('matchUpstream', () => {
  it('says when "no mirror" is not certain', () => {
    expect(matchUpstream('dashpay', 'dash', { repos: [repo('b', 'mine')], more: true }, NONE, NONE)).toEqual({ mirrors: [], open: null, partial: true, verified: NONE })
  })
  it('opens nothing for a claim the source has not confirmed, and lists it', () => {
    const m = matchUpstream('dashpay', 'dash', { repos: [repo('a', MIRROR)], more: false }, NONE, NONE)
    expect(m.open).toBeNull()
    expect(m.mirrors.map((r) => r.key)).toEqual(['a'])
  })
  it('opens a claim whose id is among the confirmed', () => {
    expect(matchUpstream('dashpay', 'dash', { repos: [repo('a', MIRROR)], more: true }, NONE, new Set(['a'])).open?.key).toBe('a')
  })
})

describe('verifiedMirrors / matchUpstream with the session store', () => {
  const source = { host: 'github.com', label: 'github.com/dashpay/dash', listUrl: 'https://github.com/dashpay/dash/pulls' }
  const github = (file: string): typeof fetch => (async (input: RequestInfo | URL) => (String(input).includes('raw.githubusercontent.com') ? new Response(file) : new Response('', { status: 404 }))) as typeof fetch

  it('knows the claims the source listed, per source and repo id, and opens only those', async () => {
    clearMirrorChecks()
    const rows = [repo('a', MIRROR), repo('b', MIRROR)]
    expect(verifiedMirrors('dashpay', 'dash', rows).size).toBe(0)
    expect(matchUpstream('dashpay', 'dash', { repos: rows, more: false }).open).toBeNull()

    await checkMirrorClaim(source, 'a', null, github(backlinkFile(['a'])))
    expect([...verifiedMirrors('dashpay', 'dash', rows)]).toEqual(['a'])
    expect(matchUpstream('dashpay', 'dash', { repos: rows, more: false }).open?.key).toBe('a')
    // The list of another source does not verify a claim on this one.
    expect(verifiedMirrors('someone', 'dash', rows).size).toBe(0)
  })

  it('does not count a list that names other mirrors, or no list', async () => {
    clearMirrorChecks()
    await checkMirrorClaim(source, 'a', null, github(backlinkFile(['zzz'])))
    await checkMirrorClaim(source, 'b', null, github(''))
    expect(verifiedMirrors('dashpay', 'dash', [repo('a', MIRROR), repo('b', MIRROR)]).size).toBe(0)
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
