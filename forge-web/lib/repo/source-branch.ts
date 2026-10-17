/**
 * A PR's source branch (review-parity R14, §4.6): where `sourceRefName` points in the source repo
 * now, so the PR page can say "Your branch is ahead of this PR — Update PR head". Resolved the way
 * every other view resolves a ref (`resolveRefByHash` over the complete update history and the
 * config timeline).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { isPlainBranchRef, type RefState, type RefUpdate } from '../rules'
import { bytesToBase64 } from '../sdk'
import type { RepoRef } from './contract'
import { refNameHash } from './push'
import { readRefNow } from './ref-admin'
import { readRefUpdates } from './refs'

/**
 * The branch's resolved state, or null when it cannot be known from here: not a plain branch
 * (an imported PR's `refs/mirror/pull/<n>/head`), a private repo (its ref names are keyed hashes
 * this reader cannot form), or no update was ever recorded for it.
 */
export async function readBranchState(sdk: EvoSDK, repo: RepoRef, refName: string): Promise<RefState | null> {
  if (!isPlainBranchRef(refName) || repo.visibility === 'private') return null
  return (await readRefNow(sdk, repo, refName)).state
}

/**
 * The branch's ref updates (both types), for who pushed what (QW3-048); empty when they cannot be
 * read from here, as {@link readBranchState}. Only updates naming this very ref are kept.
 */
export async function readBranchUpdates(sdk: EvoSDK, repo: RepoRef, refName: string): Promise<RefUpdate[]> {
  if (!isPlainBranchRef(refName) || repo.visibility === 'private') return []
  return (await readRefUpdates(sdk, repo, bytesToBase64(refNameHash(refName)))).filter((u) => u.refName === refName)
}

/** Where the branch points now: its resolved tip, else null (unborn, diverged or unknown). */
export async function readBranchTip(sdk: EvoSDK, repo: RepoRef, refName: string): Promise<string | null> {
  const s = await readBranchState(sdk, repo, refName)
  return s?.state === 'resolved' ? s.oid : null
}

/** What the head-sync banner says, from the PR head and the branch's state. */
export type HeadSync =
  | { readonly kind: 'in-sync' }
  /** The branch moved: the PR can follow it (a `headUpdate` naming `tip`). */
  | { readonly kind: 'ahead'; readonly tip: string }
  /** The branch was deleted (it resolves to unborn): nothing to follow. */
  | { readonly kind: 'deleted' }
  /** Not known from here (unreadable, never recorded, or diverged: no single head to offer). */
  | { readonly kind: 'unknown' }

export function headSync(headOid: string, state: RefState | null): HeadSync {
  if (state === null || state.state === 'diverged') return { kind: 'unknown' }
  if (state.state === 'unborn') return { kind: 'deleted' }
  return state.oid.toLowerCase() === headOid.toLowerCase() ? { kind: 'in-sync' } : { kind: 'ahead', tip: state.oid }
}

/**
 * A branch write this page made (a delete, a restore at the PR head, or a browser commit that
 * moved the branch from `from` to `head`), awaiting a read that shows it.
 */
export interface BranchWrite {
  readonly ref: string
  readonly head: string
  readonly to: 'deleted' | 'restored' | 'committed'
  /** For `committed`: the tip the commit was built on, which a read a block behind still shows. */
  readonly from?: string
}

/**
 * The head sync to show: the read one, unless this page just deleted or restored the branch at
 * this head and the read still shows how it was (a node a block behind, QW3-053). A read showing
 * anything else (the branch pushed again, moved) wins. After a browser commit the branch and the
 * PR head move together, so either read a step behind the other is the same lag: once the head is
 * the commit, a read still at its parent must not offer the older tip as an "Update PR head" (a
 * backward move, #556); while the head is still the parent, a read already at the commit must not
 * offer the commit the head update is landing anyway. A read at any other tip wins.
 */
export function branchShown(read: HeadSync | null, wrote: BranchWrite | null, refName: string | null, headOid: string): HeadSync | null {
  if (wrote === null || refName === null || wrote.ref !== refName) return read
  if (wrote.to === 'committed') {
    if (read === null || read.kind !== 'ahead' || wrote.from === undefined) return read
    const head = headOid.toLowerCase()
    const tip = read.tip.toLowerCase()
    const lag = (head === wrote.head.toLowerCase() && tip === wrote.from.toLowerCase()) || (head === wrote.from.toLowerCase() && tip === wrote.head.toLowerCase())
    return lag ? { kind: 'in-sync' } : read
  }
  if (wrote.head.toLowerCase() !== headOid.toLowerCase()) return read
  const stale = wrote.to === 'deleted' ? read === null || read.kind === 'in-sync' || read.kind === 'unknown' : read === null || read.kind === 'deleted' || read.kind === 'unknown'
  if (!stale) return read
  return wrote.to === 'deleted' ? { kind: 'deleted' } : { kind: 'in-sync' }
}

/**
 * Whether a read shows `wrote`, so the page's own record of it can go (the read alone speaks
 * again). A commit's record goes once the PR head is that commit and a read shows anything but the
 * lag it masks (the branch at the commit, pushed or rewound elsewhere, deleted): before the head
 * follows it, "in sync" is the old head and the old tip.
 */
export function branchWriteSeen(read: HeadSync | null, wrote: BranchWrite | null, headOid: string): boolean {
  if (wrote === null || read === null) return false
  if (wrote.to === 'deleted') return read.kind === 'deleted'
  if (wrote.to === 'restored') return read.kind === 'in-sync'
  if (wrote.head.toLowerCase() !== headOid.toLowerCase() || read.kind === 'unknown') return false
  return !(read.kind === 'ahead' && wrote.from !== undefined && read.tip.toLowerCase() === wrote.from.toLowerCase())
}

/**
 * Why a head update naming `proposed` must not be signed now, or null when it may. Judged at the
 * click from a fresh read, never from what the banner showed (#556): `tip` is the source branch's
 * resolved tip read now (null: it no longer resolves to one commit), `head` the PR's current head.
 * A proposal the branch is really at is allowed even when the head already holds it: that is a
 * force-push that rewound the branch, which the PR follows.
 */
export function headUpdateRefusal(input: { proposed: string; tip: string | null; head: string; branch: string }): string | null {
  const { proposed, tip, head, branch } = input
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  if (same(proposed, head)) return `This PR's head is already ${head.slice(0, 9)}; there is nothing to update. Nothing was signed.`
  if (tip === null) return `${branch} no longer points at one commit, so there is no tip to update the PR head to. Nothing was signed.`
  if (!same(tip, proposed)) {
    return `${branch} is at ${tip.slice(0, 9)} now, not ${proposed.slice(0, 9)} as this page showed. Nothing was signed; the page re-reads the branch.`
  }
  return null
}
