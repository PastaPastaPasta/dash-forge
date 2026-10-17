import { describe, expect, it } from 'vitest'

import type { RefState } from '../rules'
import { branchShown, branchWriteSeen, headSync, headUpdateRefusal, type BranchWrite } from './source-branch'

const H = 'a'.repeat(40)
const T = 'b'.repeat(40)
const resolved = (oid: string) => ({ state: 'resolved' as const, oid, author: 'x', createdAt: 1 })

describe('headSync: the head-sync banner decides only on what it knows', () => {
  it('in sync, or ahead on a resolved branch', () => {
    expect(headSync(H, resolved(H))).toEqual({ kind: 'in-sync' })
    expect(headSync(H, resolved(T))).toEqual({ kind: 'ahead', tip: T })
  })

  it('deleted only when the ref resolves to unborn', () => {
    expect(headSync(H, { state: 'unborn' })).toEqual({ kind: 'deleted' })
  })

  it('unknown when the ref could not be read: an imported refs/mirror head, a sealed private source, no ref at all', () => {
    expect(headSync(H, null)).toEqual({ kind: 'unknown' })
  })

  it('unknown for a diverged branch: no single head to offer', () => {
    expect(headSync(H, { state: 'diverged', heads: [{ oid: T, author: 'x', createdAt: 1 }] as never })).toEqual({ kind: 'unknown' })
  })
})

describe('branchShown: a branch this page just deleted or restored shows so until a read catches up (QW3-053)', () => {
  const ref = 'refs/heads/feature'
  const deleted = { ref, head: H, to: 'deleted' as const }
  const restored = { ref, head: H, to: 'restored' as const }

  it('shows a deletion over a stale read of the old tip, and the read once it differs', () => {
    expect(branchShown({ kind: 'in-sync' }, deleted, ref, H)).toEqual({ kind: 'deleted' })
    expect(branchShown(null, deleted, ref, H)).toEqual({ kind: 'deleted' })
    expect(branchShown({ kind: 'deleted' }, deleted, ref, H)).toEqual({ kind: 'deleted' })
    // Pushed again since: the read wins.
    expect(branchShown({ kind: 'ahead', tip: T }, deleted, ref, H)).toEqual({ kind: 'ahead', tip: T })
  })

  it('shows a restore over a stale read of the deletion', () => {
    expect(branchShown({ kind: 'deleted' }, restored, ref, H)).toEqual({ kind: 'in-sync' })
    expect(branchShown({ kind: 'ahead', tip: T }, restored, ref, H)).toEqual({ kind: 'ahead', tip: T })
  })

  it('ignores a write for another branch or another head', () => {
    expect(branchShown({ kind: 'in-sync' }, deleted, 'refs/heads/other', H)).toEqual({ kind: 'in-sync' })
    expect(branchShown({ kind: 'in-sync' }, deleted, ref, T)).toEqual({ kind: 'in-sync' })
    expect(branchShown({ kind: 'in-sync' }, null, ref, H)).toEqual({ kind: 'in-sync' })
  })
})

/**
 * #556: after a browser commit (an applied suggestion, Update branch) the PR head follows the new
 * commit, but a same-repo source branch is read from the repo home, which can still hold the old
 * tip. The page must not offer "Update PR head" naming that older tip (a backward move), and a
 * head update is judged again at the click from fresh reads.
 */
const OLD = '71'.repeat(20)
const NEW = 'a5'.repeat(20)
const REF = 'refs/heads/feature/x'

const resolvedRef = (oid: string): RefState => ({ state: 'resolved', oid, author: 'me', createdAt: 1 })
const committed: BranchWrite = { ref: REF, head: NEW, to: 'committed', from: OLD }

describe('branchShown after a browser commit (#556)', () => {
  it('without the record, the stale read offers the old tip as an update (the bug)', () => {
    // The PR head is NEW (the thread refreshed); the repo home still says the branch is at OLD.
    expect(headSync(NEW, resolvedRef(OLD))).toEqual({ kind: 'ahead', tip: OLD })
  })

  it('a read still at the commit parent is not offered once the PR head is the commit', () => {
    const read = headSync(NEW, resolvedRef(OLD))
    expect(branchShown(read, committed, REF, NEW)).toEqual({ kind: 'in-sync' })
  })

  it('a read at any other tip wins (someone pushed again)', () => {
    const other = 'cd'.repeat(20)
    const read = headSync(NEW, resolvedRef(other))
    expect(branchShown(read, committed, REF, NEW)).toEqual({ kind: 'ahead', tip: other })
  })

  it('masks the other half of the lag: the branch read at the commit before the PR head followed it', () => {
    // The home re-read landed before the thread refresh: offering NEW would only repeat the head update.
    expect(branchShown(headSync(OLD, resolvedRef(NEW)), committed, REF, OLD)).toEqual({ kind: 'in-sync' })
    // a read at any third tip still wins in that window
    const other = 'cd'.repeat(20)
    expect(branchShown(headSync(OLD, resolvedRef(other)), committed, REF, OLD)).toEqual({ kind: 'ahead', tip: other })
  })

  it('does not mask another ref, or a head that is neither the commit nor its parent', () => {
    const stale = headSync(NEW, resolvedRef(OLD))
    expect(branchShown(stale, committed, 'refs/heads/other', NEW)).toEqual({ kind: 'ahead', tip: OLD })
    expect(branchShown(stale, { ...committed, head: 'ee'.repeat(20) }, REF, NEW)).toEqual({ kind: 'ahead', tip: OLD })
  })

  it('keeps the record until a read in sync with the new head shows it', () => {
    // Right after the commit: head still OLD and the read in sync with it. Not yet seen.
    expect(branchWriteSeen(headSync(OLD, resolvedRef(OLD)), committed, OLD)).toBe(false)
    // The head followed, the read still lags.
    expect(branchWriteSeen(headSync(NEW, resolvedRef(OLD)), committed, NEW)).toBe(false)
    // A read at the new tip with the new head: seen, the read alone speaks again.
    expect(branchWriteSeen(headSync(NEW, resolvedRef(NEW)), committed, NEW)).toBe(true)
  })

  it('lets the record go on any read past the lag, so it never hides a later push or rewind', () => {
    const other = 'cd'.repeat(20)
    expect(branchWriteSeen(headSync(NEW, resolvedRef(other)), committed, NEW)).toBe(true)
    expect(branchWriteSeen({ kind: 'deleted' }, committed, NEW)).toBe(true)
    // an unknown read says nothing either way
    expect(branchWriteSeen({ kind: 'unknown' }, committed, NEW)).toBe(false)
  })

  it('keeps the delete and restore bookkeeping as it was', () => {
    const del: BranchWrite = { ref: REF, head: NEW, to: 'deleted' }
    const res: BranchWrite = { ref: REF, head: NEW, to: 'restored' }
    expect(branchShown(headSync(NEW, resolvedRef(NEW)), del, REF, NEW)).toEqual({ kind: 'deleted' })
    expect(branchWriteSeen(headSync(NEW, { state: 'unborn' }), del, NEW)).toBe(true)
    expect(branchShown(headSync(NEW, { state: 'unborn' }), res, REF, NEW)).toEqual({ kind: 'in-sync' })
    expect(branchWriteSeen(headSync(NEW, resolvedRef(NEW)), res, NEW)).toBe(true)
    expect(branchWriteSeen(null, res, NEW)).toBe(false)
    expect(branchWriteSeen(headSync(NEW, resolvedRef(NEW)), null, NEW)).toBe(false)
  })
})

describe('headUpdateRefusal (#556)', () => {
  const branch = 'feature/x'

  it('refuses a stale proposal: the branch is not at the proposed tip', () => {
    const stale = headUpdateRefusal({ proposed: OLD, tip: NEW, head: 'cd'.repeat(20), branch })
    expect(stale).toContain(`is at ${NEW.slice(0, 9)} now`)
    expect(stale).toContain('Nothing was signed')
  })

  it('catches the live case: after a browser commit the banner proposed its parent, the branch is at the commit', () => {
    // The head and the fresh tip are the suggestion commit; the stale banner offered its parent.
    expect(headUpdateRefusal({ proposed: OLD, tip: NEW, head: NEW, branch })).toContain(`is at ${NEW.slice(0, 9)} now, not ${OLD.slice(0, 9)}`)
  })

  it('refuses when the branch no longer resolves to one commit', () => {
    expect(headUpdateRefusal({ proposed: NEW, tip: null, head: OLD, branch })).toContain('no longer points at one commit')
  })

  it('refuses a proposal equal to the head', () => {
    expect(headUpdateRefusal({ proposed: NEW, tip: NEW, head: NEW, branch })).toContain('nothing to update')
  })

  it('allows the fresh tip: a push on top, or a force-push that rewound the branch to a commit the head holds', () => {
    expect(headUpdateRefusal({ proposed: NEW, tip: NEW, head: OLD, branch })).toBeNull()
    expect(headUpdateRefusal({ proposed: NEW, tip: NEW.toUpperCase(), head: OLD, branch })).toBeNull()
    // the branch really is at OLD (rewound by a force-push) while the head is NEW, which contains it
    expect(headUpdateRefusal({ proposed: OLD, tip: OLD, head: NEW, branch })).toBeNull()
  })
})
