/**
 * objectLocator reader — the git-MIDX analog (data-contracts §2.3, S0.5).
 *
 * Read-side port of `crates/forge-core/src/pack/locator.rs`. Layout:
 *   fanout(256 × u32 BE) || rows
 *   row = oid(20) || packRef(u16 BE) || offset(5 BE) || length(u32 BE)
 *          || deltaChainSpan(u32 BE) || deltaHint(u8)   = 36 B/object, fixed stride
 *
 * A lookup is the fanout header plus one ~1/256 slice: binary-search within the slice.
 * The whole point is size-independent single-object access — either from a fully-fetched
 * locator ({@link ObjectLocator.parse}) or via ranged reads ({@link lookupRanged}).
 */

export const OID_LEN = 20
/** Fixed row width of the locator, in bytes. */
export const LOCATOR_ROW_LEN = OID_LEN + 2 + 5 + 4 + 4 + 1 // 36
/** Byte length of the fanout header (256 cumulative u32 counts). */
export const FANOUT_LEN = 256 * 4
/** Span at or below which a single contiguous ranged read is advised (≈ 64 KiB). */
export const SPAN_SINGLE_READ_THRESHOLD = 64 * 1024
/** Sentinel deltaChainSpan meaning "not a single contiguous range — walk each base". */
export const SPAN_SENTINEL = 0xffffffff

const OFF_PACKREF = OID_LEN
const OFF_OFFSET = OFF_PACKREF + 2
const OFF_LENGTH = OFF_OFFSET + 5
const OFF_SPAN = OFF_LENGTH + 4
const OFF_HINT = OFF_SPAN + 4

/** One decoded locator row. */
export interface LocatorEntry {
  /** Index into the manifest's pack list. */
  readonly packRef: number
  /** Byte offset of the object within its pack. */
  readonly offset: number
  /** On-disk object length. */
  readonly length: number
  /** Contiguous span covering the object and its whole (contiguous) delta chain. */
  readonly deltaChainSpan: number
  /** Delta chain depth hint (0 = non-delta base). */
  readonly deltaDepth: number
}

/**
 * Whether a single contiguous span read is advised: span within threshold and not the
 * non-contiguous sentinel. Blobs almost always qualify; deep-delta trees do not and take
 * the per-base walk keyed off {@link LocatorEntry.deltaDepth}.
 */
export function singleReadAdvised(e: LocatorEntry): boolean {
  return e.deltaChainSpan !== SPAN_SENTINEL && e.deltaChainSpan <= SPAN_SINGLE_READ_THRESHOLD
}

function u32be(buf: Uint8Array, at: number): number {
  return (
    (((buf[at] as number) << 24) |
      ((buf[at + 1] as number) << 16) |
      ((buf[at + 2] as number) << 8) |
      (buf[at + 3] as number)) >>>
    0
  )
}

function u16be(buf: Uint8Array, at: number): number {
  return ((buf[at] as number) << 8) | (buf[at + 1] as number)
}

function u40be(buf: Uint8Array, at: number): number {
  // 5-byte big-endian; safe as a JS number (< 2^53).
  let v = 0
  for (let i = 0; i < 5; i++) v = v * 256 + (buf[at + i] as number)
  return v
}

function compareOid(row: Uint8Array, rowStart: number, oid: Uint8Array): number {
  for (let i = 0; i < OID_LEN; i++) {
    const a = row[rowStart + i] as number
    const b = oid[i] as number
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

function decodeRow(buf: Uint8Array, rowStart: number): LocatorEntry {
  return {
    packRef: u16be(buf, rowStart + OFF_PACKREF),
    offset: u40be(buf, rowStart + OFF_OFFSET),
    length: u32be(buf, rowStart + OFF_LENGTH),
    deltaChainSpan: u32be(buf, rowStart + OFF_SPAN),
    deltaDepth: buf[rowStart + OFF_HINT] as number,
  }
}

/** Key of {@link ObjectLocator.buildOffsetIndex}: an object's `(packRef, offset)` address. */
export function offsetKey(packRef: number, offset: number): string {
  return `${packRef}:${offset}`
}

/** A fully-fetched, parsed objectLocator held in memory for repeated lookups. */
export class ObjectLocator {
  private constructor(
    private readonly bytes: Uint8Array,
    /** Number of rows. */
    readonly count: number,
  ) {}

  /** Parse a serialized locator (`fanout || rows`) for reading. */
  static parse(bytes: Uint8Array): ObjectLocator {
    if (bytes.length < FANOUT_LEN) throw new Error('locator shorter than fanout')
    const count = u32be(bytes, 255 * 4)
    if (bytes.length !== FANOUT_LEN + count * LOCATOR_ROW_LEN) {
      throw new Error('locator length inconsistent with fanout')
    }
    return new ObjectLocator(bytes, count)
  }

  /**
   * Merge published index fragments into one locator — the reader half of fragmented index
   * publication.
   *
   * A push publishes a locator over just the pack it stored (36 bytes per object ADDED,
   * rather than republishing the whole index on every push — forge-core
   * `RepoService::publish_push_locator`), so a repo between repacks has several live
   * fragments and a reader must fold them. Parity: forge-core `pack::ObjectLocator::merge`.
   *
   * **Rows are keyed by `(oid, packRef)`, not by `oid`.** An object routinely sits in more
   * than one live pack — a push whose `have` set was incomplete re-sends history an earlier
   * pack already holds — and each copy's row is the only record of that pack's address for
   * it. This locator is not just an OID map: {@link buildOffsetIndex} is built from these
   * rows and {@link BrowseReader} resolves an `OFS_DELTA` base by `(packRef, offset)`, where
   * the base of an object in pack N is always in pack N. Dropping the pack-N row because
   * pack 0 also carried the object leaves every delta in pack N that uses it unreadable —
   * and coverage checks cannot see it, because the surviving rows still name both packs.
   * So every copy is kept and only exact `(oid, packRef)` duplicates collapse, which keeps
   * the fold idempotent. {@link lookup} returns the lowest-`packRef` copy, so which pack an
   * OID resolves to does not change as fragments accumulate.
   *
   * Sound only when the fragments share a `packRef` space (or index prefixes of one).
   * `locatorPackSpace` defines that space and `loadBrowseContext` checks the fragments
   * cover it before trusting the result.
   */
  static merge(parts: readonly ObjectLocator[]): ObjectLocator {
    if (parts.length === 1) return parts[0] as ObjectLocator
    // Rows sort by their first OID_LEN+2 bytes: the oid, then packRef big-endian. That IS
    // the (oid, packRef) order, so a plain byte comparison drives the k-way merge.
    const KEY = OID_LEN + 2
    const cursors = new Array<number>(parts.length).fill(0)
    const rows: Uint8Array[] = []
    for (;;) {
      let pick = -1
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] as ObjectLocator
        if ((cursors[i] as number) >= part.count) continue
        if (pick < 0) {
          pick = i
          continue
        }
        const best = parts[pick] as ObjectLocator
        const cmp = compareBytes(
          part.row(cursors[i] as number),
          best.row(cursors[pick] as number),
          KEY,
        )
        if (cmp < 0) pick = i
      }
      if (pick < 0) break
      const chosen = parts[pick] as ObjectLocator
      const row = chosen.row(cursors[pick] as number)
      cursors[pick] = (cursors[pick] as number) + 1
      // Collapse only exact (oid, packRef) duplicates — the same pack indexed twice.
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j] as ObjectLocator
        while (
          (cursors[j] as number) < part.count &&
          compareBytes(part.row(cursors[j] as number), row, KEY) === 0
        ) {
          cursors[j] = (cursors[j] as number) + 1
        }
      }
      rows.push(row)
    }
    return ObjectLocator.fromSortedRows(rows)
  }

  /** Assemble `fanout || rows` from rows already sorted ascending by OID. */
  private static fromSortedRows(rows: readonly Uint8Array[]): ObjectLocator {
    const bytes = new Uint8Array(FANOUT_LEN + rows.length * LOCATOR_ROW_LEN)
    const counts = new Uint32Array(256)
    for (const r of rows) counts[r[0] as number] = (counts[r[0] as number] as number) + 1
    const view = new DataView(bytes.buffer)
    let cum = 0
    for (let b = 0; b < 256; b++) {
      cum += counts[b] as number
      view.setUint32(b * 4, cum, false)
    }
    rows.forEach((r, i) => bytes.set(r, FANOUT_LEN + i * LOCATOR_ROW_LEN))
    return new ObjectLocator(bytes, rows.length)
  }

  /** The serialized `fanout || rows` bytes. Parity: forge-core `ObjectLocator::as_bytes`. */
  asBytes(): Uint8Array {
    return this.bytes
  }

  /** The distinct `packRef`s this locator indexes — what a coverage check compares. */
  packRefsCovered(): Set<number> {
    const refs = new Set<number>()
    for (let i = 0; i < this.count; i++) {
      refs.add(u16be(this.bytes, this.rowStart(i) + OID_LEN))
    }
    return refs
  }

  /** One row's raw bytes (a view into the backing buffer — never mutated). */
  private row(i: number): Uint8Array {
    const start = this.rowStart(i)
    return this.bytes.subarray(start, start + LOCATOR_ROW_LEN)
  }

  /**
   * Build a `"packRef:offset" → entry` index over every row — the reverse map the
   * per-base delta walk needs to resolve an OFS base (referenced by pack offset, not
   * OID). Keyed by pack AND offset: different packs routinely store objects at the same
   * offset (every pack's first object sits at 12), so a bare-offset key collides the
   * moment a locator spans more than one pack. O(rows); used only on the deep-delta
   * fallback, and only when the full locator is in memory.
   */
  buildOffsetIndex(): Map<string, LocatorEntry> {
    const map = new Map<string, LocatorEntry>()
    for (let i = 0; i < this.count; i++) {
      const start = this.rowStart(i)
      const e = decodeRow(this.bytes, start)
      map.set(offsetKey(e.packRef, e.offset), e)
    }
    return map
  }

  private fanout(byte: number): number {
    return u32be(this.bytes, byte * 4)
  }

  private rowStart(i: number): number {
    return FANOUT_LEN + i * LOCATOR_ROW_LEN
  }

  /**
   * Look up an object: read the fanout, take the one 1/256 slice for the OID's first
   * byte, and binary-search it. Returns `null` if absent.
   */
  lookup(oid: Uint8Array): LocatorEntry | null {
    if (oid.length !== OID_LEN) return null
    const b = oid[0] as number
    let lo = b === 0 ? 0 : this.fanout(b - 1)
    let hi = this.fanout(b)
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const start = this.rowStart(mid)
      const cmp = compareOid(this.bytes, start, oid)
      if (cmp < 0) lo = mid + 1
      else if (cmp > 0) hi = mid
      else {
        // A merged locator can hold one row per pack storing this OID ({@link merge}).
        // They are adjacent and ordered by packRef, so walking back to the first makes the
        // answer the lowest-packRef copy wherever the binary search landed.
        let at = mid
        while (at > 0 && compareOid(this.bytes, this.rowStart(at - 1), oid) === 0) at--
        return decodeRow(this.bytes, this.rowStart(at))
      }
    }
    return null
  }
}

/** Compare the first `n` bytes of two rows. */
function compareBytes(x: Uint8Array, y: Uint8Array, n: number): number {
  for (let k = 0; k < n; k++) {
    const d = (x[k] as number) - (y[k] as number)
    if (d !== 0) return d
  }
  return 0
}

/** A ranged byte fetcher: returns `bytes[start, end)` of a resource. */
export type RangeFetch = (start: number, end: number) => Promise<Uint8Array>

/**
 * Look up an object using only ranged reads against the locator artifact — the
 * size-independent path (no need to download the whole locator). Reads the 1024-byte
 * fanout, computes the OID's 1/256 slice bounds, fetches just that slice, and binary
 * searches it. Returns `null` if absent.
 */
export async function lookupRanged(
  fetchLocatorRange: RangeFetch,
  oid: Uint8Array,
): Promise<LocatorEntry | null> {
  if (oid.length !== OID_LEN) return null
  const fanout = await fetchLocatorRange(0, FANOUT_LEN)
  const b = oid[0] as number
  const lo = b === 0 ? 0 : u32be(fanout, (b - 1) * 4)
  const hi = u32be(fanout, b * 4)
  if (lo >= hi) return null
  const sliceStart = FANOUT_LEN + lo * LOCATOR_ROW_LEN
  const sliceEnd = FANOUT_LEN + hi * LOCATOR_ROW_LEN
  const slice = await fetchLocatorRange(sliceStart, sliceEnd)
  // Binary search the fetched slice (rows [lo, hi)).
  let a = 0
  let c = hi - lo
  while (a < c) {
    const mid = (a + c) >>> 1
    const start = mid * LOCATOR_ROW_LEN
    const cmp = compareOid(slice, start, oid)
    if (cmp < 0) a = mid + 1
    else if (cmp > 0) c = mid
    else {
      // A merged locator can hold one row per pack storing this OID
      // ({@link ObjectLocator.merge}). The whole group is inside this fanout slice, so
      // walking back to its first row answers with the lowest packRef — the same choice
      // {@link ObjectLocator.lookup} makes over the fully-downloaded locator.
      let at = mid
      while (at > 0 && compareOid(slice, (at - 1) * LOCATOR_ROW_LEN, oid) === 0) at--
      return decodeRow(slice, at * LOCATOR_ROW_LEN)
    }
  }
  return null
}
