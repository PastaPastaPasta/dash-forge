/**
 * "Rules at merge time" on a merged PR (view glue for `lib/rules/merge-audit.ts`): gather what the
 * shared rule judges from the loaded PR thread and three reads made only when the reader opens the
 * section (the policy history, the config history, the check runs on the merged head), and word
 * the result.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { matchesProtected } from '../rules'
import { auditMerge, type BypassEvent, type MergeAudit, type MergeAuditInput, type PolicyDoc, type ProtectionDoc, type UncountedBypass } from '../rules/merge-audit'
import { headAt } from '../rules/merge-content'
import { ROLE_NOUN } from '../rules/roles'
import { mergeTransition } from '../rules/transition'
import type { ConfigDoc } from '../rules/types'
import type { Review } from '../rules/v2'
import type { RepoRef } from '../repo'
import { readCheckRuns, type HeadChecks } from '../repo/checks'
import { readMemberships } from '../repo/members'
import { readPolicyHistory } from '../repo/settings'
import type { TransitionView } from '../repo/transitions'
import type { PullThread } from './issues-view'
import { branchName, plural } from './format'

/** What the audit reads beyond the PR thread. */
export interface AuditReads {
  readonly policies: readonly PolicyDoc[]
  readonly configs: readonly ConfigDoc[]
  /** The runs on the merged head and the repo's runners; null when not read (no check was required). */
  readonly checks: Pick<HeadChecks, 'rows' | 'runners'> | null
}

/** The merge the audit judges, from the thread: null when the PR is not merged or the merge names no commit. */
export function auditedMerge(thread: Pick<PullThread, 'pull' | 'timeline'>): { readonly merger: string; readonly mergedAt: number; readonly mergeOid: string; readonly mergeHead: string } | null {
  const { pull } = thread
  if (!pull.state.merged || pull.mergedAt === undefined || (pull.mergeOid ?? '') === '') return null
  const transitions = thread.timeline.flatMap((t): TransitionView[] => (t.kind === 'transition' ? [t.transition] : []))
  const merge = mergeTransition(transitions)
  if (merge === null) return null
  return { merger: merge.actor, mergedAt: pull.mergedAt, mergeOid: pull.mergeOid ?? '', mergeHead: headAt(pull.review.headUpdates, pull.initialHeadOid, pull.mergedAt) }
}

/** The shared rule's input for `thread`'s merge, or null (see {@link auditedMerge}). */
export function mergeAuditInput(thread: Pick<PullThread, 'pull' | 'timeline' | 'reviews' | 'review' | 'members'>, reads: AuditReads): MergeAuditInput | null {
  const merge = auditedMerge(thread)
  if (merge === null) return null
  const base = thread.pull.mergeBaseRefName
  const protection: ProtectionDoc[] = reads.configs.map((c, i) => ({
    id: c.id ?? String(i),
    createdAt: c.createdAt,
    protected: base !== '' && matchesProtected(base, c.protectedPatterns ?? []),
  }))
  const bypasses: BypassEvent[] = thread.timeline.flatMap((t): BypassEvent[] =>
    t.kind === 'event' && t.byAuthor !== true && t.event.kind === 'policyBypass'
      ? [{ id: t.event.id ?? '', actor: t.event.actor, createdAt: t.event.createdAt, oid: (t.event.oid ?? '').toLowerCase(), value: t.event.value ?? '' }]
      : [],
  )
  const reviews: Review[] = thread.reviews.map((r) => ({ id: r.id, reviewer: r.reviewer, verdict: r.verdictCode, commitOid: r.commitOid, createdAt: r.createdAt }))
  return {
    ...merge,
    prAuthor: thread.pull.author,
    policies: reads.policies,
    protection,
    memberships: thread.members,
    reviews,
    dismissals: thread.review.dismissedReviews.map((d) => ({ reviewId: d.reviewId, createdAt: d.createdAt })),
    runs: reads.checks === null ? null : reads.checks.rows,
    runners: reads.checks === null ? [] : [...reads.checks.runners],
    bypasses,
  }
}

/**
 * Read what the audit needs and judge the merge. `configHistory` is the page's config reader (the
 * repo chrome's store); `pageChecks` the runs the page already read on the PR head, reused when it
 * is the merged head. The runs are read only when the policy at the merge required a check.
 */
export async function readMergeAudit(
  sdk: EvoSDK,
  repo: RepoRef,
  page: PullThread,
  configHistory: () => Promise<readonly ConfigDoc[]>,
  pageChecks: HeadChecks | null,
): Promise<MergeAudit | null> {
  const merge = auditedMerge(page)
  if (merge === null) return null
  // The page's member read failed (no approvals were counted): read them again rather than judge
  // with nobody a member, which would call every merge unmet.
  const thread = page.approvals === null ? { ...page, members: await readMemberships(sdk, repo) } : page
  const [policies, configs] = await Promise.all([readPolicyHistory(sdk, repo), configHistory()])
  const noRuns = mergeAuditInput(thread, { policies, configs, checks: null })
  if (noRuns === null) return null
  const first = auditMerge(noRuns)
  if (!first.checksUnread) return first
  const members = new Set(thread.members.map((m) => m.identity))
  const checks = pageChecks !== null && merge.mergeHead === thread.pull.headOid.toLowerCase() ? pageChecks : await readCheckRuns(sdk, repo, merge.mergeHead, members)
  const input = mergeAuditInput(thread, { policies, configs, checks })
  return input === null ? null : auditMerge(input)
}

/**
 * One rule's line: what applied, and whether the merge met it (null: informational;
 * 'unconfirmed': the current records can't tell, as for a merger with no membership record).
 */
export interface AuditRow {
  readonly key: string
  readonly label: string
  readonly text: string
  readonly met: boolean | 'unconfirmed' | null
}

const CHECK_WORDS = { passed: 'passed', failing: 'failed', pending: 'still running at the merge', missing: 'not reported' } as const

/** The audit's rows, in the merge box's words. */
export function auditRows(a: MergeAudit, baseRefName: string): AuditRow[] {
  const base = branchName(baseRefName) || 'the base branch'
  const rows: AuditRow[] = []
  rows.push(
    a.protected
      ? {
          key: 'protected',
          label: 'Protected branch',
          text: !a.protectionUnmet
            ? `${base} was protected; a maintainer merged it`
            : a.mergerRole === null
              ? `Unconfirmed: ${base} was protected, and the merger has no current membership record`
              : `${base} was protected, and no current membership record shows the merger as a maintainer then`,
          met: !a.protectionUnmet ? true : a.mergerRole === null ? 'unconfirmed' : false,
        }
      : { key: 'protected', label: 'Protected branch', text: `${base} was not protected`, met: null },
  )
  const p = a.policy
  if (p === null) {
    rows.push({ key: 'policy', label: 'Branch policy', text: 'None', met: null })
    return rows
  }
  if (a.approvals !== null && a.approvals.need > 0) {
    const who = (p.approverRole ?? 0) === 1 ? ' (maintainers only)' : ''
    rows.push({ key: 'approvals', label: 'Required approvals', text: `${a.approvals.have} of ${a.approvals.need}${who}`, met: a.approvals.have >= a.approvals.need })
    if (a.approvals.blockedBy.length > 0) {
      rows.push({ key: 'changes', label: 'Changes requested', text: `by ${plural(a.approvals.blockedBy.length, 'reviewer')}`, met: false })
    }
  } else {
    rows.push({ key: 'approvals', label: 'Required approvals', text: 'None', met: null })
  }
  if (a.checksUnread) {
    rows.push({ key: 'checks', label: 'Required checks', text: "Couldn't be read", met: null })
  } else if (a.checks !== null) {
    if (a.checks.required.length === 0) {
      rows.push({ key: 'checks', label: 'Required checks', text: 'None reported on the merged head', met: false })
    }
    for (const c of a.checks.required) rows.push({ key: `check:${c.name}`, label: `Check ${c.name}`, text: CHECK_WORDS[c.state], met: c.state === 'passed' })
  }
  // Q5-B04: never judged here (it needs CODEOWNERS at the base and the changed paths).
  if (a.codeOwnersUnaudited) rows.push({ key: 'codeOwners', label: 'Code owners', text: 'Approval required; not audited', met: null })
  return rows
}

/**
 * Whether the current records show a rule unmet, beyond what only can't be confirmed (a merger
 * with no current membership record). Parity: dg `confirmed_unmet` (pr/verify.rs).
 */
export function confirmedUnmet(a: MergeAudit): boolean {
  return (a.protectionUnmet && a.mergerRole !== null) || (a.approvals !== null && !a.approvals.met) || (a.checks !== null && !a.checks.met)
}

/**
 * The audit's headline. An `unmet` verdict whose only gaps can't be confirmed (the merger's role,
 * or the role of whoever recorded a bypass) says so rather than "did not meet"; the verdict stays
 * `unmet`. Parity: dg `audit_headline`.
 */
export function auditHeadline(a: MergeAudit): string {
  switch (a.verdict) {
    case 'none':
      return 'No branch rules applied to this merge.'
    case 'met':
      return 'This merge met the branch rules in force at the time.'
    case 'bypassed':
      return 'A maintainer bypassed the branch rules to merge this, and recorded it.'
    case 'unmet': {
      const confirmed = confirmedUnmet(a)
      const lead = confirmed ? 'This merge did not meet the branch rules in force at the time' : "This merge can't be confirmed against the branch rules (the merger has no current membership record)"
      if (a.uncountedBypass === null) return `${lead}, and no bypass was recorded.`
      if (a.uncountedBypass.role === null) {
        return confirmed
          ? "A bypass was recorded for this merge, but it can't be confirmed. Without it, the merge did not meet the branch rules in force at the time."
          : "A bypass was recorded for this merge, but it can't be confirmed."
      }
      return `${lead}. A bypass was recorded, but no current membership record shows the person who recorded it as a maintainer then.`
    }
    case 'unknown':
      if (a.checksUnread && a.codeOwnersUnaudited) return "The required checks couldn't be read and code owner approval isn't audited here, so this merge couldn't be checked against every rule."
      if (a.codeOwnersUnaudited) return "Code owner approval was required, and it isn't audited here, so this merge couldn't be checked against every rule."
      return "The required checks couldn't be read, so this merge couldn't be checked against every rule."
  }
}

/** The merger's role in the "Merged by" line: never "none at the time" from a missing current record. */
export function mergerRoleWords(a: MergeAudit): string {
  return a.mergerRole !== null ? `, ${ROLE_NOUN[a.mergerRole]} at the time` : ', no current membership record'
}

/**
 * Why a bypass recorded for this merge does not count, after "<who> recorded a bypass <when>": the
 * role then of the person who recorded it can't be confirmed, or the current record shows
 * another role.
 */
export function uncountedBypassWhy(u: UncountedBypass): string {
  return u.role === null
    ? "They have no current membership record, so their role at the time can't be confirmed and the bypass doesn't count."
    : `Their current membership record shows ${ROLE_NOUN[u.role]} at the time, and only a maintainer's bypass counts.`
}

/** Why an `unmet` verdict is not proof (reviews and check runs can be deleted). */
export const UNMET_CAVEAT =
  "Judged by what is on Platform now. Reviews and check runs can be deleted, and a removed member's approval stops counting, so the rules may have been met when it was merged."
