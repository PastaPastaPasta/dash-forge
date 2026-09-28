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
  gitOidHex,
  baseMaxBytes,
  deltaMaxBytes,
  inflateDelta,
  inflateZlib,
  ObjectTooLargeError,
  objTypeFromCode,
  parseObjHeader,
  parseOfsBase,
  reconstructFromSpan,
  storedMaxBytes,
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
  /** Pack `packRef`'s size in bytes, when known (lets a reader read ahead without overrunning it). */
  sizeOf?(packRef: number): number | undefined
}

/** Bytes per read-ahead block of {@link readAheadSource}. */
export const READ_AHEAD_BLOCK = 256 * 1024
/** Blocks a {@link readAheadSource} keeps (so at most 16 MiB). */
const READ_AHEAD_BLOCKS = 64

/**
 * A {@link PackSource} that fetches aligned {@link READ_AHEAD_BLOCK}-byte blocks and serves
 * every range inside one from memory — for walks that read many small neighbouring objects.
 *
 * A history walk is the case (D-040): `git pack-objects` writes a pack's commits first, newest
 * first, in one contiguous run of ~100-900 bytes each, so a merge-base search over thousands of
 * commits cost one ranged GET (or chunk query) per commit. Through this it costs one per block,
 * a few hundred commits each. Ranges that span blocks, packs of unknown size, and blocks that
 * fail to load go straight to `inner`, so nothing it could read before becomes unreadable.
 * Every object read through it is still hash-checked by the reader.
 */
export function readAheadSource(inner: PackSource, block = READ_AHEAD_BLOCK, maxBlocks = READ_AHEAD_BLOCKS): PackSource {
  const blocks = new Map<string, Promise<Uint8Array>>()
  const blockOf = (packRef: number, index: number, size: number, copy: number | undefined): Promise<Uint8Array> => {
    // A single-copy pack reads the same bytes whether or not a copy is named: one key, so the
    // reader pinning copy 0 after its first verified object does not refetch the block.
    const single = (inner.copyCount?.(packRef) ?? 1) === 1
    const key = `${packRef}:${single ? 0 : copy ?? ''}:${index}`
    const hit = blocks.get(key)
    if (hit !== undefined) {
      blocks.delete(key)
      blocks.set(key, hit)
      return hit
    }
    const start = index * block
    const promise = inner.fetchRange(packRef, start, Math.min(size, start + block), copy)
    promise.catch(() => {
      if (blocks.get(key) === promise) blocks.delete(key)
    })
    blocks.set(key, promise)
    for (const k of blocks.keys()) {
      if (blocks.size <= maxBlocks) break
      blocks.delete(k)
    }
    return promise
  }
  return {
    async fetchRange(packRef, start, end, copy) {
      const size = inner.sizeOf?.(packRef)
      const index = Math.floor(start / block)
      if (size === undefined || end > size || Math.floor((end - 1) / block) !== index) {
        return inner.fetchRange(packRef, start, end, copy)
      }
      try {
        const bytes = await blockOf(packRef, index, size, copy)
        const from = start - index * block
        if (from + (end - start) <= bytes.length) return bytes.subarray(from, from + (end - start))
      } catch {
        /* the exact range may still be readable */
      }
      return inner.fetchRange(packRef, start, end, copy)
    },
    ...(inner.copyCount ? { copyCount: (packRef: number) => inner.copyCount?.(packRef) ?? 1 } : {}),
    ...(inner.sizeOf ? { sizeOf: (packRef: number) => inner.sizeOf?.(packRef) } : {}),
  }
}

/**
 * An object this reader's packs do not hold, because some of the repo's packs could not be
 * loaded (a partial in-browser clone). Distinct from "not in this repo": the object may well
 * exist, in a pack that was unreachable.
 */
export class MissingObjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingObjectError'
  }
}

/** What happened to one reconstructed object's hash check. */
export type ObjectVerdict = 'verified' | 'unchecked' | 'failed'

/** Verdicts passed on every {@link BATCH_VERDICTS} objects (and on flush), not one by one. */
const BATCH_VERDICTS = 500

class BatchedVerdicts {
  private counts: Record<ObjectVerdict, number> = { verified: 0, unchecked: 0, failed: 0 }
  private pending = 0

  constructor(private readonly sink: (verdict: ObjectVerdict, count?: number) => void) {}

  note(v: ObjectVerdict): void {
    this.counts[v] += 1
    // A failure is reported at once: the trust panel must never lag behind a bad object.
    if (v === 'failed' || ++this.pending >= BATCH_VERDICTS) this.flush()
  }

  flush(): void {
    for (const v of ['verified', 'unchecked', 'failed'] as const) {
      if (this.counts[v] > 0) this.sink(v, this.counts[v])
    }
    this.counts = { verified: 0, unchecked: 0, failed: 0 }
    this.pending = 0
  }
}

export interface BrowseReaderOptions {
  /** Verify the reconstructed object hashes to the requested OID (default true). */
  readonly verify?: boolean
  /**
   * Told the outcome of every fresh reconstruction (memo hits were reported when first
   * read). This is how the UI learns what was actually checked rather than assuming it.
   */
  readonly onObject?: (verdict: ObjectVerdict, count?: number) => void
  /**
   * The error for an OID the locator does not index. Defaults to `object not in locator`; a
   * reader built over an incomplete pack set supplies one that names what is missing.
   */
  readonly missingObject?: (oidHex: string) => Error
  /**
   * Asked once per read of an OID the locator does not index, before that read fails: a
   * reader held since before a push or a merge can be stale, and the session browse cache
   * answers with a freshly resolved reader when the repo's packs changed since
   * (`browse-source.ts`). The read is retried once on the reader returned, if it indexes the
   * OID; null (or a reader that does not hold it either) fails the read as before.
   */
  readonly onMiss?: (oidHex: string) => Promise<BrowseReader | null>
  /**
   * Told the pack (`packRef`) of every object a view's reader ({@link BrowseReader.forView})
   * returned, memo hits included, with the copy of it that verified (when known) and the view:
   * which places served a page (L-18).
   */
  readonly onRead?: (packRef: number, copy: number | undefined, view: string) => void
}

/** The memos a reader and its {@link BrowseReader.forView} siblings share. */
interface ReaderCaches {
  offsetIndex: Map<string, LocatorEntry> | null
  readonly objectsByOid: ObjectLru
  readonly objectsByAddr: ObjectLru
  readonly copyOf: Map<number, number>
}

/** Per-read limits for {@link BrowseReader.readObject}. */
export interface ReadObjectOptions {
  /** Refuse ({@link ObjectTooLargeError}) an object, or any base it is built from, larger than this. */
  readonly maxBytes?: number
}

/** A memoized object, unless it is over the caller's limit. */
function withinLimit(obj: GitObject, maxBytes: number): GitObject {
  if (obj.bytes.length > maxBytes) throw new ObjectTooLargeError(obj.bytes.length, maxBytes)
  return obj
}

/**
 * Refuse, before fetching it, a pack entry too long to hold an object of at most `maxBytes`:
 * its length is the pusher's claim, and fetching a 500 MiB entry to learn that its header
 * says 500 MiB is the cost this avoids.
 */
function checkStoredLength(entry: LocatorEntry, maxBytes: number): void {
  if (maxBytes !== Infinity && entry.length > storedMaxBytes(maxBytes)) throw new ObjectTooLargeError(entry.length, maxBytes)
}

/** Bytes that hold any pack entry header (type, size varint, OFS offset or REF oid). */
const ENTRY_HEAD_BYTES = 32

/** A read's limits, fixed when it starts: the object's, and every delta base's at any depth. */
interface Limits {
  readonly item: number
  readonly base: number
}

const limitsFor = (maxBytes: number): Limits => ({ item: maxBytes, base: baseMaxBytes(maxBytes) })

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
  /**
   * `offsetIndex`: built on first use. `objectsByOid`: the verified whole-object memo, keyed by
   * lowercase OID hex. `objectsByAddr`: the decoded-entry memo keyed `(packRef, offset)`, where
   * repeated delta-base work lands. `copyOf`: the copy each pack is read from (forge-v2 packs have
   * one per writer); it starts at the top-ranked copy and moves on only when an object read
   * through it fails to reconstruct or to hash to its oid, and the copy that served a verified
   * object is kept.
   */
  private readonly caches: ReaderCaches

  constructor(
    private readonly locator: ObjectLocator,
    private readonly packs: PackSource,
    private readonly opts: BrowseReaderOptions = {},
    /** The view whose reads this reader reports ({@link forView}); none for a shared reader. */
    private readonly view?: string,
    caches?: ReaderCaches,
  ) {
    this.caches = caches ?? { offsetIndex: null, objectsByOid: new ObjectLru(), objectsByAddr: new ObjectLru(), copyOf: new Map() }
  }

  private get objectsByOid(): ObjectLru {
    return this.caches.objectsByOid
  }
  private get objectsByAddr(): ObjectLru {
    return this.caches.objectsByAddr
  }
  private get copyOf(): Map<number, number> {
    return this.caches.copyOf
  }
  private get offsetIndex(): Map<string, LocatorEntry> | null {
    return this.caches.offsetIndex
  }
  private set offsetIndex(index: Map<string, LocatorEntry> | null) {
    this.caches.offsetIndex = index
  }

  /**
   * This reader for one view of a page (L-18): the same objects and memos, but every object it
   * returns is reported to `onRead` with `view`, so a page's trust summary names the places that
   * served it, and a view the viewer left (a history walk still running) is told apart.
   */
  forView(view: string): BrowseReader {
    return new BrowseReader(this.locator, this.packs, this.opts, view, this.caches)
  }

  /**
   * One object per set of readers that share memos (this reader and its {@link forView} siblings):
   * a key for session memos derived from what they read (a path's history), so every page of a
   * repo shares them, and a newer context (a push) starts afresh.
   */
  get memoScope(): object {
    return this.caches
  }

  private noteRead(packRef: number): void {
    if (this.view !== undefined) this.opts.onRead?.(packRef, this.copyOf.get(packRef), this.view)
  }

  /**
   * A new reader over the same locator that reads the packs through {@link readAheadSource}:
   * for walks over many commits (merge-base search), which would otherwise pay one ranged read
   * per commit. Each call has its own block cache (up to 16 MiB), freed with the walker, so
   * callers take one per walk rather than keeping it with the session. Its verdicts reach
   * `onObject` in batches ({@link BatchedVerdicts}): one per object would re-render every
   * listener tens of thousands of times in a long walk.
   */
  forHistoryWalk(): BrowseReader & { flush(): void } {
    const verdicts = this.opts.onObject ? new BatchedVerdicts(this.opts.onObject) : null
    const walker = new BrowseReader(
      this.locator,
      readAheadSource(this.packs),
      { ...this.opts, ...(verdicts ? { onObject: (v: ObjectVerdict) => verdicts.note(v) } : {}) },
      this.view,
    )
    return Object.assign(walker, { flush: () => verdicts?.flush() })
  }

  /** OIDs starting with a hex `prefix` ({@link ObjectLocator.findByPrefix}). */
  findByPrefix(prefix: string, limit?: number): string[] {
    return this.locator.findByPrefix(prefix, limit)
  }

  /** Whether some of the repo's packs are missing from this reader (a partial clone). */
  get incomplete(): boolean {
    return this.opts.missingObject !== undefined
  }

  /**
   * An object's type from its pack entry header alone (a few bytes), without reconstructing
   * it; null for a delta entry, whose type is its base's. git does not delta-encode commits in
   * practice, so a delta is "not a commit" for short-id resolution.
   */
  async objectType(oidHex: string): Promise<GitObject['type'] | null> {
    const entry = this.locate(oidHex)
    const cached = this.objectsByOid.get(oidHex.toLowerCase())
    if (cached !== undefined) {
      if (entry !== null) this.noteRead(entry.packRef)
      return cached.type
    }
    if (entry === null) return null
    this.noteRead(entry.packRef)
    const head = await this.packs.fetchRange(entry.packRef, entry.offset, Math.min(entry.offset + 16, entry.offset + entry.length), this.copyOf.get(entry.packRef))
    const { type } = parseObjHeader(head, 0)
    return type === PACK_TYPE.OFS_DELTA || type === PACK_TYPE.REF_DELTA ? null : objTypeFromCode(type)
  }

  /** Look up a raw locator entry by OID hex (or null if absent). */
  locate(oidHex: string): LocatorEntry | null {
    return this.locator.lookup(hexToBytes(oidHex))
  }

  /**
   * Reconstruct a git object by OID hex. Chooses the single contiguous span read for
   * blobs and the per-base walk for trees / deep-delta chains, as the locator's
   * `deltaChainSpan` hint advises.
   *
   * `maxBytes` bounds the object and every step of its delta chain by the sizes their own
   * headers declare, before anything is inflated or allocated ({@link ObjectTooLargeError}):
   * a stored entry's length says nothing about what it inflates to, so a few KiB of pack can
   * otherwise expand to gigabytes in the viewer's tab.
   */
  async readObject(oidHex: string, { maxBytes = Infinity }: ReadObjectOptions = {}): Promise<GitObject> {
    return this.readBounded(oidHex, limitsFor(maxBytes))
  }

  /** {@link readObject} under limits fixed by the read that started it (a REF base's read keeps them). */
  private async readBounded(oidHex: string, limits: Limits): Promise<GitObject> {
    const oidKey = oidHex.toLowerCase()
    const cached = this.objectsByOid.get(oidKey)
    const entry = this.locate(oidHex)
    if (cached !== undefined) {
      const obj = withinLimit(cached, limits.item)
      if (entry !== null) this.noteRead(entry.packRef)
      return obj
    }

    if (entry === null) {
      const fresher = await this.opts.onMiss?.(oidHex)
      // The retry keeps this read's limits (a README image stays capped on the fresher reader).
      // The fresher reader reads for this reader's view (its places still count for the page).
      if (fresher != null && fresher !== this && fresher.locate(oidHex) !== null) {
        return (this.view === undefined ? fresher : fresher.forView(this.view)).readBounded(oidHex, limits)
      }
      throw this.opts.missingObject?.(oidHex) ?? new Error(`object not in locator: ${oidHex}`)
    }

    const obj = await this.readVerified(entry, oidKey, limits)
    this.objectsByOid.set(oidKey, obj)
    this.noteRead(entry.packRef)
    return obj
  }

  /**
   * Fetch a pack entry's bytes, from `copy`. Under a finite limit an entry long enough to be
   * suspect has its header read first, so one that declares too much costs ~32 bytes, not
   * its whole length (per copy tried).
   */
  private async fetchEntry(e: LocatorEntry, maxBytes: number, copy: number | undefined): Promise<Uint8Array> {
    checkStoredLength(e, maxBytes)
    if (maxBytes !== Infinity && e.length > maxBytes * 1.001 + 64) {
      const head = await this.packs.fetchRange(e.packRef, e.offset, e.offset + Math.min(ENTRY_HEAD_BYTES, e.length), copy)
      const { type, size } = parseObjHeader(head, 0)
      // A delta's header gives the delta's own size, which is bounded differently.
      const isDelta = type === PACK_TYPE.OFS_DELTA || type === PACK_TYPE.REF_DELTA
      if (size > (isDelta ? deltaMaxBytes(maxBytes) : maxBytes)) throw new ObjectTooLargeError(size, maxBytes)
    }
    return this.packs.fetchRange(e.packRef, e.offset, e.offset + e.length, copy)
  }

  /**
   * Reconstruct `entry` and check its oid, trying the pack's copies in order: a copy whose
   * bytes do not reconstruct the object (a hostile or corrupt writer copy) is skipped for the
   * next one (`forge-v2.md` §4 "read the first copy that verifies"). A single-copy pack
   * behaves exactly as before.
   */
  private async readVerified(entry: LocatorEntry, oidKey: string, limits: Limits): Promise<GitObject> {
    const copies = this.packs.copyCount?.(entry.packRef) ?? 1
    const start = this.copyOf.get(entry.packRef) ?? 0
    let lastErr: unknown
    let tooLarge: ObjectTooLargeError | null = null
    for (let i = 0; i < copies; i++) {
      const copy = (start + i) % copies
      let obj: GitObject
      try {
        obj = i === 0 ? await this.reconstruct(entry, limits) : await this.reconstructFrom(entry, copy, limits)
      } catch (e) {
        // Over the caller's limit in this copy: another copy may be the honest one (a
        // tampered header must not hide it), and if every copy says so, that is the answer.
        if (e instanceof ObjectTooLargeError) tooLarge = e
        else lastErr = e
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
    if (tooLarge !== null) throw tooLarge
    this.opts.onObject?.('failed')
    throw lastErr
  }

  /** The default path: memoized decode through the pack's current copy. */
  private reconstruct(entry: LocatorEntry, limits: Limits): Promise<GitObject> {
    return singleReadAdvised(entry) ? this.readSpan(entry, limits) : this.decodeEntry(entry, limits.item, limits)
  }

  /**
   * Reconstruct `entry` from one specific copy of its pack, without the address memo (whose
   * entries came from another copy). REF_DELTA bases are other objects and go through
   * {@link readObject}, which verifies them on their own.
   */
  private async reconstructFrom(entry: LocatorEntry, copy: number, limits: Limits): Promise<GitObject> {
    if (singleReadAdvised(entry)) {
      const end = entry.offset + entry.length
      const slice = await this.packs.fetchRange(entry.packRef, end - entry.deltaChainSpan, end, copy)
      return reconstructFromSpan(entry, slice, limits.item, limits.base)
    }
    const walk = async (e: LocatorEntry, limit: number): Promise<GitObject> => {
      const self = await this.fetchEntry(e, limit, copy)
      const h = parseObjHeader(self, 0)
      switch (h.type) {
        case PACK_TYPE.COMMIT:
        case PACK_TYPE.TREE:
        case PACK_TYPE.BLOB:
        case PACK_TYPE.TAG:
          return { type: objTypeFromCode(h.type), bytes: inflateZlib(self, h.after, h.size, limit) }
        case PACK_TYPE.OFS_DELTA: {
          const [rel, dpos] = parseOfsBase(self, h.after)
          if (this.offsetIndex === null) this.offsetIndex = this.locator.buildOffsetIndex()
          const baseEntry = this.offsetIndex.get(offsetKey(e.packRef, e.offset - rel))
          if (baseEntry === undefined) throw new Error(`base object at pack ${e.packRef} offset ${e.offset - rel} not in locator`)
          const base = await walk(baseEntry, limits.base)
          return { type: base.type, bytes: inflateDelta(base.bytes, self, dpos, h.size, limit) }
        }
        case PACK_TYPE.REF_DELTA: {
          const base = await this.readBounded(bytesToHex(self.subarray(h.after, h.after + 20)), { item: limits.base, base: limits.base })
          return { type: base.type, bytes: inflateDelta(base.bytes, self, h.after + 20, h.size, limit) }
        }
        default:
          throw new Error(`unknown pack object type ${h.type}`)
      }
    }
    return walk(entry, limits.item)
  }

  /** Single contiguous span read (blob path): one ranged fetch, then reconstruct. */
  private async readSpan(entry: LocatorEntry, limits: Limits): Promise<GitObject> {
    const end = entry.offset + entry.length
    const start = end - entry.deltaChainSpan
    const slice = await this.packs.fetchRange(entry.packRef, start, end, this.copyOf.get(entry.packRef))
    return reconstructFromSpan(entry, slice, limits.item, limits.base)
  }

  /**
   * Per-base delta-chain walk (tree / deep-delta path): fetch this object's own on-disk
   * bytes, resolve its immediate base individually (OFS by offset via the locator's offset
   * index, REF by OID), and apply. Avoids the single-span over-fetch (root tree 212×).
   */
  private async decodeEntry(entry: LocatorEntry, maxBytes: number, limits: Limits): Promise<GitObject> {
    // Keyed by the copy too: bytes decoded from one writer's copy must not stand in for
    // another's once a bad copy has been skipped.
    const addrKey = `${offsetKey(entry.packRef, entry.offset)}:${this.copyOf.get(entry.packRef) ?? 0}`
    const cached = this.objectsByAddr.get(addrKey)
    if (cached !== undefined) return withinLimit(cached, maxBytes)
    const obj = await this.decodeEntryUncached(entry, maxBytes, limits)
    this.objectsByAddr.set(addrKey, obj)
    return obj
  }

  /** `maxBytes` bounds this entry and `limits.base` its delta bases, at any depth. */
  private async decodeEntryUncached(entry: LocatorEntry, maxBytes: number, limits: Limits): Promise<GitObject> {
    const packRef = entry.packRef
    const self = await this.fetchEntry(entry, maxBytes, this.copyOf.get(packRef))
    const h = parseObjHeader(self, 0)

    switch (h.type) {
      case PACK_TYPE.COMMIT:
      case PACK_TYPE.TREE:
      case PACK_TYPE.BLOB:
      case PACK_TYPE.TAG:
        return { type: objTypeFromCode(h.type), bytes: inflateZlib(self, h.after, h.size, maxBytes) }
      case PACK_TYPE.OFS_DELTA: {
        const [rel, dpos] = parseOfsBase(self, h.after)
        const base = await this.decodeByOffset(packRef, entry.offset - rel, limits)
        return { type: base.type, bytes: inflateDelta(base.bytes, self, dpos, h.size, maxBytes) }
      }
      case PACK_TYPE.REF_DELTA: {
        const oidHex = bytesToHex(self.subarray(h.after, h.after + 20))
        const base = await this.decodeByOid(oidHex, limits)
        return { type: base.type, bytes: inflateDelta(base.bytes, self, h.after + 20, h.size, maxBytes) }
      }
      default:
        throw new Error(`unknown pack object type ${h.type}`)
    }
  }

  private async decodeByOffset(packRef: number, off: number, limits: Limits): Promise<GitObject> {
    if (this.offsetIndex === null) this.offsetIndex = this.locator.buildOffsetIndex()
    // Keyed by (packRef, offset): offsets repeat across packs, and an OFS base is always
    // in the referencing object's own pack.
    const e = this.offsetIndex.get(offsetKey(packRef, off))
    if (e === undefined) throw new Error(`base object at pack ${packRef} offset ${off} not in locator`)
    return this.decodeEntry(e, limits.base, limits)
  }

  private async decodeByOid(oidHex: string, limits: Limits): Promise<GitObject> {
    const e = this.locator.lookup(hexToBytes(oidHex))
    if (e === null) throw new Error(`REF_DELTA base not in locator: ${oidHex}`)
    const base = await this.decodeEntry(e, limits.base, limits)
    this.noteRead(e.packRef)
    return base
  }

  /**
   * Parse a flatIndex artifact (already fetched + concatenated) for full-tree browsing.
   * Convenience wrapper around {@link FlatIndex.parse}.
   */
  static parseFlatIndex(compressed: Uint8Array): FlatIndex {
    return FlatIndex.parse(compressed)
  }
}
