/**
 * A PR's source branch (review-parity R14, §4.6): where `sourceRefName` points in the source repo
 * now, so the PR page can say "Your branch is ahead of this PR — Update PR head". Resolved the way
 * every other view resolves a ref (`resolveRefByHash` over the complete update history and the
 * config timeline). A public source only: a private source's ref names are keyed hashes.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { isPlainBranchRef } from '../rules'
import { bytesToBase64 } from '../sdk'
import { tipOidOf } from '../view/refs'
import { readConfigHistory } from './config'
import type { RepoRef } from './contract'
import { refNameHash } from './push'
import { resolveRefByHash } from './refs'

/** Where the branch points now, `null` when it has no tip (deleted, never pushed). */
export async function readBranchTip(sdk: EvoSDK, repo: RepoRef, refName: string): Promise<string | null> {
  if (!isPlainBranchRef(refName)) return null
  const ref = await resolveRefByHash(sdk, repo, bytesToBase64(refNameHash(refName)), await readConfigHistory(sdk, repo))
  return tipOidOf(ref ?? undefined)
}

/** What the head-sync banner says, from the PR head and the branch tip. */
export type HeadSync =
  | { readonly kind: 'in-sync' }
  /** The branch moved: the PR can follow it (a `headUpdate` naming `tip`). */
  | { readonly kind: 'ahead'; readonly tip: string }
  /** The branch is gone: nothing to follow. */
  | { readonly kind: 'deleted' }

export function headSync(headOid: string, tip: string | null): HeadSync {
  if (tip === null) return { kind: 'deleted' }
  return tip.toLowerCase() === headOid.toLowerCase() ? { kind: 'in-sync' } : { kind: 'ahead', tip }
}
