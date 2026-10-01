import { describe, expect, it } from 'vitest'

import type { Anchor } from '../rules/v2'
import { carryAnchor, carryFrom, carryLines, lineMap } from './carry-anchor'

const OLD = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const text = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('')
const carry = (before: string, after: string, start: number, end: number) => carryLines(lineMap(before, after)!, start, end)

describe('carryLines over a lineMap', () => {
  it('keeps the lines of an unchanged file where they are, and none past its end', () => {
    const t = text('a', 'b', 'c')
    expect(carry(t, t, 2, 3)).toEqual({ start: 2, end: 3 })
    expect(carry(t, t, 3, 4)).toBeNull()
    expect(carry(t, t, 50, 50)).toBeNull()
  })

  it('moves unchanged lines with the lines inserted above them', () => {
    expect(carry(text('a', 'b', 'c'), text('x', 'y', 'a', 'b', 'c'), 2, 3)).toEqual({ start: 4, end: 5 })
  })

  it('refuses a changed line, a deleted one, or a range split by an insertion', () => {
    expect(carry(text('a', 'b', 'c'), text('a', 'B', 'c'), 2, 2)).toBeNull()
    expect(carry(text('a', 'b', 'c'), text('a', 'c'), 2, 2)).toBeNull()
    expect(carry(text('a', 'b', 'c'), text('a', 'b', 'new', 'c'), 2, 3)).toBeNull()
    expect(carry(text('a'), text('a'), 0, 1)).toBeNull()
  })
})

describe('carryAnchor (QW3-015)', () => {
  const anchor = (over: Partial<Anchor> = {}): Anchor => ({ path: 'test_calc.py', line: 1, startLine: null, side: 1, commitOid: OLD, ...over })
  const untouched = lineMap(text('from calc import add, div, mean', '', 'def test_add():'), text('from calc import add, div, mean', '', 'def test_add():'))
  const edited = lineMap(text('def div(a, b):', "    raise ValueError('x')"), text('def div(a, b):', "    raise ZeroDivisionError('x')"))

  it('carries a comment on a file the new head did not touch to the head, so it stays current and appliable', () => {
    expect(carryAnchor(anchor(), HEAD, untouched)).toEqual(anchor({ commitOid: HEAD }))
  })

  it('keeps a comment on a changed line outdated, and carries the unchanged line above it', () => {
    expect(carryAnchor(anchor({ path: 'calc.py', line: 2 }), HEAD, edited)).toBeNull()
    expect(carryAnchor(anchor({ path: 'calc.py', line: 1 }), HEAD, edited)).toEqual(anchor({ path: 'calc.py', line: 1, commitOid: HEAD }))
  })

  it('carries a range as a range', () => {
    expect(carryAnchor(anchor({ line: 3, startLine: 1 }), HEAD, untouched)).toEqual(anchor({ line: 3, startLine: 1, commitOid: HEAD }))
  })

  it('leaves old-side, file-level, current and unread anchors alone', () => {
    expect(carryAnchor(anchor({ side: 0 }), HEAD, untouched)).toBeNull()
    expect(carryAnchor(anchor({ line: null, side: null }), HEAD, untouched)).toBeNull()
    expect(carryAnchor(anchor({ commitOid: HEAD }), HEAD, untouched)).toBeNull()
    expect(carryAnchor(anchor(), HEAD, undefined)).toBeNull()
    expect(carryAnchor(anchor(), HEAD, null)).toBeNull()
    expect(carryFrom(anchor({ commitOid: '' }), HEAD)).toBeNull()
    expect(carryFrom(anchor(), HEAD)).toBe(OLD)
  })
})
