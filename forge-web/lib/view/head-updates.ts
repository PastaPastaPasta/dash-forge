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
import type { HeadUpdate } from '../rules/review'
import type { ObjectReader } from './tree-nav'
import { plural } from './format'

/** Commits a phrase walk reads per update before it falls back to the plain wording. */
const WALK_CAP = 500

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
        // The old head is in the new one's history when walking it back from the new head
        // finds nothing new.
        const descends = (await newCommits(reader, prev, [u.oid], WALK_CAP)).length === 0
        const n = plural(added.length, 'commit')
        phrase =
          other === null
            ? { text: descends ? `pushed ${n} ${arrow}` : `force-pushed ${arrow}` }
            : descends
              ? { text: `updated the head with ${n} ${arrow} pushed by`, who: other }
              : { text: `updated the head ${arrow}, force-pushed by`, who: other }
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
