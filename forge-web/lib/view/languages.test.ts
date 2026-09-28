/**
 * The language bar (F-5): file names to languages, shares by size, and the bounded walk (tree
 * reads only, never a blob; vendored and generated files are listed but left out of the bar).
 */

import { describe, expect, it } from 'vitest'

import { MODE_TREE } from '../browse'
import { Store } from './diff-fixtures'
import { languageOf, languageShares, languageStats, walkRepoFiles } from './languages'

describe('languageOf', () => {
  it('maps extensions and whole names, case-insensitively', () => {
    expect(languageOf('crates/core/main.rs')?.name).toBe('Rust')
    expect(languageOf('src/Main.GO')?.name).toBe('Go')
    expect(languageOf('src/jv.h')?.name).toBe('C')
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

describe('walkRepoFiles and languageStats', () => {
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
    const walk = await walkRepoFiles(s.reader(undefined, locateBy(s)), root)
    expect(walk.files.map((f) => f.path)).toEqual(['README.md', 'scripts/build.sh', 'src/lib/util.rs', 'src/main.rs', 'vendor/big/huge.c'])
    const stats = languageStats(walk)
    expect(stats.languages.map((l) => l.name)).toEqual(['Rust', 'Shell'])
    expect(stats.truncated).toBe(false)
    for (const oid of new Set(s.reads)) expect(s.objects.get(oid)?.type).toBe('tree')
  })

  it('stops at its bounds and says so', async () => {
    const { s, root } = repo()
    const byTrees = await walkRepoFiles(s.reader(undefined, locateBy(s)), root, { maxTrees: 1 })
    expect(byTrees.truncated).toBe(true)
    expect(byTrees.trees).toBe(1)
    const byFiles = await walkRepoFiles(s.reader(undefined, locateBy(s)), root, { maxFiles: 1 })
    expect(byFiles.files).toHaveLength(1)
    expect(byFiles.truncated).toBe(true)
  })

  it('treats a tree entry as a directory only by its mode', async () => {
    const s = new Store()
    const sub = s.files({ 'x.go': 'package x\n' })
    const root = s.tree([{ name: 'pkg', oid: sub, mode: MODE_TREE }])
    expect(languageStats(await walkRepoFiles(s.reader(undefined, locateBy(s)), root)).languages.map((l) => l.name)).toEqual(['Go'])
  })
})
