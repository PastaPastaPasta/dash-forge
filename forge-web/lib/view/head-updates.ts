/**
 * How the PR timeline words a head update (review-parity §4.6): "pushed 3 commits
 * (abc1234 → def5678)" when the new head descends from the previous one, "force-pushed
 * (abc1234 → def5678)" when it does not, and "moved the head to def5678" when the commits cannot
 * be read. Pure over an {@link ObjectReader}.
 *
 * Who posted the head update is not always who pushed (QW3-048): the author or a maintainer
 * "Update PR head"s to commits someone else pushed to the branch. When the branch's ref updates
 * name another pusher of the new head, the words say so: "updated the head with 1 commit
 * (abc1234 → def5678) pushed by" that identity.
 */

import { newCommits } from '../merge/objects'
import { parseCommit } from './git-objects'
import type { HeadUpdate } from '../rules/review'
import type { ObjectReader } from './tree-nav'
import { plural } from './format'

/** Commits a phrase walk reads per update before it falls back to the plain wording. */
const WALK_CAP = 500

/**
 * Whether commit `next` contains commit `old` (`old` is `next` or one of its ancestors): a push,
 * not a force-push. Exact, whatever the commit dates say: a breadth-first search of `next`'s
 * ancestry for `old`. True when found; false when `next`'s whole history was read without it;
 * null when `cap` commits were read first (or `budget.left`, a total shared by several checks, ran
 * out), or a commit cannot be read. The PR timeline and a branch's Activity page both decide
 * "force-pushed" with it.
 */
export async function tipContains(reader: ObjectReader, old: string, next: string, cap = WALK_CAP, budget?: { left: number }): Promise<boolean | null> {
  if (old === next) return true
  const seen = new Set<string>([next])
  const queue = [next]
  try {
    for (let i = 0; i < queue.length; i++) {
      if (i >= cap) return null
      if (budget !== undefined) {
        if (budget.left <= 0) return null
        budget.left--
      }
      const obj = await reader.readObject(queue[i] as string)
      if (obj.type !== 'commit') return null
      for (const p of parseCommit(obj.bytes).parents) {
        if (p === old) return true
        if (!seen.has(p)) {
          seen.add(p)
          queue.push(p)
        }
      }
    }
    return false
  } catch {
    return null
  }
}

/** A head update's words; `who`, when set, is the identity the words end with ("pushed by …"). */
export interface HeadUpdatePhrase {
  readonly text: string
  readonly who?: string
}

/**
 * The words for each head update, by its event id. `pushers` maps a commit to the identity whose
 * ref update first set the PR's source branch to it ({@link firstPushers}); empty: unknown.
 * `base`, when given, is a base commit the PR is compared with: commits it already has (the base
 * commits an "Update branch" merge brings in) are not counted as pushed.
 */
export async function headUpdatePhrases(
  reader: ObjectReader,
  initialHead: string,
  updates: readonly HeadUpdate[],
  pushers: ReadonlyMap<string, string> = new Map(),
  base = '',
): Promise<Map<string, HeadUpdatePhrase>> {
  const out = new Map<string, HeadUpdatePhrase>()
  let prev = initialHead
  for (const u of updates) {
    const arrow = `(${prev.slice(0, 7)} → ${u.oid.slice(0, 7)})`
    const pusher = pushers.get(u.oid.toLowerCase())
    const other = pusher !== undefined && pusher !== u.actor ? pusher : null
    let phrase: HeadUpdatePhrase = other === null ? { text: `moved the head to ${u.oid.slice(0, 7)}` } : { text: `moved the head to ${u.oid.slice(0, 7)}, pushed by`, who: other }
    try {
      if (prev === u.oid) phrase = { text: `re-posted the head ${u.oid.slice(0, 7)}` }
      else if (prev !== '') {
        // Without the base when its history is too long to walk past (the plain count then).
        const added = await (base === '' ? newCommits(reader, u.oid, [prev], WALK_CAP) : newCommits(reader, u.oid, [prev, base], WALK_CAP).catch(() => newCommits(reader, u.oid, [prev], WALK_CAP)))
        const descends = await tipContains(reader, prev, u.oid)
        const n = plural(added.length, 'commit')
        if (descends !== null) {
          phrase =
            other === null
              ? { text: descends ? `pushed ${n} ${arrow}` : `force-pushed ${arrow}` }
              : descends
                ? { text: `updated the head with ${n} ${arrow} pushed by`, who: other }
                : { text: `updated the head ${arrow}, force-pushed by`, who: other }
        }
      }
    } catch {
      // An unreadable commit or a history past the cap: keep the plain wording.
    }
    out.set(u.id, phrase)
    prev = u.oid
  }
  return out
}

/**
 * Who first set a branch to each commit: `updates` are the branch's ref updates (any order); a
 * commit maps to the author of the earliest update (by `createdAt`, then id) naming it. A
 * deletion (a null oid) names no commit.
 */
export function firstPushers(updates: readonly { readonly id: string; readonly newOid: string; readonly author: string; readonly createdAt: number }[]): Map<string, string> {
  const out = new Map<string, string>()
  const sorted = [...updates].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const u of sorted) {
    const oid = u.newOid.toLowerCase()
    if (/^0+$/.test(oid) || out.has(oid)) continue
    out.set(oid, u.author)
  }
  return out
}

/** A PR's source branch deleted or restored, as its timeline shows it (QW4-025). */
export interface SourceBranchEvent {
  readonly id: string
  readonly actor: string
  readonly at: number
  readonly kind: 'deleted' | 'restored'
  readonly branch: string
}

/**
 * When the PR's source branch `refName` was deleted from the PR's head and restored at it, from
 * the branch's ref updates (GitHub's "deleted the feature branch" and "restored"), at or after
 * `since` (the PR's creation: an earlier branch of the same name is not this PR's). A delete counts
 * when it removed the PR's head (`prevOid`, which the page's and dg's deletes record); a restore
 * when it points the deleted branch at the head again. A push of other commits to the name is a
 * new branch, not a restore, and ends the tracking.
 */
export function sourceBranchEvents(
  updates: readonly { readonly id: string; readonly newOid: string; readonly prevOid?: string | null; readonly author: string; readonly createdAt: number }[],
  refName: string,
  headOid: string,
  since: number,
): SourceBranchEvent[] {
  const head = headOid.toLowerCase()
  const branch = refName.replace(/^refs\/heads\//, '')
  const isZero = (oid: string): boolean => oid === '' || /^0+$/.test(oid)
  const sorted = [...updates].filter((u) => u.createdAt >= since).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out: SourceBranchEvent[] = []
  let deleted = false
  // Updates of one block share a `createdAt`; their real order is their `prevOid` chain, not their
  // ids: within a block, take next the update that follows from the state so far (a delete while
  // the branch exists, anything else once it is deleted).
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j < sorted.length && sorted[j]!.createdAt === sorted[i]!.createdAt) j++
    const block = sorted.slice(i, j)
    while (block.length > 0) {
      const k = Math.max(0, block.findIndex((u) => isZero(u.newOid.toLowerCase()) !== deleted))
      const u = block.splice(k, 1)[0]!
      const to = u.newOid.toLowerCase()
      if (isZero(to) && !deleted) {
        const from = (u.prevOid ?? '').toLowerCase()
        if (from === '' || from === head) {
          out.push({ id: u.id, actor: u.author, at: u.createdAt, kind: 'deleted', branch })
          deleted = true
        }
      } else if (!isZero(to) && deleted) {
        if (to === head) out.push({ id: u.id, actor: u.author, at: u.createdAt, kind: 'restored', branch })
        deleted = false
      }
    }
    i = j
  }
  return out
}
