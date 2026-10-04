/**
 * Syntax and word highlighting for a diff's lines. Each side of the file (old: everything not
 * added; new: everything not deleted) is highlighted whole, as the blob view does it, so a
 * multi-line string or comment colours correctly; then the changed words are marked inside that
 * HTML. Display only, and bounded by highlightBlob's caps: past them a line stays plain text.
 */

import { highlightBlob } from './highlight'
import type { TextDiffLine } from './text-diff'
import { escapeHtml, markSpans, pairWordDiffs, type Span } from './word-diff'

/** Which side of the file a rendered line is read from. */
export type DiffSide = 'old' | 'new'

/** A file's two sides as text, and where each line sits in them. */
export interface DiffSides {
  readonly oldText: string
  readonly newText: string
  readonly oldIndex: ReadonlyMap<TextDiffLine, number>
  readonly newIndex: ReadonlyMap<TextDiffLine, number>
}

export function diffSides(full: readonly TextDiffLine[]): DiffSides {
  const oldLines: string[] = []
  const newLines: string[] = []
  const oldIndex = new Map<TextDiffLine, number>()
  const newIndex = new Map<TextDiffLine, number>()
  for (const line of full) {
    if (line.kind !== 'added') {
      oldIndex.set(line, oldLines.length)
      oldLines.push(line.text)
    }
    if (line.kind !== 'deleted') {
      newIndex.set(line, newLines.length)
      newLines.push(line.text)
    }
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n'), oldIndex, newIndex }
}

/** A diff's highlighting: per-side line HTML (null where a side stays plain) and the changed words. */
export interface DiffHighlight {
  readonly sides: DiffSides
  readonly old: readonly string[] | null
  readonly new: readonly string[] | null
  readonly words: ReadonlyMap<TextDiffLine, Span[]>
}

/** Word marks only, at once (no highlight.js): what a diff shows until its syntax colours load. */
export function wordsOnly(full: readonly TextDiffLine[]): DiffHighlight {
  return { sides: diffSides(full), old: null, new: null, words: pairWordDiffs(full) }
}

/**
 * Add syntax colours to {@link wordsOnly}'s result: both sides, by the file names (never a guessed
 * language: the two sides must agree). An added file has no old side to highlight, a deleted one
 * no new side.
 */
export async function highlightDiff(base: DiffHighlight, path: string, oldPath: string): Promise<DiffHighlight> {
  const { sides } = base
  const side = (text: string, index: ReadonlyMap<TextDiffLine, number>, name: string): Promise<readonly string[] | null> =>
    index.size === 0 ? Promise.resolve(null) : highlightBlob(text, name, { guess: false }).then((h) => h?.lines ?? null)
  const [oldHl, newHl] = await Promise.all([side(sides.oldText, sides.oldIndex, oldPath), side(sides.newText, sides.newIndex, path)])
  return { ...base, old: oldHl, new: newHl }
}

const WORD_CLASS: Readonly<Record<'added' | 'deleted', string>> = { added: 'diff-add-word', deleted: 'diff-del-word' }

/**
 * A line's HTML on one side: its syntax colours (when that side is highlighted) with the changed
 * words marked, or null when there is neither (the caller renders the plain text). Context lines
 * have no word marks.
 */
export function lineHtml(h: DiffHighlight, line: TextDiffLine, side: DiffSide): string | null {
  const hl = side === 'old' ? h.old : h.new
  const index = (side === 'old' ? h.sides.oldIndex : h.sides.newIndex).get(line)
  const syntax = hl !== null && index !== undefined ? (hl[index] ?? null) : null
  if (line.kind === 'context') return syntax
  const spans = h.words.get(line)
  return spans === undefined ? syntax : markSpans(syntax ?? escapeHtml(line.text), spans, WORD_CLASS[line.kind])
}
