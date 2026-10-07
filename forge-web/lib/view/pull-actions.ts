/**
 * PR action gating (view glue) — which PR state controls a viewer is shown, and what the
 * merge controls may honestly promise.
 *
 * Two merge controls, for a current maintainer or writer on an open PR (consensus admits a merge
 * `transition` only from them; a recorded merge is final, D-9):
 *
 * - **The merge box** (`MergePanel`): merges the code in the browser (pack, ref update), then
 *   records the merge.
 * - **"Mark as merged (done elsewhere)"**: records a merge that already happened some other way
 *   (a push). It moves no code, so it is offered only once the head is on the base branch, where
 *   the recorded merge counts (readers label a merge whose commit never was a base tip "merge
 *   commit not found on the base"), as `dg pr merge --event-only` requires.
 *
 * Two branch rules narrow them (`review-parity-spec.md` §4.8):
 *
 * - A **protected** base (its full ref name matches `config.protectedPatterns`): only a
 *   maintainer can move it (`protectedRefUpdate` is maintainer-gated at consensus, and a plain
 *   `refUpdate` there is inert), so a writer's merge could never land. Refused for writers.
 * - The **branch policy** (`policy`, newest wins; a client rule, nothing at consensus requires
 *   approvals): while its approvals or required checks are unmet ({@link unmetRules}), both
 *   controls stay disabled, as GitHub's merge button does. A maintainer may bypass it, the
 *   GitHub way: an explicit "bypass rules" step, a confirm naming the rules bypassed, and a real
 *   merge whose bypass is recorded on the PR as a policy-bypass event ({@link bypassValue}), which
 *   nobody can delete.
 *
 * Close/reopen stay available to the PR author as well (a transition written as the author), but
 * not to anyone consensus would refuse.
 */

import { isOidHex, isPlainBranchRef, matchesProtected, type Holdings } from '../rules'
import { capabilitiesOf, roleLimit } from '../rules/roles'
import { linkedIssues, type Approvals, type ChecksState, type CodeOwnerStatus, type Policy, type PolicyStatus } from '../rules/v2'
import type { MergeVerdict } from '../rules/merge-content'
import type { PullView } from '../repo'
import type { ProvedVerdicts } from '../repo/verdicts'
import { branchName, plural } from './format'

/** What the viewer may do from the PR page, and why not when not. */
export interface PullActions {
  /**
   * Show the merge box: the viewer can merge this PR, now or (a maintainer, {@link canBypass})
   * by bypassing the branch rules.
   */
  readonly canMerge: boolean
  /**
   * Offer "Mark as merged (done elsewhere)": {@link canMerge}, and the head is on the base
   * already ({@link markCountsNow}).
   */
  readonly canMarkMerged: boolean
  /** Offer close (open PRs) / reopen (closed, unmerged PRs). */
  readonly canCloseReopen: boolean
  /**
   * The head has already been a tip of the base branch: a merge recorded now is on the base.
   * Only then is there a merge done elsewhere to record.
   */
  readonly markCountsNow: boolean
  /** A short reason shown when the merge control is withheld; null when shown. */
  readonly mergeHint: string | null
  /** The base branch is protected (only maintainers can update it). */
  readonly baseProtected: boolean
  /**
   * The branch rules this PR does not meet ({@link unmetRules}); empty when they are met or
   * there is no policy. While any is unmet, merging stays disabled unless bypassed.
   */
  readonly unmetRules: readonly string[]
  /** A rule is unmet and the viewer is a maintainer: they may bypass it (explicit, confirmed, recorded). */
  readonly canBypass: boolean
}

export interface PullActionInputs {
  readonly pull: Pick<PullView, 'author' | 'headOid' | 'headOnBase' | 'stateComplete' | 'state'> & {
    /** The full base ref the PR merges into (`refs/heads/main`, a retarget's when there is one); absent when unknown. */
    readonly mergeBaseRefName?: string
  }
  /** The signed-in identity, or null when logged out. */
  readonly viewer: string | null
  /**
   * The viewer's current permissions: `'loading'` until read, `null` when the membership could
   * not be read — permission unknown, controls withheld with a reason.
   */
  readonly holdings: Holdings | null | 'loading'
  /** `config.protectedPatterns` in force (empty or absent: nothing protected). */
  readonly protectedPatterns?: readonly string[]
  /**
   * How the PR's approvals stand against the branch policy; null or absent: no policy;
   * `'unknown'`: it could not be read, so the merge is withheld (fail closed).
   */
  readonly policy?: PolicyStatus | null | 'unknown'
  /** The policy counts maintainers' approvals only (`approverRole` 1), for the rule's wording. */
  readonly maintainersOnly?: boolean
  /**
   * The head's required checks (`checksState`) when the policy requires any; null or absent:
   * none required; `'unknown'`: required, but the runs or the members could not be read. A
   * client rule like the approvals.
   */
  readonly checks?: ChecksState | null | 'unknown'
  /**
   * Where the PR stands against `requireCodeOwners` (`codeOwnerReview`); null or absent: not
   * required; `'unknown'`: not read yet (the merge waits, as for unread checks).
   */
  readonly codeOwners?: CodeOwnerStatus | null | 'unknown'
}

/** The branch-rule line for standing requests for changes that block a merge. Parity: `dg`'s `changes_requested_rule`. */
export function changesRequestedRule(n: number): string {
  return `changes requested by ${plural(n, 'reviewer')}`
}

/** The bypass record's line for a policy that could not be read (`dg`'s `POLICY_UNREAD`). */
export const POLICY_UNREAD = 'the branch policy could not be read'

/**
 * The branch rules a PR does not meet, one line each, in `dg pr merge`'s words (its
 * `unmet_rules`): "required approvals: 0 of 1 (maintainers only)", "required check `build`:
 * missing". Empty when every rule is met or there is no policy. Unreadable counts as unmet.
 */
export function unmetRules(
  policy: PolicyStatus | null | 'unknown',
  checks: ChecksState | null | 'unknown' = null,
  maintainersOnly = false,
  codeOwners: CodeOwnerStatus | null | 'unknown' = null,
): string[] {
  if (policy === 'unknown') return [POLICY_UNREAD]
  const out: string[] = []
  if (policy !== null && policy.have < policy.need) out.push(`required approvals: ${policy.have} of ${policy.need}${maintainersOnly ? ' (maintainers only)' : ''}`)
  if (policy !== null && policy.blockedBy.length > 0) out.push(changesRequestedRule(policy.blockedBy.length))
  if (checks === 'unknown') {
    out.push("required checks: unknown (the head's check runs are not read)")
  } else if (checks !== null && !checks.met) {
    if (checks.required.length === 0) out.push('required checks: none reported on the head')
    for (const c of checks.required) if (c.state !== 'passed') out.push(`required check \`${c.name}\`: ${c.state}`)
  }
  out.push(...codeOwnerRules(codeOwners))
  return out
}

/**
 * The branch-rule lines `requireCodeOwners` leaves unmet, one per file ("code owner approval:
 * src/a.rs (@alice)"), as `dg pr merge` names them; empty when met or not required.
 */
export function codeOwnerRules(status: CodeOwnerStatus | null | 'unknown'): string[] {
  if (status === null || (status !== 'unknown' && status.met)) return []
  if (status === 'unknown') return ['code owner approval: not read yet']
  if (status.unreadable) return ['code owner approval: the code owners or the changed files could not be read']
  return status.pending.map((p) => `code owner approval: ${p.path} (${p.owners.join(' ')}${p.approvable ? '' : '; none of them can approve'})`)
}

/**
 * The branch-rules card's line for the policy's required checks (QW2-052): the ones not passing
 * on the head, by name ("lint", "e2e (pending)"), never those that pass; once all pass, the
 * names that do. `named` is the policy's `requiredChecks` (shown while the runs are unread).
 */
export function requiredChecksLine(checks: ChecksState | null | 'unknown', named: readonly string[]): { readonly ok: boolean; readonly text: string } {
  const list = (names: readonly string[]): string => (names.length > 0 ? `: ${names.join(', ')}` : '')
  if (checks === 'unknown') return { ok: false, text: `Required checks not read yet${list(named)}` }
  if (checks === null || checks.met) return { ok: true, text: `Required checks pass${list(checks === null ? named : checks.required.map((c) => c.name))}` }
  if (checks.required.length === 0) return { ok: false, text: 'Required checks not passing on the head: none reported' }
  const notPassing = checks.required.filter((c) => c.state !== 'passed').map((c) => (c.state === 'failing' ? c.name : `${c.name} (${c.state})`))
  return { ok: false, text: `Required checks not passing on the head${list(notPassing)}` }
}

/**
 * The issues a PR's description links ("Fixes #12"), never the PR itself (QW2-054): issues and
 * PRs share one numbering, so "Fixes #<own number>" names the PR, not an issue.
 */
export function prLinkedIssues(body: string, ownNumber: number): number[] {
  return linkedIssues(body).filter((n) => n !== ownNumber)
}

/** forge-community `event.value`: at most 120 characters (and 480 bytes, which 120 never pass). */
export const BYPASS_VALUE_MAX = 120

/**
 * The `value` of the policy-bypass event a maintainer's bypass records on the PR (event kind
 * 23; the merge `transition` has no field for it): the rules not met, `; `-joined, within the
 * event's 120 characters. Whole rules only; those that do not fit are counted ("(+2 more)"), and
 * a first rule too long on its own is cut. Parity: `dg`'s `bypass_value`.
 */
export function bypassValue(rules: readonly string[]): string {
  const len = (t: string): number => [...t].length
  let out = ''
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as string
    const rest = rules.length - i - 1
    const sep = out === '' ? '' : '; '
    const more = rest === 0 ? '' : ` (+${rest} more)`
    if (len(out) + sep.length + len(r) + len(more) > BYPASS_VALUE_MAX) {
      if (out === '') return [...r].slice(0, BYPASS_VALUE_MAX - len(more) - 1).join('') + '…' + more
      return `${out} (+${rest + 1} more)`
    }
    out += sep + r
  }
  return out === '' ? 'the branch rules' : out
}

/** What the merge box's merge button may do ({@link mergeGate}). */
export interface MergeGate {
  /** The button may be clicked. */
  readonly enabled: boolean
  /** The click merges by bypassing the unmet rules (after a confirm naming them). */
  readonly bypassing: boolean
  /** Why it is disabled, shown beside it; null when enabled. */
  readonly reason: string | null
}

/**
 * The merge button against the branch rules and the tab's unlock state (QW-001, QW-014):
 * disabled while a rule is unmet, unless a maintainer ticked "bypass rules"; disabled while this
 * tab must unlock its storage settings first (a click would do nothing). Never an enabled button
 * that silently does nothing.
 */
export function mergeGate(i: {
  readonly unmet: readonly string[]
  readonly canBypass: boolean
  readonly bypassTicked: boolean
  readonly storageLocked: boolean
  /**
   * The PR's source branch is past its head (QW3-013): the branch and its tip. A merge would
   * merge the older head and silently leave the newer commits out, so it waits for "Update PR
   * head" (no bypass: it is not a branch rule).
   */
  readonly branchAhead?: { readonly branch: string; readonly tip: string; readonly head: string } | null
}): MergeGate {
  const ahead = i.branchAhead ?? null
  if (ahead !== null) {
    return {
      enabled: false,
      bypassing: false,
      reason: `${ahead.branch} is at ${ahead.tip.slice(0, 7)}, ahead of this PR's head ${ahead.head.slice(0, 7)}. Update the PR head first, so the merge includes those commits.`,
    }
  }
  const blocked = i.unmet.length > 0
  if (blocked && !(i.canBypass && i.bypassTicked)) {
    return {
      enabled: false,
      bypassing: false,
      reason: i.canBypass ? 'Merging is blocked until the branch rules are met. As a maintainer you can bypass them below.' : 'Merging is blocked until the branch rules are met.',
    }
  }
  if (i.storageLocked) return { enabled: false, bypassing: false, reason: 'Unlock above to merge: your storage settings are sealed in this tab.' }
  return { enabled: true, bypassing: blocked, reason: null }
}

/** What a repo's ACL is read from, for "couldn't read …" messages. */
export const ACL_NAME = 'members'

/**
 * The browser merge button (`ux-dx-spec.md` §5.7), forge-v2 only. Its label says what it does;
 * a disabled state says why.
 */
export type MergeButton =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'fast-forward'; readonly label: 'Merge (fast-forward)' }
  | { readonly kind: 'merge-commit'; readonly label: 'Create merge commit and merge' }
  | { readonly kind: 'conflicts'; readonly label: "Can't merge in the browser — merge with `dg pr merge`"; readonly checkout: string }
  | { readonly kind: 'protected'; readonly label: 'Protected branch — maintainers only' }
  | { readonly kind: 'mobile'; readonly label: 'Use a desktop browser for this step' }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface MergeButtonInputs {
  /** From {@link pullActions}: the viewer is a current maintainer or writer and the PR is open. */
  readonly canMerge: boolean
  /** Private repos are not merged in the browser yet (their packs must be encrypted). */
  readonly isPublic: boolean
  /** Why the PR's base or head cannot be merged at all (not a plain branch, no tip, bad oid), or null. */
  readonly refProblem: string | null
  /** The base repo's own reader is loaded (the merge never reads the base side from the fork). */
  readonly baseLoaded: boolean
  readonly isMaintainer: boolean
  /** The base branch matches the repo's current protected patterns. */
  readonly baseProtected: boolean
  readonly narrow: boolean
  /** The head has been a tip of the base (`PullView.headOnBase`): "Mark as merged (done elsewhere)" records it. */
  readonly headOnBase?: boolean
  /** The worker's verdict, or null while it runs; an error string when it could not decide. */
  readonly check: 'fast-forward' | 'merge' | 'conflict' | 'malformed' | 'too-large' | 'up-to-date' | 'unrelated' | { readonly error: string } | null
  /** `dg pr checkout <repo> <n>` for the conflicts row. */
  readonly checkout: string
}

export function mergeButton(i: MergeButtonInputs): MergeButton {
  if (!i.canMerge) return { kind: 'hidden' }
  if (!i.isPublic) return { kind: 'unavailable', reason: 'Private repositories are merged with `dg pr merge` for now.' }
  if (i.refProblem !== null) return { kind: 'unavailable', reason: i.refProblem }
  if (i.baseProtected && !i.isMaintainer) return { kind: 'protected', label: 'Protected branch — maintainers only' }
  if (i.narrow) return { kind: 'mobile', label: 'Use a desktop browser for this step' }
  if (!i.baseLoaded) return { kind: 'unavailable', reason: 'Load the base repo to merge (see Files changed below).' }
  const c = i.check
  if (c === null) return { kind: 'checking' }
  if (typeof c === 'object') return { kind: 'unavailable', reason: `Couldn't check the merge in the browser (${c.error}).` }
  switch (c) {
    case 'fast-forward':
      return { kind: 'fast-forward', label: 'Merge (fast-forward)' }
    case 'merge':
      return { kind: 'merge-commit', label: 'Create merge commit and merge' }
    case 'conflict':
      // Lines both sides changed (git conflicts too), or a shape only git merges — renames, a moved
      // directory, binary or very large files, a .gitattributes merge rule (QW3-016).
      return { kind: 'conflicts', label: "Can't merge in the browser — merge with `dg pr merge`", checkout: i.checkout }
    case 'malformed':
      return {
        kind: 'unavailable',
        reason: 'This history holds a commit or tree git would reject or read differently, or changes a .gitmodules or .gitattributes file; merge it with `dg pr merge` after checking it.',
      }
    case 'too-large':
      return { kind: 'unavailable', reason: 'This merge is too large to build in the browser; merge it with `dg pr merge`.' }
    case 'up-to-date':
      return i.headOnBase === true
        ? { kind: 'unavailable', reason: 'The base branch already contains this head: it was merged elsewhere. Record that with "Mark as merged (done elsewhere)" below.' }
        : {
            kind: 'unavailable',
            reason:
              'The base branch already contains this head through a merge commit made elsewhere. Record it with `dg pr merge --event-only --merge-oid <that commit>`: a merge counts for a commit that has been a tip of the base.',
          }
    case 'unrelated':
      return { kind: 'unavailable', reason: 'The head and the base branch share no history.' }
  }
}

/**
 * Why every write control is disabled in an archived repo. Archiving is a client rule
 * (`config.archived`): consensus still admits a member's writes, so the clients refuse them
 * (the CLI helper with E606).
 */
export const ARCHIVED_REASON = 'This repo is archived: it is read-only until a maintainer unarchives it.'

/**
 * The branch policy and its status as the PR page should use them. `approvals` null means the
 * approvals (and so the policy) could not be read: `'unknown'`, so a writer's merge is withheld
 * and the rules card says so, never "no policy".
 */
export function policyOf(
  approvals: { readonly policy: Policy | null | 'unknown'; readonly policyStatus: PolicyStatus | null | 'unknown' } | null,
): { policy: Policy | null | 'unknown'; status: PolicyStatus | null | 'unknown' } {
  return approvals === null ? { policy: 'unknown', status: 'unknown' } : { policy: approvals.policy, status: approvals.policyStatus }
}

/**
 * The merge box's review line, the GitHub way: "Changes requested", "2 of 3 required approvals",
 * "2 approvals", "No approvals yet".
 *
 * **Which number gates the merge: the fold.** Every count here is the approval fold's
 * (`countApprovals` on the head, dismissed reviews out, members at review time; `meetsPolicy`
 * for "N of M"), the same fold {@link pullActions} gates a writer's merge on (its `policy`
 * input is `approvals.policyStatus`). The proved count (`readProvedVerdicts`, RC1 R-16) is
 * display only: an upper bound that folds nothing (re-reviews, dismissals and removed members
 * all count), so where it disagrees with the fold the fold's number stands and the proved one is
 * named "on chain" beside it. Only when the members could not be read (no fold, and the merge is
 * withheld from writers anyway) does the line fall back to the proved count, said to be one.
 */
export interface VerdictSummary {
  readonly tone: 'approved' | 'changes' | 'required' | 'none'
  readonly headline: string
  /** The other counts, e.g. "1 approval" beside "Changes requested"; null when there are none. */
  readonly detail: string | null
  /** The proved count where it differs from (or stands in for) the fold; null otherwise. */
  readonly onChain: string | null
  /** The proved count was read for this head and agrees with the fold. */
  readonly proved: boolean
}

/** "3 member approvals and 1 change request". */
function verdictCounts(approvals: number, changes: number): string {
  const parts = [plural(approvals, 'member approval')]
  if (changes > 0) parts.push(plural(changes, 'change request'))
  return parts.join(' and ')
}

/** The headline for a count alone: "Changes requested", "N approvals" or "No approvals yet". */
function countHeadline(approvals: number, changes: boolean): Pick<VerdictSummary, 'tone' | 'headline'> {
  if (changes) return { tone: 'changes', headline: 'Changes requested' }
  if (approvals > 0) return { tone: 'approved', headline: plural(approvals, 'approval') }
  return { tone: 'none', headline: 'No approvals yet' }
}

/**
 * The review line for a PR head: `approvals` is the fold (null: the members could not be read),
 * `proved` the proved verdict count (null: not read). Null when neither is known.
 */
export function verdictSummary(
  approvals: (Approvals & { readonly policyStatus: PolicyStatus | null | 'unknown' }) | null,
  proved: ProvedVerdicts | null,
  headOid: string,
): VerdictSummary | null {
  const chain = proved !== null && proved.headOid === headOid.toLowerCase() ? proved : null
  if (approvals === null) {
    if (chain === null) return null
    return {
      ...countHeadline(chain.approvals, chain.changesRequested > 0),
      detail: null,
      onChain: `${verdictCounts(chain.approvals, chain.changesRequested)} on Platform. The members couldn't be read, so this is an upper bound: re-reviews, dismissed reviews and members removed since all count.`,
      proved: false,
    }
  }
  const a = approvals.approvers.length
  const c = approvals.changesRequested.length
  const status = approvals.policyStatus === 'unknown' ? null : approvals.policyStatus
  const required = status !== null && status.need > 0 ? `${status.have} of ${plural(status.need, 'required approval')}` : null
  const agrees = chain !== null && chain.approvals === a && chain.changesRequested === c
  // A count below the fold's is a node not caught up yet (L-37, or this page's own new review): no
  // upper bound, so it is not shown.
  const covers = chain !== null && chain.approvals >= a && chain.changesRequested >= c
  const base = {
    onChain: chain !== null && !agrees && covers ?`${verdictCounts(chain.approvals, chain.changesRequested)} on Platform (an upper bound: re-reviews, dismissed reviews and members removed since count there, not here)` : null,
    proved: agrees,
  }
  if (c > 0) {
    const others = [a > 0 ? plural(a, 'approval') : '', required ?? ''].filter((x) => x !== '')
    return { ...base, tone: 'changes', headline: 'Changes requested', detail: others.length > 0 ? others.join(' · ') : null }
  }
  if (required !== null && status !== null) {
    return { ...base, tone: status.met ? 'approved' : 'required', headline: required, detail: a !== status.have ? `${plural(a, 'approval')} in all` : null }
  }
  return { ...base, ...countHeadline(a, false), detail: null }
}

/** Decide the PR controls for a viewer. Pure — the unit-tested core of the PR page gate. */
export function pullActions({ pull, viewer, holdings, protectedPatterns = [], policy = null, maintainersOnly = false, checks = null, codeOwners = null }: PullActionInputs): PullActions {
  const known = holdings !== null && holdings !== 'loading'
  const maintainer = known && holdings.maintain
  // Merge is role 1's (a maintainer or writer); close and reopen also a triage member's.
  const caps = capabilitiesOf(known ? holdings.role : null)
  const holder = known && caps.canMerge
  const isAuthor = viewer !== null && viewer === pull.author
  const { merged, open } = pull.state
  // A PR whose event log was not read completely has no trustworthy state to act on.
  const actionable = pull.stateComplete && !merged
  const base = pull.mergeBaseRefName ?? ''
  const baseProtected = base !== '' && matchesProtected(base, protectedPatterns)
  const policyUnknown = policy === 'unknown'
  const unmet = unmetRules(policy, checks, maintainersOnly, codeOwners)
  const policyUnmet = unmet.length > 0

  const eligible = actionable && open && viewer !== null && holder && pull.headOid !== ''
  // A writer can neither move a protected base nor bypass the policy.
  const writerBlocked = !maintainer && (baseProtected || policyUnmet)
  const canMerge = eligible && !writerBlocked
  const canCloseReopen = actionable && viewer !== null && (caps.canCloseReopen || isAuthor)

  let mergeHint: string | null = null
  if (!canMerge && actionable && open && viewer !== null && holdings !== 'loading') {
    if (holdings === null) {
      mergeHint = `Couldn't read this repo's ${ACL_NAME}, so merge permission is unknown.`
    } else if (pull.headOid === '') {
      mergeHint = 'This PR records no head commit to mark as merged.'
    } else if (!holder) {
      mergeHint = roleLimit(holdings.role, 'canMerge', 'merge pull requests') ?? "Only this repo's maintainers and writers can mark a PR as merged."
    } else if (baseProtected) {
      mergeHint = `${branchName(base)} is a protected branch: only maintainers can merge into it.`
    } else if (policyUnknown) {
      mergeHint = "Couldn't read the branch policy, so merging is blocked for now; only a maintainer can bypass it."
    } else if (policy !== null && typeof policy === 'object' && policy.have < policy.need) {
      mergeHint = `The branch policy needs ${plural(policy.need, 'approval')} (${policy.have} so far; the PR author's own never counts). Only a maintainer can bypass it.`
    } else if (policy !== null && typeof policy === 'object' && policy.blockedBy.length > 0) {
      mergeHint = `${policy.blockedBy.length === 1 ? 'A reviewer' : 'Reviewers'} requested changes. Merging waits until the changes are approved or the review is dismissed. Only a maintainer can bypass it.`
    } else if (policyUnmet) {
      mergeHint = 'The branch policy requires passing checks on the head. Only a maintainer can bypass it.'
    }
  }

  return {
    canMerge,
    canMarkMerged: canMerge && pull.headOnBase,
    canCloseReopen,
    markCountsNow: pull.headOnBase,
    mergeHint,
    baseProtected,
    unmetRules: unmet,
    canBypass: canMerge && maintainer && policyUnmet,
  }
}

/**
 * The base tip a browser merge may build on (D-501), or `''` when there is none, which
 * {@link mergeRefProblem} refuses:
 * - the base must be a branch now (`currentTip`, the resolved branch; never the PR's historical
 *   tip): pushing to a deleted base would re-create it;
 * - the PR's base must have been a branch when the PR was opened, or retargeted to it: its
 *   `baseTipOid` is empty otherwise (`prBaseTips` from `prMergeBase`'s `since`), and a merge
 *   event into it would never count;
 * - `baseRefName` must be the base the PR merges into now (`mergeBaseRefName`: a retarget's, else
 *   the one it was opened with), which the fold judges the merge against.
 */
export function mergeBaseTip(
  pull: Pick<PullView, 'mergeBaseRefName' | 'baseTipOid'>,
  baseRefName: string,
  currentTip: string | null,
): string {
  if (currentTip === null || baseRefName !== pull.mergeBaseRefName || pull.baseTipOid === '') return ''
  return currentTip
}

/**
 * Why a PR cannot be merged in the browser before anything is read: the base must be a plain
 * branch that exists (`refs/heads/<name>`, check-ref-format; parity with `dg`'s
 * `require_branch_ref`) and the head a full commit id. Null when both hold.
 */
export function mergeRefProblem(
  baseRefName: string,
  baseTipOid: string,
  headOid: string,
): string | null {
  if (!isPlainBranchRef(baseRefName)) return `The PR's base "${baseRefName.slice(0, 80)}" is not a plain branch (refs/heads/<name>); it is not merged in the browser.`
  if (!isOidHex(baseTipOid)) {
    return 'The base branch does not exist, or was not a branch when this PR was opened or retargeted to it, so a merge into it would not count. Retarget the PR to an existing branch.'
  }
  if (!isOidHex(headOid)) return 'The PR names no valid head commit.'
  return null
}

/**
 * Why "Delete the branch after merging" cannot delete the PR's source branch, or null when it
 * can. Refused, as `dg pr merge --delete-branch` refuses (`deletable_source`), for the base branch
 * itself and the source repo's default branch; and, beyond dg, unless the branch still points at
 * the PR head that was merged: a commit pushed after it would be lost. `defaultBranch` null: it
 * could not be read, so the branch might be the default one: refused (it fails closed). `tip`
 * undefined: not read yet (only the fixed refusals apply); null: the branch is already gone.
 */
export function deleteBranchProblem(i: {
  readonly refName: string
  readonly sameRepo: boolean
  readonly baseRefName: string
  readonly defaultBranch: string | null
  readonly headOid: string
  readonly tip?: string | null
}): string | null {
  const name = branchName(i.refName)
  if (i.sameRepo && i.refName === i.baseRefName) return "the PR's source branch is its base branch"
  const d = i.defaultBranch
  if (d === null || d === '') return `the source repo's default branch could not be read, so ${name} is not deleted`
  if (i.refName === d || i.refName === `refs/heads/${d}`) return `${name} is the source repo's default branch`
  if (i.tip === undefined || i.tip === null) return null
  if (i.tip.toLowerCase() !== i.headOid.toLowerCase()) return `${name} moved to ${i.tip.slice(0, 9)} after the merged head; not deleted, so those commits are kept`
  return null
}

/**
 * What the merge box shows for "Delete the branch after merging":
 * - `offer`: the checkbox (the merger can write the source branch, and it may be deleted);
 * - `explain`: the checkbox shown disabled, with `reason` (the merger cannot write the source,
 *   typically a contributor's fork: the option exists, they just cannot use it here);
 * - `hide`: nothing (no source branch, a private or unresolved source, the branch must never be
 *   deleted: the base or default branch, or the default is not read yet).
 */
export function deleteBranchOffer(i: {
  readonly refName: string | null
  /** The source repo, resolved (null while unknown), and whether it is this repo. */
  readonly source: { readonly visibility: string; readonly sameRepo: boolean } | null
  /** The merger can write the source branch; null while not known yet. */
  readonly canWrite: boolean | null
  readonly baseRefName: string
  /** The source repo's default branch; null while not read (or unreadable). */
  readonly defaultBranch: string | null
  readonly headOid: string
}): { kind: 'offer' } | { kind: 'explain'; reason: string } | { kind: 'hide' } {
  if (i.refName === null || i.source === null || i.source.visibility !== 'public' || i.canWrite === null) return { kind: 'hide' }
  if (i.source.sameRepo && i.refName === i.baseRefName) return { kind: 'hide' }
  if (!i.canWrite) {
    return {
      kind: 'explain',
      reason: i.source.sameRepo
        ? "You can't write this branch here (it is protected, or you are not a writer)."
        : "You can't write the contributor's fork; ask them to allow edits by maintainers, or delete it from the fork.",
    }
  }
  if (deleteBranchProblem({ refName: i.refName, sameRepo: i.source.sameRepo, baseRefName: i.baseRefName, defaultBranch: i.defaultBranch, headOid: i.headOid }) !== null) return { kind: 'hide' }
  return { kind: 'offer' }
}

/**
 * Whether the merge box is on screen, given whether the viewer can merge now and whether it was
 * shown before in this page view. Once shown it stays: its own merge flips the PR to merged
 * (the viewer can no longer merge it) while it still has its last steps to report and the
 * source branch to delete, and unmounting it then would drop both silently.
 */
export function mergeBoxShown(canMerge: boolean, shownBefore: boolean): boolean {
  return canMerge || shownBefore
}

/**
 * Where the merge box is, per tab. It lives on the Conversation tab; a merge running in it
 * (possibly waiting for the merger's storage choice) stays mounted and on screen on every tab,
 * so switching tabs never strands it, and its outcome stays on the tab it ended on until the
 * merger moves on. Once it has run it stays mounted (hidden elsewhere), so the outcome is still
 * there on the way back.
 */
export function mergeBoxSlot(i: { onConversation: boolean; draft: boolean; running: boolean; ranOnPage: boolean; ranOnThisTab: boolean }): 'shown' | 'kept' | 'none' {
  if ((i.onConversation && !i.draft) || i.running || i.ranOnThisTab) return 'shown'
  return i.ranOnPage ? 'kept' : 'none'
}

/** What {@link unrecordedMerge} needs: the PR, the viewer's merge right, and the merge check of the base tip. */
export interface UnrecordedMergeInputs {
  readonly pull: Pick<PullView, 'headOid' | 'baseTipOid' | 'baseTipPrev' | 'stateComplete'> & { readonly state: Pick<PullView['state'], 'open' | 'draft' | 'merged'> }
  /** {@link PullActions.canMerge}: the viewer may record a merge (a writer is refused on a protected base). */
  readonly canMerge: boolean
}

/**
 * Whether the base tip is worth checking for an unrecorded merge of this PR: an open, ready PR the
 * viewer can merge, whose base has a tip that is not the head (a head on the base is "Mark as
 * merged") and a tip before it the merge could have built on.
 */
export function unrecordedMergeCandidate({ pull, canMerge }: UnrecordedMergeInputs): boolean {
  const tip = pull.baseTipOid.toLowerCase()
  return (
    canMerge &&
    pull.stateComplete &&
    pull.state.open &&
    !pull.state.merged &&
    !pull.state.draft &&
    isOidHex(tip) &&
    tip !== pull.headOid.toLowerCase() &&
    (pull.baseTipPrev ?? '') !== ''
  )
}

/**
 * "Record merge of <commit>": the base tip to record as this PR's merge when a merge moved the
 * base but its merge transition was never written (the browser merge stopped between the ref
 * update and the merge event, or a merge was pushed with git). Offered only when the merge check
 * (`mergeContent`, the same rule `dg pr merge --event-only` applies) says the tip contains the PR
 * or is a squash or rebase of it; null otherwise. The commit is a valid tip of the base, so the
 * recorded merge counts.
 */
export function unrecordedMerge(i: UnrecordedMergeInputs, verdict: MergeVerdict | null): string | null {
  if (!unrecordedMergeCandidate(i) || verdict === null) return null
  return verdict === 'contains' || verdict === 'squash' || verdict === 'rebase' ? i.pull.baseTipOid.toLowerCase() : null
}
