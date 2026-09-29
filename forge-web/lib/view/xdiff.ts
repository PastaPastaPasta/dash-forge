/**
 * git's own line diff (xdiff's default Myers, `xdl_do_diff` in git/xdiff/xdiffi.c with the record
 * preparation of xprepare.c), so blame pairs the same copies of a repeated line that git does.
 *
 * A minimal edit script is not unique: where a file repeats lines, several scripts of the same
 * length pair different copies, and git blame attributes lines by the one xdiff finds. xdiff does
 * not search for a minimal script over the raw lines. It first drops the records that cannot
 * match (no copy in the other file) and, among those that match too often, the ones that sit in
 * runs of unmatched lines (`xdl_cleanup_records`), then runs a divide-and-conquer middle-snake
 * search over the rest (`xdl_recs_cmp` / `xdl_split`) that gives up on a minimal answer past a
 * cost bound. Each of these steps changes which copies pair, so each is ported as it is; git's
 * change compaction (`xdiff-compact.ts`) then runs over these marks, as `xdl_diff` does.
 *
 * `git blame` (like any diff without context lines) also trims the files' common tail before
 * diffing (`trim_common_tail` in xdiff-interface.c): that changes the records xdiff counts and how
 * far compaction may slide, so {@link commonTailRecords} reproduces it.
 *
 * Records are lines with their terminators, compared exactly (no whitespace options), as blame
 * and a plain `git diff` compare them.
 */

import type { DiffLimits } from './text-diff'

// xdiffi.c
const XDL_MAX_COST_MIN = 256
const XDL_HEUR_MIN_COST = 256
const XDL_SNAKE_CNT = 20
const XDL_K_HEUR = 4
/** XDL_LINE_MAX, the backward search's sentinel (any value above every record index does). */
const LINE_MAX = 0x7fffffff

// xprepare.c
const XDL_KPDIS_RUN = 4
const XDL_MAX_EQLIMIT = 1024
const XDL_SIMSCAN_WINDOW = 100
const DISCARD = 0
const KEEP = 1
const INVESTIGATE = 2

/** xdl_bogosqrt (xutils.c): a power of two near √n, the bound xdiff sizes its limits by. */
function bogosqrt(n: number): number {
  let i = 1
  for (; n > 0; n = Math.floor(n / 4)) i *= 2
  return i
}

/** Thrown when the search exceeds {@link DiffLimits.maxWork}; caught by {@link xdiffChanges}. */
class WorkExceeded extends Error {}

/**
 * xdl_clean_mmatch: whether a record that matches too many records of the other file (INVESTIGATE)
 * should be dropped, because it sits in a run where unmatched records outnumber it enough.
 */
function cleanMmatch(action: Uint8Array, i: number, s: number, e: number): boolean {
  // The scan is limited to a window around i, as xdiff limits it (its cost on big files).
  if (i - s > XDL_SIMSCAN_WINDOW) s = i - XDL_SIMSCAN_WINDOW
  if (e - i > XDL_SIMSCAN_WINDOW) e = i + XDL_SIMSCAN_WINDOW
  let rdis0 = 0
  let rpdis0 = 1
  for (let r = 1; i - r >= s; r++) {
    const a = action[i - r]
    if (a === DISCARD) rdis0++
    else if (a === INVESTIGATE) rpdis0++
    else break
  }
  // Only a multimatch record between unmatched ones is dropped: none before it, keep it.
  if (rdis0 === 0) return false
  let rdis1 = 0
  let rpdis1 = 1
  for (let r = 1; i + r <= e; r++) {
    const a = action[i + r]
    if (a === DISCARD) rdis1++
    else if (a === INVESTIGATE) rpdis1++
    else break
  }
  if (rdis1 === 0) return false
  rdis1 += rdis0
  rpdis1 += rpdis0
  return rpdis1 * XDL_KPDIS_RUN < rpdis1 + rdis1
}

/**
 * One file after xdl_prepare_ctx and xdl_optimize_ctxs: each record's class (`ha`: equal records
 * share one), its changed mark, and the records the search runs over (`rindex`, the ones neither
 * trimmed as a common prefix or suffix nor discarded by cleanup).
 */
interface Prepared {
  readonly ha: Int32Array
  readonly changed: Uint8Array
  /** The classes of the searched records, in order (`recs[rindex[i]].ha`, xdiffi.c get_hash). */
  readonly hash: Int32Array
  readonly rindex: Int32Array
}

/**
 * xdl_cleanup_records for one file: KEEP a record with a few matches in the other file, DISCARD
 * (mark changed) one with none, and INVESTIGATE one with many (at least ~√n of them), which is
 * dropped too when it sits in a run of unmatched records ({@link cleanMmatch}).
 */
function cleanup(ha: Int32Array, dstart: number, dend: number, otherCount: readonly number[]): Prepared {
  const n = ha.length
  const changed = new Uint8Array(n)
  const action = new Uint8Array(n + 1)
  const mlim = Math.min(bogosqrt(n), XDL_MAX_EQLIMIT)
  for (let i = dstart; i <= dend; i++) {
    const nm = otherCount[ha[i] as number] ?? 0
    action[i] = nm === 0 ? DISCARD : nm >= mlim ? INVESTIGATE : KEEP
  }
  const rindex: number[] = []
  for (let i = dstart; i <= dend; i++) {
    if (action[i] === KEEP || (action[i] === INVESTIGATE && !cleanMmatch(action, i, dstart, dend))) rindex.push(i)
    else changed[i] = 1
  }
  const r = Int32Array.from(rindex)
  return { ha, changed, rindex: r, hash: r.map((i) => ha[i] as number) }
}

/** A box of the search: records `[off1, lim1)` of file 1 against `[off2, lim2)` of file 2. */
interface Box {
  off1: number
  lim1: number
  off2: number
  lim2: number
  needMin: boolean
}

/** xdl_split's answer: where to divide the box, and whether each half must be solved minimally. */
interface Split {
  i1: number
  i2: number
  minLo: boolean
  minHi: boolean
}

/** The state of one xdl_do_diff: both files, the K vectors, and the work spent. */
class Search {
  /** kvdf/kvdb share one buffer in xdiff; each is indexed by diagonal plus `base`. */
  private readonly kvdf: Int32Array
  private readonly kvdb: Int32Array
  private readonly base: number
  private readonly mxcost: number
  private work = 0

  constructor(
    private readonly h1: Int32Array,
    private readonly h2: Int32Array,
    private readonly maxWork: number,
  ) {
    const ndiags = h1.length + h2.length + 3
    this.kvdf = new Int32Array(ndiags)
    this.kvdb = new Int32Array(ndiags)
    this.base = h2.length + 1
    this.mxcost = Math.max(bogosqrt(ndiags), XDL_MAX_COST_MIN)
  }

  private spend(n: number): void {
    this.work += n
    if (this.work > this.maxWork) throw new WorkExceeded()
  }

  /**
   * xdl_split: search forward from (off1, off2) and backward from (lim1, lim2) on alternate
   * rounds until the two meet on a diagonal (the middle snake). Unless the box must be solved
   * minimally, give up early: past XDL_HEUR_MIN_COST, on a diagonal that has made good progress
   * and ends in a snake of XDL_SNAKE_CNT records; past the cost bound, on the furthest point.
   */
  private split(off1: number, lim1: number, off2: number, lim2: number, needMin: boolean): Split {
    const { h1, h2, kvdf, kvdb, base } = this
    const dmin = off1 - lim2
    const dmax = lim1 - off2
    const fmid = off1 - off2
    const bmid = lim1 - lim2
    const odd = ((fmid - bmid) & 1) !== 0
    let fmin = fmid
    let fmax = fmid
    let bmin = bmid
    let bmax = bmid
    kvdf[base + fmid] = off1
    kvdb[base + bmid] = lim1

    for (let ec = 1; ; ec++) {
      let gotSnake = false
      // Widen the forward diagonals by one each side, or narrow where the box ends; the -1 just
      // outside lets the probes below skip bounds checks.
      if (fmin > dmin) kvdf[base + --fmin - 1] = -1
      else ++fmin
      if (fmax < dmax) kvdf[base + ++fmax + 1] = -1
      else --fmax
      this.spend(fmax - fmin + 1)

      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = (kvdf[base + d - 1] as number) >= (kvdf[base + d + 1] as number) ? (kvdf[base + d - 1] as number) + 1 : (kvdf[base + d + 1] as number)
        const prev1 = i1
        let i2 = i1 - d
        while (i1 < lim1 && i2 < lim2 && h1[i1] === h2[i2]) {
          i1++
          i2++
        }
        this.spend(i1 - prev1)
        if (i1 - prev1 > XDL_SNAKE_CNT) gotSnake = true
        kvdf[base + d] = i1
        if (odd && bmin <= d && d <= bmax && (kvdb[base + d] as number) <= i1) {
          return { i1, i2, minLo: true, minHi: true }
        }
      }

      if (bmin > dmin) kvdb[base + --bmin - 1] = LINE_MAX
      else ++bmin
      if (bmax < dmax) kvdb[base + ++bmax + 1] = LINE_MAX
      else --bmax
      this.spend(bmax - bmin + 1)

      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = (kvdb[base + d - 1] as number) < (kvdb[base + d + 1] as number) ? (kvdb[base + d - 1] as number) : (kvdb[base + d + 1] as number) - 1
        const prev1 = i1
        let i2 = i1 - d
        while (i1 > off1 && i2 > off2 && h1[i1 - 1] === h2[i2 - 1]) {
          i1--
          i2--
        }
        this.spend(prev1 - i1)
        if (prev1 - i1 > XDL_SNAKE_CNT) gotSnake = true
        kvdb[base + d] = i1
        if (!odd && fmin <= d && d <= fmax && i1 <= (kvdf[base + d] as number)) {
          return { i1, i2, minLo: true, minHi: true }
        }
      }

      if (needMin) continue

      // Past the heuristic's trigger, with a good snake this round: take a diagonal whose progress
      // (its distance from the box's corner less its distance from the mid diagonal) beats
      // XDL_K_HEUR times the cost, if it ends in a snake of XDL_SNAKE_CNT matching records.
      if (gotSnake && ec > XDL_HEUR_MIN_COST) {
        // Both scans below walk every diagonal of this round, with a snake probe each.
        this.spend((fmax - fmin + 1) * XDL_SNAKE_CNT + (bmax - bmin + 1) * XDL_SNAKE_CNT)
        let best = 0
        let at: Split | null = null
        for (let d = fmax; d >= fmin; d -= 2) {
          const dd = d > fmid ? d - fmid : fmid - d
          const i1 = kvdf[base + d] as number
          const i2 = i1 - d
          const v = i1 - off1 + (i2 - off2) - dd
          if (v > XDL_K_HEUR * ec && v > best && off1 + XDL_SNAKE_CNT <= i1 && i1 < lim1 && off2 + XDL_SNAKE_CNT <= i2 && i2 < lim2) {
            for (let k = 1; h1[i1 - k] === h2[i2 - k]; k++) {
              if (k === XDL_SNAKE_CNT) {
                best = v
                at = { i1, i2, minLo: true, minHi: false }
                break
              }
            }
          }
        }
        if (at !== null) return at

        best = 0
        for (let d = bmax; d >= bmin; d -= 2) {
          const dd = d > bmid ? d - bmid : bmid - d
          const i1 = kvdb[base + d] as number
          const i2 = i1 - d
          const v = lim1 - i1 + (lim2 - i2) - dd
          if (v > XDL_K_HEUR * ec && v > best && off1 < i1 && i1 <= lim1 - XDL_SNAKE_CNT && off2 < i2 && i2 <= lim2 - XDL_SNAKE_CNT) {
            for (let k = 0; h1[i1 + k] === h2[i2 + k]; k++) {
              if (k === XDL_SNAKE_CNT - 1) {
                best = v
                at = { i1, i2, minLo: false, minHi: true }
                break
              }
            }
          }
        }
        if (at !== null) return at
      }

      // Enough: split at the furthest-reaching point, by i1 + i2, of either search.
      if (ec >= this.mxcost) {
        this.spend(fmax - fmin + 1 + (bmax - bmin + 1))
        let fbest = -1
        let fbest1 = -1
        for (let d = fmax; d >= fmin; d -= 2) {
          let i1 = Math.min(kvdf[base + d] as number, lim1)
          let i2 = i1 - d
          if (lim2 < i2) {
            i1 = lim2 + d
            i2 = lim2
          }
          if (fbest < i1 + i2) {
            fbest = i1 + i2
            fbest1 = i1
          }
        }
        let bbest = LINE_MAX
        let bbest1 = LINE_MAX
        for (let d = bmax; d >= bmin; d -= 2) {
          let i1 = Math.max(off1, kvdb[base + d] as number)
          let i2 = i1 - d
          if (i2 < off2) {
            i1 = off2 + d
            i2 = off2
          }
          if (i1 + i2 < bbest) {
            bbest = i1 + i2
            bbest1 = i1
          }
        }
        if (lim1 + lim2 - bbest < fbest - (off1 + off2)) return { i1: fbest1, i2: fbest - fbest1, minLo: true, minHi: false }
        return { i1: bbest1, i2: bbest - bbest1, minLo: false, minHi: true }
      }
    }
  }

  /**
   * xdl_recs_cmp: shrink each box by its common ends, mark a box with one side empty as changed,
   * and split the rest. xdiff recurses; this keeps its own stack (the boxes are independent, so
   * the order they are solved in does not change the marks), so a long edit cannot overflow the
   * call stack.
   */
  compare(f1: Prepared, f2: Prepared): void {
    const { h1, h2 } = this
    const stack: Box[] = [{ off1: 0, lim1: h1.length, off2: 0, lim2: h2.length, needMin: false }]
    for (let box = stack.pop(); box !== undefined; box = stack.pop()) {
      let { off1, lim1, off2, lim2 } = box
      const from = off1
      while (off1 < lim1 && off2 < lim2 && h1[off1] === h2[off2]) {
        off1++
        off2++
      }
      while (off1 < lim1 && off2 < lim2 && h1[lim1 - 1] === h2[lim2 - 1]) {
        lim1--
        lim2--
      }
      this.spend(off1 - from + 1)
      if (off1 === lim1) {
        for (; off2 < lim2; off2++) f2.changed[f2.rindex[off2] as number] = 1
      } else if (off2 === lim2) {
        for (; off1 < lim1; off1++) f1.changed[f1.rindex[off1] as number] = 1
      } else {
        const spl = this.split(off1, lim1, off2, lim2, box.needMin)
        stack.push({ off1: spl.i1, lim1, off2: spl.i2, lim2, needMin: spl.minHi })
        stack.push({ off1, lim1: spl.i1, off2, lim2: spl.i2, needMin: spl.minLo })
      }
    }
  }
}

/**
 * xdl_do_diff with git's default options (Myers, not minimal): for each record of `oldRecs` and
 * `newRecs`, whether it is changed (deleted from the old file, added to the new one), before
 * compaction — the marks `compactChanges` takes. Null when the search exceeds `limits.maxWork`
 * (its memory is linear in the files, so `maxEdits` does not apply).
 */
export function xdiffChanges(
  oldRecs: readonly string[],
  newRecs: readonly string[],
  limits: DiffLimits,
): { readonly oldChanged: Uint8Array; readonly newChanged: Uint8Array } | null {
  // xdl_classify_record: one class per distinct record, counted in each file.
  const classes = new Map<string, number>()
  const count1: number[] = []
  const count2: number[] = []
  const classify = (recs: readonly string[], own: number[], other: number[]): Int32Array =>
    Int32Array.from(recs, (r) => {
      let c = classes.get(r)
      if (c === undefined) {
        c = classes.size
        classes.set(r, c)
        own.push(0)
        other.push(0)
      }
      own[c] = (own[c] as number) + 1
      return c
    })
  const ha1 = classify(oldRecs, count1, count2)
  const ha2 = classify(newRecs, count2, count1)

  // xdl_trim_ends: the common prefix and suffix are never searched (and never changed).
  const lim = Math.min(ha1.length, ha2.length)
  let start = 0
  while (start < lim && ha1[start] === ha2[start]) start++
  let end = 0
  while (end < lim - start && ha1[ha1.length - 1 - end] === ha2[ha2.length - 1 - end]) end++

  const f1 = cleanup(ha1, start, ha1.length - end - 1, count2)
  const f2 = cleanup(ha2, start, ha2.length - end - 1, count1)
  try {
    new Search(f1.hash, f2.hash, limits.maxWork).compare(f1, f2)
  } catch (e) {
    if (e instanceof WorkExceeded) return null
    throw e
  }
  return { oldChanged: f1.changed, newChanged: f2.changed }
}

/** The UTF-8 length of `s` (a lone surrogate counts as the 3 bytes of the U+FFFD it encodes as). */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/**
 * How many records git drops from the end of both files before a diff without context
 * (`trim_common_tail`, xdiff-interface.c): it compares the files' tails in 1024-byte blocks, and
 * drops the matching blocks except up to the first newline in them, so what it drops is whole
 * lines. Byte lengths are the UTF-8 of the decoded text, which are the blob's bytes unless the
 * blob was not valid UTF-8.
 */
export function commonTailRecords(oldRecs: readonly string[], newRecs: readonly string[]): number {
  const BLK = 1024
  const min = Math.min(oldRecs.length, newRecs.length)
  let common = 0
  let commonBytes = 0
  const lengths: number[] = []
  while (common < min && oldRecs[oldRecs.length - 1 - common] === newRecs[newRecs.length - 1 - common]) {
    const len = utf8Length(oldRecs[oldRecs.length - 1 - common] as string)
    lengths.push(len)
    commonBytes += len
    common++
  }
  // The byte suffix the files share also runs into the first lines that differ.
  let shared = commonBytes
  if (common < min) {
    const enc = new TextEncoder()
    const a = enc.encode(oldRecs[oldRecs.length - 1 - common])
    const b = enc.encode(newRecs[newRecs.length - 1 - common])
    let k = 0
    while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++
    shared += k
  }
  const trimmed = Math.floor(shared / BLK) * BLK
  // Dropped: the trimmed bytes after their first newline, i.e. up to the last line boundary a
  // newline inside them precedes.
  let dropped = 0
  let bytes = 0
  while (dropped < common && bytes + (lengths[dropped] as number) <= trimmed - 1) bytes += lengths[dropped++] as number
  return dropped
}
