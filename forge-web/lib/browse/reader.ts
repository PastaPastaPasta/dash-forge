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
  /** Return pack `packRef` bytes `[start, end)`. */
  fetchRange(packRef: number, start: number, end: number): Promise<Uint8Array>
}

export interface BrowseReaderOptions {
  /** Verify the reconstructed object hashes to the requested OID (default true). */
  readonly verify?: boolean
}

/** High-level browse reader over one repo's objectLocator + pack source. */
export class BrowseReader {
  private offsetIndex: Map<string, LocatorEntry> | null = null

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
    const entry = this.locate(oidHex)
    if (entry === null) throw new Error(`object not in locator: ${oidHex}`)

    const obj = singleReadAdvised(entry)
      ? await this.readSpan(entry)
      : await this.decodeEntry(entry)

    if (this.opts.verify !== false) {
      const got = gitOidHex(obj.type, obj.bytes)
      if (got !== oidHex.toLowerCase()) {
        throw new Error(`oid mismatch: wanted ${oidHex}, reconstructed ${got}`)
      }
    }
    return obj
  }

  /** Single contiguous span read (blob path): one ranged fetch, then reconstruct. */
  private async readSpan(entry: LocatorEntry): Promise<GitObject> {
    const end = entry.offset + entry.length
    const start = end - entry.deltaChainSpan
    const slice = await this.packs.fetchRange(entry.packRef, start, end)
    return reconstructFromSpan(entry, slice)
  }

  /**
   * Per-base delta-chain walk (tree / deep-delta path): fetch this object's own on-disk
   * bytes, resolve its immediate base individually (OFS by offset via the locator's offset
   * index, REF by OID), and apply. Avoids the single-span over-fetch (root tree 212×).
   */
  private async decodeEntry(entry: LocatorEntry): Promise<GitObject> {
    const packRef = entry.packRef
    const self = await this.packs.fetchRange(packRef, entry.offset, entry.offset + entry.length)
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
