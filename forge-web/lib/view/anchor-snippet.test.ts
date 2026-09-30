import { describe, expect, it } from 'vitest'

import type { Anchor } from '../rules/v2'
import { SNIPPET_MAX_LINES, snippetLines, snippetSource } from './anchor-snippet'

const HEAD = 'ab'.repeat(20)
const OLD = 'cd'.repeat(20)
const at = (a: Partial<Anchor>): Anchor => ({ path: 'src/calc.py', line: 5, startLine: null, side: 1, commitOid: HEAD, ...a })
const FILE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

describe('snippetSource — which file a Conversation comment shows (QW2-049)', () => {
  it('reads the new side at the commit the comment names, any head', () => {
    expect(snippetSource(at({}))).toEqual({ commit: HEAD, path: 'src/calc.py' })
    expect(snippetSource(at({ commitOid: OLD }))).toEqual({ commit: OLD, path: 'src/calc.py' })
  })

  it('shows no code for the old side (its compared base is not recorded), a file-level comment, or no commit', () => {
    expect(snippetSource(at({ side: 0 }))).toBeNull()
    expect(snippetSource(at({ line: null, side: null }))).toBeNull()
    expect(snippetSource(at({ commitOid: '' }))).toBeNull()
  })
})

describe('snippetLines — the commented lines and a few above', () => {
  it('shows three lines of context, then the commented line', () => {
    expect(snippetLines(FILE, at({ line: 5 }))).toEqual([
      { n: 2, text: 'line 2', commented: false },
      { n: 3, text: 'line 3', commented: false },
      { n: 4, text: 'line 4', commented: false },
      { n: 5, text: 'line 5', commented: true },
    ])
  })

  it('marks a range, starts at line 1, and keeps a long range to its last lines', () => {
    expect(snippetLines(FILE, at({ startLine: 1, line: 2 }))?.map((l) => [l.n, l.commented])).toEqual([
      [1, true],
      [2, true],
    ])
    const long = snippetLines(FILE, at({ startLine: 3, line: 25 }))
    expect(long).toHaveLength(SNIPPET_MAX_LINES)
    expect(long?.[0]?.n).toBe(25 - SNIPPET_MAX_LINES + 1)
    expect(long?.every((l) => l.commented)).toBe(true)
  })

  it('shows nothing when the lines are not in the file or it was not read', () => {
    expect(snippetLines(FILE, at({ line: 31 }))).toBeNull()
    expect(snippetLines(null, at({}))).toBeNull()
    expect(snippetLines(undefined, at({}))).toBeNull()
  })
})
