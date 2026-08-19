import { describe, expect, it } from 'vitest'

import { compactDiffLines, diffTextLines } from './text-diff'

describe('diffTextLines', () => {
  it('tracks line numbers across additions and deletions', () => {
    expect(diffTextLines('one\ntwo\nthree', 'one\nsecond\nthree\nfour')).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'one' },
      { kind: 'deleted', oldLine: 2, newLine: null, text: 'two' },
      { kind: 'added', oldLine: null, newLine: 2, text: 'second' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'three' },
      { kind: 'added', oldLine: null, newLine: 4, text: 'four' },
    ])
  })

  it('declines inputs beyond the work bound', () => {
    expect(diffTextLines('a\nb', 'a\nb', 8)).toBeNull()
  })

  it('compacts distant unchanged regions into gap rows', () => {
    const lines = diffTextLines('a\nb\nc\nd\ne\nf\ng', 'a\nb\nC\nd\ne\nf\nG')
    expect(lines).not.toBeNull()
    expect(compactDiffLines(lines!, 1).map((line) => line.kind)).toEqual([
      'gap',
      'context',
      'deleted',
      'added',
      'context',
      'gap',
      'context',
      'deleted',
      'added',
    ])
  })
})
