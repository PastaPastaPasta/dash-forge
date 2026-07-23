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
      else return decodeRow(this.bytes, start)
    }
    return null
  }
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
    else return decodeRow(slice, start)
  }
  return null
}
