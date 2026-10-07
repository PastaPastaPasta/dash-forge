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
 * next offset): {@link zlibStreamLength} inflates it to the size its header declares, and no
 * further, without keeping the bytes.
 *
 * A pack is the pusher's bytes, and a 2 MiB one opens without asking, so both passes are
 * bounded: every inflate and delta by the size it declares, all of them together by
 * {@link INDEX_DECODE_MAX_BYTES}, and every chain by {@link DELTA_DEPTH_MAX}.
 */

import { sha1 } from '@noble/hashes/legacy.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { FANOUT_LEN, LOCATOR_ROW_LEN, OID_LEN, SPAN_SENTINEL } from './locator'
import {
  type GitObject,
  DECODE_MAX_BYTES,
  DELTA_DEPTH_MAX,
  ObjectTooLargeError,
  PACK_TYPE,
  applyDelta,
  gitOidHex,
  inflateZlib,
  objTypeFromCode,
  parseObjHeader,
  parseOfsBase,
  zlibStreamLength,
} from './pack'
import type { PackSource } from './reader'

const PACK_HEADER_LEN = 12
const PACK_TRAILER_LEN = 20

/**
 * The most bytes each pass of an index build decodes by default, all objects together: the
 * scan inflates every stream once, and the resolve holds every object it decodes until the
 * index is built ({@link DECODE_MAX_BYTES}). A caller that did not ask the user first passes
 * a smaller budget.
 */
export const INDEX_DECODE_MAX_BYTES = DECODE_MAX_BYTES

/** The packs decode to more than the budget {@link indexPacks} was given: nothing was indexed. */
export class IndexTooLargeError extends Error {
  constructor(readonly budget: number) {
    super(`the packs decode to more than ${budget} bytes`)
    this.name = 'IndexTooLargeError'
  }
}

/** What a pass may still decode, of {@link INDEX_DECODE_MAX_BYTES}. */
export interface DecodeBudget {
  left: number
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
 * discovering their offsets/lengths, and verify the terminal offset and sha1 trailer. Every
 * stream's declared size is charged to `budget` before it is inflated.
 */
export function scanPack(pack: Uint8Array, budget: DecodeBudget = { left: INDEX_DECODE_MAX_BYTES }): ScanRecord[] {
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
    let consumed: number
    try {
      consumed = zlibStreamLength(pack, dataPos, h.size, budget.left)
    } catch (e) {
      if (e instanceof ObjectTooLargeError) throw e
      throw new Error(`inflate failed at ${dataPos}: ${e instanceof Error ? e.message : String(e)}`)
    }
    budget.left -= h.size
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
 * OFS bases resolve by offset within the same pack; REF bases by OID across all packs (a later
 * pack may REF an object stored in an earlier one): an object blocked on a REF base waits for
 * that OID and is resolved again once it is, so each object is tried at most twice. Decoded
 * objects are memoized in full for the duration of the call — peak memory is roughly the
 * repo's decompressed size, transient, and at most `budget` ({@link IndexTooLargeError} past it).
 */
export async function indexPacks(
  packs: readonly Uint8Array[],
  onProgress?: (objectsIndexed: number, objectsTotal: number) => void,
  budget = INDEX_DECODE_MAX_BYTES,
): Promise<IndexedObject[]> {
  try {
    return await resolvePacks(packs, onProgress, budget)
  } catch (e) {
    if (e instanceof ObjectTooLargeError) throw new IndexTooLargeError(budget)
    throw e
  }
}

async function resolvePacks(
  packs: readonly Uint8Array[],
  onProgress: ((objectsIndexed: number, objectsTotal: number) => void) | undefined,
  budget: number,
): Promise<IndexedObject[]> {
  interface Site {
    readonly packRef: number
    readonly rec: ScanRecord
  }
  const scanned: DecodeBudget = { left: budget }
  const perPack = packs.map((p) => scanPack(p, scanned))
  const byOffset = perPack.map((recs) => new Map(recs.map((r) => [r.offset, r])))
  const totalObjects = perPack.reduce((s, recs) => s + recs.length, 0)
  onProgress?.(0, totalObjects)

  const memo = new Map<ScanRecord, Resolved>()
  const byOid = new Map<string, Resolved>()
  const held: DecodeBudget = { left: budget }
  const out: IndexedObject[] = []
  // Keyed by (packRef, oid), NOT by oid. An object routinely sits in more than one live
  // pack, and each copy's row is the only record of THAT pack's address for it. The reader
  // resolves an OFS_DELTA base by (packRef, offset) through `buildOffsetIndex`, and the
  // base of an object in pack N is always in pack N — so dropping pack N's row because
  // pack 0 also carried the object makes every delta in pack N that uses it unreadable.
  // Every row here carries SPAN_SENTINEL, so that walk is the ONLY read path this locator
  // offers. Parity: forge-core `pack::ObjectLocator::merge`.
  const seenSite = new Set<string>()
  let sinceYield = 0

  const queue: Site[] = perPack.flatMap((recs, packRef) => recs.map((rec) => ({ packRef, rec })))
  /** Sites blocked on a REF base, by the base's OID: queued again once it resolves. */
  const waiting = new Map<string, Site[]>()
  /**
   * Records whose chain is blocked, and the OID it waits for: an OFS delta on top of one is
   * blocked too, at once, rather than walking the chain down again.
   */
  const blockedOn = new Map<ScanRecord, string>()

  // Resolve a record's full chain, or return the OID of the REF base it is blocked on, whose
  // object has not been resolved yet. `depth`: OFS steps taken to reach `rec`.
  const tryResolve = (packRef: number, rec: ScanRecord, depth = 0): Resolved | string => {
    const hit = memo.get(rec)
    if (hit !== undefined) return hit
    const waitsFor = blockedOn.get(rec)
    if (waitsFor !== undefined && !byOid.has(waitsFor)) return waitsFor
    if (depth > DELTA_DEPTH_MAX) throw new Error(`delta chain at ${rec.offset} is over ${DELTA_DEPTH_MAX} deep`)
    const pack = packs[packRef] as Uint8Array
    let res: Resolved
    if (rec.typeCode === PACK_TYPE.OFS_DELTA || rec.typeCode === PACK_TYPE.REF_DELTA) {
      let base: Resolved | string
      if (rec.typeCode === PACK_TYPE.OFS_DELTA) {
        const baseRec = byOffset[packRef]?.get(rec.ofsBaseOffset as number)
        if (baseRec === undefined) throw new Error(`OFS base at ${rec.ofsBaseOffset} is not an object boundary`)
        base = tryResolve(packRef, baseRec, depth + 1)
      } else {
        base = byOid.get(rec.refBaseOid as string) ?? (rec.refBaseOid as string)
      }
      if (typeof base === 'string') {
        blockedOn.set(rec, base)
        return base
      }
      if (base.depth >= DELTA_DEPTH_MAX) throw new Error(`delta chain at ${rec.offset} is over ${DELTA_DEPTH_MAX} deep`)
      // The scan inflated this delta to its declared size, within the budget.
      const delta = inflateZlib(pack, rec.dataPos, rec.size)
      res = { obj: { type: base.obj.type, bytes: applyDelta(base.obj.bytes, delta, held.left) }, depth: base.depth + 1 }
    } else {
      res = { obj: { type: objTypeFromCode(rec.typeCode), bytes: inflateZlib(pack, rec.dataPos, rec.size, held.left) }, depth: 0 }
    }
    held.left -= res.obj.bytes.length
    memo.set(rec, res)
    const oidHex = gitOidHex(res.obj.type, res.obj.bytes)
    byOid.set(oidHex, res)
    const ready = waiting.get(oidHex)
    if (ready !== undefined) {
      waiting.delete(oidHex)
      for (const site of ready) queue.push(site)
    }
    const site = `${packRef}:${oidHex}`
    if (!seenSite.has(site)) {
      seenSite.add(site)
      out.push({ oidHex, packRef, offset: rec.offset, length: rec.length, deltaDepth: res.depth })
    }
    return res
  }

  for (let at = 0; at < queue.length; at++) {
    const site = queue[at] as Site
    const blocked = tryResolve(site.packRef, site.rec)
    if (typeof blocked === 'string') {
      const sites = waiting.get(blocked)
      if (sites === undefined) waiting.set(blocked, [site])
      else sites.push(site)
    }
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0
      onProgress?.(memo.size, totalObjects)
      await yieldToUI()
    }
  }
  if (waiting.size > 0) {
    const missing = waiting.keys().next().value as string
    throw new Error(`REF_DELTA base not found in live packs: ${missing}`)
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
  // Sorted by (oid, packRef), the order `ObjectLocator` requires: an OID can have one row
  // per pack that stores it, and `lookup` finds the lowest-packRef row by walking back to
  // the first of the adjacent group.
  const sorted = [...objects].sort((a, b) =>
    a.oidHex < b.oidHex ? -1 : a.oidHex > b.oidHex ? 1 : a.packRef - b.packRef,
  )
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
    sizeOf: (packRef) => packs[packRef]?.length,
  }
}
