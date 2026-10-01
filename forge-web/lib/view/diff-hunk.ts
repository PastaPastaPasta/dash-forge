/**
 * A mirrored review comment's source diff hunk (RC2 rider QW2-010, `comment.diffHunk`), parsed for
 * display: the `@@ -o,a +n,b @@` header, then each line numbered on the side(s) it belongs to, and
 * the commented range marked. The importer stores the tail of the source's hunk that ends at the
 * commented line (`crates/forge-import/src/hunk.rs`), so the last lines are the commented ones.
 *
 * The text is the source's, untrusted: it is only ever rendered as text, and a hunk that does
 * not parse is shown as plain monospace text ({@link parseDiffHunk} returns null).
 */

import { trustedOrigin } from '../repo/provenance'
import type { CommentView } from './issues-view'

/**
 * The hunk a reader shows for comment `c`: its `diffHunk` (an imported comment on a file) when its
 * provenance is trusted (`trustedOrigin`: the signer may mirror, `trust` the mirror set), else
 * null. A native or untrusted comment's hunk is never shown.
 */
export function shownHunk(c: Pick<CommentView, 'diffHunk' | 'anchor' | 'origin' | 'author'>, trust: ReadonlySet<string> | null): string | null {
  if (c.diffHunk == null || c.anchor === null || c.origin == null) return null
  return trustedOrigin(c.origin, c.author, trust) !== null ? c.diffHunk : null
}

/** One hunk line: its kind, its numbers on the old and new side, and whether it is commented on. */
export interface HunkLine {
  readonly kind: 'context' | 'add' | 'del' | 'note'
  /** The line on the old side (`-` and context lines), else null. */
  readonly old: number | null
  /** The line on the new side (`+` and context lines), else null. */
  readonly new: number | null
  /** The text without its `+` / `-` / ` ` marker (a `\` note keeps its words). */
  readonly text: string
  /** Inside the commented range on the comment's side. */
  readonly marked: boolean
}

/** A parsed hunk: its header and lines. */
export interface ParsedHunk {
  readonly header: string
  readonly lines: readonly HunkLine[]
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** How many lines a comment covers: `startLine..line`, or 1. */
export function commentedSpan(line: number | null, startLine: number | null): number {
  return line !== null && startLine !== null && startLine <= line ? line - startLine + 1 : 1
}

/**
 * Parse `hunk`, marking the commented lines: the last `commented.span` lines on `commented.side`
 * (1 new, 0 old). The stored hunk ends at the commented line, so the range is its tail, whatever
 * commit the comment's anchor names now. Null when the header does not parse or a line has an
 * unknown marker.
 */
export function parseDiffHunk(hunk: string, commented?: { readonly side: 0 | 1 | null; readonly span: number }): ParsedHunk | null {
  const all = hunk.split('\n')
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  const header = all[0]
  const m = header === undefined ? null : HEADER.exec(header)
  if (header === undefined || m === null) return null
  let old = Number(m[1])
  let neu = Number(m[2])
  const lines: HunkLine[] = []
  for (const raw of all.slice(1)) {
    const marker = raw[0]
    if (marker === '+') {
      lines.push({ kind: 'add', old: null, new: neu++, text: raw.slice(1), marked: false })
    } else if (marker === '-') {
      lines.push({ kind: 'del', old: old++, new: null, text: raw.slice(1), marked: false })
    } else if (marker === ' ' || marker === undefined) {
      // A context line (an empty one lost its space on the way: still context).
      lines.push({ kind: 'context', old: old++, new: neu++, text: raw.slice(1), marked: false })
    } else if (marker === '\\') {
      lines.push({ kind: 'note', old: null, new: null, text: raw, marked: false })
    } else {
      return null
    }
  }
  const side = commented?.side ?? null
  if (side === null) return { header, lines }
  const counts = (l: HunkLine): boolean => (side === 1 ? l.new !== null : l.old !== null)
  let left = commented?.span ?? 1
  const marked = [...lines]
  for (let i = marked.length - 1; i >= 0 && left > 0; i--) {
    const l = marked[i]!
    if (!counts(l)) continue
    marked[i] = { ...l, marked: true }
    left--
  }
  return { header, lines: marked }
}
