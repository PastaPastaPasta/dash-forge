/**
 * Pack object reconstruction (read side) — zlib inflate + OFS/REF delta apply.
 *
 * Read-side port of the decode paths in `crates/forge-core/src/pack/parse.rs`. Turns a
 * ranged pack slice back into a git object. The single-contiguous-`deltaChainSpan` read
 * (blobs) is the primary browse path; a per-base delta-chain walk is the fallback for
 * deep-delta objects (trees over-fetch catastrophically under a single span).
 *
 * Stored packs are self-contained + repacked (all bases OFS, earlier in the pack), so the
 * span read only ever needs OFS bases within the slice; REF_DELTA in a span read is an
 * error (the pack would not be self-contained).
 */

import { sha1 } from '@noble/hashes/legacy.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { Inflate } from 'pako'

/** Final git object type, after any delta chain is resolved to its base. */
export type GitObjType = 'commit' | 'tree' | 'blob' | 'tag'

const T_COMMIT = 1
const T_TREE = 2
const T_BLOB = 3
const T_TAG = 4
const T_OFS_DELTA = 6
const T_REF_DELTA = 7

/** A reconstructed git object. */
export interface GitObject {
  readonly type: GitObjType
  readonly bytes: Uint8Array
}

function typeFromCode(code: number): GitObjType {
  switch (code) {
    case T_COMMIT:
      return 'commit'
    case T_TREE:
      return 'tree'
    case T_BLOB:
      return 'blob'
    case T_TAG:
      return 'tag'
    default:
      throw new Error(`non-base pack object type ${code}`)
  }
}

function headerKeyword(t: GitObjType): string {
  return t // 'commit' | 'tree' | 'blob' | 'tag' — already the git keyword.
}

/** Raw pack object type codes (base + delta), exported for the per-base walk. */
export const PACK_TYPE = {
  COMMIT: T_COMMIT,
  TREE: T_TREE,
  BLOB: T_BLOB,
  TAG: T_TAG,
  OFS_DELTA: T_OFS_DELTA,
  REF_DELTA: T_REF_DELTA,
} as const

/** Map a base pack type code to its git object type (throws on a delta code). */
export function objTypeFromCode(code: number): GitObjType {
  return typeFromCode(code)
}

export interface ObjHeader {
  readonly type: number
  readonly size: number
  readonly after: number
}

/** Parse an object header at `pos`: `(type_code, decoded_size, pos_after_header)`. */
export function parseObjHeader(buf: Uint8Array, pos: number): ObjHeader {
  let p = pos
  let c = buf[p]
  if (c === undefined) throw new Error('truncated object header')
  p += 1
  const type = (c >> 4) & 7
  let size = c & 0x0f
  let shift = 4
  while ((c & 0x80) !== 0) {
    c = buf[p]
    if (c === undefined) throw new Error('truncated object size varint')
    p += 1
    size |= (c & 0x7f) << shift
    shift += 7
  }
  return { type, size: size >>> 0, after: p }
}

/** Parse an OFS_DELTA base back-pointer varint. Returns `[rel_offset, pos_after]`. */
export function parseOfsBase(buf: Uint8Array, pos: number): [number, number] {
  let p = pos
  let c = buf[p]
  if (c === undefined) throw new Error('truncated OFS base varint')
  p += 1
  let ofs = c & 0x7f
  while ((c & 0x80) !== 0) {
    c = buf[p]
    if (c === undefined) throw new Error('truncated OFS base varint')
    p += 1
    ofs = ((ofs + 1) << 7) | (c & 0x7f)
  }
  return [ofs, p]
}

/** An object (or a delta-chain step) is larger than the caller's `maxBytes`: it was not inflated. */
export class ObjectTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`object is ${size} bytes, over the ${maxBytes}-byte limit`)
    this.name = 'ObjectTooLargeError'
  }
}

/** Deflate cannot expand input by more than this factor (a 258-byte match per ~2 bits). */
const DEFLATE_MAX_RATIO = 1032

/** Output chunk: how far a stream may overrun its declared size before it is stopped. */
const INFLATE_CHUNK = 64 * 1024

/**
 * Inflate one zlib stream at `buf[from..]` into exactly `expected` bytes (the size its pack
 * header declares), failing as soon as it yields more. A declared size over `maxBytes`, or one
 * the input could not inflate to, is refused before inflating.
 *
 * pako hands over output a chunk at a time while it inflates, and stops at the end of the zlib
 * stream, ignoring the bytes after it (a pack slice goes on). So a zip bomb whose header claims
 * 1 KiB costs about that much, not the gigabyte it would inflate to (a pack header is the
 * pusher's claim, nothing checks it), and a short stream followed by megabytes of other
 * entries costs only the stream.
 */
export function inflateZlib(buf: Uint8Array, from: number, expected: number, maxBytes = Infinity): Uint8Array {
  if (expected > maxBytes) throw new ObjectTooLargeError(expected, maxBytes)
  const input = buf.subarray(from)
  if (expected > input.length * DEFLATE_MAX_RATIO + 64) throw new Error('inflate size mismatch')
  const out = new Uint8Array(expected)
  let got = 0
  // windowBits 15: zlib only (no gzip or raw-deflate detection).
  // A small object needs no 64 KiB output chunk (one past `expected` still catches an overrun).
  const inflater = new Inflate({ chunkSize: Math.min(INFLATE_CHUNK, expected + 1), windowBits: 15 })
  inflater.onData = (chunk: Uint8Array) => {
    if (got + chunk.length > expected) throw new Error('inflate size mismatch')
    out.set(chunk, got)
    got += chunk.length
  }
  inflater.onEnd = () => {}
  inflater.push(input, true)
  if (inflater.err !== 0 || got !== expected) throw new Error('inflate size mismatch')
  return out
}

/**
 * The most bytes a delta producing at most `maxBytes` can hold: a copy instruction is at most
 * 8 bytes (opcode, 4 offset bytes, 3 size bytes) and yields at least one, plus the size varints.
 */
export function deltaMaxBytes(maxBytes: number): number {
  return maxBytes * 8 + 32
}

/**
 * The largest base an object of at most `maxBytes` may be a delta of. Bases are often larger
 * than what is built from them (an image shrunk in a later commit), so they get room of their own.
 */
export function baseMaxBytes(maxBytes: number): number {
  return maxBytes * 4
}

/**
 * The most bytes a pack entry for an object of at most `maxBytes` can occupy: its inflated
 * content (a delta at worst) stored raw, plus deflate's block overhead and the entry header.
 * A longer entry is refused before it is fetched.
 */
export function storedMaxBytes(maxBytes: number): number {
  return Math.ceil(deltaMaxBytes(maxBytes) * 1.001) + 64
}

/**
 * Inflate the delta whose zlib stream is at `buf[from..]` (declared `size`) and apply it to
 * `base`, refusing a delta or a result that could exceed `maxBytes` before allocating either.
 */
export function inflateDelta(base: Uint8Array, buf: Uint8Array, from: number, size: number, maxBytes = Infinity): Uint8Array {
  return applyDelta(base, inflateZlib(buf, from, size, deltaMaxBytes(maxBytes)), maxBytes)
}

/**
 * Apply a git delta (`src_size, dst_size, [copy|insert]*`) to `base`. A `dst_size` over
 * `maxBytes` is refused before anything is allocated: a few KiB of copy opcodes can ask for
 * gigabytes.
 */
export function applyDelta(base: Uint8Array, delta: Uint8Array, maxBytes = Infinity): Uint8Array {
  let pos = 0
  const readSize = (): number => {
    let r = 0
    let shift = 0
    for (;;) {
      const b = delta[pos]
      if (b === undefined) throw new Error('unexpected end of delta size')
      pos += 1
      r |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
    }
    return r >>> 0
  }
  readSize() // src size (unused)
  const dst = readSize()
  if (dst > maxBytes) throw new ObjectTooLargeError(dst, maxBytes)
  const out = new Uint8Array(dst)
  let outPos = 0
  while (pos < delta.length) {
    const op = delta[pos] as number
    pos += 1
    if ((op & 0x80) !== 0) {
      let cpOff = 0
      for (let i = 0; i < 4; i++) {
        if ((op & (1 << i)) !== 0) {
          const b = delta[pos]
          if (b === undefined) throw new Error('truncated delta copy offset')
          pos += 1
          cpOff |= b << (8 * i)
        }
      }
      cpOff = cpOff >>> 0
      let cpSize = 0
      for (let i = 0; i < 3; i++) {
        if ((op & (1 << (4 + i))) !== 0) {
          const b = delta[pos]
          if (b === undefined) throw new Error('truncated delta copy size')
          pos += 1
          cpSize |= b << (8 * i)
        }
      }
      if (cpSize === 0) cpSize = 0x10000
      const end = cpOff + cpSize
      if (end > base.length) throw new Error('delta copy out of base bounds')
      out.set(base.subarray(cpOff, end), outPos)
      outPos += cpSize
    } else if (op !== 0) {
      const n = op
      const end = pos + n
      if (end > delta.length) throw new Error('delta insert past end')
      out.set(delta.subarray(pos, end), outPos)
      outPos += n
      pos = end
    } else {
      throw new Error('reserved delta opcode 0')
    }
  }
  if (outPos !== dst) throw new Error('delta output size mismatch')
  return out
}

/**
 * Reconstruct a git object from ONLY the contiguous `deltaChainSpan` slice — the
 * browse-plane single-read path.
 *
 * `spanSlice` must be exactly the pack bytes `[end - deltaChainSpan, end)` where
 * `end = offset + length`. Recurses into (earlier, in-slice) OFS delta bases. REF_DELTA
 * is rejected here (the span model is only valid on self-contained, all-OFS packs).
 */
export function reconstructFromSpan(
  loc: { offset: number; length: number; deltaChainSpan: number },
  spanSlice: Uint8Array,
  maxBytes = Infinity,
  baseMax = baseMaxBytes(maxBytes),
): GitObject {
  const end = loc.offset + loc.length
  const baseAddr = end - loc.deltaChainSpan
  if (spanSlice.length !== loc.deltaChainSpan) throw new Error('span slice length mismatch')
  return decodeAt(spanSlice, baseAddr, loc.offset, null, maxBytes, baseMax)
}

/** A resolver for REF_DELTA bases / per-base fetches, keyed by OID (hex). */
export type ObjectByOid = (oidHex: string) => Promise<GitObject> | GitObject

/**
 * Decode the object at pack-absolute `absOff`, where `buf[0]` corresponds to pack-absolute
 * `baseAddr`. Recurses into earlier OFS bases within `buf`. `refResolver` (may be null in
 * a span read) resolves REF_DELTA bases by OID.
 */
function decodeAt(
  buf: Uint8Array,
  baseAddr: number,
  absOff: number,
  refResolver: ((oidHex: string) => GitObject) | null,
  maxBytes: number,
  baseMax: number,
): GitObject {
  const pos = absOff - baseAddr
  const h = parseObjHeader(buf, pos)
  switch (h.type) {
    case T_COMMIT:
    case T_TREE:
    case T_BLOB:
    case T_TAG: {
      const data = inflateZlib(buf, h.after, h.size, maxBytes)
      return { type: typeFromCode(h.type), bytes: data }
    }
    case T_OFS_DELTA: {
      const [rel, dpos] = parseOfsBase(buf, h.after)
      const baseAbs = absOff - rel
      const base = decodeAt(buf, baseAddr, baseAbs, refResolver, baseMax, baseMax)
      return { type: base.type, bytes: inflateDelta(base.bytes, buf, dpos, h.size, maxBytes) }
    }
    case T_REF_DELTA: {
      if (refResolver === null) {
        throw new Error('REF_DELTA in a span read (pack is not self-contained/OFS-only)')
      }
      const oid = bytesToHex(buf.subarray(h.after, h.after + 20))
      const base = refResolver(oid)
      return { type: base.type, bytes: inflateDelta(base.bytes, buf, h.after + 20, h.size, maxBytes) }
    }
    default:
      throw new Error(`unknown pack object type ${h.type}`)
  }
}

/** git OID of an object: `sha1("<type> <len>\0" + payload)`, hex. */
export function gitOidHex(type: GitObjType, payload: Uint8Array): string {
  const prefix = new TextEncoder().encode(`${headerKeyword(type)} ${payload.length}\0`)
  const buf = new Uint8Array(prefix.length + payload.length)
  buf.set(prefix, 0)
  buf.set(payload, prefix.length)
  return bytesToHex(sha1(buf))
}
