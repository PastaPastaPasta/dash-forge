/**
 * Ref resolution — fold a ref's refUpdate/protectedRefUpdate history into a RefState.
 *
 * Ports `resolve_ref` (+ `is_update_valid`, `config_as_of`) from
 * `crates/forge-core/src/rules.rs`, byte-for-byte behaviorally. Implements
 * data-contracts §4 protected-ref routing plus the §2.3 same-`prevOid` divergence rule,
 * with the prevOid causal DAG authoritative over the `(createdAt, id)` clock.
 */

import { matchesProtected } from './matchesProtected'
import { compareKey, isContentHash, isLegalRefName, isNullOid, refNameHashMatches } from './oid'
import type { ConfigDoc, IsAncestor, RefHead, RefState, RefUpdate } from './types'

/** The `config` in force at time `at`: newest config with `createdAt <= at` (tie: greatest id). */
function configAsOf(configHistory: readonly ConfigDoc[], at: number): ConfigDoc | undefined {
  let best: ConfigDoc | undefined
  for (const c of configHistory) {
    if (c.createdAt > at) continue
    if (best === undefined || compareKey(c, best) > 0) best = c
  }
  return best
}

/** The as-of-time protection check from §4: is update `u` a valid mover of its ref? */
function isUpdateValid(u: RefUpdate, configHistory: readonly ConfigDoc[]): boolean {
  // (0) Injection / key-decoupling defense: an illegal refName is inert, and — when a
  // real 32-byte refNameHash is present — it MUST be sha256(refName).
  if (!isLegalRefName(u.refName)) return false
  if (isContentHash(u.refNameHash) && !refNameHashMatches(u.refName, u.refNameHash)) {
    return false
  }

  const cfg = configAsOf(configHistory, u.createdAt)
  if (cfg === undefined) return true // no config in force → nothing protected → valid.
  if (matchesProtected(u.refName, cfg.protectedPatterns ?? [])) {
    // Protected ref: only a MAINTAIN-gated protectedRefUpdate moves it.
    return u.protected === true
  }
  // Unprotected: either type is fine.
  return true
}

/**
 * Fold a ref's update history into its {@link RefState}.
 *
 * `updates` may contain updates for *other* refs; only those whose `refNameHash` equals
 * `refNameHash` participate. `configHistory` is the repo's full config timeline.
 * `isAncestor(a, b)` reports whether commit `a` is an ancestor of (or equal to) `b`.
 */
export function resolveRef(
  updates: readonly RefUpdate[],
  configHistory: readonly ConfigDoc[],
  refNameHash: string,
  isAncestor: IsAncestor,
): RefState {
  // (1) validity filter, keeping only this ref's updates.
  const valid = updates.filter(
    (u) => u.refNameHash === refNameHash && isUpdateValid(u, configHistory),
  )

  // (2) order ascending by (createdAt, id).
  valid.sort(compareKey)

  // (3) unborn / deleted.
  const newest = valid[valid.length - 1]
  if (newest === undefined) return { state: 'unborn' }
  if (isNullOid(newest.newOid)) return { state: 'unborn' }

  // (4) live heads.
  const newerSupersedes = (u: RefUpdate, v: RefUpdate): boolean => {
    // A direct prevOid chain (`v.prevOid == u.newOid`) is an unambiguous causal "v after
    // u" — independent of the (createdAt, id) clock, repairing the all-zero-timestamp case.
    if (!isNullOid(v.prevOid) && v.prevOid === u.newOid && v.newOid !== u.newOid) {
      return true
    }
    // Conversely, if `u` chained off `v`, `u` is a causal descendant — `v` NEVER supersedes.
    if (!isNullOid(u.prevOid) && u.prevOid === v.newOid && u.newOid !== v.newOid) {
      return false
    }

    // Remaining conditions carry no causal proof → gate on `v` strictly newer by (createdAt, id).
    if (compareKey(v, u) <= 0) return false
    if (isNullOid(v.newOid) || v.force === true) return true
    return isAncestor(u.newOid, v.newOid)
  }

  const heads: RefHead[] = []
  for (const u of valid) {
    if (isNullOid(u.newOid)) continue
    if (valid.some((v) => newerSupersedes(u, v))) continue
    const candidate: RefHead = {
      id: u.id,
      oid: u.newOid,
      author: u.author,
      createdAt: u.createdAt,
    }
    // Deduplicate by tip, keeping the newest occurrence by (createdAt, id).
    const existingIdx = heads.findIndex((h) => h.oid === candidate.oid)
    if (existingIdx >= 0) {
      const existing = heads[existingIdx] as RefHead
      if (compareKey(candidate, existing) > 0) heads[existingIdx] = candidate
    } else {
      heads.push(candidate)
    }
  }

  // (5) resolve.
  if (heads.length === 0) return { state: 'unborn' } // unreachable given (3), but total.
  if (heads.length === 1) {
    const h = heads[0] as RefHead
    return { state: 'resolved', oid: h.oid, author: h.author, createdAt: h.createdAt }
  }
  // Newest-first by (createdAt, id): heads[0] is the provisional read-only tip (§2.3).
  heads.sort((a, b) => compareKey(b, a))
  return { state: 'diverged', heads }
}
