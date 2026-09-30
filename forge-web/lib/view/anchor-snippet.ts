/**
 * The code an inline review comment was left on, for the Conversation tab (QW2-049): GitHub shows
 * a review comment there under a few lines of its diff hunk, and marks it Outdated once the
 * head has moved on. Here the lines come from the file at the commit the comment names, for a
 * comment on the new side. An old-side comment's file is the base the reviewer compared
 * against, which is not recorded (the base moves, and a merged PR compares differently), so it
 * shows no code rather than lines that may not be the ones commented on.
 */

import type { Anchor } from '../rules/v2'

/** Context lines shown above the commented line (or range), as GitHub's hunk excerpt. */
export const SNIPPET_CONTEXT = 3
/** The most lines a snippet shows: a longer range keeps its last lines. */
export const SNIPPET_MAX_LINES = 12

export interface SnippetLine {
  /** 1-based line number in the file. */
  readonly n: number
  readonly text: string
  /** The line is one the comment covers (`startLine..line`). */
  readonly commented: boolean
}

/** Which file a snippet is read from: `commit`'s tree, at `path`. */
export interface SnippetSource {
  readonly commit: string
  readonly path: string
}

/** The key of a {@link SnippetSource} in a text cache. */
export function snippetKey(s: SnippetSource): string {
  return `${s.commit}:${s.path}`
}

/** Where `a`'s code is read from, or null (a file-level or old-side comment, or no commit recorded). */
export function snippetSource(a: Anchor): SnippetSource | null {
  if (a.line === null || a.side !== 1 || a.commitOid === '') return null
  return { commit: a.commitOid, path: a.path }
}

/**
 * The lines of `text` a snippet for `a` shows: up to {@link SNIPPET_CONTEXT} lines before the
 * commented range, then the range, at most {@link SNIPPET_MAX_LINES} in all (the last ones).
 * Null when the anchor's lines are not in the file.
 */
export function snippetLines(text: string | null | undefined, a: Anchor): readonly SnippetLine[] | null {
  if (typeof text !== 'string' || a.line === null) return null
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // A final newline ends the last line; it does not start another.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const start = a.startLine ?? a.line
  if (start < 1 || a.line > lines.length || start > a.line) return null
  const from = Math.max(1, start - SNIPPET_CONTEXT, a.line - SNIPPET_MAX_LINES + 1)
  const out: SnippetLine[] = []
  for (let n = from; n <= a.line; n++) out.push({ n, text: lines[n - 1] ?? '', commented: n >= start })
  return out
}
