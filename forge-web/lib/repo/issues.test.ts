import { describe, expect, it } from 'vitest'

import type { RefUpdate } from '../rules'
import { baseRefTips } from './issues'

const NULL = '0'.repeat(40)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

function update(id: string, createdAt: number, newOid: string, isProtected = false): RefUpdate {
  return { id, refNameHash: 'h', refName: 'refs/heads/main', newOid, createdAt, author: 'o', protected: isProtected }
}

describe('baseRefTips', () => {
  it('orders plain and protected updates together by (createdAt, id)', () => {
    // As readRefUpdates returns them: all plain updates, then all protected ones.
    const tips = baseRefTips([update('p1', 10, A), update('p2', 30, C), update('q1', 20, B, true)], 25)
    expect(tips.historical).toEqual([A, B, C])
    expect(tips.tip).toBe(C)
    expect(tips.atOpen).toBe(B)
  })

  it('never takes a deletion as the current tip', () => {
    const tips = baseRefTips([update('1', 10, A), update('2', 20, NULL)], 30)
    expect(tips.historical).toEqual([A])
    expect(tips.tip).toBe(A)
    // …but a ref deleted when the PR was opened had nothing to compare against.
    expect(tips.atOpen).toBe('')
  })

  it('leaves atOpen undefined when the ref had no update before the PR', () => {
    expect(baseRefTips([update('1', 50, A)], 10).atOpen).toBeUndefined()
    expect(baseRefTips([], 10)).toEqual({ historical: [], tip: undefined, atOpen: undefined })
  })

  it('breaks a createdAt tie by document id', () => {
    const tips = baseRefTips([update('b', 10, B), update('a', 10, A)], 10)
    expect(tips.tip).toBe(B)
    expect(tips.atOpen).toBe(B)
  })
})
