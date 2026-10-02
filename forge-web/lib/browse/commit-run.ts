/**
 * Commits a history walk finds without asking its index (QW3-001).
 *
 * An index read a slice at a time ({@link RangedLocator}) costs a query per lookup, and a
 * history walk looks up one commit after another, each the parent of the last: one page of
 * dashpay/dash's log was 35 slice reads in a row. But `git pack-objects` writes a pack's commits
 * first, newest first, one after the other, and a walk reads them through read-ahead blocks
 * ({@link readAheadSource}): once it has read one commit, the ones after it are in the block it
 * already holds. {@link scanCommits} parses those entries in order from the end of the one
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

/**
 * Index lookups a history walk makes beyond what it learned before it has the index read whole
 * ({@link WalkIndex.lookup}). A page of log, a file's History or a commit asks a handful; a
 * dash-sized merge-base search or a column walked 400 commits from an unindexed tip asked 130-170,
 * one after the other, and then read the whole index anyway (its byte rule, `ESCALATE_FRACTION`).
 * The whole of dash's is 7 queries.
 */
export const WALK_LOOKUPS_BEFORE_WHOLE = 24

/** A commit found in a scan: its oid and pack entry. */
export interface ScannedCommit {
  readonly oid: string
  readonly entry: LocatorEntry
}

/** Pack bytes held in memory: `bytes` are the pack's from offset `start`. */
export interface PackWindow {
  readonly start: number
  readonly bytes: Uint8Array
}

/** What a scan found, and where it stopped. */
export interface CommitRun {
  readonly found: ScannedCommit[]
  /**
   * The offset of the entry the scan stopped at because it would not parse: usually one the
   * window cuts short at its end, which the next block (once held) can finish. Null when the run
   * ended (a whole tree, blob or tag) or the scan reached its bound.
   */
  readonly cutAt: number | null
}

/**
 * Delta-chain steps a scan follows to the commit a delta is built on (git's default `pack.depth`
 * is 50; a longer chain is left to the index).
 */
const SCAN_CHAIN_MAX = 64

/**
 * The commits stored in `block` (pack `packRef`'s bytes from offset `blockStart`) from the entry at
 * pack offset `from` on, and where the scan stopped: whole ones, and OFS deltas of commits. A
 * delta's base is decoded where it is held: earlier in the same scan, or anywhere in `block` or in
 * a window `held` returns (a block read before), following its chain; a delta built on a tree or a blob, or on a base not held, is
 * stepped over. A whole tree, blob or tag ends the scan (the commit run is over), as does an entry
 * the block cuts short or that does not parse.
 *
 * A dash mirror stores runs of its commits as deltas of commits written before them (QW4-003:
 * 789 of the 37,293 commits a v22.0.0...v23.0.0 merge-base search reads), often of one before the
 * entry the scan starts at; each was an index query of its own.
 */
export function scanCommits(block: Uint8Array, blockStart: number, from: number, packRef: number, held?: (offset: number) => PackWindow | undefined): CommitRun {
  const found: ScannedCommit[] = []
  // Decoded entries by pack offset (each is decoded, and so noted, once); null: not a commit (or
  // not decodable here).
  const decoded = new Map<number, GitObject | null>()
  const note = (offset: number, obj: GitObject, length: number, whole: boolean): void => {
    found.push({
      oid: gitOidHex('commit', obj.bytes),
      entry: { packRef, offset, length, deltaChainSpan: whole ? length : SPAN_SENTINEL, deltaDepth: whole ? 0 : 1 },
    })
  }
  const windowOf = (offset: number): PackWindow | undefined => {
    if (offset >= blockStart && offset < blockStart + block.length) return { start: blockStart, bytes: block }
    const w = held?.(offset)
    return w !== undefined && offset >= w.start && offset < w.start + w.bytes.length ? w : undefined
  }
  /**
   * The commit at `offset` (a base some delta names), decoded from what is held; null when it is
   * not a commit or cannot be decoded here. Headers are read first, so a chain that ends at a tree
   * or a blob costs no inflate.
   */
  const commitAt = (offset: number, depth: number): GitObject | null => {
    const known = decoded.get(offset)
    if (known !== undefined) return known
    // Too deep from here (not cached: a shallower delta on the same base may still decode it).
    if (depth > SCAN_CHAIN_MAX) return null
    let out: GitObject | null = null
    const w = windowOf(offset)
    if (w !== undefined) {
      try {
        const at = offset - w.start
        const h = parseObjHeader(w.bytes, at)
        if (h.type === PACK_TYPE.COMMIT) {
          const { bytes, consumed } = inflateZlibMeasured(w.bytes, h.after, h.size, COMMIT_MAX_BYTES)
          out = { type: 'commit', bytes }
          note(offset, out, h.after + consumed - at, true)
        } else if (h.type === PACK_TYPE.OFS_DELTA) {
          const [rel, dpos] = parseOfsBase(w.bytes, h.after)
          const base = rel > 0 ? commitAt(offset - rel, depth + 1) : null
          if (base !== null) {
            const { bytes: delta, consumed } = inflateZlibMeasured(w.bytes, dpos, h.size, deltaMaxBytes(COMMIT_MAX_BYTES))
            out = { type: 'commit', bytes: applyDelta(base.bytes, delta, COMMIT_MAX_BYTES) }
            note(offset, out, dpos + consumed - at, false)
          }
        }
      } catch {
        out = null
      }
    }
    decoded.set(offset, out)
    return out
  }
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
        const base = rel > 0 ? commitAt(offset - rel, 1) : null
        if (base !== null) obj = { type: 'commit', bytes: applyDelta(base.bytes, delta, COMMIT_MAX_BYTES) }
        end = dpos + consumed
      } else if (h.type === PACK_TYPE.REF_DELTA) {
        end = h.after + 20 + inflateZlibMeasured(block, h.after + 20, h.size, deltaMaxBytes(COMMIT_MAX_BYTES)).consumed
      } else {
        return { found, cutAt: null }
      }
      decoded.set(offset, obj)
      if (obj !== null) note(offset, obj, end - at, h.type === PACK_TYPE.COMMIT)
      at = end
    } catch {
      return { found, cutAt: offset }
    }
  }
  return { found, cutAt: null }
}

/**
 * A history walk's index: what it learned from the commit runs it read ({@link scanCommits}),
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

  /**
   * A scan waiting for a block on its way (the run goes on past the block a commit was read from):
   * a lookup it may answer waits for it rather than ask the index for what the block will tell.
   */
  learning(scan: Promise<void>): void {
    const settled = scan.catch(() => undefined)
    this.pending.add(settled)
    void settled.then(() => this.pending.delete(settled))
  }

  private readonly pending = new Set<Promise<void>>()
  /** Lookups the walk asked the repo's index ({@link WALK_LOOKUPS_BEFORE_WHOLE}). */
  private asked = 0

  async lookup(oid: Uint8Array): Promise<LocatorEntry | null> {
    const known = this.byOid.get(bytesToHex(oid))
    if (known !== undefined) return known
    return this.ask(oid)
  }

  /**
   * {@link lookup} of an object the caller expects to be a commit: while a scan of the run is on
   * its way it waits for that (one block) rather than ask the index, which the scan would answer.
   * Other objects (a tree, a blob) are never in a run, and do not wait.
   */
  async lookupCommit(oid: Uint8Array): Promise<LocatorEntry | null> {
    const hex = bytesToHex(oid)
    while (!this.byOid.has(hex) && this.pending.size > 0) await Promise.all(this.pending)
    return this.byOid.get(hex) ?? this.ask(oid)
  }

  private ask(oid: Uint8Array): Promise<LocatorEntry | null> {
    // A walk that keeps asking the index will ask it many more times (a long merge-base search,
    // a column walked from a tip no history index covers): past a few dozen queries one after the
    // other, the whole index in a few large ones costs less (QW4-003, QW4-004).
    if (++this.asked === WALK_LOOKUPS_BEFORE_WHOLE && !this.inner.inMemory) this.inner.preload().catch(() => undefined)
    return this.inner.lookup(oid)
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
