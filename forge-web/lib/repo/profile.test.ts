/** The profile data layer (P1-7): flattening, the replace's changes, its cost, the refusal. */

import { describe, expect, it } from 'vitest'

import { normalizeProfile, profileChanges, profileCost, profileFromDoc, ProfileInputError, sameProfile } from './profile'

const ID = '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB'

describe('profileFromDoc', () => {
  it('keeps the set fields, the revision and the keys', () => {
    const p = profileFromDoc({
      $id: 'doc1',
      $ownerId: ID,
      $revision: 3,
      displayName: 'Alice',
      bio: '',
      links: ['https://alice.dev'],
      pubkeys: ['ssh-ed25519 AAAA'],
    })
    expect(p).toEqual({ id: 'doc1', owner: ID, revision: 3, fields: { displayName: 'Alice', links: ['https://alice.dev'] }, pubkeys: ['ssh-ed25519 AAAA'] })
  })

  it('reads an empty links array as none', () => {
    expect(profileFromDoc({ $id: 'd', $ownerId: ID, links: [] }).fields).toEqual({})
  })
})

describe('profileChanges', () => {
  it('names only the changed fields, an unset one as removed', () => {
    const changes = profileChanges({ displayName: 'Alice', bio: 'x', links: ['https://a.dev'] }, { displayName: 'Alice', links: ['https://a.dev', 'https://b.dev'] })
    expect(changes).toEqual({ bio: undefined, links: ['https://a.dev', 'https://b.dev'] })
    expect('bio' in changes).toBe(true)
  })

  it('compares links by order too, and never touches pubkeys', () => {
    expect(Object.keys(profileChanges({ links: ['https://a.dev', 'https://b.dev'] }, { links: ['https://b.dev', 'https://a.dev'] }))).toEqual(['links'])
    expect(sameProfile({ company: 'Acme' }, { company: 'Acme' })).toBe(true)
  })
})

describe('profileCost', () => {
  it('prices a create, a replace of the changes, and nothing for no change', () => {
    const create = profileCost(null, { displayName: 'Alice' })
    expect(create?.credits).toBeGreaterThan(0)
    const stored = profileFromDoc({ $id: 'd', $ownerId: ID, $revision: 1, displayName: 'Alice' })
    expect(profileCost(stored, { displayName: 'Alice' })).toBeNull()
    const replace = profileCost(stored, { displayName: 'Alice B.' })
    expect(replace?.credits).toBeGreaterThan(0)
    expect(replace!.credits).toBeLessThan(create!.credits)
  })
})

describe('normalizeProfile', () => {
  it('throws naming every refused field, before anything is signed', () => {
    try {
      normalizeProfile({ displayName: 'x'.repeat(61), links: ['http://a.dev'] })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ProfileInputError)
      expect(Object.keys((e as ProfileInputError).problems)).toEqual(['displayName', 'links'])
    }
  })
})
