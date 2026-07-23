/**
 * Client-side pack indexer — the browser's `git index-pack` (the fallback clone path).
 *
 * When a repo has no published objectLocator, the webapp downloads its live kind-0 packs
 * whole and indexes them here: a sequential scan discovers every object's offset (pass 1),
 * a global fixpoint resolve decodes delta chains to compute each OID (pass 2), and
 * {@link serializeLocator} emits a real `fanout || rows` locator so the ordinary
 * {@link ObjectLocator} + BrowseReader path serves all reads unchanged. Every row is
 * written with `deltaChainSpan = SPAN_SENTINEL`, routing reads through the per-base walk —
 * correct for every object type, and the span optimization is moot against an in-memory
 * {@link memoryPackSource}.
 *
 * The scan needs the exact compressed length of each object's zlib stream (to find the
 * next offset); fflate cannot report consumed input bytes, so this module — and only this
 * module — uses pako, whose `strm.next_in` exposes the stream end. Keep it behind a
 * dynamic import so pako stays out of the main-route bundles.
 */

import { Inflate } from 'pako'
import { sha1 } from '@noble/hashes/legacy.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { FANOUT_LEN, LOCATOR_ROW_LEN, OID_LEN, SPAN_SENTINEL } from './locator'
import {
  type GitObject,
  PACK_TYPE,
  applyDelta,
  gitOidHex,
  inflateZlib,
  objTypeFromCode,
  parseObjHeader,
  parseOfsBase,
} from './pack'
import type { PackSource } from './reader'

const PACK_HEADER_LEN = 12
const PACK_TRAILER_LEN = 20

export interface InflateResult {
  readonly data: Uint8Array
  /** Compressed bytes consumed from `buf[from..]` — the stream's exact on-disk length. */
  readonly consumed: number
}

/** Inflate one zlib stream at `buf[from..]`, ignoring trailing pack bytes. */
export function inflateWithConsumed(buf: Uint8Array, from: number): InflateResult {
  const inf = new Inflate()
  inf.push(buf.subarray(from), true)
  if (inf.err !== 0 || !inf.ended || !(inf.result instanceof Uint8Array)) {
    throw new Error(`inflate failed at ${from}: ${inf.msg !== '' ? inf.msg : `err ${inf.err}`}`)
  }
  // pako's zlib stream state is not in @types/pako, but next_in is stable public state.
  const consumed = (inf as unknown as { strm: { next_in: number } }).strm.next_in
  return { data: inf.result, consumed }
}

/** One object discovered by the sequential scan (pass 1). */
export interface ScanRecord {
  /** Pack-absolute byte offset of the object. */
  readonly offset: number
  /** On-disk length (header + base pointer + compressed stream). */
  readonly length: number
  /** Raw pack type code ({@link PACK_TYPE}). */
  readonly typeCode: number
  /** Pack-absolute start of the object's zlib stream (after header + base pointer). */
  readonly dataPos: number
  /** Inflated size from the object header. */
  readonly size: number
  /** OFS_DELTA only: pack-absolute offset of the base object. */
  readonly ofsBaseOffset?: number
  /** REF_DELTA only: base OID, hex. */
  readonly refBaseOid?: string
}

/**
 * Sequentially scan a whole pack (`PACK` v2 frame): validate the header, walk all objects
 * discovering their offsets/lengths, and verify the terminal offset and sha1 trailer.
 */
export function scanPack(pack: Uint8Array): ScanRecord[] {
  if (pack.length < PACK_HEADER_LEN + PACK_TRAILER_LEN) throw new Error('pack too short')
  if (pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) {
    throw new Error('bad pack magic')
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.length)
  const version = view.getUint32(4, false)
  if (version !== 2) throw new Error(`unsupported pack version ${version}`)
  const count = view.getUint32(8, false)

  const records: ScanRecord[] = []
  let offset = PACK_HEADER_LEN
  for (let i = 0; i < count; i++) {
    const h = parseObjHeader(pack, offset)
    let dataPos = h.after
    let ofsBaseOffset: number | undefined
    let refBaseOid: string | undefined
    if (h.type === PACK_TYPE.OFS_DELTA) {
      const [rel, p] = parseOfsBase(pack, h.after)
      ofsBaseOffset = offset - rel
      // A base must sit strictly earlier — also rules out self-reference cycles.
      if (ofsBaseOffset < PACK_HEADER_LEN || ofsBaseOffset >= offset) {
        throw new Error(`OFS base out of bounds at ${offset}`)
      }
      dataPos = p
    } else if (h.type === PACK_TYPE.REF_DELTA) {
      refBaseOid = bytesToHex(pack.subarray(h.after, h.after + OID_LEN))
      dataPos = h.after + OID_LEN
    }
    const { data, consumed } = inflateWithConsumed(pack, dataPos)
    if (data.length !== h.size) throw new Error(`inflate size mismatch at offset ${offset}`)
    const end = dataPos + consumed
    records.push({ offset, length: end - offset, typeCode: h.type, dataPos, size: h.size, ofsBaseOffset, refBaseOid })
    offset = end
  }

  if (offset !== pack.length - PACK_TRAILER_LEN) {
    throw new Error(`pack scan ended at ${offset}, expected ${pack.length - PACK_TRAILER_LEN}`)
  }
  const trailer = bytesToHex(pack.subarray(offset))
  const computed = bytesToHex(sha1(pack.subarray(0, offset)))
  if (trailer !== computed) throw new Error('pack sha1 trailer mismatch')
  return records
}

/** One fully-resolved object: locator-row material. */
export interface IndexedObject {
  readonly oidHex: string
  readonly packRef: number
  readonly offset: number
  readonly length: number
  readonly deltaDepth: number
}

interface Resolved {
  readonly obj: GitObject
  readonly depth: number
}

/** Yield to the event loop so progress UI can paint during long resolves. */
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const YIELD_EVERY = 500

/**
 * Index packs globally (pass 2): resolve every delta chain to compute each object's OID.
 * OFS bases resolve by offset within the same pack; REF bases by OID across all packs via
 * a fixpoint loop (a later pack may REF an object stored in an earlier one). Decoded
 * objects are memoized in full for the duration of the call — peak memory is roughly the
 * repo's decompressed size, transient; an LRU-by-byte-budget with re-decode is the escape
 * hatch if externally-stored repos outgrow this.
 */
export async function indexPacks(
  packs: readonly Uint8Array[],
  onProgress?: (objectsIndexed: number, objectsTotal: number) => void,
): Promise<IndexedObject[]> {
  interface Site {
    readonly packRef: number
    readonly rec: ScanRecord
  }
  const perPack = packs.map((p) => scanPack(p))
  const byOffset = perPack.map((recs) => new Map(recs.map((r) => [r.offset, r])))
  const totalObjects = perPack.reduce((s, recs) => s + recs.length, 0)
  onProgress?.(0, totalObjects)

  const memo = new Map<ScanRecord, Resolved>()
  const byOid = new Map<string, Resolved>()
  const out: IndexedObject[] = []
  const seenOid = new Set<string>()
  let sinceYield = 0

  // Resolve a record's full chain, or return null when blocked on a REF base whose
  // object has not been registered yet (retried by the fixpoint loop below).
  const tryResolve = (packRef: number, rec: ScanRecord): Resolved | null => {
    const hit = memo.get(rec)
    if (hit !== undefined) return hit
    const pack = packs[packRef] as Uint8Array
    let res: Resolved
    if (rec.typeCode === PACK_TYPE.OFS_DELTA || rec.typeCode === PACK_TYPE.REF_DELTA) {
      let base: Resolved | null
      if (rec.typeCode === PACK_TYPE.OFS_DELTA) {
        const baseRec = byOffset[packRef]?.get(rec.ofsBaseOffset as number)
        if (baseRec === undefined) throw new Error(`OFS base at ${rec.ofsBaseOffset} is not an object boundary`)
        base = tryResolve(packRef, baseRec)
      } else {
        base = byOid.get(rec.refBaseOid as string) ?? null
      }
      if (base === null) return null
      const delta = inflateZlib(pack, rec.dataPos, rec.size)
      res = { obj: { type: base.obj.type, bytes: applyDelta(base.obj.bytes, delta) }, depth: base.depth + 1 }
    } else {
      res = { obj: { type: objTypeFromCode(rec.typeCode), bytes: inflateZlib(pack, rec.dataPos, rec.size) }, depth: 0 }
    }
    memo.set(rec, res)
    const oidHex = gitOidHex(res.obj.type, res.obj.bytes)
    byOid.set(oidHex, res)
    if (!seenOid.has(oidHex)) {
      seenOid.add(oidHex)
      out.push({ oidHex, packRef, offset: rec.offset, length: rec.length, deltaDepth: res.depth })
    }
    return res
  }

  let pending: Site[] = perPack.flatMap((recs, packRef) => recs.map((rec) => ({ packRef, rec })))
  while (pending.length > 0) {
    const next: Site[] = []
    for (const site of pending) {
      if (tryResolve(site.packRef, site.rec) === null) next.push(site)
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0
        onProgress?.(memo.size, totalObjects)
        await yieldToUI()
      }
    }
    if (next.length === pending.length) {
      const missing = next[0]?.rec.refBaseOid ?? 'unknown'
      throw new Error(`REF_DELTA base not found in live packs: ${missing}`)
    }
    pending = next
  }
  onProgress?.(totalObjects, totalObjects)
  return out
}

/**
 * Serialize indexed objects as a real objectLocator (`fanout || rows`) for
 * `ObjectLocator.parse`. Every row carries `deltaChainSpan = SPAN_SENTINEL` (see module
 * doc) and the true chain depth clamped to u8.
 */
export function serializeLocator(objects: readonly IndexedObject[]): Uint8Array {
  const sorted = [...objects].sort((a, b) => (a.oidHex < b.oidHex ? -1 : a.oidHex > b.oidHex ? 1 : 0))
  const bytes = new Uint8Array(FANOUT_LEN + sorted.length * LOCATOR_ROW_LEN)
  const view = new DataView(bytes.buffer)

  const counts = new Array<number>(256).fill(0)
  for (const o of sorted) {
    const first = parseInt(o.oidHex.slice(0, 2), 16)
    counts[first] = (counts[first] as number) + 1
  }
  let cum = 0
  for (let i = 0; i < 256; i++) {
    cum += counts[i] as number
    view.setUint32(i * 4, cum, false)
  }

  let at = FANOUT_LEN
  for (const o of sorted) {
    for (let i = 0; i < OID_LEN; i++) {
      bytes[at + i] = parseInt(o.oidHex.slice(i * 2, i * 2 + 2), 16)
    }
    view.setUint16(at + OID_LEN, o.packRef, false)
    let off = o.offset
    for (let k = 4; k >= 0; k--) {
      bytes[at + OID_LEN + 2 + k] = off & 0xff
      off = Math.floor(off / 256)
    }
    view.setUint32(at + OID_LEN + 7, o.length, false)
    view.setUint32(at + OID_LEN + 11, SPAN_SENTINEL, false)
    bytes[at + OID_LEN + 15] = Math.min(o.deltaDepth, 255)
    at += LOCATOR_ROW_LEN
  }
  return bytes
}

/** A {@link PackSource} over fully-downloaded in-memory packs (packRef = array index). */
export function memoryPackSource(packs: readonly Uint8Array[]): PackSource {
  return {
    fetchRange: (packRef, start, end) => {
      const pack = packs[packRef]
      if (pack === undefined) throw new Error(`packRef ${packRef} out of range`)
      if (start < 0 || end > pack.length || start > end) {
        throw new Error(`range [${start}, ${end}) out of pack bounds`)
      }
      return Promise.resolve(pack.subarray(start, end))
    },
  }
}
