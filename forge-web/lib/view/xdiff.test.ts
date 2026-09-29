/**
 * The xdiff port (L-70) against real git: random pairs of line lists, most drawn from a few
 * distinct lines so that many minimal edit scripts exist and only xdiff's own choices (its record
 * cleanup, middle-snake splits and cost heuristics, then compaction) give git's. Each pair's
 * changed lines, after compaction and the common-tail trim, must equal the hunks of
 * `git diff --no-index -U0` (myers, indent heuristic: git's defaults, which blame uses).
 *
 * All pairs are written as two directories and diffed by one git process. Skipped without git.
 * `FORGE_XDIFF_CASES` sets the number of cases, `FORGE_XDIFF_SEED` the (fixed by default) seed.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { HAVE_GIT } from '../merge/git-oracle'
import { lineMap } from './blame-core'
import { DEFAULT_DIFF_LIMITS, splitLines } from './text-diff'
import { commonTailRecords, xdiffChanges } from './xdiff'
import { compactChanges } from './xdiff-compact'

const CASES = Number(process.env['FORGE_XDIFF_CASES'] ?? '600')
const SEED = Number(process.env['FORGE_XDIFF_SEED'] ?? '20260929')

/** Changed marks of both files as git blame would see them: tail trim, xdiff, compaction. */
function ourMarks(before: string, after: string): { old: number[]; new: number[] } | null {
  const a = splitLines(before)
  const b = splitLines(after)
  const tail = commonTailRecords(a, b)
  const oldRecs = a.slice(0, a.length - tail)
  const newRecs = b.slice(0, b.length - tail)
  const raw = xdiffChanges(oldRecs, newRecs, DEFAULT_DIFF_LIMITS)
  if (raw === null) return null
  const c = compactChanges(oldRecs, newRecs, raw.oldChanged, raw.newChanged)
  const pad = (m: Uint8Array, n: number): number[] => [...m, ...new Array<number>(n - m.length).fill(0)]
  return { old: pad(c.oldChanged, a.length), new: pad(c.newChanged, b.length) }
}

/** Changed marks from each file pair's `@@ -os,oc +ns,nc @@` headers in a `git diff -U0`. */
function gitMarks(pairs: readonly (readonly [string, string])[]): { old: number[]; new: number[] }[] {
  const root = mkdtempSync(join(tmpdir(), 'forge-xdiff-'))
  try {
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    pairs.forEach(([x, y], i) => {
      writeFileSync(join(root, 'a', `f${i}`), x)
      writeFileSync(join(root, 'b', `f${i}`), y)
    })
    const r = spawnSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-renames', '--diff-algorithm=myers', '--indent-heuristic', '-U0', 'a', 'b'],
      { cwd: root, maxBuffer: 1 << 28, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } },
    )
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr.toString()}`)
    const marks = pairs.map(([x, y]) => ({ old: new Array<number>(splitLines(x).length).fill(0), new: new Array<number>(splitLines(y).length).fill(0) }))
    let cur: { old: number[]; new: number[] } | undefined
    for (const line of r.stdout.toString().split('\n')) {
      const file = /^diff --git a\/a\/f(\d+) b\//.exec(line)
      if (file) {
        cur = marks[Number(file[1])]
        continue
      }
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (h && cur) {
        const [os, oc, ns, nc] = [Number(h[1]), h[2] === undefined ? 1 : Number(h[2]), Number(h[3]), h[4] === undefined ? 1 : Number(h[4])]
        for (let k = 0; k < oc; k++) cur.old[os - 1 + k] = 1
        for (let k = 0; k < nc; k++) cur.new[ns - 1 + k] = 1
      }
    }
    return marks
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A tiny deterministic PRNG, so a failure is reproducible from its seed. */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}

/**
 * A random pair: an old list of lines from a small vocabulary (often skewed, so some lines repeat
 * enough to be "investigated" by xdiff's cleanup), and a new one made by random edits of it. Some
 * pairs are large, with enough edits to reach xdiff's cost heuristics (cost above 256); some share
 * a long common tail (git's 1 KiB tail trim); some lose their final newline.
 */
function randomPair(rand: () => number, c: number): [string, string] {
  const big = c % 25 === 0
  const vocab = Array.from({ length: 2 + Math.floor(rand() * (big ? 40 : 8)) }, (_, i) => (i % 5 === 4 ? '' : `${'\t'.repeat(i % 3)}line ${i}`))
  const skew = rand() < 0.5
  const word = (): string => (skew ? vocab[Math.floor(rand() ** 3 * vocab.length)] : vocab[Math.floor(rand() * vocab.length)]) as string
  const n = big ? 800 + Math.floor(rand() * 2000) : Math.floor(rand() * 60)
  const old = Array.from({ length: n }, word)
  const next = [...old]
  const edits = big ? 100 + Math.floor(rand() * 600) : Math.floor(rand() * 12)
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rand() * (next.length + 1))
    const op = rand()
    if (op < 0.35) next.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 4) }, word))
    else if (op < 0.65) next.splice(at, 1 + Math.floor(rand() * 4))
    else if (op < 0.85 && next.length > 0) next[Math.min(at, next.length - 1)] = rand() < 0.5 ? word() : `unique ${c}.${e}`
    else if (next.length > 1) {
      // Move a run elsewhere: the same lines, other copies.
      const run = next.splice(at, 1 + Math.floor(rand() * 5))
      next.splice(Math.floor(rand() * (next.length + 1)), 0, ...run)
    }
  }
  const tail = rand() < 0.15 ? Array.from({ length: 40 + Math.floor(rand() * 120) }, (_, i) => `shared tail ${i} ${word()}`) : []
  const text = (lines: string[], nl: boolean): string => (lines.length === 0 ? '' : lines.join('\n') + (nl ? '\n' : ''))
  const nlOld = rand() < 0.9
  const nlNew = rand() < 0.9
  return tail.length > 0 ? [text([...old, ...tail], true), text([...next, ...tail], true)] : [text(old, nlOld), text(next, nlNew)]
}

describe.skipIf(!HAVE_GIT)('xdiff port matches git diff', () => {
  it(`random line-list pairs with repeated lines (${CASES} cases, seed ${SEED})`, () => {
    const rand = prng(SEED)
    const pairs = Array.from({ length: CASES }, (_, c) => randomPair(rand, c))
    const want = gitMarks(pairs)
    pairs.forEach(([a, b], c) => {
      const got = ourMarks(a, b)
      expect(got, `case ${c}`).not.toBeNull()
      expect(got, `case ${c}`).toEqual(want[c])
    })
  }, 180_000)

  it('large files with many scattered edits (the snake heuristic of xdl_split)', () => {
    // The heuristic applies past cost 256 and before the cost bound, which is above 256 only
    // when the files have ~33k searched lines between them; mostly distinct lines give the long
    // snakes it looks for, and a few repeated ones keep the pairing ambiguous.
    const rand = prng(SEED + 1)
    const pairs = Array.from({ length: 8 }, (_, c): [string, string] => {
      const old = Array.from({ length: 34_000 + Math.floor(rand() * 4000) }, (_, i) => (rand() < 0.1 ? `rep ${Math.floor(rand() * 6)}` : `u${c}.${i}`))
      const next = [...old]
      for (let e = 0; e < (c % 2 ? 6000 : 1500) + Math.floor(rand() * 1500); e++) {
        const at = Math.floor(rand() * next.length)
        const op = rand()
        if (op < 0.4) next.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 3) }, () => (rand() < 0.5 ? `rep ${Math.floor(rand() * 6)}` : `new ${c}.${e}`)))
        else if (op < 0.8) next.splice(at, 1 + Math.floor(rand() * 3))
        else next[at] = `changed ${c}.${e}`
      }
      return [`${old.join('\n')}\n`, `${next.join('\n')}\n`]
    })
    const want = gitMarks(pairs)
    pairs.forEach(([a, b], c) => expect(ourMarks(a, b), `case ${c}`).toEqual(want[c]))
  }, 180_000)

  it('the line map of a pair follows the same marks', () => {
    // Line 4 of the new file is the old line 4 (both "\ty"), not line 7 (another "\ty").
    expect([...(lineMap('\nc\na\n\ty\n\n}\n\ty\n', '\ty\nb\na\n\ty\na\n') as Int32Array)]).toEqual([3, -1, -1, 6, -1])
  })
})

describe('xdiffChanges bounds', () => {
  it('returns null past the work bound, and answers within it', () => {
    // The same 2000 distinct lines in another order: every line matches, so none is discarded.
    const rand = prng(SEED)
    const a = Array.from({ length: 2000 }, (_, i) => `${i}\n`)
    const b = [...a].sort(() => rand() - 0.5)
    expect(xdiffChanges(a, b, { maxEdits: DEFAULT_DIFF_LIMITS.maxEdits, maxWork: 10_000 })).toBeNull()
    expect(xdiffChanges(a, b, DEFAULT_DIFF_LIMITS)).not.toBeNull()
  })

  it('trims the common tail as git does: whole 1 KiB blocks, less their first partial line', () => {
    // 100 shared lines of 20 bytes (2000 bytes): one 1024-byte block is trimmed, which starts 4
    // bytes before the end of the 52nd line from the end. git gives back the bytes up to that
    // line's newline, so it drops the 51 whole lines after it.
    const tail = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(19, '0')}\n`)
    expect(commonTailRecords(['x\n', ...tail], ['y\n', ...tail])).toBe(51)
    // Under 1 KiB in common: nothing is trimmed.
    expect(commonTailRecords(['x\n', ...tail.slice(0, 40)], ['y\n', ...tail.slice(0, 40)])).toBe(0)
  })
})
