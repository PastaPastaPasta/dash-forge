import { describe, expect, it } from 'vitest'

import { mapPooled } from './pool'

describe('mapPooled', () => {
  it('keeps input order and at most `limit` calls in flight', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapPooled([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, n))
      inFlight--
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
    expect(peak).toBe(2)
  })

  it('starts no further item once one rejects', async () => {
    const started: number[] = []
    const run = mapPooled([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
      started.push(n)
      await new Promise((r) => setTimeout(r, 1))
      if (n === 1) throw new Error('window 1 failed')
      return n
    })
    await expect(run).rejects.toThrow('window 1 failed')
    await new Promise((r) => setTimeout(r, 20))
    // 0 and 1 ran together, 2 was taken when 0 finished; nothing after 1 failed.
    expect(started.length).toBeLessThanOrEqual(3)
  })

  it('rejects only once the calls already in flight have settled', async () => {
    const settled: number[] = []
    const run = mapPooled([0, 1, 2, 3], 4, async (i) => {
      await new Promise((r) => setTimeout(r, i === 0 ? 1 : 20))
      settled.push(i)
      if (i === 0) throw new Error('window 0 failed')
      return i
    })
    await expect(run).rejects.toThrow('window 0 failed')
    // The pool did not reject while windows 1..3 were still reading.
    expect(settled.sort()).toEqual([0, 1, 2, 3])
  })
})
