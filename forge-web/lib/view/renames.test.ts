/**
 * Rename detection (L-24) against real git: `git diff -M --raw` between two trees must list the
 * same renames, with the same similarity index, as {@link detectRenames} over {@link diffTrees}.
 * Random tree pairs exercise each phase of git's diffcore-rename: exact renames (a basename
 * preferred among equal blobs, symlinks only with equal modes), unique-basename matches at 75%,
 * and the best-first similarity matrix at 50%, including CRLF, binary, empty and near-threshold
 * files. Skipped without git.
 */

import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { HAVE_GIT, scratchRepo, writeLiterally } from '../merge/git-oracle'
import { diffTrees, diffTreesWithRenames, loadCommitChanges, type FileChange } from './commit-log'
import { Store, type Entry } from './diff-fixtures'
import { basenameSame, detectRenames, spanHash } from './renames'

const CASES = Number(process.env['FORGE_RENAME_CASES'] ?? '150')
const SEED = Number(process.env['FORGE_RENAME_SEED'] ?? '20260929')

/** A tree from `path → [mode, content]`, nested as git nests it. */
function tree(s: Store, files: ReadonlyMap<string, readonly [number, string | Uint8Array]>): string {
  const build = (prefix: string): string => {
    const here: Entry[] = []
    const dirs = new Set<string>()
    for (const [path, [mode, content]] of files) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) here.push({ name: rest, oid: s.blob(content), mode })
      else dirs.add(rest.slice(0, slash))
    }
    // `Store.tree` orders by plain name: no directory name here is a prefix of a file name, so
    // that is the tree order (a directory sorts as `name/`).
    for (const d of dirs) here.push({ name: d, oid: build(`${prefix}${d}/`), mode: 0o40000 })
    return s.tree(here)
  }
  return build('')
}

/** `git diff -M --raw` of two trees: `R<score> old new` per rename, and A / D / M lines. */
function gitRaw(s: Store, pairs: readonly (readonly [string, string])[]): string[][] | null {
  if (!HAVE_GIT) return null
  const { dir, done } = scratchRepo()
  try {
    writeLiterally(dir, s.objects.values())
    return pairs.map(([a, b]) => {
      const r = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '-M', '--raw', '-z', '--no-abbrev', a, b], {
        cwd: dir,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        maxBuffer: 1 << 26,
      })
      if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr.toString()}`)
      const parts = r.stdout.toString().split('\0').filter((p) => p !== '')
      const out: string[] = []
      for (let i = 0; i < parts.length; ) {
        const status = (parts[i++] as string).split(' ').pop() as string
        if (status.startsWith('R') || status.startsWith('C')) out.push(`${status} ${parts[i++]} ${parts[i++]}`)
        else out.push(`${status} ${parts[i++]}`)
      }
      return out.sort()
    })
  } finally {
    done()
  }
}

/** Our changes in the same form. */
function ours(changes: readonly FileChange[]): string[] {
  return changes
    .map((c) =>
      c.status === 'renamed'
        ? `R${String(c.similarity).padStart(3, '0')} ${c.oldPath} ${c.path}`
        : `${c.status === 'added' ? 'A' : c.status === 'deleted' ? 'D' : c.baseMode !== c.headMode && (c.baseMode === 0o120000 || c.headMode === 0o120000) ? 'T' : 'M'} ${c.path}`,
    )
    .sort()
}

function prng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}

const DIRS = ['', 'src/', 'src/util/', 'lib/', 'doc/', 'contrib/completions/bash/', 'test/functional/']
const NAMES = ['main.c', 'util.h', 'Makefile', 'README.md', 'init.cpp', 'echo.cpp', 'handler.cpp', 'dash-cli.bash', 'notes.txt', 'data.bin', 'link']

/**
 * A base tree and a head tree made from it: files deleted, edited, moved (with and without edits,
 * keeping or changing the basename), copied, and added. Contents are line lists from a small
 * vocabulary, so edited copies land on both sides of git's 50% and 75% bars.
 */
function randomCase(s: Store, rand: () => number, c: number): [string, string] {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
  const vocab = Array.from({ length: 30 }, (_, i) => `vocab line ${i} ${'x'.repeat(i % 7)}`)
  const text = (n: number): string => {
    const crlf = rand() < 0.1
    const body = Array.from({ length: n }, () => (rand() < 0.3 ? `unique ${c}.${Math.floor(rand() * 1e9)}` : pick(vocab))).join(crlf ? '\r\n' : '\n')
    return n === 0 ? '' : `${body}${crlf ? '\r\n' : '\n'}`
  }
  const edit = (t: string): string => {
    const lines = t.split('\n')
    const edits = Math.floor(rand() * (lines.length + 1))
    for (let e = 0; e < edits; e++) {
      const at = Math.floor(rand() * lines.length)
      const op = rand()
      if (op < 0.4) lines.splice(at, 1)
      else if (op < 0.8) lines.splice(at, 0, `edit ${c}.${e}`)
      else lines[at] = pick(vocab)
    }
    return lines.join('\n')
  }
  const base = new Map<string, readonly [number, string | Uint8Array]>()
  const n = 3 + Math.floor(rand() * 14)
  for (let i = 0; i < n; i++) {
    const name = pick(NAMES)
    const path = `${pick(DIRS)}${name}`
    if (name === 'link') base.set(path, [0o120000, pick(['../target', 'src/main.c', 'x'])])
    else if (name === 'data.bin') base.set(path, [0o100644, new Uint8Array([0, 1, 2, ...new TextEncoder().encode(text(4))])])
    else base.set(path, [rand() < 0.1 ? 0o100755 : 0o100644, text(Math.floor(rand() * 30))])
  }
  const head = new Map(base)
  for (const [path, [mode, content]] of base) {
    const op = rand()
    if (op < 0.2) head.delete(path)
    else if (op < 0.35) head.set(path, [mode, typeof content === 'string' ? edit(content) : content])
    else if (op < 0.75) {
      head.delete(path)
      const name = rand() < 0.6 ? path.slice(path.lastIndexOf('/') + 1) : pick(NAMES)
      const to = `${pick(DIRS)}${rand() < 0.3 ? 'moved-' : ''}${name}`
      if (to === path) continue
      head.set(to, [mode, typeof content === 'string' && rand() < 0.6 ? edit(content) : content])
    } else if (op < 0.85) {
      head.set(`${pick(DIRS)}copy-${path.slice(path.lastIndexOf('/') + 1)}`, [mode, content])
    }
  }
  for (let i = Math.floor(rand() * 4); i > 0; i--) head.set(`${pick(DIRS)}new-${i}-${pick(NAMES)}`, [0o100644, text(Math.floor(rand() * 20))])
  return [tree(s, base), tree(s, head)]
}

describe.skipIf(!HAVE_GIT)('rename detection matches git diff -M', () => {
  it(`random tree pairs (${CASES} cases, seed ${SEED})`, async () => {
    const s = new Store()
    const rand = prng(SEED)
    const pairs = Array.from({ length: CASES }, (_, c) => randomCase(s, rand, c))
    const want = gitRaw(s, pairs) as string[][]
    const r = s.reader()
    let renames = 0
    for (const [c, [a, b]] of pairs.entries()) {
      const { changes, limited } = await detectRenames({ base: r, head: r }, (await diffTrees({ base: r, head: r }, a, b)).changes, { readBudget: Infinity })
      expect(limited, `case ${c}`).toBeNull()
      expect(ours(changes), `case ${c}`).toEqual(want[c])
      renames += changes.filter((x) => x.status === 'renamed').length
      // A tight read budget may find fewer renames, never one git does not make.
      const tight = await detectRenames({ base: r, head: r }, (await diffTrees({ base: r, head: r }, a, b)).changes, { readBudget: 3 })
      for (const line of ours(tight.changes).filter((l) => l.startsWith('R'))) expect(want[c], `case ${c}, budget 3`).toContain(line)
    }
    // The generator must actually exercise renames (exact and with edits).
    expect(renames).toBeGreaterThan(CASES / 2)
  }, 120_000)

  it('the shapes of dashpay/dash f1be1b800: moved completions are R100, unrelated A and D stay apart', async () => {
    const s = new Store()
    const completion = (name: string): string => `# bash completion for ${name}\n${'_complete() { COMPREPLY=(); }\n'.repeat(20)}`
    const base = new Map<string, readonly [number, string]>([
      ['contrib/dash-cli.bash', [0o100644, completion('dash-cli')]],
      ['contrib/dashd.bash', [0o100644, completion('dashd')]],
      ['src/interfaces/echo.cpp', [0o100644, '#include <interfaces/echo.h>\nclass EchoImpl {};\n']],
      ['src/interfaces/init.cpp', [0o100644, '#include <interfaces/init.h>\nnamespace interfaces {}\n']],
    ])
    const head = new Map<string, readonly [number, string]>([
      ['contrib/completions/bash/dash-cli.bash-completion', [0o100644, completion('dash-cli')]],
      ['contrib/completions/bash/dashd.bash-completion', [0o100644, completion('dashd')]],
      ['contrib/completions/fish/dashd.fish', [0o100644, 'complete -c dashd -l help\n']],
      ['src/common/interfaces.cpp', [0o100644, '#include <interfaces/echo.h>\n#include <interfaces/handler.h>\nnamespace common { void Run(); }\n// much more\n'.repeat(3)]],
    ])
    const a = tree(s, base)
    const b = tree(s, head)
    const r = s.reader()
    const got = await diffTreesWithRenames({ base: r, head: r }, a, b)
    expect(ours(got.changes)).toEqual((gitRaw(s, [[a, b]]) as string[][])[0])
    expect(ours(got.changes)).toEqual([
      'A contrib/completions/fish/dashd.fish',
      'A src/common/interfaces.cpp',
      'D src/interfaces/echo.cpp',
      'D src/interfaces/init.cpp',
      'R100 contrib/dash-cli.bash contrib/completions/bash/dash-cli.bash-completion',
      'R100 contrib/dashd.bash contrib/completions/bash/dashd.bash-completion',
    ])
  })
})

describe('detectRenames', () => {
  it('a commit page lists a move as one renamed file at its new path, not an add and a delete', async () => {
    const s = new Store()
    const body = 'line\n'.repeat(50)
    const c1 = s.commit(s.files({ 'old/name.txt': body, 'keep.txt': 'k' }))
    const c2 = s.commit(s.files({ 'new/name.txt': `${body}one more\n`, 'keep.txt': 'k' }), [c1])
    const got = await loadCommitChanges(s.reader(), c2)
    expect(got.changes).toHaveLength(1)
    expect(got.changes[0]).toMatchObject({ status: 'renamed', path: 'new/name.txt', oldPath: 'old/name.txt', similarity: 96 })
  })

  it('within its read budget, pairs what it can read and says the rest was not compared; exact renames still pair', async () => {
    const s = new Store()
    const files = (prefix: string, n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}.txt`, `file ${i}\n${'body\n'.repeat(i + 3)}`]))
    const moved = { 'same.txt': 'identical\n' }
    const a = s.files({ ...files('a/', 10), ...moved })
    const b = s.files({ ...Object.fromEntries(Object.entries(files('b/', 10)).map(([k, v]) => [k, `${v}edited\n`])), 'dir/same.txt': 'identical\n' })
    const r = s.reader()
    const { changes } = await diffTrees({ base: r, head: r }, a, b)
    const before = s.reads.length
    const got = await detectRenames({ base: r, head: r }, changes, { readBudget: 4 })
    // Four blobs: the first two same-named pairs, each a pair git makes too; no similarity matrix.
    expect(s.reads.length - before).toBe(4)
    expect(got.limited).toMatch(/too many files in the browser, so only 2 of them were compared/)
    expect(ours(got.changes).filter((l) => l.startsWith('R'))).toEqual(['R075 a/0.txt b/0.txt', 'R079 a/1.txt b/1.txt', 'R100 same.txt dir/same.txt'])
  })

  describe('within its byte budget (counted as reads land)', () => {
    const files = (prefix: string, n: number, edit = ''): Record<string, string> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}.txt`, `file ${i}\n${'body\n'.repeat(i + 3)}${edit}`]))

    it('same-named pairs: stops reading once spent, still pairs what it read, and skips the matrix', async () => {
      const s = new Store()
      // 20 same-named pairs (40 blobs); the pool starts 16 reads before any lands.
      const a = s.files({ ...files('a/', 20), 'x/old.txt': 'moved\n'.repeat(20) })
      const b = s.files({ ...files('b/', 20, 'edited\n'), 'y/new.txt': `${'moved\n'.repeat(20)}more\n` })
      const r = s.reader()
      const { changes } = await diffTrees({ base: r, head: r }, a, b)
      const before = s.reads.length
      const got = await detectRenames({ base: r, head: r }, changes, { readBytes: 1 })
      expect(s.reads.length - before).toBe(16)
      expect(got.limited).toMatch(/kept their names would download more than/)
      // The 16 reads were the first 8 pairs, pair by pair: each scored, each a pair git makes too.
      // x/old.txt → y/new.txt needs the matrix, which is skipped.
      const renamed = got.changes.filter((c) => c.status === 'renamed').map((c) => `${c.oldPath} ${c.path}`)
      expect(renamed).toHaveLength(8)
      expect(renamed).not.toContain('x/old.txt y/new.txt')
      for (const pair of renamed) expect(pair).toMatch(/^a\/(\d+)\.txt b\/\1\.txt$/)
    })

    it('the matrix: a part of its blobs is not enough, so it is skipped rather than pair worse', async () => {
      const s = new Store()
      const a = s.files(files('a/', 10))
      const b = s.files(files('b/n', 10, 'edited\n'))
      const r = s.reader()
      const { changes } = await diffTrees({ base: r, head: r }, a, b)
      const got = await detectRenames({ base: r, head: r }, changes, { readBytes: 1 })
      expect(got.changes.some((c) => c.status === 'renamed')).toBe(false)
      expect(got.limited).toMatch(/comparing 10 deleted files with 10 added files would download more than/)
      // With the default budget the same change pairs.
      const full = await detectRenames({ base: r, head: r }, changes)
      expect(full.limited).toBeNull()
      expect(full.changes.filter((c) => c.status === 'renamed')).toHaveLength(10)
    })
  })

  it('a blob that cannot be read is not scored, and the result says renames may be missing', async () => {
    const s = new Store()
    const text = 'shared\n'.repeat(40)
    const a = s.files({ 'x/a.txt': text })
    const b = s.files({ 'y/b.txt': `${text}more\n` })
    const r = s.reader()
    const { changes } = await diffTrees({ base: r, head: r }, a, b)
    const missing = s.blob(text)
    const broken = { readObject: (oid: string) => (oid === missing ? Promise.reject(new Error('gone')) : r.readObject(oid)) }
    const got = await detectRenames({ base: broken, head: r }, changes)
    expect(got.changes.map((c) => c.status).sort()).toEqual(['added', 'deleted'])
    expect(got.limited).toMatch(/could not be read/)
  })

  it('basename_same and the span hash follow git (CR before LF ignored in text, not in binary)', () => {
    expect(basenameSame('a/b/c.txt', 'x/c.txt')).toBe(true)
    expect(basenameSame('c.txt', 'x/c.txt')).toBe(true)
    expect(basenameSame('a/bc.txt', 'x/c.txt')).toBe(false)
    const enc = new TextEncoder()
    expect(spanHash(enc.encode('a\r\nb\r\n'))).toEqual(spanHash(enc.encode('a\nb\n')))
    expect(spanHash(new Uint8Array([0, 0x0d, 0x0a]))).not.toEqual(spanHash(new Uint8Array([0, 0x0a])))
  })
})
