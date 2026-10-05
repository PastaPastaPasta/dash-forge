/**
 * A ref's activity (epic E5): every update that moved one branch or tag, and every config change
 * that protected it or lifted its protection, oldest first. The ref's Activity page shows it, as
 * `dg repo activity` does.
 *
 * Only valid updates appear ({@link validRefUpdates}: a plain update on a ref protected as of
 * its `createdAt` moved nothing), in the causal order {@link resolveRef} folds them in. An
 * update's `from` is the tip the walk holds before it, never the writer's own `prevOid`, so a
 * pusher cannot make a force-push read as a fast-forward by naming another parent. An update
 * that leaves the tip where it was is no change and is left out.
 *
 * `contains(old, new)` answers whether commit `new` contains commit `old` (`null`: unknown within
 * the caller's budget). A branch move reads `pushed`, `forcePushed` or `updated` (unknown); a tag
 * that names another object reads `moved` whatever the graph says.
 *
 * Protection follows the config in force: configs sharing a `createdAt` take effect together (the
 * greatest `id` wins), and a config change comes before the updates of its block, which it judged.
 *
 * Parity: forge-core `rules::ref_history` (vectors `ref_history__*`).
 */

import { matchesProtected } from './matchesProtected'
import { compareKey, isNullOid } from './oid'
import { validRefUpdates } from './resolveRef'
import type { ConfigDoc, RefUpdate } from './types'

/** What one entry of a ref's activity did. */
export type RefEventKind =
  | 'created'
  | 'pushed'
  | 'forcePushed'
  | 'updated'
  | 'moved'
  | 'deleted'
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

/** A config change rather than an update. */
export function isProtectionEvent(e: RefEvent): boolean {
  return e.kind === 'protectionAdded' || e.kind === 'protectionLifted' || e.kind === 'protectionRestored'
}

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
  let tip: string | null = null
  for (const u of validRefUpdates(updates, configs, refNameHash)) {
    const to = isNullOid(u.newOid) ? null : u.newOid
    if (to === tip) continue
    let kind: RefEventKind
    if (tip === null) kind = 'created'
    else if (to === null) kind = 'deleted'
    else if (isTag) kind = 'moved'
    else {
      const c = contains(tip, to)
      kind = c === true ? 'pushed' : c === false ? 'forcePushed' : 'updated'
    }
    moves.push({ kind, id: u.id, at: u.createdAt, by: u.author, from: tip, to })
    tip = to
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

/** The `[old, new]` pairs of `events` whose ancestry decides their kind (branch moves). */
export function ancestryQuestions(events: readonly RefEvent[]): [string, string][] {
  return events.filter((e) => e.kind === 'pushed' || e.kind === 'forcePushed' || e.kind === 'updated').map((e) => [e.from as string, e.to as string])
}
