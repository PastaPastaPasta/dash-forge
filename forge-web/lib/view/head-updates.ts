/**
 * How the PR timeline words a head update (review-parity §4.6): "pushed 3 commits
 * (abc1234 → def5678)" when the new head descends from the previous one, "force-pushed
 * (abc1234 → def5678)" when it does not, and "moved the head to def5678" when the commits cannot
 * be read. Pure over an {@link ObjectReader}.
 */

import { newCommits } from '../merge/objects'
import type { HeadUpdate } from '../rules/review'
import type { ObjectReader } from './tree-nav'
import { plural } from './format'

/** Commits a phrase walk reads per update before it falls back to the plain wording. */
const WALK_CAP = 500

/** The words for each head update, by its event id. */
export async function headUpdatePhrases(
  reader: ObjectReader,
  initialHead: string,
  updates: readonly HeadUpdate[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let prev = initialHead
  for (const u of updates) {
    const arrow = `(${prev.slice(0, 7)} → ${u.oid.slice(0, 7)})`
    let text = `moved the head to ${u.oid.slice(0, 7)}`
    try {
      if (prev === u.oid) text = `re-posted the head ${u.oid.slice(0, 7)}`
      else if (prev !== '') {
        const added = await newCommits(reader, u.oid, [prev], WALK_CAP)
        // The old head is in the new one's history when walking it back from the new head
        // finds nothing new.
        const descends = (await newCommits(reader, prev, [u.oid], WALK_CAP)).length === 0
        text = descends ? `pushed ${plural(added.length, 'commit')} ${arrow}` : `force-pushed ${arrow}`
      }
    } catch {
      // An unreadable commit or a history past the cap: keep the plain wording.
    }
    out.set(u.id, text)
    prev = u.oid
  }
  return out
}
