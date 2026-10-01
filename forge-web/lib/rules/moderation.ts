/**
 * Maintainer moderation (RC2 MOD, `docs/contracts/forge-v2.md` §3.2; part of FORGE_RULES_V2):
 * what a reader collapses after a maintainer's hide. TypeScript port of
 * `crates/forge-core/src/rules/moderation.rs`; the `"rules": "v2"` vectors `hidden_items__*` hold
 * the two in parity.
 *
 * Platform v5 cannot delete someone else's document in one repo only (contract moderation is
 * contract-wide), so a maintainer hides a comment, a review or a whole issue or PR with an
 * immutable `event` (kind 24, `refId` = the item, none = the thread; kind 25 unhides) and every
 * reader applies {@link hiddenItems}. Nothing is deleted; the events are the audit trail. With
 * the contract's `asMaintainer` proof every hide counts (consensus proved its writer a maintainer
 * when it was written); without it only the owner's and current maintainers' hides count.
 *
 * Display only: a hidden review's verdict still counts until it is dismissed (kind 15), because
 * clients compute merge readiness themselves and must agree.
 */

import { compareKey, compareStrings } from './oid'
import type { Event } from './types'

/** The reasons a hide may give (`value`); any other value reads as no reason. */
export const HIDE_REASONS = ['spam', 'abuse', 'off-topic', 'outdated', 'resolved', 'duplicate'] as const
export type HideReason = (typeof HIDE_REASONS)[number]

export function isHideReason(value: string): value is HideReason {
  return (HIDE_REASONS as readonly string[]).includes(value)
}

/** A comment or review of the thread: what a hide's `refId` may name. */
export interface ThreadItem {
  readonly id: string
  /** Its writer (`$ownerId`). */
  readonly author: string
  /** A comment's `reviewId` (an inline comment of that review). */
  readonly reviewId?: string | null
}

/** Who may hide in a thread, and how a reader judges it. */
export interface HideScope {
  /** The issue's or PR's `$id`. */
  readonly threadId: string
  readonly threadAuthor: string
  /** The repo's owner: its hide outranks a maintainer's, and only it hides what it wrote. */
  readonly owner: string
  /** The repo's maintainers now; read only without `proved`. */
  readonly maintainers?: readonly string[]
  /** Whether the contract proves a hide's maintainer (`event.asMaintainer`). */
  readonly proved: boolean
}

/** A standing hide. `via`: the item's own hide, or (an inline comment) its review's. */
export interface Hidden {
  readonly by: string
  readonly reason: HideReason | null
  readonly at: number
  readonly eventId: string
  readonly via: 'item' | 'review'
}

/** What a reader collapses in one issue or PR. */
export interface HiddenItems {
  /** The whole thread is hidden (lists leave it out; its page shows a banner). */
  readonly thread: Hidden | null
  /** Each hidden comment or review by `$id`, with the inline comments of a hidden review. */
  readonly items: Readonly<Record<string, Hidden>>
  /**
   * The `$id`s of the hide and unhide events that count (sorted): what the timeline shows as the
   * record. Any other kind 24/25 (a writer's without the proof, a `refId` of another thread) is
   * noise a reader drops.
   */
  readonly counted: readonly string[]
}

export const NOTHING_HIDDEN: HiddenItems = { thread: null, items: {}, counted: [] }

/** Whether `e` is a hide or an unhide (kinds 24/25). */
export function isModerationKind(e: Pick<Event, 'kind'>): boolean {
  return e.kind === 'hide' || e.kind === 'unhide'
}

/**
 * The hides standing in a thread (parity: Rust `hidden_items`). Per key — the thread, or one of
 * its comments or reviews — only kinds 24/25 on this thread count, from a proved hider or (no
 * proof) the owner or a current maintainer; a `refId` must name an item of this thread; the
 * owner's latest decides when the owner wrote any, only the owner hides what it wrote, otherwise
 * the latest by `($createdAt, $id)` decides. A review's hide also covers its inline comments.
 */
export function hiddenItems(
  events: readonly Event[],
  scope: HideScope,
  comments: readonly ThreadItem[],
  reviews: readonly ThreadItem[],
): HiddenItems {
  const authors = new Map<string, string>([...comments, ...reviews].map((i) => [i.id, i.author]))
  const maintainers = new Set(scope.maintainers ?? [])
  const ordered = events
    .filter((e) => isModerationKind(e) && e.targetId === scope.threadId)
    .filter((e) => scope.proved || e.actor === scope.owner || maintainers.has(e.actor))
    .sort((a, b) => compareKey(a, b))
  const THREAD = '\u0000thread'
  const byKey = new Map<string, Event[]>()
  const counted: string[] = []
  for (const e of ordered) {
    const ref = e.refId ?? null
    if (ref !== null && !authors.has(ref)) continue
    counted.push(e.id ?? '')
    const key = ref ?? THREAD
    const list = byKey.get(key)
    if (list) list.push(e)
    else byKey.set(key, [e])
  }
  let thread: Hidden | null = null
  const items: Record<string, Hidden> = {}
  for (const [key, list] of byKey) {
    const author = key === THREAD ? scope.threadAuthor : (authors.get(key) as string)
    const owners = list.filter((e) => e.actor === scope.owner)
    const decisive = owners.length > 0 ? owners[owners.length - 1] : author === scope.owner ? undefined : list[list.length - 1]
    if (decisive === undefined || decisive.kind !== 'hide') continue
    const value = decisive.value ?? null
    const hidden: Hidden = {
      by: decisive.actor,
      reason: value !== null && isHideReason(value) ? value : null,
      at: decisive.createdAt,
      eventId: decisive.id ?? '',
      via: 'item',
    }
    if (key === THREAD) thread = hidden
    else items[key] = hidden
  }
  for (const c of comments) {
    if (!c.reviewId || items[c.id] !== undefined) continue
    const h = items[c.reviewId]
    if (h !== undefined && h.via === 'item') items[c.id] = { ...h, via: 'review' }
  }
  return { thread, items, counted: [...new Set(counted)].sort(compareStrings) }
}

/**
 * Why a hide or unhide would change nothing a reader sees (parity: Rust `hide_blocked`): the
 * owner's content or decision (only the owner changes it), an inline comment hidden with its review
 * (unhide the review), already hidden, or not hidden. Null when it would take effect.
 */
export type HideBlock = 'ownersContent' | 'ownerDecided' | 'withItsReview' | 'alreadyHidden' | 'notHidden'

export function hideBlocked(
  events: readonly Event[],
  scope: HideScope,
  comments: readonly ThreadItem[],
  reviews: readonly ThreadItem[],
  signer: string,
  item: string | null,
  hide: boolean,
): HideBlock | null {
  if (signer !== scope.owner) {
    const author = item === null ? scope.threadAuthor : [...comments, ...reviews].find((c) => c.id === item)?.author
    if (author === scope.owner) return 'ownersContent'
    const ownerDecided = events.some((e) => isModerationKind(e) && e.targetId === scope.threadId && e.actor === scope.owner && (e.refId ?? null) === item)
    if (ownerDecided) return 'ownerDecided'
  }
  const now = hiddenItems(events, scope, comments, reviews)
  const via = (item === null ? now.thread : now.items[item])?.via ?? null
  if (hide && via === 'item') return 'alreadyHidden'
  if (!hide && via === null) return 'notHidden'
  if (!hide && via === 'review') return 'withItsReview'
  return null
}
