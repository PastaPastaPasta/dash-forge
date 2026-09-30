/**
 * An issue's cross-references (QW2-048), as GitHub's timeline shows them:
 *
 * - "closed this as completed in #3": the close was made by the merge of a pull request whose
 *   description closes the issue ("Fixes #1"). A `transition` names no cause, so the close is
 *   matched to the merge it followed: the same identity recorded both, the close at or after the
 *   merge and within {@link CLOSED_IN_WINDOW_MS} of it (the merge box, and `dg pr merge`, close the
 *   linked issues right after merging).
 * - "mentioned this issue in #4": a pull request whose description names `#N` without closing it
 *   ("Refs #2"). Only descriptions are read (from the pull index the issue page already shares);
 *   mentions in comments have no index to find them by.
 */

import type { TransitionView } from '../repo/transitions'
import { ISSUE_CLOSE } from '../rules/transition'

/** How long after a merge its linked issues' closes are taken to be its doing. */
export const CLOSED_IN_WINDOW_MS = 10 * 60_000

/** Inline code spans. */
const INLINE_CODE = /(`+)[^`]*?\1/g
/** A Markdown link or image destination (`[text](#2-install)` is an anchor, not a reference). */
const LINK_DEST = /\]\([^)\s]*(?:\s+"[^"]*")?\)/g
/** `#n` not glued to a word, an `&` (an entity) or a path (`owner/repo#n` names another repo). */
const REF = /(^|[^\w&/#])#(\d{1,10})(?!\w)/g

/** `text` without its fenced code blocks (``` or ~~~, to the closing fence or the end). */
function withoutFences(text: string): string {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence === null) {
      if (open) fence = open[1] as string
      else kept.push(line)
    } else if (open && (open[1] as string)[0] === fence[0] && (open[1] as string).length >= fence.length && line.trim() === open[1]) {
      fence = null
    }
  }
  return kept.join('\n')
}

/**
 * The issue and PR numbers `text` references as `#n`, outside code, deduplicated and ascending.
 * Closing references ("Fixes #1") are references too: the caller separates them.
 */
export function referencedNumbers(text: string): number[] {
  const prose = withoutFences(text).replace(INLINE_CODE, '').replace(LINK_DEST, ']')
  const out = new Set<number>()
  for (const m of prose.matchAll(REF)) {
    const n = Number(m[2])
    if (n > 0 && n <= 0xffff_ffff) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/** A merged pull request that closes the issue, with the transition that merged it. */
export interface ClosingMerge<P> {
  readonly pull: P
  readonly merge: Pick<TransitionView, 'actor' | 'createdAt'>
}

/**
 * The merged pull request `close` was made by, or null: of the merges by the same identity at or
 * before the close, and at most {@link CLOSED_IN_WINDOW_MS} before it, the latest.
 */
export function closedIn<P>(close: Pick<TransitionView, 'kind' | 'actor' | 'createdAt'>, merges: readonly ClosingMerge<P>[]): P | null {
  if (close.kind !== ISSUE_CLOSE) return null
  let best: ClosingMerge<P> | null = null
  for (const m of merges) {
    if (m.merge.actor !== close.actor) continue
    const gap = close.createdAt - m.merge.createdAt
    if (gap < 0 || gap > CLOSED_IN_WINDOW_MS) continue
    if (best === null || m.merge.createdAt > best.merge.createdAt) best = m
  }
  return best?.pull ?? null
}
