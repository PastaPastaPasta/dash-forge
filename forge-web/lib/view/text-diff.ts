/** Small, dependency-free line diff for reviewable text blobs. */

export interface TextDiffLine {
  readonly kind: 'context' | 'added' | 'deleted'
  readonly oldLine: number | null
  readonly newLine: number | null
  readonly text: string
}

export type CompactDiffLine = TextDiffLine | { readonly kind: 'gap' }

/**
 * Compute a line-level diff with a bounded LCS table. `null` means the input is too large for
 * an in-browser review; callers should surface that honestly rather than freezing the page.
 */
export function diffTextLines(
  before: string,
  after: string,
  maxCells = 1_000_000,
): TextDiffLine[] | null {
  const oldLines = before === '' ? [] : before.split('\n')
  const newLines = after === '' ? [] : after.split('\n')
  const width = newLines.length + 1
  if ((oldLines.length + 1) * width > maxCells) return null

  const lcs = new Uint32Array((oldLines.length + 1) * width)
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      const at = oldIndex * width + newIndex
      lcs[at] =
        oldLines[oldIndex] === newLines[newIndex]
          ? (lcs[(oldIndex + 1) * width + newIndex + 1] as number) + 1
          : Math.max(
              lcs[(oldIndex + 1) * width + newIndex] as number,
              lcs[oldIndex * width + newIndex + 1] as number,
            )
    }
  }

  const lines: TextDiffLine[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      lines.push({
        kind: 'context',
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
        text: oldLines[oldIndex] as string,
      })
      oldIndex += 1
      newIndex += 1
    } else if (
      newIndex >= newLines.length ||
      (oldIndex < oldLines.length &&
        (lcs[(oldIndex + 1) * width + newIndex] as number) >=
          (lcs[oldIndex * width + newIndex + 1] as number))
    ) {
      lines.push({
        kind: 'deleted',
        oldLine: oldIndex + 1,
        newLine: null,
        text: oldLines[oldIndex] as string,
      })
      oldIndex += 1
    } else {
      lines.push({
        kind: 'added',
        oldLine: null,
        newLine: newIndex + 1,
        text: newLines[newIndex] as string,
      })
      newIndex += 1
    }
  }
  return lines
}

/** Keep `context` unchanged lines around edits and replace omitted runs with one gap row. */
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
  let gap = false
  for (let i = 0; i < lines.length; i++) {
    if (visible[i] === 1) {
      gap = false
      out.push(lines[i] as TextDiffLine)
    } else if (!gap) {
      gap = true
      out.push({ kind: 'gap' })
    }
  }
  return out
}
