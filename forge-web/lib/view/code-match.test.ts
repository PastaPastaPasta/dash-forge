import { describe, expect, it } from 'vitest'

import { LINE_WINDOW, MAX_SHOWN_LINES, searchCorpus, type CorpusFile } from './code-match'
import { parseCodeQuery } from './code-query'
import { headerLanguage, searchLanguageNamed, searchLanguageOf } from './languages'

const file = (path: string, text: string, language: string | null = null): CorpusFile => ({ path, text, language })

const FILES: CorpusFile[] = [
  file('src/net.cpp', '#include "net.h"\n\nvoid CConnman::Start() {\n  // start the net\n  StartNet();\n}\n', 'C++'),
  file('src/net.h', 'class CConnman {\n  void Start();\n};\n', 'C++'),
  file('test/functional/p2p.py', 'def test_start():\n    node.start()\n', 'Python'),
  file('README.md', '# Net\n\nStart here.\n', 'Markdown'),
  file('doc/build.md', 'Build with make.\n', 'Markdown'),
]

const search = (q: string, files: readonly CorpusFile[] = FILES) => searchCorpus(files, parseCodeQuery(q))

describe('searchCorpus', () => {
  it('finds a word in content or path, case-insensitively, with its lines and marks', () => {
    const r = search('start')
    expect(r.fileCount).toBe(4)
    const cpp = r.files.find((f) => f.path === 'src/net.cpp')
    expect(cpp?.matchLines).toBe(3)
    const line = cpp?.lines.find((l) => l.n === 3)
    expect(line?.text).toBe('void CConnman::Start() {')
    expect(line?.ranges).toEqual([[15, 20]])
    // A line of context either side of each match.
    expect(cpp?.lines.map((l) => l.n)).toEqual([2, 3, 4, 5, 6])
    expect(cpp?.lines.find((l) => l.n === 2)?.ranges).toEqual([])
  })

  it('ranks a path match first', () => {
    const r = search('net')
    expect(r.files[0]?.path).toMatch(/^src\/net\./)
    expect(r.files[0]?.pathRanges).toEqual([[4, 7]])
  })

  it('needs every term, and drops a negated one', () => {
    expect(search('start connman').files.map((f) => f.path).sort()).toEqual(['src/net.cpp', 'src/net.h'])
    expect(search('start -connman').files.map((f) => f.path).sort()).toEqual(['README.md', 'test/functional/p2p.py'])
    expect(search('start NOT connman').fileCount).toBe(2)
  })

  it('matches case with case:yes', () => {
    expect(search('Start case:yes').files.map((f) => f.path).sort()).toEqual(['README.md', 'src/net.cpp', 'src/net.h'])
  })

  it('filters by path and language, with aliases', () => {
    expect(search('start path:src/').files.map((f) => f.path).sort()).toEqual(['src/net.cpp', 'src/net.h'])
    expect(search('start path:*.h').files.map((f) => f.path)).toEqual(['src/net.h'])
    expect(search('start -path:src').fileCount).toBe(2)
    expect(search('start path:/^test\\//').files.map((f) => f.path)).toEqual(['test/functional/p2p.py'])
    expect(search('start path:/src/').files.map((f) => f.path).sort()).toEqual(['src/net.cpp', 'src/net.h'])
    expect(search('start language:constructor').unknownLanguages).toEqual(['constructor'])
    expect(search('start language:py').files.map((f) => f.path)).toEqual(['test/functional/p2p.py'])
    expect(search('start language:c++').fileCount).toBe(2)
    expect(search('start -language:cpp').fileCount).toBe(2)
  })

  it('lists files for a qualifier alone, and nothing for an unknown language', () => {
    const r = search('language:markdown')
    expect(r.files.map((f) => f.path).sort()).toEqual(['README.md', 'doc/build.md'])
    expect(r.files[0]?.lines).toEqual([])
    const unknown = search('start language:klingon')
    expect(unknown.fileCount).toBe(0)
    expect(unknown.unknownLanguages).toEqual(['klingon'])
  })

  it('matches content only with content:', () => {
    // `net` is in README's content (`# Net`), and in src's paths only as far as net.h goes.
    expect(search('content:connman').files.map((f) => f.path).sort()).toEqual(['src/net.cpp', 'src/net.h'])
    expect(search('content:functional').fileCount).toBe(0)
  })

  it('runs regular expressions, with ^ and $ as line anchors', () => {
    const r = search('/^\\s+void \\w+\\(\\);$/')
    expect(r.files.map((f) => f.path)).toEqual(['src/net.h'])
    expect(r.files[0]?.lines.find((l) => l.ranges.length > 0)?.n).toBe(2)
  })

  it('never loops on an empty match', () => {
    const r = search('/x*/ path:README')
    expect(r.fileCount).toBe(1)
    expect(r.files[0]?.lines).toEqual([])
  })

  it('returns nothing for an empty or broken query', () => {
    expect(search('').fileCount).toBe(0)
    expect(search('/a(/').fileCount).toBe(0)
  })

  it('cuts a long line to a window around its match', () => {
    const long = `${'a'.repeat(1000)}NEEDLE${'b'.repeat(1000)}`
    const r = search('needle', [file('min.js', long)])
    const line = r.files[0]?.lines[0]
    expect(line?.text.length).toBe(LINE_WINDOW)
    expect(line?.clippedStart).toBe(true)
    expect(line?.clippedEnd).toBe(true)
    const [s, e] = line?.ranges[0] ?? [0, 0]
    expect(line?.text.slice(s, e)).toBe('NEEDLE')
  })

  it('caps the lines shown per file, pages files, and stops at its time budget', () => {
    const many = file('many.txt', Array.from({ length: 300 }, () => 'hit').join('\n'))
    const r = search('hit', [many])
    // The first 100 matching lines, and the line of context after the last (marked: it matches too).
    expect(r.files[0]?.lines).toHaveLength(MAX_SHOWN_LINES + 1)
    expect(r.files[0]?.lines.at(-1)?.n).toBe(MAX_SHOWN_LINES + 1)
    expect(r.files[0]?.matchLines).toBe(300)
    const files = Array.from({ length: 50 }, (_, i) => file(`f${String(i).padStart(2, '0')}.txt`, 'hit'))
    const page2 = searchCorpus(files, parseCodeQuery('hit'), { offset: 20, limit: 20 })
    expect(page2.fileCount).toBe(50)
    expect(page2.files[0]?.path).toBe('f20.txt')
    let t = 0
    const slow = searchCorpus(Array.from({ length: 200 }, (_, i) => file(`g${i}`, 'hit')), parseCodeQuery('hit'), { budgetMs: 0, now: () => (t += 1) })
    expect(slow.stopped).toBe(true)
    expect(slow.fileCount).toBeLessThan(200)
  })

  it('drops a carriage return and the empty line after a trailing newline', () => {
    const r = search('b', [file('crlf.txt', 'a\r\nb\r\n')])
    expect(r.files[0]?.lines).toEqual([
      { n: 1, text: 'a', ranges: [], clippedStart: false, clippedEnd: false },
      { n: 2, text: 'b', ranges: [[0, 1]], clippedStart: false, clippedEnd: false },
    ])
  })
})

describe('search languages', () => {
  const header = headerLanguage(['src/a.cpp', 'src/a.h', 'lib/b.c', 'lib/b.h'])
  it('names every file, vendored and docs included', () => {
    expect(searchLanguageOf('src/a.h', header)).toBe('C++')
    expect(searchLanguageOf('lib/b.h', header)).toBe('C')
    expect(searchLanguageOf('doc/x.md', header)).toBe('Markdown')
    expect(searchLanguageOf('vendor/y.go', header)).toBe('Go')
    expect(searchLanguageOf('src/qt/locale/dash_de.ts', header)).toBe('XML')
    expect(searchLanguageOf('web/app.ts', header)).toBe('TypeScript')
    expect(searchLanguageOf('Makefile', header)).toBe('Makefile')
    expect(searchLanguageOf('blob.bin', header)).toBeNull()
  })
  it('reads names and aliases', () => {
    expect(searchLanguageNamed('cpp')).toBe('C++')
    expect(searchLanguageNamed('C++')).toBe('C++')
    expect(searchLanguageNamed('objective-c')).toBe('Objective-C')
    expect(searchLanguageNamed('Protocol Buffer')).toBe('Protocol Buffer')
    expect(searchLanguageNamed('klingon')).toBeNull()
  })
})
