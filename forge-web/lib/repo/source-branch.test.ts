import { describe, expect, it } from 'vitest'

import { headSync } from './source-branch'

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
