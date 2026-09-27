/**
 * D-040: a PR on a long-lived branch. The merge-base walk used to pay one ranged read per
 * commit and give up at 2,000 commits (~100 s and 2,065 storage GETs on git/git). These tests
 * build a real pack the way `git pack-objects` lays one out (commits first, newest first), read
 * it through the ordinary BrowseReader, and hold the walk to a request budget.
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { BrowseReader, ObjectLocator, gitOidHex, type ObjectVerdict, type PackSource } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { objHeader, packFrame } from '../browse/pack-fixtures'
import { PACK_TYPE } from '../browse/pack'
import { findMergeBase, loadPullComparison, MergeBaseCancelledError } from './pull-diff'
import { loadCommitChanges } from './commit-log'

const enc = new TextEncoder()
const TREE = gitOidHex('tree', new Uint8Array(0))

interface Built {
  readonly reader: BrowseReader
  readonly fetches: () => number
  readonly fork: string
  readonly baseTip: string
  readonly head: string
}

/**
 * `baseCommits` on the base branch after the fork point, `headCommits` on the PR branch, and
 * a shared history of `shared` commits before it. Commits carry a realistic ~200-byte message.
 */
async function build(
  shared: number,
  baseCommits: number,
  headCommits: number,
  onObject?: (verdict: ObjectVerdict, count?: number) => void,
): Promise<Built> {
  const objects: { oid: string; bytes: Uint8Array }[] = []
  let when = 1_600_000_000
  const commit = (parents: readonly string[], msg: string): string => {
    const ident = `A U Thor <author@example.com> ${when++} +0000`
    const text = [`tree ${TREE}`, ...parents.map((p) => `parent ${p}`), `author ${ident}`, `committer ${ident}`, '', `${msg}\n${'body '.repeat(30)}`, ''].join('\n')
    const bytes = enc.encode(text)
    const oid = gitOidHex('commit', bytes)
    objects.push({ oid, bytes })
    return oid
  }
  let tip = commit([], 'root')
  for (let i = 0; i < shared; i++) tip = commit([tip], `shared ${i}`)
  const fork = tip
  let head = fork
  for (let i = 0; i < headCommits; i++) head = commit([head], `pr ${i}`)
  let base = fork
  for (let i = 0; i < baseCommits; i++) base = commit([base], `base ${i}`)

  // Newest first, as pack-objects writes them; the empty tree last.
  const stored = [...objects].reverse().map((o) => new Uint8Array([...objHeader(PACK_TYPE.COMMIT, o.bytes.length), ...zlibSync(o.bytes)]))
  stored.push(new Uint8Array([...objHeader(PACK_TYPE.TREE, 0), ...zlibSync(new Uint8Array(0))]))
  const pack = packFrame(...stored)
  const locator = ObjectLocator.parse(serializeLocator(await indexPacks([pack])))
  const inner = memoryPackSource([pack])
  let count = 0
  const counted: PackSource = {
    fetchRange: (...args) => {
      count++
      return inner.fetchRange(...args)
    },
    sizeOf: inner.sizeOf,
  }
  return { reader: new BrowseReader(locator, counted, onObject ? { onObject } : {}), fetches: () => count, fork, baseTip: base, head }
}

describe('merge-base walk over a long history (D-040)', () => {
  it('finds the fork point 2,500 base commits back within a request budget', async () => {
    const b = await build(200, 2500, 5)
    const got = await findMergeBase(b.reader.forHistoryWalk(), b.baseTip, b.head)
    expect(got).toBe(b.fork)
    // ~2,700 commits read; one ranged read per 256 KiB block of the pack, not one per commit.
    expect(b.fetches()).toBeLessThanOrEqual(10)
  })

  it('costs one read per commit without read-ahead (the old path)', async () => {
    const b = await build(20, 300, 2)
    await findMergeBase(b.reader, b.baseTip, b.head)
    expect(b.fetches()).toBeGreaterThan(300)
  })

  it('compares a PR whose base moved 2,500 commits on, instead of falling back to the head commit', async () => {
    const b = await build(50, 2500, 3)
    const r = b.reader
    const result = await loadPullComparison(
      { base: r, head: r },
      { baseTipOid: b.baseTip, baseOidAtOpen: b.baseTip, headOid: b.head, merged: false, imported: false },
    )
    expect(result.comparedBaseOid).toBe(b.fork)
    expect(result.comparisonNote).toBeNull()
    expect(b.fetches()).toBeLessThanOrEqual(10)
  })

  it('reports progress and stops when cancelled', async () => {
    const b = await build(50, 2000, 3)
    const controller = new AbortController()
    const seen: number[] = []
    const run = findMergeBase(b.reader.forHistoryWalk(), b.baseTip, b.head, {
      signal: controller.signal,
      onProgress: (n) => {
        seen.push(n)
        if (n >= 500) controller.abort()
      },
    })
    await expect(run).rejects.toBeInstanceOf(MergeBaseCancelledError)
    expect(seen.slice(0, 3)).toEqual([100, 200, 300])
    expect(Math.max(...seen)).toBeLessThan(700)
  })

  it('falls back to the first parent, flagged as stopped, when the user stops the search', async () => {
    const b = await build(50, 2000, 3)
    const controller = new AbortController()
    const result = await loadPullComparison(
      { base: b.reader, head: b.reader },
      { baseTipOid: b.baseTip, baseOidAtOpen: b.baseTip, headOid: b.head, merged: false, imported: false },
      { signal: controller.signal, onProgress: (n) => n >= 300 && controller.abort() },
    )
    expect(result.searchStopped).toBe(true)
    expect(result.comparisonNote).toMatch(/was stopped after .* commits.*first parent/s)
  })

  it('reports the walk\'s hash checks in a few batches, not one per commit', async () => {
    const calls: [ObjectVerdict, number | undefined][] = []
    const b = await build(50, 2500, 3, (v, n) => calls.push([v, n]))
    const result = await loadPullComparison(
      { base: b.reader, head: b.reader },
      { baseTipOid: b.baseTip, baseOidAtOpen: b.baseTip, headOid: b.head, merged: false, imported: false },
    )
    expect(result.comparedBaseOid).toBe(b.fork)
    const verified = calls.filter(([v]) => v === 'verified').reduce((n, [, c]) => n + (c ?? 1), 0)
    expect(verified).toBeGreaterThan(2500)
    expect(calls.length).toBeLessThan(20)
  })

  it('opens a commit by its 7-character id through a real BrowseReader (D-057)', async () => {
    const b = await build(5, 5, 2)
    const changes = await loadCommitChanges(b.reader, b.head.slice(0, 7))
    expect(changes.oid).toBe(b.head)
    // Resolution reads entry headers only: a handful of small ranges, not whole objects.
    expect(b.fetches()).toBeLessThan(10)
  })
})
