/**
 * The language bar (F-5): file names to languages, shares by size, and the bounded walk (tree
 * reads only, never a blob; vendored and generated files are listed but left out of the bar).
 */

import { describe, expect, it } from 'vitest'

import { MODE_TREE } from '../browse'
import { Store } from './diff-fixtures'
import { headerLanguage, isQtTranslation, languageOf, languageShares, languageStats } from './languages'
import { walkFiles } from './zip'

describe('languageOf', () => {
  it('maps extensions and whole names, case-insensitively', () => {
    expect(languageOf('crates/core/main.rs')?.name).toBe('Rust')
    expect(languageOf('src/Main.GO')?.name).toBe('Go')
    expect(languageOf('src/jv.c')?.name).toBe('C')
    expect(languageOf('src/net.cpp')?.name).toBe('C++')
    expect(languageOf('Makefile')?.name).toBe('Makefile')
    expect(languageOf('shell/key-bindings.bash')?.name).toBe('Shell')
    expect(languageOf('src/builtin.jq')?.name).toBe('jq')
  })

  it('leaves out prose, data, dotfiles, vendored, generated and documentation files', () => {
    for (const p of ['README.md', 'Cargo.lock', 'LICENSE', '.editorconfig', 'vendor/decNumber/decNumber.c', 'node_modules/x/index.js', 'docs/content/manual.js', 'dist/app.min.js', 'x.min.js', 'third_party/y.cc', 'build/gen.c']) {
      expect(languageOf(p), p).toBeNull()
    }
  })
})

describe('a .h and a .ts by the files around them (QW-024)', () => {
  const tree = [
    'src/validation.cpp',
    'src/validation.h',
    'src/net.cpp',
    'src/net.h',
    'src/secp256k1/src/secp256k1.c',
    'src/secp256k1/src/field.h',
    'src/secp256k1/include/secp256k1.h',
    'src/univalue/lib/univalue.cpp',
    'src/univalue/include/univalue.h',
    'src/qt/locale/dash_de.ts',
    'src/qt/locale/dash_zh_CN.ts',
    'web/src/app.ts',
    'web/src/i18n/en.ts',
  ]

  it('gives a header the language of the sources nearest to it', () => {
    const of = headerLanguage(tree)
    expect(of('src/validation.h').name).toBe('C++')
    // A C library inside a C++ project: its own sources decide, even for headers in a sibling directory.
    expect(of('src/secp256k1/src/field.h').name).toBe('C')
    expect(of('src/secp256k1/include/secp256k1.h').name).toBe('C')
    expect(of('src/univalue/include/univalue.h').name).toBe('C++')
    // No C-family source anywhere: C, as linguist defaults.
    expect(headerLanguage(['include/a.h'])('include/a.h').name).toBe('C')
  })

  it('keeps Qt translations out of TypeScript', () => {
    expect(isQtTranslation('src/qt/locale/dash_de.ts')).toBe(true)
    expect(isQtTranslation('src/qt/locale/bitcoin_sr@latin.ts')).toBe(true)
    expect(isQtTranslation('web/src/app.ts')).toBe(false)
    expect(isQtTranslation('web/src/i18n/en.ts')).toBe(false)
  })

  it('counts a C++ project as C++, not C, and its translations as nothing', () => {
    const shares = languageShares(tree.map((p) => [p, 100] as const))
    const by = new Map(shares.map((s) => [s.name, s.percent]))
    // 3 C++ sources + 3 C++ headers, 1 C source + 2 C headers, 2 TypeScript files; no Qt .ts counted.
    expect(by.get('C++')).toBe(54.5)
    expect(by.get('C')).toBe(27.3)
    expect(by.get('TypeScript')).toBe(18.2)
  })
})

describe('a file stored as a delta (QW-024)', () => {
  it('counts at its language\'s average whole-stored size, not the delta\'s', () => {
    // Four busy C++ files stored as small deltas, one C file stored whole: C++ still leads.
    const shares = languageShares([
      ['src/a.cpp', 1_000, false],
      ['src/b.cpp', 100, true],
      ['src/c.cpp', 100, true],
      ['src/d.cpp', 100, true],
      ['lib/x.c', 2_000, false],
    ])
    expect(shares.map((s) => [s.name, s.percent])).toEqual([
      ['C++', 66.7],
      ['C', 33.3],
    ])
    // With no whole-stored file of its language, a delta counts at its own size.
    expect(languageShares([['a.rs', 50, true], ['b.py', 50, false]]).map((s) => s.percent)).toEqual([50, 50])
  })

  it('caps a data table at the 99th percentile of stored sizes, so it cannot outweigh the code', () => {
    // 100 C++ files of 1,000 bytes; one C table of 500,000 (dash's precomputed_ecmult.c, compressed).
    const rows: [string, number, boolean][] = Array.from({ length: 100 }, (_, i) => [`src/f${i}.cpp`, 1_000, false])
    rows.push(['src/secp256k1/src/precomputed_ecmult.c', 500_000, false])
    const shares = languageShares(rows)
    expect(shares[0]?.name).toBe('C++')
    // Capped at the 99th percentile (a 1,000-byte file here): 1 of 101 equal files.
    expect(shares.find((s) => s.name === 'C')?.percent).toBe(1)
  })
})

describe('languageShares', () => {
  it('groups by language, largest first, with percentages summing to about 100', () => {
    const shares = languageShares([
      ['a.rs', 900],
      ['b.rs', 100],
      ['c.py', 500],
      ['d.sh', 500],
      ['README.md', 10_000],
    ])
    expect(shares.map((s) => [s.name, s.percent])).toEqual([
      ['Rust', 50],
      ['Python', 25],
      ['Shell', 25],
    ])
  })

  it('folds languages under 0.1% into Other, and is empty with nothing to count', () => {
    const shares = languageShares([
      ['a.rs', 100_000],
      ['b.lua', 5],
    ])
    expect(shares.map((s) => s.name)).toEqual(['Rust', 'Other'])
    expect(languageShares([['README.md', 10]])).toEqual([])
  })
})

describe('walkFiles and languageStats', () => {
  function repo(): { s: Store; root: string } {
    const s = new Store()
    const root = s.files({
      'src/main.rs': 'fn main() {}\n',
      'src/lib/util.rs': 'pub fn f() {}\n',
      'scripts/build.sh': '#!/bin/sh\n',
      'vendor/big/huge.c': 'x'.repeat(10_000),
      'README.md': '# hi\n',
    })
    return { s, root }
  }
  /** Stored sizes for the locator: the blob's length, so shares are checkable. */
  const locateBy = (s: Store) => (oid: string) => {
    const o = s.objects.get(oid)
    return o ? { packRef: 0, offset: 0, length: o.bytes.length, deltaChainSpan: 0, deltaDepth: 0 } : null
  }

  it('sizes files from the locator, reads trees only, and leaves vendored files out of the bar (Go to file still lists them)', async () => {
    const { s, root } = repo()
    const walk = await walkFiles(s.reader(undefined, locateBy(s)), root)
    expect(walk.files.map((f) => f.path)).toEqual(['README.md', 'scripts/build.sh', 'src/lib/util.rs', 'src/main.rs', 'vendor/big/huge.c'])
    const stats = languageStats(walk)
    expect(stats.languages.map((l) => l.name)).toEqual(['Rust', 'Shell'])
    expect(stats.truncated).toBe(false)
    for (const oid of new Set(s.reads)) expect(s.objects.get(oid)?.type).toBe('tree')
  })

  it('stops at its bounds and says so', async () => {
    const { s, root } = repo()
    const byTrees = await walkFiles(s.reader(undefined, locateBy(s)), root, { maxTrees: 1 })
    expect(byTrees.truncated).toBe(true)
    const byFiles = await walkFiles(s.reader(undefined, locateBy(s)), root, { maxFiles: 1 })
    expect(byFiles.files).toHaveLength(1)
    expect(byFiles.truncated).toBe(true)
  })

  it('a single tree with more files than the bound is truncated, not complete', async () => {
    const s = new Store()
    const files: Record<string, string> = {}
    for (let i = 0; i < 12; i++) files[`f${i}.rs`] = String(i)
    const root = s.files(files)
    const walk = await walkFiles(s.reader(undefined, locateBy(s)), root, { maxFiles: 5 })
    expect(walk.files).toHaveLength(5)
    expect(walk.truncated).toBe(true)
  })

  it('treats a tree entry as a directory only by its mode', async () => {
    const s = new Store()
    const sub = s.files({ 'x.go': 'package x\n' })
    const root = s.tree([{ name: 'pkg', oid: sub, mode: MODE_TREE }])
    expect(languageStats(await walkFiles(s.reader(undefined, locateBy(s)), root)).languages.map((l) => l.name)).toEqual(['Go'])
  })
})
