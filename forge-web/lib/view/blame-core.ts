/**
 * Blame, the pure part: attribute each line of a file to the newest commit that introduced it,
 * given the file's versions newest first (`git blame --first-parent` semantics: each version's
 * lines are compared with the version before it, and a line both have is passed back).
 *
 * The line alignment is git's own: its common-tail trim and Myers diff ({@link xdiffChanges}, a
 * port of xdiff's, which pairs the same copies of a repeated line that git does), then its change
 * compaction ({@link compactChanges}, which places ambiguous hunks where git does). Records are
 * lines with their terminators, as xdiff compares them, so a line that only gained its final
 * newline is a change, as in git.
 */

import { DEFAULT_DIFF_LIMITS, splitLines, type DiffLimits } from './text-diff'
import { commonTailRecords, xdiffChanges } from './xdiff'
import { compactChanges } from './xdiff-compact'

/** For each line of `after` (0-based), the line of `before` it is unchanged from, or -1 (added there). */
export type LineMap = Int32Array

/**
 * {@link LineMap} of `after` against `before`, aligned as `git blame` aligns them, or null when
 * the change is too large for the diff's work bound (`limits.maxWork`).
 */
export function lineMap(before: string, after: string, limits: DiffLimits = DEFAULT_DIFF_LIMITS): LineMap | null {
  const oldAll = splitLines(before)
  const newAll = splitLines(after)
  // git drops the files' common tail (in whole 1 KiB blocks) before it diffs: those lines are
  // unchanged, and xdiff neither counts them nor slides a change into them.
  const tail = commonTailRecords(oldAll, newAll)
  const oldRecs = oldAll.slice(0, oldAll.length - tail)
  const newRecs = newAll.slice(0, newAll.length - tail)
  const diff = xdiffChanges(oldRecs, newRecs, limits)
  if (diff === null) return null
  // A compaction that fails (a bug: the port asserts what xdiff asserts) must not fail the blame:
  // the uncompacted alignment is still a valid one.
  let compacted = diff
  try {
    compacted = compactChanges(oldRecs, newRecs, diff.oldChanged, diff.newChanged)
  } catch {
    /* keep the uncompacted alignment */
  }
  const map = new Int32Array(newAll.length).fill(-1)
  let i = 0
  let j = 0
  while (j < newRecs.length) {
    if (i < oldRecs.length && compacted.oldChanged[i] === 1) i++
    else if (compacted.newChanged[j] === 1) j++
    else map[j++] = i++
  }
  for (let k = 0; k < tail; k++) map[newRecs.length + k] = oldRecs.length + k
  return map
}

/**
 * The attribution of a file's lines as a walk goes back through its versions. Start from the
 * newest text; {@link step} each older version in turn. `owner[i]` is the commit line `i` is
 * blamed on (null: not yet), `pending` the lines still unblamed.
 */
export class BlameState {
  readonly lines: readonly string[]
  readonly owner: (string | null)[]
  /** For each unblamed final line, its index in the version being examined. */
  private readonly at: Int32Array
  private open: number

  constructor(text: string) {
    this.lines = splitLines(text)
    this.owner = new Array<string | null>(this.lines.length).fill(null)
    this.at = Int32Array.from(this.lines, (_, i) => i)
    this.open = this.lines.length
  }

  /** Lines not attributed yet. */
  get pending(): number {
    return this.open
  }

  /**
   * `commit` changed the file from `parentText` to the version being examined (null: `commit`
   * added it, or it is where the walk stops). Lines the map says are new are blamed on `commit`;
   * the rest move to their line in `parentText`, the next version examined. A null map (a change
   * too large to align) blames every open line on `commit`, and says so (`approximate`).
   */
  step(commit: string, map: LineMap | null | 'added'): { readonly approximate: boolean } {
    let approximate = false
    for (let i = 0; i < this.owner.length; i++) {
      if (this.owner[i] !== null) continue
      const from = map === 'added' || map === null ? -1 : (map[this.at[i] as number] ?? -1)
      if (from === -1) {
        this.owner[i] = commit
        this.open -= 1
        if (map === null) approximate = true
      } else {
        this.at[i] = from
      }
    }
    return { approximate }
  }

  /** Blame every open line on `commit` (the oldest version the walk reached). */
  finish(commit: string): void {
    this.step(commit, 'added')
  }
}
