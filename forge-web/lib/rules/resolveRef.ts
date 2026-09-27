/**
 * Ref resolution — fold a ref's refUpdate/protectedRefUpdate history into a RefState.
 *
 * Ports `resolve_ref` (+ `is_update_valid`, `config_as_of`) from
 * `crates/forge-core/src/rules.rs`, byte-for-byte behaviorally. Implements
 * protected-ref routing (`forge-v2.md` §2, §6) plus the same-`prevOid` divergence rule. Updates
 * are folded in consensus-clock order, with the prevOid chain ordering updates within one
 * block (see forge-core `resolve_ref` for why the clock must come first: D-600).
 */

import { matchesProtected } from './matchesProtected'
import { compareKey, isContentHash, isLegalRefName, isNullOid, refNameHashMatches } from './oid'
import type { ConfigDoc, IsAncestor, MergeBaseTips, RefHead, RefState, RefUpdate } from './types'

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

/** The valid updates of the ref keyed `refNameHash` in the causal order: steps 1–2 of {@link resolveRef}. */
function validUpdates(updates: readonly RefUpdate[], configHistory: readonly ConfigDoc[], refNameHash: string): RefUpdate[] {
  return causalOrder(updates.filter((u) => u.refNameHash === refNameHash && isUpdateValid(u, configHistory)))
}

/** Whether `v` recorded `u`'s tip as its `prevOid` and moved the ref somewhere else. */
function buildsOn(v: RefUpdate, u: RefUpdate): boolean {
  return !isNullOid(v.prevOid) && v.prevOid === u.newOid && v.newOid !== u.newOid
}

/** Whether unplaced `block[start]` builds, through unplaced updates, on itself. Parity: `on_cycle`. */
function onCycle(block: readonly RefUpdate[], placed: readonly boolean[], start: number): boolean {
  const seen = block.map(() => false)
  const stack = [start]
  for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
    for (let u = 0; u < block.length; u++) {
      if (placed[u] || !buildsOn(block[v] as RefUpdate, block[u] as RefUpdate)) continue
      if (u === start) return true
      if (!seen[u]) {
        seen[u] = true
        stack.push(u)
      }
    }
  }
  return false
}

/**
 * The causal order {@link resolveRef} folds in: ascending `createdAt`; within one `createdAt`
 * (one block) an update that builds on another comes after it; remaining ties, and chain
 * cycles, by ascending `id`. Within a block: Kahn's sort taking the smallest-`id` unplaced
 * update that builds on no other unplaced one, else (every one waits on a cycle) the
 * smallest-`id` unplaced one that lies on a cycle, never one merely downstream of it.
 * Parity: forge-core `rules::causal_order`.
 */
function causalOrder(updates: readonly RefUpdate[]): RefUpdate[] {
  const sorted = [...updates].sort(compareKey)
  const out: RefUpdate[] = []
  for (let start = 0; start < sorted.length; ) {
    let end = start
    while (end < sorted.length && (sorted[end] as RefUpdate).createdAt === (sorted[start] as RefUpdate).createdAt) end++
    const block = sorted.slice(start, end)
    // How many unplaced updates of the block each builds on (never itself: a different tip).
    const waiting = block.map((v) => block.filter((u) => buildsOn(v, u)).length)
    const placed = block.map(() => false)
    for (let n = 0; n < block.length; n++) {
      let next = block.findIndex((_, i) => !placed[i] && waiting[i] === 0)
      if (next < 0) next = block.findIndex((_, i) => !placed[i] && onCycle(block, placed, i))
      placed[next] = true
      const u = block[next] as RefUpdate
      out.push(u)
      block.forEach((v, i) => {
        if (!placed[i] && buildsOn(v, u)) waiting[i] = (waiting[i] as number) - 1
      })
    }
    start = end
  }
  return out
}

/**
 * The base-ref history a PR merge is verified against (§4 routing, §6 merge reachability);
 * ports `merge_base_tips` in `crates/forge-core/src/rules.rs` (vectors `merge_base_tips__*`).
 *
 * Only a VALID update moves a ref ({@link resolveRef} step 1): a legal name that hashes to
 * its key, and on a ref protected by the config in force when it was written, the
 * MAINTAIN-gated `protectedRefUpdate` type. A plain `refUpdate` naming a protected ref is
 * inert, so the commit it names was never on the branch, and a merge event naming it must
 * not count. The fold takes `tip` as the base tip and membership in `historical` as the
 * ancestry predicate (`historicalTipsPredicate` in `lib/repo/issues.ts`).
 */
export function mergeBaseTips(
  updates: readonly RefUpdate[],
  configHistory: readonly ConfigDoc[],
  refNameHash: string,
): MergeBaseTips {
  const valid = validUpdates(updates, configHistory, refNameHash)
  const historical: string[] = []
  for (const u of valid) {
    if (!isNullOid(u.newOid) && !historical.includes(u.newOid)) historical.push(u.newOid)
  }
  const newestTip = valid.findLast((u) => !isNullOid(u.newOid))
  const newest = valid.at(-1)
  return {
    historical,
    tip: newestTip?.newOid ?? null,
    current: newest === undefined || isNullOid(newest.newOid) ? null : newest.newOid,
  }
}

/**
 * The base history a PR opened at `openedAt` (its `$createdAt`) is folded against: the PR's
 * base must have been a branch when the PR was opened (D-501). {@link mergeBaseTips}, except
 * that when the base had no valid tip at `openedAt` (never created, or deleted then)
 * `historical` is empty and `tip` null, so no merge event counts, whatever is pushed to that
 * name later; `current` is kept. Updates at exactly `openedAt` count as before it.
 * Parity: forge-core `rules::pr_base_tips` (vectors `pr_base_tips__*`).
 */
export function prBaseTips(
  updates: readonly RefUpdate[],
  configHistory: readonly ConfigDoc[],
  refNameHash: string,
  openedAt: number,
): MergeBaseTips {
  const tips = mergeBaseTips(updates, configHistory, refNameHash)
  const before = mergeBaseTips(
    updates.filter((u) => u.createdAt <= openedAt),
    configHistory,
    refNameHash,
  )
  return before.current !== null ? tips : { ...tips, historical: [], tip: null }
}

/**
 * The name to DISPLAY for the ref keyed by `refNameHashHex`: the `refName` of the newest
 * update (on the `(createdAt, id)` total order) whose name actually hashes to that key.
 *
 * A shared rule, not a reader convenience, because the two halves of a ref document are
 * trusted differently: `refNameHash` is the indexed key, while `refName` is caller-supplied
 * content. A writer may therefore file an update under `main`'s hash carrying any legal
 * name. {@link resolveRef} already ignores such an update when resolving the tip, so a client
 * that named the ref from it would show a different branch name for the same ref than a
 * client that did not. Parity: forge-core `rules::display_ref_name`.
 *
 * `undefined` when no update carries a name matching the key.
 */
export function displayRefName(
  updates: readonly RefUpdate[],
  refNameHashHex: string,
): string | undefined {
  const named = updates
    .filter((u) => u.refNameHash === refNameHashHex && refNameHashMatches(u.refName, refNameHashHex))
    .sort(compareKey)
  return named[named.length - 1]?.refName
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
  // (1) validity filter, keeping only this ref's updates; (2) the causal order.
  const valid = validUpdates(updates, configHistory, refNameHash)

  // (3) unborn / deleted.
  const newest = valid[valid.length - 1]
  if (newest === undefined) return { state: 'unborn' }
  if (isNullOid(newest.newOid)) return { state: 'unborn' }

  // (4) live heads: `v` (later in the causal order) supersedes `u`.
  const supersedes = (u: RefUpdate, v: RefUpdate): boolean =>
    isNullOid(v.newOid) || v.force === true || buildsOn(v, u) || isAncestor(u.newOid, v.newOid)

  // Heads newest-first: walking the causal order backwards, the first occurrence of a tip is
  // its newest, and a later duplicate of the same tip is one head, not two.
  const heads: RefHead[] = []
  for (let i = valid.length - 1; i >= 0; i--) {
    const u = valid[i] as RefUpdate
    if (isNullOid(u.newOid) || heads.some((h) => h.oid === u.newOid)) continue
    let superseded = false
    for (let j = i + 1; j < valid.length && !superseded; j++) superseded = supersedes(u, valid[j] as RefUpdate)
    if (superseded) continue
    heads.push({ id: u.id, oid: u.newOid, author: u.author, createdAt: u.createdAt })
  }

  // (5) resolve. heads[0] is the provisional read-only tip of a diverged ref.
  if (heads.length === 0) return { state: 'unborn' } // unreachable given (3), but total.
  if (heads.length === 1) {
    const h = heads[0] as RefHead
    return { state: 'resolved', oid: h.oid, author: h.author, createdAt: h.createdAt }
  }
  return { state: 'diverged', heads }
}
