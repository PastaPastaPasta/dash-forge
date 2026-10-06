/**
 * The pure part of maintainer moderation (RC2 MOD) the loaders and list indexes use, apart from the
 * writes in `moderation.ts` (which pull in the write path): a thread's hides, what readers
 * collapse ({@link hiddenItems}), and whether a hide or unhide would take effect
 * ({@link hideBlocked}).
 */

import type { Event } from '../rules'
import { applyBans, type Ban } from '../rules/bans'
import { hiddenItems, hideBlocked, isModerationKind, NOTHING_HIDDEN, type HiddenItems, type HideBlock, type HideScope, type Membership, type ThreadItem } from '../rules/v2'

/** forge-community `event.asMaintainer` (RC2 MOD): the writer's maintainer document, proved. */
export const EVENT_AS_MAINTAINER = 'asMaintainer'

/** Whether a thread's events hold any hide or unhide (nothing to fold, and no read, otherwise). */
export function hasHides(events: readonly Event[]): boolean {
  return events.some(isModerationKind)
}

/** What the reader rule reads for one thread. */
export interface ModerationInput {
  readonly events: readonly Event[]
  readonly scope: HideScope
  readonly comments: readonly ThreadItem[]
  readonly reviews: readonly ThreadItem[]
  /** The repo's standing bans (UPDATE-1): a banned identity's thread, comments and reviews collapse too. */
  readonly bans?: ReadonlyMap<string, Ban>
}

/**
 * A thread's {@link ModerationInput}, with the repo's current maintainers (they count only without
 * the contract's proof).
 */
export function moderationInput(input: {
  readonly events: readonly Event[]
  readonly thread: { readonly id: string; readonly author: string }
  readonly owner: string
  readonly members: readonly Membership[]
  readonly proved: boolean
  readonly comments: readonly { readonly id: string; readonly author: string; readonly reviewId?: string | null }[]
  readonly reviews?: readonly { readonly id: string; readonly reviewer: string }[]
  readonly bans?: ReadonlyMap<string, Ban>
}): ModerationInput {
  return {
    ...(input.bans !== undefined && input.bans.size > 0 ? { bans: input.bans } : {}),
    events: input.events,
    scope: {
      threadId: input.thread.id,
      threadAuthor: input.thread.author,
      owner: input.owner,
      maintainers: input.members.filter((m) => m.role === 'maintainer').map((m) => m.identity),
      proved: input.proved,
    },
    comments: input.comments.map((c) => ({ id: c.id, author: c.author, reviewId: c.reviewId ?? null })),
    reviews: (input.reviews ?? []).map((r) => ({ id: r.id, author: r.reviewer })),
  }
}

/** What readers collapse in one thread ({@link hiddenItems}); nothing to fold without a hide. */
export function foldModeration(m: ModerationInput): HiddenItems {
  const hidden = hasHides(m.events) ? hiddenItems(m.events, m.scope, m.comments, m.reviews) : NOTHING_HIDDEN
  return m.bans === undefined ? hidden : applyBans(hidden, m.bans, m.scope.threadAuthor, m.comments, m.reviews)
}

/** {@link moderationInput} folded: what readers collapse in one thread. */
export function threadModeration(input: Parameters<typeof moderationInput>[0]): HiddenItems {
  return foldModeration(moderationInput(input))
}

/** Why `signer`'s hide (`hide`) or unhide of `item` (null: the thread) would change nothing ({@link hideBlocked}). */
export function moderationBlocked(m: ModerationInput | undefined, signer: string | null, item: string | null, hide: boolean): HideBlock | null {
  if (m === undefined || signer === null) return null
  return hideBlocked(m.events, m.scope, m.comments, m.reviews, signer, item, hide)
}

/** A thread's hides and unhides of the whole thread (no `refId`): what a list row keeps. */
export function threadHidesOf(events: readonly Event[]): readonly Event[] {
  return events.filter((e) => isModerationKind(e) && !e.refId)
}
