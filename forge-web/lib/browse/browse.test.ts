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

// --- tiny pack-format writers -------------------------------------------------

const T_BLOB = 3
const T_OFS_DELTA = 6

/** Encode a pack object header: 3-bit type + size varint (4 low bits, then 7-bit groups). */
function objHeader(type: number, size: number): Uint8Array {
  const out: number[] = []
  let c = (type << 4) | (size & 0x0f)
  size = Math.floor(size / 16)
  while (size > 0) {
    out.push(c | 0x80)
    c = size & 0x7f
    size = Math.floor(size / 128)
  }
  out.push(c)
  return new Uint8Array(out)
}

/** Encode an OFS_DELTA relative base back-pointer (git's offset varint). */
function ofsBase(rel: number): Uint8Array {
  const bytes = [rel & 0x7f]
  let n = Math.floor(rel / 128)
  while (n > 0) {
    n -= 1
    bytes.unshift(0x80 | (n & 0x7f))
    n = Math.floor(n / 128)
  }
  return new Uint8Array(bytes)
}

/** Encode a git delta size varint (little-endian 7-bit groups). */
function deltaSize(n: number): number[] {
  const out: number[] = []
  for (;;) {
    let b = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    out.push(b)
    if (n === 0) break
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

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

const PACK_HEADER = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 2]) // "PACK" v2 n=2

function packSourceFor(pack: Uint8Array): PackSource {
  return {
    fetchRange: (_packRef, start, end) => Promise.resolve(pack.slice(start, end)),
  }
}

describe('browse-plane reader', () => {
  it('reconstructs a base blob from a locator lookup + single-span ranged read', async () => {
    const content = new TextEncoder().encode('hello dash forge\n'.repeat(4))
    const blobOid = gitOidHex('blob', content)

    const offset = PACK_HEADER.length
    const stored = concat(objHeader(T_BLOB, content.length), zlibSync(content))
    const pack = concat(PACK_HEADER, stored, new Uint8Array(20)) // + zeroed trailer

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
    const insert = new TextEncoder().encode('cat\n')
    const copyLen = 40
    const delta = new Uint8Array([
      ...deltaSize(base.length),
      ...deltaSize(target.length),
      0x80 | 0x01 | 0x10 | 0x20, // copy: offset byte + 2 size bytes
      0x00, // copy offset = 0
      copyLen & 0xff,
      (copyLen >> 8) & 0xff,
      insert.length, // insert op
      ...insert,
    ])

    const baseOffset = PACK_HEADER.length
    const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base))
    const deltaOffset = baseOffset + baseStored.length
    const deltaStored = concat(
      objHeader(T_OFS_DELTA, delta.length),
      ofsBase(deltaOffset - baseOffset),
      zlibSync(delta),
    )
    const pack = concat(PACK_HEADER, baseStored, deltaStored, new Uint8Array(20))

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
})
