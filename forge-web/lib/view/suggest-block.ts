/**
 * Writing a ```` ```suggestion ```` block into a review comment (GitHub's "Insert a suggestion",
 * review-parity R5): the block is pre-filled with the lines it would replace, fenced so no line
 * of theirs can close it early. And the lines a suggestion on an anchor would replace, read from
 * the head's text of its file (a comment's diff shows them as removed).
 */

/** A fence longer than any backtick run in `lines` (at least three). Linear in the text. */
export function suggestionFence(lines: readonly string[]): string {
  let longest = 0
  for (const line of lines) {
    let run = 0
    for (let i = 0; i < line.length; i++) {
      run = line[i] === '`' ? run + 1 : 0
      if (run > longest) longest = run
    }
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * `body` with a suggestion block of `lines` in place of `start..end` (the selection), on lines
 * of its own; `caret` is the end of the suggested text (where the author goes on typing).
 */
export function insertSuggestion(body: string, start: number, end: number, lines: readonly string[]): { body: string; caret: number } {
  const before = body.slice(0, start)
  const after = body.slice(end)
  const fence = suggestionFence(lines)
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const open = `${before}${lead}${fence}suggestion\n${lines.join('\n')}`
  const trail = after === '' ? '\n' : after.startsWith('\n') ? '' : '\n'
  return { body: `${open}\n${fence}${trail}${after}`, caret: open.length }
}

/** Where a suggestion points: a comment's anchor, or a pending comment's. */
export interface SuggestionAnchor {
  readonly path: string
  readonly line?: number | null | undefined
  readonly startLine?: number | null | undefined
  readonly side?: 0 | 1 | null | undefined
  readonly commitOid?: string | undefined
}

/**
 * The lines of `text` (the head's file) that a suggestion on `a` would replace, or null when they
 * are not those of `head`'s new side (the old side, another head, out of range).
 */
export function linesAt(text: string | null | undefined, a: SuggestionAnchor, head: string): readonly string[] | null {
  if (typeof text !== 'string' || a.line == null || a.side !== 1 || (a.commitOid ?? '').toLowerCase() !== head.toLowerCase()) return null
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = a.startLine ?? a.line
  return start >= 1 && start <= a.line && a.line <= lines.length ? lines.slice(start - 1, a.line) : null
}
