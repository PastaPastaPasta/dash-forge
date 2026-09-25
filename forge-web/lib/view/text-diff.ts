/**
 * Small, dependency-free line diff for reviewable text blobs.
 *
 * Myers' O(ND) algorithm after trimming the common prefix and suffix, so cost tracks the size
 * of the edit rather than the size of the file: a one-line change to a 20 000-line file is as
 * cheap as one to a 20-line file. Work and trace memory are both bounded; past the bound the
 * diff is declined (`null`) and the caller says so instead of freezing the tab.
 */

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
}

export type CompactDiffLine = TextDiffLine | DiffGap

/** Bounds for {@link diffTextLines}. */
export interface DiffLimits {
  /**
   * Max edit distance (lines added + deleted) the diff will reconstruct. The backtracking
   * trace holds O(D²) integers — 2000 edits is ~16 MB, briefly. A change that only adds or
   * only deletes lines skips the search and is not subject to this bound.
   */
  readonly maxEdits: number
  /** Max inner-loop steps (snake extensions + diagonal probes) before giving up. */
  readonly maxWork: number
}

export const DEFAULT_DIFF_LIMITS: DiffLimits = { maxEdits: 2000, maxWork: 20_000_000 }

/** Split into lines keeping each terminator, so "no newline at EOF" compares as a difference. */
function splitLines(text: string): string[] {
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
 * Myers' greedy shortest-edit-script with a per-round trace for backtracking. Returns the
 * edit ops in order, or null when the edit distance or the work exceeds `limits`.
 */
function myers(a: readonly string[], b: readonly string[], limits: DiffLimits): Op[] | null {
  const n = a.length
  const m = b.length
  // Pure insertion or deletion (a new file, a deleted file, lines appended): nothing to search.
  if (n === 0 || m === 0) return new Array<Op>(n + m).fill(n === 0 ? 2 : 1)
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let work = 0
  let found = -1

  for (let d = 0; d <= max; d++) {
    if (d > limits.maxEdits) return null
    // Snapshot of v over k ∈ [-(d+1), d+1] before round d — all the backtrack reads.
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
          ? (v[offset + k + 1] as number)
          : (v[offset + k - 1] as number) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
        work += 1
      }
      work += 1
      if (work > limits.maxWork) return null
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }

  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const snap = trace[d] as Int32Array
    const at = (k: number): number => snap[k + d + 1] as number
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(0)
      x -= 1
      y -= 1
    }
    if (d === 0) break
    ops.push(x === prevX ? 2 : 1)
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

/**
 * Compute a line-level diff. `null` means the change is too large for an in-browser review;
 * callers should surface that honestly rather than freezing the page.
 */
export function diffTextLines(
  before: string,
  after: string,
  limits: DiffLimits = DEFAULT_DIFF_LIMITS,
): TextDiffLine[] | null {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)

  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const ops = myers(
    oldLines.slice(prefix, oldLines.length - suffix),
    newLines.slice(prefix, newLines.length - suffix),
    limits,
  )
  if (ops === null) return null

  const lines: TextDiffLine[] = []
  let o = 0
  let w = 0
  const context = (): void => {
    lines.push(toLine('context', oldLines[o] as string, o + 1, w + 1))
    o += 1
    w += 1
  }
  for (let i = 0; i < prefix; i++) context()
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
  for (let i = 0; i < suffix; i++) context()
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

/** Keep `context` unchanged lines around edits and replace each omitted run with one gap row. */
export function compactDiffLines(
  lines: readonly TextDiffLine[],
  context = 3,
): CompactDiffLine[] {
  const visible = new Uint8Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.kind === 'context') continue
    const from = Math.max(0, i - context)
    const to = Math.min(lines.length - 1, i + context)
    visible.fill(1, from, to + 1)
  }

  const out: CompactDiffLine[] = []
  let hidden = 0
  for (let i = 0; i < lines.length; i++) {
    if (visible[i] === 1) {
      if (hidden > 0) out.push({ kind: 'gap', hidden })
      hidden = 0
      out.push(lines[i] as TextDiffLine)
    } else {
      hidden += 1
    }
  }
  if (hidden > 0) out.push({ kind: 'gap', hidden })
  return out
}
