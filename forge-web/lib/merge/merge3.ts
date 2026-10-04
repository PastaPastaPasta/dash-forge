/**
 * A three-way merge of one file's contents, as git's `xdl_merge` (`xdiff/xmerge.c`, v2.56) does it
 * for `merge-ort` (`ll_xdl_merge`): the base→ours and base→theirs edit scripts ({@link diffChanges},
 * histogram), walked together by `xdl_do_merge`. A change only one side made is taken; two
 * changes that overlap or touch (no unchanged line between them) are a conflict, unless they are
 * the very same change.
 *
 * Only a clean merge produces bytes. The verdict is git's at `XDL_MERGE_EAGER`: conflicts are not
 * refined. git's default (`XDL_MERGE_ZEALOUS`, conflict style "merge") also resolves an overlap
 * whose two sides end up identical line for line, but a `merge.conflictStyle` of `diff3` or
 * `zdiff3` turns that off, so the browser refuses those few merges whatever the merger's git is
 * configured with. Every merge accepted here is clean, byte for byte the same, under all of them.
 *
 * Refused as git's own binary-merge conflict: any side with a NUL in its first 8000 bytes
 * (`buffer_is_binary`). Refused as too large for a tab: any side over {@link MERGE3_MAX_BYTES}.
 */

import { concat } from '../private/bytes'
import { diffChanges, recordKey, splitRecords, XdiffError, type XdChange } from './xdiff'

/** The largest file the browser merges line by line (git's own limit is 1 GiB). */
export const MERGE3_MAX_BYTES = 2 * 1024 * 1024

/** git's `FIRST_FEW_BYTES`: how far `buffer_is_binary` looks for a NUL. */
const FIRST_FEW_BYTES = 8000

/** `buffer_is_binary`. */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, Math.min(bytes.length, FIRST_FEW_BYTES)).includes(0)
}

export type Merge3Result =
  | { readonly kind: 'clean'; readonly bytes: Uint8Array }
  /** git conflicts (or would at a stricter conflict style). */
  | { readonly kind: 'conflict' }
  /** Not merged here: binary, too large, or a diff git itself gives up on. */
  | { readonly kind: 'refused'; readonly reason: string }

interface XdMerge {
  mode: 0 | 1 | 2
  i0: number
  chg0: number
  i1: number
  chg1: number
  i2: number
  chg2: number
}

/** `xdl_append_merge`: a region joins the previous one when they touch (its mode then 0 unless equal). */
function appendMerge(list: XdMerge[], mode: 0 | 1 | 2, i0: number, chg0: number, i1: number, chg1: number, i2: number, chg2: number): void {
  const m = list[list.length - 1]
  if (m !== undefined && (i1 <= m.i1 + m.chg1 || i2 <= m.i2 + m.chg2)) {
    if (mode !== m.mode) m.mode = 0
    m.chg0 = i0 + chg0 - m.i0
    m.chg1 = i1 + chg1 - m.i1
    m.chg2 = i2 + chg2 - m.i2
  } else {
    list.push({ mode, i0, chg0, i1, chg1, i2, chg2 })
  }
}

/** `xdl_do_merge` at `XDL_MERGE_EAGER`, without output: the merge regions. */
function doMerge(xscr1: readonly XdChange[], ours: readonly string[], n0a: number, xscr2: readonly XdChange[], theirs: readonly string[], n0b: number): XdMerge[] {
  const c: XdMerge[] = []
  let a = 0
  let b = 0
  const sameLines = (i1: number, i2: number, count: number): boolean => {
    for (let k = 0; k < count; k++) if (ours[i1 + k] !== theirs[i2 + k]) return false
    return true
  }
  while (a < xscr1.length && b < xscr2.length) {
    const x1 = xscr1[a] as XdChange
    const x2 = xscr2[b] as XdChange
    if (x1.i1 + x1.chg1 < x2.i1) {
      appendMerge(c, 1, x1.i1, x1.chg1, x1.i2, x1.chg2, x2.i2 - x2.i1 + x1.i1, x1.chg1)
      a++
      continue
    }
    if (x2.i1 + x2.chg1 < x1.i1) {
      appendMerge(c, 2, x2.i1, x2.chg1, x1.i2 - x1.i1 + x2.i1, x2.chg1, x2.i2, x2.chg2)
      b++
      continue
    }
    if (x1.i1 !== x2.i1 || x1.chg1 !== x2.chg1 || x1.chg2 !== x2.chg2 || !sameLines(x1.i2, x2.i2, x1.chg2)) {
      const off = x1.i1 - x2.i1
      const ffo = off + x1.chg1 - x2.chg1
      let i0 = x1.i1
      let i1 = x1.i2
      let i2 = x2.i2
      if (off > 0) {
        i0 -= off
        i1 -= off
      } else i2 += off
      let chg0 = x1.i1 + x1.chg1 - i0
      let chg1 = x1.i2 + x1.chg2 - i1
      let chg2 = x2.i2 + x2.chg2 - i2
      if (ffo < 0) {
        chg0 -= ffo
        chg1 -= ffo
      } else chg2 += ffo
      appendMerge(c, 0, i0, chg0, i1, chg1, i2, chg2)
    }
    const e1 = x1.i1 + x1.chg1
    const e2 = x2.i1 + x2.chg1
    if (e1 >= e2) b++
    if (e2 >= e1) a++
  }
  for (; a < xscr1.length; a++) {
    const x1 = xscr1[a] as XdChange
    appendMerge(c, 1, x1.i1, x1.chg1, x1.i2, x1.chg2, x1.i1 + theirs.length - n0b, x1.chg1)
  }
  for (; b < xscr2.length; b++) {
    const x2 = xscr2[b] as XdChange
    appendMerge(c, 2, x2.i1, x2.chg1, x2.i1 + ours.length - n0a, x2.chg1, x2.i2, x2.chg2)
  }
  return c
}

/**
 * Merge `ours` and `theirs`, both changed from `base` (none equal to it: the tree merge takes
 * an unchanged side's partner without reading contents), as `git merge` does a file both sides
 * changed.
 */
export function merge3(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Merge3Result {
  if (base.length > MERGE3_MAX_BYTES || ours.length > MERGE3_MAX_BYTES || theirs.length > MERGE3_MAX_BYTES) {
    return { kind: 'refused', reason: `a file over ${MERGE3_MAX_BYTES / (1024 * 1024)} MiB` }
  }
  if (isBinary(base) || isBinary(ours) || isBinary(theirs)) return { kind: 'conflict' }
  const recs0 = splitRecords(base)
  const recs1 = splitRecords(ours)
  const recs2 = splitRecords(theirs)
  const k0 = recs0.map(recordKey)
  const k1 = recs1.map(recordKey)
  const k2 = recs2.map(recordKey)
  let xscr1: readonly XdChange[]
  let xscr2: readonly XdChange[]
  try {
    xscr1 = diffChanges(k0, k1, 'histogram')
    xscr2 = diffChanges(k0, k2, 'histogram')
  } catch (e) {
    if (e instanceof XdiffError) return { kind: 'refused', reason: e.message }
    throw e
  }
  // `xdl_merge`: a side without changes is the other side whole.
  if (xscr1.length === 0) return { kind: 'clean', bytes: theirs }
  if (xscr2.length === 0) return { kind: 'clean', bytes: ours }
  const regions = doMerge(xscr1, k1, k0.length, xscr2, k2, k0.length)
  if (regions.some((m) => m.mode === 0)) return { kind: 'conflict' }
  // `xdl_fill_merge_buffer`: ours up to each region, then the side that changed it.
  const parts: Uint8Array[] = []
  let i = 0
  for (const m of regions) {
    for (let k = i; k < m.i1; k++) parts.push(recs1[k] as Uint8Array)
    if (m.mode === 1) for (let k = m.i1; k < m.i1 + m.chg1; k++) parts.push(recs1[k] as Uint8Array)
    else for (let k = m.i2; k < m.i2 + m.chg2; k++) parts.push(recs2[k] as Uint8Array)
    i = m.i1 + m.chg1
  }
  for (let k = i; k < recs1.length; k++) parts.push(recs1[k] as Uint8Array)
  return { kind: 'clean', bytes: concat(...parts) }
}
