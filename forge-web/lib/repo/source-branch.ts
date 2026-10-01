/**
 * A PR's source branch (review-parity R14, §4.6): where `sourceRefName` points in the source repo
 * now, so the PR page can say "Your branch is ahead of this PR — Update PR head". Resolved the way
 * every other view resolves a ref (`resolveRefByHash` over the complete update history and the
 * config timeline).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { isPlainBranchRef, type RefState, type RefUpdate } from '../rules'
import { bytesToBase64 } from '../sdk'
import { readConfigHistory } from './config'
import type { RepoRef } from './contract'
import { refNameHash } from './push'
import { readRefUpdates, resolveRefByHash } from './refs'

/**
 * The branch's resolved state, or null when it cannot be known from here: not a plain branch
 * (an imported PR's `refs/mirror/pull/<n>/head`), a private repo (its ref names are keyed hashes
 * this reader cannot form), or no update was ever recorded for it.
 */
export async function readBranchState(sdk: EvoSDK, repo: RepoRef, refName: string): Promise<RefState | null> {
  if (!isPlainBranchRef(refName) || repo.visibility === 'private') return null
  const ref = await resolveRefByHash(sdk, repo, bytesToBase64(refNameHash(refName)), await readConfigHistory(sdk, repo))
  return ref?.state ?? null
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

/** A branch write this page made (a delete, or a restore at the PR head), awaiting a read that shows it. */
export interface BranchWrite {
  readonly ref: string
  readonly head: string
  readonly to: 'deleted' | 'restored'
}

/**
 * The head sync to show: the read one, unless this page just deleted or restored the branch at
 * this head and the read still shows how it was (a node a block behind, QW3-053). A read showing
 * anything else (the branch pushed again, moved) wins.
 */
export function branchShown(read: HeadSync | null, wrote: BranchWrite | null, refName: string | null, headOid: string): HeadSync | null {
  if (wrote === null || refName === null || wrote.ref !== refName || wrote.head.toLowerCase() !== headOid.toLowerCase()) return read
  const stale = wrote.to === 'deleted' ? read === null || read.kind === 'in-sync' || read.kind === 'unknown' : read === null || read.kind === 'deleted' || read.kind === 'unknown'
  if (!stale) return read
  return wrote.to === 'deleted' ? { kind: 'deleted' } : { kind: 'in-sync' }
}
