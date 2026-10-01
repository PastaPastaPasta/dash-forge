import { describe, expect, it } from 'vitest'

import type { Anchor } from '../rules/v2'
import { carryAnchor, carryLines, carrySources } from './carry-anchor'

const OLD = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const text = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('')

describe('carryLines', () => {
  it('keeps the lines of an unchanged file where they are', () => {
    const t = text('a', 'b', 'c')
    expect(carryLines(t, t, 2, 3)).toEqual({ start: 2, end: 3 })
  })

  it('moves unchanged lines with the lines inserted above them', () => {
    expect(carryLines(text('a', 'b', 'c'), text('x', 'y', 'a', 'b', 'c'), 2, 3)).toEqual({ start: 4, end: 5 })
  })

  it('refuses a changed line, a deleted one, or a range split by an insertion', () => {
    expect(carryLines(text('a', 'b', 'c'), text('a', 'B', 'c'), 2, 2)).toBeNull()
    expect(carryLines(text('a', 'b', 'c'), text('a', 'c'), 2, 2)).toBeNull()
    expect(carryLines(text('a', 'b', 'c'), text('a', 'b', 'new', 'c'), 2, 3)).toBeNull()
    expect(carryLines(text('a'), text('a'), 0, 1)).toBeNull()
  })
})

describe('carryAnchor (QW3-015)', () => {
  const anchor = (over: Partial<Anchor> = {}): Anchor => ({ path: 'test_calc.py', line: 1, startLine: null, side: 1, commitOid: OLD, ...over })
  const files: Record<string, string> = {
    [`${OLD}:test_calc.py`]: text('from calc import add, div, mean', '', 'def test_add():'),
    [`${HEAD}:test_calc.py`]: text('from calc import add, div, mean', '', 'def test_add():'),
    [`${OLD}:calc.py`]: text('def div(a, b):', "    raise ValueError('x')"),
    [`${HEAD}:calc.py`]: text('def div(a, b):', "    raise ZeroDivisionError('x')"),
  }
  const texts = (c: string, p: string): string | null | undefined => files[`${c}:${p}`]

  it('carries a comment on a file the new head did not touch to the head, so it stays current and appliable', () => {
    expect(carryAnchor(anchor(), HEAD, texts)).toEqual(anchor({ commitOid: HEAD }))
  })

  it('keeps a comment on a changed line outdated', () => {
    expect(carryAnchor(anchor({ path: 'calc.py', line: 2 }), HEAD, texts)).toBeNull()
    // The unchanged line above it still carries.
    expect(carryAnchor(anchor({ path: 'calc.py', line: 1 }), HEAD, texts)).toEqual(anchor({ path: 'calc.py', line: 1, commitOid: HEAD }))
  })

  it('carries a range as a range', () => {
    expect(carryAnchor(anchor({ line: 3, startLine: 1 }), HEAD, texts)).toEqual(anchor({ line: 3, startLine: 1, commitOid: HEAD }))
  })

  it('leaves old-side, file-level, current and unread anchors alone', () => {
    expect(carryAnchor(anchor({ side: 0 }), HEAD, texts)).toBeNull()
    expect(carryAnchor(anchor({ line: null, side: null }), HEAD, texts)).toBeNull()
    expect(carryAnchor(anchor({ commitOid: HEAD }), HEAD, texts)).toBeNull()
    expect(carryAnchor(anchor({ path: 'missing.py' }), HEAD, texts)).toBeNull()
    expect(carrySources(anchor({ commitOid: '' }), HEAD)).toBeNull()
    expect(carrySources(anchor(), HEAD)).toEqual([
      { commit: OLD, path: 'test_calc.py' },
      { commit: HEAD, path: 'test_calc.py' },
    ])
  })
})
