import { describe, expect, it } from 'vitest'

import { authorRoles } from './author-role'
import type { Membership } from '../rules/v2'

const OWNER = '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB'
const m = (identity: string, role: Membership['role'], createdAt = 10): Membership => ({ identity, role, createdAt })

describe('authorRoles', () => {
  it('names the owner, whatever documents it holds', () => {
    expect(authorRoles(OWNER, [m(OWNER, 'maintainer')]).get(OWNER)).toBe('owner')
    expect(authorRoles(OWNER, []).get(OWNER)).toBe('owner')
  })

  it("gives each member their best current role", () => {
    const roles = authorRoles(OWNER, [m('a', 'reader'), m('a', 'maintainer'), m('b', 'triage'), m('c', 'writer')])
    expect(roles.get('a')).toBe('maintainer')
    expect(roles.get('b')).toBe('triage')
    expect(roles.get('c')).toBe('writer')
  })

  it("shows Bot only for a current Bot row: a removed bot shows none, and a member's own role wins over what a post claims", () => {
    const roles = authorRoles(OWNER, [m('ci', 'bot'), m('w', 'writer')])
    expect(roles.get('ci')).toBe('bot')
    // a post's `mRole` 4 is never read: the badge is the author's current row, here Write
    expect(roles.get('w')).toBe('writer')
    expect(authorRoles(OWNER, [m('w', 'writer')]).get('ci')).toBeUndefined()
  })

  it('gives a stranger, or an id that only starts like a member’s, no role', () => {
    const roles = authorRoles(OWNER, [m('8hJmcHWmaintainer', 'maintainer')])
    expect(roles.get('stranger')).toBeUndefined()
    expect(roles.get('8hJmcHWimpostor')).toBeUndefined()
  })
})
