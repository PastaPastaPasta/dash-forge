/**
 * Membership changes made through this tab, for caches that depend on who holds a role (a
 * module of its own, so a cache can listen without importing `./members`).
 */

import type { RepoRef } from './contract'

const listeners = new Set<(repo: RepoRef) => void>()

/** Call `f` whenever a repo's membership changes through this tab (`invalidateMembers`). */
export function onMembersInvalidated(f: (repo: RepoRef) => void): void {
  listeners.add(f)
}

/** Tell every listener that `repo`'s membership changed. */
export function membersInvalidated(repo: RepoRef): void {
  for (const f of listeners) f(repo)
}
