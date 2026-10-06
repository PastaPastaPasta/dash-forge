/**
 * Rules at merge time: which branch rules applied when a pull request was merged, and whether the
 * merge met them. Parity with forge-core `rules::merge_audit` (vectors `merge_audit__*`).
 *
 * Branch rules are a client rule: consensus admits a merge transition from any maintainer or
 * role-1 writer, with or without approvals, and a maintainer may append a weaker policy, merge,
 * and append the old one back. {@link auditMerge} re-judges the merge from what is on chain: the
 * newest policy written no later than the merge, the base branch's protection then, the reviews,
 * dismissals and check runs written no later than the merge, and a policy-bypass event a
 * maintainer recorded for the merge commit. It reuses the merge box's own rules
 * ({@link countApprovals}, {@link meetsPolicy}, {@link checksState}) with the membership as it
 * stood at the merge.
 *
 * Reviews and check runs are deletable and revoked members' documents are gone, so a rule found
 * unmet now may have been met then: readers say so. A recorded bypass is immutable and stands.
 */

import { compareKey } from './oid'
import { checksState, type CheckRunRow, type ChecksState } from './parity'
import { meetsPolicy, type Policy, type PolicyStatus } from './review'
import { RoleOracle, countApprovals, type Membership, type Review, type Role } from './v2'

/** How long before a merge a change to the branch rules is flagged (one hour, ms). */
export const RULES_CHANGE_WINDOW_MS = 3_600_000

/** One `policy` document of the repository. */
export interface PolicyDoc {
  readonly id: string
  readonly createdAt: number
  readonly policy: Policy
}

/** Whether one `config` document protected the base branch (its protected patterns match it). */
export interface ProtectionDoc {
  readonly id: string
  readonly createdAt: number
  readonly protected: boolean
}

/** A review dismissal: the review it names stops counting from `createdAt`. */
export interface DismissalAt {
  readonly reviewId: string
  readonly createdAt: number
}

/** A policy-bypass event (kind 23) on the pull request. */
export interface BypassEvent {
  readonly id: string
  readonly actor: string
  readonly createdAt: number
  /** The merge commit it names, hex. */
  readonly oid: string
  /** The rules it says were not met. */
  readonly value: string
}

export interface MergeAuditInput {
  /** The merge transition's `$createdAt` (ms). */
  readonly mergedAt: number
  /** Who wrote the merge transition. */
  readonly merger: string
  /** The merge transition's commit, hex. */
  readonly mergeOid: string
  /** The PR's head when it was merged (`headAt`). */
  readonly mergeHead: string
  readonly prAuthor: string
  readonly policies?: readonly PolicyDoc[]
  /** Every config document, judged against the base branch. */
  readonly protection?: readonly ProtectionDoc[]
  /** The repository's current membership documents. */
  readonly memberships?: readonly Membership[]
  readonly reviews?: readonly Review[]
  readonly dismissals?: readonly DismissalAt[]
  /** The check runs on `mergeHead`; null or absent when they were not read. */
  readonly runs?: readonly CheckRunRow[] | null
  /** The repository's current runners. */
  readonly runners?: readonly string[]
  readonly bypasses?: readonly BypassEvent[]
}

/**
 * `none`: no rule applied (no policy, unprotected base); `met`; `bypassed`: a maintainer recorded
 * a bypass for this merge; `unmet`: a rule is not met by what is on chain now and no bypass was
 * recorded; `unknown`: nothing found unmet, but the required checks were not read.
 */
export type AuditVerdict = 'none' | 'met' | 'bypassed' | 'unmet' | 'unknown'

export interface MergeAudit {
  readonly verdict: AuditVerdict
  /** The policy in force at the merge, or null. */
  readonly policy: Policy | null
  /** The base branch was protected at the merge. */
  readonly protected: boolean
  /** The merger's role at the merge (null: no current membership document says). */
  readonly mergerRole: Role | null
  /** A protected base was merged by someone other than a maintainer. */
  readonly protectionUnmet: boolean
  /** The approvals at the merge against the policy; null without a policy. */
  readonly approvals: PolicyStatus | null
  /** The required checks at the merge; null when none were required or the runs were not read. */
  readonly checks: ChecksState | null
  /** The policy required checks and the runs were not read. */
  readonly checksUnread: boolean
  /** The first bypass a maintainer recorded for this merge. */
  readonly bypass: BypassEvent | null
  /** The policy or the base's protection changed within {@link RULES_CHANGE_WINDOW_MS} before the merge. */
  readonly rulesChanged: boolean
}

type Keyed = { readonly createdAt: number; readonly id: string }

/** The newest of `items` written at or before `at`, by `(createdAt, id)`. */
function newestAt<T extends Keyed>(items: readonly T[], at: number): T | null {
  let best: T | null = null
  for (const x of items) if (x.createdAt <= at && (best === null || compareKey(x, best) > 0)) best = x
  return best
}

/**
 * Whether a document written in the window before `at` changed what the one before it said; the
 * first document ever counts as a change when it `applies`.
 */
function changedBefore<T extends Keyed>(items: readonly T[], at: number, same: (a: T, b: T) => boolean, applies: (x: T) => boolean): boolean {
  const sorted = items.filter((x) => x.createdAt <= at).sort(compareKey)
  const from = Math.max(0, at - RULES_CHANGE_WINDOW_MS)
  return sorted.some((x, i) => {
    if (x.createdAt <= from) return false
    const prev = i > 0 ? (sorted[i - 1] as T) : null
    return prev === null ? applies(x) : !same(prev, x)
  })
}

/** Field-by-field policy equality, absent and default alike (forge-core's derived `PartialEq`). */
function samePolicy(a: Policy, b: Policy): boolean {
  const list = (x: readonly string[] | undefined): string => JSON.stringify(x ?? [])
  return (
    a.requiredApprovals === b.requiredApprovals &&
    (a.approverRole ?? 0) === (b.approverRole ?? 0) &&
    (a.requireChecks ?? false) === (b.requireChecks ?? false) &&
    (a.mergeMethods ?? 0) === (b.mergeMethods ?? 0) &&
    list(a.requiredChecks) === list(b.requiredChecks) &&
    list(a.requiredCheckSources) === list(b.requiredCheckSources)
  )
}

/**
 * The check runs as they stood at the merge `at`: those created no later, each completed run
 * keeping its conclusion only when it completed no later (by `updatedAt`, else `createdAt`); one
 * that completed after the merge was still running then. Parity: forge-core `runs_at`.
 */
function runsAt(runs: readonly CheckRunRow[], at: number): CheckRunRow[] {
  return runs
    .filter((r) => r.createdAt <= at)
    .map((r) => (r.status === 'completed' && (r.updatedAt ?? r.createdAt) > at ? { ...r, status: 'in_progress', conclusion: null } : r))
}

/** Judge a merge against the branch rules in force when it was recorded (see the module docs). */
export function auditMerge(input: MergeAuditInput): MergeAudit {
  const at = input.mergedAt
  const memberships = input.memberships ?? []
  const oracle = new RoleOracle(memberships)
  // The membership as it stood at the merge: members added since never counted then.
  const then = new RoleOracle(memberships.filter((m) => m.createdAt <= at))
  const policies = input.policies ?? []
  const protection = input.protection ?? []
  const policy = newestAt(policies, at)?.policy ?? null
  const isProtected = newestAt(protection, at)?.protected === true
  const mergerRole = oracle.roleAt(input.merger, at)
  const protectionUnmet = isProtected && mergerRole !== 'maintainer'

  let approvals: PolicyStatus | null = null
  if (policy !== null) {
    const dismissed = new Set((input.dismissals ?? []).filter((d) => d.createdAt <= at).map((d) => d.reviewId))
    const reviews = (input.reviews ?? []).filter((r) => r.createdAt <= at)
    approvals = meetsPolicy(countApprovals(reviews, then, input.mergeHead, dismissed, input.prAuthor), then, policy)
  }

  const checksRequired = policy !== null && (policy.requireChecks === true || (policy.requiredChecks ?? []).some((n) => n !== ''))
  const runs = input.runs ?? null
  const checks =
    policy !== null && checksRequired && runs !== null
      ? checksState(
          runsAt(runs, at),
          input.mergeHead,
          then,
          new Set(input.runners ?? []),
          policy,
        )
      : null
  const checksUnread = checksRequired && runs === null

  // Only a maintainer's record for this merge's commit counts (the merge box and `dg` write it
  // right after the merge).
  const mergeOid = input.mergeOid.toLowerCase()
  const bypass =
    [...(input.bypasses ?? [])]
      .filter((b) => b.oid.toLowerCase() === mergeOid && oracle.roleAt(b.actor, b.createdAt) === 'maintainer')
      .sort(compareKey)[0] ?? null

  const rulesChanged =
    changedBefore(policies, at, (a, b) => samePolicy(a.policy, b.policy), () => true) ||
    changedBefore(protection, at, (a, b) => a.protected === b.protected, (p) => p.protected)

  const unmet = protectionUnmet || (approvals !== null && !approvals.met) || (checks !== null && !checks.met)
  const verdict: AuditVerdict =
    bypass !== null ? 'bypassed' : unmet ? 'unmet' : checksUnread ? 'unknown' : policy === null && !isProtected ? 'none' : 'met'
  return {
    verdict,
    policy,
    protected: isProtected,
    mergerRole,
    protectionUnmet,
    approvals,
    checks,
    checksUnread,
    bypass,
    rulesChanged,
  }
}
