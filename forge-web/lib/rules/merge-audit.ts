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
 * unmet now may have been met then: readers say so. A recorded bypass is immutable and stands. A
 * bypass whose writer no current membership document shows as a maintainer then (removing a
 * member or changing a role deletes the document) does not count, but it is reported
 * ({@link UncountedBypass}), never hidden.
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

/**
 * A policy-bypass event for this merge that does not count: no current membership document shows
 * its writer as a maintainer when they wrote it. Consensus admits kind 23 only from a maintainer
 * or a role-1 writer; `role` is what the current documents say about then (null: none covers that
 * time, so the role can't be confirmed). Parity: forge-core `UncountedBypass`.
 */
export interface UncountedBypass {
  readonly event: BypassEvent
  readonly role: Role | null
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
 * a bypass for this merge; `unmet`: a rule is not met by what is on chain now and no maintainer's
 * bypass is proven (see {@link MergeAudit.uncountedBypass}); `unknown`: nothing found unmet, but a
 * rule was not judged (the required checks were not read, or the policy required code owners'
 * approval, which this audit does not check).
 */
export type AuditVerdict = 'none' | 'met' | 'bypassed' | 'unmet' | 'unknown'

export interface MergeAudit {
  readonly verdict: AuditVerdict
  /** The policy in force at the merge, or null. */
  readonly policy: Policy | null
  /** The base branch was protected at the merge. */
  readonly protected: boolean
  /** The merger's role at the merge (null: no current membership document covers it; they may have been removed or changed role since). */
  readonly mergerRole: Role | null
  /** A protected base was merged by someone other than a maintainer. */
  readonly protectionUnmet: boolean
  /** The approvals at the merge against the policy; null without a policy. */
  readonly approvals: PolicyStatus | null
  /** The required checks at the merge; null when none were required or the runs were not read. */
  readonly checks: ChecksState | null
  /** The policy required checks and the runs were not read. */
  readonly checksUnread: boolean
  /**
   * The policy required code owners' approval. Judging it needs the CODEOWNERS file at the base,
   * the changed paths and the owners' names, which this audit does not read: reported as not
   * audited, so the merge never reads as fully met.
   */
  readonly codeOwnersUnaudited: boolean
  /** The first bypass a maintainer recorded for this merge. */
  readonly bypass: BypassEvent | null
  /** Without a counted `bypass`: the first bypass event for this merge's commit whose writer is not shown as a maintainer then. */
  readonly uncountedBypass: UncountedBypass | null
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
    (a.requireCodeOwners ?? false) === (b.requireCodeOwners ?? false) &&
    list(a.requiredChecks) === list(b.requiredChecks) &&
    list(a.requiredCheckSources) === list(b.requiredCheckSources)
  )
}

/**
 * The check runs as they stood at the merge `at`: those created no later, each completed run
 * keeping its conclusion only when its last replace (`updatedAt`) came no later; otherwise it was
 * still running at the merge as far as anyone can tell. Fails safe: a run whose `updatedAt` was
 * not read, or that was replaced again after the merge, reads as still running then. Parity:
 * forge-core `runs_at`.
 */
function runsAt(runs: readonly CheckRunRow[], at: number): CheckRunRow[] {
  return runs
    .filter((r) => r.createdAt <= at)
    .map((r) => (r.status === 'completed' && (r.updatedAt === undefined || r.updatedAt > at) ? { ...r, status: 'in_progress', conclusion: null } : r))
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
  const codeOwnersUnaudited = policy?.requireCodeOwners === true

  // Only a maintainer's record for this merge's commit counts (the merge box and `dg` write it
  // right after the merge); any other record for it is reported, not hidden.
  const mergeOid = input.mergeOid.toLowerCase()
  const events = (input.bypasses ?? []).filter((b) => b.oid.toLowerCase() === mergeOid).sort(compareKey)
  const bypass = events.find((b) => oracle.roleAt(b.actor, b.createdAt) === 'maintainer') ?? null
  const first = bypass === null ? (events[0] ?? null) : null
  const uncountedBypass = first === null ? null : { event: first, role: oracle.roleAt(first.actor, first.createdAt) }

  const rulesChanged =
    changedBefore(policies, at, (a, b) => samePolicy(a.policy, b.policy), () => true) ||
    changedBefore(protection, at, (a, b) => a.protected === b.protected, (p) => p.protected)

  const unmet = protectionUnmet || (approvals !== null && !approvals.met) || (checks !== null && !checks.met)
  const verdict: AuditVerdict =
    bypass !== null ? 'bypassed' : unmet ? 'unmet' : checksUnread || codeOwnersUnaudited ? 'unknown' : policy === null && !isProtected ? 'none' : 'met'
  return {
    verdict,
    policy,
    protected: isProtected,
    mergerRole,
    protectionUnmet,
    approvals,
    checks,
    checksUnread,
    codeOwnersUnaudited,
    bypass,
    uncountedBypass,
    rulesChanged,
  }
}
