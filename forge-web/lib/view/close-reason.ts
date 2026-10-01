/**
 * How the issue pages say why an issue was closed (RC2 rider QW-069): the timeline's sentence for
 * a close, and whether it was done (completed: the purple check) or not (not planned or a
 * duplicate: GitHub's grey slash). The reading itself is the shared rule (`closeReasonOf`,
 * `currentCloseReason` in `lib/rules/transition.ts`); a duplicate links only to an issue of the
 * repo ({@link closeWhyOf}'s `duplicates`).
 */

import { closeReasonOf, closeReasonPhrase, type ClosedAs, type Transition } from '../rules/transition'

/** A linked issue: its number, title ('' when unreadable) and page. */
export interface IssueLink {
  readonly number: number
  readonly title: string
  readonly href: string
}

/** Why a close happened, as the timeline says it. */
export interface CloseWhy {
  /** "closed this as not planned" (a duplicate whose canonical does not link: "closed this as a duplicate"). */
  readonly phrase: string
  /** A duplicate's canonical, when it is an issue of the repo. */
  readonly duplicate: IssueLink | null
  /** Not done (not planned, or a duplicate): the grey icon. */
  readonly skipped: boolean
}

/** A close reason after "closed as": "completed", "not planned", "a duplicate of #3". */
export function closedAsWords(c: ClosedAs): string {
  if (c.reason === 'duplicate') return c.duplicateOf !== null ? `a duplicate of #${c.duplicateOf}` : 'a duplicate'
  return c.reason === 'not_planned' ? 'not planned' : 'completed'
}

/** Whether a close reason means "not done" (the grey icon and badge). */
export function closedSkipped(closed: ClosedAs | null | undefined): boolean {
  return closed?.reason === 'not_planned' || closed?.reason === 'duplicate'
}

/**
 * The timeline's words for transition `t` of issue #`targetNumber`: null unless it is an issue
 * close with a reason. `duplicates` are the canonicals that are issues of the repo (by number),
 * `href` their pages.
 */
export function closeWhyOf(
  t: Transition,
  targetNumber: number,
  duplicates: ReadonlyMap<number, { readonly number: number; readonly title: string }>,
  href: (n: number) => string,
): CloseWhy | null {
  const closed = closeReasonOf(t, targetNumber)
  if (closed === null) return null
  const canonical = closed.duplicateOf === null ? undefined : duplicates.get(closed.duplicateOf)
  return {
    phrase: closeReasonPhrase({ ...closed, duplicateOf: canonical === undefined ? null : closed.duplicateOf }),
    duplicate: canonical === undefined ? null : { number: canonical.number, title: canonical.title, href: href(canonical.number) },
    skipped: closedSkipped(closed),
  }
}
