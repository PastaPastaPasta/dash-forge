/**
 * QW3-001: a history walk over an index read a slice at a time learns the commits after each one
 * it reads from the read-ahead block it read it from, so a page of log costs one index slice, not
 * one per commit.
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { WALK_LOOKUPS_BEFORE_WHOLE, WalkIndex, scanCommits } from './commit-run'
import { serializeLocator, type IndexedObject } from './indexer'
import { FANOUT_LEN, ObjectLocator, type LocatorEntry } from './locator'
import { FragmentedIndex, RangedLocator, type ObjectIndex } from './object-index'
import { PACK_TYPE, gitOidHex } from './pack'
import { T_BLOB, T_OFS_DELTA, concat, deltaSize, objHeader, ofsBase, packFrame } from './pack-fixtures'
import { BrowseReader, READ_AHEAD_BLOCK, type PackSource } from './reader'

const enc = new TextEncoder()
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** `n` commits, each the parent of the next, written newest first (as `git pack-objects` does), then a blob. */
function history(n: number, { deltaAt }: { deltaAt?: number | readonly number[] } = {}): { pack: Uint8Array; oids: string[]; rows: IndexedObject[] } {
  const deltas = new Set(typeof deltaAt === 'number' ? [deltaAt] : (deltaAt ?? []))
  const texts: Uint8Array[] = []
  const oids: string[] = []
  for (let i = 0; i < n; i++) {
    const parent = i === 0 ? '' : `parent ${oids[i - 1] as string}\n`
    const text = enc.encode(`tree ${TREE}\n${parent}author A <a@example.com> ${1_700_000_000 + i} +0000\ncommitter A <a@example.com> ${1_700_000_000 + i} +0000\n\nchange ${i}\n`)
    texts.push(text)
    oids.push(gitOidHex('commit', text))
  }
  // Newest first; one commit stored as an OFS delta of the commit written just before it.
  const order = [...texts.keys()].reverse()
  const stored: Uint8Array[] = []
  const rows: IndexedObject[] = []
  let at = 12
  let prev: { offset: number; text: Uint8Array } | null = null
  for (const i of order) {
    const text = texts[i] as Uint8Array
    let entry: Uint8Array
    if (deltas.has(i) && prev !== null) {
      // Copy nothing, insert all: a valid delta of the commit before it whose result is this one.
      const delta = new Uint8Array([...deltaSize(prev.text.length), ...deltaSize(text.length), ...chunkedInsert(text)])
      entry = concat(objHeader(T_OFS_DELTA, delta.length), ofsBase(at - prev.offset), zlibSync(delta))
    } else {
      entry = concat(objHeader(PACK_TYPE.COMMIT, text.length), zlibSync(text))
    }
    rows.push({ oidHex: oids[i] as string, packRef: 0, offset: at, length: entry.length, deltaDepth: deltas.has(i) && prev !== null ? 1 : 0 })
    stored.push(entry)
    prev = { offset: at, text }
    at += entry.length
  }
  const blob = enc.encode('a file\n')
  stored.push(concat(objHeader(T_BLOB, blob.length), zlibSync(blob)))
  return { pack: packFrame(...stored), oids, rows }
}

/** A delta's insert ops for `bytes` (at most 127 bytes each). */
function chunkedInsert(bytes: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i < bytes.length; i += 127) {
    const part = bytes.subarray(i, i + 127)
    out.push(part.length, ...part)
  }
  return out
}

function source(pack: Uint8Array): PackSource {
  return { fetchRange: async (_r, start, end) => pack.slice(start, end), sizeOf: () => pack.length }
}

describe('scanCommits', () => {
  it('finds every commit after an entry, at the index’s own addresses, and stops at the first blob', () => {
    const { pack, oids, rows } = history(40, { deltaAt: 20 })
    const first = rows[0] as IndexedObject
    const found = scanCommits(pack, 0, first.offset + first.length, 0).found
    expect(found.map((c) => c.oid)).toEqual(oids.slice(0, 39).reverse())
    for (const c of found) {
      const row = rows.find((r) => r.oidHex === c.oid) as IndexedObject
      expect(c.entry).toMatchObject({ packRef: 0, offset: row.offset, length: row.length, deltaDepth: row.deltaDepth })
    }
  })

  it('stops where the block cuts an entry short, and says where', () => {
    const { pack, rows } = history(10)
    const third = rows[3] as IndexedObject
    const run = scanCommits(pack.subarray(0, third.offset + 5), 0, (rows[0] as IndexedObject).offset, 0)
    expect(run.found).toHaveLength(3)
    expect(run.cutAt).toBe(third.offset)
    // A run that ends at a blob was not cut: nothing to go on with.
    expect(scanCommits(pack, 0, (rows[0] as IndexedObject).offset, 0).cutAt).toBeNull()
  })

  // QW4-003: dash stores runs of commits as deltas of commits written before them, often of one
  // before the entry the scan starts at; each was an index query of its own.
  it('decodes a delta whose base was written before the scan starts', () => {
    const { pack, oids, rows } = history(10, { deltaAt: [4] })
    // Rows are written newest first: row 5 is commit 4, a delta of row 4 (commit 5).
    const delta = rows[5] as IndexedObject
    expect(delta.deltaDepth).toBe(1)
    const found = scanCommits(pack, 0, delta.offset, 0).found
    expect(found.find((c) => c.oid === oids[4])).toMatchObject({ entry: { offset: delta.offset, length: delta.length, deltaDepth: 1 } })
    // Its base is learned too, where the index has it, and the run goes on after the delta.
    expect(found.find((c) => c.oid === oids[5])?.entry.offset).toBe((rows[4] as IndexedObject).offset)
    expect(found.map((c) => c.oid).sort()).toEqual(oids.slice(0, 6).sort())
  })

  it('follows a chain of deltas back to its whole commit', () => {
    const { pack, oids, rows } = history(12, { deltaAt: [3, 4, 5, 6] })
    // Commit 3 is a delta of 4, of 5, of 6, of 7 (whole): start the scan at commit 3.
    const found = scanCommits(pack, 0, (rows[8] as IndexedObject).offset, 0).found
    expect(found.find((c) => c.entry.offset === (rows[8] as IndexedObject).offset)?.oid).toBe(oids[3])
  })

  it('decodes a delta whose base is in a block held before this one', () => {
    const { pack, oids, rows } = history(10, { deltaAt: [4] })
    const delta = rows[5] as IndexedObject
    // The base (row 4) sits in the window before; the scan reads the window from the delta on.
    const split = delta.offset
    const before = { start: 0, bytes: pack.subarray(0, split) }
    const found = scanCommits(pack.subarray(split), split, delta.offset, 0, (offset) => (offset < split ? before : undefined)).found
    expect(found.find((c) => c.entry.offset === delta.offset)?.oid).toBe(oids[4])
    // Without it the delta is stepped over and the run goes on after it.
    expect(scanCommits(pack.subarray(split), split, delta.offset, 0).found[0]?.oid).toBe(oids[3])
  })
})

describe('WalkIndex', () => {
  /** An index answering every lookup with nothing, counting lookups and whole reads. */
  function counting(): ObjectIndex & { lookups: number; preloads: number } {
    const inner = {
      lookups: 0,
      preloads: 0,
      count: 1,
      inMemory: false,
      lookup: async (): Promise<LocatorEntry | null> => {
        inner.lookups += 1
        return null
      },
      peek: () => undefined,
      findByPrefix: async () => [],
      atOffset: () => undefined,
      preload: async () => {
        inner.preloads += 1
      },
    }
    return inner
  }

  // QW4-003/QW4-004: a merge-base search or an unindexed column walk asked a dash-sized index 130-170
  // times, one query after the other, then read it whole anyway.
  it(`has the index read whole once a walk has asked it ${WALK_LOOKUPS_BEFORE_WHOLE} times`, async () => {
    const inner = counting()
    const walk = new WalkIndex(inner)
    const oid = new Uint8Array(20)
    for (let i = 1; i < WALK_LOOKUPS_BEFORE_WHOLE; i++) await walk.lookup(oid)
    expect(inner.preloads).toBe(0)
    await walk.lookup(oid)
    expect(inner.preloads).toBe(1)
    for (let i = 0; i < 10; i++) await walk.lookup(oid)
    expect(inner.preloads).toBe(1)
  })

  it('waits for a scan on its way for a commit, rather than ask the index; not for anything else', async () => {
    const inner = counting()
    const walk = new WalkIndex(inner)
    const oid = new Uint8Array(20).fill(7)
    const entry: LocatorEntry = { packRef: 0, offset: 12, length: 100, deltaChainSpan: 100, deltaDepth: 0 }
    let land: () => void = () => undefined
    walk.learning(new Promise<void>((resolve) => (land = resolve)).then(() => walk.learn([{ oid: '07'.repeat(20), entry }])))
    // A tree or a blob is never in a commit run: asked at once.
    expect(await walk.lookup(new Uint8Array(20).fill(9))).toBeNull()
    expect(inner.lookups).toBe(1)
    const asked = walk.lookupCommit(oid)
    land()
    expect(await asked).toEqual(entry)
    expect(inner.lookups).toBe(1)
  })
})

describe('a history walk over an index read a slice at a time', () => {
  it('reads one index slice for a page of history, not one per commit', async () => {
    const N = 60
    const { pack, oids, rows } = history(N, { deltaAt: 30 })
    const bytes = serializeLocator(rows)
    let slices = 0
    const index = RangedLocator.open(bytes.slice(0, FANOUT_LEN), {
      sizeBytes: bytes.length,
      readRange: async (start, end) => {
        slices += 1
        return bytes.slice(start, end)
      },
      loadWhole: async () => bytes,
    }) as RangedLocator
    const reader = new BrowseReader(new FragmentedIndex([index]), source(pack))
    const walker = reader.forHistoryWalk()
    let oid: string | undefined = oids[N - 1]
    const seen: string[] = []
    while (oid !== undefined) {
      const commit = await walker.readObject(oid)
      seen.push(oid)
      oid = /^parent ([0-9a-f]{40})$/m.exec(new TextDecoder().decode(commit.bytes))?.[1]
    }
    expect(seen).toEqual([...oids].reverse())
    expect(slices).toBe(1)
    // The same walk over the whole index reads the same objects.
    const whole = new BrowseReader(ObjectLocator.parse(bytes), source(pack)).forHistoryWalk()
    expect((await whole.readObject(oids[0] as string)).bytes).toEqual((await walker.readObject(oids[0] as string)).bytes)
  })
})

describe('a long history walk across read-ahead blocks (QW4-003)', () => {
  it('reads one index slice for thousands of commits running through several blocks', async () => {
    const N = 4000
    // Every 50th commit a delta of the one written before it, as a mirror's pack stores some.
    const { pack, oids, rows } = history(N, { deltaAt: Array.from({ length: N / 50 }, (_, i) => i * 50 + 7) })
    expect(pack.length).toBeGreaterThan(2 * READ_AHEAD_BLOCK)
    const bytes = serializeLocator(rows)
    let slices = 0
    const index = RangedLocator.open(bytes.slice(0, FANOUT_LEN), {
      sizeBytes: bytes.length,
      granule: 36 * 64,
      readRange: async (start, end) => {
        slices += 1
        return bytes.slice(start, end)
      },
      loadWhole: async () => bytes,
    }) as RangedLocator
    const walker = new BrowseReader(new FragmentedIndex([index]), source(pack)).forHistoryWalk()
    let oid: string | undefined = oids[N - 1]
    let walked = 0
    let tipSlices = 0
    while (oid !== undefined) {
      const commit = await walker.readObject(oid)
      walked += 1
      if (walked === 1) tipSlices = slices
      oid = /^parent ([0-9a-f]{40})$/m.exec(new TextDecoder().decode(commit.bytes))?.[1]
    }
    expect(walked).toBe(N)
    // The tip's rows (a granule or two, one query); then every commit is learned from the runs,
    // across block edges too (was a slice or two at each edge, and one per delta whose base was
    // written before its run's start).
    expect(tipSlices).toBeLessThanOrEqual(2)
    expect(slices).toBe(tipSlices)
  })
})
