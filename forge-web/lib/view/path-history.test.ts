/**
 * The Commits page's paging and a path's History (F-5): every commit on a first-parent walk,
 * page by page, or only those that changed a path — checked against `git log --first-parent`, and
 * held to a read budget on a real pack (the history walker reads commits in blocks, and a second
 * walk of the same path reads nothing again).
 */

import { spawnSync } from 'node:child_process'
import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { BrowseReader, ObjectLocator, type PackSource } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { objHeader, packFrame } from '../browse/pack-fixtures'
import { PACK_TYPE } from '../browse/pack'
import { HAVE_GIT, scratchRepo, writeBatched } from '../merge/git-oracle'
import { Store } from './diff-fixtures'
import { historyWalker } from './commit-log'
import { logPage } from './path-history'

/** A history of `n` commits over `a.txt` (changes every 3rd commit), `dir/b.txt` (every 5th) and `c.txt` (every commit). */
function history(n: number, messagePad = 0): { s: Store; tips: string[] } {
  const s = new Store()
  const tips: string[] = []
  let tip: string | undefined
  for (let i = 0; i < n; i++) {
    const files = { 'a.txt': String(Math.floor(i / 3)), 'dir/b.txt': String(Math.floor(i / 5)), 'c.txt': String(i) }
    // A real commit message is hundreds of bytes: padded, a long history spans many read-ahead blocks.
    tip = s.commit(s.files(files), tip === undefined ? [] : [tip], `commit ${i}${messagePad > 0 ? `\n\n${'body '.repeat(messagePad)}` : ''}`)
    tips.push(tip)
  }
  return { s, tips }
}

/** `git log --first-parent --format=%H <tip> -- <path>` over the store's objects. */
function gitLog(s: Store, tip: string, path: string): string[] | null {
  if (!HAVE_GIT) return null
  const { dir, done } = scratchRepo()
  try {
    writeBatched(dir, s.objects.values())
    const r = spawnSync('git', ['log', '--first-parent', '--format=%H', tip, ...(path ? ['--', path] : [])], { cwd: dir })
    return r.stdout.toString().split('\n').filter((l) => l !== '')
  } finally {
    done()
  }
}

describe('logPage', () => {
  it('pages the whole log 40 at a time and ends at the root', async () => {
    const { s, tips } = history(95)
    const reader = s.reader()
    const p1 = await logPage(reader, tips[94] as string)
    expect(p1.entries.map((e) => e.subject)).toEqual(Array.from({ length: 40 }, (_, i) => `commit ${94 - i}`))
    expect(p1.next).toBe(tips[54])
    const p2 = await logPage(reader, p1.next as string)
    const p3 = await logPage(reader, p2.next as string)
    expect(p3.entries).toHaveLength(15)
    expect(p3.next).toBeNull()
    expect([...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.oid)).toEqual([...tips].reverse())
  })

  it.skipIf(!HAVE_GIT)('a file’s and a directory’s History are git log --first-parent -- <path>', async () => {
    const { s, tips } = history(60)
    const tip = tips[59] as string
    for (const path of ['a.txt', 'dir/b.txt', 'dir', 'c.txt']) {
      const got: string[] = []
      for (let next: string | null = tip; next !== null; ) {
        const page = await logPage(s.reader(), next, { path, limit: 7 })
        got.push(...page.entries.map((e) => e.oid))
        next = page.next
      }
      expect(got, path).toEqual(gitLog(s, tip, path))
    }
  })

  it('ends a History at the commit that added the path', async () => {
    const s = new Store()
    const c1 = s.commit(s.files({ old: '1' }), [], 'root')
    const c2 = s.commit(s.files({ old: '2', 'new.txt': 'a' }), [c1], 'add new')
    const c3 = s.commit(s.files({ old: '3', 'new.txt': 'b' }), [c2], 'edit new')
    const page = await logPage(s.reader(), c3, { path: 'new.txt' })
    expect(page.entries.map((e) => e.subject)).toEqual(['edit new', 'add new'])
    expect(page.next).toBeNull()
  })

  it('stops a sparse path walk at the cap and says so, then resumes from there', async () => {
    const { s, tips } = history(50)
    // `a.txt` changes every 3rd commit; with a cap of 10 commits examined, a page of 40 stops short.
    const page = await logPage(s.reader(), tips[49] as string, { path: 'a.txt', cap: 10 })
    expect(page.capped).toBe(true)
    expect(page.examined).toBe(10)
    expect(page.entries.length).toBeGreaterThan(0)
    const more = await logPage(s.reader(), page.next as string, { path: 'a.txt', cap: 10 })
    expect(more.entries[0]?.oid).not.toBe(page.entries.at(-1)?.oid)
  })

  it('forgets a failed read, so the next walk reads again', async () => {
    const { s, tips } = history(5)
    let fail = true
    const base = s.reader()
    const reader = { ...base, memoScope: {}, readObject: (oid: string) => (fail ? Promise.reject(new Error('offline')) : base.readObject(oid)) }
    await expect(logPage(reader, tips[4] as string)).rejects.toThrow('offline')
    fail = false
    expect((await logPage(reader, tips[4] as string)).entries).toHaveLength(5)
  })

  it('stops when its signal aborts', async () => {
    const { s, tips } = history(20)
    const stop = new AbortController()
    stop.abort()
    await expect(logPage(s.reader(), tips[19] as string, { signal: stop.signal })).rejects.toThrow()
  })
})

describe('request budget on a real pack (commits newest first, as pack-objects writes them)', () => {
  /** A pack of `n` commits (and their trees and blobs) through a BrowseReader counting its ranged reads. */
  async function packed(n: number): Promise<{ reader: BrowseReader; tip: string; fetches: () => number }> {
    const { s, tips } = history(n, 200)
    const all = [...s.objects.entries()]
    const order = [...all.filter(([, o]) => o.type === 'commit').reverse(), ...all.filter(([, o]) => o.type !== 'commit')]
    const code = { commit: PACK_TYPE.COMMIT, tree: PACK_TYPE.TREE, blob: PACK_TYPE.BLOB, tag: PACK_TYPE.TAG } as const
    const pack = packFrame(...order.map(([, o]) => new Uint8Array([...objHeader(code[o.type], o.bytes.length), ...zlibSync(o.bytes)])))
    const locator = ObjectLocator.parse(serializeLocator(await indexPacks([pack])))
    const inner = memoryPackSource([pack])
    let count = 0
    const counted: PackSource = { fetchRange: (...args) => (count++, inner.fetchRange(...args)), sizeOf: inner.sizeOf }
    return { reader: new BrowseReader(locator, counted), tip: tips[n - 1] as string, fetches: () => count }
  }

  it('a page of the log costs a few block reads, not one per commit', async () => {
    const { reader, tip, fetches } = await packed(2000)
    // One walker for every page, as the Commits page keeps one.
    const walker = historyWalker(reader)
    const page = await logPage(reader, tip, { walker })
    expect(page.entries).toHaveLength(40)
    // 40 commits of ~1 KiB: one 256 KiB block (plus one for the pack's size-less tail at most).
    expect(fetches()).toBeLessThanOrEqual(2)
    // Paging on through all 2,000 costs about one read per 250 commits, not 2,000.
    let next = page.next
    while (next !== null) next = (await logPage(reader, next, { walker })).next
    expect(fetches()).toBeLessThanOrEqual(12)
  })

  it('a path History reads only the trees on the path; a second walk of it (and paging back over it) reads nothing', async () => {
    const { reader, tip, fetches } = await packed(2000)
    const first = await logPage(reader, tip, { path: 'dir/b.txt' })
    const afterFirst = fetches()
    expect(first.entries).toHaveLength(40)
    // 200 commits examined, with their root and `dir` trees (never a blob): read in blocks, a
    // handful of reads rather than ~600 (one per object).
    expect(first.examined).toBe(200)
    expect(afterFirst).toBeLessThanOrEqual(6)
    await logPage(reader.forView('another page'), tip, { path: 'dir/b.txt' })
    expect(fetches()).toBe(afterFirst)
  })
})
