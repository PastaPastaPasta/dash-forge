import { describe, expect, it } from 'vitest'
import { KNOWN_MAX, lookalikeOf, readKnown, remember, rememberNames, type KnownName } from './known-names'

const REAL = 'H3xi5biFj6wbxmpbdhHx1D2D3ofKJJ7anDG58ixhqvry'
const FAKE = 'H3xi5bi9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function owner(name: string, identity: string, how: KnownName['how'] = 'visited', at = 1): KnownName {
  return { kind: 'owner', name, identity, how, at }
}

function repo(name: string, identity: string, repoId: string, how: KnownName['how'] = 'visited'): KnownName {
  return { kind: 'repo', name, identity, repoId, label: `x/${name}`, how, at: 1 }
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
    expect(lookalikeOf([owner('dashpay', REAL, 'starred')], { kind: 'owner', name: 'dashpay2', identity: FAKE })?.identity).toBe(REAL)
  })

  it('never compares an owner with itself or its own repos, nor unrelated names', () => {
    const list = [owner('dashpay', REAL, 'starred'), repo('dashcore', REAL, 'r1')]
    expect(lookalikeOf(list, { kind: 'owner', name: 'dashpay', identity: REAL })).toBeNull()
    expect(lookalikeOf(list, { kind: 'owner', name: 'alice', identity: FAKE })).toBeNull()
    expect(lookalikeOf(list, { kind: 'repo', name: 'dash-core', identity: REAL, repoId: 'r2' })).toBeNull()
    expect(lookalikeOf(list, { kind: 'repo', name: 'dash-core', identity: FAKE, repoId: 'r3' })?.repoId).toBe('r1')
    expect(lookalikeOf(list, { kind: 'owner', name: 'dash-core', identity: FAKE })).toBeNull()
  })

  it("notes another owner's repo of the very same name only when asked (not a fork)", () => {
    const list = [repo('dashcore', REAL, 'r1', 'starred')]
    expect(lookalikeOf(list, { kind: 'repo', name: 'dashcore', identity: FAKE, repoId: 'r2' })).toBeNull()
    expect(lookalikeOf(list, { kind: 'repo', name: 'dashcore', identity: FAKE, repoId: 'r2', sameNameCounts: true })?.repoId).toBe('r1')
  })

  it('prefers what the viewer starred or follows over what they visited', () => {
    const list = [owner('dashpay1', 'v', 'visited', 9), owner('dash-pay', 's', 'followed', 1)]
    expect(lookalikeOf(list, { kind: 'owner', name: 'dashpay', identity: FAKE })?.identity).toBe('s')
  })

  it('never weakens a star to a visit, keeps a repo label, and unstars back to a visit', () => {
    const starred = remember([], [{ ...repo('dash', REAL, 'r'), label: 'dashpay/dash', how: 'starred' }])
    const visited = remember(starred, [{ kind: 'repo', name: 'dash', identity: REAL, repoId: 'r', how: 'visited', at: 2 }])
    expect(visited).toEqual([{ kind: 'repo', name: 'dash', identity: REAL, repoId: 'r', label: 'dashpay/dash', how: 'starred', at: 2 }])
    expect(remember(visited, [{ ...repo('dash', REAL, 'r'), how: 'starred' }], true)[0]?.how).toBe('visited')
    // Unfollowing does not undo a star of the same thing, and unsetting an unknown entry adds nothing.
    expect(remember(visited, [{ ...repo('dash', REAL, 'r'), how: 'followed' }], true)[0]?.how).toBe('starred')
    expect(remember([], [owner('a', 'b', 'starred')], true)).toEqual([])
  })

  it('stays bounded, dropping the oldest visits first', () => {
    let list: KnownName[] = [owner('kept', 'star', 'starred', 0)]
    for (let i = 1; i <= KNOWN_MAX + 5; i++) list = remember(list, [owner(`n${i}`, `id${i}`, 'visited', i)])
    expect(list).toHaveLength(KNOWN_MAX)
    expect(list.some((k) => k.identity === 'star')).toBe(true)
    expect(list.some((k) => k.identity === 'id1')).toBe(false)
  })

  it('keeps each network apart, and survives a corrupt, malformed or missing store', () => {
    const s = memoryStorage()
    rememberNames('devnet', [owner('dashpay', REAL)], false, s)
    expect(readKnown('devnet', s)).toHaveLength(1)
    expect(readKnown('mainnet', s)).toEqual([])
    s.setItem('forge.known-names:devnet', JSON.stringify([{ kind: 'owner', name: 'x', identity: 'y', how: 'watched', at: 1 }, owner('ok', 'z')]))
    expect(readKnown('devnet', s).map((k) => k.name)).toEqual(['ok'])
    s.setItem('forge.known-names:devnet', '{nope')
    expect(readKnown('devnet', s)).toEqual([])
    expect(readKnown('devnet', null)).toEqual([])
    expect(() => rememberNames('devnet', [owner('x', 'y')], false, null)).not.toThrow()
  })
})
