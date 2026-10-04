/**
 * git's change compaction (xdiff `xdl_change_compact`, git/xdiff/xdiffi.c), so a line alignment
 * places ambiguous hunks where git does: where a run of added or deleted lines could sit at
 * several positions (the file repeats lines around it), git slides it as far down as it goes,
 * then back up to line up with a change on the other side, or else to the position the indent
 * heuristic scores best (`diff.indentHeuristic`, on by default, which `git blame` uses too).
 * Blame attributions follow the alignment, so this is what makes ours agree with git's.
 *
 * `changed[i]` marks record `i` of a file as changed (deleted from the old file, or added to the
 * new one). It is mutated in place, as xdiff does. Records are lines with their terminators.
 *
 * Merges compact differently ({@link CompactOptions}): `merge-ort` passes no indent heuristic, and
 * its histogram diff re-diffs a group that grew while sliding.
 */

import { xdiffChanges } from './xdiff.ts'

/** A contiguous run of changed records `[start, end)` (possibly empty). */
interface Group {
  start: number
  end: number
}

/** A file under compaction: its records and change marks, with xdiff's sentinel slots. */
class CompactFile {
  /** `rchg[i + 1]` is record `i`'s mark: slots 0 and n + 1 are the unchanged sentinels. */
  private readonly rchg: Uint8Array
  readonly recs: readonly string[]

  constructor(recs: readonly string[], changed: ArrayLike<number | boolean>) {
    this.recs = recs
    this.rchg = new Uint8Array(recs.length + 2)
    for (let i = 0; i < recs.length; i++) this.rchg[i + 1] = changed[i] ? 1 : 0
  }

  get n(): number {
    return this.recs.length
  }

  isChanged(i: number): boolean {
    return this.rchg[i + 1] === 1
  }

  private set(i: number, v: 0 | 1): void {
    this.rchg[i + 1] = v
  }

  /** group_init: the first group. */
  first(): Group {
    const g = { start: 0, end: 0 }
    while (this.isChanged(g.end)) g.end++
    return g
  }

  /** group_next: false at the end of the file. */
  next(g: Group): boolean {
    if (g.end === this.n) return false
    g.start = g.end + 1
    for (g.end = g.start; this.isChanged(g.end); g.end++);
    return true
  }

  /** group_previous: false at the start of the file. */
  previous(g: Group): boolean {
    if (g.start === 0) return false
    g.end = g.start - 1
    for (g.start = g.end; this.isChanged(g.start - 1); g.start--);
    return true
  }

  /** group_slide_down: move the group one record down if the records allow it (merging with a following group). */
  slideDown(g: Group): boolean {
    if (g.end < this.n && this.recs[g.start] === this.recs[g.end]) {
      this.set(g.start++, 0)
      this.set(g.end++, 1)
      while (this.isChanged(g.end)) g.end++
      return true
    }
    return false
  }

  /** group_slide_up. */
  slideUp(g: Group): boolean {
    if (g.start > 0 && this.recs[g.start - 1] === this.recs[g.end - 1]) {
      this.set(--g.start, 1)
      this.set(--g.end, 0)
      while (this.isChanged(g.start - 1)) g.start--
      return true
    }
    return false
  }

  /** Overwrite the marks of records `[start, start + marks.length)` (xdl_fall_back_diff's copy). */
  setRange(start: number, marks: Uint8Array): void {
    for (let i = 0; i < marks.length; i++) this.set(start + i, marks[i] ? 1 : 0)
  }

  /** The final marks. */
  marks(): Uint8Array {
    return this.rchg.slice(1, this.n + 1)
  }
}

// The indent heuristic's weights (git/xdiff/xdiffi.c).
const MAX_INDENT = 200
const MAX_BLANKS = 20
const START_OF_FILE_PENALTY = 1
const END_OF_FILE_PENALTY = 21
const TOTAL_BLANK_WEIGHT = -30
const POST_BLANK_WEIGHT = 6
const RELATIVE_INDENT_PENALTY = -4
const RELATIVE_INDENT_WITH_BLANK_PENALTY = 10
const RELATIVE_OUTDENT_PENALTY = 24
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY = 17
const RELATIVE_DEDENT_PENALTY = 23
const RELATIVE_DEDENT_WITH_BLANK_PENALTY = 17
const INDENT_WEIGHT = 60
const INDENT_HEURISTIC_MAX_SLIDING = 100

/** A line's indent (tabs to multiples of 8), or -1 for a line of whitespace only. */
export function getIndent(rec: string): number {
  let ret = 0
  for (let i = 0; i < rec.length; i++) {
    const c = rec.charCodeAt(i)
    // git's isspace (git-compat-util.h sane_ctype): space, \t, \n and \r only, not \v or \f.
    if (!(c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d)) return ret
    if (c === 0x20) ret += 1
    else if (c === 0x09) ret += 8 - (ret % 8)
    if (ret >= MAX_INDENT) return MAX_INDENT
  }
  return -1
}

interface SplitMeasurement {
  endOfFile: boolean
  indent: number
  preBlank: number
  preIndent: number
  postBlank: number
  postIndent: number
}

function measureSplit(f: CompactFile, split: number): SplitMeasurement {
  const m: SplitMeasurement = { endOfFile: split >= f.n, indent: split >= f.n ? -1 : getIndent(f.recs[split] as string), preBlank: 0, preIndent: -1, postBlank: 0, postIndent: -1 }
  for (let i = split - 1; i >= 0; i--) {
    m.preIndent = getIndent(f.recs[i] as string)
    if (m.preIndent !== -1) break
    m.preBlank += 1
    if (m.preBlank === MAX_BLANKS) {
      m.preIndent = 0
      break
    }
  }
  for (let i = split + 1; i < f.n; i++) {
    m.postIndent = getIndent(f.recs[i] as string)
    if (m.postIndent !== -1) break
    m.postBlank += 1
    if (m.postBlank === MAX_BLANKS) {
      m.postIndent = 0
      break
    }
  }
  return m
}

interface SplitScore {
  effectiveIndent: number
  penalty: number
}

function scoreAddSplit(m: SplitMeasurement, s: SplitScore): void {
  if (m.preIndent === -1 && m.preBlank === 0) s.penalty += START_OF_FILE_PENALTY
  if (m.endOfFile) s.penalty += END_OF_FILE_PENALTY
  const postBlank = m.indent === -1 ? 1 + m.postBlank : 0
  const totalBlank = m.preBlank + postBlank
  s.penalty += TOTAL_BLANK_WEIGHT * totalBlank
  s.penalty += POST_BLANK_WEIGHT * postBlank
  const indent = m.indent !== -1 ? m.indent : m.postIndent
  const anyBlanks = totalBlank !== 0
  s.effectiveIndent += indent
  if (indent === -1 || m.preIndent === -1 || indent === m.preIndent) return
  if (indent > m.preIndent) {
    s.penalty += anyBlanks ? RELATIVE_INDENT_WITH_BLANK_PENALTY : RELATIVE_INDENT_PENALTY
  } else if (m.postIndent !== -1 && m.postIndent > indent) {
    s.penalty += anyBlanks ? RELATIVE_OUTDENT_WITH_BLANK_PENALTY : RELATIVE_OUTDENT_PENALTY
  } else {
    s.penalty += anyBlanks ? RELATIVE_DEDENT_WITH_BLANK_PENALTY : RELATIVE_DEDENT_PENALTY
  }
}

function scoreCmp(a: SplitScore, b: SplitScore): number {
  const cmpIndents = Number(a.effectiveIndent > b.effectiveIndent) - Number(a.effectiveIndent < b.effectiveIndent)
  return INDENT_WEIGHT * cmpIndents + (a.penalty - b.penalty)
}

/** How `xdl_change_compact` runs: its flags. */
export interface CompactOptions {
  /** `XDF_INDENT_HEURISTIC` (`diff.indentHeuristic`, on for `git diff` and blame; merges pass none). Default true. */
  readonly indentHeuristic?: boolean
  /**
   * `XDF_HISTOGRAM_DIFF`: a group that moved while sliding, facing a non-empty group of the other
   * file, is re-diffed with Myers (`xdl_fall_back_diff`) and its marks replaced. Default false.
   */
  readonly histogram?: boolean
}

/** No bound on the Myers re-diff of one group (xdiff has none; its own cost heuristics bound it). */
const NO_LIMITS = { maxEdits: Infinity, maxWork: Infinity }

/** xdl_change_compact(xdf, xdfo, flags). */
function changeCompact(f: CompactFile, o: CompactFile, opts: CompactOptions): void {
  const g = f.first()
  const go = o.first()
  for (;;) {
    if (g.end !== g.start) {
      const orig = { start: g.start, end: g.end }
      let groupsize: number
      let earliestEnd: number
      let endMatchingOther: number
      do {
        groupsize = g.end - g.start
        endMatchingOther = -1
        while (f.slideUp(g)) {
          if (!o.previous(go)) throw new Error('xdiff compaction: group sync broken sliding up')
        }
        earliestEnd = g.end
        if (go.end > go.start) endMatchingOther = g.end
        for (;;) {
          if (!f.slideDown(g)) break
          if (!o.next(go)) throw new Error('xdiff compaction: group sync broken sliding down')
          if (go.end > go.start) endMatchingOther = g.end
        }
      } while (groupsize !== g.end - g.start)

      if (g.end === earliestEnd) {
        // No shifting was possible.
      } else if (endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!f.slideUp(g)) throw new Error('xdiff compaction: match disappeared')
          if (!o.previous(go)) throw new Error('xdiff compaction: group sync broken sliding to match')
        }
      } else if (opts.indentHeuristic !== false) {
        let shift = earliestEnd
        if (g.end - groupsize - 1 > shift) shift = g.end - groupsize - 1
        if (g.end - INDENT_HEURISTIC_MAX_SLIDING > shift) shift = g.end - INDENT_HEURISTIC_MAX_SLIDING
        let bestShift = -1
        let best: SplitScore = { effectiveIndent: 0, penalty: 0 }
        for (; shift <= g.end; shift++) {
          const score: SplitScore = { effectiveIndent: 0, penalty: 0 }
          scoreAddSplit(measureSplit(f, shift), score)
          scoreAddSplit(measureSplit(f, shift - groupsize), score)
          if (bestShift === -1 || scoreCmp(score, best) <= 0) {
            best = score
            bestShift = shift
          }
        }
        while (g.end > bestShift) {
          if (!f.slideUp(g)) throw new Error('xdiff compaction: best shift unreached')
          if (!o.previous(go)) throw new Error('xdiff compaction: group sync broken sliding to blank line')
        }
      }
      // A group merged with others while sliding may now hold lines both files share.
      if (opts.histogram === true && go.end !== go.start && (g.start !== orig.start || g.end !== orig.end)) {
        const sub = xdiffChanges(f.recs.slice(g.start, g.end), o.recs.slice(go.start, go.end), NO_LIMITS)
        if (sub === null) throw new Error('xdiff compaction: an unbounded re-diff gave up')
        f.setRange(g.start, sub.oldChanged)
        o.setRange(go.start, sub.newChanged)
      }
    }
    if (!f.next(g)) break
    if (!o.next(go)) throw new Error('xdiff compaction: group sync broken moving to next group')
  }
}

/**
 * Compact an alignment of `oldRecs` and `newRecs` given as change marks, as `xdl_diff` does
 * (the old file first, then the new one). Returns the new marks.
 */
export function compactChanges(
  oldRecs: readonly string[],
  newRecs: readonly string[],
  oldChanged: ArrayLike<number | boolean>,
  newChanged: ArrayLike<number | boolean>,
  opts: CompactOptions = {},
): { readonly oldChanged: Uint8Array; readonly newChanged: Uint8Array } {
  const a = new CompactFile(oldRecs, oldChanged)
  const b = new CompactFile(newRecs, newChanged)
  changeCompact(a, b, opts)
  changeCompact(b, a, opts)
  return { oldChanged: a.marks(), newChanged: b.marks() }
}
