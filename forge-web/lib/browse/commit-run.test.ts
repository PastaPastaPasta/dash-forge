/**
 * QW3-001: a history walk over an index read a slice at a time learns the commits after each one
 * it reads from the read-ahead block it read it from, so a page of log costs one index slice, not
 * one per commit.
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { scanCommitRun } from './commit-run'
import { serializeLocator, type IndexedObject } from './indexer'
import { FANOUT_LEN, ObjectLocator } from './locator'
import { FragmentedIndex, RangedLocator } from './object-index'
import { PACK_TYPE, gitOidHex } from './pack'
import { T_BLOB, T_OFS_DELTA, concat, deltaSize, objHeader, ofsBase, packFrame } from './pack-fixtures'
import { BrowseReader, type PackSource } from './reader'

const enc = new TextEncoder()
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** `n` commits, each the parent of the next, written newest first (as `git pack-objects` does), then a blob. */
function history(n: number, { deltaAt }: { deltaAt?: number } = {}): { pack: Uint8Array; oids: string[]; rows: IndexedObject[] } {
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
    if (i === deltaAt && prev !== null) {
      // Copy nothing, insert all: a valid delta of the commit before it whose result is this one.
      const delta = new Uint8Array([...deltaSize(prev.text.length), ...deltaSize(text.length), ...chunkedInsert(text)])
      entry = concat(objHeader(T_OFS_DELTA, delta.length), ofsBase(at - prev.offset), zlibSync(delta))
    } else {
      entry = concat(objHeader(PACK_TYPE.COMMIT, text.length), zlibSync(text))
    }
    rows.push({ oidHex: oids[i] as string, packRef: 0, offset: at, length: entry.length, deltaDepth: i === deltaAt ? 1 : 0 })
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

describe('scanCommitRun', () => {
  it('finds every commit after an entry, at the index’s own addresses, and stops at the first blob', () => {
    const { pack, oids, rows } = history(40, { deltaAt: 20 })
    const first = rows[0] as IndexedObject
    const found = scanCommitRun(pack, 0, first.offset + first.length, 0)
    expect(found.map((c) => c.oid)).toEqual(oids.slice(0, 39).reverse())
    for (const c of found) {
      const row = rows.find((r) => r.oidHex === c.oid) as IndexedObject
      expect(c.entry).toMatchObject({ packRef: 0, offset: row.offset, length: row.length, deltaDepth: row.deltaDepth })
    }
  })

  it('stops where the block cuts an entry short', () => {
    const { pack, rows } = history(10)
    const third = rows[3] as IndexedObject
    const found = scanCommitRun(pack.subarray(0, third.offset + 5), 0, (rows[0] as IndexedObject).offset, 0)
    expect(found).toHaveLength(3)
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
