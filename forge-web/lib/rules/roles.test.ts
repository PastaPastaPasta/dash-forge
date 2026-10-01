import { describe, expect, it } from 'vitest'

import {
  RoleRefusedError,
  capabilitiesOf,
  claimedRole,
  grantableRoles,
  isRoleGated,
  memberMayWriteEvent,
  roleLimit,
  writerRoleOf,
} from './roles'
import type { Role } from './v2'

describe('writerRoleOf (read tolerant)', () => {
  it('absent or 1 is a writer, 2 triage, 3 reader; anything else grants nothing', () => {
    expect(writerRoleOf(undefined)).toBe('writer')
    expect(writerRoleOf(null)).toBe('writer')
    expect(writerRoleOf(1)).toBe('writer')
    expect(writerRoleOf(2n)).toBe('triage')
    expect(writerRoleOf(3)).toBe('reader')
    expect(writerRoleOf(0)).toBeNull()
    expect(writerRoleOf(4)).toBeNull()
    expect(writerRoleOf('writer')).toBeNull()
  })
})

describe('claimedRole: the r a gated write carries', () => {
  const roles: (Role | null)[] = ['maintainer', 'writer', 'triage', 'reader', null]
  const claim = (type: string, data: Record<string, unknown>, role: Role | null): number | null | 'refused' => {
    try {
      return claimedRole(type, data, role)
    } catch (e) {
      if (e instanceof RoleRefusedError) return 'refused'
      throw e
    }
  }

  it('carries none on an ungated type, whatever the role', () => {
    for (const role of roles) for (const type of ['issue', 'comment', 'review', 'protectedRefUpdate', 'authorEvent', 'policy']) expect(claim(type, {}, role)).toBeNull()
    expect(isRoleGated('refUpdate')).toBe(true)
    expect(isRoleGated('protectedRefUpdate')).toBe(false)
  })

  it('push class and check runs: 1 for maintainers, writers and non-members (runners, the owner); refused for triage and readers', () => {
    for (const type of ['refUpdate', 'packManifest', 'chunk', 'checkRun']) {
      expect(roles.map((role) => claim(type, {}, role))).toEqual([1, 1, 'refused', 'refused', 1])
    }
  })

  it('label and milestone: 1 for maintainers and writers, 2 for triage, refused for readers', () => {
    for (const type of ['label', 'milestone']) expect(roles.map((role) => claim(type, {}, role))).toEqual([1, 1, 2, 'refused', 1])
  })

  it('transition: triage closes, reopens and locks (2), never merges, drafts or readies; the author always claims 1', () => {
    for (const kind of [1, 2, 3, 4, 11, 12, 16, 17, 18, 19]) expect(roles.map((role) => claim('transition', { kind, asAuthor: 0 }, role))).toEqual([1, 1, 2, 'refused', 1])
    for (const kind of [13, 14, 15]) expect(roles.map((role) => claim('transition', { kind, asAuthor: 0 }, role))).toEqual([1, 1, 'refused', 'refused', 1])
    for (const kind of [1, 14, 15]) expect(roles.map((role) => claim('transition', { kind, asAuthor: 7 }, role))).toEqual([1, 1, 1, 1, 1])
  })

  it('event: triage writes its kinds (2), never 8, 15, 16, 19, 20 or 23; a reader none', () => {
    for (const kind of [4, 5, 6, 7, 11, 12, 13, 14, 17, 18]) expect(roles.map((role) => claim('event', { kind }, role))).toEqual([1, 1, 2, 'refused', 1])
    for (const kind of [8, 15, 16, 19, 20, 23]) expect(roles.map((role) => claim('event', { kind: BigInt(kind) }, role))).toEqual([1, 1, 'refused', 'refused', 1])
  })

  it('says why, naming the role', () => {
    expect(() => claimedRole('refUpdate', {}, 'triage')).toThrow('your role on this repo is triage: a triage member cannot push')
    expect(() => claimedRole('transition', { kind: 13, asAuthor: 0 }, 'triage')).toThrow(/cannot merge a pull request/)
    expect(() => claimedRole('event', { kind: 4 }, 'reader')).toThrow(/^your role on this repo is reader: a reader cannot/)
  })
})

describe('capabilitiesOf', () => {
  it('triage: close, lock, label, assign, milestone, request reviews, resolve; nothing that needs role 1', () => {
    const t = capabilitiesOf('triage')
    expect([t.canCloseReopen, t.canLock, t.canLabel, t.canAssign, t.canMilestone, t.canRequestReview, t.canResolve]).toEqual(Array(7).fill(true))
    expect([t.canPush, t.canMerge, t.canDraftReady, t.canDismiss, t.canRetarget, t.canPin, t.canPostChecks, t.canBypass, t.canManageSettings]).toEqual(Array(9).fill(false))
  })

  it('a reader and a non-member: no member writes', () => {
    for (const role of ['reader', null, undefined] as const) expect(Object.values(capabilitiesOf(role)).every((v) => v === false)).toBe(true)
  })

  it('a writer: everything but bypass and settings; a maintainer: everything', () => {
    const w = capabilitiesOf('writer')
    expect(w.canPush && w.canMerge && w.canDraftReady && w.canDismiss && w.canPin && w.canPostChecks && w.canCloseReopen).toBe(true)
    expect([w.canBypass, w.canManageSettings]).toEqual([false, false])
    expect(Object.values(capabilitiesOf('maintainer')).every((v) => v === true)).toBe(true)
  })

  it('agrees with claimedRole: a capability a role lacks is a write it is refused', () => {
    const t = capabilitiesOf('triage')
    expect(t.canPush).toBe(false)
    expect(() => claimedRole('packManifest', {}, 'triage')).toThrow(RoleRefusedError)
    expect(t.canPin).toBe(false)
    expect(() => claimedRole('event', { kind: 19 }, 'triage')).toThrow(RoleRefusedError)
    expect(t.canLabel).toBe(true)
    expect(claimedRole('event', { kind: 4 }, 'triage')).toBe(2)
  })
})

describe('memberMayWriteEvent', () => {
  it('triage writes its kinds as a member; a writer-only kind or a hide goes elsewhere', () => {
    expect(memberMayWriteEvent('triage', 13)).toBe(true)
    expect(memberMayWriteEvent('triage', 16)).toBe(false)
    expect(memberMayWriteEvent('triage', 24)).toBe(false)
    expect(memberMayWriteEvent('writer', 16)).toBe(true)
    expect(memberMayWriteEvent('reader', 13)).toBe(false)
    expect(memberMayWriteEvent(null, 13)).toBe(false)
  })
})

describe('grantableRoles and roleLimit', () => {
  it('offers a reader on a private repo only', () => {
    expect(grantableRoles('public')).toEqual(['writer', 'triage', 'maintainer'])
    expect(grantableRoles('private')).toEqual(['writer', 'triage', 'reader', 'maintainer'])
  })

  it('explains a limit to triage and readers only', () => {
    expect(roleLimit('triage', 'merge pull requests')).toBe("Your role here is triage: a triage member can't merge pull requests.")
    expect(roleLimit('reader', 'label issues')).toBe("Your role here is reader: a reader can't label issues.")
    expect(roleLimit('writer', 'x')).toBeNull()
    expect(roleLimit(null, 'x')).toBeNull()
  })
})
