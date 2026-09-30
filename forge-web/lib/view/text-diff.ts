/**
 * Line diff for reviewable text blobs, as git computes it: git's own xdiff (`xdiff.ts`, Myers with
 * xdiff's record cleanup and cost heuristics, then `xdiff-compact.ts`'s hunk compaction), so a
 * patch shows the hunks `git diff` shows and counts the lines `git diff --numstat` counts (L-25;
 * a minimal edit script is not always git's). Work is bounded; past the bound, or past
 * `maxEdits` changed lines, the diff is declined (`null`) and the caller says so instead of
 * freezing the tab.
 *
 * Loaded by plain Node (type stripping) in `render-fuzz.test.ts`: keep imports relative and
 * the syntax erasable (no enums, namespaces or `@/` aliases).
 */

import { xdiffChanges } from './xdiff.ts'
import { compactChanges } from './xdiff-compact.ts'

export interface TextDiffLine {
  readonly kind: 'context' | 'added' | 'deleted'
  readonly oldLine: number | null
  readonly newLine: number | null
  /** The line's text without its terminator. */
  readonly text: string
  /** Set on a final line that has no trailing newline (git's "\ No newline at end of file"). */
  readonly noNewline?: true
}

/** An elided run of unchanged lines. */
export interface DiffGap {
  readonly kind: 'gap'
  readonly hidden: number
  /** The index of its first line in the full diff (what "show more" reveals from). */
  readonly from: number
}

export type CompactDiffLine = TextDiffLine | DiffGap

/** Bounds for {@link diffTextLines}. */
export interface DiffLimits {
  /**
   * Max changed lines (added + deleted) a diff shows. A change that only adds or only deletes
   * lines skips the search and is not subject to this bound.
   */
  readonly maxEdits: number
  /** Max inner-loop steps (snake extensions + diagonal probes) before giving up. */
  readonly maxWork: number
}

export const DEFAULT_DIFF_LIMITS: DiffLimits = { maxEdits: 2000, maxWork: 20_000_000 }

/** Split into lines keeping each terminator, so "no newline at EOF" compares as a difference. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function toLine(
  kind: TextDiffLine['kind'],
  raw: string,
  oldLine: number | null,
  newLine: number | null,
): TextDiffLine {
  const terminated = raw.endsWith('\n')
  const text = raw.replace(/\r?\n$/, '')
  return terminated ? { kind, oldLine, newLine, text } : { kind, oldLine, newLine, text, noNewline: true }
}

type Op = 0 | 1 | 2 // equal | delete | insert

/**
 * git's edit script for `a` → `b` ({@link xdiffChanges}, then {@link compactChanges}): each hunk's
 * deletions before its additions, as git prints them. Null when the search runs past
 * `limits.maxWork`; `{ added, deleted }` alone when the script has more than `limits.maxEdits`
 * edits (too many to show, still counted: QW-027).
 */
function gitOps(a: readonly string[], b: readonly string[], limits: DiffLimits): Op[] | { readonly added: number; readonly deleted: number } | null {
  if (a.length === 0 || b.length === 0) return new Array<Op>(a.length + b.length).fill(a.length === 0 ? 2 : 1)
  const marks = xdiffChanges(a, b, limits)
  if (marks === null) return null
  let c: { readonly oldChanged: Uint8Array; readonly newChanged: Uint8Array }
  try {
    c = compactChanges(a, b, marks.oldChanged, marks.newChanged)
  } catch {
    // Compaction asserts what xdiff asserts; the uncompacted alignment is still a valid diff.
    c = marks
  }
  let deleted = 0
  let added = 0
  for (let k = 0; k < a.length; k++) deleted += c.oldChanged[k] as number
  for (let k = 0; k < b.length; k++) added += c.newChanged[k] as number
  if (added + deleted > limits.maxEdits) return { added, deleted }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && c.oldChanged[i] === 1) {
      ops.push(1)
      i++
    } else if (j < b.length && c.newChanged[j] === 1) {
      ops.push(2)
      j++
    } else {
      ops.push(0)
      i++
      j++
    }
  }
  return ops
}

/**
 * Compute a line-level diff. `null` means the change is too large for an in-browser review;
 * callers should surface that honestly rather than freezing the page.
 */
export function diffTextLines(
  before: string,
  after: string,
  limits: DiffLimits = DEFAULT_DIFF_LIMITS,
  options: { readonly ignoreWhitespace?: boolean } = {},
): TextDiffLine[] | null {
  const got = diffTextLinesOrCount(before, after, limits, options)
  return Array.isArray(got) ? got : null
}

/**
 * {@link diffTextLines}, or for a change with more edits than `limits.maxEdits` (too many to
 * show) the lines it adds and deletes, from the same diff (QW-027: a change set's totals stay
 * whole). Null only when the search runs past `limits.maxWork`.
 */
export function diffTextLinesOrCount(
  before: string,
  after: string,
  limits: DiffLimits = DEFAULT_DIFF_LIMITS,
  options: { readonly ignoreWhitespace?: boolean } = {},
): TextDiffLine[] | { readonly added: number; readonly deleted: number } | null {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  // Ignoring whitespace (`git diff -w`) compares lines with all whitespace removed; the lines
  // shown keep their text (the new side's, for an unchanged line).
  const key = options.ignoreWhitespace ? (l: string): string => l.replace(/\s+/g, '') : (l: string): string => l
  const oldKeys = options.ignoreWhitespace ? oldLines.map(key) : oldLines
  const newKeys = options.ignoreWhitespace ? newLines.map(key) : newLines

  // xdiff sees the whole files: it trims their common ends itself, after counting every record
  // (which lines its cleanup drops depends on how often they occur in the whole file).
  const ops = gitOps(oldKeys, newKeys, limits)
  if (ops === null || !Array.isArray(ops)) return ops

  const lines: TextDiffLine[] = []
  let o = 0
  let w = 0
  const context = (): void => {
    lines.push(toLine('context', (options.ignoreWhitespace ? newLines[w] : oldLines[o]) as string, o + 1, w + 1))
    o += 1
    w += 1
  }
  for (const op of ops) {
    if (op === 0) {
      context()
    } else if (op === 1) {
      lines.push(toLine('deleted', oldLines[o] as string, o + 1, null))
      o += 1
    } else {
      lines.push(toLine('added', newLines[w] as string, null, w + 1))
      w += 1
    }
  }
  return lines
}

/** Count added and deleted lines. */
export function diffStat(lines: readonly TextDiffLine[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const line of lines) {
    if (line.kind === 'added') added += 1
    else if (line.kind === 'deleted') deleted += 1
  }
  return { added, deleted }
}

/** Lines of the full diff shown in addition to the context around edits: `[from, to)` ranges. */
export type Revealed = readonly (readonly [number, number])[]

/** Unchanged lines shown around each change, as git shows them (`-U3`). */
export const DIFF_CONTEXT = 3

/**
 * Keep `context` unchanged lines around edits (and the `revealed` ranges a reader expanded, L-69)
 * and replace each omitted run with one gap row saying where it starts.
 */
export function compactDiffLines(
  lines: readonly TextDiffLine[],
  context = DIFF_CONTEXT,
  revealed: Revealed = [],
): CompactDiffLine[] {
  const visible = new Uint8Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.kind === 'context') continue
    const from = Math.max(0, i - context)
    const to = Math.min(lines.length - 1, i + context)
    visible.fill(1, from, to + 1)
  }
  for (const [from, to] of revealed) visible.fill(1, Math.max(0, from), Math.min(lines.length, to))

  const out: CompactDiffLine[] = []
  let hidden = 0
  for (let i = 0; i < lines.length; i++) {
    if (visible[i] === 1) {
      if (hidden > 0) out.push({ kind: 'gap', hidden, from: i - hidden })
      hidden = 0
      out.push(lines[i] as TextDiffLine)
    } else {
      hidden += 1
    }
  }
  if (hidden > 0) out.push({ kind: 'gap', hidden, from: lines.length - hidden })
  return out
}

/** Lines a gap's "show more" reveals at a time (GitHub's step). */
export const EXPAND_STEP = 20

/**
 * The range a gap's expander reveals: `all` of it, or {@link EXPAND_STEP} lines from its top
 * (`down`, continuing the hunk above) or from its bottom (`up`, leading into the hunk below).
 */
export function expandGap(gap: DiffGap, how: 'up' | 'down' | 'all'): readonly [number, number] {
  const end = gap.from + gap.hidden
  if (how === 'all' || gap.hidden <= EXPAND_STEP) return [gap.from, end]
  return how === 'down' ? [gap.from, gap.from + EXPAND_STEP] : [end - EXPAND_STEP, end]
}

/** One row of a side-by-side diff: the old line on the left, the new one on the right. */
export type SplitRow =
  | DiffGap
  | { readonly kind: 'pair'; readonly left: TextDiffLine | null; readonly right: TextDiffLine | null }

/**
 * Pair a compact diff for side-by-side display: context lines sit on both sides, and each run
 * of deletions is laid beside the additions that follow it, row by row (the longer side runs
 * on with blanks opposite).
 */
export function splitRows(lines: readonly CompactDiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: TextDiffLine[] = []
  let adds: TextDiffLine[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({ kind: 'pair', left: dels[i] ?? null, right: adds[i] ?? null })
    }
    dels = []
    adds = []
  }
  for (const line of lines) {
    if (line.kind === 'deleted') {
      if (adds.length > 0) flush()
      dels.push(line)
    } else if (line.kind === 'added') {
      adds.push(line)
    } else {
      flush()
      rows.push(line.kind === 'gap' ? line : { kind: 'pair', left: line, right: line })
    }
  }
  flush()
  return rows
}
