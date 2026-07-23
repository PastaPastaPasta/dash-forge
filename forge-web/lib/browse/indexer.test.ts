/**
 * Client-side pack indexer round-trip: build real framed packs (header + sha1 trailer) in
 * memory, scan + index them, serialize the synthesized locator, and prove the ordinary
 * `ObjectLocator.parse` → `BrowseReader` path reconstructs byte-identical objects — the
 * whole fallback-clone read plane, including a REF_DELTA whose base lives in a *different*
 * pack (the cross-pack fixpoint).
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { BrowseReader, ObjectLocator, gitOidHex } from './index'
import {
  indexPacks,
  inflateWithConsumed,
  memoryPackSource,
  scanPack,
  serializeLocator,
} from './indexer'
import {
  T_BLOB,
  T_OFS_DELTA,
  T_REF_DELTA,
  concat,
  copyInsertDelta,
  hexToBytes,
  objHeader,
  ofsBase,
  packFrame,
} from './pack-fixtures'

describe('inflateWithConsumed', () => {
  it('reports the exact compressed length with trailing bytes present', () => {
    const payload = new TextEncoder().encode('consumed-bytes probe '.repeat(20))
    const stream = zlibSync(payload)
    const buf = concat(new Uint8Array([0xee]), stream, new Uint8Array([1, 2, 3, 4]))
    const { data, consumed } = inflateWithConsumed(buf, 1)
    expect(consumed).toBe(stream.length)
    expect(Array.from(data)).toEqual(Array.from(payload))
  })

  it('throws on a truncated stream', () => {
    const stream = zlibSync(new TextEncoder().encode('truncate me '.repeat(50)))
    expect(() => inflateWithConsumed(stream.subarray(0, stream.length - 10), 0)).toThrow(/inflate failed/)
  })
})

describe('scanPack', () => {
  const base = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n')
  const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base))

  it('discovers offsets, lengths and type codes for base + OFS + REF objects', () => {
    const delta = copyInsertDelta(base.length, 44, 40, new TextEncoder().encode('cat\n'))
    const baseOffset = 12
    const deltaOffset = baseOffset + baseStored.length
    const ofsStored = concat(objHeader(T_OFS_DELTA, delta.length), ofsBase(deltaOffset - baseOffset), zlibSync(delta))
    const refStored = concat(
      objHeader(T_REF_DELTA, delta.length),
      hexToBytes(gitOidHex('blob', base)),
      zlibSync(delta),
    )
    const pack = packFrame(baseStored, ofsStored, refStored)

    const recs = scanPack(pack)
    expect(recs.map((r) => r.typeCode)).toEqual([T_BLOB, T_OFS_DELTA, T_REF_DELTA])
    expect(recs.map((r) => r.offset)).toEqual([
      baseOffset,
      deltaOffset,
      deltaOffset + ofsStored.length,
    ])
    expect(recs.map((r) => r.length)).toEqual([baseStored.length, ofsStored.length, refStored.length])
    expect(recs[1]?.ofsBaseOffset).toBe(baseOffset)
    expect(recs[2]?.refBaseOid).toBe(gitOidHex('blob', base))
  })

  it('rejects bad magic, a corrupted trailer, and a lying object count', () => {
    const good = packFrame(baseStored)
    const badMagic = good.slice()
    badMagic[0] = 0x51
    expect(() => scanPack(badMagic)).toThrow(/magic/)

    const badTrailer = good.slice()
    badTrailer[badTrailer.length - 1] = (badTrailer[badTrailer.length - 1] as number) ^ 0xff
    expect(() => scanPack(badTrailer)).toThrow(/trailer/)

    const badCount = good.slice()
    badCount[11] = 2 // claims 2 objects, stores 1
    expect(() => scanPack(badCount)).toThrow()
  })
})

describe('index → serialize → BrowseReader round trip', () => {
  it('serves byte-identical objects, with a REF base in a different pack', async () => {
    const base = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n')
    const catTarget = new TextEncoder().encode('the quick brown fox jumps over the lazy cat\n')
    const batTarget = new TextEncoder().encode('the quick brown fox jumps over the lazy bat\n')
    const readme = new TextEncoder().encode('# fallback clone\n'.repeat(10))

    // Pack 0: base blob + an OFS_DELTA onto it + an unrelated blob.
    const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base))
    const catDelta = copyInsertDelta(base.length, catTarget.length, 40, new TextEncoder().encode('cat\n'))
    const catStored = concat(
      objHeader(T_OFS_DELTA, catDelta.length),
      ofsBase(baseStored.length), // rel = deltaOffset - baseOffset
      zlibSync(catDelta),
    )
    const readmeStored = concat(objHeader(T_BLOB, readme.length), zlibSync(readme))
    const pack0 = packFrame(baseStored, catStored, readmeStored)

    // Pack 1: a REF_DELTA whose base blob lives in pack 0.
    const batDelta = copyInsertDelta(base.length, batTarget.length, 40, new TextEncoder().encode('bat\n'))
    const batStored = concat(
      objHeader(T_REF_DELTA, batDelta.length),
      hexToBytes(gitOidHex('blob', base)),
      zlibSync(batDelta),
    )
    const pack1 = packFrame(batStored)

    const progress: number[] = []
    const objects = await indexPacks([pack0, pack1], (done, total) => progress.push(done / total))
    expect(objects).toHaveLength(4)
    expect(progress[progress.length - 1]).toBe(1)

    const depths = new Map(objects.map((o) => [o.oidHex, o.deltaDepth]))
    expect(depths.get(gitOidHex('blob', base))).toBe(0)
    expect(depths.get(gitOidHex('blob', catTarget))).toBe(1)
    expect(depths.get(gitOidHex('blob', batTarget))).toBe(1)

    const locator = ObjectLocator.parse(serializeLocator(objects))
    const reader = new BrowseReader(locator, memoryPackSource([pack0, pack1]))
    for (const [oid, want] of [
      [gitOidHex('blob', base), base],
      [gitOidHex('blob', catTarget), catTarget],
      [gitOidHex('blob', batTarget), batTarget],
      [gitOidHex('blob', readme), readme],
    ] as const) {
      const obj = await reader.readObject(oid) // verify: true — sha1 checked
      expect(obj.type).toBe('blob')
      expect(Array.from(obj.bytes)).toEqual(Array.from(want))
    }
  })

  it('errors when a REF base exists in no pack', async () => {
    const delta = copyInsertDelta(10, 4, 0, new TextEncoder().encode('nope'))
    const orphan = concat(objHeader(T_REF_DELTA, delta.length), new Uint8Array(20).fill(0x42), zlibSync(delta))
    await expect(indexPacks([packFrame(orphan)])).rejects.toThrow(/REF_DELTA base not found/)
  })
})
