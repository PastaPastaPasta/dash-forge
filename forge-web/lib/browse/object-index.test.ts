/**
 * QW3-001: an object index read a granule at a time answers every lookup exactly as the whole,
 * merged locator does, reading only the rows around what it looks up; and the reader rebuilds
 * deep-delta objects over it without the whole index's offset map.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { serializeLocator, type IndexedObject } from './indexer'
import { FANOUT_LEN, LOCATOR_ROW_LEN, ObjectLocator, SPAN_SENTINEL } from './locator'
import { ESCALATE_FRACTION, FragmentedIndex, RangedLocator, indexOf, type RangedSource } from './object-index'
import { gitOidHex } from './pack'
import { BrowseReader, type PackSource } from './reader'
import { T_BLOB, T_OFS_DELTA, concat, copyInsertDelta, hexToBytes, objHeader, ofsBase, packFrame } from './pack-fixtures'

const oidOf = (n: number): string => bytesToHex(sha256(new TextEncoder().encode(`object ${n}`))).slice(0, 40)

function rows(n: number, packRef: number, from = 0): IndexedObject[] {
  return Array.from({ length: n }, (_, i) => ({ oidHex: oidOf(from + i), packRef, offset: 12 + (from + i) * 7, length: 7, deltaDepth: i % 3 }))
}

/** A ranged source over `bytes` in `granule`-byte reads, logging every range read and every whole load. */
function source(bytes: Uint8Array, granule?: number): RangedSource & { readonly reads: [number, number][]; wholeLoads: number } {
  const reads: [number, number][] = []
  const out = {
    sizeBytes: bytes.length,
    ...(granule !== undefined ? { granule } : {}),
    reads,
    wholeLoads: 0,
    readRange: async (start: number, end: number) => {
      reads.push([start, end])
      return bytes.slice(start, end)
    },
    loadWhole: async () => {
      out.wholeLoads += 1
      return bytes.slice()
    },
  }
  return out
}

function ranged(bytes: Uint8Array, granule?: number): { index: RangedLocator; src: ReturnType<typeof source> } {
  const src = source(bytes, granule)
  const index = RangedLocator.open(bytes.slice(0, FANOUT_LEN), src)
  if (index === null) throw new Error('fanout rejected')
  return { index, src }
}

/** A pseudo-random oid that is not in the index. */
const absent = (n: number): string => bytesToHex(sha256(new TextEncoder().encode(`absent ${n}`))).slice(0, 40)

describe('RangedLocator', () => {
  // dash's shape, scaled: ~1,000 rows a fanout slice, read in granules of a tenth of a slice.
  const ROWS = 256 * 1000
  const GRANULE = 3600
  const bytes = serializeLocator(rows(ROWS, 0))
  const whole = ObjectLocator.parse(bytes)
  const SLICE_GRANULES = Math.ceil((1000 * LOCATOR_ROW_LEN) / GRANULE)

  it('answers every lookup and prefix as the whole locator does', async () => {
    const { index } = ranged(bytes, GRANULE)
    expect(index.count).toBe(ROWS)
    for (let i = 0; i < 300; i++) {
      for (const hex of [oidOf(i * 853), absent(i)]) {
        expect(await index.lookup(hexToBytes(hex))).toEqual(whole.lookup(hexToBytes(hex)))
        const prefix = hex.slice(0, 2 + (i % 7))
        expect(await index.findByPrefix(prefix, 1 + (i % 4))).toEqual(whole.findByPrefix(prefix, 1 + (i % 4)))
      }
    }
    // A lookup at a slice's very ends.
    for (const hex of ['00'.repeat(20), 'ff'.repeat(20), `ab${'00'.repeat(19)}`, `ab${'ff'.repeat(19)}`]) {
      expect(await index.lookup(hexToBytes(hex))).toEqual(whole.lookup(hexToBytes(hex)))
    }
  })

  it('reads the granules around a lookup, not its whole fanout slice', async () => {
    const LOOKUPS = 100
    let granules = 0
    for (let i = 0; i < LOOKUPS; i++) {
      const { index, src } = ranged(bytes, GRANULE)
      expect(await index.lookup(hexToBytes(oidOf(i * 2_011)))).not.toBeNull()
      for (const [start, end] of src.reads) {
        expect(start % GRANULE).toBe(0)
        expect(end - start).toBeLessThanOrEqual(GRANULE)
      }
      granules += src.reads.length
    }
    // About one granule each, two near a boundary, never the 10 or 11 of a slice.
    expect(granules / LOOKUPS).toBeLessThan(2.5)
    expect(SLICE_GRANULES).toBeGreaterThanOrEqual(10)
  })

  it('reads a granule once, and peeks only at granules it holds', async () => {
    const { index, src } = ranged(bytes, GRANULE)
    const oid = hexToBytes(oidOf(5))
    expect(index.peek(oid)).toBeUndefined()
    await Promise.all([index.lookup(oid), index.lookup(oid), index.findByPrefix(oidOf(5).slice(0, 8), 2)])
    const reads = src.reads.length
    expect(reads).toBeLessThanOrEqual(2)
    expect(index.peek(oid)).toEqual(whole.lookup(oid))
    await index.lookup(oid)
    expect(src.reads.length).toBe(reads)
  })

  it(`reads the whole fragment once its granules reach ${ESCALATE_FRACTION * 100}% of it, then answers from memory`, async () => {
    const { index, src } = ranged(bytes, GRANULE)
    for (let b = 0; b < 256 && src.wholeLoads === 0; b++) await index.findByPrefix(b.toString(16).padStart(2, '0'), 1)
    expect(src.wholeLoads).toBe(1)
    const read = src.reads.reduce((n, [s, e]) => n + e - s, 0)
    expect(read).toBeGreaterThanOrEqual(ROWS * LOCATOR_ROW_LEN * ESCALATE_FRACTION)
    expect(read).toBeLessThan(ROWS * LOCATOR_ROW_LEN * ESCALATE_FRACTION + 2 * SLICE_GRANULES * GRANULE)
    await index.loadWhole()
    const reads = src.reads.length
    for (let n = 0; n < ROWS; n += 9_973) expect(await index.lookup(hexToBytes(oidOf(n)))).toEqual(whole.lookup(hexToBytes(oidOf(n))))
    expect(src.reads.length).toBe(reads)
    expect(index.wholeLocator).not.toBeNull()
  })

  it('answers from the whole, verified fragment when the rows read are malformed', async () => {
    const bad = bytes.slice()
    // Swap the row of the object looked up with the next: still whole rows, but out of order.
    const target = oidOf(1)
    let at = FANOUT_LEN
    while (bytesToHex(bad.subarray(at, at + 20)) !== target) at += LOCATOR_ROW_LEN
    const row = bad.slice(at, at + LOCATOR_ROW_LEN)
    bad.copyWithin(at, at + LOCATOR_ROW_LEN, at + 2 * LOCATOR_ROW_LEN)
    bad.set(row, at + LOCATOR_ROW_LEN)
    const src = source(bad, GRANULE)
    // The whole is the honest artifact (it is what `loadWhole` hash-checks).
    src.loadWhole = async () => {
      src.wholeLoads += 1
      return bytes.slice()
    }
    const index = RangedLocator.open(bad.slice(0, FANOUT_LEN), src) as RangedLocator
    expect(await index.lookup(hexToBytes(target))).toEqual(whole.lookup(hexToBytes(target)))
    expect(src.wholeLoads).toBe(1)
  })

  it('does not let a fanout that cuts a slice short hide the rows it leaves out', async () => {
    // A fanout that still adds up but starts slice `b` after the target's row: the row before the
    // slice's claimed start is then of slice `b` itself, which the edge check catches.
    const target = oidOf(7)
    const b = parseInt(target.slice(0, 2), 16)
    let row = 0
    while (bytesToHex(bytes.subarray(FANOUT_LEN + row * LOCATOR_ROW_LEN, FANOUT_LEN + row * LOCATOR_ROW_LEN + 20)) !== target) row++
    const bad = bytes.slice()
    new DataView(bad.buffer).setUint32((b - 1) * 4, row + 1)
    const src = source(bad, GRANULE)
    src.loadWhole = async () => {
      src.wholeLoads += 1
      return bytes.slice()
    }
    const index = RangedLocator.open(bad.slice(0, FANOUT_LEN), src) as RangedLocator
    expect(await index.lookup(hexToBytes(target))).toEqual(whole.lookup(hexToBytes(target)))
    expect(src.wholeLoads).toBe(1)
  })

  it('answers from the whole fragment when a range cannot be read, and does not retry a failed whole on every lookup', async () => {
    const src = source(bytes, GRANULE)
    src.readRange = async () => {
      throw new Error('chunk missing')
    }
    const index = RangedLocator.open(bytes.slice(0, FANOUT_LEN), src) as RangedLocator
    expect(await index.lookup(hexToBytes(oidOf(3)))).toEqual(whole.lookup(hexToBytes(oidOf(3))))
    expect(src.wholeLoads).toBe(1)

    const failing = source(bytes, GRANULE)
    failing.readRange = async () => {
      throw new Error('chunk missing')
    }
    failing.loadWhole = async () => {
      failing.wholeLoads += 1
      throw new Error('offline')
    }
    const stuck = RangedLocator.open(bytes.slice(0, FANOUT_LEN), failing) as RangedLocator
    await expect(stuck.lookup(hexToBytes(oidOf(3)))).rejects.toThrow('offline')
    await expect(stuck.lookup(hexToBytes(oidOf(4)))).rejects.toThrow('chunk missing')
    expect(failing.wholeLoads).toBe(1)
  })

  it('refuses a fanout that does not describe the fragment', () => {
    expect(RangedLocator.open(bytes.slice(0, FANOUT_LEN), { ...source(bytes), sizeBytes: bytes.length + LOCATOR_ROW_LEN })).toBeNull()
    const falling = bytes.slice(0, FANOUT_LEN)
    new DataView(falling.buffer).setUint32(4, 0)
    new DataView(falling.buffer).setUint32(0, 5)
    expect(RangedLocator.open(falling, source(bytes))).toBeNull()
  })
})

describe('FragmentedIndex', () => {
  // The same object in two packs: a push re-sent what an earlier pack holds.
  const a = serializeLocator([...rows(600, 0), ...rows(10, 1, 1000)])
  const b = serializeLocator([...rows(300, 1, 1000), ...rows(5, 1, 0)])
  const merged = ObjectLocator.merge([ObjectLocator.parse(a), ObjectLocator.parse(b)])

  it('answers as the merge of its parts, whole or ranged: the lowest packRef of any', async () => {
    const index = new FragmentedIndex([ObjectLocator.parse(a), ranged(b).index])
    // Rows, summed: the ten rows both parts hold for the same pack count twice (the merge keeps one).
    expect(index.count).toBe(merged.count + 10)
    for (const n of [0, 3, 4, 7, 599, 1000, 1005, 1299]) {
      const oid = hexToBytes(oidOf(n))
      expect(await index.lookup(oid)).toEqual(merged.lookup(oid))
      expect(await index.findByPrefix(oidOf(n).slice(0, 4), 4)).toEqual(merged.findByPrefix(oidOf(n).slice(0, 4), 4))
    }
  })

  it('knows an address only from parts held whole', async () => {
    const r = ranged(b)
    const index = new FragmentedIndex([ObjectLocator.parse(a), r.index])
    const inA = merged.lookup(hexToBytes(oidOf(3)))
    expect(inA).not.toBeNull()
    // In the whole part: found by its address.
    expect(index.atOffset(0, 12 + 3 * 7)).toMatchObject({ packRef: 0, offset: 12 + 3 * 7 })
    // Not in the whole part, and a ranged part might hold it: unknown.
    expect(index.atOffset(1, 12 + 1200 * 7)).toBeUndefined()
    await index.preload()
    expect(r.src.wholeLoads).toBe(1)
    expect(index.atOffset(1, 12 + 1200 * 7)).toMatchObject({ packRef: 1 })
    expect(index.atOffset(1, 5)).toBeNull()
  })

  it('wraps a whole locator, and passes an index through', () => {
    const whole = ObjectLocator.parse(a)
    const wrapped = indexOf(whole)
    expect(wrapped.count).toBe(whole.count)
    expect(indexOf(wrapped)).toBe(wrapped)
  })
})

describe('BrowseReader over a ranged index', () => {
  /** A blob, a delta of it, and a delta of that (OFS each), with filler between, as git writes a chain. */
  function chain(): { pack: Uint8Array; index: Uint8Array; oids: string[]; texts: Uint8Array[] } {
    const enc = new TextEncoder()
    // The base: incompressible enough that its stored length is close to its size.
    const base = new Uint8Array(20_000)
    for (let i = 0; i < base.length; i++) base[i] = (i * 2654435761) >>> 24
    const t1 = concat(base.subarray(0, 19_000), enc.encode('first change\n'))
    const t2 = concat(t1.subarray(0, 18_000), enc.encode('second change\n'))
    const d1 = copyInsertDelta(base.length, t1.length, 19_000, enc.encode('first change\n'))
    const d2 = copyInsertDelta(t1.length, t2.length, 18_000, enc.encode('second change\n'))
    const filler = concat(objHeader(T_BLOB, 5000), zlibSync(new Uint8Array(5000).fill(7)))
    const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base))
    const o0 = 12
    const o1 = o0 + baseStored.length + filler.length
    const d1Stored = concat(objHeader(T_OFS_DELTA, d1.length), ofsBase(o1 - o0), zlibSync(d1))
    const o2 = o1 + d1Stored.length + filler.length
    const d2Stored = concat(objHeader(T_OFS_DELTA, d2.length), ofsBase(o2 - o1), zlibSync(d2))
    const pack = packFrame(baseStored, filler, d1Stored, filler, d2Stored)
    const oids = [base, t1, t2].map((t) => gitOidHex('blob', t))
    const stored = [
      [o0, baseStored.length, 0],
      [o1, d1Stored.length, 1],
      [o2, d2Stored.length, 2],
    ] as const
    const index = serializeLocator(stored.map(([offset, length, deltaDepth], i) => ({ oidHex: oids[i] as string, packRef: 0, offset, length, deltaDepth })))
    // Sentinel spans: the per-base walk, which resolves each OFS base by its address.
    for (let at = FANOUT_LEN; at < index.length; at += LOCATOR_ROW_LEN) new DataView(index.buffer).setUint32(at + 31, SPAN_SENTINEL)
    return { pack, index, oids, texts: [base, t1, t2] }
  }

  function counting(pack: Uint8Array): PackSource & { readonly ranges: [number, number][] } {
    const ranges: [number, number][] = []
    return {
      ranges,
      fetchRange: async (_ref, start, end) => {
        ranges.push([start, end])
        return pack.slice(start, end)
      },
      sizeOf: () => pack.length,
    }
  }

  it('rebuilds a two-deep OFS chain from each base’s own header, never reading past the delta that names it', async () => {
    const { pack, index, oids, texts } = chain()
    const src = counting(pack)
    const reader = new BrowseReader(new FragmentedIndex([ranged(index).index]), src)
    const obj = await reader.readObject(oids[2] as string)
    expect(Array.from(obj.bytes)).toEqual(Array.from(texts[2] as Uint8Array))
    // The same object through the whole index's offset map: identical.
    const viaWhole = await new BrowseReader(ObjectLocator.parse(index), counting(pack)).readObject(oids[2] as string)
    expect(Array.from(viaWhole.bytes)).toEqual(Array.from(obj.bytes))
    // No read reaches into the pack's trailer, and none spans more than the base plus its bound.
    for (const [, end] of src.ranges) expect(end).toBeLessThanOrEqual(pack.length - 20)
    expect(await reader.objectType(oids[2] as string)).toBe('blob')
  })

  it('reports a memoized object’s pack without reading the index again', async () => {
    const { pack, index, oids } = chain()
    const seen: number[] = []
    const r = ranged(index)
    const reader = new BrowseReader(new FragmentedIndex([r.index]), counting(pack), { onRead: (packRef) => seen.push(packRef) }).forView('page')
    await reader.readObject(oids[0] as string)
    const reads = r.src.reads.length
    await reader.readObject(oids[0] as string)
    expect(r.src.reads.length).toBe(reads)
    expect(seen).toEqual([0, 0])
  })
})
