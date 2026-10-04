/**
 * Syntax and word highlighting for a diff's lines. Each side of the file (old: everything not
 * added; new: everything not deleted) is highlighted whole, as the blob view does it, so a
 * multi-line string or comment colours correctly; then the changed words are marked inside that
 * HTML. Display only, and bounded: a side over {@link DIFF_HIGHLIGHT_MAX} characters, or one
 * highlight.js cannot colour, leaves both sides plain (never one coloured and one not), and the
 * files of a page are coloured one side per task, so opening many never blocks the page at once.
 */

import { highlightBlob } from './highlight'
import type { TextDiffLine } from './text-diff'
import { escapeHtml, markSpans, pairWordDiffs, type Span } from './word-diff'

/**
 * The longest side, in characters, that is coloured: highlight.js takes about 1 ms per KiB of C++
 * on the main thread, so this keeps each side's task near 100 ms.
 */
export const DIFF_HIGHLIGHT_MAX = 128 * 1024

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
  const wanted = [
    { text: sides.oldText, index: sides.oldIndex, name: oldPath },
    { text: sides.newText, index: sides.newIndex, name: path },
  ].filter((s) => s.index.size > 0)
  if (wanted.some((s) => s.text.length > DIFF_HIGHLIGHT_MAX)) return base
  const lines: (readonly string[] | null)[] = []
  for (const s of wanted) {
    const hl = await inTurn(() => highlightBlob(s.text, s.name, { guess: false }))
    if (hl === null) return base
    lines.push(hl.lines)
  }
  const at = (index: ReadonlyMap<TextDiffLine, number>): readonly string[] | null => (index.size === 0 ? null : (lines.shift() ?? null))
  return { ...base, old: at(sides.oldIndex), new: at(sides.newIndex) }
}

/** The colouring jobs of every diff on the page, one after another, each in a task of its own. */
let queue: Promise<unknown> = Promise.resolve()

function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(() => new Promise<void>((r) => setTimeout(r, 0))).then(job)
  queue = run.catch(() => undefined)
  return run
}

const WORD_CLASS: Readonly<Record<'added' | 'deleted', string>> = { added: 'diff-add-word', deleted: 'diff-del-word' }

/**
 * A line's HTML on one side: its syntax colours (when that side is highlighted) with the changed
 * words marked, or null when there is neither (the caller renders the plain text). Context lines
 * have no word marks.
 */
export function lineHtml(h: DiffHighlight, line: TextDiffLine, side: DiffSide): string | null {
  let memo = MEMO.get(h)
  if (memo === undefined) MEMO.set(h, (memo = { old: new Map(), new: new Map() }))
  const known = memo[side].get(line)
  if (known !== undefined) return known
  const html = buildLineHtml(h, line, side)
  memo[side].set(line, html)
  return html
}

/** Each highlighting's line HTML, built once per line and side (a diff re-renders on every gutter focus). */
const MEMO = new WeakMap<DiffHighlight, Record<DiffSide, Map<TextDiffLine, string | null>>>()

function buildLineHtml(h: DiffHighlight, line: TextDiffLine, side: DiffSide): string | null {
  const hl = side === 'old' ? h.old : h.new
  const index = (side === 'old' ? h.sides.oldIndex : h.sides.newIndex).get(line)
  const syntax = hl !== null && index !== undefined ? (hl[index] ?? null) : null
  if (line.kind === 'context') return syntax
  const spans = h.words.get(line)
  return spans === undefined ? syntax : markSpans(syntax ?? escapeHtml(line.text), spans, WORD_CLASS[line.kind])
}
