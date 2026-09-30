/**
 * `selectRef` / `refParamFor`: the `?ref=` param resolution browse views hang off — default
 * fallback, bare-name branch-first precedence, kind-pinned `heads/`/`tags/` forms (how a tag
 * sharing a branch's name stays addressable), and the canonical param round-trip.
 */

import { describe, expect, it } from 'vitest'

import type { ResolvedRef } from '../repo'
import { isLive, matchesRefQuery, refParamFor, selectedTip, selectRef, splitRefPath } from './refs'

function ref(refName: string, oid = 'a'.repeat(40)): ResolvedRef {
  return { refName, refNameHash: 'x', state: { state: 'resolved', oid, author: 'id', createdAt: 1 } }
}

const branches = [ref('refs/heads/main', '1'.repeat(40)), ref('refs/heads/release', '2'.repeat(40))]
const tags = [ref('refs/tags/v1.0', '3'.repeat(40)), ref('refs/tags/release', '4'.repeat(40))]

describe('selectRef', () => {
  it('falls back to the default branch on an empty param', () => {
    const s = selectRef(branches, tags, 'main', '')
    expect(s.name).toBe('main')
    expect(s.ref?.refName).toBe('refs/heads/main')
    expect(s.isTag).toBe(false)
  })

  it('matches a tag by bare name when no branch shares it', () => {
    const s = selectRef(branches, tags, 'main', 'v1.0')
    expect(s.ref?.refName).toBe('refs/tags/v1.0')
    expect(s.isTag).toBe(true)
  })

  it('prefers the branch when a bare name collides', () => {
    const s = selectRef(branches, tags, 'main', 'release')
    expect(s.ref?.refName).toBe('refs/heads/release')
    expect(s.isTag).toBe(false)
  })

  it('pins the tag on a collision via the tags/ form', () => {
    const s = selectRef(branches, tags, 'main', 'tags/release')
    expect(s.name).toBe('release')
    expect(s.ref?.refName).toBe('refs/tags/release')
    expect(s.isTag).toBe(true)
  })

  it('accepts refs/-prefixed kind-pinned forms', () => {
    expect(selectRef(branches, tags, 'main', 'refs/tags/release').isTag).toBe(true)
    expect(selectRef(branches, tags, 'main', 'refs/heads/release').ref?.refName).toBe('refs/heads/release')
  })

  it('does not fall through to a branch on a kind-pinned tag miss', () => {
    const s = selectRef(branches, tags, 'main', 'tags/main')
    expect(s.ref).toBeUndefined()
  })

  it('leaves ref undefined for an unknown name', () => {
    const s = selectRef(branches, tags, 'main', 'nope')
    expect(s.name).toBe('nope')
    expect(s.ref).toBeUndefined()
  })
})

describe('isLive', () => {
  it('is true for resolved refs, false for unborn (deleted) ones', () => {
    expect(isLive(ref('refs/heads/main'))).toBe(true)
    expect(isLive({ refName: 'refs/heads/dead', refNameHash: 'x', state: { state: 'unborn' } })).toBe(false)
  })
})

describe('refParamFor', () => {
  it('is empty for the default branch, bare for others, tags/-pinned for tags', () => {
    expect(refParamFor('main', false, 'main')).toBe('')
    expect(refParamFor('release', false, 'main')).toBe('release')
    expect(refParamFor('v1.0', true, 'main')).toBe('tags/v1.0')
  })

  it('round-trips through selectRef, including a colliding tag name', () => {
    for (const [shortName, isTag] of [['release', false], ['release', true], ['v1.0', true]] as const) {
      const param = refParamFor(shortName, isTag, 'main')
      const s = selectRef(branches, tags, 'main', param)
      expect(s.name).toBe(shortName)
      expect(s.isTag).toBe(isTag)
      expect(s.ref).toBeDefined()
    }
  })
})

describe('matchesRefQuery', () => {
  it('matches everything on an empty or whitespace-only query', () => {
    expect(matchesRefQuery('v23.1.8', '')).toBe(true)
    expect(matchesRefQuery('v23.1.8', '   ')).toBe(true)
  })

  it('matches a case-insensitive substring anywhere in the name', () => {
    expect(matchesRefQuery('v23.1.8', '23.1')).toBe(true)
    expect(matchesRefQuery('Release-Candidate', 'candidate')).toBe(true)
    expect(matchesRefQuery('v23.1.8', 'CANDIDATE')).toBe(false)
  })
})

describe('pinned commits (permalinks, D-054)', () => {
  const commit = 'AbCdEf0123456789abcdef0123456789ABCDEF01'
  it('reads a full commit id no ref is named as a pinned commit', () => {
    const selected = selectRef(branches, tags, 'main', commit)
    expect(selected.pinned).toBe(commit.toLowerCase())
    expect(selectedTip(selected)).toBe(commit.toLowerCase())
    expect(selected.ref).toBeUndefined()
    expect(selected.name).toBe('abcdef0')
  })

  it('prefers a branch that has the name, and resolves the default branch', () => {
    const named = [...branches, ref(`refs/heads/${commit}`, '9'.repeat(40))]
    expect(selectedTip(selectRef(named, tags, 'main', commit))).toBe('9'.repeat(40))
    expect(selectRef(named, tags, 'main', commit).pinned).toBeUndefined()
    expect(selectedTip(selectRef(branches, tags, 'main', ''))).toBe('1'.repeat(40))
  })

  it('pins a short hex id for the view to resolve (L-32), and leaves other unknown names unresolved', () => {
    const short = selectRef(branches, tags, 'main', 'abcdef0')
    expect(short.ref).toBeUndefined()
    expect(short.pinned).toBe('abcdef0')
    const unknown = selectRef(branches, tags, 'main', 'feature-x')
    expect(unknown.pinned).toBeUndefined()
    expect(selectedTip(unknown)).toBeNull()
  })
})

// QW2-024: `/tree/feat/flatpak/doc` pasted from GitHub reaches the page as ref=feat, path=flatpak/doc.
describe('splitRefPath', () => {
  const slashed = [ref('refs/heads/main'), ref('refs/heads/feat/flatpak'), ref('refs/heads/fix/a/b')]
  const slashTags = [ref('refs/tags/release/v2')]
  it('takes the longest branch or tag the path’s leading segments complete', () => {
    expect(splitRefPath(slashed, slashTags, 'feat', 'flatpak/doc')).toEqual({ ref: 'feat/flatpak', path: 'doc' })
    expect(splitRefPath(slashed, slashTags, 'feat', 'flatpak')).toEqual({ ref: 'feat/flatpak', path: '' })
    expect(splitRefPath(slashed, slashTags, 'fix', 'a/b/src/x.c')).toEqual({ ref: 'fix/a/b', path: 'src/x.c' })
    expect(splitRefPath(slashed, slashTags, 'release', 'v2/README.md')).toEqual({ ref: 'release/v2', path: 'README.md' })
  })
  it('leaves a ref that exists, an unknown one, and a URL with no path alone', () => {
    expect(splitRefPath(slashed, slashTags, 'main', 'flatpak/doc')).toBeNull()
    expect(splitRefPath(slashed, slashTags, 'feat', 'other/doc')).toBeNull()
    expect(splitRefPath(slashed, slashTags, 'feat', '')).toBeNull()
    expect(splitRefPath(slashed, slashTags, '', 'feat/flatpak')).toBeNull()
  })
})
