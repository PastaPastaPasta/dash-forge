/* eslint-disable no-console -- a local measuring helper: it reports what it measured. */
/**
 * Local helper (never gates CI): FG-5 on the real dashpay/dash history, read from a local clone
 * through `git cat-file --batch`, checked against git itself. For the ledger's commits:
 *
 *  - f1be1b800 (3 moved completion scripts): 69 files, the renames `git diff -M` finds (L-24);
 *  - f5979f7c5 (a 747-file merge): whole-commit totals equal to `git diff --shortstat` (L-25);
 *  - v22.0.0...develop: the merge base, `git rev-list --count v22.0.0..develop`, and the object
 *    reads it takes (L-30).
 *
 *   FORGE_DASH_GIT_DIR=/path/to/dash FORGE_DASH_DEVELOP=<develop oid> pnpm exec vitest run lib/view/dash-compare.local.test.ts
 */

import { spawn, spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import type { GitObject } from '../browse'
import { loadCommitChanges } from './commit-log'
import { loadComparison } from './compare'
import { diffTotals, loadFilePatch, type FilePatch } from './file-diff'
import { mapPooled } from './pool'
import { findMergeBase } from './pull-diff'
import { newCommits } from '../merge/objects'
import type { PrefixReader } from './commit-log'

const DIR = process.env['FORGE_DASH_GIT_DIR']
const DEVELOP = process.env['FORGE_DASH_DEVELOP'] ?? ''

/** An object reader over `git cat-file --batch`, counting reads. */
function catFileReader(dir: string): PrefixReader & { reads: number; distinct: Set<string>; close(): void } {
  const proc = spawn('git', ['cat-file', '--batch'], { cwd: dir })
  let buf = Buffer.alloc(0)
  const waiting: { resolve: (o: GitObject) => void; reject: (e: Error) => void }[] = []
  proc.stdout.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const nl = buf.indexOf(0x0a)
      if (nl === -1) return
      const header = buf.subarray(0, nl).toString()
      const parts = header.split(' ')
      if (parts[1] === 'missing') {
        buf = buf.subarray(nl + 1)
        waiting.shift()?.reject(new Error(`missing ${parts[0]}`))
        continue
      }
      const size = Number(parts[2])
      if (buf.length < nl + 1 + size + 1) return
      const bytes = new Uint8Array(buf.subarray(nl + 1, nl + 1 + size))
      buf = buf.subarray(nl + 1 + size + 1)
      waiting.shift()?.resolve({ type: parts[1] as GitObject['type'], bytes })
    }
  })
  const r = {
    reads: 0,
    distinct: new Set<string>(),
    readObject(oid: string): Promise<GitObject> {
      r.reads += 1
      r.distinct.add(oid)
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject })
        proc.stdin.write(`${oid}\n`)
      })
    },
    close: () => proc.stdin.end(),
  }
  return r
}

/**
 * What the distinct objects read cost as a browser would read them: commits come in read-ahead
 * blocks (their packed bytes / 256 KiB, the pack's commits being contiguous), every other object is
 * its own ranged read.
 */
function costOf(dir: string, oids: ReadonlySet<string>): Record<string, number> {
  const r = spawnSync('git', ['cat-file', '--batch-check=%(objecttype) %(objectsize:disk)'], { cwd: dir, input: [...oids].join('\n') + '\n', maxBuffer: 1 << 28 })
  const out: Record<string, number> = { commit: 0, tree: 0, blob: 0, commitBytes: 0 }
  for (const line of r.stdout.toString().split('\n')) {
    const [type, size] = line.split(' ')
    if (type === undefined || size === undefined) continue
    out[type] = (out[type] ?? 0) + 1
    if (type === 'commit') out['commitBytes'] = (out['commitBytes'] ?? 0) + Number(size)
  }
  out['commitBlocks'] = Math.ceil((out['commitBytes'] ?? 0) / (256 * 1024))
  return out
}

const git = (dir: string, args: string[]): string => spawnSync('git', args, { cwd: dir, maxBuffer: 1 << 28 }).stdout.toString().trim()

describe.skipIf(DIR === undefined)('FG-5 on dashpay/dash (local clone)', () => {
  it('f1be1b800: renames as git diff -M finds them', async () => {
    const r = catFileReader(DIR!)
    try {
      const got = await loadCommitChanges(r, git(DIR!, ['rev-parse', 'f1be1b800^{commit}']))
      const oid = got.oid
      const want = git(DIR!, ['diff', '-M', '--name-status', `${oid}^`, oid]).split('\n').map((l) => {
        const [st, ...p] = l.split('\t')
        return `${(st as string).startsWith('R') ? `R ${p[0]} ${p[1]}` : `${(st as string)[0]} ${p[0]}`}`
      })
      const ours = got.changes.map((c) => (c.status === 'renamed' ? `R ${c.oldPath} ${c.path}` : `${c.status[0]!.toUpperCase()} ${c.path}`))
      expect(ours.sort()).toEqual(want.sort())
      expect(got.changes).toHaveLength(69)
      console.log(`f1be1b800: ${got.changes.length} files, ${got.changes.filter((c) => c.status === 'renamed').length} renames, ${r.reads} object reads`)
    } finally {
      r.close()
    }
  }, 120_000)

  it('f5979f7c5: whole-commit totals equal git diff --shortstat', async () => {
    const r = catFileReader(DIR!)
    try {
      const got = await loadCommitChanges(r, git(DIR!, ['rev-parse', 'f5979f7c5^{commit}']))
      const sides = { base: r, head: r }
      const patches = await mapPooled(got.changes, 8, (c) => loadFilePatch(sides, c))
      const byPath = new Map<string, FilePatch>(patches.map((p) => [p.change.path, p]))
      const totals = diffTotals(got.changes, (c) => byPath.get(c.path))
      const stat = git(DIR!, ['diff', '-M', '--shortstat', `${got.oid}^`, got.oid])
      // The files the view says it did not count (over the inline-diff limit), counted by git.
      const skipped = got.changes.filter((c) => {
        const p = byPath.get(c.path)
        return p?.kind === 'placeholder' && p.added === undefined && (p.reason === 'large' || p.reason === 'too-complex' || p.reason === 'unreadable')
      })
      let addSkipped = 0
      let delSkipped = 0
      for (const c of skipped) {
        const [a, d] = git(DIR!, ['diff', '--numstat', `${got.oid}^`, got.oid, '--', c.path]).split('\t')
        addSkipped += Number(a)
        delSkipped += Number(d)
      }
      console.log(`f5979f7c5: ${got.changes.length} files +${totals.added} −${totals.deleted} (${totals.uncounted} not counted: ${skipped.map((c) => c.path).join(', ')}); git: ${stat}; ${r.reads} object reads`)
      expect(totals.uncounted).toBe(skipped.length)
      // Per file, to name any that counts differently from git.
      const numstat = new Map(
        git(DIR!, ['diff', '-M', '--numstat', `${got.oid}^`, got.oid])
          .split('\n')
          .map((l) => l.split('\t'))
          .map(([a, d, ...p]) => [p.join('\t').replace(/^.*=> /, '').replace(/[{}]/g, ''), `${a}/${d}`] as const),
      )
      const differ = patches.filter((p) => p.kind === 'text' && numstat.get(p.change.path) !== `${p.added}/${p.deleted}`).map((p) => `${p.change.path}: ours ${p.kind === 'text' ? `${p.added}/${p.deleted}` : ''}, git ${numstat.get(p.change.path)}`)
      if (differ.length > 0) console.log(`differ: ${differ.join('; ')}`)
      expect(stat).toContain(`${got.changes.length} files changed`)
      expect(stat).toContain(`${totals.added + addSkipped} insertions(+)`)
      expect(stat).toContain(`${totals.deleted + delSkipped} deletions(-)`)
    } finally {
      r.close()
    }
  }, 300_000)

  it.skipIf(DEVELOP === '')('v22.0.0...develop: merge base, commit count and cost', async () => {
    const r = catFileReader(DIR!)
    try {
      const base = git(DIR!, ['rev-parse', 'v22.0.0^{commit}'])
      const t0 = Date.now()
      const mbReads = r.reads
      await findMergeBase(r, base, DEVELOP)
      const mbCost = r.reads - mbReads
      const nc0 = r.reads
      await newCommits(r, DEVELOP, [base], 60_000)
      console.log(`phases: merge base ${mbCost} reads, commit list ${r.reads - nc0} reads`)
      r.reads = 0
      r.distinct.clear()
      const t1 = Date.now()
      const got = await loadComparison(r, base, DEVELOP)
      const ms = Date.now() - t1
      void t0
      expect(got.kind).toBe('diff')
      if (got.kind !== 'diff') return
      expect(got.mergeBase).toBe(git(DIR!, ['merge-base', base, DEVELOP]))
      expect(got.commits.total).toBe(Number(git(DIR!, ['rev-list', '--count', `${base}..${DEVELOP}`])))
      const files = Number(/(\d+) files? changed/.exec(git(DIR!, ['diff', '-M', '--shortstat', `${base}...${DEVELOP}`]))?.[1])
      console.log(
        `v22.0.0...develop: ${JSON.stringify(costOf(DIR!, r.distinct))}; ${got.commits.total} commits, ${got.diff.changes.length}${got.diff.truncated ? '+ (listing capped)' : ''} of ${files} files, renames ${got.diff.changes.filter((c) => c.status === 'renamed').length} (${got.diff.renameLimit ?? 'no limit hit'}), ${r.reads} object reads (${r.distinct.size} distinct), ${ms} ms`,
      )
    } finally {
      r.close()
    }
  }, 600_000)
})
