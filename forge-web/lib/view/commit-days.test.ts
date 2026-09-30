/** QW-061c: the commits list cut into "Commits on <day>" runs, in log order. */

import { describe, expect, it } from 'vitest'

import { dayKey, dayRuns } from './commit-days'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

describe('dayRuns', () => {
  it('cuts consecutive rows of one local day into a run, in log order', () => {
    const rows = [at(2026, 9, 30, 18), at(2026, 9, 30, 9), at(2026, 9, 29), at(2026, 9, 30, 1), 0]
    const runs = dayRuns(rows, (x) => x)
    expect(runs.map((r) => [r.day, r.rows.length])).toEqual([
      ['2026-9-30', 2],
      ['2026-9-29', 1],
      // A day that comes back (older work merged in) starts a new run.
      ['2026-9-30', 1],
      ['', 1],
    ])
    expect(runs[0]?.at).toBe(at(2026, 9, 30, 18))
  })

  it('keys an unknown time as no day', () => {
    expect(dayKey(0)).toBe('')
  })
})
