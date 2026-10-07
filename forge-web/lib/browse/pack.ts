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

/** Past this an OFS distance is no pack offset (and the next step would lose precision). */
const OFS_MAX = 2 ** 46

/**
 * Parse an OFS_DELTA base back-pointer varint. Returns `[rel_offset, pos_after]`. A base sits
 * before its delta, so a distance of 0 (the delta itself) is refused, as git refuses it.
 */
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
    // Arithmetic, not `<<`: a long varint must not wrap round to a small or negative distance.
    ofs = (ofs + 1) * 128 + (c & 0x7f)
    if (ofs > OFS_MAX) throw new Error('OFS base offset out of range')
  }
  if (ofs === 0) throw new Error('OFS base offset 0 names the delta itself')
  return [ofs, p]
}

/**
 * The longest delta chain a reader follows. git clamps `pack.depth` to 4095, and the packs a
 * push stores are `git pack-objects` output at the pusher's `pack.depth`, so a longer chain (or
 * a cycle) is a hostile pack. forge-core's pack parser uses the same bound.
 */
export const DELTA_DEPTH_MAX = 4095

/**
 * The most bytes one decode (an inflated object or delta, or a delta's result) may take when
 * its caller sets no tighter limit. No git or Forge rule bounds an object's size, but a tab
 * cannot hold much past this, while a few KiB of hostile pack can declare far more.
 */
export const DECODE_MAX_BYTES = 1024 * 1024 * 1024

/** An object (or a delta-chain step) is larger than the caller's `maxBytes`: it was not inflated. */
export class ObjectTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
    message = `object is ${size} bytes, over the ${maxBytes}-byte limit`,
  ) {
    super(message)
    this.name = 'ObjectTooLargeError'
  }
}

/**
 * A delta chain no honest pack holds: one that loops back on itself or runs past
 * {@link DELTA_DEPTH_MAX}, or a read that took too many steps. Where the chain was entered decides
 * it as much as the entry does, so it says nothing about the entry read on another path.
 */
export class DeltaChainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeltaChainError'
  }
}

/**
 * A read built more than its {@link BuildBudget}: what it built before says as much as the
 * entry it stopped at, so it says nothing about that entry read on another path.
 */
export class BuildBudgetError extends ObjectTooLargeError {
  constructor(built: number, max: number) {
    super(built, max, `reading this object built ${built} bytes, over the ${max}-byte limit`)
    this.name = 'BuildBudgetError'
  }
}

/** The least a read may build however small its limit: 4095 steps of 64 KiB, git's deepest chain of small objects. */
const BUILD_FLOOR_BYTES = 256 * 1024 * 1024

/**
 * The most bytes one read may build across its whole delta chain: every inflate and every
 * delta result, added up. Each step is bounded ({@link DECODE_MAX_BYTES}), but a chain of 4095
 * of them is not. 64 steps of the largest base the read allows ({@link baseMaxBytes}) cover
 * git's default `pack.depth` of 50 even when every base is that large; the floor lets small
 * objects use the whole depth git allows. No read builds more than 2 decodes' worth, the most
 * one step needs (a delta's largest base, then its largest result): a tab that holds that has
 * little left, and a read with no limit of its own would otherwise get 64 times it.
 */
export function buildMaxBytes(maxBytes: number): number {
  return Math.min(2 * DECODE_MAX_BYTES, Math.max(64 * baseMaxBytes(maxBytes), BUILD_FLOOR_BYTES))
}

/** What one read has built so far, against its {@link buildMaxBytes}. */
export class BuildBudget {
  private built = 0

  constructor(readonly max: number) {}

  /** Count `bytes` about to be built, before they are allocated; past the budget, the read fails instead. */
  spend(bytes: number): void {
    if (this.built + bytes > this.max) throw new BuildBudgetError(this.built + bytes, this.max)
    this.built += bytes
  }
}

/**
 * Deflate cannot expand input by more than this factor (a 258-byte match per ~2 bits).
 * forge-core's pack parser bounds its inflates by the same factor.
 */
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
export function inflateZlib(buf: Uint8Array, from: number, expected: number, maxBytes = Infinity, budget?: BuildBudget): Uint8Array {
  return inflateStream(buf, from, expected, maxBytes, true, budget).bytes
}

/**
 * {@link inflateZlib}, also saying how many input bytes the stream took (`consumed`): where the
 * next pack entry starts. Only a stream that ended counts: one cut short throws.
 */
export function inflateZlibMeasured(buf: Uint8Array, from: number, expected: number, maxBytes = Infinity): { readonly bytes: Uint8Array; readonly consumed: number } {
  const { bytes, inflater } = inflateStream(buf, from, expected, maxBytes)
  return { bytes, consumed: measured(inflater) }
}

/** The input bytes a finished stream took; one cut short throws. */
function measured(inflater: Inflate): number {
  // pako keeps zlib's stream state; its typings leave it out.
  const state = inflater as unknown as { readonly ended?: boolean; readonly strm?: { readonly total_in?: number } }
  const consumed = state.strm?.total_in
  if (state.ended !== true || consumed === undefined) throw new Error('inflate size mismatch')
  return consumed
}

/**
 * How many input bytes the zlib stream at `buf[from..]` takes, inflating it to exactly
 * `expected` bytes ({@link inflateZlibMeasured}'s checks) without keeping them: for a scan
 * that only needs to know where the next pack entry starts.
 */
export function zlibStreamLength(buf: Uint8Array, from: number, expected: number, maxBytes = Infinity): number {
  return measured(inflateStream(buf, from, expected, maxBytes, false).inflater)
}

function inflateStream(
  buf: Uint8Array,
  from: number,
  expected: number,
  maxBytes: number,
  keep = true,
  /** Charged `expected` before it is allocated. */
  budget?: BuildBudget,
): { readonly bytes: Uint8Array; readonly inflater: Inflate } {
  const limit = Math.min(maxBytes, DECODE_MAX_BYTES)
  if (expected > limit) throw new ObjectTooLargeError(expected, limit)
  const input = buf.subarray(from)
  if (expected > input.length * DEFLATE_MAX_RATIO + 64) throw new Error('inflate size mismatch')
  budget?.spend(expected)
  const out = new Uint8Array(keep ? expected : 0)
  let got = 0
  // windowBits 15: zlib only (no gzip or raw-deflate detection).
  // A small object needs no 64 KiB output chunk (one past `expected` still catches an overrun).
  const inflater = new Inflate({ chunkSize: Math.min(INFLATE_CHUNK, expected + 1), windowBits: 15 })
  inflater.onData = (chunk: Uint8Array) => {
    if (got + chunk.length > expected) throw new Error('inflate size mismatch')
    if (keep) out.set(chunk, got)
    got += chunk.length
  }
  inflater.onEnd = () => {}
  inflater.push(input, true)
  if (inflater.err !== 0 || got !== expected) throw new Error('inflate size mismatch')
  return { bytes: out, inflater }
}

/** Stops a prefix inflate once it has what it wants. */
class PrefixDone extends Error {}

/**
 * The first `want` bytes a zlib stream at `buf[from..]` inflates to (fewer when the stream, or
 * `buf`, ends first): enough to sniff an object too large to read whole, without inflating the
 * rest. `buf` may stop mid-stream. Nothing here is hash-checked: a caller only classifies.
 */
export function inflatePrefix(buf: Uint8Array, from: number, want: number): Uint8Array {
  // pako never returns from a push with a zero-byte output chunk.
  if (!(want > 0)) return new Uint8Array(0)
  const out = new Uint8Array(want)
  let got = 0
  const inflater = new Inflate({ chunkSize: Math.min(INFLATE_CHUNK, want), windowBits: 15 })
  inflater.onData = (chunk: Uint8Array) => {
    const take = Math.min(chunk.length, want - got)
    out.set(chunk.subarray(0, take), got)
    got += take
    if (got >= want) throw new PrefixDone()
  }
  inflater.onEnd = () => {}
  try {
    inflater.push(buf.subarray(from), false)
  } catch (e) {
    if (!(e instanceof PrefixDone)) throw e
  }
  return out.subarray(0, got)
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
 * `budget` is charged the result, before it is allocated.
 */
export function inflateDelta(base: Uint8Array, buf: Uint8Array, from: number, size: number, maxBytes = Infinity, budget?: BuildBudget): Uint8Array {
  return applyDelta(base, inflateZlib(buf, from, size, deltaMaxBytes(maxBytes)), maxBytes, budget)
}

/**
 * Apply a git delta (`src_size, dst_size, [copy|insert]*`) to `base`. A `dst_size` over
 * `maxBytes` is refused before anything is allocated: a few KiB of copy opcodes can ask for
 * gigabytes. So is one the instructions do not build: they are sized before `dst_size` bytes
 * are reserved for them, and charged to `budget`.
 */
export function applyDelta(base: Uint8Array, delta: Uint8Array, maxBytes = Infinity, budget?: BuildBudget): Uint8Array {
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
  const limit = Math.min(maxBytes, DECODE_MAX_BYTES)
  if (dst > limit) throw new ObjectTooLargeError(dst, limit)
  if (runDelta(base, delta, pos, null) !== dst) throw new Error('delta output size mismatch')
  budget?.spend(dst)
  const out = new Uint8Array(dst)
  runDelta(base, delta, pos, out)
  return out
}

/**
 * Run `delta`'s instructions from `pos` against `base`, writing into `out` (or, when null, only
 * checking and counting them). Returns how many bytes they build.
 */
function runDelta(base: Uint8Array, delta: Uint8Array, pos: number, out: Uint8Array | null): number {
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
      out?.set(base.subarray(cpOff, end), outPos)
      outPos += cpSize
    } else if (op !== 0) {
      const n = op
      const end = pos + n
      if (end > delta.length) throw new Error('delta insert past end')
      out?.set(delta.subarray(pos, end), outPos)
      outPos += n
      pos = end
    } else {
      throw new Error('reserved delta opcode 0')
    }
  }
  return outPos
}

/**
 * Reconstruct a git object from ONLY the contiguous `deltaChainSpan` slice — the
 * browse-plane single-read path.
 *
 * `spanSlice` must be exactly the pack bytes `[end - deltaChainSpan, end)` where
 * `end = offset + length`. Follows (earlier, in-slice) OFS delta bases in a loop, charging what
 * every step builds to `budget`. REF_DELTA is rejected here (the span model is only valid on
 * self-contained, all-OFS packs).
 */
export function reconstructFromSpan(
  loc: { offset: number; length: number; deltaChainSpan: number },
  spanSlice: Uint8Array,
  maxBytes = Infinity,
  baseMax = baseMaxBytes(maxBytes),
  budget = new BuildBudget(buildMaxBytes(maxBytes)),
  /** Called for each entry of the chain before it is decoded: a reader counts its steps. */
  step: () => void = () => {},
): GitObject {
  const end = loc.offset + loc.length
  const baseAddr = end - loc.deltaChainSpan
  if (spanSlice.length !== loc.deltaChainSpan) throw new Error('span slice length mismatch')
  return decodeAt(spanSlice, baseAddr, loc.offset, null, maxBytes, baseMax, budget, step)
}

/** A resolver for REF_DELTA bases / per-base fetches, keyed by OID (hex). */
export type ObjectByOid = (oidHex: string) => Promise<GitObject> | GitObject

/**
 * Decode the object at pack-absolute `absOff`, where `buf[0]` corresponds to pack-absolute
 * `baseAddr`. Follows earlier OFS bases within `buf` down to the chain's root, then applies the
 * deltas back up: a loop, so a chain as deep as git allows ({@link DELTA_DEPTH_MAX}) needs no
 * stack, and a deeper one is refused. `refResolver` (may be null in a span read) resolves
 * REF_DELTA bases by OID. The object is bounded by `maxBytes`, every base by `baseMax`, and
 * everything built together by `budget`.
 */
function decodeAt(
  buf: Uint8Array,
  baseAddr: number,
  absOff: number,
  refResolver: ((oidHex: string) => GitObject) | null,
  maxBytes: number,
  baseMax: number,
  budget: BuildBudget,
  step: () => void,
): GitObject {
  /** The deltas met on the way down, the object's first: each one's stream and limit. */
  const deltas: { readonly pos: number; readonly size: number; readonly limit: number }[] = []
  let at = absOff
  let limit = maxBytes
  let base: GitObject
  for (;;) {
    if (deltas.length > DELTA_DEPTH_MAX) throw new DeltaChainError(`delta chain is over ${DELTA_DEPTH_MAX} deep`)
    step()
    const h = parseObjHeader(buf, at - baseAddr)
    if (h.type === T_COMMIT || h.type === T_TREE || h.type === T_BLOB || h.type === T_TAG) {
      base = { type: typeFromCode(h.type), bytes: inflateZlib(buf, h.after, h.size, limit, budget) }
      break
    }
    if (h.type === T_OFS_DELTA) {
      const [rel, dpos] = parseOfsBase(buf, h.after)
      deltas.push({ pos: dpos, size: h.size, limit })
      // Strictly earlier (rel > 0) and inside the slice, so every step moves back: no cycle.
      at -= rel
      if (at < baseAddr) throw new Error(`OFS base at ${at} is outside the span`)
      limit = baseMax
      continue
    }
    if (h.type === T_REF_DELTA) {
      if (refResolver === null) {
        throw new Error('REF_DELTA in a span read (pack is not self-contained/OFS-only)')
      }
      deltas.push({ pos: h.after + 20, size: h.size, limit })
      base = refResolver(bytesToHex(buf.subarray(h.after, h.after + 20)))
      break
    }
    throw new Error(`unknown pack object type ${h.type}`)
  }
  for (let i = deltas.length - 1; i >= 0; i--) {
    const d = deltas[i] as (typeof deltas)[number]
    base = { type: base.type, bytes: inflateDelta(base.bytes, buf, d.pos, d.size, d.limit, budget) }
  }
  return base
}

/** git OID of an object: `sha1("<type> <len>\0" + payload)`, hex. */
export function gitOidHex(type: GitObjType, payload: Uint8Array): string {
  const prefix = new TextEncoder().encode(`${headerKeyword(type)} ${payload.length}\0`)
  const buf = new Uint8Array(prefix.length + payload.length)
  buf.set(prefix, 0)
  buf.set(payload, prefix.length)
  return bytesToHex(sha1(buf))
}
