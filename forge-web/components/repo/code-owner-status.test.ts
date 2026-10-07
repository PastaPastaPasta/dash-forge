import { describe, expect, it } from 'vitest'

import { codeOwnerChangesIncomplete } from './code-owners'

describe('codeOwnerChangesIncomplete (the code owner rule fails closed)', () => {
  it('trusts a complete merge-base listing', () => {
    expect(codeOwnerChangesIncomplete(null, { truncated: false })).toBe(false)
  })
  it('does not trust a failed, cut-short, fallen-back or stopped listing', () => {
    expect(codeOwnerChangesIncomplete('boom', null)).toBe(true)
    expect(codeOwnerChangesIncomplete(null, { truncated: true })).toBe(true)
    expect(codeOwnerChangesIncomplete(null, { truncated: false, fellBack: true })).toBe(true)
    expect(codeOwnerChangesIncomplete(null, { truncated: false, fellBack: true, searchStopped: true })).toBe(true)
  })
})

describe('codeOwnerVerdict', async () => {
  const { codeOwnerVerdict } = await import('./code-owners')
  const { parseCodeOwners } = await import('@/lib/rules/codeowners')
  const base = {
    policy: { requiredApprovals: 0, requireCodeOwners: true },
    file: { path: 'CODEOWNERS', owners: parseCodeOwners('/src/ @alice\n') },
    paths: ['src/a.rs'],
    changesFailed: false,
    approvals: { approvers: [], changesRequested: [] },
    members: [],
    author: 'P',
    names: ['@alice'],
  } as const
  it("is unreadable when the owners' names could not be resolved", () => {
    expect(codeOwnerVerdict({ ...base, resolved: 'failed' })).toEqual({ met: false, unreadable: true, pending: [] })
  })
  it('waits while the names are read, then judges', () => {
    expect(codeOwnerVerdict({ ...base, resolved: null })).toBe('unknown')
    expect(codeOwnerVerdict({ ...base, resolved: new Map([['@alice', null]]) })).toMatchObject({ met: false, unreadable: false })
  })
})
