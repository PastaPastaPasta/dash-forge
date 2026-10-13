/**
 * #451: which branches "Compare & pull request" offers, from the repo home alone (no request).
 */

import { describe, expect, it } from 'vitest'

import type { ResolvedRef } from '../repo'
import type { RepoHome } from './repo-view'
import { DISMISSED_MAX, RECENT_PUSH_MAX, RECENT_PUSH_MS, recentPushKey, recentPushes, withDismissed } from './recent-push'

const ME = 'MeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe11'
const THEM = 'ThemThemThemThemThemThemThemThemThemThem1111'
const NOW = 1_800_000_000_000
const oid = (c: string): string => c.repeat(40)

const branch = (name: string, tip: string, author = ME, ago = 5 * 60_000): ResolvedRef => ({
  refName: `refs/heads/${name}`,
  refNameHash: name,
  state: { state: 'resolved', oid: tip, author, createdAt: NOW - ago },
})

const home = (branches: ResolvedRef[], extra: Partial<RepoHome> = {}): RepoHome =>
  ({
    repo: { forge: {}, repoId: 'REPO', ownerId: THEM, name: 'proj', visibility: 'public' },
    config: null,
    defaultBranch: 'main',
    branches,
    tags: [],
    ...extra,
  }) as unknown as RepoHome

const MAIN = branch('main', oid('a'), THEM, 3 * 60 * 60_000)

describe('recentPushes', () => {
  it('offers a branch the viewer pushed within the hour, with its tip and push time', () => {
    expect(recentPushes(home([MAIN, branch('feature/x', oid('b'))]), ME, NOW)).toEqual([
      { refName: 'refs/heads/feature/x', branch: 'feature/x', tip: oid('b'), pushedAt: NOW - 5 * 60_000 },
    ])
  })

  it('offers nothing to a signed-out viewer, nor a branch someone else moved last', () => {
    const h = home([MAIN, branch('feature', oid('b')), branch('theirs', oid('c'), THEM)])
    expect(recentPushes(h, null, NOW)).toEqual([])
    expect(recentPushes(h, THEM, NOW).map((p) => p.branch)).toEqual(['theirs'])
    expect(recentPushes(h, ME, NOW).map((p) => p.branch)).toEqual(['feature'])
  })

  it('leaves out a push older than the hour; a time slightly ahead (clock skew) is recent', () => {
    const h = home([MAIN, branch('old', oid('b'), ME, RECENT_PUSH_MS + 1), branch('edge', oid('c'), ME, RECENT_PUSH_MS), branch('ahead', oid('d'), ME, -30_000)])
    expect(recentPushes(h, ME, NOW).map((p) => p.branch)).toEqual(['ahead', 'edge'])
  })

  it('leaves out the default branch, a branch at the default tip, and deleted, diverged or unborn branches', () => {
    const h = home([
      branch('main', oid('a'), ME),
      branch('same', oid('a')),
      branch('gone', '0'.repeat(40)),
      { refName: 'refs/heads/split', refNameHash: 's', state: { state: 'diverged', heads: [{ id: '1', oid: oid('e'), author: ME, createdAt: NOW }] } },
      { refName: 'refs/heads/none', refNameHash: 'n', state: { state: 'unborn' } },
      { refName: 'refs/tags/v1', refNameHash: 't', state: { state: 'resolved', oid: oid('f'), author: ME, createdAt: NOW } },
    ])
    expect(recentPushes(h, ME, NOW)).toEqual([])
  })

  it('offers nothing on a private or archived repo, nor from a home that holds the default branch alone', () => {
    const b = [MAIN, branch('feature', oid('b'))]
    expect(recentPushes(home(b, { repo: { visibility: 'private', repoId: 'REPO' } as RepoHome['repo'] }), ME, NOW)).toEqual([])
    expect(recentPushes(home(b, { config: { archived: true } as RepoHome['config'] }), ME, NOW)).toEqual([])
    expect(recentPushes(home(b, { refsPartial: true }), ME, NOW)).toEqual([])
  })

  it('lists the newest pushes first, at most a few', () => {
    const many = Array.from({ length: RECENT_PUSH_MAX + 2 }, (_, i) => branch(`b${i}`, oid(String(i + 1)), ME, (i + 1) * 60_000))
    expect(recentPushes(home([MAIN, ...many]), ME, NOW).map((p) => p.branch)).toEqual(['b0', 'b1', 'b2'].slice(0, RECENT_PUSH_MAX))
  })
})

describe('dismissals', () => {
  it('are kept per repo, branch and tip: a new push is offered again', () => {
    const p = { refName: 'refs/heads/f', tip: oid('b') }
    expect(recentPushKey('REPO', p)).not.toEqual(recentPushKey('REPO', { ...p, tip: oid('c') }))
    expect(recentPushKey('REPO', p)).not.toEqual(recentPushKey('OTHER', p))
  })

  it('keep each key once, newest last, and the newest few only', () => {
    expect(withDismissed(['a', 'b'], 'a')).toEqual(['b', 'a'])
    const full = Array.from({ length: DISMISSED_MAX }, (_, i) => `k${i}`)
    const next = withDismissed(full, 'new')
    expect(next).toHaveLength(DISMISSED_MAX)
    expect(next[0]).toBe('k1')
    expect(next.at(-1)).toBe('new')
  })
})
