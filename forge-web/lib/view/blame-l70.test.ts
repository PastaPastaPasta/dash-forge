/**
 * L-70 (dashpay/dash `src/qt/dashstrings.cpp`): blame of its 33 first-parent versions against git
 * blame over the same versions. Runs only where the versions were dumped (FORGE_L70_DIR, from
 * `blame-dump.live.test.ts`; the QA copy is `evidence/impl/perf-blame-history-shell/l70-versions`,
 * 956 KB, too large to vendor) and git is installed; a failure names the version pair that
 * diverges. CI is covered by the git-oracle property tests in `xdiff.test.ts` and `blame.test.ts`.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { gitBlame, HAVE_GIT } from '../merge/git-oracle'
import { blameFile } from './blame'
import { lineMap } from './blame-core'
import { Store } from './diff-fixtures'

const DIR = process.env['FORGE_L70_DIR']

/** git's line map of `after` against `before` (for each line of after, its line in before, or -1). */
function gitLineMap(before: string, after: string): number[] {
  const d = mkdtempSync(join(tmpdir(), 'l70-'))
  writeFileSync(join(d, 'a'), before)
  writeFileSync(join(d, 'b'), after)
  let out = ''
  try {
    execFileSync('git', ['diff', '--no-index', '--no-color', '-U0', join(d, 'a'), join(d, 'b')], { encoding: 'utf8' })
  } catch (e) {
    out = (e as { stdout: string }).stdout
  }
  const nb = after.split('\n').length - (after.endsWith('\n') ? 1 : 0)
  const map = new Array<number>(nb).fill(-2)
  const hunks = [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    os: Number(m[1]), oc: m[2] === undefined ? 1 : Number(m[2]), ns: Number(m[3]), nc: m[4] === undefined ? 1 : Number(m[4]),
  }))
  let o = 1
  let n = 1
  for (const h of hunks) {
    const nStart = h.nc === 0 ? h.ns + 1 : h.ns
    const oStart = h.oc === 0 ? h.os + 1 : h.os
    while (n < nStart) map[n++ - 1] = o++ - 1
    for (let k = 0; k < h.nc; k++) map[n++ - 1] = -1
    o = oStart + h.oc
  }
  while (n <= nb) map[n++ - 1] = o++ - 1
  return map
}

describe.skipIf(!HAVE_GIT || DIR === undefined)('L-70: dashstrings.cpp against git blame', () => {
  it('attributes every line as git blame --first-parent does', async () => {
    const files = readdirSync(DIR!).filter((f) => f.endsWith('.txt')).sort().reverse() // oldest first
    const texts = files.map((f) => readFileSync(join(DIR!, f), 'utf8'))
    const s = new Store()
    let tip = ''
    const byCommit: string[] = []
    for (const t of texts) {
      tip = s.commit(s.files({ f: t }), tip === '' ? [] : [tip], String(byCommit.length))
      byCommit.push(tip)
    }
    const want = gitBlame(s.objects.values(), tip, "f") ?? []
    const got = (await blameFile(s.reader(), tip, 'f', { maxVersions: 1000 })).hunks.flatMap((h) => new Array<string>(h.count).fill(h.oid))
    const diffs = want.map((w, i) => (w === got[i] ? null : { line: i + 1, git: files[byCommit.indexOf(w)], ours: files[byCommit.indexOf(got[i]!)] })).filter((d) => d !== null)
    // The version steps where our line map and git's differ.
    const steps: string[] = []
    for (let k = texts.length - 1; k > 0; k--) {
      const ours = [...(lineMap(texts[k - 1]!, texts[k]!) ?? [])]
      const theirs = gitLineMap(texts[k - 1]!, texts[k]!)
      const bad = ours.map((v, i) => (v === theirs[i] ? null : `L${i + 1}: ours ${v + 1} git ${(theirs[i] ?? -2) + 1}`)).filter((x) => x !== null)
      if (bad.length > 0) steps.push(`${files[k - 1]} -> ${files[k]}: ${bad.slice(0, 6).join('; ')}${bad.length > 6 ? ` (+${bad.length - 6})` : ''}`)
    }
    expect(diffs, JSON.stringify({ diffs, steps }, null, 1)).toEqual([])
  }, 120_000)
})
