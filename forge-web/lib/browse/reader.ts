/**
 * Browse-plane reader — the size-independent object-access layer.
 *
 * Ties {@link ObjectLocator} lookup to ranged pack fetches and pack reconstruction:
 * given a repo's locator + a way to fetch pack byte ranges, recover any single git object
 * (blob / tree / commit) without materializing the repo.
 *
 *   1. locator.lookup(oid) → {packRef, offset, length, deltaChainSpan, deltaDepth}
 *   2. blob (contiguous span ≤ threshold): fetch `[end-span, end)` once → reconstruct
 *   3. tree / deep-delta (sentinel or oversized span): per-base walk — fetch each object's
 *      own slice and resolve OFS bases via the locator's offset index
 *
 * The pack bytes come from wherever the manifest points (a backend URI honoring HTTP
 * Range, or platform `chunk` documents reassembled by seq) — modeled as {@link PackSource}.
 */

import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'

import { FlatIndex } from './flatindex'
import { type LocatorEntry, ObjectLocator, offsetKey, singleReadAdvised } from './locator'
import {
  type GitObject,
  PACK_TYPE,
  applyDelta,
  gitOidHex,
  inflateZlib,
  objTypeFromCode,
  parseObjHeader,
  parseOfsBase,
  reconstructFromSpan,
} from './pack'

/**
 * Fetches pack byte ranges. `packRef` indexes the manifest's pack list; a reader maps it
 * to a concrete pack (external URI via Range, or platform chunks reassembled by seq).
 */
export interface PackSource {
  /**
   * Return pack `packRef` bytes `[start, end)`, from copy `copy` (default 0) when the pack
   * has several (forge-v2: one per writer, `forge-v2.md` §4).
   */
  fetchRange(packRef: number, start: number, end: number, copy?: number): Promise<Uint8Array>
  /** How many copies pack `packRef` has (default 1). */
  copyCount?(packRef: number): number
}

/** What happened to one reconstructed object's hash check. */
export type ObjectVerdict = 'verified' | 'unchecked' | 'failed'

export interface BrowseReaderOptions {
  /** Verify the reconstructed object hashes to the requested OID (default true). */
  readonly verify?: boolean
  /**
   * Told the outcome of every fresh reconstruction (memo hits were reported when first
   * read). This is how the UI learns what was actually checked rather than assuming it.
   */
  readonly onObject?: (verdict: ObjectVerdict) => void
  /**
   * The error for an OID the locator does not index. Defaults to `object not in locator`; a
   * reader built over an incomplete pack set supplies one that names what is missing.
   */
  readonly missingObject?: (oidHex: string) => Error
}

/** Per-reader object-memo budget — readers live for the session (cached browse context). */
const OBJECT_CACHE_BUDGET_BYTES = 8 * 1024 * 1024
/** Objects above this size are never memoized (one huge blob must not evict everything). */
const OBJECT_CACHE_MAX_ENTRY_BYTES = 128 * 1024

/**
 * A byte-bounded LRU of reconstructed objects. Safe to share: every cached object was
 * either hash-verified against its OID or decoded from hash-verified pack bytes, and
 * consumers never mutate the returned buffers. Map insertion order is the recency order.
 */
class ObjectLru {
  private readonly map = new Map<string, GitObject>()
  private bytes = 0

  get(key: string): GitObject | undefined {
    const hit = this.map.get(key)
    if (hit !== undefined) {
      this.map.delete(key)
      this.map.set(key, hit)
    }
    return hit
  }

  set(key: string, obj: GitObject): void {
    if (obj.bytes.length > OBJECT_CACHE_MAX_ENTRY_BYTES || this.map.has(key)) return
    this.map.set(key, obj)
    this.bytes += obj.bytes.length
    for (const [k, v] of this.map) {
      if (this.bytes <= OBJECT_CACHE_BUDGET_BYTES) break
      this.map.delete(k)
      this.bytes -= v.bytes.length
    }
  }
}

/** High-level browse reader over one repo's objectLocator + pack source. */
export class BrowseReader {
  private offsetIndex: Map<string, LocatorEntry> | null = null
  /** Verified whole-object memo, keyed by lowercase OID hex. */
  private readonly objectsByOid = new ObjectLru()
  /** Decoded-entry memo keyed `(packRef, offset)` — where repeated delta-base work lands. */
  private readonly objectsByAddr = new ObjectLru()
  /**
   * The copy each pack is read from (forge-v2 packs have one per writer). Starts at the
   * top-ranked copy and moves on only when an object read through it fails to reconstruct or
   * to hash to its oid; the copy that served a verified object is kept.
   */
  private readonly copyOf = new Map<number, number>()

  constructor(
    private readonly locator: ObjectLocator,
    private readonly packs: PackSource,
    private readonly opts: BrowseReaderOptions = {},
  ) {}

  /** Look up a raw locator entry by OID hex (or null if absent). */
  locate(oidHex: string): LocatorEntry | null {
    return this.locator.lookup(hexToBytes(oidHex))
  }

  /**
   * Reconstruct a git object by OID hex. Chooses the single contiguous span read for
   * blobs and the per-base walk for trees / deep-delta chains, as the locator's
   * `deltaChainSpan` hint advises.
   */
  async readObject(oidHex: string): Promise<GitObject> {
    const oidKey = oidHex.toLowerCase()
    const cached = this.objectsByOid.get(oidKey)
    if (cached !== undefined) return cached

    const entry = this.locate(oidHex)
    if (entry === null) {
      throw this.opts.missingObject?.(oidHex) ?? new Error(`object not in locator: ${oidHex}`)
    }

    const obj = await this.readVerified(entry, oidKey)
    this.objectsByOid.set(oidKey, obj)
    return obj
  }

  /**
   * Reconstruct `entry` and check its oid, trying the pack's copies in order: a copy whose
   * bytes do not reconstruct the object (a hostile or corrupt writer copy) is skipped for the
   * next one (`forge-v2.md` §4 "read the first copy that verifies"). A single-copy pack
   * behaves exactly as before.
   */
  private async readVerified(entry: LocatorEntry, oidKey: string): Promise<GitObject> {
    const copies = this.packs.copyCount?.(entry.packRef) ?? 1
    const start = this.copyOf.get(entry.packRef) ?? 0
    let lastErr: unknown
    for (let i = 0; i < copies; i++) {
      const copy = (start + i) % copies
      let obj: GitObject
      try {
        obj = i === 0 ? await this.reconstruct(entry) : await this.reconstructFrom(entry, copy)
      } catch (e) {
        lastErr = e
        continue
      }
      if (this.opts.verify === false) {
        this.opts.onObject?.('unchecked')
        return obj
      }
      const got = gitOidHex(obj.type, obj.bytes)
      if (got === oidKey) {
        this.copyOf.set(entry.packRef, copy)
        this.opts.onObject?.('verified')
        return obj
      }
      lastErr = new Error(`oid mismatch: wanted ${oidKey}, reconstructed ${got}`)
    }
    this.opts.onObject?.('failed')
    throw lastErr
  }

  /** The default path: memoized decode through the pack's current copy. */
  private reconstruct(entry: LocatorEntry): Promise<GitObject> {
    return singleReadAdvised(entry) ? this.readSpan(entry) : this.decodeEntry(entry)
  }

  /**
   * Reconstruct `entry` from one specific copy of its pack, without the address memo (whose
   * entries came from another copy). REF_DELTA bases are other objects and go through
   * {@link readObject}, which verifies them on their own.
   */
  private async reconstructFrom(entry: LocatorEntry, copy: number): Promise<GitObject> {
    if (singleReadAdvised(entry)) {
      const end = entry.offset + entry.length
      const slice = await this.packs.fetchRange(entry.packRef, end - entry.deltaChainSpan, end, copy)
      return reconstructFromSpan(entry, slice)
    }
    const walk = async (e: LocatorEntry): Promise<GitObject> => {
      const self = await this.packs.fetchRange(e.packRef, e.offset, e.offset + e.length, copy)
      const h = parseObjHeader(self, 0)
      switch (h.type) {
        case PACK_TYPE.COMMIT:
        case PACK_TYPE.TREE:
        case PACK_TYPE.BLOB:
        case PACK_TYPE.TAG:
          return { type: objTypeFromCode(h.type), bytes: inflateZlib(self, h.after, h.size) }
        case PACK_TYPE.OFS_DELTA: {
          const [rel, dpos] = parseOfsBase(self, h.after)
          if (this.offsetIndex === null) this.offsetIndex = this.locator.buildOffsetIndex()
          const baseEntry = this.offsetIndex.get(offsetKey(e.packRef, e.offset - rel))
          if (baseEntry === undefined) throw new Error(`base object at pack ${e.packRef} offset ${e.offset - rel} not in locator`)
          const base = await walk(baseEntry)
          return { type: base.type, bytes: applyDelta(base.bytes, inflateZlib(self, dpos, h.size)) }
        }
        case PACK_TYPE.REF_DELTA: {
          const base = await this.readObject(bytesToHex(self.subarray(h.after, h.after + 20)))
          return { type: base.type, bytes: applyDelta(base.bytes, inflateZlib(self, h.after + 20, h.size)) }
        }
        default:
          throw new Error(`unknown pack object type ${h.type}`)
      }
    }
    return walk(entry)
  }

  /** Single contiguous span read (blob path): one ranged fetch, then reconstruct. */
  private async readSpan(entry: LocatorEntry): Promise<GitObject> {
    const end = entry.offset + entry.length
    const start = end - entry.deltaChainSpan
    const slice = await this.packs.fetchRange(entry.packRef, start, end, this.copyOf.get(entry.packRef))
    return reconstructFromSpan(entry, slice)
  }

  /**
   * Per-base delta-chain walk (tree / deep-delta path): fetch this object's own on-disk
   * bytes, resolve its immediate base individually (OFS by offset via the locator's offset
   * index, REF by OID), and apply. Avoids the single-span over-fetch (root tree 212×).
   */
  private async decodeEntry(entry: LocatorEntry): Promise<GitObject> {
    // Keyed by the copy too: bytes decoded from one writer's copy must not stand in for
    // another's once a bad copy has been skipped.
    const addrKey = `${offsetKey(entry.packRef, entry.offset)}:${this.copyOf.get(entry.packRef) ?? 0}`
    const cached = this.objectsByAddr.get(addrKey)
    if (cached !== undefined) return cached
    const obj = await this.decodeEntryUncached(entry)
    this.objectsByAddr.set(addrKey, obj)
    return obj
  }

  private async decodeEntryUncached(entry: LocatorEntry): Promise<GitObject> {
    const packRef = entry.packRef
    const self = await this.packs.fetchRange(packRef, entry.offset, entry.offset + entry.length, this.copyOf.get(packRef))
    const h = parseObjHeader(self, 0)

    switch (h.type) {
      case PACK_TYPE.COMMIT:
      case PACK_TYPE.TREE:
      case PACK_TYPE.BLOB:
      case PACK_TYPE.TAG:
        return { type: objTypeFromCode(h.type), bytes: inflateZlib(self, h.after, h.size) }
      case PACK_TYPE.OFS_DELTA: {
        const [rel, dpos] = parseOfsBase(self, h.after)
        const base = await this.decodeByOffset(packRef, entry.offset - rel)
        return { type: base.type, bytes: applyDelta(base.bytes, inflateZlib(self, dpos, h.size)) }
      }
      case PACK_TYPE.REF_DELTA: {
        const oidHex = bytesToHex(self.subarray(h.after, h.after + 20))
        const base = await this.decodeByOid(oidHex)
        return {
          type: base.type,
          bytes: applyDelta(base.bytes, inflateZlib(self, h.after + 20, h.size)),
        }
      }
      default:
        throw new Error(`unknown pack object type ${h.type}`)
    }
  }

  private async decodeByOffset(packRef: number, off: number): Promise<GitObject> {
    if (this.offsetIndex === null) this.offsetIndex = this.locator.buildOffsetIndex()
    // Keyed by (packRef, offset): offsets repeat across packs, and an OFS base is always
    // in the referencing object's own pack.
    const e = this.offsetIndex.get(offsetKey(packRef, off))
    if (e === undefined) throw new Error(`base object at pack ${packRef} offset ${off} not in locator`)
    return this.decodeEntry(e)
  }

  private async decodeByOid(oidHex: string): Promise<GitObject> {
    const e = this.locator.lookup(hexToBytes(oidHex))
    if (e === null) throw new Error(`REF_DELTA base not in locator: ${oidHex}`)
    return this.decodeEntry(e)
  }

  /**
   * Parse a flatIndex artifact (already fetched + concatenated) for full-tree browsing.
   * Convenience wrapper around {@link FlatIndex.parse}.
   */
  static parseFlatIndex(compressed: Uint8Array): FlatIndex {
    return FlatIndex.parse(compressed)
  }
}
