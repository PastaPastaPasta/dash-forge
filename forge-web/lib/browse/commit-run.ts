/**
 * Commits a history walk finds without asking its index (QW3-001).
 *
 * An index read a slice at a time ({@link RangedLocator}) costs a query per lookup, and a
 * history walk looks up one commit after another, each the parent of the last: one page of
 * dashpay/dash's log was 35 slice reads in a row. But `git pack-objects` writes a pack's commits
 * first, newest first, one after the other, and a walk reads them through read-ahead blocks
 * ({@link readAheadSource}): once it has read one commit, the ones after it are in the block it
 * already holds. {@link scanCommitRun} parses those entries in order from the end of the one
 * read, hashes each commit, and so learns where they are ({@link WalkIndex}): the walk's next
 * lookups answer from that, and the index is asked again only where the run leaves the block.
 *
 * What is learned is no more trusted than an index row: the reader rebuilds the object at the
 * address and hashes it against the oid it wanted, as for any read.
 */

import { bytesToHex } from '@noble/hashes/utils.js'

import { SPAN_SENTINEL, offsetKey, type LocatorEntry } from './locator'
import type { ObjectIndex } from './object-index'
import { PACK_TYPE, applyDelta, deltaMaxBytes, gitOidHex, inflateZlibMeasured, parseObjHeader, parseOfsBase, type GitObject } from './pack'

/** A commit larger than this ends a scan (a real one is a few KiB at most). */
const COMMIT_MAX_BYTES = 1024 * 1024
/** Entries one scan parses at most (a 256 KiB block holds a few hundred commits). */
const SCAN_MAX_ENTRIES = 4096

/** A commit found in a scan: its oid and pack entry. */
export interface ScannedCommit {
  readonly oid: string
  readonly entry: LocatorEntry
}

/**
 * The commits stored in `block` (pack `packRef`'s bytes from offset `blockStart`) from the entry at
 * pack offset `from` on: whole ones, and OFS deltas of commits found earlier in the same scan.
 * Another delta is stepped over; a whole tree, blob or tag ends the scan (the commit run is over),
 * as does an entry the block cuts short or that does not parse.
 */
export function scanCommitRun(block: Uint8Array, blockStart: number, from: number, packRef: number): ScannedCommit[] {
  const found: ScannedCommit[] = []
  const decoded = new Map<number, GitObject>()
  let at = from - blockStart
  for (let n = 0; n < SCAN_MAX_ENTRIES && at >= 0 && at < block.length; n++) {
    const offset = blockStart + at
    try {
      const h = parseObjHeader(block, at)
      let obj: GitObject | null = null
      let end: number
      if (h.type === PACK_TYPE.COMMIT) {
        const { bytes, consumed } = inflateZlibMeasured(block, h.after, h.size, COMMIT_MAX_BYTES)
        obj = { type: 'commit', bytes }
        end = h.after + consumed
      } else if (h.type === PACK_TYPE.OFS_DELTA) {
        const [rel, dpos] = parseOfsBase(block, h.after)
        const { bytes: delta, consumed } = inflateZlibMeasured(block, dpos, h.size, deltaMaxBytes(COMMIT_MAX_BYTES))
        const base = decoded.get(offset - rel)
        if (base !== undefined) obj = { type: base.type, bytes: applyDelta(base.bytes, delta, COMMIT_MAX_BYTES) }
        end = dpos + consumed
      } else if (h.type === PACK_TYPE.REF_DELTA) {
        end = h.after + 20 + inflateZlibMeasured(block, h.after + 20, h.size, deltaMaxBytes(COMMIT_MAX_BYTES)).consumed
      } else {
        break
      }
      if (obj !== null) {
        decoded.set(offset, obj)
        const whole = h.type === PACK_TYPE.COMMIT
        found.push({
          oid: gitOidHex('commit', obj.bytes),
          entry: { packRef, offset, length: end - at, deltaChainSpan: whole ? end - at : SPAN_SENTINEL, deltaDepth: whole ? 0 : 1 },
        })
      }
      at = end
    } catch {
      break
    }
  }
  return found
}

/**
 * A history walk's index: what it learned from the commit runs it read ({@link scanCommitRun}),
 * then the repo's index.
 */
export class WalkIndex implements ObjectIndex {
  private readonly byOid = new Map<string, LocatorEntry>()
  private readonly byAddress = new Map<string, LocatorEntry>()

  constructor(private readonly inner: ObjectIndex) {}

  get count(): number {
    return this.inner.count
  }

  get inMemory(): boolean {
    return this.inner.inMemory
  }

  /** Whether the entry at `(packRef, offset)` was learned (a run already scanned from there). */
  knows(packRef: number, offset: number): boolean {
    return this.byAddress.has(offsetKey(packRef, offset))
  }

  learn(commits: readonly ScannedCommit[]): void {
    for (const { oid, entry } of commits) {
      if (!this.byOid.has(oid)) this.byOid.set(oid, entry)
      this.byAddress.set(offsetKey(entry.packRef, entry.offset), entry)
    }
  }

  async lookup(oid: Uint8Array): Promise<LocatorEntry | null> {
    return this.byOid.get(bytesToHex(oid)) ?? this.inner.lookup(oid)
  }

  peek(oid: Uint8Array): LocatorEntry | null | undefined {
    return this.byOid.get(bytesToHex(oid)) ?? this.inner.peek(oid)
  }

  findByPrefix(prefix: string, limit?: number): Promise<string[]> {
    return this.inner.findByPrefix(prefix, limit)
  }

  atOffset(packRef: number, offset: number): LocatorEntry | null | undefined {
    return this.byAddress.get(offsetKey(packRef, offset)) ?? this.inner.atOffset(packRef, offset)
  }

  preload(): Promise<void> {
    return this.inner.preload()
  }
}
