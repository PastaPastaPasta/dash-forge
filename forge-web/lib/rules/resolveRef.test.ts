/**
 * The causal order's invariant, exhaustively over one-block histories of five updates on four
 * tips (parity with forge-core's `causal_order_places_no_update_before_its_predecessor`): an
 * update is placed before one it builds on only when that one builds back on it through updates
 * placed no earlier (they share a cycle).
 */

import { describe, expect, it } from 'vitest'

import { causalOrderForTest, resolveRef } from './resolveRef'
import type { RefState, RefUpdate } from './types'

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

/** A ref's live heads, newest first, as a reader's fold leaves them. */
function headsOf(state: RefState): string[] {
  if (state.state === 'resolved') return [state.oid]
  if (state.state === 'diverged') return state.heads.map((h) => h.oid)
  return []
}

/**
 * The merge-settles-race property (parity with forge-core's
 * `merging_every_live_head_resolves_and_never_drops_an_unnamed_one`): over every short history
 * of fast-forwards, forces and deletes on three tips in one or two blocks, a tip that merged
 * every live head and is pushed as one update naming each head resolves for a reader with no
 * commit graph; leaving out any one of those updates leaves its head live.
 */
describe('a merge naming every live head', () => {
  const OIDS3 = ['A', 'B', 'C', '0'] as const
  const noGraph = (): boolean => false
  const update = (id: string, prevOid: string, newOid: string, createdAt: number, force = false): RefUpdate => ({
    id,
    refNameHash: 'H',
    refName: 'refs/heads/main',
    prevOid,
    newOid,
    force,
    protected: false,
    author: 'a',
    createdAt,
  })
  const mk = (i: number, code: number): RefUpdate =>
    update(
      `u${i}`,
      OIDS3[Math.floor(code / 4) % 4] as string,
      OIDS3[code % 4] as string,
      100 * (Math.floor(i / 2) + 1) + 100 * (Math.floor(code / 32) % 2),
      Math.floor(code / 16) % 2 === 1,
    )

  it('settles the race with no commit graph, and never drops a head it does not name', () => {
    let diverged = 0
    for (let a = 0; a < 64; a++) {
      for (let b = 0; b < 64; b++) {
        for (let c = 0; c < 64; c += 3) {
          const history = [mk(0, a), mk(1, b), mk(2, c)]
          const heads = headsOf(resolveRef(history, [], 'H', noGraph))
          if (heads.length === 0) continue // unborn: a push creates it, naming nothing
          for (const layout of [0, 1, 2]) {
            const settle = heads.map((prev, k) => update(layout === 1 ? `s${9 - k}` : `s${k}`, prev, 'M', 1000 + (layout === 2 ? k : 0)))
            const got = resolveRef([...history, ...settle], [], 'H', noGraph)
            if (got.state !== 'resolved' || got.oid !== 'M') expect.fail(`${JSON.stringify(history)}: ${JSON.stringify(got)}`)
            if (heads.length < 2) continue
            diverged++
            settle.forEach((_, skip) => {
              const left = headsOf(resolveRef([...history, ...settle.filter((__, k) => k !== skip)], [], 'H', noGraph))
              if (!left.includes(heads[skip] as string)) expect.fail(`${JSON.stringify(history)}: ${heads[skip]} dropped unnamed`)
            })
          }
        }
      }
    }
    expect(diverged).toBeGreaterThan(1000)
  })
})
