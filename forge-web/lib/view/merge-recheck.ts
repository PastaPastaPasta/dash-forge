/**
 * The merge gate ({@link pullActions}) judged again when the merge is clicked, against the repo's
 * membership read then, uncached. The page's own read can be minutes old: a member revoked since
 * must not carry a merge (as the merger, as a counted approver, or as a trusted check reporter),
 * and a maintainer made a writer must not bypass the branch rules. Only the membership is read
 * again; the reviews, the policy and the check runs are the page's.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import type { RepoRef } from '../repo/contract'
import { holdingsOfRole, readMembershipsFresh } from '../repo/members'
import { meetsPolicy, RoleOracle, type Approvals, type ChecksState, type Membership, type Policy, type PolicyStatus } from '../rules/v2'
import { pullActions, type PullActionInputs } from './pull-actions'

export interface MergeRecheck {
  /** The gate's inputs as the page judged them, less the three that follow the membership. */
  readonly gate: Omit<PullActionInputs, 'holdings' | 'policy' | 'checks'>
  /** The branch policy in force (null: none; `'unknown'`: unread). */
  readonly policy: Policy | null | 'unknown'
  /** How the page found the approvals stand against it. */
  readonly status: PolicyStatus | null | 'unknown'
  /** The page's approval fold on the head (null: the page could not read the members). */
  readonly approvals: Approvals | null
  /** The head's required checks, trusting the reporters `oracle` holds (null: none required). */
  readonly checks: (oracle: RoleOracle) => ChecksState | null | 'unknown'
  /** The rules the merger confirmed bypassing (empty: none). */
  readonly bypass: readonly string[]
}

const CHANGED = "This repo's members changed since the page loaded"

/**
 * Why the merge must stop under `members` (the membership now), or null: the viewer can no
 * longer merge, or the rules left unmet are not exactly the ones the merger confirmed bypassing.
 */
export function mergeMembersProblem(members: readonly Membership[], r: MergeRecheck): string | null {
  const oracle = new RoleOracle([...members])
  const status = r.approvals !== null && r.policy !== null && r.policy !== 'unknown' ? meetsPolicy(r.approvals, oracle, r.policy) : r.status
  const role = r.gate.viewer === null ? null : oracle.currentRole(r.gate.viewer)
  const now = pullActions({ ...r.gate, holdings: holdingsOfRole(role), policy: status, checks: r.checks(oracle) })
  if (!now.canMerge) return `${CHANGED}. ${now.mergeHint ?? 'You can no longer merge this pull request.'}`
  if (now.unmetRules.length === r.bypass.length && now.unmetRules.every((rule, i) => rule === r.bypass[i])) return null
  if (r.bypass.length === 0) return `${CHANGED}, and the branch rules are no longer met: ${now.unmetRules.join('; ')}.`
  return `${CHANGED}, and the branch rules to bypass are different now. Reload to see them.`
}

/**
 * {@link mergeMembersProblem} with the membership read now. A failed read stops the merge too:
 * whether it may go ahead is unknown.
 */
export async function recheckMergeMembers(sdk: EvoSDK, repo: RepoRef, network: Network, r: MergeRecheck): Promise<string | null> {
  const members = await readMembershipsFresh(sdk, repo, network).catch(() => null)
  if (members === null) return "Couldn't read this repo's members to confirm the merge. Try again."
  return mergeMembersProblem(members, r)
}
