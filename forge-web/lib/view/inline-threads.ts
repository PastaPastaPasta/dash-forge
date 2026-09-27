/**
 * Placing inline comments on a PR diff (`ux-dx-spec.md` §5.7). A thread is a root comment with
 * an anchor and its replies (`replyTo`, followed to the root). A thread shows under its line
 * when its anchor names the PR's current head and the line is still in the diff; otherwise
 * (another head, no head recorded, a line the diff no longer shows) it is outdated and
 * collapses under "n comments on an older version".
 */

import type { CommentAnchor } from '../repo/anchors'
import type { CommentView } from './issues-view'

export interface InlineThread {
  readonly root: CommentView & { readonly anchor: CommentAnchor }
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
  /** Threads on an older head, or on a line the diff no longer shows. */
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
 * whether the current diff shows that line (pass `null` while the diff is still loading:
 * then only the head check applies).
 */
export function placeThreads(
  comments: readonly CommentView[],
  headOid: string,
  lineExists: ((path: string, side: 0 | 1, line: number) => boolean) | null,
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
  const outdated: InlineThread[] = []
  let outdatedCount = 0
  for (const t of threads.values()) {
    const a = t.root.anchor
    // An anchor that names no commit cannot be shown to be on this head: outdated.
    const onHead = a.commitOid !== '' && a.commitOid === headOid.toLowerCase()
    const shown = onHead && (lineExists === null || lineExists(a.path, a.side, a.line))
    if (shown) {
      const key = lineKey(a.path, a.side, a.line)
      current.set(key, [...(current.get(key) ?? []), t])
    } else {
      outdated.push(t)
      outdatedCount += 1 + t.replies.length
    }
  }
  return { current, outdated, outdatedCount, general }
}
