/**
 * Review comments across a moved PR head (QW3-015, the QW2-049 follow-up). GitHub keeps a review
 * comment on its line while the lines it covers are unchanged in the new head, moving it with the
 * lines around it; only a comment whose lines changed goes Outdated. Here an anchor on an older
 * head is carried to the current head the same way: the file at the anchor's commit is diffed
 * against the file at the head (git's line diff, `text-diff.ts`), and when every line the comment
 * covers is an unchanged line of that diff, the anchor names the head and the lines' new numbers.
 * Anything else (a changed or deleted line, an old-side comment, a file-level one, a renamed,
 * unreadable or too-large file) stays on its commit, and so outdated. `dg pr view` still names
 * the commit a comment was made on.
 *
 * A carried suggestion is then appliable on the head, at its lines there: the lines it replaces
 * are byte-for-byte the ones the reviewer commented on.
 */

import type { Anchor } from '../rules/v2'
import { diffTextLines, splitLines } from './text-diff'

/** Old line → new line for every line `after` kept unchanged from `before`; null when the diff is too large to make. */
export type LineMap = ReadonlyMap<number, number>

export function lineMap(before: string, after: string): LineMap | null {
  if (before === after) {
    const n = splitLines(before).length
    return new Map(Array.from({ length: n }, (_, i) => [i + 1, i + 1] as const))
  }
  const lines = diffTextLines(before, after)
  if (lines === null) return null
  const out = new Map<number, number>()
  for (const l of lines) if (l.kind === 'context' && l.oldLine !== null && l.newLine !== null) out.set(l.oldLine, l.newLine)
  return out
}

/** The lines `start..end` (1-based, inclusive) through `map`, when all are kept and still adjacent; else null. */
export function carryLines(map: LineMap, start: number, end: number): { readonly start: number; readonly end: number } | null {
  if (start < 1 || end < start) return null
  const first = map.get(start)
  if (first === undefined) return null
  // Every line kept, and nothing inserted between them (a range stays one range).
  for (let n = start + 1; n <= end; n++) if (map.get(n) !== first + (n - start)) return null
  return { start: first, end: first + (end - start) }
}

/** Where `a` would be carried from: its commit, when it is a new-side line comment on another commit than `head`; else null. */
export function carryFrom(a: Anchor, head: string): string | null {
  const h = head.toLowerCase()
  return a.line === null || a.side !== 1 || a.commitOid === '' || h === '' || a.commitOid === h ? null : a.commitOid
}

/** `a` carried to `head` through the line map of its file between its commit and the head (null: unread or too large), or null. */
export function carryAnchor(a: Anchor, head: string, map: LineMap | null | undefined): Anchor | null {
  if (a.line === null || carryFrom(a, head) === null || map == null) return null
  const at = carryLines(map, a.startLine ?? a.line, a.line)
  if (at === null) return null
  return { ...a, commitOid: head.toLowerCase(), line: at.end, startLine: a.startLine === null ? null : at.start }
}
