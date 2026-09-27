/**
 * `readObject(oid, { maxBytes })` refuses an object by the sizes its pack headers declare,
 * before inflating or applying anything: a delta a few hundred bytes long in the pack can ask
 * for gigabytes (review of #82: a README image inflated in the viewer's tab).
 */

import { describe, expect, it } from 'vitest'

import { imageRepo, png } from '../view/image-repo-fixture'
import { ObjectTooLargeError, applyDelta } from './index'

const MIB = 1024 * 1024

describe('object size limit', () => {
  it('refuses a delta-compressed blob over the limit although its stored entry is tiny', async () => {
    const { reader, oids } = await imageRepo([{ name: 'big.png', delta: { base: png(1024), size: 6 * MIB } }])
    const oid = oids['big.png'] as string
    const entry = reader.locate(oid)
    expect(entry?.deltaDepth).toBe(1)
    expect(entry?.length).toBeLessThan(2048) // the stored-length check passed this
    await expect(reader.readObject(oid, { maxBytes: 5 * MIB })).rejects.toBeInstanceOf(ObjectTooLargeError)
    // Without a limit it still reads (the blob view offers it as a download); a limited read
    // after that is still refused.
    expect((await reader.readObject(oid)).bytes.length).toBe(6 * MIB)
    await expect(reader.readObject(oid, { maxBytes: 5 * MIB })).rejects.toBeInstanceOf(ObjectTooLargeError)
  })

  it('refuses a whole-stored blob over the limit, and reads one under it', async () => {
    const { reader, oids } = await imageRepo([
      { name: 'zeros.png', bytes: png(6 * MIB) },
      { name: 'ok.png', bytes: png(4096) },
    ])
    await expect(reader.readObject(oids['zeros.png'] as string, { maxBytes: 5 * MIB })).rejects.toBeInstanceOf(ObjectTooLargeError)
    expect((await reader.readObject(oids['ok.png'] as string, { maxBytes: 5 * MIB })).bytes.length).toBe(4096)
  })

  it('checks a delta\'s declared result size before allocating it', () => {
    // src 1, dst 2^31: a 10-byte delta asking for 2 GiB.
    const delta = new Uint8Array([1, 0x80, 0x80, 0x80, 0x80, 0x08])
    expect(() => applyDelta(new Uint8Array([0]), delta, 5 * MIB)).toThrow(ObjectTooLargeError)
  })
})
