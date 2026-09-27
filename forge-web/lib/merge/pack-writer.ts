/**
 * Git packfile writer: a standard, **non-thin** `PACK` v2 frame (header, one zlib-deflated
 * entry per object, sha1 trailer) with no deltas. Every object is stored whole, so the pack
 * is self-contained: the browser's own `scanPack` / `indexPacks`, forge-core's parser and
 * `git index-pack` all read it without any other pack.
 */

import { sha1 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { zlibSync } from 'fflate'

import { PACK_TYPE, type GitObject } from '../browse'

const TYPE_CODE: Readonly<Record<GitObject['type'], number>> = {
  commit: PACK_TYPE.COMMIT,
  tree: PACK_TYPE.TREE,
  blob: PACK_TYPE.BLOB,
  tag: PACK_TYPE.TAG,
}

/** An entry header: 3-bit type, then the size as a little-endian varint (4 bits, then 7). */
function entryHeader(type: number, size: number): Uint8Array {
  const out: number[] = []
  let c = (type << 4) | (size & 0x0f)
  let rest = Math.floor(size / 16)
  while (rest > 0) {
    out.push(c | 0x80)
    c = rest & 0x7f
    rest = Math.floor(rest / 128)
  }
  out.push(c)
  return new Uint8Array(out)
}

/** A built pack and the facts a `packManifest` records about it. */
export interface BuiltPack {
  readonly bytes: Uint8Array
  readonly objectCount: number
  /** sha256 of the bytes, hex — the manifest's `packHash`. */
  readonly packHash: string
}

/** Pack `objects` (each stored whole) into one self-contained pack. */
export function writePack(objects: readonly GitObject[]): BuiltPack {
  const parts: Uint8Array[] = []
  const header = new Uint8Array(12)
  header.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2])
  new DataView(header.buffer).setUint32(8, objects.length, false)
  parts.push(header)
  for (const o of objects) {
    parts.push(entryHeader(TYPE_CODE[o.type], o.bytes.length), zlibSync(o.bytes))
  }
  const bodyLen = parts.reduce((n, p) => n + p.length, 0)
  const bytes = new Uint8Array(bodyLen + 20)
  let at = 0
  for (const p of parts) {
    bytes.set(p, at)
    at += p.length
  }
  bytes.set(sha1(bytes.subarray(0, bodyLen)), bodyLen)
  return { bytes, objectCount: objects.length, packHash: bytesToHex(sha256(bytes)) }
}
