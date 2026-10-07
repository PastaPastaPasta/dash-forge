/**
 * The merge gate ({@link pullActions}) judged again when the merge is clicked, against the repo's
 * membership (and, when a required check is counted, its runners) read then, uncached. The page's
 * own reads can be minutes old: a member revoked since must not carry a merge (as the merger, as a
 * counted approver, or as a trusted check reporter), and a maintainer made a writer must not
 * bypass the branch rules. The reviews, the policy and the check runs are the page's.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { readRunners } from '../repo/checks'
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
  /**
   * The head's required checks (null: none required), trusting the reporters `oracle` holds and
   * `runners` (null: the page's runners, when {@link readsRunners} is false).
   */
  readonly checks: (oracle: RoleOracle, runners: ReadonlySet<string> | null) => ChecksState | null | 'unknown'
  /** The checks count runners' runs: read the runners again too. */
  readonly readsRunners: boolean
  /** The rules the merger confirmed bypassing (empty: none). */
  readonly bypass: readonly string[]
}

const CHANGED = 'Something changed since the page loaded'

/**
 * Why the merge must stop under `members` (the membership now) and `runners` (null: the page's),
 * or null: the viewer can no longer merge, or the rules left unmet are not exactly the ones the
 * merger confirmed bypassing.
 */
export function mergeMembersProblem(members: readonly Membership[], r: MergeRecheck, runners: ReadonlySet<string> | null = null): string | null {
  const oracle = new RoleOracle([...members])
  const status = r.approvals !== null && r.policy !== null && r.policy !== 'unknown' ? meetsPolicy(r.approvals, oracle, r.policy) : r.status
  const role = r.gate.viewer === null ? null : oracle.currentRole(r.gate.viewer)
  const now = pullActions({ ...r.gate, holdings: holdingsOfRole(role), policy: status, checks: r.checks(oracle, runners) })
  if (!now.canMerge) return `${CHANGED}. ${now.mergeHint ?? 'You can no longer merge this pull request.'}`
  if (now.unmetRules.length === r.bypass.length && now.unmetRules.every((rule, i) => rule === r.bypass[i])) return null
  if (r.bypass.length === 0) return `${CHANGED}: the branch rules are no longer met (${now.unmetRules.join('; ')}).`
  return `${CHANGED}: the branch rules to bypass are different now.`
}

/** The error a merge stops with when the members cannot be read: whether it may go ahead is unknown. */
export const MEMBERS_UNREAD = "Couldn't read this repo's members to confirm the merge. Try again."

/**
 * {@link mergeMembersProblem} with the membership (and the runners, {@link MergeRecheck.readsRunners})
 * read now.
 *
 * @throws Error ({@link MEMBERS_UNREAD}) when they cannot be read: the caller stops the merge.
 */
export async function recheckMergeMembers(sdk: EvoSDK, repo: RepoRef, network: Network, r: MergeRecheck): Promise<string | null> {
  const [members, runners] = await Promise.all([
    readMembershipsFresh(sdk, repo, network),
    r.readsRunners ? readRunners(sdk, repo).then((ids) => new Set(ids)) : null,
  ]).catch(() => {
    throw new Error(MEMBERS_UNREAD)
  })
  return mergeMembersProblem(members, r, runners)
}

/**
 * "Mark as merged (done elsewhere)": judge the merge again (`recheck`), record it (`merge`, the
 * merge transition), then a bypass's record (`recordBypass`, null: none). `landed`: this action's
 * transition already landed (a retry after the record failed): the merge is recorded and final,
 * so it is neither judged nor written again, and only the record is retried.
 */
export async function markMerged(run: {
  readonly landed: boolean
  readonly recheck: () => Promise<string | null>
  readonly merge: () => Promise<void>
  readonly recordBypass: (() => Promise<void>) | null
  /** Platform's answer, worded for the person (the write guard's `failed`). */
  readonly describe: (e: unknown) => string
}): Promise<void> {
  if (!run.landed) {
    const problem = await run.recheck()
    if (problem !== null) throw new Error(problem)
    await run.merge()
  }
  if (run.recordBypass === null) return
  try {
    await run.recordBypass()
  } catch (e) {
    throw new Error(`The merge is recorded, but recording the rules bypass failed: ${run.describe(e)} Retry to record it.`)
  }
}
