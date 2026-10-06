/**
 * A ref's activity (epic E5): every update that moved one branch or tag, and every config change
 * that protected it or lifted its protection, oldest first. The ref's Activity page shows it, as
 * `dg repo activity` does.
 *
 * Only valid updates appear ({@link validRefUpdates}: a plain update on a ref protected as of
 * its `createdAt` moved nothing), in the causal order {@link resolveRef} folds them in, tracking
 * the live heads as the fold does: a later update supersedes a head when it is forced, builds on
 * it (its `prevOid` names it) or contains it. An update's `from` is the head it supersedes.
 *
 * `contains(old, new)` answers whether commit `new` contains commit `old` (`null`: unknown within
 * the caller's budget). A branch move reads `pushed` when every head it supersedes is contained,
 * `forcePushed` when it supersedes (forced, or building on it) a head it does not contain, and
 * `updated` when that is unknown. One that supersedes no head reads `diverged` (two tips race, as
 * the fold reads it). A tag that names another object reads `moved` whatever the graph says. An
 * update that sets the tip the ref already holds alone is left out.
 *
 * Protection follows the config in force: configs sharing a `createdAt` take effect together (the
 * greatest `id` wins), and a config change comes before the updates of its block, which it judged.
 *
 * Parity: forge-core `rules::ref_history` (vectors `ref_history__*`).
 */

import { matchesProtected } from './matchesProtected'
import { compareKey, isNullOid } from './oid'
import { buildsOn, validRefUpdates } from './resolveRef'
import type { ConfigDoc, RefUpdate } from './types'

/** What one entry of a ref's activity did. */
export type RefEventKind =
  | 'created'
  | 'pushed'
  | 'forcePushed'
  | 'updated'
  | 'moved'
  | 'deleted'
  | 'diverged'
  | 'protectionAdded'
  | 'protectionLifted'
  | 'protectionRestored'

/** One entry of a ref's activity. */
export interface RefEvent {
  readonly kind: RefEventKind
  /** The update's `$id`, or the config's (the one in force after the change). */
  readonly id: string
  /** Its `createdAt` (ms). */
  readonly at: number
  /** The update's pusher; null for a config change (the caller knows its writer). */
  readonly by: string | null
  /** The tip before an update; null when the ref did not exist, and for a config change. */
  readonly from: string | null
  /** The tip an update set; null for a deletion and a config change. */
  readonly to: string | null
}

/** Whether `new` contains `old`; null when unknown. */
export type Contains = (old: string, next: string) => boolean | null

/** The activity of the ref `refName` (keyed `refNameHash`, hex), oldest first. */
export function refHistory(
  refName: string,
  refNameHash: string,
  updates: readonly RefUpdate[],
  configs: readonly ConfigDoc[],
  contains: Contains,
): RefEvent[] {
  const isTag = refName.startsWith('refs/tags/')
  const moves: RefEvent[] = []
  // The live heads, oldest first.
  let heads: RefUpdate[] = []
  for (const v of validRefUpdates(updates, configs, refNameHash)) {
    const event = (kind: RefEventKind, from: string | null, to: string | null): RefEvent => ({ kind, id: v.id, at: v.createdAt, by: v.author, from, to })
    if (isNullOid(v.newOid)) {
      const last = heads[heads.length - 1]
      if (last !== undefined) moves.push(event('deleted', last.newOid, null))
      heads = []
      continue
    }
    const newest = heads[heads.length - 1]
    if (newest === undefined) {
      moves.push(event('created', null, v.newOid))
      heads = [v]
      continue
    }
    // The same tip again: that head is v's now; any other head it also supersedes goes.
    const same = heads.some((h) => h.newOid === v.newOid)
    const superseded: { readonly h: RefUpdate; readonly has: boolean | null }[] = []
    const kept: RefUpdate[] = []
    for (const h of heads) {
      if (h.newOid === v.newOid) continue
      const has = contains(h.newOid, v.newOid)
      if (v.force || buildsOn(v, h) || has === true) superseded.push({ h, has })
      else kept.push(h)
    }
    heads = [...kept, v]
    if (superseded.length === 0) {
      if (!same) moves.push(event('diverged', newest.newOid, v.newOid))
      continue
    }
    const from = (superseded[superseded.length - 1] as { readonly h: RefUpdate }).h.newOid
    const kind: RefEventKind = isTag
      ? 'moved'
      : superseded.some((x) => x.has === false)
        ? 'forcePushed'
        : superseded.every((x) => x.has === true)
          ? 'pushed'
          : 'updated'
    moves.push(event(kind, from, v.newOid))
  }

  const sorted = [...configs].sort(compareKey)
  const protection: RefEvent[] = []
  let now = false
  let ever = false
  sorted.forEach((c, i) => {
    if (sorted[i + 1]?.createdAt === c.createdAt) return
    const protects = matchesProtected(refName, c.protectedPatterns ?? [])
    if (protects === now) return
    const kind: RefEventKind = !protects ? 'protectionLifted' : ever ? 'protectionRestored' : 'protectionAdded'
    protection.push({ kind, id: c.id ?? '', at: c.createdAt, by: null, from: null, to: null })
    now = protects
    ever ||= protects
  })

  const out: RefEvent[] = []
  let m = 0
  let p = 0
  while (m < moves.length || p < protection.length) {
    const u = moves[m]
    const c = protection[p]
    if (c !== undefined && (u === undefined || c.at <= u.at)) {
      out.push(c)
      p++
    } else if (u !== undefined) {
      out.push(u)
      m++
    }
  }
  return out
}
