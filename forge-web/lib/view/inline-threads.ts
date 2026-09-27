/**
 * Placing inline comments on a PR diff (`ux-dx-spec.md` §5.7, review-parity §4.2). A thread is
 * a root comment with an anchor (`anchorOf`) and its replies (`replyTo`, followed to the root).
 * A thread shows under its line — the last line of a range — when its anchor names the PR's
 * current head and that line is still in the diff; otherwise (another head, no head recorded,
 * a line the diff no longer shows) it is outdated and collapses under "n comments on an older
 * version". A file-level anchor (a path, no line) on the current head is listed with the
 * threads not shown on a line.
 */

import type { Anchor } from '../rules/v2'
import type { CommentView } from './issues-view'

export interface InlineThread {
  readonly root: CommentView & { readonly anchor: Anchor }
  /** Replies, oldest first. */
  readonly replies: readonly CommentView[]
}

/** `path` · side · line — where a thread sits in a diff. */
export function lineKey(path: string, side: 0 | 1, line: number): string {
  return `${side}:${line}:${path}`
}

export interface PlacedThreads {
  /** Threads on lines of the current diff, by {@link lineKey}. */
  readonly current: ReadonlyMap<string, readonly InlineThread[]>
  /** File-level threads (a path, no line) on the current head. */
  readonly fileLevel: readonly InlineThread[]
  /** Threads on an older head, or on a line (or file) the diff no longer shows. */
  readonly outdated: readonly InlineThread[]
  /** How many comments (roots and replies) are outdated. */
  readonly outdatedCount: number
  /** Comments that are neither anchored nor replies to an anchored comment. */
  readonly general: readonly CommentView[]
}

/** The ids of every comment that belongs to an inline thread (anchored roots and their replies). */
export function inlineCommentIds(comments: readonly CommentView[]): string[] {
  const byId = new Map(comments.map((c) => [c.id, c]))
  return comments.filter((c) => rootOf(c, byId).anchor !== null).map((c) => c.id)
}

/** The root a comment replies to (following `replyTo`), or itself; cycles stop. */
function rootOf(c: CommentView, byId: ReadonlyMap<string, CommentView>): CommentView {
  let cur = c
  const seen = new Set<string>([c.id])
  while (cur.replyTo !== null) {
    const parent = byId.get(cur.replyTo)
    if (parent === undefined || seen.has(parent.id)) break
    seen.add(parent.id)
    cur = parent
  }
  return cur
}

/**
 * Group `comments` into inline threads and place them. `lineExists(path, side, line)` says
 * whether the current diff shows that line, and `fileExists(path)` whether it shows that file
 * (pass `null` for either while the diff is still loading: then only the head check applies).
 */
export function placeThreads(
  comments: readonly CommentView[],
  headOid: string,
  lineExists: ((path: string, side: 0 | 1, line: number) => boolean) | null,
  fileExists: ((path: string) => boolean) | null = null,
): PlacedThreads {
  const byId = new Map(comments.map((c) => [c.id, c]))
  const threads = new Map<string, { root: InlineThread['root']; replies: CommentView[] }>()
  const general: CommentView[] = []
  for (const c of comments) {
    const root = rootOf(c, byId)
    if (root.anchor === null) {
      general.push(c)
      continue
    }
    let t = threads.get(root.id)
    if (t === undefined) {
      t = { root: root as InlineThread['root'], replies: [] }
      threads.set(root.id, t)
    }
    if (c.id !== root.id) t.replies.push(c)
  }
  const current = new Map<string, InlineThread[]>()
  const fileLevel: InlineThread[] = []
  const outdated: InlineThread[] = []
  let outdatedCount = 0
  for (const t of threads.values()) {
    const a = t.root.anchor
    // An anchor that names no commit cannot be shown to be on this head: outdated.
    const onHead = a.commitOid !== '' && a.commitOid === headOid.toLowerCase()
    if (onHead && (a.line === null || a.side === null)) {
      if (fileExists === null || fileExists(a.path)) {
        fileLevel.push(t)
        continue
      }
    } else if (onHead && a.line !== null && a.side !== null && (lineExists === null || lineExists(a.path, a.side, a.line))) {
      const key = lineKey(a.path, a.side, a.line)
      current.set(key, [...(current.get(key) ?? []), t])
      continue
    }
    outdated.push(t)
    outdatedCount += 1 + t.replies.length
  }
  return { current, fileLevel, outdated, outdatedCount, general }
}

/** Where an anchor points, for a heading: `path line 12 (new)`, `path lines 3–5 (old)`, or `path`. */
export function anchorLabel(a: Anchor): string {
  if (a.line === null) return a.path
  const lines = a.startLine !== null && a.startLine !== a.line ? `lines ${a.startLine}–${a.line}` : `line ${a.line}`
  return `${a.path} ${lines}${a.side === null ? '' : a.side === 1 ? ' (new)' : ' (old)'}`
}
