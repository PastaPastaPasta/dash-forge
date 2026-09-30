/**
 * Keyboard access to a diff's line-number buttons (each opens an inline comment) as one tab
 * stop per file, not one per line: a roving tabindex. Tab reaches one gutter button; the arrow
 * keys move between them. One tab stop per code line made a 400-line diff 400 Tab presses deep,
 * and packed 20 px tab stops against each other (axe `target-size`, WCAG 2.5.8).
 */

import type { CompactDiffLine } from '@/lib/view/text-diff'

export type GutterSide = 0 | 1

/** A gutter button's key: its side (0 old, 1 new) and line number. */
export function gutterKey(side: GutterSide, line: number): string {
  return `${side}:${line}`
}

/** The key of each line number a patch's shown rows put in the gutter, in order. */
export function gutterKeys(rows: readonly CompactDiffLine[]): string[] {
  const out: string[] = []
  for (const l of rows) {
    if (l.kind === 'gap') continue
    if (l.kind !== 'added' && l.oldLine !== null) out.push(gutterKey(0, l.oldLine))
    if (l.kind !== 'deleted' && l.newLine !== null) out.push(gutterKey(1, l.newLine))
  }
  return out
}

/** Which gutter button is the file's tab stop: the one last focused while it is shown, else the first. */
export function gutterTabStop(keys: readonly string[], last: string | null): string | null {
  if (last !== null && keys.includes(last)) return last
  return keys[0] ?? null
}

/** Where an arrow key moves focus in one side's buttons (`count` of them, focus at `index`); null: not a move. */
export function nextGutterIndex(count: number, index: number, key: string): number | null {
  if (count === 0 || index < 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, index + 1)
    case 'ArrowUp':
      return Math.max(0, index - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
