/**
 * Real git as the judge (skipped where git is not installed):
 *
 *  - what the browser merge produces from ordinary histories — fast-forwards, merge commits,
 *    subdirectories, symlinks, executables, gitlinks, non-ASCII names — passes
 *    `git fsck --strict`, `git log` and `git clone` when written into a real repository;
 *  - a property test: random mutations of well-formed commit and tree bytes, and the web's
 *    checks never accept one that git's own object checks reject.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { gitOidHex, MODE_GITLINK, MODE_TREE, type GitObject } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { BrowseReader, ObjectLocator } from '../browse'
import { Store } from '../view/diff-fixtures'
import { checkCommit, checkTree } from '../view/git-objects'
import { runMerge, type MergeInput } from './engine'
import { gitAcceptsHistory, gitAcceptsObject, HAVE_GIT } from './git-oracle'

const ME = { name: 'Merger', email: 'm@example.com', timestamp: 1_700_000_000, timezoneOffset: -60 }
const input = (baseTip: string, headOid: string): MergeInput => ({ baseTip, headOid, prNumber: 9, sourceLabel: 'refs/heads/feature', title: 'Feature', author: ME, headInBase: false })

/** Everything the base had, plus what the merge pack carries: the repository after the merge. */
async function afterMerge(s: Store, pack: Uint8Array): Promise<GitObject[]> {
  const rows = await indexPacks([pack])
  const r = new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), memoryPackSource([pack]))
  const packed = await Promise.all(rows.map((row) => r.readObject(row.oidHex)))
  return [...s.objects.values(), ...packed]
}

describe.skipIf(!HAVE_GIT)('what the browser merge produces, git accepts', () => {
  it('a merge commit over directories, an executable, a symlink, a gitlink and non-ASCII names', async () => {
    const s = new Store()
    const sub = '1'.repeat(40)
    const tree = (a: string, b: string): string =>
      s.tree([
        { name: 'README.md', oid: s.blob(a) },
        { name: 'src', oid: s.files({ 'main.rs': b, 'lib/util.rs': 'u\n' }), mode: MODE_TREE },
        { name: 'run.sh', oid: s.blob('#!/bin/sh\n'), mode: 0o100755 },
        { name: 'link', oid: s.blob('README.md'), mode: 0o120000 },
        { name: 'vendor', oid: sub, mode: MODE_GITLINK },
        { name: 'café.txt', oid: s.blob('é\n') },
        { name: '\u{1f600}.md', oid: s.blob('smile\n') },
      ])
    const root = s.commit(tree('r\n', 'fn main() {}\n'))
    const base = s.commit(tree('R\n', 'fn main() {}\n'), [root])
    const head = s.commit(tree('r\n', 'fn main() { run() }\n'), [root])
    const out = await runMerge(s.reader(), input(base, head))
    if (out.kind !== 'merge') throw new Error(out.kind)
    const verdict = gitAcceptsHistory(await afterMerge(s, out.pack), out.newTip)
    expect(verdict).toEqual({ fsck: true, log: true, clone: true })
  }, 60_000)

  it('a fast-forward', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = s.commit(s.files({ 'a.txt': 'b\n', 'd/e.txt': 'e\n' }), [base])
    const out = await runMerge(s.reader(), input(base, head))
    if (out.kind !== 'fast-forward') throw new Error(out.kind)
    expect(gitAcceptsHistory(await afterMerge(s, out.pack), out.newTip)).toEqual({ fsck: true, log: true, clone: true })
  }, 60_000)
})

/** A tiny deterministic PRNG, so a failure is reproducible from its seed. */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 0x1_0000_0000
  }
}

const INTERESTING = [0x00, 0x0a, 0x20, 0x2f, 0x2e, 0x30, 0x3c, 0x3e, 0x5c, 0x7f, 0xef, 0xbb, 0xbf, 0xff, 0x2b, 0x2d]

/** Mutate `bytes`: flip, insert, delete or duplicate a line, biased towards interesting bytes. */
function mutate(bytes: Uint8Array, rand: () => number): Uint8Array {
  const arr = [...bytes]
  const at = Math.floor(rand() * (arr.length + 1))
  const pick = (): number => (rand() < 0.7 ? (INTERESTING[Math.floor(rand() * INTERESTING.length)] as number) : Math.floor(rand() * 256))
  switch (Math.floor(rand() * 5)) {
    case 0:
      if (arr.length > 0) arr[Math.min(at, arr.length - 1)] = pick()
      break
    case 1:
      arr.splice(at, 0, pick())
      break
    case 2:
      arr.splice(at, 1 + Math.floor(rand() * 4))
      break
    case 3: {
      const text = new TextDecoder('latin1').decode(new Uint8Array(arr))
      const lines = text.split('\n')
      const i = Math.floor(rand() * lines.length)
      lines.splice(i, 0, lines[i] as string)
      return Uint8Array.from(lines.join('\n'), (c) => c.charCodeAt(0))
    }
    default:
      arr.unshift(0xef, 0xbb, 0xbf)
  }
  return new Uint8Array(arr)
}

const webAccepts = (o: GitObject): boolean => {
  try {
    if (o.type === 'commit') checkCommit(gitOidHex(o.type, o.bytes), o.bytes)
    else checkTree(gitOidHex(o.type, o.bytes), o.bytes)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!HAVE_GIT)('property: the web never accepts an object git rejects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-git-prop-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('mutated commits and trees', () => {
    const s = new Store()
    const tree = s.tree([
      { name: 'a.txt', oid: s.blob('a\n') },
      { name: 'dir', oid: s.files({ 'x.rs': 'x\n' }), mode: MODE_TREE },
      { name: 'link', oid: s.blob('a.txt'), mode: 0o120000 },
    ])
    const parent = s.commit(tree)
    const commit = s.commit(tree, [parent], 'message\nbody')
    const seeds: GitObject[] = [s.objects.get(tree) as GitObject, s.objects.get(commit) as GitObject]
    const rand = prng(20260926)
    let checked = 0
    const disagreements: string[] = []
    for (let n = 0; n < 400; n++) {
      const seed = seeds[n % seeds.length] as GitObject
      let bytes = seed.bytes
      for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) bytes = mutate(bytes, rand)
      const obj: GitObject = { type: seed.type, bytes }
      if (!webAccepts(obj)) continue
      checked += 1
      if (gitAcceptsObject(obj, dir) === false) disagreements.push(`${obj.type}: ${Buffer.from(bytes).toString('hex')}`)
    }
    expect(disagreements).toEqual([])
    // Not vacuous: enough mutants pass the web's checks for git to judge them.
    expect(checked).toBeGreaterThan(20)
  }, 120_000)
})
