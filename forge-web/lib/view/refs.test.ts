/**
 * `selectRef` / `refParamFor`: the `?ref=` param resolution browse views hang off — default
 * fallback, bare-name branch-first precedence, kind-pinned `heads/`/`tags/` forms (how a tag
 * sharing a branch's name stays addressable), and the canonical param round-trip.
 */

import { describe, expect, it } from 'vitest'

import type { ResolvedRef } from '../repo'
import { refParamFor, selectRef } from './refs'

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
