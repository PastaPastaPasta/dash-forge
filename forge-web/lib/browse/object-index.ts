/**
 * The object index a {@link BrowseReader} looks objects up in: whole objectLocators held in
 * memory, or a large published one read a few kilobytes at a time (QW3-001).
 *
 * A repo's published index used to be downloaded whole before any of its objects could be read:
 * 9.65 MB for dashpay/dash (657 chunk documents, about 12.6 MB with their proofs), so a cold
 * visit to any of its code pages sat behind a spinner for minutes on a slow link. A lookup only
 * needs the fanout and the rows around its OID in the 1/256 slice for its first byte
 * (`forge-v2.md` §4), so a large fragment is read that way ({@link RangedLocator}): its fanout
 * when the repo resolves, then the granules (Platform chunks) a lookup needs, usually one. A page
 * costs a chunk or two per object it shows, not the whole index.
 *
 * Small fragments (a push's own) are read whole, as before: one query either way. A fragment
 * whose granules read add up to a good part of it ({@link ESCALATE_FRACTION}: a blame, a long
 * history) is then read whole too, hash-checked, and answers every later lookup from memory, and a
 * walk that will look up nearly every object (the file list behind Go to file and the language
 * bar) asks for that up front ({@link ObjectIndex.preload}).
 *
 * A range cannot be hashed on its own: the rows read are checked for shape
 * ({@link wellFormedSlice}), and every object read through them is hash-checked against its OID by
 * the reader, so a wrong row can make a read fail but never show the wrong bytes. Malformed rows
 * are answered from the whole, verified fragment instead.
 */

import {
  FANOUT_LEN,
  LOCATOR_ROW_LEN,
  OID_LEN,
  ObjectLocator,
  compareOid,
  fanoutBounds,
  fanoutCount,
  offsetKey,
  prefixLow,
  rowsWithPrefix,
  searchRows,
  wellFormedSlice,
  type LocatorEntry,
} from './locator'

/** What a {@link BrowseReader} asks of its index. */
export interface ObjectIndex {
  /** Rows indexed (git's automatic abbreviation length grows with it). */
  readonly count: number
  /** Whether every part is held whole: no lookup reads anything. */
  readonly inMemory: boolean
  /** An object's entry (its lowest-`packRef` copy), or null when no part indexes it. */
  lookup(oid: Uint8Array): Promise<LocatorEntry | null>
  /** {@link lookup} without reading anything: undefined when a slice it needs is not loaded. */
  peek(oid: Uint8Array): LocatorEntry | null | undefined
  /** The distinct OIDs (hex) starting with a hex `prefix`, in order, at most `limit` (default 2). */
  findByPrefix(prefix: string, limit?: number): Promise<string[]>
  /**
   * The entry stored at `(packRef, offset)`, from the parts held in memory: what resolves a delta's
   * OFS base. Undefined when a part not held whole may index it (the reader then reads the base's
   * header to learn its length).
   */
  atOffset(packRef: number, offset: number): LocatorEntry | null | undefined
  /** Read every ranged part whole: for a walk that will look up most objects. */
  preload(): Promise<void>
}

/** Where a {@link RangedLocator} reads its fragment from. */
export interface RangedSource {
  /** The fragment's size in bytes (its manifest's `sizeBytes`). */
  readonly sizeBytes: number
  /**
   * The unit ranges are read in, aligned to the fragment's start: what one read costs whatever
   * part of it is used (Platform: a chunk; {@link DEFAULT_GRANULE} elsewhere).
   */
  readonly granule?: number
  /** Bytes `[start, end)` of the fragment. */
  readRange(start: number, end: number): Promise<Uint8Array>
  /** The whole fragment, checked against its `packHash`. */
  loadWhole(): Promise<Uint8Array>
}

/** {@link RangedSource.granule} where the source names none. */
export const DEFAULT_GRANULE = 16 * 1024

/**
 * Once the granules a fragment has served add up to this share of its rows, the rest of it is
 * read whole: a view that touches a quarter of them will likely touch most, and the whole is read
 * in 100-chunk queries rather than one or two per lookup. At worst a fragment costs its size once
 * plus the quarter read before.
 */
export const ESCALATE_FRACTION = 0.25

/** Checked row windows a {@link RangedLocator} keeps. */
const CHECKED_WINDOWS = 256

/** Rows that are not a well-formed part of their fanout slice (a corrupt store, a bad copy). */
class MalformedSliceError extends Error {
  constructor(b: number) {
    super(`index slice ${b.toString(16).padStart(2, '0')} is malformed`)
    this.name = 'MalformedSliceError'
  }
}

/** Where a key falls in its fanout slice, as a fraction: OIDs are uniform past their first byte. */
function keyFraction(key: Uint8Array): number {
  return ((key[1] as number) * 2 ** 24 + (key[2] as number) * 2 ** 16 + (key[3] as number) * 2 ** 8 + (key[4] as number)) / 2 ** 32
}

/** The highest OID a hex prefix allows: the prefix padded with `f`s. */
function prefixHigh(prefix: string): Uint8Array {
  const hex = prefix.toLowerCase().padEnd(OID_LEN * 2, 'f')
  const out = new Uint8Array(OID_LEN)
  for (let i = 0; i < OID_LEN; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * One index fragment read a granule at a time, until (if ever) it is read whole.
 *
 * A lookup needs the rows around its OID, not its whole fanout slice: OIDs are uniform past their
 * first byte, so where one sits in its slice is predictable (interpolation search) to within a few
 * rows (a standard deviation of about √n/2: 16 of dash's 1,047 per slice). A lookup reads the
 * granules holding the predicted rows with a margin, checks they bracket the key, and only if not
 * reads the rest of the slice: on dash, one 14.7 KB chunk rather than the 3 or 4 a slice spans.
 * Granules are aligned to the fragment, so lookups share them, and they are kept (IndexedDB)
 * under stable keys.
 */
export class RangedLocator {
  private readonly granules = new Map<number, Promise<Uint8Array>>()
  private readonly held = new Map<number, Uint8Array>()
  /** Row windows already assembled and checked, by `b:from:to` (a memoized object's pack is peeked often). */
  private readonly checked = new Map<string, Uint8Array>()
  private granuleBytes = 0
  private whole: ObjectLocator | null = null
  private wholeLoad: Promise<ObjectLocator> | null = null
  /** The read whole that {@link ESCALATE_FRACTION} started failed: it is not started again by lookups. */
  private escalationFailed = false
  private readonly granule: number

  private constructor(
    private readonly fanout: Uint8Array,
    /** Rows in the fragment (its fanout's total). */
    readonly count: number,
    private readonly source: RangedSource,
  ) {
    // At least two rows a granule, so a window always holds a whole row.
    this.granule = Math.max(2 * LOCATOR_ROW_LEN, Math.floor(source.granule ?? DEFAULT_GRANULE))
  }

  /**
   * Over a fragment whose first {@link FANOUT_LEN} bytes are `fanout`; null when they are not a
   * fanout for a fragment of `source.sizeBytes` (read it whole instead).
   */
  static open(fanout: Uint8Array, source: RangedSource): RangedLocator | null {
    const count = fanoutCount(fanout)
    if (count === null || FANOUT_LEN + count * LOCATOR_ROW_LEN !== source.sizeBytes) return null
    return new RangedLocator(fanout.slice(), count, source)
  }

  /** The whole fragment, once read. */
  get wholeLocator(): ObjectLocator | null {
    return this.whole
  }

  /** Read the whole fragment (once); every later lookup answers from memory. */
  loadWhole(): Promise<ObjectLocator> {
    if (this.wholeLoad === null) {
      const load = this.source.loadWhole().then((bytes) => {
        const locator = ObjectLocator.parse(bytes)
        this.whole = locator
        this.granules.clear()
        this.held.clear()
        this.checked.clear()
        return locator
      })
      load.catch(() => {
        if (this.wholeLoad === load) this.wholeLoad = null
      })
      this.wholeLoad = load
    }
    return this.wholeLoad
  }

  /** Granule `g`: bytes `[g·G, (g+1)·G)` of the fragment, read once. */
  private readGranule(g: number): Promise<Uint8Array> {
    const cached = this.granules.get(g)
    if (cached !== undefined) return cached
    const start = g * this.granule
    const end = Math.min(this.source.sizeBytes, start + this.granule)
    const read = this.source.readRange(start, end).then((bytes) => {
      if (bytes.length !== end - start) throw new MalformedSliceError(-1)
      this.granuleBytes += bytes.length
      if (this.whole === null) this.held.set(g, bytes)
      this.escalate()
      return bytes
    })
    read.catch(() => {
      if (this.granules.get(g) === read) this.granules.delete(g)
    })
    this.granules.set(g, read)
    return read
  }

  /**
   * Past {@link ESCALATE_FRACTION} of the fragment, read the rest whole in the background, once:
   * if that fails (a chunk the lookups never needed is missing), lookups go on a granule at a
   * time rather than download megabytes again on each one. {@link loadWhole} still tries.
   */
  private escalate(): void {
    if (this.escalationFailed || this.wholeLoad !== null || this.granuleBytes < this.count * LOCATOR_ROW_LEN * ESCALATE_FRACTION) return
    this.loadWhole().catch(() => {
      this.escalationFailed = true
    })
  }

  /** The byte range of rows `[from, to)`. */
  private bytesOf(from: number, to: number): readonly [number, number] {
    return [FANOUT_LEN + from * LOCATOR_ROW_LEN, FANOUT_LEN + to * LOCATOR_ROW_LEN]
  }

  /** The granules rows `[from, to)` lie in. */
  private granulesOf(from: number, to: number): number[] {
    const [start, end] = this.bytesOf(from, to)
    const out: number[] = []
    if (end > start) for (let g = Math.floor(start / this.granule); g <= Math.floor((end - 1) / this.granule); g++) out.push(g)
    return out
  }

  /** Rows `[from, to)` of slice `b`, from `parts` (their granules, in order), checked for shape. */
  private assemble(b: number, from: number, to: number, parts: readonly Uint8Array[]): Uint8Array {
    const key = `${b}:${from}:${to}`
    const done = this.checked.get(key)
    if (done !== undefined) return done
    const [start, end] = this.bytesOf(from, to)
    const first = Math.floor(start / this.granule)
    const out = new Uint8Array(end - start)
    parts.forEach((bytes, i) => {
      const at = (first + i) * this.granule
      const a = Math.max(start, at)
      const z = Math.min(end, at + bytes.length)
      if (z > a) out.set(bytes.subarray(a - at, z - at), a - start)
    })
    if (!wellFormedSlice(out, b)) throw new MalformedSliceError(b)
    this.checked.set(key, out)
    // Kept small: a window is a granule or two, and lookups land in few of them at once.
    for (const k of this.checked.keys()) {
      if (this.checked.size <= CHECKED_WINDOWS) break
      this.checked.delete(k)
    }
    return out
  }

  /**
   * The rows of slice `b` to search for keys in `[low, high]`: where they should be, with a margin,
   * out to whole granules (they cost the same).
   */
  private window(b: number, low: Uint8Array, high: Uint8Array): readonly [number, number] {
    const [lo, hi] = fanoutBounds(this.fanout, b)
    const n = hi - lo
    // A key's place in its slice deviates by about √n/2 rows: a margin of four deviations.
    const margin = Math.ceil(2 * Math.sqrt(n)) + 2
    const clamp = (r: number): number => Math.max(lo, Math.min(hi, r))
    const [start, end] = this.bytesOf(clamp(lo + Math.floor(keyFraction(low) * n) - margin), clamp(lo + Math.ceil(keyFraction(high) * n) + margin))
    const gStart = Math.floor(start / this.granule) * this.granule
    const gEnd = Math.ceil(end / this.granule) * this.granule
    const from = clamp(Math.ceil((gStart - FANOUT_LEN) / LOCATOR_ROW_LEN))
    const to = clamp(Math.floor((gEnd - FANOUT_LEN) / LOCATOR_ROW_LEN))
    return from < to ? [from, to] : [lo, hi]
  }

  /**
   * Whether `rows` (rows `[from, to)` of slice `b`) hold every row with a key in `[low, high]`: each
   * end is the slice's, or a row strictly outside the range.
   */
  private brackets(b: number, from: number, to: number, rows: Uint8Array, low: Uint8Array, high: Uint8Array): boolean {
    const [lo, hi] = fanoutBounds(this.fanout, b)
    return (from === lo || compareOid(rows, 0, low) < 0) && (to === hi || compareOid(rows, (to - from - 1) * LOCATOR_ROW_LEN, high) > 0)
  }

  /** The rows that hold every key in `[low, high]` of slice `b`, read as needed. */
  private async rowsFor(b: number, low: Uint8Array, high: Uint8Array): Promise<Uint8Array> {
    if (this.whole !== null) return this.whole.bucketRows(b)
    try {
      const read = async (from: number, to: number): Promise<Uint8Array> =>
        this.assemble(b, from, to, await Promise.all(this.granulesOf(from, to).map((g) => this.readGranule(g))))
      const [from, to] = this.window(b, low, high)
      const rows = await read(from, to)
      if (this.brackets(b, from, to, rows, low, high)) return rows
      // A key the prediction missed: the whole slice (granules already read are not read again).
      const [lo, hi] = fanoutBounds(this.fanout, b)
      return await read(lo, hi)
    } catch (e) {
      if (!(e instanceof MalformedSliceError)) throw e
      return (await this.loadWhole()).bucketRows(b)
    }
  }

  /** {@link rowsFor} from granules already in memory; undefined when one it needs is not. */
  private heldRowsFor(b: number, low: Uint8Array, high: Uint8Array): Uint8Array | undefined {
    if (this.whole !== null) return this.whole.bucketRows(b)
    const held = (from: number, to: number): Uint8Array | undefined => {
      const parts = this.granulesOf(from, to).map((g) => this.held.get(g))
      if (parts.some((p) => p === undefined)) return undefined
      try {
        return this.assemble(b, from, to, parts as Uint8Array[])
      } catch {
        return undefined
      }
    }
    const [from, to] = this.window(b, low, high)
    const rows = held(from, to)
    if (rows !== undefined && this.brackets(b, from, to, rows, low, high)) return rows
    const [lo, hi] = fanoutBounds(this.fanout, b)
    return held(lo, hi)
  }

  async lookup(oid: Uint8Array): Promise<LocatorEntry | null> {
    if (oid.length !== OID_LEN) return null
    return searchRows(await this.rowsFor(oid[0] as number, oid, oid), oid)
  }

  peek(oid: Uint8Array): LocatorEntry | null | undefined {
    if (oid.length !== OID_LEN) return null
    const rows = this.heldRowsFor(oid[0] as number, oid, oid)
    return rows === undefined ? undefined : searchRows(rows, oid)
  }

  async findByPrefix(prefix: string, limit: number): Promise<string[]> {
    const low = prefixLow(prefix)
    if (low === null) return []
    return rowsWithPrefix(await this.rowsFor(low[0] as number, low, prefixHigh(prefix)), prefix, limit)
  }
}

type Part = ObjectLocator | RangedLocator

/** The lower-`packRef` of two answers (the copy {@link ObjectLocator.merge} + lookup would give). */
function lower(a: LocatorEntry | null, b: LocatorEntry | null): LocatorEntry | null {
  if (a === null) return b
  if (b === null) return a
  return b.packRef < a.packRef ? b : a
}

/**
 * An index over several fragments, each whole or ranged, answering as their merge would
 * ({@link ObjectLocator.merge}): a lookup is the lowest-`packRef` row of any part.
 */
export class FragmentedIndex implements ObjectIndex {
  private readonly offsets = new Map<ObjectLocator, Map<string, LocatorEntry>>()

  constructor(private readonly parts: readonly Part[]) {}

  get count(): number {
    return this.parts.reduce((n, p) => n + p.count, 0)
  }

  get inMemory(): boolean {
    return this.parts.every((p) => p instanceof ObjectLocator || p.wholeLocator !== null)
  }

  async lookup(oid: Uint8Array): Promise<LocatorEntry | null> {
    const found = await Promise.all(this.parts.map((p) => p.lookup(oid)))
    return found.reduce<LocatorEntry | null>(lower, null)
  }

  peek(oid: Uint8Array): LocatorEntry | null | undefined {
    let best: LocatorEntry | null = null
    for (const p of this.parts) {
      const e = p instanceof ObjectLocator ? p.lookup(oid) : p.peek(oid)
      if (e === undefined) return undefined
      best = lower(best, e)
    }
    return best
  }

  async findByPrefix(prefix: string, limit = 2): Promise<string[]> {
    const found = await Promise.all(this.parts.map((p) => p.findByPrefix(prefix, limit)))
    // Each part's first `limit` matches in order: the first `limit` of their union are among them.
    return [...new Set(found.flat())].sort().slice(0, limit)
  }

  atOffset(packRef: number, offset: number): LocatorEntry | null | undefined {
    let unknown = false
    for (const p of this.parts) {
      const whole = p instanceof ObjectLocator ? p : p.wholeLocator
      if (whole === null) {
        unknown = true
        continue
      }
      let index = this.offsets.get(whole)
      if (index === undefined) {
        index = whole.buildOffsetIndex()
        this.offsets.set(whole, index)
      }
      const hit = index.get(offsetKey(packRef, offset))
      if (hit !== undefined) return hit
    }
    return unknown ? undefined : null
  }

  async preload(): Promise<void> {
    await Promise.all(this.parts.map((p) => (p instanceof RangedLocator ? p.loadWhole() : p)))
  }
}

/** `locator` as an {@link ObjectIndex} (a whole one is wrapped; an index is itself). */
export function indexOf(locator: ObjectLocator | ObjectIndex): ObjectIndex {
  return locator instanceof ObjectLocator ? new FragmentedIndex([locator]) : locator
}
