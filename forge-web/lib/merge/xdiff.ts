/**
 * git's histogram diff (`xdiff/xhistogram.c`, git v2.56) and the edit script a merge works from,
 * so the browser sees exactly the changes git's merge machinery sees:
 *
 *  - {@link diffChanges}: `xdl_do_diff` + `xdl_change_compact` (both ways) + `xdl_build_script`,
 *    with the histogram algorithm (what `merge-ort` uses for content merges: `init_merge_options`
 *    sets `HISTOGRAM_DIFF`) or classic Myers (what `git diff` and patch ids use). No whitespace
 *    flags and no indent heuristic: a merge passes only the algorithm.
 *
 * Myers is the port blame already uses (`lib/view/xdiff.ts`), and so is compaction
 * (`lib/view/xdiff-compact.ts`, with the histogram re-diff of a grown group); this file adds the
 * histogram search, which falls back to Myers where git's does. Its structure, names and order of
 * operations follow the C, so the two can be read side by side.
 *
 * Lines are records as xdiff reads them: everything up to and including a `\n` (the last record
 * may lack one), compared byte for byte. A diff git itself gives up on (`scanA`'s 64-record hash
 * chain limit) throws {@link XdiffError}; the merge refuses it too rather than guess.
 */

import { xdiffChanges } from '../view/xdiff'
import { compactChanges } from '../view/xdiff-compact'

/** git's xdiff gave up on these inputs (git's merge fails on them as well). */
export class XdiffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XdiffError'
  }
}

/** One change of an edit script: `chg1` records at `i1` of file 1 became `chg2` at `i2` of file 2 (0-based). */
export interface XdChange {
  readonly i1: number
  readonly i2: number
  readonly chg1: number
  readonly chg2: number
}

export type DiffAlgorithm = 'myers' | 'histogram'

/** Split `bytes` into xdiff records (each keeps its `\n`). */
export function splitRecords(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      out.push(bytes.subarray(start, i + 1))
      start = i + 1
    }
  }
  if (start < bytes.length) out.push(bytes.subarray(start))
  return out
}

/** A record as a string key, one char per byte (so equal keys are equal bytes). */
export function recordKey(rec: Uint8Array): string {
  let s = ''
  // Chunked: String.fromCharCode takes its bytes as arguments.
  for (let i = 0; i < rec.length; i += 8192) s += String.fromCharCode(...rec.subarray(i, Math.min(rec.length, i + 8192)))
  return s
}

/** No bound on a Myers diff: xdiff has none (its own cost heuristics bound the search). */
const NO_LIMITS = { maxEdits: Infinity, maxWork: Infinity }

/** `xdl_hashbits`. */
function hashbits(size: number): number {
  let val = 1
  let bits = 0
  for (; val < size && bits < 32; val *= 2, bits++);
  return bits !== 0 ? bits : 1
}

/** `XDL_HASHLONG(v, b)` on a 64-bit unsigned long (`v` is small here). */
function hashlong(v: number, b: number): number {
  return (v + Math.floor(v / 2 ** b)) % 2 ** b
}

/** Both files of a histogram diff: records, their classes (`minimal_perfect_hash`), change marks. */
interface HistFile {
  readonly keys: readonly string[]
  readonly ids: Int32Array
  readonly changed: Uint8Array
}

/**
 * `xdl_fall_back_diff`: a Myers diff of records `[line1, line1 + count1)` of `a` against
 * `[line2, line2 + count2)` of `b` (1-based), its marks copied into theirs.
 */
function fallBackDiff(a: HistFile, b: HistFile, line1: number, count1: number, line2: number, count2: number): void {
  const sub = xdiffChanges(a.keys.slice(line1 - 1, line1 - 1 + count1), b.keys.slice(line2 - 1, line2 - 1 + count2), NO_LIMITS)
  if (sub === null) throw new XdiffError('an unbounded diff gave up')
  a.changed.set(sub.oldChanged, line1 - 1)
  b.changed.set(sub.newChanged, line2 - 1)
}

const MAX_CHAIN_LENGTH = 64
const MAX_CNT = 0xffffffff

interface HistRecord {
  ptr: number
  cnt: number
  next: HistRecord | null
}

interface Region {
  begin1: number
  end1: number
  begin2: number
  end2: number
}

/** `find_lcs`: -1 (git fails), 1 (fall back to Myers), or 0 with `lcs` set (all zero: none found). */
function findLcs(x1: HistFile, x2: HistFile, lcs: Region, line1: number, count1: number, line2: number, count2: number): -1 | 0 | 1 {
  const tableBits = hashbits(count1)
  const records: (HistRecord | null)[] = new Array<HistRecord | null>(2 ** tableBits).fill(null)
  const lineMap: (HistRecord | null)[] = new Array<HistRecord | null>(count1).fill(null)
  const nextPtrs = new Float64Array(count1)
  const ptrShift = line1
  const end1 = line1 + count1 - 1
  const end2 = line2 + count2 - 1
  const id1 = (l: number): number => x1.ids[l - 1] as number
  const id2 = (l: number): number => x2.ids[l - 1] as number

  // scanA: chain every line of the region under its record, last line first.
  for (let ptr = end1; line1 <= ptr; ptr--) {
    const tbl = hashlong(id1(ptr), tableBits)
    let rec = records[tbl] ?? null
    let chainLen = 0
    let found = false
    while (rec !== null) {
      if (id1(rec.ptr) === id1(ptr)) {
        nextPtrs[ptr - ptrShift] = rec.ptr
        rec.ptr = ptr
        rec.cnt = Math.min(MAX_CNT, rec.cnt + 1)
        lineMap[ptr - ptrShift] = rec
        found = true
        break
      }
      rec = rec.next
      chainLen++
    }
    if (found) continue
    if (chainLen === MAX_CHAIN_LENGTH) return -1
    const fresh: HistRecord = { ptr, cnt: 1, next: records[tbl] ?? null }
    records[tbl] = fresh
    lineMap[ptr - ptrShift] = fresh
  }

  let indexCnt = MAX_CHAIN_LENGTH + 1
  let hasCommon = false
  const cnt = (ptr: number): number => (lineMap[ptr - ptrShift] as HistRecord).cnt
  const nextPtr = (ptr: number): number => nextPtrs[ptr - ptrShift] as number

  // try_lcs for every b_ptr.
  for (let bPtr = line2; bPtr <= end2; ) {
    let bNext = bPtr + 1
    for (let rec = records[hashlong(id2(bPtr), tableBits)] ?? null; rec !== null; rec = rec.next) {
      if (rec.cnt > indexCnt) {
        if (!hasCommon) hasCommon = id1(rec.ptr) === id2(bPtr)
        continue
      }
      let as1 = rec.ptr
      if (id1(as1) !== id2(bPtr)) continue
      hasCommon = true
      for (;;) {
        let np = nextPtr(as1)
        let bs = bPtr
        let ae = as1
        let be = bs
        let rc = rec.cnt
        while (line1 < as1 && line2 < bs && id1(as1 - 1) === id2(bs - 1)) {
          as1--
          bs--
          if (1 < rc) rc = Math.min(rc, cnt(as1))
        }
        while (ae < end1 && be < end2 && id1(ae + 1) === id2(be + 1)) {
          ae++
          be++
          if (1 < rc) rc = Math.min(rc, cnt(ae))
        }
        if (bNext <= be) bNext = be + 1
        if (lcs.end1 - lcs.begin1 < ae - as1 || rc < indexCnt) {
          lcs.begin1 = as1
          lcs.begin2 = bs
          lcs.end1 = ae
          lcs.end2 = be
          indexCnt = rc
        }
        if (np === 0) break
        let shouldBreak = false
        while (np <= ae) {
          np = nextPtr(np)
          if (np === 0) {
            shouldBreak = true
            break
          }
        }
        if (shouldBreak) break
        as1 = np
      }
    }
    bPtr = bNext
  }
  return hasCommon && MAX_CHAIN_LENGTH < indexCnt ? 1 : 0
}

/** `histogram_diff` over 1-based ranges; its left recursion on an explicit stack, its tail call a loop. */
function histogramDiff(x1: HistFile, x2: HistFile): void {
  const work: [number, number, number, number][] = [[1, x1.keys.length, 1, x2.keys.length]]
  while (work.length > 0) {
    let [line1, count1, line2, count2] = work.pop() as [number, number, number, number]
    for (;;) {
      if (count1 <= 0 && count2 <= 0) break
      if (count1 === 0) {
        x2.changed.fill(1, line2 - 1, line2 - 1 + count2)
        break
      }
      if (count2 === 0) {
        x1.changed.fill(1, line1 - 1, line1 - 1 + count1)
        break
      }
      const lcs: Region = { begin1: 0, end1: 0, begin2: 0, end2: 0 }
      const found = findLcs(x1, x2, lcs, line1, count1, line2, count2)
      if (found < 0) throw new XdiffError('a hash chain past the histogram diff limit')
      if (found === 1) {
        fallBackDiff(x1, x2, line1, count1, line2, count2)
        break
      }
      if (lcs.begin1 === 0 && lcs.begin2 === 0) {
        x1.changed.fill(1, line1 - 1, line1 - 1 + count1)
        x2.changed.fill(1, line2 - 1, line2 - 1 + count2)
        break
      }
      work.push([line1, lcs.begin1 - line1, line2, lcs.begin2 - line2])
      const e1 = line1 + count1 - 1
      const e2 = line2 + count2 - 1
      count1 = e1 - lcs.end1
      line1 = lcs.end1 + 1
      count2 = e2 - lcs.end2
      line2 = lcs.end2 + 1
    }
  }
}

/** `xdl_build_script`: the changes in file order, from both files' marks. */
function buildScript(c1: Uint8Array, c2: Uint8Array): XdChange[] {
  const at = (c: Uint8Array, i: number): boolean => i >= 0 && i < c.length && c[i] === 1
  const out: XdChange[] = []
  for (let i1 = c1.length, i2 = c2.length; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (at(c1, i1 - 1) || at(c2, i2 - 1)) {
      const l1 = i1
      const l2 = i2
      for (; at(c1, i1 - 1); i1--);
      for (; at(c2, i2 - 1); i2--);
      out.push({ i1, i2, chg1: l1 - i1, chg2: l2 - i2 })
    }
  }
  return out.reverse()
}

/**
 * The edit script git computes from `keys1` to `keys2` (records as {@link recordKey}s), as
 * `xdl_merge` (and `xdl_diff`) work from it. Throws {@link XdiffError} where git's diff fails.
 */
export function diffChanges(keys1: readonly string[], keys2: readonly string[], algorithm: DiffAlgorithm): XdChange[] {
  let c1: Uint8Array
  let c2: Uint8Array
  if (algorithm === 'histogram') {
    // xdl_classify_record: one class per distinct record, file 1's first.
    const classes = new Map<string, number>()
    const classify = (keys: readonly string[]): Int32Array =>
      Int32Array.from(keys, (k) => {
        let c = classes.get(k)
        if (c === undefined) {
          c = classes.size
          classes.set(k, c)
        }
        return c
      })
    const x1: HistFile = { keys: keys1, ids: classify(keys1), changed: new Uint8Array(keys1.length) }
    const x2: HistFile = { keys: keys2, ids: classify(keys2), changed: new Uint8Array(keys2.length) }
    histogramDiff(x1, x2)
    c1 = x1.changed
    c2 = x2.changed
  } else {
    const marks = xdiffChanges(keys1, keys2, NO_LIMITS)
    if (marks === null) throw new XdiffError('an unbounded diff gave up')
    c1 = marks.oldChanged
    c2 = marks.newChanged
  }
  const compacted = compactChanges(keys1, keys2, c1, c2, { indentHeuristic: false, histogram: algorithm === 'histogram' })
  return buildScript(compacted.oldChanged, compacted.newChanged)
}
