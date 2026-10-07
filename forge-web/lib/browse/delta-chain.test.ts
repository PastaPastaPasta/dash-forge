/**
 * Delta chains a pack's publisher controls: a cycle (a delta whose base is, at some remove, the
 * delta itself) and a chain past git's depth limit fail the read at once, on every read path,
 * rather than recursing until the tab gives out.
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { serializeLocator, memoryPackSource, type IndexedObject } from './indexer'
import { ObjectLocator } from './locator'
import { BuildBudget, BuildBudgetError, ObjectTooLargeError, applyDelta, buildMaxBytes, gitOidHex, parseOfsBase, reconstructFromSpan } from './pack'
import { T_BLOB, T_OFS_DELTA, T_REF_DELTA, concat, copyInsertDelta, deltaSize, hexToBytes, objHeader, ofsBase } from './pack-fixtures'
import { BrowseReader, PACK_COPIES_TRIED, type PackSource } from './reader'

const PACK_HEADER_LEN = 12
/** git's ceiling on `pack.depth`, written out so this file stands on its own. */
const DELTA_DEPTH_MAX = 4095
const DELTA = copyInsertDelta(4, 5, 4, new Uint8Array([0x21]))

/** A pack body (no trailer is needed by a reader) of `stored` entries after a 12-byte header. */
function packOf(stored: readonly Uint8Array[]): { pack: Uint8Array; offsets: number[] } {
  const offsets: number[] = []
  let at = PACK_HEADER_LEN
  for (const s of stored) {
    offsets.push(at)
    at += s.length
  }
  return { pack: concat(new Uint8Array(PACK_HEADER_LEN), ...stored), offsets }
}

const refDelta = (baseOid: string): Uint8Array => concat(objHeader(T_REF_DELTA, DELTA.length), hexToBytes(baseOid), zlibSync(DELTA))

/** A reader over `pack` whose locator says each `oid` is at the matching entry; `fetched` counts its pack reads. */
function readerOf(pack: Uint8Array, rows: readonly { oid: string; offset: number; length: number }[], copies = 1, fetched = { n: 0 }): BrowseReader {
  const objects: IndexedObject[] = rows.map((r) => ({ oidHex: r.oid, packRef: 0, offset: r.offset, length: r.length, deltaDepth: 1 }))
  const inner = memoryPackSource([pack])
  const counted: PackSource = {
    ...inner,
    fetchRange: (packRef, start, end, copy) => {
      fetched.n += 1
      return inner.fetchRange(packRef, start, end, copy)
    },
  }
  const source: PackSource = copies === 1 ? counted : { ...counted, copyCount: () => copies }
  return new BrowseReader(ObjectLocator.parse(serializeLocator(objects)), source)
}

/** A delta onto a `baseLen` base: copy its first `copyLen` bytes (3 size bytes), then insert `tail`. */
function copyThenInsert(baseLen: number, copyLen: number, tail: readonly number[]): Uint8Array {
  return new Uint8Array([
    ...deltaSize(baseLen),
    ...deltaSize(copyLen + tail.length),
    0x80 | 0x10 | 0x20 | 0x40, // copy from offset 0, three size bytes
    copyLen & 0xff,
    (copyLen >> 8) & 0xff,
    (copyLen >> 16) & 0xff,
    tail.length,
    ...tail,
  ])
}

const X = 'ab'.repeat(20)
const Y = 'cd'.repeat(20)

describe('delta cycles', () => {
  it('fails a REF delta whose base is itself', async () => {
    const stored = refDelta(X)
    const { pack, offsets } = packOf([stored])
    const reader = readerOf(pack, [{ oid: X, offset: offsets[0] as number, length: stored.length }])
    await expect(reader.readObject(X)).rejects.toThrow(/loops back/)
  }, 5_000)

  it('fails two REF deltas that are each other’s base', async () => {
    const a = refDelta(Y)
    const b = refDelta(X)
    const { pack, offsets } = packOf([a, b])
    const reader = readerOf(pack, [
      { oid: X, offset: offsets[0] as number, length: a.length },
      { oid: Y, offset: offsets[1] as number, length: b.length },
    ])
    await expect(reader.readObject(X)).rejects.toThrow(/loops back/)
    await expect(reader.readObject(Y)).rejects.toThrow(/loops back/)
  }, 5_000)

  it('fails a REF cycle on the path that tries another copy of the pack', async () => {
    const stored = refDelta(X)
    const { pack, offsets } = packOf([stored])
    const reader = readerOf(pack, [{ oid: X, offset: offsets[0] as number, length: stored.length }], 2)
    await expect(reader.readObject(X)).rejects.toThrow(/loops back/)
  }, 5_000)

  it.each([
    ['whose root does not hash to its oid', false],
    ['whose bottom delta does not decode', true],
  ])('reads a REF chain %s, on every copy, in a bounded number of fetches', async (_name, broken) => {
    // A REF chain 40 deep that fails on all 3 copies of its pack. Each copy tried used to walk the
    // whole chain below it again, through every copy: 3^depth reads.
    const depth = 40
    const oid = (k: number): string => k.toString(16).padStart(40, '0')
    const delta = copyInsertDelta(4, 4, 4, new Uint8Array(0))
    const stored = [concat(objHeader(T_BLOB, 4), zlibSync(new Uint8Array([1, 2, 3, 4])))]
    for (let k = 1; k <= depth; k++) {
      // A header declaring one byte more than the stream holds does not decode.
      const declared = broken && k === 1 ? delta.length + 1 : delta.length
      stored.push(concat(objHeader(T_REF_DELTA, declared), hexToBytes(oid(k - 1)), zlibSync(delta)))
    }
    const { pack, offsets } = packOf(stored)
    const rows = stored.map((s, k) => ({ oid: oid(k), offset: offsets[k] as number, length: s.length }))
    const fetched = { n: 0 }
    await expect(readerOf(pack, rows, 3, fetched).readObject(oid(depth))).rejects.toThrow()
    // One read of each entry from each copy, at most.
    expect(fetched.n).toBeLessThanOrEqual(3 * (depth + 1))
  }, 10_000)

  it('refuses an OFS distance of 0 (the delta itself) in a span read', () => {
    const stored = concat(objHeader(T_OFS_DELTA, DELTA.length), new Uint8Array([0]), zlibSync(DELTA))
    const loc = { offset: PACK_HEADER_LEN, length: stored.length, deltaChainSpan: stored.length }
    expect(() => reconstructFromSpan(loc, stored)).toThrow(/names the delta itself/)
  })

  it('refuses an OFS distance too long to be a pack offset, rather than wrapping it', () => {
    const varint = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])
    expect(() => parseOfsBase(varint, 0)).toThrow(/out of range/)
  })
})

/**
 * A blob `a`, then `deltas` OFS deltas each adding a byte to the object before it: every object
 * differs, and the last is `deltas` deep.
 */
function chain(deltas: number): { pack: Uint8Array; rows: { oid: string; offset: number; length: number }[]; top: string } {
  let prev = new Uint8Array([0x61])
  const stored: Uint8Array[] = [concat(objHeader(T_BLOB, 1), zlibSync(prev))]
  const contents = [prev]
  for (let k = 0; k < deltas; k++) {
    const delta = copyInsertDelta(prev.length, prev.length + 1, prev.length, new Uint8Array([0x62]))
    stored.push(concat(objHeader(T_OFS_DELTA, delta.length), ofsBase((stored[k] as Uint8Array).length), zlibSync(delta)))
    const next = new Uint8Array(prev.length + 1)
    next.set(prev)
    next[prev.length] = 0x62
    contents.push(next)
    prev = next
  }
  const { pack, offsets } = packOf(stored)
  const rows = contents.map((c, i) => ({ oid: gitOidHex('blob', c), offset: offsets[i] as number, length: (stored[i] as Uint8Array).length }))
  return { pack, rows, top: (rows[rows.length - 1] as { oid: string }).oid }
}

describe('delta depth', () => {
  it('reads a chain as deep as git allows, and refuses a deeper one', async () => {
    const ok = chain(DELTA_DEPTH_MAX)
    const obj = await readerOf(ok.pack, ok.rows).readObject(ok.top)
    expect(obj.bytes.length).toBe(DELTA_DEPTH_MAX + 1)
    const deep = chain(DELTA_DEPTH_MAX + 1)
    await expect(readerOf(deep.pack, deep.rows).readObject(deep.top)).rejects.toThrow(/over 4095 deep/)
  }, 30_000)

  it('fails a read whose chain builds more than its budget, though every step is small', async () => {
    // 2,100 deltas each rebuilding a 128 KiB object: ~263 MiB built in all, past the 256 MiB a
    // read under a 256 KiB limit may build. Only the top object's oid is real (only it is checked).
    const size = 128 * 1024
    const first = new Uint8Array(size).map((_, i) => i % 251)
    const stored = [concat(objHeader(T_BLOB, size), zlibSync(first))]
    const steps = 2_100
    for (let k = 1; k <= steps; k++) {
      const delta = copyThenInsert(size, size - 2, [k & 0xff, k >> 8])
      stored.push(concat(objHeader(T_OFS_DELTA, delta.length), ofsBase((stored[k - 1] as Uint8Array).length), zlibSync(delta)))
    }
    const top = first.slice()
    top[size - 2] = steps & 0xff
    top[size - 1] = steps >> 8
    const { pack, offsets } = packOf(stored)
    const rows = stored.map((s, k) => ({ oid: k === steps ? gitOidHex('blob', top) : (k + 1).toString(16).padStart(40, '0'), offset: offsets[k] as number, length: s.length }))
    const maxBytes = 256 * 1024
    expect(buildMaxBytes(maxBytes)).toBe(256 * 1024 * 1024)
    expect((steps + 1) * size).toBeGreaterThan(buildMaxBytes(maxBytes))
    await expect(readerOf(pack, rows).readObject(gitOidHex('blob', top), { maxBytes })).rejects.toThrow(ObjectTooLargeError)
    // The same chain cut to fit reads.
    const short = stored.slice(0, 101)
    const fits = packOf(short)
    const shortTop = first.slice()
    shortTop[size - 2] = 100
    shortTop[size - 1] = 0
    const shortRows = short.map((s, k) => ({ oid: k === 100 ? gitOidHex('blob', shortTop) : (k + 1).toString(16).padStart(40, '0'), offset: fits.offsets[k] as number, length: s.length }))
    expect((await readerOf(fits.pack, shortRows).readObject(gitOidHex('blob', shortTop), { maxBytes })).bytes).toEqual(shortTop)
  }, 60_000)

  it('fails a span read whose chain builds more than its budget', () => {
    const deep = chain(50)
    const top = deep.rows[deep.rows.length - 1] as { offset: number; length: number }
    const span = top.offset + top.length - PACK_HEADER_LEN
    const loc = { offset: top.offset, length: top.length, deltaChainSpan: span }
    // 1 + 2 + … + 51 bytes are built in all.
    expect(() => reconstructFromSpan(loc, deep.pack.subarray(PACK_HEADER_LEN), Infinity, Infinity, new BuildBudget(1_000))).toThrow(ObjectTooLargeError)
    expect(reconstructFromSpan(loc, deep.pack.subarray(PACK_HEADER_LEN), Infinity, Infinity, new BuildBudget(2_000)).bytes.length).toBe(51)
  })

  it('caps what a read with no limit of its own may build at 2 GiB', () => {
    expect(buildMaxBytes(Infinity)).toBe(2 * 1024 * 1024 * 1024)
  })

  it('charges a step to the budget before building it', () => {
    // 16 copies of a 64 KiB base: a 1 MiB result from a 100-byte delta.
    const base = new Uint8Array(64 * 1024)
    const delta = new Uint8Array([...deltaSize(base.length), ...deltaSize(16 * base.length), ...Array<number>(16).fill(0x80)])
    const budget = new BuildBudget(1024 * 1024 - 1)
    expect(() => applyDelta(base, delta, Infinity, budget)).toThrow(BuildBudgetError)
    // Refused, it was not counted: what is left still builds a smaller step.
    expect(applyDelta(base, new Uint8Array([...deltaSize(base.length), ...deltaSize(base.length), 0x80]), Infinity, budget).length).toBe(base.length)
    expect(applyDelta(base, delta, Infinity, new BuildBudget(1024 * 1024)).length).toBe(1024 * 1024)
  })

  it('refuses a chain deeper than git allows in a span read', () => {
    const deep = chain(DELTA_DEPTH_MAX + 1)
    const top = deep.rows[deep.rows.length - 1] as { offset: number; length: number }
    const span = top.offset + top.length - PACK_HEADER_LEN
    const loc = { offset: top.offset, length: top.length, deltaChainSpan: span }
    expect(() => reconstructFromSpan(loc, deep.pack.subarray(PACK_HEADER_LEN))).toThrow(/over 4095 deep/)
  })
})

/** `entry` followed by zeros up to `length` bytes: a reader stops at the end of its zlib stream. */
function padded(entry: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(entry)
  return out
}

/**
 * A reader over packs given as one byte array per copy (`packs[packRef][copy]`), whose locator
 * says each `oid` is at the matching entry. `copiesRead` collects the copies fetched from.
 */
function copiesReaderOf(
  packs: readonly (readonly Uint8Array[])[],
  rows: readonly { oid: string; packRef: number; offset: number; length: number }[],
  copiesRead = new Set<string>(),
  opts: ConstructorParameters<typeof BrowseReader>[2] = {},
): BrowseReader {
  const objects: IndexedObject[] = rows.map((r) => ({ oidHex: r.oid, packRef: r.packRef, offset: r.offset, length: r.length, deltaDepth: 1 }))
  const source: PackSource = {
    fetchRange: (packRef, start, end, copy) => {
      copiesRead.add(`${packRef}:${copy ?? 0}`)
      const pack = packs[packRef]?.[copy ?? 0]
      if (pack === undefined || end > pack.length) return Promise.reject(new Error(`no pack ${packRef} copy ${copy}`))
      return Promise.resolve(pack.subarray(start, end))
    },
    copyCount: (packRef) => packs[packRef]?.length ?? 1,
  }
  return new BrowseReader(ObjectLocator.parse(serializeLocator(objects)), source, opts)
}

describe('pack copies', () => {
  it('reads the honest copy after a hostile one built nearly all of a read’s budget', async () => {
    // Copy 0 holds a chain of 2,047 entries of 128 KiB each at the object's address: 2,047 x 128
    // KiB is 128 KiB short of the 256 MiB a read under 256 KiB may build, and it does not hash to
    // the object. Copy 1 holds the object itself (200 KiB), which must still read.
    const size = 128 * 1024
    const first = new Uint8Array(size).map((_, i) => i % 251)
    const junk = [concat(objHeader(T_BLOB, size), zlibSync(first))]
    for (let k = 1; k < 2_047; k++) {
      const delta = copyThenInsert(size, size - 2, [k & 0xff, k >> 8])
      junk.push(concat(objHeader(T_OFS_DELTA, delta.length), ofsBase((junk[k - 1] as Uint8Array).length), zlibSync(delta)))
    }
    const honest = new Uint8Array(200 * 1024).map((_, i) => i % 13)
    const honestEntry = concat(objHeader(T_BLOB, honest.length), zlibSync(honest))
    const hostileTop = junk.pop() as Uint8Array
    const length = Math.max(hostileTop.length, honestEntry.length)
    const below = packOf(junk).pack
    const top = below.length
    const copies = [concat(below, padded(hostileTop, length)), concat(below, padded(honestEntry, length))]
    const { offsets } = packOf(junk)
    const rows = [
      ...junk.map((s, k) => ({ oid: (k + 1).toString(16).padStart(40, '0'), packRef: 0, offset: offsets[k] as number, length: s.length })),
      { oid: gitOidHex('blob', honest), packRef: 0, offset: top, length },
    ]
    const maxBytes = 256 * 1024
    expect(2_047 * size + honest.length).toBeGreaterThan(buildMaxBytes(maxBytes))
    const obj = await copiesReaderOf([copies], rows).readObject(gitOidHex('blob', honest), { maxBytes })
    expect(obj.bytes).toEqual(honest)
  }, 60_000)

  it('reads the honest copy after a hostile one failed a shared REF base on its depth', async () => {
    // Pack 1 (one copy) holds Z. Copy 0 of pack 0 reaches Z under 4,096 deltas, past the depth a
    // read follows; copy 1 is one delta on Z. Z failing deep in copy 0 says nothing about Z.
    const z = new Uint8Array([1, 2, 3, 4])
    const zEntry = concat(objHeader(T_BLOB, z.length), zlibSync(z))
    const zPack = packOf([zEntry])
    const deep = [refDelta(gitOidHex('blob', z))]
    for (let k = 1; k <= DELTA_DEPTH_MAX; k++) {
      deep.push(concat(objHeader(T_OFS_DELTA, DELTA.length), ofsBase((deep[k - 1] as Uint8Array).length), zlibSync(DELTA)))
    }
    const want = new Uint8Array([1, 2, 3, 4, 0x21])
    const honestTop = refDelta(gitOidHex('blob', z))
    const hostileTop = deep.pop() as Uint8Array
    const length = Math.max(hostileTop.length, honestTop.length)
    const below = packOf(deep)
    const top = below.pack.length
    const copies = [concat(below.pack, padded(hostileTop, length)), concat(below.pack, padded(honestTop, length))]
    const rows = [
      { oid: gitOidHex('blob', z), packRef: 1, offset: zPack.offsets[0] as number, length: zEntry.length },
      ...deep.map((s, k) => ({ oid: (k + 1).toString(16).padStart(40, '0'), packRef: 0, offset: below.offsets[k] as number, length: s.length })),
      { oid: gitOidHex('blob', want), packRef: 0, offset: top, length },
    ]
    const obj = await copiesReaderOf([copies, [zPack.pack]], rows).readObject(gitOidHex('blob', want))
    expect(obj.bytes).toEqual(want)
  }, 30_000)

  it('tries a bounded number of a pack’s copies', async () => {
    const real = new Uint8Array([1, 2, 3])
    const entry = concat(objHeader(T_BLOB, 3), zlibSync(new Uint8Array([9, 9, 9])))
    const { pack, offsets } = packOf([entry])
    const read = new Set<string>()
    const reader = copiesReaderOf([Array.from({ length: 12 }, () => pack)], [{ oid: gitOidHex('blob', real), packRef: 0, offset: offsets[0] as number, length: entry.length }], read)
    await expect(reader.readObject(gitOidHex('blob', real))).rejects.toThrow(/oid mismatch/)
    expect(read.size).toBe(PACK_COPIES_TRIED)
  })

  it('does not let a stale reader’s failed entries fail the fresher reader it asks', async () => {
    // The stale reader's copy 0 holds a broken entry at the address where the fresher reader's
    // pack 0 holds X; its copy 1 is a delta on X, which only the fresher reader indexes.
    const x = new Uint8Array([1, 2, 3, 4])
    const xEntry = concat(objHeader(T_BLOB, x.length), zlibSync(x))
    const want = new Uint8Array([1, 2, 3, 4, 0x21])
    const good = refDelta(gitOidHex('blob', x))
    const length = Math.max(good.length, xEntry.length)
    const broken = padded(concat(objHeader(T_BLOB, 4), new Uint8Array([0x78, 0x9c, 0xff, 0xff])), length)
    const stale = [packOf([broken]).pack, packOf([padded(good, length)]).pack]
    const fresh = copiesReaderOf([[packOf([padded(xEntry, length)]).pack]], [{ oid: gitOidHex('blob', x), packRef: 0, offset: PACK_HEADER_LEN, length }])
    const reader = copiesReaderOf([stale], [{ oid: gitOidHex('blob', want), packRef: 0, offset: PACK_HEADER_LEN, length }], new Set(), {
      onMiss: () => Promise.resolve(fresh),
    })
    expect((await reader.readObject(gitOidHex('blob', want))).bytes).toEqual(want)
  })
})
