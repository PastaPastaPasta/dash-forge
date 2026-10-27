/**
 * Properties of the board rules the vectors cannot list case by case (forge-core
 * `rules::boards::tests` checks the same, with the same PRNG): `rankBetween` is strictly
 * between for every pair, specs round-trip, dates and Mondays.
 */

import { describe, expect, it } from 'vitest'

import { compareStrings } from './oid'
import { RANK_DIGITS, RANK_MAX, RERANK_MAX, dateDays, dateOf, defaultSpec, isExplicitRank, mondayOf, parseSpec, rankBetween, rerank, serializeSpec } from './boards'

const DAY = 86_400_000

/** splitmix64, the same as the Rust test's `Rng`. */
class Rng {
  private s: bigint
  constructor(seed: bigint) {
    this.s = seed
  }
  next(): bigint {
    const M = (1n << 64n) - 1n
    this.s = (this.s + 0x9e3779b97f4a7c15n) & M
    let z = this.s
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M
    return z ^ (z >> 31n)
  }
  below(n: number): number {
    return Number(this.next() % BigInt(n))
  }
  /** 0-`max` rank digits, biased to `0`, `1`, `y`, `z` (the edges). */
  digits(max: number): string {
    const len = this.below(max + 1)
    let out = ''
    for (let i = 0; i < len; i++) out += this.below(4) === 0 ? '01yz'[this.below(4)] : RANK_DIGITS[this.below(62)]
    return out
  }
}

/** Whether nothing lies strictly between `a` < `b`: `b` is `a` and only `0`s. */
const nothingBetween = (a: string, b: string) => b.length > a.length && b.startsWith(a) && /^0+$/.test(b.slice(a.length))

function checkBetween(a: string, b: string): void {
  const r = rankBetween(a, b)
  if ('rank' in r) {
    expect(compareStrings(a, r.rank), `${a} < ${r.rank}`).toBeLessThan(0)
    if (b !== '') expect(compareStrings(r.rank, b), `${r.rank} < ${b}`).toBeLessThan(0)
    expect(isExplicitRank(r.rank)).toBe(true)
    expect(r.rank.length).toBeLessThanOrEqual(Math.max(a.length, b.length) + 1)
  } else {
    expect(r.error, `${a} ${b}`).toBe('re-rank')
    expect(nothingBetween(a, b) || Math.max(a.length, b.length) >= RANK_MAX, `${a} ${b}`).toBe(true)
  }
}

describe('rankBetween', () => {
  it('is strictly between, for every pair (prefix relations included)', () => {
    const rng = new Rng(0x00b0a2d5n)
    for (let n = 0; n < 20_000; n++) {
      let x = rng.digits(6)
      let y = rng.digits(6)
      // half the pairs share a prefix, so prefix relations (V / V1 / V10) are common
      if (rng.below(2) === 0) {
        const p = rng.digits(4)
        x = p + x
        y = p + y
      }
      const c = compareStrings(x, y)
      if (c < 0) checkBetween(x, y)
      else if (c > 0) checkBetween(y, x)
      else expect(rankBetween(x, y)).toEqual(x === '' ? { rank: 'V' } : { error: 're-rank' })
      checkBetween(x, '')
      if (x !== '') checkBetween('', x)
    }
  })

  it('handles implicit bounds ending in 0', () => {
    for (const [a, b] of [['V', 'V0'], ['V1', 'V10'], ['V1', 'V100'], ['V10', 'V1000'], ['', '0'], ['', '00']]) expect(rankBetween(a!, b!)).toEqual({ error: 're-rank' })
    expect(rankBetween('V1', 'V101')).toEqual({ rank: 'V100V' })
    expect(rankBetween('V', 'V01')).toEqual({ rank: 'V00V' })
  })

  it('runs out after a few hundred drops into one gap', () => {
    let hi = 'V'
    let drops = 0
    for (let r = rankBetween('', hi); 'rank' in r; r = rankBetween('', hi)) {
      hi = r.rank
      drops++
    }
    expect(drops).toBeGreaterThanOrEqual(300)
    expect(drops).toBeLessThanOrEqual(400)
  })
})

describe('rerank', () => {
  it('spreads ranks below the pool with room between', () => {
    for (const n of [0, 1, 2, 3, 30, 31, 100, 1921, 1922, 5000]) {
      const r = rerank(n)
      if (!('ranks' in r)) throw new Error('refused')
      expect(r.ranks.length).toBe(n)
      for (let i = 1; i < r.ranks.length; i++) {
        expect(compareStrings(r.ranks[i - 1]!, r.ranks[i]!)).toBeLessThan(0)
        expect('rank' in rankBetween(r.ranks[i - 1]!, r.ranks[i]!)).toBe(true)
      }
      expect(r.ranks.every((x) => isExplicitRank(x) && compareStrings(x, 'V') < 0)).toBe(true)
    }
    expect(rerank(RERANK_MAX + 1)).toEqual({ error: 'invalid' })
    expect(rerank(1.5)).toEqual({ error: 'invalid' })
  })
})

describe('spec', () => {
  it('round-trips the template within 4096 bytes', () => {
    const spec = defaultSpec('4tJ7mVo5yJm4b6rKZ2SRsG6YqfJHFDLC2kUwD3nAhZ7b', Date.UTC(2026, 9, 30))
    const out = serializeSpec(spec)
    if (!('json' in out)) throw new Error(out.error)
    const back = parseSpec(out.json)
    expect(back).toEqual({ spec })
    expect(serializeSpec(spec)).toEqual(out)
    expect(new TextEncoder().encode(out.json).length).toBeLessThanOrEqual(4096)
  })
})

describe('dates', () => {
  it('reads calendar dates and finds Mondays (UTC)', () => {
    expect(dateDays('1970-01-01')).toBe(0)
    expect(dateDays('2024-02-29')).toBe(19_782)
    expect(dateDays('2023-02-29')).toBeNull()
    expect(dateOf(19_782 * DAY)).toBe('2024-02-29')
    expect(mondayOf(0)).toBe('1969-12-29')
    expect(mondayOf(dateDays('2026-10-27')! * DAY + 5)).toBe('2026-10-26')
    expect(mondayOf(dateDays('2026-10-26')! * DAY)).toBe('2026-10-26')
    for (const d of [-719_162, -700_000, -1, 0, 59, 60, 10_000, 2_932_896]) expect(dateDays(dateOf(d * DAY))).toBe(d)
  })
})
