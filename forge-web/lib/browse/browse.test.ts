/**
 * Browse-plane reader round-trip: build a tiny self-contained pack + objectLocator in
 * memory, then prove {@link BrowseReader} reconstructs the original bytes from a locator
 * lookup + ranged read — for a base blob (single-span path) and an OFS_DELTA object
 * (both the single-span and the per-base walk). This is the artifact that makes
 * size-independent browsing sound: locator lookup → ranged fetch → inflate + delta apply.
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  BrowseReader,
  FANOUT_LEN,
  LOCATOR_ROW_LEN,
  ObjectLocator,
  type PackSource,
  SPAN_SENTINEL,
  gitOidHex,
  isSourceFailure,
} from './index'
import { PackError } from '../private/pack'
import {
  T_BLOB,
  T_OFS_DELTA,
  concat,
  copyInsertDelta,
  hexToBytes,
  objHeader,
  ofsBase,
  packFrame,
} from './pack-fixtures'

// --- objectLocator writer -----------------------------------------------------

interface Row {
  oidHex: string
  offset: number
  length: number
  span: number
  depth: number
}

function buildLocator(rows: Row[]): Uint8Array {
  const sorted = [...rows].sort((a, b) => (a.oidHex < b.oidHex ? -1 : 1))
  const fanout = new Uint8Array(FANOUT_LEN)
  const counts = new Array<number>(256).fill(0)
  for (const r of sorted) {
    const first = parseInt(r.oidHex.slice(0, 2), 16)
    counts[first] = (counts[first] as number) + 1
  }
  let cum = 0
  for (let i = 0; i < 256; i++) {
    cum += counts[i] as number
    const dv = new DataView(fanout.buffer, i * 4, 4)
    dv.setUint32(0, cum, false)
  }
  const body = new Uint8Array(sorted.length * LOCATOR_ROW_LEN)
  let o = 0
  for (const r of sorted) {
    body.set(hexToBytes(r.oidHex), o)
    o += 20
    const dv = new DataView(body.buffer, o, 2)
    dv.setUint16(0, 0, false) // packRef 0
    o += 2
    // offset: 5 BE bytes
    let off = r.offset
    for (let k = 4; k >= 0; k--) {
      body[o + k] = off & 0xff
      off = Math.floor(off / 256)
    }
    o += 5
    new DataView(body.buffer, o, 4).setUint32(0, r.length, false)
    o += 4
    new DataView(body.buffer, o, 4).setUint32(0, r.span >>> 0, false)
    o += 4
    body[o] = r.depth
    o += 1
  }
  return concat(fanout, body)
}

// --- fixtures -----------------------------------------------------------------

const PACK_HEADER_LEN = 12

function packSourceFor(pack: Uint8Array): PackSource {
  return {
    fetchRange: (_packRef, start, end) => Promise.resolve(pack.slice(start, end)),
  }
}

/** A pack source that counts its fetches — pins the reader's object-memo behavior. */
function countingPackSource(pack: Uint8Array): PackSource & { readonly fetches: () => number } {
  let n = 0
  return {
    fetchRange: (_packRef, start, end) => {
      n += 1
      return Promise.resolve(pack.slice(start, end))
    },
    fetches: () => n,
  }
}

describe('browse-plane reader', () => {
  it('reconstructs a base blob from a locator lookup + single-span ranged read', async () => {
    const content = new TextEncoder().encode('hello dash forge\n'.repeat(4))
    const blobOid = gitOidHex('blob', content)

    const offset = PACK_HEADER_LEN
    const stored = concat(objHeader(T_BLOB, content.length), zlibSync(content))
    const pack = packFrame(stored)

    const locator = ObjectLocator.parse(
      buildLocator([{ oidHex: blobOid, offset, length: stored.length, span: stored.length, depth: 0 }]),
    )
    const reader = new BrowseReader(locator, packSourceFor(pack))

    const obj = await reader.readObject(blobOid)
    expect(obj.type).toBe('blob')
    expect(Array.from(obj.bytes)).toEqual(Array.from(content))
  })

  it('reconstructs an OFS_DELTA object — single-span and per-base give identical bytes', async () => {
    const base = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n')
    const target = new TextEncoder().encode('the quick brown fox jumps over the lazy cat\n')
    const baseOid = gitOidHex('blob', base)
    const targetOid = gitOidHex('blob', target)

    // Delta: copy [0, 40) from base, then insert "cat\n".
    const delta = copyInsertDelta(base.length, target.length, 40, new TextEncoder().encode('cat\n'))

    const baseOffset = PACK_HEADER_LEN
    const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base))
    const deltaOffset = baseOffset + baseStored.length
    const deltaStored = concat(
      objHeader(T_OFS_DELTA, delta.length),
      ofsBase(deltaOffset - baseOffset),
      zlibSync(delta),
    )
    const pack = packFrame(baseStored, deltaStored)

    const baseRow: Row = {
      oidHex: baseOid,
      offset: baseOffset,
      length: baseStored.length,
      span: baseStored.length,
      depth: 0,
    }

    // (a) single-span: span covers [baseOffset, deltaEnd) — the contiguous chain.
    const deltaEnd = deltaOffset + deltaStored.length
    const spanRow: Row = {
      oidHex: targetOid,
      offset: deltaOffset,
      length: deltaStored.length,
      span: deltaEnd - baseOffset,
      depth: 1,
    }
    const spanReader = new BrowseReader(
      ObjectLocator.parse(buildLocator([baseRow, spanRow])),
      packSourceFor(pack),
    )
    const viaSpan = await spanReader.readObject(targetOid)
    expect(Array.from(viaSpan.bytes)).toEqual(Array.from(target))

    // (b) per-base: span = sentinel forces the per-base walk (OFS base via offset index).
    const perBaseRow: Row = { ...spanRow, span: SPAN_SENTINEL, depth: 1 }
    const perBaseReader = new BrowseReader(
      ObjectLocator.parse(buildLocator([baseRow, perBaseRow])),
      packSourceFor(pack),
    )
    const viaPerBase = await perBaseReader.readObject(targetOid)
    expect(Array.from(viaPerBase.bytes)).toEqual(Array.from(target))
  })

  it('memoizes reconstructed objects — a repeat read issues no further fetches', async () => {
    const content = new TextEncoder().encode('memo me\n'.repeat(8))
    const blobOid = gitOidHex('blob', content)
    const stored = concat(objHeader(T_BLOB, content.length), zlibSync(content))
    const pack = packFrame(stored)
    const source = countingPackSource(pack)
    const reader = new BrowseReader(
      ObjectLocator.parse(
        buildLocator([
          { oidHex: blobOid, offset: PACK_HEADER_LEN, length: stored.length, span: stored.length, depth: 0 },
        ]),
      ),
      source,
    )

    const first = await reader.readObject(blobOid)
    const after = source.fetches()
    expect(after).toBeGreaterThan(0)
    const second = await reader.readObject(blobOid)
    expect(source.fetches()).toBe(after)
    expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes))
  })

  it('does not memoize objects above the per-entry byte cap', async () => {
    // > 128 KiB uncompressed — the memo must skip it so one huge blob cannot evict the
    // hot small objects (trees / commits) the navigation paths live on.
    const content = new Uint8Array(160 * 1024)
    for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) & 0xff
    const blobOid = gitOidHex('blob', content)
    const stored = concat(objHeader(T_BLOB, content.length), zlibSync(content))
    const pack = packFrame(stored)
    const source = countingPackSource(pack)
    const reader = new BrowseReader(
      ObjectLocator.parse(
        buildLocator([
          { oidHex: blobOid, offset: PACK_HEADER_LEN, length: stored.length, span: stored.length, depth: 0 },
        ]),
      ),
      source,
    )

    await reader.readObject(blobOid)
    const after = source.fetches()
    await reader.readObject(blobOid)
    expect(source.fetches()).toBeGreaterThan(after)
  })

  it('reports each fresh read to onObject: verified on a match, failed on a mismatch', async () => {
    const content = new TextEncoder().encode('observe me\n')
    const blobOid = gitOidHex('blob', content)
    const stored = concat(objHeader(T_BLOB, content.length), zlibSync(content))
    const row = { offset: PACK_HEADER_LEN, length: stored.length, span: stored.length, depth: 0 }
    const verdicts: string[] = []

    const good = new BrowseReader(
      ObjectLocator.parse(buildLocator([{ oidHex: blobOid, ...row }])),
      packSourceFor(packFrame(stored)),
      { onObject: (v) => verdicts.push(v) },
    )
    await good.readObject(blobOid)
    await good.readObject(blobOid) // memo hit: already reported
    expect(verdicts).toEqual(['verified'])

    // A locator that files these bytes under a different id: the hash check must refuse it.
    const wrongOid = 'ff'.repeat(20)
    const lying = new BrowseReader(
      ObjectLocator.parse(buildLocator([{ oidHex: wrongOid, ...row }])),
      packSourceFor(packFrame(stored)),
      { onObject: (v) => verdicts.push(v) },
    )
    await expect(lying.readObject(wrongOid)).rejects.toThrow(/oid mismatch/)
    expect(verdicts).toEqual(['verified', 'failed'])

    const unchecked = new BrowseReader(
      ObjectLocator.parse(buildLocator([{ oidHex: blobOid, ...row }])),
      packSourceFor(packFrame(stored)),
      { verify: false, onObject: (v) => verdicts.push(v) },
    )
    await unchecked.readObject(blobOid)
    expect(verdicts).toEqual(['verified', 'failed', 'unchecked'])
  })

  describe('a network failure mid-read is an outage, never a hash mismatch (L-10)', () => {
    const content = new TextEncoder().encode('read me while offline\n'.repeat(4))
    const blobOid = gitOidHex('blob', content)
    const stored = concat(objHeader(T_BLOB, content.length), zlibSync(content))
    const pack = packFrame(stored)
    const row = { oidHex: blobOid, offset: PACK_HEADER_LEN, length: stored.length, span: stored.length, depth: 0 }

    /** A source whose connection drops for `drops` reads, then comes back. */
    function flakySource(drops: number, copies = 1): PackSource & { calls: number } {
      const src = {
        calls: 0,
        fetchRange: (_packRef: number, start: number, end: number) => {
          src.calls++
          if (src.calls <= drops) return Promise.reject(new TypeError('Failed to fetch'))
          return Promise.resolve(pack.slice(start, end))
        },
        copyCount: () => copies,
      }
      return src
    }

    it('reports no verdict while offline, then verifies the same object once back online', async () => {
      const verdicts: string[] = []
      const source = flakySource(1)
      const reader = new BrowseReader(ObjectLocator.parse(buildLocator([row])), source, { onObject: (v) => verdicts.push(v) })

      const offline = await reader.readObject(blobOid).catch((e: unknown) => e)
      expect(offline).toBeInstanceOf(TypeError)
      expect(isSourceFailure(offline)).toBe(true)
      expect(verdicts).toEqual([]) // not 'failed': nothing arrived, nothing was checked

      const obj = await reader.readObject(blobOid) // the connection is back
      expect(Array.from(obj.bytes)).toEqual(Array.from(content))
      expect(verdicts).toEqual(['verified'])
    })

    it('a drop on every copy of a multi-copy pack is still no verdict', async () => {
      const verdicts: string[] = []
      const reader = new BrowseReader(ObjectLocator.parse(buildLocator([row])), flakySource(3, 3), { onObject: (v) => verdicts.push(v) })
      await expect(reader.readObject(blobOid)).rejects.toThrow(/Failed to fetch/)
      expect(verdicts).toEqual([])
    })

    it('a drop on one copy and wrong bytes on another is a failure: bytes arrived and were wrong', async () => {
      const verdicts: string[] = []
      let calls = 0
      const source: PackSource = {
        fetchRange: (_p, start, end) => {
          calls++
          if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'))
          const bad = pack.slice(start, end)
          bad[bad.length - 1] ^= 0xff // a tampered copy: its zlib stream no longer checks
          return Promise.resolve(bad)
        },
        copyCount: () => 2,
      }
      const reader = new BrowseReader(ObjectLocator.parse(buildLocator([row])), source, { onObject: (v) => verdicts.push(v) })
      await expect(reader.readObject(blobOid)).rejects.toThrow()
      expect(verdicts).toEqual(['failed'])
    })

    it('a source that received bytes and says they are corrupt (a sealed pack) is a failure', async () => {
      const verdicts: string[] = []
      const source: PackSource = { fetchRange: () => Promise.reject(new PackError('sealedPackCorrupt')) }
      const reader = new BrowseReader(ObjectLocator.parse(buildLocator([row])), source, { onObject: (v) => verdicts.push(v) })
      await expect(reader.readObject(blobOid)).rejects.toThrow(/sealedPackCorrupt/)
      expect(verdicts).toEqual(['failed'])
    })

    it('a drop while reading a delta base is an outage too', async () => {
      const base = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n')
      const target = new TextEncoder().encode('the quick brown fox jumps over the lazy cat\n')
      const delta = copyInsertDelta(base.length, target.length, 40, new TextEncoder().encode('cat\n'))
      const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base))
      const deltaOffset = PACK_HEADER_LEN + baseStored.length
      const deltaStored = concat(objHeader(T_OFS_DELTA, delta.length), ofsBase(deltaOffset - PACK_HEADER_LEN), zlibSync(delta))
      const twoPack = packFrame(baseStored, deltaStored)
      const rows: Row[] = [
        { oidHex: gitOidHex('blob', base), offset: PACK_HEADER_LEN, length: baseStored.length, span: baseStored.length, depth: 0 },
        { oidHex: gitOidHex('blob', target), offset: deltaOffset, length: deltaStored.length, span: SPAN_SENTINEL, depth: 1 },
      ]
      let calls = 0
      const source: PackSource = {
        // The delta's own bytes arrive; the base's read (the second) drops.
        fetchRange: (_p, start, end) => (++calls === 2 ? Promise.reject(new Error('transport error: grpc error: Failed to fetch')) : Promise.resolve(twoPack.slice(start, end))),
      }
      const verdicts: string[] = []
      const reader = new BrowseReader(ObjectLocator.parse(buildLocator(rows)), source, { onObject: (v) => verdicts.push(v) })
      await expect(reader.readObject(gitOidHex('blob', target))).rejects.toThrow(/Failed to fetch/)
      expect(verdicts).toEqual([])
      expect(Array.from((await reader.readObject(gitOidHex('blob', target))).bytes)).toEqual(Array.from(target))
      expect(verdicts).toEqual(['verified'])
    })
  })
})
