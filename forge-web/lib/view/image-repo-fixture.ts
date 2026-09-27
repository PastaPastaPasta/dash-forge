/**
 * TEST FIXTURES ONLY — a one-commit repo in a real pack for the README image tests (imported
 * by `*.test.ts(x)`; never by app code, so never bundled). A blob can be stored whole, as an
 * OFS delta against a base (a delta whose result is megabytes is a few hundred bytes in the
 * pack, which a stored-length size check misses), or as a zip bomb whose header lies.
 */

import { zlibSync } from 'fflate'

import { BrowseReader, ObjectLocator, applyDelta, gitOidHex, type PackSource } from '../browse'
import { memoryPackSource, serializeLocator, type IndexedObject } from '../browse/indexer'
import { PACK_TYPE } from '../browse/pack'
import { concat, deltaSize, hexToBytes, objHeader, ofsBase, packFrame } from '../browse/pack-fixtures'

/** A `size`-byte file that starts with the PNG magic (enough for `imagePreviewType`). */
export function png(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

/** A delta that repeats `base` (or its first 64 KiB) until the result is `targetLen` bytes. */
function repeatingDelta(base: Uint8Array, targetLen: number): Uint8Array {
  const ops: number[] = [...deltaSize(base.length), ...deltaSize(targetLen)]
  for (let left = targetLen; left > 0; ) {
    const n = Math.min(left, base.length, 0xffff)
    ops.push(0x80 | 0x10 | 0x20, n & 0xff, (n >> 8) & 0xff) // copy base[0, n)
    left -= n
  }
  return new Uint8Array(ops)
}

export interface ImageRepoFile {
  readonly name: string
  /** Stored whole. */
  readonly bytes?: Uint8Array
  /** Stored as a delta that repeats `base` to `size` bytes (the blob is that result). */
  readonly delta?: { readonly base: Uint8Array; readonly size: number }
  /**
   * A zip bomb: the entry's header says `claimed` bytes (the tree names `png(claimed)`'s oid),
   * but its zlib stream inflates to `inflates` bytes of zeros.
   */
  readonly bomb?: { readonly claimed: number; readonly inflates: number }
}

export interface ImageRepo {
  readonly reader: BrowseReader
  readonly tipOid: string
  readonly oids: Record<string, string>
  /** Every range the reader fetched, `[start, end)`. */
  readonly fetched: [number, number][]
}

/**
 * A reader over one commit whose root tree holds `files`. `source` builds the pack source
 * from the pack (default: in memory), e.g. to add a tampered second copy.
 */
export function imageRepo(files: readonly ImageRepoFile[], source?: (pack: Uint8Array) => PackSource): ImageRepo {
  const stored: Uint8Array[] = []
  const rows: IndexedObject[] = []
  let offset = 12 // after the pack header
  const put = (oidHex: string, bytes: Uint8Array, deltaDepth = 0): number => {
    const at = offset
    stored.push(bytes)
    rows.push({ oidHex, packRef: 0, offset: at, length: bytes.length, deltaDepth })
    offset += bytes.length
    return at
  }
  const whole = (type: 'blob' | 'tree' | 'commit', code: number, bytes: Uint8Array): string => {
    const oid = gitOidHex(type, bytes)
    put(oid, concat(objHeader(code, bytes.length), zlibSync(bytes)))
    return oid
  }

  const oids: Record<string, string> = {}
  for (const f of files) {
    if (f.delta !== undefined) {
      const { base, size } = f.delta
      const delta = repeatingDelta(base, size)
      oids[f.name] = gitOidHex('blob', applyDelta(base, delta))
      whole('blob', PACK_TYPE.BLOB, base)
      const baseAt = offset - (stored[stored.length - 1] as Uint8Array).length
      put(oids[f.name] as string, concat(objHeader(PACK_TYPE.OFS_DELTA, delta.length), ofsBase(offset - baseAt), zlibSync(delta)), 1)
    } else if (f.bomb !== undefined) {
      oids[f.name] = gitOidHex('blob', png(f.bomb.claimed))
      put(oids[f.name] as string, concat(objHeader(PACK_TYPE.BLOB, f.bomb.claimed), zlibSync(new Uint8Array(f.bomb.inflates), { level: 9 })))
    } else {
      oids[f.name] = whole('blob', PACK_TYPE.BLOB, f.bytes ?? new Uint8Array(0))
    }
  }

  const enc = new TextEncoder()
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : 1))
  const tree = concat(...sorted.flatMap((f) => [enc.encode(`100644 ${f.name}\0`), hexToBytes(oids[f.name] as string)]))
  const treeOid = whole('tree', PACK_TYPE.TREE, tree)
  const ident = 'A U Thor <a@example.com> 1700000000 +0000'
  const tipOid = whole('commit', PACK_TYPE.COMMIT, enc.encode(`tree ${treeOid}\nauthor ${ident}\ncommitter ${ident}\n\nimages\n`))

  const pack = packFrame(...stored)
  const inner = source?.(pack) ?? memoryPackSource([pack])
  const fetched: [number, number][] = []
  const counted: PackSource = {
    ...inner,
    fetchRange: (packRef, start, end, copy) => {
      fetched.push([start, end])
      return inner.fetchRange(packRef, start, end, copy)
    },
  }
  const reader = new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), counted)
  return { reader, tipOid, oids, fetched }
}
