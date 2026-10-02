import { describe, expect, it } from 'vitest'

import { globRegex, isEmptyQuery, parseCodeQuery } from './code-query'

describe('parseCodeQuery', () => {
  it('reads bare words, phrases and regular expressions', () => {
    const q = parseCodeQuery('foo "bar baz" /qu+x [a-z]/')
    expect(q.terms).toEqual([
      { kind: 'literal', value: 'foo', negated: false, contentOnly: false },
      { kind: 'literal', value: 'bar baz', negated: false, contentOnly: false },
      { kind: 'regex', value: 'qu+x [a-z]', negated: false, contentOnly: false },
    ])
    expect(q.error).toBeNull()
  })

  it('negates with NOT and -, and drops AND', () => {
    const q = parseCodeQuery('a AND NOT b -c -"d e"')
    expect(q.terms.map((t) => [t.value, t.negated])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
      ['d e', true],
    ])
  })

  it('reads path: as a substring, a glob, an anchored prefix or a regex', () => {
    const q = parseCodeQuery('x path:src/net path:*.cpp -path:test path:/^src\\// path:"with space"')
    expect(q.paths).toEqual([
      { kind: 'substring', value: 'src/net', negated: false },
      { kind: 'glob', value: '*.cpp', negated: false },
      { kind: 'substring', value: 'test', negated: true },
      { kind: 'regex', value: '^src\\/', negated: false },
      { kind: 'substring', value: 'with space', negated: false },
    ])
    // A slash-wrapped plain path is a directory from the root, not a regex.
    expect(parseCodeQuery('path:/src/').paths).toEqual([{ kind: 'substring', value: '/src/', negated: false }])
    expect(parseCodeQuery('path:/\\.rs$/').paths).toEqual([{ kind: 'regex', value: '\\.rs$', negated: false }])
    // Names Object.prototype carries are neither qualifiers nor languages.
    expect(parseCodeQuery('constructor:foo').terms.map((t) => t.value)).toEqual(['constructor:foo'])
  })

  it('reads language:, lang:, case: and content:', () => {
    const q = parseCodeQuery('language:cpp -lang:python case:yes content:main')
    expect(q.languages).toEqual([
      { value: 'cpp', negated: false },
      { value: 'python', negated: true },
    ])
    expect(q.caseSensitive).toBe(true)
    expect(q.terms).toEqual([{ kind: 'literal', value: 'main', negated: false, contentOnly: true }])
  })

  it('reports what one repo cannot apply, and never searches it as text', () => {
    const q = parseCodeQuery('repo:dashpay/dash foo OR bar symbol:CTx')
    expect(q.ignored.map((i) => i.token)).toEqual(['repo:dashpay/dash', 'OR', 'symbol:CTx'])
    expect(q.terms.map((t) => t.value)).toEqual(['foo', 'bar'])
  })

  it('keeps other word:word tokens as text, and quoted qualifiers as text', () => {
    expect(parseCodeQuery('std::string').terms[0]?.value).toBe('std::string')
    expect(parseCodeQuery('http://example.com').terms[0]?.value).toBe('http://example.com')
    expect(parseCodeQuery('"repo:x"').terms[0]).toEqual({ kind: 'literal', value: 'repo:x', negated: false, contentOnly: false })
    expect(parseCodeQuery('"repo:x"').ignored).toEqual([])
  })

  it('reads a slash that does not close a regex as a word', () => {
    expect(parseCodeQuery('/usr/bin').terms).toEqual([{ kind: 'literal', value: '/usr/bin', negated: false, contentOnly: false }])
    expect(parseCodeQuery('a / b').terms.map((t) => t.value)).toEqual(['a', '/', 'b'])
    expect(parseCodeQuery('-').terms.map((t) => [t.value, t.negated])).toEqual([['-', false]])
  })

  it('unescapes a phrase, and keeps a regex escape for the engine', () => {
    expect(parseCodeQuery('"say \\"hi\\""').terms[0]?.value).toBe('say "hi"')
    expect(parseCodeQuery('/a\\/b/').terms[0]?.value).toBe('a\\/b')
  })

  it('says what is wrong with a bad regex or an open quote', () => {
    expect(parseCodeQuery('/a(b/').error).toMatch(/\/a\(b\/:/)
    expect(parseCodeQuery('"open').error).toMatch(/Unclosed quote/)
  })

  it('is empty with nothing positive to look for', () => {
    expect(isEmptyQuery(parseCodeQuery(''))).toBe(true)
    expect(isEmptyQuery(parseCodeQuery('-foo'))).toBe(true)
    expect(isEmptyQuery(parseCodeQuery('path:*.md'))).toBe(false)
    expect(isEmptyQuery(parseCodeQuery('language:go'))).toBe(false)
  })
})

describe('globRegex', () => {
  it('matches a glob anywhere unless anchored, and always to the end', () => {
    expect(globRegex('*.ts').test('src/a.ts')).toBe(true)
    expect(globRegex('*.ts').test('src/a.tsx')).toBe(false)
    expect(globRegex('src/*.h').test('src/a.h')).toBe(true)
    expect(globRegex('src/*.h').test('src/x/a.h')).toBe(false)
    expect(globRegex('src/**/*.h').test('src/x/y/a.h')).toBe(true)
    expect(globRegex('src/**/*.h').test('src/a.h')).toBe(true)
    expect(globRegex('/src/*.h').test('lib/src/a.h')).toBe(false)
    expect(globRegex('src/*.h').test('lib/src/a.h')).toBe(true)
    expect(globRegex('a?.c').test('ab.c')).toBe(true)
    expect(globRegex('*.TS').test('a.ts')).toBe(true)
    expect(globRegex('*.TS', true).test('a.ts')).toBe(false)
  })
})
