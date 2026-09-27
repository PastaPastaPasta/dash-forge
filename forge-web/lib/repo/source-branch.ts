/**
 * A PR's source branch (review-parity R14, §4.6): where `sourceRefName` points in the source repo
 * now, so the PR page can say "Your branch is ahead of this PR — Update PR head". Resolved the way
 * every other view resolves a ref (`resolveRefByHash` over the complete update history and the
 * config timeline).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { isPlainBranchRef, type RefState } from '../rules'
import { bytesToBase64 } from '../sdk'
import { readConfigHistory } from './config'
import type { RepoRef } from './contract'
import { refNameHash } from './push'
import { resolveRefByHash } from './refs'

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
