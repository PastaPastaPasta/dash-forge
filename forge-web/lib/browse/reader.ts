/**
 * Browse-plane reader — the size-independent object-access layer.
 *
 * Ties {@link ObjectLocator} lookup to ranged pack fetches and pack reconstruction:
 * given a repo's locator + a way to fetch pack byte ranges, recover any single git object
 * (blob / tree / commit) without materializing the repo.
 *
 *   1. index.lookup(oid) → {packRef, offset, length, deltaChainSpan, deltaDepth}
 *   2. blob (contiguous span ≤ threshold): fetch `[end-span, end)` once → reconstruct
 *   3. tree / deep-delta (sentinel or oversized span): per-base walk — fetch each object's
 *      own slice and resolve OFS bases via the index's offset map, or (an index read a slice
 *      at a time, {@link ObjectIndex}) from the base's own entry header
 *
 * The pack bytes come from wherever the manifest points (a backend URI honoring HTTP
 * Range, or platform `chunk` documents reassembled by seq) — modeled as {@link PackSource}.
 */

import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'

import { isOffline } from '../online'
import { isUnreachableError } from '../sdk/unreachable'

import { FlatIndex } from './flatindex'
import { type LocatorEntry, ObjectLocator, SPAN_SENTINEL, offsetKey, singleReadAdvised } from './locator'
import { WalkIndex, scanCommits } from './commit-run'
import { indexOf, type ObjectIndex } from './object-index'
import {
  type GitObject,
  PACK_TYPE,
  gitOidHex,
  baseMaxBytes,
  deltaMaxBytes,
  inflateDelta,
  inflatePrefix,
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
 * Blocks a history walk's source fetches ahead once its reads run through a pack in order
 * (QW-027): a merge-base search over dashpay/dash v22.0.0...v23.0.0 reads 18,000 commits one block
 * after the next, ~60 round trips in a row. With the next blocks asked for as the walk enters
 * one, they arrive side by side (and in one chunk query, gathered with the demanded block).
 */
export const READ_AHEAD_SEQUENTIAL = 3

/** A block a {@link readAheadSource} holds: where it starts in its pack, and its bytes. */
export interface HeldBlock {
  readonly start: number
  readonly bytes: Uint8Array
}

/**
 * A {@link PackSource} that fetches aligned {@link READ_AHEAD_BLOCK}-byte blocks and serves
 * every range inside one from memory — for walks that read many small neighbouring objects.
 *
 * A history walk is the case (D-040): `git pack-objects` writes a pack's commits first, newest
 * first, in one contiguous run of ~100-900 bytes each, so a merge-base search over thousands of
 * commits cost one ranged GET (or chunk query) per commit. Through this it costs one per block,
 * a few hundred commits each. Ranges that span blocks, packs of unknown size, and blocks that
 * fail to load go straight to `inner`, so nothing it could read before becomes unreadable.
 * Every object read through it is still hash-checked by the reader. `heldBlock` hands a walk the
 * block it read an object from, to find the commits after it ({@link scanCommits}).
 */
export function readAheadSource(
  inner: PackSource,
  block = READ_AHEAD_BLOCK,
  maxBlocks = READ_AHEAD_BLOCKS,
  ahead = 0,
): PackSource & {
  heldBlock(packRef: number, offset: number, copy: number | undefined): Promise<HeldBlock> | undefined
  readBlock(packRef: number, offset: number, copy: number | undefined): Promise<HeldBlock> | undefined
  arrivedBlock(packRef: number, offset: number, copy: number | undefined): HeldBlock | undefined
} {
  const blocks = new Map<string, Promise<Uint8Array>>()
  /** The bytes of blocks that have arrived, while they are kept ({@link blocks}). */
  const arrived = new WeakMap<Promise<Uint8Array>, Uint8Array>()
  /** Per pack copy, the block the last read asked for (a read of the next one is a sequential run). */
  const lastBlock = new Map<string, number>()
  // A single-copy pack reads the same bytes whether or not a copy is named: one key, so the
  // reader pinning copy 0 after its first verified object does not refetch the block.
  const copyKeyOf = (packRef: number, copy: number | undefined): string => `${packRef}:${(inner.copyCount?.(packRef) ?? 1) === 1 ? 0 : copy ?? ''}`
  const blockOf = (packRef: number, index: number, size: number, copy: number | undefined, demand = true): Promise<Uint8Array> => {
    const copyKey = copyKeyOf(packRef, copy)
    const key = `${copyKey}:${index}`
    if (demand && ahead > 0) {
      // Reads running through the pack in order: ask for the next blocks now, side by side.
      const last = lastBlock.get(copyKey)
      lastBlock.set(copyKey, index)
      if (last === index - 1) {
        const blocksInPack = Math.ceil(size / block)
        for (let next = index + 1; next <= index + ahead && next < blocksInPack; next++) {
          if (!blocks.has(`${copyKey}:${next}`)) blockOf(packRef, next, size, copy, false).catch(() => undefined)
        }
      }
    }
    const hit = blocks.get(key)
    if (hit !== undefined) {
      blocks.delete(key)
      blocks.set(key, hit)
      return hit
    }
    const start = index * block
    const promise = inner.fetchRange(packRef, start, Math.min(size, start + block), copy)
    promise.then(
      (bytes) => arrived.set(promise, bytes),
      () => {
        if (blocks.get(key) === promise) blocks.delete(key)
      },
    )
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
      } catch (e) {
        // Bad bytes, or nothing answering, fail the exact range the same way: asking again
        // would only double the requests during an outage. Any other block failure (a block
        // past what a mirror serves) may still leave the exact range readable.
        if (isTransportError(e) || (e as { corrupt?: unknown } | null)?.corrupt === true) throw e
      }
      return inner.fetchRange(packRef, start, end, copy)
    },
    /** The block holding pack offset `offset`, if one was read (or is being read); nothing is fetched. */
    heldBlock(packRef, offset, copy) {
      const index = Math.floor(offset / block)
      return blocks.get(`${copyKeyOf(packRef, copy)}:${index}`)?.then((bytes) => ({ start: index * block, bytes }))
    },
    /**
     * The block holding pack offset `offset`, read now if it is not held (not as a demand: it does
     * not start the sequential read-ahead): for a commit run that goes on into it. Undefined where
     * the pack's size is unknown or the offset is past it.
     */
    readBlock(packRef, offset, copy) {
      const size = inner.sizeOf?.(packRef)
      if (size === undefined || offset < 0 || offset >= size) return undefined
      const index = Math.floor(offset / block)
      return blockOf(packRef, index, size, copy, false).then((bytes) => ({ start: index * block, bytes }))
    },
    /** {@link heldBlock}, only once it has arrived: what a scan can decode a delta's base from now. */
    arrivedBlock(packRef, offset, copy) {
      const index = Math.floor(offset / block)
      const promise = blocks.get(`${copyKeyOf(packRef, copy)}:${index}`)
      const bytes = promise === undefined ? undefined : arrived.get(promise)
      return bytes === undefined ? undefined : { start: index * block, bytes }
    },
    ...(inner.copyCount ? { copyCount: (packRef: number) => inner.copyCount?.(packRef) ?? 1 } : {}),
    ...(inner.sizeOf ? { sizeOf: (packRef: number) => inner.sizeOf?.(packRef) } : {}),
  }
}

/**
 * How near its window's end a scan's stop must be to read as an entry the window cuts short (the
 * run goes on in the next block), not one that does not parse: a commit entry is far smaller.
 */
const EDGE_CUT_BYTES = 64 * 1024

/**
 * What a history walk does after each commit it reads fresh ({@link BrowseReader.forHistoryWalk}):
 * learn the commits stored after it into `walkIndex` from the block it was read from
 * ({@link scanCommits}). Where the run reaches the block's end, it goes on in the next block, read
 * for it (the walk reads it next anyway), at most {@link READ_AHEAD_SEQUENTIAL} blocks on, and the
 * walk's commit lookups wait for that rather than ask the index for each commit past a block edge
 * (QW4-003). A block that fails to read is not asked for again by this walk.
 */
function learnRunsInto(
  walkIndex: WalkIndex,
  source: ReturnType<typeof readAheadSource>,
  copyOf: (packRef: number) => number | undefined,
): (entry: LocatorEntry) => Promise<void> {
  // Read before the copy was pinned (the first object of a pack) or after: either key.
  const heldAt = (packRef: number, offset: number): Promise<HeldBlock> | undefined =>
    source.heldBlock(packRef, offset, copyOf(packRef)) ?? source.heldBlock(packRef, offset, undefined)
  const arrivedAt = (packRef: number) => (offset: number): HeldBlock | undefined =>
    source.arrivedBlock(packRef, offset, copyOf(packRef)) ?? source.arrivedBlock(packRef, offset, undefined)
  const refused = new Set<string>()
  /** The block at `offset`, held or read now; undefined once a read of it failed. */
  const blockAt = (packRef: number, offset: number): Promise<HeldBlock> | undefined => {
    const key = `${packRef}:${Math.floor(offset / READ_AHEAD_BLOCK)}`
    if (refused.has(key)) return undefined
    const block = heldAt(packRef, offset) ?? source.readBlock(packRef, offset, copyOf(packRef))
    block?.catch(() => refused.add(key))
    return block
  }
  const goOn = (packRef: number, from: number, hops: number, learn: (next: HeldBlock) => void): void => {
    if (hops > READ_AHEAD_SEQUENTIAL) return
    const following = blockAt(packRef, from)
    if (following !== undefined) walkIndex.learning(following.then(learn))
  }
  const learnRun = (packRef: number, window: HeldBlock, from: number, hops: number): void => {
    const { found, cutAt } = scanCommits(window.bytes, window.start, from, packRef, arrivedAt(packRef))
    walkIndex.learn(found)
    const end = window.start + window.bytes.length
    if (cutAt === null || end - cutAt > EDGE_CUT_BYTES || walkIndex.knows(packRef, cutAt)) return
    goOn(packRef, end, hops + 1, (next) => {
      if (next.start !== end) return
      const tail = window.bytes.subarray(cutAt - window.start)
      const joined = new Uint8Array(tail.length + next.bytes.length)
      joined.set(tail)
      joined.set(next.bytes, tail.length)
      learnRun(packRef, { start: cutAt, bytes: joined }, cutAt, hops + 1)
    })
  }
  return async (entry) => {
    const next = entry.offset + entry.length
    if (walkIndex.knows(entry.packRef, next)) return
    const block = await heldAt(entry.packRef, entry.offset)?.catch(() => undefined)
    // Its block was not read (a range read on its own) or failed: no run to go on from.
    if (block === undefined) return
    const blockEnd = block.start + block.bytes.length
    if (next < blockEnd) return learnRun(entry.packRef, block, next, 0)
    // The commit ends at its block's end, or was read as a range across the edge: the run goes on
    // in the block after it.
    if (next < blockEnd + READ_AHEAD_BLOCK) goOn(entry.packRef, next, 1, (b) => learnRun(entry.packRef, b, next, 1))
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

/**
 * Why a read failed, for the trust panel (L-10):
 *  - `transport`: the bytes never arrived because nothing answered (offline, a node or mirror
 *    that did not respond). No verdict; the view reads again once the connection is back.
 *  - `content`: bytes arrived and were wrong (a hash mismatch, bytes that do not decode, a
 *    sealed pack that fails authentication). The object is reported `failed`.
 *  - `other`: neither (a pack a partial clone never loaded, a locked private session, a
 *    missing base). No verdict, and no automatic retry: it would fail the same way.
 */
export type ReadFailure = 'transport' | 'content' | 'other'

/** Rejections from a {@link PackSource}, classified where they were caught. */
const fetchFailures = new WeakMap<object, Exclude<ReadFailure, 'content'>>()

/**
 * A pack-source rejection that means nothing answered: marked `transport: true` by the source
 * (an HTTP fetch that failed, a pack no mirror served), a network or node error by its message,
 * or any rejection while the browser says it is offline. `corrupt: true` (bytes that arrived
 * and failed a check) is never one.
 */
export function isTransportError(e: unknown): boolean {
  const marks = typeof e === 'object' && e !== null ? (e as { transport?: unknown; corrupt?: unknown }) : {}
  if (marks.corrupt === true) return false
  return marks.transport === true || isUnreachableError(e) || isOffline()
}

/** How a failed read is classified ({@link ReadFailure}). */
export function readFailure(e: unknown): ReadFailure {
  if (e instanceof MissingObjectError) return 'other'
  const tagged = typeof e === 'object' && e !== null ? fetchFailures.get(e) : undefined
  return tagged ?? 'content'
}

/** `e` as thrown by a pack source, tagged: transport, content (`corrupt`), or other. */
function tagFetchFailure(e: unknown): unknown {
  const err = typeof e === 'object' && e !== null ? e : new Error(String(e))
  if ((err as { corrupt?: unknown }).corrupt !== true) fetchFailures.set(err, isTransportError(err) ? 'transport' : 'other')
  return err
}

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
   * Told when a read failed because nothing answered ({@link ReadFailure} `transport`): no
   * verdict, but something on the page is missing until it is read again (L-10).
   */
  readonly onUnreachable?: () => void
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
  readonly objectsByOid: ObjectLru
  readonly objectsByAddr: ObjectLru
  readonly copyOf: Map<number, number>
}

/** Per-read limits for {@link BrowseReader.readObject}. */
export interface ReadObjectOptions {
  /** Refuse ({@link ObjectTooLargeError}) an object, or any base it is built from, larger than this. */
  readonly maxBytes?: number
  /**
   * The caller expects a commit: a history walk may wait for the commit run it is reading on into
   * rather than ask the index ({@link WalkIndex.lookupCommit}).
   */
  readonly commit?: boolean
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

/**
 * A pack entry to decode: an index row, or a delta's OFS base found by its address alone
 * (`bounded`), when the index is not held whole to say how long the base is. A bounded entry's
 * `length` is only how far it can reach (to the delta that names it, which comes after it).
 */
type PackEntry = LocatorEntry & { readonly bounded?: true }

/** A bounded entry's first read: its header, and the whole of a small object. */
const BOUNDED_FIRST_READ = 4096

/**
 * The most bytes a zlib stream of `size` inflated bytes occupies, from any encoder that, as
 * zlib, miniz and libdeflate all do, picks the smallest of stored, fixed and dynamic blocks:
 * fixed codes cost at most 9 bits a byte, plus the header, block and trailer overhead.
 */
function zlibMaxBytes(size: number): number {
  return size + Math.ceil(size / 8) + 64
}

/**
 * Delta-chain steps {@link BrowseReader.objectType} follows: git caps `pack.depth` at 4095, so
 * a longer chain (or a cycle of REF deltas) is a hostile pack, not a real one.
 */
const DELTA_WALK_MAX = 4095

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

/** High-level browse reader over one repo's object index + pack source. */
export class BrowseReader {
  /**
   * `objectsByOid`: the verified whole-object memo, keyed by
   * lowercase OID hex. `objectsByAddr`: the decoded-entry memo keyed `(packRef, offset)`, where
   * repeated delta-base work lands. `copyOf`: the copy each pack is read from (forge-v2 packs have
   * one per writer); it starts at the top-ranked copy and moves on only when an object read
   * through it fails to reconstruct or to hash to its oid, and the copy that served a verified
   * object is kept.
   */
  private readonly caches: ReaderCaches
  /** The object index, shared by this reader's {@link forView} siblings (and its offset map with it). */
  private readonly index: ObjectIndex

  constructor(
    locator: ObjectLocator | ObjectIndex,
    private readonly packs: PackSource,
    private readonly opts: BrowseReaderOptions = {},
    /** The view whose reads this reader reports ({@link forView}); none for a shared reader. */
    private readonly view?: string,
    caches?: ReaderCaches,
  ) {
    this.index = indexOf(locator)
    this.caches = caches ?? { objectsByOid: new ObjectLru(), objectsByAddr: new ObjectLru(), copyOf: new Map() }
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

  /**
   * This reader for one view of a page (L-18): the same objects and memos, but every object it
   * returns is reported to `onRead` with `view`, so a page's trust summary names the places that
   * served it, and a view the viewer left (a history walk still running) is told apart.
   */
  forView(view: string): BrowseReader {
    return new BrowseReader(this.index, this.packs, this.opts, view, this.caches)
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

  /** Every pack read goes through here, so a rejection is classified ({@link readFailure}). */
  private async fetchRange(packRef: number, start: number, end: number, copy: number | undefined): Promise<Uint8Array> {
    try {
      return await this.packs.fetchRange(packRef, start, end, copy)
    } catch (e) {
      throw tagFetchFailure(e)
    }
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
    const source = readAheadSource(this.packs, READ_AHEAD_BLOCK, READ_AHEAD_BLOCKS, READ_AHEAD_SEQUENTIAL)
    // An index read a slice at a time would cost the walk a query per commit: it learns the
    // commits after each one it reads from the block it read it from instead (QW3-001).
    const walkIndex = this.index.inMemory ? null : new WalkIndex(this.index)
    const walker = this.batchedWalker(walkIndex ?? this.index, source)
    if (walkIndex !== null) walker.afterCommit = learnRunsInto(walkIndex, source, (packRef) => walker.copyOf.get(packRef))
    return walker
  }

  /**
   * A new reader over the same index, packs and memos for one walk over many trees (Go to file, the
   * language bar): each object is read as its own range, as this reader reads it, and only its
   * verdicts are batched ({@link BatchedVerdicts}). A pack keeps its commits together but not its
   * trees, so {@link forHistoryWalk}'s blocks would cost a block per tree (QW4-002).
   */
  forTreeWalk(): BrowseReader & { flush(): void } {
    return this.batchedWalker(this.index, this.packs)
  }

  /**
   * A reader over `index` and `packs` sharing this reader's memos (what a walk verified, the page
   * does not read again), whose verdicts reach `onObject` in batches ({@link BatchedVerdicts}).
   */
  private batchedWalker(index: ObjectIndex, packs: PackSource): BrowseReader & { flush(): void } {
    const verdicts = this.opts.onObject ? new BatchedVerdicts(this.opts.onObject) : null
    const walker = new BrowseReader(index, packs, { ...this.opts, ...(verdicts ? { onObject: (v: ObjectVerdict) => verdicts.note(v) } : {}) }, this.view, this.caches)
    return Object.assign(walker, { flush: () => verdicts?.flush() })
  }

  /** Told of every commit this reader reads fresh, at its entry: a history walk learns from it. */
  afterCommit: ((entry: LocatorEntry) => Promise<void>) | undefined

  /** How many objects the locator indexes (git's automatic abbreviation length grows with it). */
  get objectCount(): number {
    return this.index.count
  }

  /** OIDs starting with a hex `prefix` ({@link ObjectLocator.findByPrefix}). */
  async findByPrefix(prefix: string, limit?: number): Promise<string[]> {
    return this.index.findByPrefix(prefix, limit).catch((e: unknown) => {
      throw this.indexFailure(e)
    })
  }

  /**
   * Read the whole object index now, where it is read a slice at a time: for a walk about to look
   * up nearly every object (every file of a tree, for Go to file and the language bar), which
   * would otherwise read it slice by slice.
   */
  preloadIndex(): Promise<void> {
    return this.index.preload().catch((e: unknown) => {
      throw this.indexFailure(e)
    })
  }

  /** An index read that failed: classified as a pack read is, and an outage noted (L-10). */
  private indexFailure(e: unknown): unknown {
    const tagged = tagFetchFailure(e)
    if (readFailure(tagged) === 'transport') this.opts.onUnreachable?.()
    return tagged
  }

  /** Whether some of the repo's packs are missing from this reader (a partial clone). */
  get incomplete(): boolean {
    return this.opts.missingObject !== undefined
  }

  /**
   * An object's type from pack entry headers alone (a few bytes each), without reconstructing
   * it; null only for an object this reader does not index. A delta's type is its base's, so a
   * delta entry follows its chain header by header to the whole object at its root: git does
   * delta-encode commits (small, similar ones especially), and a short id must still resolve
   * to one without downloading any candidate's body.
   *
   * Headers are not hash-checked: callers that act on an object read it ({@link readObject}).
   */
  async objectType(oidHex: string): Promise<GitObject['type'] | null> {
    const cached = this.objectsByOid.get(oidHex.toLowerCase())
    if (cached !== undefined) {
      this.noteHeld(oidHex)
      return cached.type
    }
    const entry = await this.locate(oidHex)
    if (entry === null) return null
    this.noteRead(entry.packRef)
    let e: PackEntry = entry
    // A base seen before is a cycle (a hostile pack): fail at once, not after the whole budget.
    const seen = new Set<string>()
    for (let step = 0; step <= DELTA_WALK_MAX; step++) {
      const at = offsetKey(e.packRef, e.offset)
      if (seen.has(at)) throw new Error(`delta chain of ${oidHex} loops back to pack ${e.packRef} offset ${e.offset}`)
      seen.add(at)
      const head = await this.fetchRange(e.packRef, e.offset, e.offset + Math.min(ENTRY_HEAD_BYTES, e.length), this.copyOf.get(e.packRef))
      const h = parseObjHeader(head, 0)
      if (h.type === PACK_TYPE.OFS_DELTA) {
        const [rel] = parseOfsBase(head, h.after)
        e = this.entryAt(e, rel)
      } else if (h.type === PACK_TYPE.REF_DELTA) {
        if (head.length < h.after + 20) throw new Error('truncated REF_DELTA base oid')
        const baseOid = bytesToHex(head.subarray(h.after, h.after + 20))
        const known = this.objectsByOid.get(baseOid)
        if (known !== undefined) return known.type
        const base = await this.locate(baseOid)
        if (base === null) throw this.missing(baseOid)
        this.noteRead(base.packRef)
        e = base
      } else {
        return objTypeFromCode(h.type)
      }
    }
    throw new Error(`delta chain of ${oidHex} is over ${DELTA_WALK_MAX} deep`)
  }

  /**
   * The first `bytes` bytes of a blob stored whole (not as a delta) in its pack, from a short
   * range read: how git tells a binary file (a NUL in its first 8,000 bytes) for one too large to
   * read whole here (QW3-045). Null for a delta, an object of another type, or one not indexed.
   * Not hash-checked (only the whole object can be): use it to classify, never to show.
   */
  async blobPrefix(oidHex: string, bytes: number): Promise<Uint8Array | null> {
    const entry = await this.locate(oidHex)
    if (entry === null) return null
    const cached = this.objectsByOid.get(oidHex.toLowerCase())
    if (cached !== undefined) return cached.type === 'blob' ? cached.bytes.subarray(0, bytes) : null
    const copy = this.copyOf.get(entry.packRef)
    const head = await this.fetchRange(entry.packRef, entry.offset, entry.offset + Math.min(ENTRY_HEAD_BYTES, entry.length), copy)
    const h = parseObjHeader(head, 0)
    if (h.type !== PACK_TYPE.BLOB) return null
    // Deflate rarely grows data by more than a few bytes per 16 KiB block: twice `bytes` is ample.
    const span = await this.fetchRange(entry.packRef, entry.offset, entry.offset + Math.min(entry.length, h.after + 2 * bytes + 64), copy)
    return inflatePrefix(span, h.after, Math.min(bytes, h.size))
  }

  /** The error for an object this reader does not index ({@link ReadFailure} `other`). */
  private missing(oidHex: string): Error {
    return this.opts.missingObject?.(oidHex) ?? new MissingObjectError(`object not in locator: ${oidHex}`)
  }

  /** Look up a raw locator entry by OID hex (or null if absent). */
  async locate(oidHex: string, commit = false): Promise<LocatorEntry | null> {
    try {
      const oid = hexToBytes(oidHex)
      return await (commit && this.index instanceof WalkIndex ? this.index.lookupCommit(oid) : this.index.lookup(oid))
    } catch (e) {
      throw this.indexFailure(e)
    }
  }

  /**
   * A memoized object served again: its pack is reported to `onRead` when the index can say
   * which without a read (it can: the read that memoized it looked the object up).
   */
  private noteHeld(oidHex: string): void {
    const entry = this.index.peek(hexToBytes(oidHex))
    if (entry != null) this.noteRead(entry.packRef)
  }

  /**
   * The OFS base of delta entry `e`, `rel` bytes before it in the same pack: its index row when
   * the index holds that pack's rows in memory, else an entry bounded by the delta (a base sits
   * wholly before the delta that names it), whose header says how much of that to read.
   */
  private entryAt(e: PackEntry, rel: number): PackEntry {
    const offset = e.offset - rel
    if (rel <= 0 || offset < 0) throw new Error(`OFS base of pack ${e.packRef} offset ${e.offset} is out of range`)
    const known = this.index.atOffset(e.packRef, offset)
    if (known === null) throw new Error(`base object at pack ${e.packRef} offset ${offset} not in locator`)
    if (known !== undefined) return known
    return { packRef: e.packRef, offset, length: rel, deltaChainSpan: SPAN_SENTINEL, deltaDepth: 0, bounded: true }
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
  async readObject(oidHex: string, { maxBytes = Infinity, commit = false }: ReadObjectOptions = {}): Promise<GitObject> {
    return this.readBounded(oidHex, limitsFor(maxBytes), commit)
  }

  /** {@link readObject} under limits fixed by the read that started it (a REF base's read keeps them). */
  private async readBounded(oidHex: string, limits: Limits, commit = false): Promise<GitObject> {
    const oidKey = oidHex.toLowerCase()
    const cached = this.objectsByOid.get(oidKey)
    if (cached !== undefined) {
      const obj = withinLimit(cached, limits.item)
      this.noteHeld(oidHex)
      return obj
    }

    const entry = await this.locate(oidHex, commit)
    if (entry === null) {
      const fresher = await this.opts.onMiss?.(oidHex)
      // The retry keeps this read's limits (a README image stays capped on the fresher reader).
      // The fresher reader reads for this reader's view (its places still count for the page).
      if (fresher != null && fresher !== this && (await fresher.locate(oidHex)) !== null) {
        return (this.view === undefined ? fresher : fresher.forView(this.view)).readBounded(oidHex, limits)
      }
      throw this.missing(oidHex)
    }

    const obj = await this.readVerified(entry, oidKey, limits)
    this.objectsByOid.set(oidKey, obj)
    this.noteRead(entry.packRef)
    if (obj.type === 'commit') await this.afterCommit?.(entry)
    return obj
  }

  /**
   * Fetch a pack entry's bytes, from `copy`. Under a finite limit an entry long enough to be
   * suspect has its header read first, so one that declares too much costs ~32 bytes, not
   * its whole length (per copy tried).
   */
  private async fetchEntry(e: PackEntry, maxBytes: number, copy: number | undefined): Promise<Uint8Array> {
    if (e.bounded === true) return this.fetchBounded(e, maxBytes, copy)
    checkStoredLength(e, maxBytes)
    if (maxBytes !== Infinity && e.length > maxBytes * 1.001 + 64) {
      const head = await this.fetchRange(e.packRef, e.offset, e.offset + Math.min(ENTRY_HEAD_BYTES, e.length), copy)
      const { type, size } = parseObjHeader(head, 0)
      // A delta's header gives the delta's own size, which is bounded differently.
      const isDelta = type === PACK_TYPE.OFS_DELTA || type === PACK_TYPE.REF_DELTA
      if (size > (isDelta ? deltaMaxBytes(maxBytes) : maxBytes)) throw new ObjectTooLargeError(size, maxBytes)
    }
    return this.fetchRange(e.packRef, e.offset, e.offset + e.length, copy)
  }

  /**
   * A {@link PackEntry} known only by its address (`bounded`): its header first (with the whole
   * of a small object), whose declared size bounds how many bytes the rest can take
   * ({@link zlibMaxBytes}); then those, never past the delta that named it.
   */
  private async fetchBounded(e: PackEntry, maxBytes: number, copy: number | undefined): Promise<Uint8Array> {
    const head = await this.fetchRange(e.packRef, e.offset, e.offset + Math.min(BOUNDED_FIRST_READ, e.length), copy)
    const h = parseObjHeader(head, 0)
    const isDelta = h.type === PACK_TYPE.OFS_DELTA || h.type === PACK_TYPE.REF_DELTA
    if (h.size > (isDelta ? deltaMaxBytes(maxBytes) : maxBytes)) throw new ObjectTooLargeError(h.size, maxBytes)
    // After the type and size: an OFS base's distance (at most 10 bytes) or a REF base's oid.
    const need = Math.min(e.length, h.after + (h.type === PACK_TYPE.REF_DELTA ? 20 : 10) + zlibMaxBytes(h.size))
    if (need <= head.length) return head
    const rest = await this.fetchRange(e.packRef, e.offset + head.length, e.offset + need, copy)
    const all = new Uint8Array(head.length + rest.length)
    all.set(head)
    all.set(rest, head.length)
    return all
  }

  /**
   * Reconstruct `entry` and check its oid, trying the pack's copies in order: a copy whose
   * bytes do not reconstruct the object (a hostile or corrupt writer copy) is skipped for the
   * next one (`forge-v2.md` §4 "read the first copy that verifies"). A single-copy pack
   * behaves exactly as before. Reported `failed` only when some copy's bytes arrived and were
   * wrong; any other failure throws with no verdict ({@link ReadFailure}).
   */
  private async readVerified(entry: LocatorEntry, oidKey: string, limits: Limits): Promise<GitObject> {
    const copies = Math.max(1, this.packs.copyCount?.(entry.packRef) ?? 1)
    const start = this.copyOf.get(entry.packRef) ?? 0
    // The last error of each kind ({@link ReadFailure}) over the copies tried.
    const failed: Partial<Record<ReadFailure, unknown>> = {}
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
        else failed[readFailure(e)] = e
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
      failed.content = new Error(`oid mismatch: wanted ${oidKey}, reconstructed ${got}`)
    }
    if (tooLarge !== null) throw tooLarge
    // Only bytes that arrived and were wrong are a content failure (L-10).
    if ('content' in failed) {
      this.opts.onObject?.('failed')
      throw failed.content
    }
    if ('transport' in failed) {
      this.opts.onUnreachable?.()
      throw failed.transport
    }
    throw failed.other
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
      const slice = await this.fetchRange(entry.packRef, end - entry.deltaChainSpan, end, copy)
      return reconstructFromSpan(entry, slice, limits.item, limits.base)
    }
    const walk = async (e: PackEntry, limit: number): Promise<GitObject> => {
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
          const base = await walk(this.entryAt(e, rel), limits.base)
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
    const slice = await this.fetchRange(entry.packRef, start, end, this.copyOf.get(entry.packRef))
    return reconstructFromSpan(entry, slice, limits.item, limits.base)
  }

  /**
   * Per-base delta-chain walk (tree / deep-delta path): fetch this object's own on-disk
   * bytes, resolve its immediate base individually (OFS by offset via the locator's offset
   * index, REF by OID), and apply. Avoids the single-span over-fetch (root tree 212×).
   */
  private async decodeEntry(entry: PackEntry, maxBytes: number, limits: Limits): Promise<GitObject> {
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
  private async decodeEntryUncached(entry: PackEntry, maxBytes: number, limits: Limits): Promise<GitObject> {
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
        // An OFS base is always in the referencing object's own pack.
        const base = await this.decodeEntry(this.entryAt(entry, rel), limits.base, limits)
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

  private async decodeByOid(oidHex: string, limits: Limits): Promise<GitObject> {
    const e = await this.locate(oidHex)
    // A base this reader does not index: the same "missing object" as a direct read of it.
    if (e === null) throw this.missing(oidHex)
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
