import { describe, expect, it } from 'vitest'
import { KNOWN_MAX, lookalikeOf, readKnown, remember, rememberName, type KnownName } from './known-names'

const REAL = 'H3xi5biFj6wbxmpbdhHx1D2D3ofKJJ7anDG58ixhqvry'
const FAKE = 'H3xi5bi9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function owner(name: string, identity: string, how: KnownName['how'] = 'visited', at = 1): KnownName {
  return { kind: 'owner', name, identity, how, at }
}

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    },
  }
}

describe('known names (TS-24)', () => {
  it('finds a known name the subject could be mistaken for', () => {
    const list = [owner('dashpay', REAL, 'starred')]
    expect(lookalikeOf(list, { kind: 'owner', name: 'dashpay2', identity: FAKE })?.identity).toBe(REAL)
  })

  it('never warns about the same identity or repo, or an unrelated name', () => {
    const list = [owner('dashpay', REAL, 'starred')]
    expect(lookalikeOf(list, { kind: 'owner', name: 'dashpay', identity: REAL })).toBeNull()
    expect(lookalikeOf(list, { kind: 'owner', name: 'alice', identity: FAKE })).toBeNull()
    const repos: KnownName[] = [{ kind: 'repo', name: 'dashcore', identity: REAL, repoId: 'r1', how: 'visited', at: 1 }]
    expect(lookalikeOf(repos, { kind: 'repo', name: 'dash-core', identity: REAL, repoId: 'r1' })).toBeNull()
    expect(lookalikeOf(repos, { kind: 'repo', name: 'dash-core', identity: FAKE, repoId: 'r2' })?.repoId).toBe('r1')
    expect(lookalikeOf(repos, { kind: 'owner', name: 'dash-core', identity: FAKE })).toBeNull()
  })

  it('prefers what the viewer starred or follows over what they visited', () => {
    const list = [owner('dashpay1', 'v', 'visited', 9), owner('dash-pay', 's', 'followed', 1)]
    expect(lookalikeOf(list, { kind: 'owner', name: 'dashpay', identity: FAKE })?.identity).toBe('s')
  })

  it('never weakens a star to a visit, and keeps a repo label', () => {
    const starred = remember([], { kind: 'repo', name: 'dash', identity: REAL, repoId: 'r', label: 'dashpay/dash', how: 'starred', at: 1 })
    const visited = remember(starred, { kind: 'repo', name: 'dash', identity: REAL, repoId: 'r', how: 'visited', at: 2 })
    expect(visited).toEqual([{ kind: 'repo', name: 'dash', identity: REAL, repoId: 'r', label: 'dashpay/dash', how: 'starred', at: 2 }])
  })

  it('stays bounded, dropping the oldest visits first', () => {
    let list: KnownName[] = [owner('kept', 'star', 'starred', 0)]
    for (let i = 1; i <= KNOWN_MAX + 5; i++) list = remember(list, owner(`n${i}`, `id${i}`, 'visited', i))
    expect(list).toHaveLength(KNOWN_MAX)
    expect(list.some((k) => k.identity === 'star')).toBe(true)
    expect(list.some((k) => k.identity === 'id1')).toBe(false)
  })

  it('persists, and survives a corrupt or missing store', () => {
    const s = memoryStorage()
    rememberName(owner('dashpay', REAL), s)
    expect(readKnown(s)).toHaveLength(1)
    s.setItem('forge.known-names', '{nope')
    expect(readKnown(s)).toEqual([])
    expect(readKnown(null)).toEqual([])
    expect(() => rememberName(owner('x', 'y'), null)).not.toThrow()
  })
})
