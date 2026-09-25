import { describe, expect, it } from 'vitest'

import { compactDiffLines, diffStat, diffTextLines, type TextDiffLine } from './text-diff'

/** Rebuild both sides from a diff: the invariant every correct line diff satisfies. */
function sides(lines: readonly TextDiffLine[]): { before: string[]; after: string[] } {
  const before: string[] = []
  const after: string[] = []
  for (const l of lines) {
    if (l.kind !== 'added') before.push(l.text)
    if (l.kind !== 'deleted') after.push(l.text)
  }
  return { before, after }
}

describe('diffTextLines', () => {
  it('tracks line numbers across additions and deletions', () => {
    expect(diffTextLines('one\ntwo\nthree\n', 'one\nsecond\nthree\nfour\n')).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'one' },
      { kind: 'deleted', oldLine: 2, newLine: null, text: 'two' },
      { kind: 'added', oldLine: null, newLine: 2, text: 'second' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'three' },
      { kind: 'added', oldLine: null, newLine: 4, text: 'four' },
    ])
  })

  it('shows every line as added for a new file and deleted for a removed one', () => {
    expect(diffTextLines('', 'a\nb\n')?.map((l) => [l.kind, l.newLine])).toEqual([
      ['added', 1],
      ['added', 2],
    ])
    expect(diffTextLines('a\nb\n', '')?.map((l) => [l.kind, l.oldLine])).toEqual([
      ['deleted', 1],
      ['deleted', 2],
    ])
  })

  it('treats a missing final newline as a change and flags it', () => {
    const lines = diffTextLines('a\nb', 'a\nb\n')
    expect(lines).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'deleted', oldLine: 2, newLine: null, text: 'b', noNewline: true },
      { kind: 'added', oldLine: null, newLine: 2, text: 'b' },
    ])
  })

  it('strips CRLF terminators from the displayed text', () => {
    expect(diffTextLines('a\r\n', 'b\r\n')?.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('produces a minimal diff that reconstructs both sides', () => {
    const before = ['a', 'b', 'c', 'a', 'b', 'b', 'a']
    const after = ['c', 'b', 'a', 'b', 'a', 'c']
    const lines = diffTextLines(`${before.join('\n')}\n`, `${after.join('\n')}\n`)
    expect(lines).not.toBeNull()
    expect(sides(lines!)).toEqual({ before, after })
    // Myers' classic example: the shortest edit script has length 5.
    const { added, deleted } = diffStat(lines!)
    expect(added + deleted).toBe(5)
  })

  it('reconstructs both sides for arbitrary inputs', () => {
    let seed = 7
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let round = 0; round < 200; round++) {
      const make = (): string[] => Array.from({ length: rand(12) }, () => 'abc'[rand(3)] as string)
      const before = make()
      const after = make()
      const lines = diffTextLines(before.map((l) => `${l}\n`).join(''), after.map((l) => `${l}\n`).join(''))
      expect(sides(lines!)).toEqual({ before, after })
    }
  })

  it('stays cheap for a one-line change in a very large file', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `line ${i}`)
    const changed = [...big]
    changed[25_000] = 'changed'
    const lines = diffTextLines(big.join('\n'), changed.join('\n'), { maxEdits: 10, maxWork: 1000 })
    expect(lines).not.toBeNull()
    expect(diffStat(lines!)).toEqual({ added: 1, deleted: 1 })
  })

  it('diffs a large new or deleted file without searching', () => {
    const big = Array.from({ length: 100_000 }, (_, i) => `l${i}\n`).join('')
    const tight = { maxEdits: 1, maxWork: 1 }
    expect(diffStat(diffTextLines('', big, tight)!)).toEqual({ added: 100_000, deleted: 0 })
    expect(diffStat(diffTextLines(big, '', tight)!)).toEqual({ added: 0, deleted: 100_000 })
    expect(diffStat(diffTextLines(big, `${big}tail\n`, tight)!)).toEqual({ added: 1, deleted: 0 })
  })

  it('declines a change beyond the edit bound', () => {
    const before = Array.from({ length: 100 }, (_, i) => `a${i}`).join('\n')
    const after = Array.from({ length: 100 }, (_, i) => `b${i}`).join('\n')
    expect(diffTextLines(before, after, { maxEdits: 50, maxWork: 1_000_000 })).toBeNull()
    expect(diffTextLines(before, after, { maxEdits: 1000, maxWork: 10 })).toBeNull()
    expect(diffTextLines(before, after)).not.toBeNull()
  })
})

describe('compactDiffLines', () => {
  it('replaces distant unchanged runs with gap rows that count what they hide', () => {
    const lines = diffTextLines('a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nC\nd\ne\nf\nG\n')
    expect(lines).not.toBeNull()
    expect(compactDiffLines(lines!, 1)).toEqual([
      { kind: 'gap', hidden: 1 },
      { kind: 'context', oldLine: 2, newLine: 2, text: 'b' },
      { kind: 'deleted', oldLine: 3, newLine: null, text: 'c' },
      { kind: 'added', oldLine: null, newLine: 3, text: 'C' },
      { kind: 'context', oldLine: 4, newLine: 4, text: 'd' },
      { kind: 'gap', hidden: 1 },
      { kind: 'context', oldLine: 6, newLine: 6, text: 'f' },
      { kind: 'deleted', oldLine: 7, newLine: null, text: 'g' },
      { kind: 'added', oldLine: null, newLine: 7, text: 'G' },
    ])
  })

  it('emits a trailing gap after the last change', () => {
    const lines = diffTextLines('x\na\nb\nc\nd\n', 'y\na\nb\nc\nd\n')
    expect(compactDiffLines(lines!, 1).at(-1)).toEqual({ kind: 'gap', hidden: 3 })
  })
})
