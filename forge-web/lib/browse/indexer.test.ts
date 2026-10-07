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
  INDEX_DECODE_MAX_BYTES,
  IndexTooLargeError,
  indexPacks,
  memoryPackSource,
  scanPack,
  serializeLocator,
} from './indexer'
import { DELTA_DEPTH_MAX, ObjectTooLargeError, zlibStreamLength } from './pack'
import {
  T_BLOB,
  T_OFS_DELTA,
  T_REF_DELTA,
  concat,
  copyInsertDelta,
  deltaSize,
  hexToBytes,
  objHeader,
  ofsBase,
  packFrame,
} from './pack-fixtures'

describe('zlibStreamLength', () => {
  it('reports the exact compressed length with trailing bytes present', () => {
    const payload = new TextEncoder().encode('consumed-bytes probe '.repeat(20))
    const stream = zlibSync(payload)
    const buf = concat(new Uint8Array([0xee]), stream, new Uint8Array([1, 2, 3, 4]))
    expect(zlibStreamLength(buf, 1, payload.length)).toBe(stream.length)
  })

  it('throws on a truncated stream', () => {
    const payload = new TextEncoder().encode('truncate me '.repeat(50))
    const stream = zlibSync(payload)
    expect(() => zlibStreamLength(stream.subarray(0, stream.length - 10), 0, payload.length)).toThrow(/inflate size mismatch/)
  })
})

/** A pack holding one blob of `size` zero bytes: a few KiB stored, `size` inflated. */
function zeroBlobPack(size: number, declared = size): Uint8Array {
  return packFrame(concat(objHeader(T_BLOB, declared), zlibSync(new Uint8Array(size), { level: 9 })))
}

describe('fallback clone budgets', () => {
  it('refuses a deflate bomb over the budget before inflating it', () => {
    const bomb = zeroBlobPack(8 * 1024 * 1024) // ~8 KiB stored
    expect(bomb.length).toBeLessThan(64 * 1024)
    expect(() => scanPack(bomb, { left: 1024 * 1024 })).toThrow(ObjectTooLargeError)
    // The same pack under a budget it fits is fine: the budget, not the pack, refused it.
    expect(scanPack(bomb, { left: 16 * 1024 * 1024 })).toHaveLength(1)
  })

  it('stops a stream that inflates past the size its header declares', () => {
    const lying = zeroBlobPack(8 * 1024 * 1024, 100)
    expect(() => scanPack(lying)).toThrow(/inflate failed at \d+: inflate size mismatch/)
  })

  it('charges every stream of every pack to one scan budget', () => {
    const a = zeroBlobPack(600 * 1024)
    const b = zeroBlobPack(600 * 1024)
    const budget = { left: 1024 * 1024 }
    expect(scanPack(a, budget)).toHaveLength(1)
    expect(() => scanPack(b, budget)).toThrow(ObjectTooLargeError)
  })

  it('refuses a delta that builds more than the budget from a small base', async () => {
    // 16,385 one-byte "copy 64 KiB of the base" instructions: ~16 KiB of delta (a few hundred
    // bytes stored) that asks for just over 1 GiB.
    const base = new Uint8Array(0x10000)
    const ops = 16_385
    const delta = new Uint8Array([...deltaSize(base.length), ...deltaSize(ops * 0x10000), ...new Uint8Array(ops).fill(0x80)])
    expect(ops * 0x10000).toBeGreaterThan(INDEX_DECODE_MAX_BYTES)
    const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base, { level: 9 }))
    const deltaStored = concat(objHeader(T_OFS_DELTA, delta.length), ofsBase(baseStored.length), zlibSync(delta, { level: 9 }))
    const pack = packFrame(baseStored, deltaStored)
    expect(pack.length).toBeLessThan(4096)
    await expect(indexPacks([pack])).rejects.toBeInstanceOf(IndexTooLargeError)
  })

  it('holds a caller to the budget it passes, over both passes', async () => {
    const pack = zeroBlobPack(2 * 1024 * 1024)
    await expect(indexPacks([pack], undefined, 1024 * 1024)).rejects.toBeInstanceOf(IndexTooLargeError)
    expect(await indexPacks([pack], undefined, 4 * 1024 * 1024)).toHaveLength(1)
  })

  it('refuses a chain longer than git allows, and reads one at the limit', async () => {
    // Each delta copies the whole object before it and adds one byte, so every object differs.
    const chainPack = (deltas: number): Uint8Array => {
      const stored: Uint8Array[] = []
      let prev = new Uint8Array([0x61])
      stored.push(concat(objHeader(T_BLOB, 1), zlibSync(prev)))
      for (let k = 0; k < deltas; k++) {
        const delta = copyInsertDelta(prev.length, prev.length + 1, prev.length, new Uint8Array([0x62]))
        stored.push(concat(objHeader(T_OFS_DELTA, delta.length), ofsBase((stored[stored.length - 1] as Uint8Array).length), zlibSync(delta)))
        const next = new Uint8Array(prev.length + 1)
        next.set(prev)
        next[prev.length] = 0x62
        prev = next
      }
      return packFrame(...stored)
    }
    const atLimit = await indexPacks([chainPack(DELTA_DEPTH_MAX)])
    expect(Math.max(...atLimit.map((o) => o.deltaDepth))).toBe(DELTA_DEPTH_MAX)
    await expect(indexPacks([chainPack(DELTA_DEPTH_MAX + 1)])).rejects.toThrow(/over 4095 deep/)
  }, 30_000)
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

  it('keeps a duplicated object\'s row in EVERY pack that stores it', async () => {
    // A push whose `have` set was incomplete re-packs history an earlier pack already
    // holds, so the same blob lands in two live packs — and the later pack's OFS deltas
    // are relative to ITS copy. Indexing one row per OID drops that copy's address, and
    // since every synthesized row carries SPAN_SENTINEL the per-base walk is the only read
    // path there is: the delta becomes unreadable with `base object at pack 1 offset N not
    // in locator`.
    const base = new TextEncoder().encode('shared history line that both packs carry\n')
    const target = new TextEncoder().encode('shared history line that both packs carrX\n')
    const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base))
    const pack0 = packFrame(baseStored)

    // Pack 1 re-sends the same blob, then an OFS_DELTA against ITS OWN copy of it.
    const delta = copyInsertDelta(base.length, target.length, 40, new TextEncoder().encode('X\n'))
    const deltaStored = concat(
      objHeader(T_OFS_DELTA, delta.length),
      ofsBase(baseStored.length),
      zlibSync(delta),
    )
    const pack1 = packFrame(baseStored, deltaStored)

    const objects = await indexPacks([pack0, pack1])
    const baseOid = gitOidHex('blob', base)
    expect(objects.filter((o) => o.oidHex === baseOid).map((o) => o.packRef)).toEqual([0, 1])

    const locator = ObjectLocator.parse(serializeLocator(objects))
    // Lookup still answers with the lowest packRef, so nothing about the shared object moves.
    expect(locator.lookup(hexToBytes(baseOid))).toMatchObject({ packRef: 0 })
    // ...and pack 1's delta resolves, which is what the dropped row used to break.
    const reader = new BrowseReader(locator, memoryPackSource([pack0, pack1]))
    const obj = await reader.readObject(gitOidHex('blob', target))
    expect(Array.from(obj.bytes)).toEqual(Array.from(target))
  })

  it('resolves OFS bases per pack when offsets collide across packs', async () => {
    // Both packs put their base blob at offset 12 and an OFS_DELTA right after — the
    // collision that a bare-offset index mis-resolved (offsets repeat across packs).
    const mk = (text: string, tail: string): { pack: Uint8Array; base: Uint8Array; target: Uint8Array } => {
      const base = new TextEncoder().encode(text)
      const target = new TextEncoder().encode(text.slice(0, 40) + tail)
      const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base))
      const delta = copyInsertDelta(base.length, target.length, 40, new TextEncoder().encode(tail))
      const deltaStored = concat(objHeader(T_OFS_DELTA, delta.length), ofsBase(baseStored.length), zlibSync(delta))
      return { pack: packFrame(baseStored, deltaStored), base, target }
    }
    const a = mk('the quick brown fox jumps over the lazy dog\n', 'cat\n')
    const b = mk('pack rat stacks packed racks in a black shack\n', 'nook\n')

    const objects = await indexPacks([a.pack, b.pack])
    const reader = new BrowseReader(
      ObjectLocator.parse(serializeLocator(objects)),
      memoryPackSource([a.pack, b.pack]),
    )
    for (const target of [a.target, b.target]) {
      const obj = await reader.readObject(gitOidHex('blob', target))
      expect(Array.from(obj.bytes)).toEqual(Array.from(target))
    }
  })

  it('resolves a REF base stored after the deltas that wait on it', async () => {
    // Pack 0: a REF_DELTA onto a blob only pack 1 holds, and an OFS_DELTA on top of it; both
    // wait for the blob and are resolved once it is.
    const base = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n')
    const mid = new TextEncoder().encode('the quick brown fox jumps over the lazy cat\n')
    const top = new TextEncoder().encode('the quick brown fox jumps over the lazy cow\n')
    const refDelta = copyInsertDelta(base.length, mid.length, 40, new TextEncoder().encode('cat\n'))
    const refStored = concat(objHeader(T_REF_DELTA, refDelta.length), hexToBytes(gitOidHex('blob', base)), zlibSync(refDelta))
    const ofsDelta = copyInsertDelta(mid.length, top.length, 40, new TextEncoder().encode('cow\n'))
    const ofsStored = concat(objHeader(T_OFS_DELTA, ofsDelta.length), ofsBase(refStored.length), zlibSync(ofsDelta))
    const pack0 = packFrame(refStored, ofsStored)
    const pack1 = packFrame(concat(objHeader(T_BLOB, base.length), zlibSync(base)))

    const objects = await indexPacks([pack0, pack1])
    const depths = new Map(objects.map((o) => [o.oidHex, o.deltaDepth]))
    expect(depths.get(gitOidHex('blob', base))).toBe(0)
    expect(depths.get(gitOidHex('blob', mid))).toBe(1)
    expect(depths.get(gitOidHex('blob', top))).toBe(2)
  })

  it('errors when a REF base exists in no pack', async () => {
    const delta = copyInsertDelta(10, 4, 0, new TextEncoder().encode('nope'))
    const orphan = concat(objHeader(T_REF_DELTA, delta.length), new Uint8Array(20).fill(0x42), zlibSync(delta))
    await expect(indexPacks([packFrame(orphan)])).rejects.toThrow(/REF_DELTA base not found/)
  })
})
