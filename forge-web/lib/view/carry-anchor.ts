/**
 * Review comments across a moved PR head (QW3-015, the QW2-049 follow-up). GitHub keeps a review
 * comment on its line while the lines it covers are unchanged in the new head, moving it with the
 * lines around it; only a comment whose lines changed goes Outdated. Here an anchor on an older
 * head is carried to the current head the same way: the file at the anchor's commit is diffed
 * against the file at the head (git's line diff, `text-diff.ts`), and when every line the comment
 * covers is an unchanged line of that diff, the anchor names the head and the lines' new numbers.
 * Anything else (a changed or deleted line, an old-side comment, a file-level one, an unreadable
 * or too-large file) stays on its commit, and so outdated.
 *
 * A carried suggestion is then appliable on the head, at its lines there: the lines it replaces
 * are byte-for-byte the ones the reviewer commented on.
 */

import type { Anchor } from '../rules/v2'
import { diffTextLines } from './text-diff'

/** The lines `start..end` (1-based, inclusive) of `before` in `after`, when all are unchanged and still adjacent; else null. */
export function carryLines(before: string, after: string, start: number, end: number): { readonly start: number; readonly end: number } | null {
  if (start < 1 || end < start) return null
  if (before === after) return { start, end }
  const lines = diffTextLines(before, after)
  if (lines === null) return null
  const moved = new Map<number, number>()
  for (const l of lines) if (l.kind === 'context' && l.oldLine !== null && l.newLine !== null) moved.set(l.oldLine, l.newLine)
  const first = moved.get(start)
  if (first === undefined) return null
  for (let n = start; n <= end; n++) {
    // Every line kept, and nothing inserted between them (a range stays one range).
    if (moved.get(n) !== first + (n - start)) return null
  }
  return { start: first, end: first + (end - start) }
}

/** Which file texts {@link carryAnchor} needs for `a` on `head`: the anchor's commit's and the head's, at its path; null when it cannot be carried. */
export function carrySources(a: Anchor, head: string): readonly { readonly commit: string; readonly path: string }[] | null {
  const h = head.toLowerCase()
  if (a.line === null || a.side !== 1 || a.commitOid === '' || h === '' || a.commitOid === h) return null
  return [
    { commit: a.commitOid, path: a.path },
    { commit: h, path: a.path },
  ]
}

/**
 * `a` carried to `head`, or null (it stays where it is). `texts(commit, path)` is the file's text
 * there: a string, null when it is not a readable text file, undefined while unread.
 */
export function carryAnchor(a: Anchor, head: string, texts: (commit: string, path: string) => string | null | undefined): Anchor | null {
  if (carrySources(a, head) === null || a.line === null) return null
  const before = texts(a.commitOid, a.path)
  const after = texts(head.toLowerCase(), a.path)
  if (typeof before !== 'string' || typeof after !== 'string') return null
  const at = carryLines(before, after, a.startLine ?? a.line, a.line)
  if (at === null) return null
  return { ...a, commitOid: head.toLowerCase(), line: at.end, startLine: a.startLine === null ? null : at.start }
}
