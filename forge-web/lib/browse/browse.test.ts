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
} from './index'
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
})
