import { describe, expect, it } from 'vitest'

import { branchShown, headSync } from './source-branch'

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
