/**
 * flatIndex reader — a tip commit's full recursive file listing (GitHub's tree API as one
 * static artifact, data-contracts §2.3).
 *
 * Read-side port of `crates/forge-core/src/pack/flatindex.rs`. gzip-compressed body:
 *   tipOid(20) || varint(nrows) || row*
 *   row = mode(u32 BE) || oid(20) || varint(size) || varint(pathLen) || path(utf8)
 *
 * Entries are path-sorted; includes tree nodes and gitlink submodule entries (mode
 * 0o160000 = 57344). This is deferred from the cold repo-home to deep tree-browse /
 * filename-search (it is O(files); the home view rides the locator instead).
 */

import { gunzipSync } from 'fflate'
import { bytesToHex } from '@noble/hashes/utils.js'

const OID_LEN = 20
/** git file mode of a gitlink (submodule) entry — numeric value of octal 160000. */
export const MODE_GITLINK = 0o160_000
/** git file mode of a tree (directory) node — numeric value of octal 40000. */
export const MODE_TREE = 0o040_000

/** One entry in a flat index. */
export interface FlatEntry {
  /** Repository-root-relative path. */
  readonly path: string
  /** Object id (hex) at the path (tree, blob, or submodule commit). */
  readonly oid: string
  /** git file mode. */
  readonly mode: number
  /** Object size in bytes (0 for trees and gitlinks). */
  readonly size: number
}

function readVarint(buf: Uint8Array, pos: { i: number }): number {
  let r = 0
  let shift = 0
  for (;;) {
    const b = buf[pos.i]
    if (b === undefined) throw new Error('flatIndex truncated (varint)')
    pos.i += 1
    r += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return r
}

function u32be(buf: Uint8Array, at: number): number {
  const a = buf[at]
  const b = buf[at + 1]
  const c = buf[at + 2]
  const d = buf[at + 3]
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error('flatIndex truncated (mode)')
  }
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

/** A parsed flat index over one tip commit. */
export class FlatIndex {
  private constructor(
    /** The tip commit OID (hex) this index describes. */
    readonly tip: string,
    private readonly entriesArr: readonly FlatEntry[],
  ) {}

  /** Parse a gzip-compressed flatIndex artifact. */
  static parse(compressed: Uint8Array): FlatIndex {
    const body = gunzipSync(compressed)
    const pos = { i: 0 }
    if (body.length < OID_LEN) throw new Error('flatIndex truncated (tip)')
    const tip = bytesToHex(body.subarray(0, OID_LEN))
    pos.i = OID_LEN
    const nrows = readVarint(body, pos)

    const entries: FlatEntry[] = []
    for (let n = 0; n < nrows; n++) {
      const mode = u32be(body, pos.i)
      pos.i += 4
      if (pos.i + OID_LEN > body.length) throw new Error('flatIndex truncated (oid)')
      const oid = bytesToHex(body.subarray(pos.i, pos.i + OID_LEN))
      pos.i += OID_LEN
      const size = readVarint(body, pos)
      const plen = readVarint(body, pos)
      if (pos.i + plen > body.length) throw new Error('flatIndex truncated (path)')
      const path = new TextDecoder('utf-8', { fatal: false }).decode(
        body.subarray(pos.i, pos.i + plen),
      )
      pos.i += plen
      entries.push({ path, oid, mode, size })
    }
    return new FlatIndex(tip, entries)
  }

  /** All entries, path-sorted. */
  entries(): readonly FlatEntry[] {
    return this.entriesArr
  }

  /** Look up a single path. */
  lookup(path: string): FlatEntry | null {
    // Binary search (entries are path-sorted).
    let lo = 0
    let hi = this.entriesArr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const e = this.entriesArr[mid] as FlatEntry
      if (e.path < path) lo = mid + 1
      else if (e.path > path) hi = mid
      else return e
    }
    return null
  }

  /** List the immediate children of a directory `prefix` (`""` = repo root). */
  listDir(prefix: string): FlatEntry[] {
    const norm = prefix.length === 0 || prefix.endsWith('/') ? prefix : `${prefix}/`
    return this.entriesArr.filter((e) => {
      if (!e.path.startsWith(norm)) return false
      const rest = e.path.slice(norm.length)
      return rest.length > 0 && !rest.includes('/')
    })
  }
}
