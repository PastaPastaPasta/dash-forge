/**
 * Whole-change line totals (L-25) against real git: {@link diffTotals} over every file's patch
 * must equal `git diff -M --shortstat` between the same trees — text edits, an added and a deleted
 * file, a rename with edits (counted against its old content), an exact rename and a mode change
 * (nothing), a binary file (nothing), and a submodule bump (one line each side). Skipped without git.
 */

import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { HAVE_GIT, scratchRepo, writeLiterally } from '../merge/git-oracle'
import { diffTreesWithRenames } from './commit-log'
import { MODE_GITLINK, MODE_TREE, Store } from './diff-fixtures'
import { diffTotals, loadFilePatch, type FilePatch } from './file-diff'

function shortstat(s: Store, a: string, b: string): { files: number; added: number; deleted: number } {
  const { dir, done } = scratchRepo()
  try {
    writeLiterally(dir, s.objects.values())
    const r = spawnSync('git', ['diff', '-M', '--shortstat', a, b], { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
    const out = r.stdout.toString()
    const n = (re: RegExp): number => Number(re.exec(out)?.[1] ?? 0)
    return { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?/), deleted: n(/(\d+) deletions?/) }
  } finally {
    done()
  }
}

describe.skipIf(!HAVE_GIT)('diffTotals matches git diff --shortstat', () => {
  it('over text, added, deleted, renamed, binary, mode-only and submodule changes', async () => {
    const s = new Store()
    const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join('\n') + '\n'
    const big = lines(80, 'moved')
    const sub = (oid: string) => ({ name: 'vendor', oid, mode: MODE_GITLINK })
    const baseSrc = s.tree([
      { name: 'main.c', oid: s.blob(lines(40, 'main')) },
      { name: 'old.c', oid: s.blob(big) },
      { name: 'gone.txt', oid: s.blob(lines(7, 'gone')) },
      { name: 'same.txt', oid: s.blob('same\n') },
      { name: 'run.sh', oid: s.blob('#!/bin/sh\n') },
    ])
    const headSrc = s.tree([
      { name: 'main.c', oid: s.blob(lines(40, 'main').replace('main line 3\n', 'MAIN line 3\nextra\n').replace('main line 30\n', '')) },
      { name: 'new.c', oid: s.blob(big.replace('moved line 10\n', 'moved line ten\n') + 'tail\n') },
      { name: 'fresh.txt', oid: s.blob(lines(5, 'fresh')) },
      { name: 'renamed.txt', oid: s.blob('same\n') },
      { name: 'run.sh', oid: s.blob('#!/bin/sh\n'), mode: 0o100755 },
      { name: 'logo.png', oid: s.blob(new Uint8Array([0x89, 0x50, 0, 1, 2, 3])) },
    ])
    const a = s.tree([{ name: 'src', oid: baseSrc, mode: MODE_TREE }, sub('1'.repeat(40))])
    const b = s.tree([{ name: 'src', oid: headSrc, mode: MODE_TREE }, sub('2'.repeat(40))])
    const r = s.reader()
    const sides = { base: r, head: r }
    const { changes } = await diffTreesWithRenames(sides, a, b)
    const patches = new Map<string, FilePatch>()
    for (const c of changes) patches.set(c.path, await loadFilePatch(sides, c))
    const totals = diffTotals(changes, (c) => patches.get(c.path))
    const git = shortstat(s, a, b)
    expect({ files: changes.length, added: totals.added, deleted: totals.deleted }).toEqual(git)
    expect(totals).toMatchObject({ pending: 0, uncounted: 0 })
    expect(changes.filter((c) => c.status === 'renamed').map((c) => `${c.oldPath}→${c.path}`).sort()).toEqual(['src/old.c→src/new.c', 'src/same.txt→src/renamed.txt'])
  })
})

describe('diffTotals', () => {
  it('says how many files are not loaded yet or cannot be counted', async () => {
    const s = new Store()
    const r = s.reader()
    const a = s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    const b = s.files({ 'a.txt': 'A\n', 'b.txt': 'B\n' })
    const { changes } = await diffTreesWithRenames({ base: r, head: r }, a, b)
    const first = await loadFilePatch({ base: r, head: r }, changes[0]!)
    expect(diffTotals(changes, (c) => (c === changes[0] ? first : undefined))).toEqual({ added: 1, deleted: 1, pending: 1, uncounted: 0 })
    const unreadable: FilePatch = { kind: 'placeholder', change: changes[1]!, reason: 'unreadable', note: 'x' }
    expect(diffTotals(changes, (c) => (c === changes[0] ? first : unreadable))).toEqual({ added: 1, deleted: 1, pending: 0, uncounted: 1 })
  })
})
