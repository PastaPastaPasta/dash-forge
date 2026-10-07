/**
 * Maintainer bans (UPDATE-1 `ban`, `forge-v2.md` §3.2): which identities a repo's maintainers
 * banned, and what readers collapse because of it. The TypeScript half of forge-core
 * `rules::bans` (whose module docs are the spec), held equal by the `bans__*` vectors:
 *
 * 1. A ban counts only while its writer is the repo's owner or a current maintainer.
 * 2. A ban of the owner or of a current maintainer is ignored.
 * 3. Several standing bans of one identity: the owner's decides, else the earliest by
 *    (`$createdAt`, `$id`).
 * 4. Readers collapse every issue, PR, comment and review the banned identity wrote in the repo,
 *    with a reveal; an item a maintainer hid keeps its hide. Display only.
 * 5. Clients refuse the banned identity's writes in the repo before signing.
 *
 * `reason` is a code 0–255 by contract; {@link BAN_REASONS} is what it means.
 */

import type { Hidden, HiddenItems, ThreadItem } from './moderation'
import { compareStrings } from './oid'

/** The reason codes clients write and how they read them. 0 (or none) is no reason. */
export const BAN_REASONS = [
  [1, 'spam'],
  [2, 'abuse'],
  [3, 'off-topic'],
] as const

/** How a reason code outside {@link BAN_REASONS} (and not 0) reads. */
export const BAN_REASON_OTHER = 'other'

/** The reason a ban's code names: null for no reason (absent or 0). */
export function banReasonLabel(code: number | null | undefined): string | null {
  if (code === null || code === undefined || code === 0) return null
  return BAN_REASONS.find(([c]) => c === code)?.[1] ?? BAN_REASON_OTHER
}

/** The code a reason name is written as (null: not one of {@link BAN_REASONS}). */
export function banReasonCode(name: string): number | null {
  return BAN_REASONS.find(([, n]) => n === name.toLowerCase())?.[0] ?? null
}

/** A `ban` document, flattened. */
export interface Ban {
  readonly id: string
  /** `identityId`: who is banned (base58). */
  readonly identity: string
  /** `$ownerId`: the maintainer who banned them. */
  readonly by: string
  readonly reason?: number | null
  readonly createdAt: number
}

/** Whose bans count in a repo: the owner and the maintainers now. */
export interface BanScope {
  readonly owner: string
  readonly maintainers: readonly string[]
}

const moderates = (scope: BanScope, id: string): boolean => id === scope.owner || scope.maintainers.includes(id)

/** The standing ban of each banned identity (rules 1–3), by identity. */
export function standingBans(bans: readonly Ban[], scope: BanScope): ReadonlyMap<string, Ban> {
  const ordered = bans
    .filter((b) => moderates(scope, b.by) && !moderates(scope, b.identity))
    .sort((a, b) => a.createdAt - b.createdAt || compareStrings(a.id, b.id))
  const out = new Map<string, Ban>()
  for (const b of ordered) {
    const have = out.get(b.identity)
    // The owner's outranks a maintainer's earlier one; otherwise the earliest stands.
    if (have !== undefined && !(have.by !== scope.owner && b.by === scope.owner)) continue
    out.set(b.identity, b)
  }
  return out
}

/** A ban as a reader's collapse. */
export function banHidden(ban: Ban): Hidden {
  return { by: ban.by, reason: null, at: ban.createdAt, eventId: ban.id, via: 'ban', banReason: ban.reason ?? 0 }
}

/**
 * `hidden` (a thread's maintainer hides, `hiddenItems`) with the standing `bans` applied (rule 4):
 * the thread when its author is banned, and every comment and review a banned identity wrote, each
 * unless a hide already covers it. `counted` is unchanged.
 */
export function applyBans(
  hidden: HiddenItems,
  bans: ReadonlyMap<string, Ban>,
  threadAuthor: string,
  comments: readonly ThreadItem[],
  reviews: readonly ThreadItem[],
): HiddenItems {
  if (bans.size === 0) return hidden
  const items: Record<string, Hidden> = { ...hidden.items }
  for (const item of [...comments, ...reviews]) {
    if (items[item.id] !== undefined) continue
    const b = bans.get(item.author)
    if (b !== undefined) items[item.id] = banHidden(b)
  }
  const author = bans.get(threadAuthor)
  return { thread: hidden.thread ?? (author !== undefined ? banHidden(author) : null), items, counted: hidden.counted }
}
