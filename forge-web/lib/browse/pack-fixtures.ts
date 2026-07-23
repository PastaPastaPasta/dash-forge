/**
 * TEST FIXTURES ONLY — tiny git pack-format writers for unit tests (imported by
 * `indexer.test.ts` / `browse-fallback.test.ts`; never by app code, so never bundled).
 * Builds real `PACK` v2 frames: header + object entries + sha1 trailer.
 */

import { sha1 } from '@noble/hashes/legacy.js'

import { PACK_TYPE } from './pack'

export const T_BLOB = PACK_TYPE.BLOB
export const T_OFS_DELTA = PACK_TYPE.OFS_DELTA
export const T_REF_DELTA = PACK_TYPE.REF_DELTA

/** Encode a pack object header: 3-bit type + size varint (4 low bits, then 7-bit groups). */
export function objHeader(type: number, size: number): Uint8Array {
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
export function ofsBase(rel: number): Uint8Array {
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
export function deltaSize(n: number): number[] {
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

export function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Frame stored objects as a real pack: `PACK` v2 + count + body + sha1 trailer. */
export function packFrame(...stored: Uint8Array[]): Uint8Array {
  const header = new Uint8Array(12)
  header.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2])
  new DataView(header.buffer).setUint32(8, stored.length, false)
  const body = concat(header, ...stored)
  return concat(body, sha1(body))
}

/** A delta that copies `copyLen` bytes of the base then inserts `tail`. */
export function copyInsertDelta(
  baseLen: number,
  targetLen: number,
  copyLen: number,
  tail: Uint8Array,
): Uint8Array {
  return new Uint8Array([
    ...deltaSize(baseLen),
    ...deltaSize(targetLen),
    0x80 | 0x01 | 0x10 | 0x20, // copy: offset byte + 2 size bytes
    0x00,
    copyLen & 0xff,
    (copyLen >> 8) & 0xff,
    tail.length,
    ...tail,
  ])
}
