/**
 * `readObject(oid, { maxBytes })` refuses an object by the sizes its pack headers declare,
 * before inflating or applying anything: a delta a few hundred bytes long in the pack can ask
 * for gigabytes (review of #82: a README image inflated in the viewer's tab). A header can lie
 * too, so inflating stops once a stream yields more than it declared, and an entry too long to
 * hold an allowed object is not fetched at all.
 */

import { describe, expect, it } from 'vitest'

import { zlibSync } from 'fflate'

import { imageRepo, png } from '../view/image-repo-fixture'
import { memoryPackSource } from './indexer'
import { ObjectTooLargeError, PACK_TYPE, applyDelta, gitOidHex, inflateZlib, type PackSource } from './index'
import { objHeader } from './pack-fixtures'

/** The pack offset of the blob entry that inflates to the object `oid` (a linear scan of this tiny test pack). */
function findEntry(pack: Uint8Array, oid: string): number {
  for (let at = 12; at < pack.length - 20; at++) {
    try {
      const size = objHeader(PACK_TYPE.BLOB, 4096)
      if (size.every((b, i) => pack[at + i] === b) && gitOidHex('blob', inflateZlib(pack, at + size.length, 4096)) === oid) return at
    } catch {
      /* not an entry start */
    }
  }
  throw new Error('entry not found')
}

const MIB = 1024 * 1024
const CAP = 5 * MIB

describe('object size limit', () => {
  it('refuses a delta-compressed blob over the limit although its stored entry is tiny', async () => {
    const { reader, oids } = imageRepo([{ name: 'big.png', delta: { base: png(1024), size: 6 * MIB } }])
    const oid = oids['big.png'] as string
    const entry = reader.locate(oid)
    expect(entry?.deltaDepth).toBe(1)
    expect(entry?.length).toBeLessThan(4096) // the stored-length check passed this
    await expect(reader.readObject(oid, { maxBytes: CAP })).rejects.toBeInstanceOf(ObjectTooLargeError)
    // Without a limit it still reads (the blob view offers it as a download); a limited read
    // after that is still refused.
    expect((await reader.readObject(oid)).bytes.length).toBe(6 * MIB)
    await expect(reader.readObject(oid, { maxBytes: CAP })).rejects.toBeInstanceOf(ObjectTooLargeError)
  })

  it('refuses a whole-stored blob over the limit, and reads one under it', async () => {
    const { reader, oids } = imageRepo([
      { name: 'zeros.png', bytes: png(6 * MIB) },
      { name: 'ok.png', bytes: png(4096) },
    ])
    await expect(reader.readObject(oids['zeros.png'] as string, { maxBytes: CAP })).rejects.toBeInstanceOf(ObjectTooLargeError)
    expect((await reader.readObject(oids['ok.png'] as string, { maxBytes: CAP })).bytes.length).toBe(4096)
  })

  it('reads an image under the limit built from a larger base', async () => {
    // A 5.1 MiB image, then a 4.9 MiB one stored as a delta of it: the base is over the image
    // limit, but the image is not.
    const { reader, oids } = imageRepo([{ name: 'small.png', delta: { base: png(CAP + 100_000), size: CAP - 100_000 } }])
    expect((await reader.readObject(oids['small.png'] as string, { maxBytes: CAP })).bytes.length).toBe(CAP - 100_000)
  })

  it('stops inflating a zip bomb once it passes its declared size', async () => {
    // The header says 1 KiB; the stream inflates to 64 MiB of zeros (about 64 KiB stored).
    const { reader, oids } = imageRepo([{ name: 'bomb.png', bomb: { claimed: 1024, inflates: 64 * MIB } }])
    const t = performance.now()
    await expect(reader.readObject(oids['bomb.png'] as string, { maxBytes: CAP })).rejects.toThrow(/inflate size mismatch/)
    expect(performance.now() - t).toBeLessThan(100)
  })

  it('does not fetch an entry too long to hold an object under the limit', async () => {
    const { reader, oids, fetched } = imageRepo([{ name: 'bomb.png', bomb: { claimed: 1024, inflates: 128 * MIB } }])
    const oid = oids['bomb.png'] as string
    const length = reader.locate(oid)?.length ?? 0
    expect(length).toBeGreaterThan(64 * 1024)
    const before = fetched.length
    await expect(reader.readObject(oid, { maxBytes: 4096 })).rejects.toBeInstanceOf(ObjectTooLargeError)
    expect(fetched.slice(before).some(([start, end]) => end - start >= length)).toBe(false)
  })

  it('reads the honest copy when another copy claims the object is too large', async () => {
    // 4 KiB of random bytes stores at about 4 KiB, so a lying header fits in the same entry.
    const good = png(4096)
    crypto.getRandomValues(good.subarray(8))
    const { reader, oids } = imageRepo([{ name: 'a.png', bytes: good }], (pack) => {
      const oid = gitOidHex('blob', good)
      const at = findEntry(pack, oid)
      // Copy 0 is tampered: its header claims 16 KiB (same two-byte varint, so the same length).
      const tampered = pack.slice()
      tampered.set(objHeader(PACK_TYPE.BLOB, 16 * 1024), at)
      const copies = [memoryPackSource([tampered]), memoryPackSource([pack])]
      return { copyCount: () => 2, fetchRange: (packRef, start, end, copy = 0) => (copies[copy] as PackSource).fetchRange(packRef, start, end) }
    })
    expect((await reader.readObject(oids['a.png'] as string, { maxBytes: 8 * 1024 })).bytes).toEqual(good)
  })

  it('refuses a declared size the input could not inflate to, without inflating', () => {
    const stream = zlibSync(new Uint8Array(100))
    expect(() => inflateZlib(stream, 0, 100 * 1024 * 1024)).toThrow(/inflate size mismatch/)
  })

  it('checks a delta\'s declared result size before allocating it', () => {
    // src 1, dst 2^31: a 10-byte delta asking for 2 GiB.
    const delta = new Uint8Array([1, 0x80, 0x80, 0x80, 0x80, 0x08])
    expect(() => applyDelta(new Uint8Array([0]), delta, CAP)).toThrow(ObjectTooLargeError)
  })
})
