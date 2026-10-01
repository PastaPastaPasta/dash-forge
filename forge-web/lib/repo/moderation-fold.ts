/**
 * The pure part of maintainer moderation (RC2 MOD) the loaders and list indexes use, apart from the
 * writes in `moderation.ts` (which pull in the write path): a thread's hides, and what readers
 * collapse ({@link hiddenItems}).
 */

import type { Event } from '../rules'
import { hiddenItems, NOTHING_HIDDEN, type HiddenItems, type Membership, type ThreadItem } from '../rules/v2'

/** Whether a thread's events hold any hide or unhide (nothing to fold, and no read, otherwise). */
export function hasHides(events: readonly Event[]): boolean {
  return events.some((e) => e.kind === 'hide' || e.kind === 'unhide')
}

/**
 * What readers collapse in one thread: {@link hiddenItems} over its events, comments and reviews,
 * with the repo's current maintainers (read only without the contract's proof).
 */
export function threadModeration(input: {
  readonly events: readonly Event[]
  readonly thread: { readonly id: string; readonly author: string }
  readonly owner: string
  readonly members: readonly Membership[]
  readonly proved: boolean
  readonly comments: readonly { readonly id: string; readonly author: string; readonly reviewId?: string | null }[]
  readonly reviews?: readonly { readonly id: string; readonly reviewer: string }[]
}): HiddenItems {
  if (!hasHides(input.events)) return NOTHING_HIDDEN
  const comments: ThreadItem[] = input.comments.map((c) => ({ id: c.id, author: c.author, reviewId: c.reviewId ?? null }))
  const reviews: ThreadItem[] = (input.reviews ?? []).map((r) => ({ id: r.id, author: r.reviewer }))
  return hiddenItems(
    input.events,
    {
      threadId: input.thread.id,
      threadAuthor: input.thread.author,
      owner: input.owner,
      maintainers: input.members.filter((m) => m.role === 'maintainer').map((m) => m.identity),
      proved: input.proved,
    },
    comments,
    reviews,
  )
}

/** A thread's hides and unhides of the whole thread (no `refId`): what a list row keeps. */
export function threadHidesOf(events: readonly Event[]): readonly Event[] {
  return events.filter((e) => (e.kind === 'hide' || e.kind === 'unhide') && !e.refId)
}
