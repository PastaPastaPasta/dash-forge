/**
 * TEST FIXTURES ONLY — a one-commit repo in a real pack for the README image tests (imported
 * by `*.test.ts(x)`; never by app code, so never bundled). A blob can be stored whole, or as
 * an OFS delta against a small base: a delta whose result is megabytes is a few hundred bytes
 * in the pack, which is exactly what a stored-length size check misses.
 */

import { zlibSync } from 'fflate'

import { BrowseReader, ObjectLocator, applyDelta, gitOidHex } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { PACK_TYPE } from '../browse/pack'
import { concat, deltaSize, hexToBytes, objHeader, ofsBase, packFrame } from '../browse/pack-fixtures'

/** A `size`-byte file that starts with the PNG magic (enough for `imagePreviewType`). */
export function png(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

/** A delta that repeats all of `base` until the result is `targetLen` bytes. */
function repeatingDelta(base: Uint8Array, targetLen: number): Uint8Array {
  const ops: number[] = [...deltaSize(base.length), ...deltaSize(targetLen)]
  for (let left = targetLen; left > 0; ) {
    const n = Math.min(left, base.length)
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
}

/** A reader over one commit whose root tree holds `files`, that commit's oid, and each blob's oid. */
export async function imageRepo(files: readonly ImageRepoFile[]): Promise<{ reader: BrowseReader; tipOid: string; oids: Record<string, string> }> {
  const stored: Uint8Array[] = []
  let offset = 12 // after the pack header
  const put = (bytes: Uint8Array): number => {
    const at = offset
    stored.push(bytes)
    offset += bytes.length
    return at
  }
  const whole = (type: number, bytes: Uint8Array): number => put(concat(objHeader(type, bytes.length), zlibSync(bytes)))

  const oids: Record<string, string> = {}
  for (const f of files) {
    if (f.delta !== undefined) {
      const { base, size } = f.delta
      const delta = repeatingDelta(base, size)
      oids[f.name] = gitOidHex('blob', applyDelta(base, delta))
      const baseAt = whole(PACK_TYPE.BLOB, base)
      put(concat(objHeader(PACK_TYPE.OFS_DELTA, delta.length), ofsBase(offset - baseAt), zlibSync(delta)))
    } else {
      const bytes = f.bytes ?? new Uint8Array(0)
      oids[f.name] = gitOidHex('blob', bytes)
      whole(PACK_TYPE.BLOB, bytes)
    }
  }

  const enc = new TextEncoder()
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : 1))
  const tree = concat(...sorted.flatMap((f) => [enc.encode(`100644 ${f.name}\0`), hexToBytes(oids[f.name] as string)]))
  whole(PACK_TYPE.TREE, tree)
  const ident = 'A U Thor <a@example.com> 1700000000 +0000'
  const commit = enc.encode(`tree ${gitOidHex('tree', tree)}\nauthor ${ident}\ncommitter ${ident}\n\nimages\n`)
  whole(PACK_TYPE.COMMIT, commit)

  const pack = packFrame(...stored)
  const locator = ObjectLocator.parse(serializeLocator(await indexPacks([pack])))
  return { reader: new BrowseReader(locator, memoryPackSource([pack])), tipOid: gitOidHex('commit', commit), oids }
}
