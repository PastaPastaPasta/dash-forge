/**
 * Maintainer moderation (RC2 MOD, `docs/contracts/forge-v2.md` §3.2): hide and unhide a comment,
 * a review or a whole issue or PR, and what readers collapse. Parity: forge-core
 * `collab/moderation.rs` (`set_hidden`, `hidden_items`), `dg issue hide` / `dg pr hide`.
 *
 * A hide is an immutable member `event` (kind 24; 25 unhides) naming the item in `refId` (none:
 * the thread) and an optional reason in `value` (sealed in a private repo, like every event
 * value). Where the registered forge-community has `event.asMaintainer` (the
 * `event_as_maintainer` build flag) the event names the writer's own maintainer document and
 * consensus refuses it from anyone else; elsewhere readers count only the owner's and the current
 * maintainers' hides ({@link hiddenItems}). Nothing is deleted: Platform v5 cannot scope a delete
 * of someone else's document to one repo, so the UI never says "delete" for it.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import type { Event } from '../rules'
import type { HideReason, Membership } from '../rules/v2'
import type { Hidden } from '../rules/moderation'
import { EVENT_AS_MAINTAINER, threadModeration } from './moderation-fold'
import type { WriteAuth, WriteResult } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { contractHasProperty } from './contract-shape'
import { readMembershipsCached } from './members'
import type { Network } from '../constants'
import { targetEventData } from './review-writes'
import { writeRepoDoc, type WriteTarget } from './writes'

export { EVENT_AS_MAINTAINER }

/** Whether the repo's forge-community proves a hide's maintainer (then every hide counts). */
export function hidesProved(sdk: EvoSDK, repo: RepoRef): Promise<boolean> {
  return contractHasProperty(sdk, repo.forge.community, DOC.event, EVENT_AS_MAINTAINER)
}

/** What a hide or unhide writes: the event, and with `maintainer` (the signer) the proof. */
export function hideData(target: WriteTarget, input: { item?: string | null; reason?: HideReason | null; hide: boolean; maintainer?: string | null }): Record<string, unknown> {
  const data = targetEventData(target, input.hide ? 'hide' : 'unhide', {
    ...(input.hide && input.reason ? { value: input.reason } : {}),
    ...(input.item ? { refId: input.item } : {}),
  })
  if (input.maintainer) data[EVENT_AS_MAINTAINER] = decodeIdentifier(input.maintainer)
  return data
}

/**
 * Hide (`hide`) or unhide comment or review `item` of `target`, or with no `item` the thread.
 * Maintainers only: consensus refuses anyone else where the contract proves it, and readers ignore
 * them elsewhere, so the page offers it to maintainers alone.
 */
export async function setHidden(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; item?: string | null; reason?: HideReason | null; hide: boolean; intent?: string },
): Promise<WriteResult> {
  const proved = await hidesProved(sdk, repo)
  const data = hideData(input.target, { ...input, maintainer: proved ? auth.identityId : null })
  return writeRepoDoc(sdk, auth, repo, DOC.event, data, input.intent)
}

/** A list row as {@link hiddenThreadIds} reads it. */
export interface HideableRow {
  readonly id: string
  readonly author: string
  readonly threadHides?: readonly Event[]
}

/**
 * The rows of a list page whose thread a maintainer hid (lists leave them out behind a toggle),
 * with who hid each and why (a revealed row says so, QW4-038). Reads the contract's proof and the
 * members only when a row holds a hide (a failed read counts the owner's and current maintainers'
 * hides, and no members: the owner's alone).
 */
export async function hiddenThreadIds(sdk: EvoSDK, repo: RepoRef, network: Network, rows: readonly HideableRow[]): Promise<ReadonlyMap<string, Hidden>> {
  if (!rows.some((r) => (r.threadHides?.length ?? 0) > 0)) return new Map()
  const [proved, members] = await Promise.all([hidesProved(sdk, repo).catch(() => false), readMembershipsCached(sdk, repo, network).catch((): Membership[] => [])])
  return hiddenRowIds(rows, repo.ownerId, members, proved)
}

/**
 * The rows whose thread is hidden, judged with `members` and `proved` (pure). A list shows this
 * with `proved` assumed (every hide counts, as on a registration with the proof) until the read of
 * the contract and the members lands, so a hidden spam row never flashes into the list.
 */
export function hiddenRowIds(rows: readonly HideableRow[], owner: string, members: readonly Membership[], proved: boolean): ReadonlyMap<string, Hidden> {
  const out = new Map<string, Hidden>()
  for (const r of rows) {
    if ((r.threadHides?.length ?? 0) === 0) continue
    const m = threadModeration({ events: r.threadHides ?? [], thread: { id: r.id, author: r.author }, owner, members, proved, comments: [] })
    if (m.thread !== null) out.set(r.id, m.thread)
  }
  return out
}

export { hasHides, threadHidesOf, threadModeration } from './moderation-fold'
