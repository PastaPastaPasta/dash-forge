/**
 * Blame, the pure part: attribute each line of a file to the newest commit that introduced it,
 * given the file's versions newest first (`git blame --first-parent` semantics: each version's
 * lines are compared with the version before it, and a line both have is passed back).
 *
 * The line alignment is `diffTextLines` (Myers over lines, terminators included, as git's xdiff
 * compares records), so a line that only gained its final newline is a change, as in git; then
 * git's change compaction ({@link compactChanges}) places ambiguous hunks where git does.
 */

import { diffTextLines, DEFAULT_DIFF_LIMITS, splitLines, type DiffLimits } from './text-diff'
import { compactChanges } from './xdiff-compact'

/** For each line of `after` (0-based), the line of `before` it is unchanged from, or -1 (added there). */
export type LineMap = Int32Array

/**
 * {@link LineMap} of `after` against `before`, or null when the change is too large for the
 * diff's bounds. The alignment is compacted as git's is ({@link compactChanges}), so where a
 * repeated line could come from either of two commits it is given the one git gives it.
 */
export function lineMap(before: string, after: string, limits: DiffLimits = DEFAULT_DIFF_LIMITS): LineMap | null {
  const diff = diffTextLines(before, after, limits)
  if (diff === null) return null
  const oldRecs = splitLines(before)
  const newRecs = splitLines(after)
  const oldChanged = new Uint8Array(oldRecs.length)
  const newChanged = new Uint8Array(newRecs.length)
  for (const l of diff) {
    if (l.kind === 'deleted' && l.oldLine !== null) oldChanged[l.oldLine - 1] = 1
    if (l.kind === 'added' && l.newLine !== null) newChanged[l.newLine - 1] = 1
  }
  // A compaction that fails (a bug: the port asserts what xdiff asserts) must not fail the blame:
  // the uncompacted alignment is still a valid one.
  let compacted: { readonly oldChanged: Uint8Array; readonly newChanged: Uint8Array } = { oldChanged, newChanged }
  try {
    compacted = compactChanges(oldRecs, newRecs, oldChanged, newChanged)
  } catch {
    /* keep the Myers alignment */
  }
  const map = new Int32Array(newRecs.length).fill(-1)
  for (let i = 0, j = 0; j < newRecs.length; ) {
    if (i < oldRecs.length && compacted.oldChanged[i] === 1) i++
    else if (compacted.newChanged[j] === 1) j++
    else map[j++] = i++
  }
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
