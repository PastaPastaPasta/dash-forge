/**
 * Delta chains a pack's publisher controls: a cycle (a delta whose base is, at some remove, the
 * delta itself) and a chain past git's depth limit fail the read at once, on every read path,
 * rather than recursing until the tab gives out.
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { serializeLocator, memoryPackSource, type IndexedObject } from './indexer'
import { ObjectLocator } from './locator'
import { DELTA_DEPTH_MAX, gitOidHex, parseOfsBase, reconstructFromSpan } from './pack'
import { T_BLOB, T_OFS_DELTA, T_REF_DELTA, concat, copyInsertDelta, hexToBytes, objHeader, ofsBase } from './pack-fixtures'
import { BrowseReader, type PackSource } from './reader'

const PACK_HEADER_LEN = 12
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

/** A reader over `pack` whose locator says each `oid` is at the matching entry. */
function readerOf(pack: Uint8Array, rows: readonly { oid: string; offset: number; length: number }[], copies = 1): BrowseReader {
  const objects: IndexedObject[] = rows.map((r) => ({ oidHex: r.oid, packRef: 0, offset: r.offset, length: r.length, deltaDepth: 1 }))
  const inner = memoryPackSource([pack])
  const source: PackSource = copies === 1 ? inner : { ...inner, copyCount: () => copies }
  return new BrowseReader(ObjectLocator.parse(serializeLocator(objects)), source)
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

  it('refuses a chain deeper than git allows in a span read', () => {
    const deep = chain(DELTA_DEPTH_MAX + 1)
    const top = deep.rows[deep.rows.length - 1] as { offset: number; length: number }
    const span = top.offset + top.length - PACK_HEADER_LEN
    const loc = { offset: top.offset, length: top.length, deltaChainSpan: span }
    expect(() => reconstructFromSpan(loc, deep.pack.subarray(PACK_HEADER_LEN))).toThrow(/over 4095 deep/)
  })
})
