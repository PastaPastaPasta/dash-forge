/**
 * Refs this tab moved (a browser merge), per repo, until a read of the repo's refs shows them.
 * A DAPI node a block behind still answers with the old tip: a repo home read from it right after
 * the merge would put the pre-merge tip back on the Code tab (L-09). The home loader re-reads
 * while {@link showsOwnRefMoves} is false.
 *
 * An expectation lapses after {@link OWN_MOVE_WAIT_MS}: by then another writer may well have
 * moved the ref again, and its tip is the truth.
 */

import { onRepoContentWritten, type RepoRef, type ResolvedRef } from '../repo'
import { tipOidOf } from './refs'

export const OWN_MOVE_WAIT_MS = 60_000

const expected = new Map<string, Map<string, { readonly oid: string; readonly until: number }>>()

onRepoContentWritten((repo, moved) => {
  if (moved === undefined) return
  const tips = expected.get(repo.repoId) ?? new Map()
  tips.set(moved.refName, { oid: moved.newOid, until: Date.now() + OWN_MOVE_WAIT_MS })
  expected.set(repo.repoId, tips)
})

/** Whether this tab waits for any ref move to show. */
export function awaitingOwnRefMoves(): boolean {
  return expected.size > 0
}

/**
 * Whether `refs` of `repo` show every ref move this tab made there (a deleted ref: absent).
 * Moves shown, or lapsed, are forgotten.
 */
export function showsOwnRefMoves(repo: RepoRef, refs: readonly ResolvedRef[]): boolean {
  const tips = expected.get(repo.repoId)
  if (tips === undefined) return true
  for (const [refName, { oid, until }] of tips) {
    const ref = refs.find((r) => r.refName === refName)
    const shown = ref === undefined ? /^0+$/.test(oid) : tipOidOf(ref) === oid
    if (shown || Date.now() > until) tips.delete(refName)
  }
  if (tips.size === 0) expected.delete(repo.repoId)
  return tips.size === 0
}

/** Test hook: forget every expectation. */
export function resetOwnRefMoves(): void {
  expected.clear()
}
