/**
 * The causal order's invariant, exhaustively over one-block histories of five updates on four
 * tips (parity with forge-core's `causal_order_places_no_update_before_its_predecessor`): an
 * update is placed before one it builds on only when that one builds back on it through updates
 * placed no earlier (they share a cycle).
 */

import { describe, expect, it } from 'vitest'

import { causalOrderForTest } from './resolveRef'
import type { RefUpdate } from './types'

const OIDS = ['A', 'B', 'C', 'D'] as const
const PAIRS: [string, string][] = OIDS.flatMap((p) => OIDS.filter((q) => q !== p).map((q) => [p, q] as [string, string]))

const buildsOn = (v: RefUpdate, u: RefUpdate): boolean => v.prevOid === u.newOid && v.newOid !== u.newOid

describe('causalOrder', () => {
  it('places no update before one it builds on unless that one builds back on it (5 updates, one block)', () => {
    let checked = 0
    const code = [0, 0, 0, 0, 0]
    for (;;) {
      const ups: RefUpdate[] = code.map((c, i) => ({
        id: 'abcde'[i] as string,
        refNameHash: 'H',
        refName: 'refs/heads/main',
        prevOid: (PAIRS[c] as [string, string])[0],
        newOid: (PAIRS[c] as [string, string])[1],
        force: false,
        protected: false,
        author: 'a',
        createdAt: 100,
      }))
      const order = causalOrderForTest(ups)
      const reaches = (from: number, to: number, within: number): boolean => {
        const seen = order.map(() => false)
        const todo = [from]
        for (let x = todo.pop(); x !== undefined; x = todo.pop()) {
          for (let y = within; y < order.length; y++) {
            if (!seen[y] && buildsOn(order[x] as RefUpdate, order[y] as RefUpdate)) {
              if (y === to) return true
              seen[y] = true
              todo.push(y)
            }
          }
        }
        return false
      }
      for (let u = 0; u < order.length; u++) {
        for (let v = u + 1; v < order.length; v++) {
          if (buildsOn(order[u] as RefUpdate, order[v] as RefUpdate) && !reaches(v, u, u)) {
            expect.fail(`${order[u]?.id} placed before its predecessor ${order[v]?.id} in ${JSON.stringify(code)}`)
          }
        }
      }
      checked++
      let d = 0
      for (; d < code.length; d++) {
        code[d] = (code[d] as number) + 1
        if ((code[d] as number) < PAIRS.length) break
        code[d] = 0
      }
      if (d === code.length) break
    }
    expect(checked).toBe(PAIRS.length ** 5)
  })
})
