/**
 * The xdiff port against real git (skipped where git is not installed):
 *
 *  - {@link diffChanges} gives the very hunks `git diff --no-index -U0 --no-indent-heuristic`
 *    prints, for the histogram and the Myers algorithm, over random files built to make diffs
 *    ambiguous (few distinct lines, runs that slide, more than 64 copies of a line so histogram
 *    falls back to Myers, missing final newlines, CRLF);
 *  - {@link merge3}: whenever it merges, `git merge-file -p --diff-algorithm=histogram` merges
 *    cleanly to the same bytes; whenever git conflicts, it does not merge.
 *
 * `FORGE_PARITY_CASES` sets the cases (300 by default), `FORGE_PARITY_SEED` the seed.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { HAVE_GIT } from './git-oracle'
import { merge3 } from './merge3'
import { editLines, GIT_ENV, prng, randomLines, toBytes } from './parity-fixtures'
import { diffChanges, recordKey, splitRecords, type DiffAlgorithm } from './xdiff'

const CASES = Number(process.env['FORGE_PARITY_CASES'] ?? '300')
const SEED = Number(process.env['FORGE_PARITY_SEED'] ?? '20261002')

const enc = new TextEncoder()

/** The hunks `git diff -U0` prints, as `[i1, chg1, i2, chg2]` (0-based starts as xdiff's script). */
function gitHunks(dir: string, a: Uint8Array, b: Uint8Array, algorithm: DiffAlgorithm): number[][] {
  writeFileSync(join(dir, 'a'), a)
  writeFileSync(join(dir, 'b'), b)
  const r = spawnSync('git', ['-c', 'core.quotepath=off', 'diff', '--no-index', '--no-color', '-U0', '--no-indent-heuristic', `--diff-algorithm=${algorithm}`, '--', 'a', 'b'], { cwd: dir, env: GIT_ENV, maxBuffer: 1 << 26 })
  if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr.toString()}`)
  const out: number[][] = []
  for (const line of r.stdout.toString('latin1').split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (m === null) continue
    const chg1 = m[2] === undefined ? 1 : Number(m[2])
    const chg2 = m[4] === undefined ? 1 : Number(m[4])
    // `-U0` names the line before an empty range.
    const i1 = chg1 === 0 ? Number(m[1]) : Number(m[1]) - 1
    const i2 = chg2 === 0 ? Number(m[3]) : Number(m[3]) - 1
    out.push([i1, chg1, i2, chg2])
  }
  return out
}

describe.skipIf(!HAVE_GIT)('the xdiff port is git diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-xdiff-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  for (const algorithm of ['histogram', 'myers'] as const) {
    it(`${algorithm}: the same hunks as git diff -U0`, () => {
      const rand = prng(SEED + (algorithm === 'histogram' ? 1 : 2))
      const wrong: string[] = []
      for (let n = 0; n < CASES; n++) {
        const lines = randomLines(rand)
        const a = toBytes(lines, rand)
        const b = toBytes(editLines(lines, rand, 'n'), rand)
        // git diff trims a common tail of whole KiB blocks with -U0; the files here are smaller.
        const ours = diffChanges(splitRecords(a).map(recordKey), splitRecords(b).map(recordKey), algorithm).map((c) => [c.i1, c.chg1, c.i2, c.chg2])
        const git = gitHunks(dir, a, b, algorithm)
        if (JSON.stringify(ours) !== JSON.stringify(git)) wrong.push(`case ${n}: ${JSON.stringify(new TextDecoder().decode(a))} → ${JSON.stringify(new TextDecoder().decode(b))}: ours ${JSON.stringify(ours)} git ${JSON.stringify(git)}`)
      }
      expect(wrong.slice(0, 3)).toEqual([])
    }, 300_000)

    it(`${algorithm}: large, heavily edited files (Myers' cost heuristics) give git's hunks`, () => {
      const rand = prng(SEED + (algorithm === 'histogram' ? 11 : 12))
      const wrong: string[] = []
      for (let n = 0; n < Math.max(4, Math.floor(CASES / 25)); n++) {
        const tokens = Array.from({ length: 4 + Math.floor(rand() * 40) }, (_, i) => `t${i}`)
        const lines = Array.from({ length: 1000 + Math.floor(rand() * 3000) }, () => tokens[Math.floor(rand() * tokens.length)] as string)
        const edited = lines.flatMap((l) => (rand() < 0.3 ? (rand() < 0.5 ? [] : [tokens[Math.floor(rand() * tokens.length)] as string, `new${Math.floor(rand() * 9)}`]) : [l]))
        // Different last lines: git diff -U0 trims a common tail of whole KiB blocks first.
        const a = enc.encode(`${[...lines, 'end a'].join('\n')}\n`)
        const b = enc.encode(`${[...edited, 'end b'].join('\n')}\n`)
        const ours = diffChanges(splitRecords(a).map(recordKey), splitRecords(b).map(recordKey), algorithm).map((c) => [c.i1, c.chg1, c.i2, c.chg2])
        const git = gitHunks(dir, a, b, algorithm)
        if (JSON.stringify(ours) !== JSON.stringify(git)) wrong.push(`case ${n}: ${ours.length} hunks here, ${git.length} in git`)
      }
      expect(wrong).toEqual([])
    }, 300_000)
  }
})

describe.skipIf(!HAVE_GIT)('merge3 is git merge-file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-merge3-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('clean here ⇒ clean in git with the same bytes; a git conflict is never merged here', () => {
    const rand = prng(SEED + 3)
    const wrong: string[] = []
    let clean = 0
    let gitOnly = 0
    let conflicts = 0
    for (let n = 0; n < CASES * 2; n++) {
      const lines = randomLines(rand)
      const base = toBytes(lines, rand)
      const ours = toBytes(editLines(lines, rand, 'o'), rand)
      const theirs = toBytes(editLines(lines, rand, 't'), rand)
      if (recordKey(ours) === recordKey(base) || recordKey(theirs) === recordKey(base) || recordKey(ours) === recordKey(theirs)) continue
      writeFileSync(join(dir, 'base'), base)
      writeFileSync(join(dir, 'ours'), ours)
      writeFileSync(join(dir, 'theirs'), theirs)
      const r = spawnSync('git', ['-c', 'merge.conflictStyle=merge', 'merge-file', '-p', '--diff-algorithm=histogram', 'ours', 'base', 'theirs'], { cwd: dir, env: GIT_ENV, maxBuffer: 1 << 26 })
      if (r.status === null || r.status < 0 || r.status > 127) throw new Error(`git merge-file failed: ${r.stderr.toString()}`)
      const gitClean = r.status === 0
      const mine = merge3(base, ours, theirs)
      const show = (b: Uint8Array): string => JSON.stringify(new TextDecoder().decode(b))
      if (mine.kind === 'clean') {
        clean++
        if (!gitClean) wrong.push(`case ${n}: merged here, git conflicts: base ${show(base)} ours ${show(ours)} theirs ${show(theirs)}`)
        else if (recordKey(mine.bytes) !== recordKey(new Uint8Array(r.stdout))) wrong.push(`case ${n}: different bytes: base ${show(base)} ours ${show(ours)} theirs ${show(theirs)}: ${show(mine.bytes)} vs ${show(new Uint8Array(r.stdout))}`)
      } else if (gitClean) gitOnly++
      else conflicts++
    }
    expect(wrong.slice(0, 3)).toEqual([])
    // Not vacuous: both clean merges and conflicts are common.
    expect(clean).toBeGreaterThan(CASES / 10)
    expect(conflicts).toBeGreaterThan(CASES / 10)
    // Merges git makes clean only at its default conflict style (an overlap whose two sides are
    // the same lines) are refused here; they are rare.
    expect(gitOnly).toBeLessThan(clean)
  }, 300_000)
})
