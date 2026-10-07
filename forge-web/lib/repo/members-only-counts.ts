/**
 * How many of a repo's issues and PRs are members-only, once a list has read every one of them
 * (DESIGN §4.1: a count that includes members-only items is labelled, "Issues 3 (1 members-only)").
 * The same for every reader: a members-only issue or PR is a row for everyone (D14), readable or
 * not. In this tab's memory only; a write to the repo drops it with the list that counted it.
 */

import { onRepoInvalidated } from './issues'
import type { RepoRef } from './contract'

/** Members-only rows of one type by state. */
export interface MembersOnlyCount {
  readonly open: number
  readonly closed: number
}

const counts = new Map<string, MembersOnlyCount>()
const listeners = new Set<() => void>()

const keyOf = (repo: Pick<RepoRef, 'repoId'>, type: 'issue' | 'patch'): string => `${repo.repoId}:${type}`

onRepoInvalidated((repo) => {
  let changed = false
  for (const type of ['issue', 'patch'] as const) changed = counts.delete(keyOf(repo, type)) || changed
  if (changed) for (const l of listeners) l()
})

/** The rows' members-only counts by state (the rows are every row of the type). */
export function countMembersOnly(rows: Iterable<{ readonly audience?: 'members'; readonly state: { readonly open: boolean } }>): MembersOnlyCount {
  let open = 0
  let closed = 0
  for (const r of rows) {
    if (r.audience !== 'members') continue
    if (r.state.open) open++
    else closed++
  }
  return { open, closed }
}

/** Record `count` for `repo`'s `type` (a list read every row). */
export function noteMembersOnly(repo: Pick<RepoRef, 'repoId'>, type: 'issue' | 'patch', count: MembersOnlyCount): void {
  const key = keyOf(repo, type)
  const was = counts.get(key)
  if (was?.open === count.open && was.closed === count.closed) return
  counts.set(key, count)
  for (const l of listeners) l()
}

/** What is known of `repo`'s members-only `type`, or null (no list read them all yet). */
export function membersOnlyOf(repo: Pick<RepoRef, 'repoId'>, type: 'issue' | 'patch'): MembersOnlyCount | null {
  return counts.get(keyOf(repo, type)) ?? null
}

/** Be told when a count changes. */
export function onMembersOnlyCounts(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
