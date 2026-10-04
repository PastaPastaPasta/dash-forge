import { describe, expect, it } from 'vitest'
import { escapeHtml, markSpans, pairWordDiffs, tokenize, wordDiff, type Span } from './word-diff'
import type { TextDiffLine } from './text-diff'

const pick = (text: string, spans: readonly Span[]): string[] => spans.map(([a, b]) => text.slice(a, b))

describe('tokenize', () => {
  it('splits words, whitespace and punctuation, and covers every character', () => {
    const text = 'let été_2 = foo(a, "b");\t// ok'
    expect(tokenize(text).join('')).toBe(text)
    expect(tokenize('foo(a, b)')).toEqual(['foo', '(', 'a', ',', ' ', 'b', ')'])
    expect(tokenize('été_2')).toEqual(['été_2'])
  })
})

describe('wordDiff', () => {
  it('marks the changed word on each side', () => {
    const a = 'const timeout = 30 * SECOND'
    const b = 'const timeout = 60 * SECOND'
    const d = wordDiff(a, b)!
    expect(pick(a, d.a)).toEqual(['30'])
    expect(pick(b, d.b)).toEqual(['60'])
  })

  it('marks an insertion on the new side only', () => {
    const d = wordDiff('call(a)', 'call(a, b)')!
    expect(d.a).toEqual([])
    expect(pick('call(a, b)', d.b)).toEqual([', b'])
  })

  it('joins changed words separated only by whitespace into one span', () => {
    const a = 'if foo bar then'
    const b = 'if baz qux then'
    const d = wordDiff(a, b)!
    expect(pick(a, d.a)).toEqual(['foo bar'])
    expect(pick(b, d.b)).toEqual(['baz qux'])
  })

  it('marks an indentation change', () => {
    const d = wordDiff('  x()', '    x()')!
    expect(pick('    x()', d.b)).toEqual(['    '])
  })

  it('gives up on a rewritten line and on a very long one', () => {
    expect(wordDiff('return compute(alpha, beta)', 'throw new Error("nope")')).toBeNull()
    const long = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ')
    expect(wordDiff(long, `${long} x`)).toBeNull()
  })

  it('has nothing to mark in equal lines', () => {
    expect(wordDiff('same', 'same')).toEqual({ a: [], b: [] })
  })
})

describe('pairWordDiffs', () => {
  const line = (kind: TextDiffLine['kind'], text: string, n: number): TextDiffLine => ({
    kind,
    text,
    oldLine: kind === 'added' ? null : n,
    newLine: kind === 'deleted' ? null : n,
  })

  it('pairs each deletion with the addition at the same place in the run that follows', () => {
    const lines = [
      line('context', 'a', 1),
      line('deleted', 'x = 1', 2),
      line('deleted', 'y = 2', 3),
      line('added', 'x = 10', 2),
      line('added', 'y = 20', 3),
      line('added', 'z = 3', 4),
      line('context', 'b', 5),
    ]
    const m = pairWordDiffs(lines)
    expect(pick('x = 1', m.get(lines[1]!)!)).toEqual(['1'])
    expect(pick('x = 10', m.get(lines[3]!)!)).toEqual(['10'])
    expect(pick('y = 20', m.get(lines[4]!)!)).toEqual(['20'])
    // The extra addition has no partner, and context is never marked.
    expect(m.has(lines[5]!)).toBe(false)
    expect(m.has(lines[0]!)).toBe(false)
  })

  it('does not pair across context', () => {
    const lines = [line('deleted', 'x = 1', 1), line('context', 'k', 2), line('added', 'x = 2', 3)]
    expect(pairWordDiffs(lines).size).toBe(0)
  })

  it('stops marking once a file spends its comparison budget (x = 1 / x = 10 is 5 x 5 tokens)', () => {
    const lines = [line('deleted', 'x = 1', 1), line('deleted', 'y = 2', 2), line('added', 'x = 10', 1), line('added', 'y = 20', 2)]
    expect(pairWordDiffs(lines, 25).size).toBe(2)
    expect(pairWordDiffs(lines, 24).size).toBe(0)
  })
})

describe('markSpans', () => {
  it('wraps spans of plain escaped text', () => {
    const text = 'a < b && c'
    expect(markSpans(escapeHtml(text), [[4, 6]], 'w')).toBe('a &lt; <mark class="w">b </mark>&amp;&amp; c')
  })

  it('counts an entity as one character', () => {
    expect(markSpans(escapeHtml('"x"'), [[1, 2]], 'w')).toBe('&quot;<mark class="w">x</mark>&quot;')
  })

  it('keeps marks inside highlight spans, so the HTML nests', () => {
    const html = '<span class="hljs-keyword">return</span> <span class="hljs-number">30</span>;'
    expect(markSpans(html, [[5, 9]], 'w')).toBe(
      '<span class="hljs-keyword">retur<mark class="w">n</mark></span><mark class="w"> </mark><span class="hljs-number"><mark class="w">30</mark></span>;',
    )
  })

  it('leaves HTML alone with no spans', () => {
    expect(markSpans('<span>a</span>', [], 'w')).toBe('<span>a</span>')
  })
})
